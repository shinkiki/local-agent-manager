//! Claude Code 플러그인·스킬 사용 설정(C8)의 유일한 읽기·쓰기 어댑터.
//!
//! 공급자 설정 전체를 소유하지 않는다. 설치 인벤토리와 네 설정 스코프를 읽어 유효값을
//! 계산하고, 쓰기는 사용자 `settings.json` 또는 등록 프로젝트의 `settings.local.json`
//! 안 `enabledPlugins`·`skillOverrides` 엔트리 하나로만 제한한다.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::catalog::{
    child_directories, claude_installed_plugins, frontmatter_value, read_text_limited,
    split_frontmatter,
};
use crate::provider_settings_file::{save_backup, SettingsFileGuard, SettingsPathRules};
use crate::store_lock;
use crate::user_home::home_dir;
use crate::CoreError;

const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;
const SETTINGS_LOCK_FILE: &str = "claude-settings.lock";

/// 문자열 값과 1:1로 대응하는 Claude 설정 열거형에 `ALL`·`as_str`·`Display`·`FromStr`를
/// 한 벌로 붙인다. 네 열거형이 같은 네 덩어리를 각자 적고 있어, 변이 하나를 늘리거나
/// 문자열 값을 고칠 때 네 곳을 맞춰 고쳐야 했고 `as_str`와 `FromStr` 중 한쪽만 고쳐도
/// 컴파일은 지나가 해석만 조용히 어긋났다. 여기서는 변이와 문자열 값의 대응표만 적고
/// `FromStr`가 그 표를 뒤집어 쓰므로 양방향이 어긋날 수 없다. `$label`은 알 수 없는 값을
/// 만났을 때의 오류 문구 앞머리다. 모듈마다 같은 모양의 매크로를 두는 이 저장소의 방식을
/// 따른다(`chat.rs`의 `chat_string_enum`, `account_tools.rs`의 `account_tool_string_enum`).
macro_rules! claude_settings_string_enum {
    ($ty:ident, $label:literal, { $($variant:ident => $value:literal),+ $(,)? }) => {
        impl $ty {
            pub const ALL: [Self; [$(stringify!($variant)),+].len()] = [$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value,)+
                }
            }
        }

        impl std::fmt::Display for $ty {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $ty {
            type Err = CoreError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s.trim() {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(CoreError::InvalidInput(format!(
                        concat!($label, ": {}"),
                        s
                    ))),
                }
            }
        }
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeSettingsScopeKind {
    User,
    Project,
    Local,
    Policy,
}

claude_settings_string_enum!(ClaudeSettingsScopeKind, "알 수 없는 Claude 설정 스코프 종류입니다", {
    User => "user",
    Project => "project",
    Local => "local",
    Policy => "policy",
});

impl ClaudeSettingsScopeKind {
    /// 값이 겹칠 때 이기는 순서(강한 갈래가 앞). Claude가 정한 우선순위이고, 이 모듈에서
    /// 갈래를 훑는 자리는 모두 이 표를 돈다 — 순서를 여러 곳에 늘어놓으면 한쪽만 고쳐도
    /// 컴파일이 통과해 조회 경로마다 다른 우선순위를 갖게 된다.
    const PRECEDENCE: [Self; 4] = [Self::Policy, Self::Local, Self::Project, Self::User];

    /// 프로젝트 수준 스코프(project 또는 local)인지 여부.
    pub fn is_project_scoped(self) -> bool {
        matches!(self, Self::Project | Self::Local)
    }

    /// 직접 쓰기 변경이 가능한 스코프(user 또는 project)인지 여부.
    pub fn is_writable(self) -> bool {
        matches!(self, Self::User | Self::Project)
    }

    /// 쓰기 가능한 스코프인 경우 대응하는 ClaudeSettingsWriteScope를 반환한다.
    pub fn as_write_scope(self) -> Option<ClaudeSettingsWriteScope> {
        match self {
            Self::User => Some(ClaudeSettingsWriteScope::User),
            Self::Project => Some(ClaudeSettingsWriteScope::Project),
            Self::Local | Self::Policy => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeSettingsWriteScope {
    User,
    Project,
}

claude_settings_string_enum!(ClaudeSettingsWriteScope, "알 수 없는 Claude 설정 쓰기 스코프입니다", {
    User => "user",
    Project => "project",
});

impl ClaudeSettingsWriteScope {
    /// 대응하는 ClaudeSettingsScopeKind를 반환한다.
    pub fn as_scope_kind(self) -> ClaudeSettingsScopeKind {
        match self {
            Self::User => ClaudeSettingsScopeKind::User,
            Self::Project => ClaudeSettingsScopeKind::Project,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudePluginSettingValue {
    True,
    False,
    Custom,
}

claude_settings_string_enum!(ClaudePluginSettingValue, "알 수 없는 Claude 플러그인 설정값입니다", {
    True => "true",
    False => "false",
    Custom => "custom",
});

impl ClaudePluginSettingValue {
    /// 플러그인이 활성화 상태인지 여부.
    pub fn is_enabled(self) -> bool {
        matches!(self, Self::True)
    }

    /// 플러그인이 비활성화 상태인지 여부.
    pub fn is_disabled(self) -> bool {
        matches!(self, Self::False)
    }

    /// 플러그인이 커스텀(JSON 객체/배열 등) 설정값인지 여부.
    pub fn is_custom(self) -> bool {
        matches!(self, Self::Custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillOverrideValue {
    On,
    NameOnly,
    UserInvocableOnly,
    Off,
}

claude_settings_string_enum!(SkillOverrideValue, "알 수 없는 스킬 오버라이드 값입니다", {
    On => "on",
    NameOnly => "name-only",
    UserInvocableOnly => "user-invocable-only",
    Off => "off",
});

impl SkillOverrideValue {
    /// 오버라이드가 꺼져 있지 않고 유효하게 동작 중인지 여부.
    pub fn is_active(self) -> bool {
        !matches!(self, Self::Off)
    }

    /// 오버라이드가 꺼져 있는지(off) 여부.
    pub fn is_disabled(self) -> bool {
        matches!(self, Self::Off)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeScopeValues<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<T>,
}

impl<T> ClaudeScopeValues<T> {
    /// 네 갈래가 모두 빈 묶음. `Default` 파생은 `T: Default`를 요구하므로 해석 결과를
    /// 담는 자리에서는 쓸 수 없다.
    fn empty() -> Self {
        Self {
            user: None,
            project: None,
            local: None,
            policy: None,
        }
    }

    /// 갈래 하나가 앉는 자리. 갈래를 늘리면 여기서 컴파일이 멈춘다.
    fn slot_mut(&mut self, kind: ClaudeSettingsScopeKind) -> &mut Option<T> {
        match kind {
            ClaudeSettingsScopeKind::User => &mut self.user,
            ClaudeSettingsScopeKind::Project => &mut self.project,
            ClaudeSettingsScopeKind::Local => &mut self.local,
            ClaudeSettingsScopeKind::Policy => &mut self.policy,
        }
    }
}

impl<T: Copy> ClaudeScopeValues<T> {
    fn get(&self, kind: ClaudeSettingsScopeKind) -> Option<T> {
        match kind {
            ClaudeSettingsScopeKind::User => self.user,
            ClaudeSettingsScopeKind::Project => self.project,
            ClaudeSettingsScopeKind::Local => self.local,
            ClaudeSettingsScopeKind::Policy => self.policy,
        }
    }

    fn winner(&self) -> Option<(ClaudeSettingsScopeKind, T)> {
        ClaudeSettingsScopeKind::PRECEDENCE
            .into_iter()
            .find_map(|kind| Some((kind, self.get(kind)?)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsFileStatus {
    pub path: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsScopes {
    pub user: ClaudeSettingsFileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ClaudeSettingsFileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<ClaudeSettingsFileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<ClaudeSettingsFileStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePluginState {
    pub plugin_id: String,
    pub name: String,
    pub marketplace: String,
    pub version: Option<String>,
    pub install_path: String,
    pub skill_count: usize,
    pub default_enabled: bool,
    pub values: ClaudeScopeValues<ClaudePluginSettingValue>,
    pub effective_enabled: bool,
    pub decided_by: Option<ClaudeSettingsScopeKind>,
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSkillOverrideState {
    pub override_key: String,
    pub name: String,
    pub directory: String,
    pub scope: String,
    pub project_path: Option<String>,
    pub values: ClaudeScopeValues<SkillOverrideValue>,
    pub effective: SkillOverrideValue,
    pub decided_by: Option<ClaudeSettingsScopeKind>,
    pub locked: bool,
    pub disable_model_invocation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsSnapshot {
    pub scopes: ClaudeSettingsScopes,
    pub plugins: Vec<ClaudePluginState>,
    pub skills: Vec<ClaudeSkillOverrideState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClaudePluginEnabledRequest {
    pub plugin_id: String,
    pub scope: ClaudeSettingsWriteScope,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClaudeSkillOverrideRequest {
    pub override_key: String,
    pub scope: ClaudeSettingsWriteScope,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub value: Option<SkillOverrideValue>,
}

#[derive(Debug, Clone)]
struct ScopeDocument {
    status: ClaudeSettingsFileStatus,
    root: Option<Map<String, Value>>,
}

impl ScopeDocument {
    fn value(&self, section: &str, key: &str) -> Option<&Value> {
        self.root.as_ref()?.get(section)?.as_object()?.get(key)
    }
}

/// 한 조회가 읽은 네 우선순위 문서 묶음. 항목 하나의 값을 뽑을 때마다
/// user/project/local/policy 네 갈래를 호출부에 늘어놓으면 갈래를 빠뜨려도 컴파일이
/// 통과하고, 갈래를 넘기느라 인자가 넷씩 늘어난다. 갈래 나열은 여기 한 벌만 둔다.
struct ScopeDocuments {
    user: ScopeDocument,
    project: Option<ScopeDocument>,
    local: Option<ScopeDocument>,
    policy: Option<ScopeDocument>,
}

impl ScopeDocuments {
    fn read(home: &Path, project: Option<&Path>) -> Self {
        Self {
            user: read_scope_document(&home.join(".claude/settings.json")),
            project: project.map(|root| read_scope_document(&root.join(".claude/settings.json"))),
            local: project
                .map(|root| read_scope_document(&root.join(".claude/settings.local.json"))),
            policy: policy_settings_path().map(|path| read_scope_document(&path)),
        }
    }

    /// 갈래 하나가 읽은 문서. user는 언제나 읽히고 나머지 셋은 대상이 없으면 비어 있다.
    fn document(&self, kind: ClaudeSettingsScopeKind) -> Option<&ScopeDocument> {
        match kind {
            ClaudeSettingsScopeKind::User => Some(&self.user),
            ClaudeSettingsScopeKind::Project => self.project.as_ref(),
            ClaudeSettingsScopeKind::Local => self.local.as_ref(),
            ClaudeSettingsScopeKind::Policy => self.policy.as_ref(),
        }
    }

    fn raw(&self, section: &str, key: &str, kind: ClaudeSettingsScopeKind) -> Option<&Value> {
        self.document(kind)?.value(section, key)
    }

    /// 네 갈래의 값을 같은 해석기로 읽는다. 해석하지 못한 값은 그 갈래가 비어 있는 것으로
    /// 본다 — 우선순위 판정은 알아볼 수 있는 값만으로 한다.
    fn values<T>(
        &self,
        section: &str,
        key: &str,
        parse: impl Fn(&Value) -> Option<T>,
    ) -> ClaudeScopeValues<T> {
        let mut values = ClaudeScopeValues::empty();
        for kind in ClaudeSettingsScopeKind::PRECEDENCE {
            *values.slot_mut(kind) = self.raw(section, key, kind).and_then(&parse);
        }
        values
    }

    /// 어느 갈래든 해석하지 못한 값이 있는지. 사용자가 손으로 고쳐야 하는 상태라
    /// 화면에서는 잠근다.
    fn has_unreadable<T>(
        &self,
        section: &str,
        key: &str,
        parse: impl Fn(&Value) -> Option<T>,
    ) -> bool {
        ClaudeSettingsScopeKind::PRECEDENCE
            .into_iter()
            .filter_map(|kind| self.raw(section, key, kind))
            .any(|value| parse(value).is_none())
    }

    /// 항목 하나의 갈래별 값과 우선순위 판정을 한 번에 읽는다. 값을 읽는 쪽과 이긴
    /// 갈래를 고르는 쪽이 늘 붙어 다니므로 둘을 떼어 쓸 일이 없다.
    fn resolve<T: Copy>(
        &self,
        section: &str,
        key: &str,
        parse: impl Fn(&Value) -> Option<T>,
    ) -> ResolvedSetting<T> {
        let values = self.values(section, key, parse);
        ResolvedSetting {
            winner: values.winner(),
            values,
        }
    }
}

/// 항목 하나의 갈래별 값과 그중 이긴 갈래.
///
/// 플러그인과 스킬은 같은 우선순위로 이기고 같은 이유(정책 갈래가 값을 들고 있음)로
/// 잠기지만, 그 밖에 무엇이 더 잠그는지만 다르다. 두 조립이 각자 `winner()`를 부르고
/// `decided_by`를 만들고 `values.policy.is_some()`을 적고 있어 한쪽만 고치면 같은 설정이
/// 항목 종류에 따라 다른 판정을 받는다. 공통분은 여기 두고, 갈래별 사정은 `locked`의
/// 인자로만 얹는다.
struct ResolvedSetting<T> {
    values: ClaudeScopeValues<T>,
    winner: Option<(ClaudeSettingsScopeKind, T)>,
}

impl<T: Copy> ResolvedSetting<T> {
    /// 이긴 값. 어느 갈래에도 알아볼 수 있는 값이 없으면 `None`이고, 그때 기본값을
    /// 무엇으로 볼지는 항목 종류가 정한다.
    fn winner_value(&self) -> Option<T> {
        self.winner.map(|(_, value)| value)
    }

    /// 어느 갈래가 값을 정했는지.
    fn decided_by(&self) -> Option<ClaudeSettingsScopeKind> {
        self.winner.map(|(scope, _)| scope)
    }

    /// 화면에서 잠글지. 정책 갈래는 사용자가 고칠 수 없으므로 언제나 잠그고,
    /// `also`로 항목 종류별 사정(해석 불가한 값, 우리가 쓰지 않는 모양의 값)을 더한다.
    fn locked(&self, also: bool) -> bool {
        self.values.policy.is_some() || also
    }
}

pub fn load_claude_settings_states(
    project: Option<&Path>,
) -> Result<ClaudeSettingsSnapshot, CoreError> {
    load_claude_settings_states_with_home(&home_dir()?, project)
}

pub fn set_claude_plugin_enabled(
    app_data_dir: &Path,
    project: Option<&Path>,
    request: &SetClaudePluginEnabledRequest,
) -> Result<ClaudeSettingsSnapshot, CoreError> {
    set_claude_plugin_enabled_with_home(app_data_dir, &home_dir()?, project, request)
}

pub fn set_claude_skill_override(
    app_data_dir: &Path,
    project: Option<&Path>,
    request: &SetClaudeSkillOverrideRequest,
) -> Result<ClaudeSettingsSnapshot, CoreError> {
    set_claude_skill_override_with_home(app_data_dir, &home_dir()?, project, request)
}

fn load_claude_settings_states_with_home(
    home: &Path,
    project: Option<&Path>,
) -> Result<ClaudeSettingsSnapshot, CoreError> {
    let documents = ScopeDocuments::read(home, project);

    let plugins = plugin_states(home, &documents);

    let mut skills = Vec::new();
    scan_skill_overrides(
        &home.join(".claude/skills"),
        "personal",
        None,
        &documents,
        &mut skills,
    );
    if let Some(project_root) = project {
        scan_skill_overrides(
            &project_root.join(".claude/skills"),
            "project",
            Some(project_root.to_string_lossy().into_owned()),
            &documents,
            &mut skills,
        );
    }
    skills.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.directory.cmp(&right.directory))
    });

    Ok(ClaudeSettingsSnapshot {
        scopes: ClaudeSettingsScopes {
            user: documents.user.status,
            project: documents.project.map(|document| document.status),
            local: documents.local.map(|document| document.status),
            policy: documents.policy.map(|document| document.status),
        },
        plugins,
        skills,
    })
}

fn set_claude_plugin_enabled_with_home(
    app_data_dir: &Path,
    home: &Path,
    project: Option<&Path>,
    request: &SetClaudePluginEnabledRequest,
) -> Result<ClaudeSettingsSnapshot, CoreError> {
    apply_settings_entry(
        app_data_dir,
        home,
        project,
        request.scope,
        SettingsEntryWrite {
            section: "enabledPlugins",
            key: &request.plugin_id,
            next: request.enabled.map(Value::Bool),
            installed: &|before| {
                before
                    .plugins
                    .iter()
                    .any(|plugin| plugin.plugin_id == request.plugin_id)
            },
            missing_message: "설치된 Claude Code 플러그인을 찾을 수 없습니다",
            editable_current: Value::is_boolean,
        },
    )
}

fn set_claude_skill_override_with_home(
    app_data_dir: &Path,
    home: &Path,
    project: Option<&Path>,
    request: &SetClaudeSkillOverrideRequest,
) -> Result<ClaudeSettingsSnapshot, CoreError> {
    apply_settings_entry(
        app_data_dir,
        home,
        project,
        request.scope,
        SettingsEntryWrite {
            section: "skillOverrides",
            key: &request.override_key,
            // `as_str`은 이 enum의 serde 표기(kebab-case)와 같은 값을 주고 왕복 테스트가
            // 그 일치를 지킨다. 직렬화 왕복으로 문자열을 얻던 두 단계의 `expect`를 지운다.
            next: request
                .value
                .map(|value| Value::String(value.as_str().to_owned())),
            installed: &|before| {
                before
                    .skills
                    .iter()
                    .any(|skill| skill.override_key == request.override_key)
            },
            missing_message: "설치된 Claude Code 스킬을 찾을 수 없습니다",
            editable_current: |current| skill_override_value(current).is_some(),
        },
    )
}

/// 설정 항목 하나를 쓰는 요청에서 플러그인·스킬이 갈리는 부분만 담는다.
struct SettingsEntryWrite<'a> {
    /// 항목이 사는 설정 섹션 이름.
    section: &'a str,
    /// 섹션 안 항목 키.
    key: &'a str,
    /// 쓸 값. `None`이면 항목을 지운다.
    next: Option<Value>,
    /// 인벤토리에 이 항목이 있는지. 설치되지 않은 항목은 쓰기 전에 끊는다.
    installed: &'a dyn Fn(&ClaudeSettingsSnapshot) -> bool,
    /// 설치돼 있지 않을 때 낼 오류 메시지.
    missing_message: &'a str,
    /// 대상 파일에 이미 있는 값을 우리가 덮어써도 되는 모양인지.
    editable_current: fn(&Value) -> bool,
}

/// 설정 항목 쓰기의 공통 골격. 설정 락을 잡고 인벤토리에 있는 항목인지 확인한 뒤 허용된
/// 대상 파일의 항목 하나만 고치고, 쓰기 후 상태를 다시 읽어 돌려준다. 락 안에서 읽고
/// 쓰고 다시 읽는 순서가 두 쓰기 경로에서 어긋나지 않게 한 곳에 둔다.
fn apply_settings_entry(
    app_data_dir: &Path,
    home: &Path,
    project: Option<&Path>,
    scope: ClaudeSettingsWriteScope,
    write: SettingsEntryWrite<'_>,
) -> Result<ClaudeSettingsSnapshot, CoreError> {
    let _guard = store_lock::acquire(app_data_dir, SETTINGS_LOCK_FILE, "Claude 설정")?;
    let before = load_claude_settings_states_with_home(home, project)?;
    if !(write.installed)(&before) {
        return Err(CoreError::NotFound(write.missing_message.to_owned()));
    }
    let target = write_target(home, project, scope)?;
    mutate_settings_entry(
        app_data_dir,
        &target,
        write.section,
        write.key,
        write.next,
        write.editable_current,
    )?;
    load_claude_settings_states_with_home(home, project)
}

/// Claude 설정 파일을 손댈 때 쓰는 판정표. 판정과 쓰기 순서 자체는
/// `provider_settings_file`이 소유하고, 여기에는 어느 공급자의 설정인지 알리는 문구만 둔다.
const CLAUDE_GUARD: SettingsFileGuard = SettingsFileGuard {
    read: SettingsPathRules {
        symlink: "심볼릭 링크 설정 파일은 읽지 않습니다",
        wrong_kind: "설정 경로가 일반 파일이 아닙니다",
        directory: false,
    },
    write: SettingsPathRules {
        symlink: "Claude 설정 파일이 심볼릭 링크라 수정하지 않습니다",
        wrong_kind: "Claude 설정 경로가 일반 파일이 아닙니다",
        directory: false,
    },
    parent: SettingsPathRules {
        symlink: "Claude 설정 폴더가 심볼릭 링크라 수정하지 않습니다",
        wrong_kind: "Claude 설정 상위 경로가 폴더가 아닙니다",
        directory: true,
    },
    grandparent: SettingsPathRules {
        symlink: "Claude 설정 폴더의 상위 경로가 안전한 폴더가 아닙니다",
        wrong_kind: "Claude 설정 폴더의 상위 경로가 안전한 폴더가 아닙니다",
        directory: true,
    },
    missing_parent: "Claude 설정 상위 경로가 없습니다",
    missing_grandparent: "Claude 설정 폴더의 상위 경로가 없습니다",
    fallback_file_name: "settings.json",
};

/// Claude 설정 백업이 쌓이는 앱 데이터 저장소 이름.
const BACKUP_STORE: &str = "claude-settings-backups";

fn read_scope_document(path: &Path) -> ScopeDocument {
    let path_text = path.to_string_lossy().into_owned();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ScopeDocument {
                status: ClaudeSettingsFileStatus {
                    path: path_text,
                    exists: false,
                    parse_error: None,
                },
                root: Some(Map::new()),
            }
        }
        Err(error) => {
            return invalid_scope(path_text, false, error.to_string());
        }
    };
    if let Err(message) = CLAUDE_GUARD.read.check(&metadata) {
        return invalid_scope(path_text, true, message.to_owned());
    }
    if metadata.len() > MAX_SETTINGS_BYTES {
        return invalid_scope(
            path_text,
            true,
            format!("설정 파일이 {}바이트 제한을 넘었습니다", MAX_SETTINGS_BYTES),
        );
    }
    let parsed = fs::read(path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(|error| error.to_string())
        })
        .and_then(|value| match value {
            Value::Object(root) => Ok(root),
            _ => Err("설정 파일 최상위 값이 객체가 아닙니다".to_owned()),
        });
    match parsed {
        Ok(root) => ScopeDocument {
            status: ClaudeSettingsFileStatus {
                path: path_text,
                exists: true,
                parse_error: None,
            },
            root: Some(root),
        },
        Err(error) => invalid_scope(path_text, true, error),
    }
}

fn invalid_scope(path: String, exists: bool, error: String) -> ScopeDocument {
    ScopeDocument {
        status: ClaudeSettingsFileStatus {
            path,
            exists,
            parse_error: Some(error),
        },
        root: None,
    }
}

fn plugin_setting_value(value: &Value) -> Option<ClaudePluginSettingValue> {
    match value {
        Value::Bool(true) => Some(ClaudePluginSettingValue::True),
        Value::Bool(false) => Some(ClaudePluginSettingValue::False),
        Value::Array(_) | Value::Object(_) | Value::String(_) => {
            Some(ClaudePluginSettingValue::Custom)
        }
        _ => None,
    }
}

fn skill_override_value(value: &Value) -> Option<SkillOverrideValue> {
    value.as_str()?.parse().ok()
}

/// 설치된 마켓플레이스 플러그인의 설정 상태. 스킬 쪽 `scan_skill_overrides`와 짝이며,
/// 이름·플러그인 id 순으로 고정해 화면이 조회마다 순서를 바꾸지 않게 한다.
fn plugin_states(home: &Path, documents: &ScopeDocuments) -> Vec<ClaudePluginState> {
    let mut plugins = claude_installed_plugins(home)
        .into_iter()
        .map(|installed| {
            let setting =
                documents.resolve("enabledPlugins", &installed.plugin_id, plugin_setting_value);
            // 우리가 쓰지 않는 모양(배열·객체·문자열)으로 적힌 값은 사용자가 손으로 넣은
            // 설정이다. 켜진 것으로 보되 덮어쓰지 않도록 잠근다.
            let locked = setting.locked(
                setting
                    .winner_value()
                    .is_some_and(ClaudePluginSettingValue::is_custom),
            );
            ClaudePluginState {
                plugin_id: installed.plugin_id,
                name: installed.name,
                marketplace: installed.marketplace,
                version: installed.version,
                install_path: installed.install_path.to_string_lossy().into_owned(),
                skill_count: count_skill_directories(&installed.install_path.join("skills")),
                default_enabled: installed.default_enabled,
                effective_enabled: setting
                    .winner_value()
                    .map(|value| !value.is_disabled())
                    .unwrap_or(installed.default_enabled),
                decided_by: setting.decided_by(),
                locked,
                values: setting.values,
            }
        })
        .collect::<Vec<_>>();
    plugins.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.plugin_id.cmp(&right.plugin_id))
    });
    plugins
}

fn scan_skill_overrides(
    parent: &Path,
    scope: &str,
    project_path: Option<String>,
    documents: &ScopeDocuments,
    output: &mut Vec<ClaudeSkillOverrideState>,
) {
    let mut seen = BTreeSet::new();
    for directory in child_directories(parent) {
        let path = directory.join("SKILL.md");
        let Ok(text) = read_text_limited(&path, MAX_SKILL_FILE_BYTES) else {
            continue;
        };
        let (frontmatter, _) = split_frontmatter(&text);
        let fallback = directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "skill".to_owned());
        let name = frontmatter_value(frontmatter, "name").unwrap_or(fallback);
        if name.trim().is_empty() || !seen.insert(directory.clone()) {
            continue;
        }
        let setting = documents.resolve("skillOverrides", &name, skill_override_value);
        // 해석하지 못한 값이 한 갈래라도 있으면 사용자가 손으로 고쳐야 한다.
        let locked =
            setting.locked(documents.has_unreadable("skillOverrides", &name, skill_override_value));
        output.push(ClaudeSkillOverrideState {
            override_key: name.clone(),
            name,
            directory: directory.to_string_lossy().into_owned(),
            scope: scope.to_owned(),
            project_path: project_path.clone(),
            effective: setting.winner_value().unwrap_or(SkillOverrideValue::On),
            decided_by: setting.decided_by(),
            locked,
            disable_model_invocation: frontmatter_value(frontmatter, "disable-model-invocation")
                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
            values: setting.values,
        });
    }
}

fn count_skill_directories(parent: &Path) -> usize {
    child_directories(parent)
        .into_iter()
        .filter(|directory| directory.join("SKILL.md").is_file())
        .count()
}

fn write_target(
    home: &Path,
    project: Option<&Path>,
    scope: ClaudeSettingsWriteScope,
) -> Result<PathBuf, CoreError> {
    match scope {
        ClaudeSettingsWriteScope::User => Ok(home.join(".claude/settings.json")),
        ClaudeSettingsWriteScope::Project => project
            .map(|root| root.join(".claude/settings.local.json"))
            .ok_or_else(|| {
                CoreError::InvalidInput(
                    "프로젝트 설정을 바꾸려면 등록 프로젝트를 선택해야 합니다".to_owned(),
                )
            }),
    }
}

fn mutate_settings_entry(
    app_data_dir: &Path,
    target: &Path,
    section: &str,
    key: &str,
    next: Option<Value>,
    editable_current: impl Fn(&Value) -> bool,
) -> Result<(), CoreError> {
    if key.trim().is_empty() || key.len() > 512 || key.contains(['\n', '\r', '\0']) {
        return Err(CoreError::InvalidInput(
            "설정 키가 올바르지 않습니다".to_owned(),
        ));
    }
    CLAUDE_GUARD.ensure_parent(target)?;
    let document = read_scope_document(target);
    if let Some(error) = document.status.parse_error {
        return Err(CoreError::InvalidInput(format!(
            "Claude 설정 파일을 안전하게 수정할 수 없습니다: {error}"
        )));
    }
    let mut root = document.root.unwrap_or_default();
    let before = root.clone();
    let section_value = root
        .entry(section.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let entries = section_value.as_object_mut().ok_or_else(|| {
        CoreError::InvalidInput(format!("Claude 설정의 {section} 값이 객체가 아닙니다"))
    })?;
    if entries
        .get(key)
        .is_some_and(|current| !editable_current(current))
    {
        return Err(CoreError::InvalidInput(
            "사용자 지정 또는 알 수 없는 설정값은 Agent Manager가 덮어쓰지 않습니다".to_owned(),
        ));
    }
    match next {
        Some(value) => {
            entries.insert(key.to_owned(), value);
        }
        None => {
            entries.remove(key);
        }
    }
    if entries.is_empty() {
        root.remove(section);
    }
    if root == before {
        return Ok(());
    }
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(root))?;
    bytes.push(b'\n');
    if document.status.exists {
        let original = fs::read(target)?;
        save_backup(app_data_dir, BACKUP_STORE, "json", target, &original)?;
    }
    CLAUDE_GUARD.atomic_write(target, &bytes)
}

fn policy_settings_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(PathBuf::from(
            "/Library/Application Support/ClaudeCode/managed-settings.json",
        ))
    }
    #[cfg(target_os = "windows")]
    {
        Some(PathBuf::from(
            r"C:\Program Files\ClaudeCode\managed-settings.json",
        ))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Some(PathBuf::from("/etc/claude-code/managed-settings.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_settings_file::BACKUP_LIMIT;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().expect("fixture");
        let home = root.path().join("home");
        let app_data = root.path().join("app-data");
        let install = home.join(".claude/plugins/cache/official/demo/1.0.0");
        fs::create_dir_all(install.join(".claude-plugin")).expect("manifest dir");
        fs::create_dir_all(install.join("skills/plugin-skill")).expect("plugin skill");
        fs::write(
            install.join(".claude-plugin/plugin.json"),
            r#"{"defaultEnabled":false}"#,
        )
        .expect("manifest");
        fs::write(
            install.join("skills/plugin-skill/SKILL.md"),
            "---\nname: plugin-skill\n---\nbody",
        )
        .expect("plugin skill file");
        fs::create_dir_all(home.join(".claude/plugins")).expect("plugin registry dir");
        fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "plugins": {
                    "demo@official": [{
                        "installPath": install,
                        "version": "1.0.0"
                    }]
                }
            }))
            .expect("registry json"),
        )
        .expect("registry");
        let personal = home.join(".claude/skills/personal-skill");
        fs::create_dir_all(&personal).expect("personal skill");
        fs::write(
            personal.join("SKILL.md"),
            "---\nname: personal-skill\n---\nbody",
        )
        .expect("personal skill file");
        (root, home, app_data)
    }

    fn plugin_request(enabled: Option<bool>) -> SetClaudePluginEnabledRequest {
        SetClaudePluginEnabledRequest {
            plugin_id: "demo@official".to_owned(),
            scope: ClaudeSettingsWriteScope::User,
            project_path: None,
            enabled,
        }
    }

    #[test]
    fn merges_scope_entries_and_treats_custom_plugin_values_as_enabled_and_locked() {
        let (_root, home, _app_data) = fixture();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"demo@official":false},"skillOverrides":{"personal-skill":"off"}}"#,
        )
        .expect("user settings");
        let project = home.join("project");
        fs::create_dir_all(project.join(".claude")).expect("project settings dir");
        fs::write(
            project.join(".claude/settings.local.json"),
            r#"{"enabledPlugins":{"demo@official":["1.0.0"]},"skillOverrides":{"personal-skill":"name-only"}}"#,
        )
        .expect("local settings");

        let snapshot = load_claude_settings_states_with_home(&home, Some(&project)).expect("load");
        let plugin = &snapshot.plugins[0];
        assert!(plugin.effective_enabled);
        assert!(plugin.locked);
        assert_eq!(plugin.decided_by, Some(ClaudeSettingsScopeKind::Local));
        assert_eq!(plugin.skill_count, 1);
        let skill = snapshot
            .skills
            .iter()
            .find(|skill| skill.override_key == "personal-skill")
            .expect("personal skill");
        assert_eq!(skill.effective, SkillOverrideValue::NameOnly);
        assert_eq!(skill.decided_by, Some(ClaudeSettingsScopeKind::Local));
    }

    #[test]
    fn write_preserves_unknown_values_and_creates_a_private_backup() {
        let (_root, home, app_data) = fixture();
        let settings = home.join(".claude/settings.json");
        let blob = serde_json::json!({"hooks":{"PreToolUse":[{"matcher":"x","hooks":[{"type":"command","command":"keep"}]}]},"enabledPlugins":{"demo@official":false}});
        fs::write(&settings, serde_json::to_vec_pretty(&blob).unwrap()).expect("settings");

        set_claude_plugin_enabled_with_home(&app_data, &home, None, &plugin_request(Some(true)))
            .expect("toggle");
        let stored: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert_eq!(stored["hooks"], blob["hooks"]);
        assert_eq!(stored["enabledPlugins"]["demo@official"], true);
        let backup_root = app_data.join("claude-settings-backups");
        let backups = fs::read_dir(backup_root)
            .unwrap()
            .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
            .count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn corrupt_and_custom_target_values_are_reported_and_never_overwritten() {
        let (_root, home, app_data) = fixture();
        let settings = home.join(".claude/settings.json");
        fs::write(&settings, b"{ broken").expect("broken settings");
        let snapshot = load_claude_settings_states_with_home(&home, None).expect("read report");
        assert!(snapshot.scopes.user.parse_error.is_some());
        assert!(set_claude_plugin_enabled_with_home(
            &app_data,
            &home,
            None,
            &plugin_request(Some(true)),
        )
        .is_err());

        fs::write(
            &settings,
            r#"{"enabledPlugins":{"demo@official":["1.0.0"]}}"#,
        )
        .expect("custom settings");
        assert!(set_claude_plugin_enabled_with_home(
            &app_data,
            &home,
            None,
            &plugin_request(Some(false)),
        )
        .is_err());
    }

    #[test]
    fn removing_the_last_entry_removes_the_empty_section() {
        let (_root, home, app_data) = fixture();
        let settings = home.join(".claude/settings.json");
        fs::write(
            &settings,
            r#"{"enabledPlugins":{"demo@official":false},"theme":"dark"}"#,
        )
        .expect("settings");
        set_claude_plugin_enabled_with_home(&app_data, &home, None, &plugin_request(None))
            .expect("inherit");
        let stored: Value = serde_json::from_slice(&fs::read(settings).unwrap()).unwrap();
        assert!(stored.get("enabledPlugins").is_none());
        assert_eq!(stored["theme"], "dark");
    }

    #[test]
    fn project_scope_creates_only_settings_local_under_the_selected_project() {
        let (_root, home, app_data) = fixture();
        let project = home.join("project");
        fs::create_dir(&project).expect("project");
        let request = SetClaudeSkillOverrideRequest {
            override_key: "personal-skill".to_owned(),
            scope: ClaudeSettingsWriteScope::Project,
            project_path: Some(project.to_string_lossy().into_owned()),
            value: Some(SkillOverrideValue::Off),
        };
        set_claude_skill_override_with_home(&app_data, &home, Some(&project), &request)
            .expect("project override");
        let local = project.join(".claude/settings.local.json");
        assert!(local.is_file());
        assert!(!project.join(".claude/settings.json").exists());
        let stored: Value = serde_json::from_slice(&fs::read(&local).unwrap()).unwrap();
        assert_eq!(stored["skillOverrides"]["personal-skill"], "off");
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(project.join(".claude"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&local).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(fs::read_dir(project.join(".claude"))
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn oversized_settings_are_reported_and_never_overwritten() {
        let (_root, home, app_data) = fixture();
        let settings = home.join(".claude/settings.json");
        let original = vec![b' '; MAX_SETTINGS_BYTES as usize + 1];
        fs::write(&settings, &original).expect("oversized settings");

        let snapshot = load_claude_settings_states_with_home(&home, None).expect("read report");
        assert!(snapshot.scopes.user.parse_error.is_some());
        assert!(set_claude_plugin_enabled_with_home(
            &app_data,
            &home,
            None,
            &plugin_request(Some(true)),
        )
        .is_err());
        assert_eq!(fs::read(settings).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_settings_are_not_followed() {
        use std::os::unix::fs::symlink;

        let (_root, home, app_data) = fixture();
        let target = home.join("target.json");
        fs::write(&target, r#"{"enabledPlugins":{}}"#).expect("target");
        symlink(&target, home.join(".claude/settings.json")).expect("symlink");
        assert!(set_claude_plugin_enabled_with_home(
            &app_data,
            &home,
            None,
            &plugin_request(Some(true)),
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            r#"{"enabledPlugins":{}}"#
        );
    }

    #[test]
    fn backup_rotation_keeps_only_the_five_latest_files() {
        let (_root, home, app_data) = fixture();
        let settings = home.join(".claude/settings.json");
        fs::write(&settings, r#"{"enabledPlugins":{"demo@official":false}}"#).unwrap();
        for enabled in [true, false, true, false, true, false, true] {
            set_claude_plugin_enabled_with_home(
                &app_data,
                &home,
                None,
                &plugin_request(Some(enabled)),
            )
            .expect("toggle");
        }
        let backup_root = app_data.join("claude-settings-backups");
        let backup_dir = fs::read_dir(backup_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read_dir(backup_dir).unwrap().count(), BACKUP_LIMIT);
    }

    #[test]
    fn claude_settings_scope_kind_display_and_from_str_round_trip() {
        assert_eq!(
            ClaudeSettingsScopeKind::ALL,
            [
                ClaudeSettingsScopeKind::User,
                ClaudeSettingsScopeKind::Project,
                ClaudeSettingsScopeKind::Local,
                ClaudeSettingsScopeKind::Policy,
            ]
        );
        for kind in ClaudeSettingsScopeKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(
                kind.as_str().parse::<ClaudeSettingsScopeKind>().unwrap(),
                kind
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: ClaudeSettingsScopeKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert_eq!(
            "  user  ".parse::<ClaudeSettingsScopeKind>().unwrap(),
            ClaudeSettingsScopeKind::User
        );
        assert_eq!(
            "  project  ".parse::<ClaudeSettingsScopeKind>().unwrap(),
            ClaudeSettingsScopeKind::Project
        );
        assert_eq!(
            "  local  ".parse::<ClaudeSettingsScopeKind>().unwrap(),
            ClaudeSettingsScopeKind::Local
        );
        assert_eq!(
            "  policy  ".parse::<ClaudeSettingsScopeKind>().unwrap(),
            ClaudeSettingsScopeKind::Policy
        );
        assert!(matches!(
            "invalid".parse::<ClaudeSettingsScopeKind>(),
            Err(CoreError::InvalidInput(_))
        ));

        // 헬퍼 메서드 검증
        assert!(!ClaudeSettingsScopeKind::User.is_project_scoped());
        assert!(ClaudeSettingsScopeKind::Project.is_project_scoped());
        assert!(ClaudeSettingsScopeKind::Local.is_project_scoped());
        assert!(!ClaudeSettingsScopeKind::Policy.is_project_scoped());

        assert!(ClaudeSettingsScopeKind::User.is_writable());
        assert!(ClaudeSettingsScopeKind::Project.is_writable());
        assert!(!ClaudeSettingsScopeKind::Local.is_writable());
        assert!(!ClaudeSettingsScopeKind::Policy.is_writable());

        assert_eq!(
            ClaudeSettingsScopeKind::User.as_write_scope(),
            Some(ClaudeSettingsWriteScope::User)
        );
        assert_eq!(
            ClaudeSettingsScopeKind::Project.as_write_scope(),
            Some(ClaudeSettingsWriteScope::Project)
        );
        assert_eq!(ClaudeSettingsScopeKind::Local.as_write_scope(), None);
        assert_eq!(ClaudeSettingsScopeKind::Policy.as_write_scope(), None);
    }

    #[test]
    fn claude_settings_write_scope_display_and_from_str_round_trip() {
        assert_eq!(
            ClaudeSettingsWriteScope::ALL,
            [
                ClaudeSettingsWriteScope::User,
                ClaudeSettingsWriteScope::Project
            ]
        );
        for scope in ClaudeSettingsWriteScope::ALL {
            assert_eq!(scope.to_string(), scope.as_str());
            assert_eq!(
                scope.as_str().parse::<ClaudeSettingsWriteScope>().unwrap(),
                scope
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&scope).unwrap();
            assert_eq!(serialized, format!("\"{}\"", scope.as_str()));
            let deserialized: ClaudeSettingsWriteScope = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, scope);
        }
        assert_eq!(
            "  user  ".parse::<ClaudeSettingsWriteScope>().unwrap(),
            ClaudeSettingsWriteScope::User
        );
        assert_eq!(
            "  project  ".parse::<ClaudeSettingsWriteScope>().unwrap(),
            ClaudeSettingsWriteScope::Project
        );
        assert!(matches!(
            "local".parse::<ClaudeSettingsWriteScope>(),
            Err(CoreError::InvalidInput(_))
        ));

        // 헬퍼 메서드 검증
        assert_eq!(
            ClaudeSettingsWriteScope::User.as_scope_kind(),
            ClaudeSettingsScopeKind::User
        );
        assert_eq!(
            ClaudeSettingsWriteScope::Project.as_scope_kind(),
            ClaudeSettingsScopeKind::Project
        );
    }

    #[test]
    fn claude_plugin_setting_value_display_and_from_str_round_trip() {
        assert_eq!(
            ClaudePluginSettingValue::ALL,
            [
                ClaudePluginSettingValue::True,
                ClaudePluginSettingValue::False,
                ClaudePluginSettingValue::Custom,
            ]
        );
        for value in ClaudePluginSettingValue::ALL {
            assert_eq!(value.to_string(), value.as_str());
            assert_eq!(
                value.as_str().parse::<ClaudePluginSettingValue>().unwrap(),
                value
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&value).unwrap();
            assert_eq!(serialized, format!("\"{}\"", value.as_str()));
            let deserialized: ClaudePluginSettingValue = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, value);
        }
        assert_eq!(
            "  true  ".parse::<ClaudePluginSettingValue>().unwrap(),
            ClaudePluginSettingValue::True
        );
        assert_eq!(
            "  false  ".parse::<ClaudePluginSettingValue>().unwrap(),
            ClaudePluginSettingValue::False
        );
        assert_eq!(
            "  custom  ".parse::<ClaudePluginSettingValue>().unwrap(),
            ClaudePluginSettingValue::Custom
        );
        assert!(matches!(
            "other".parse::<ClaudePluginSettingValue>(),
            Err(CoreError::InvalidInput(_))
        ));

        // 헬퍼 메서드 검증
        assert!(ClaudePluginSettingValue::True.is_enabled());
        assert!(!ClaudePluginSettingValue::False.is_enabled());
        assert!(!ClaudePluginSettingValue::Custom.is_enabled());

        assert!(!ClaudePluginSettingValue::True.is_disabled());
        assert!(ClaudePluginSettingValue::False.is_disabled());
        assert!(!ClaudePluginSettingValue::Custom.is_disabled());

        assert!(!ClaudePluginSettingValue::True.is_custom());
        assert!(!ClaudePluginSettingValue::False.is_custom());
        assert!(ClaudePluginSettingValue::Custom.is_custom());
    }

    #[test]
    fn skill_override_value_display_and_from_str_round_trip() {
        assert_eq!(
            SkillOverrideValue::ALL,
            [
                SkillOverrideValue::On,
                SkillOverrideValue::NameOnly,
                SkillOverrideValue::UserInvocableOnly,
                SkillOverrideValue::Off,
            ]
        );
        for value in SkillOverrideValue::ALL {
            assert_eq!(value.to_string(), value.as_str());
            assert_eq!(value.as_str().parse::<SkillOverrideValue>().unwrap(), value);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&value).unwrap();
            assert_eq!(serialized, format!("\"{}\"", value.as_str()));
            let deserialized: SkillOverrideValue = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, value);
        }
        assert_eq!(
            "  on  ".parse::<SkillOverrideValue>().unwrap(),
            SkillOverrideValue::On
        );
        assert_eq!(
            "  name-only  ".parse::<SkillOverrideValue>().unwrap(),
            SkillOverrideValue::NameOnly
        );
        assert_eq!(
            "  user-invocable-only  "
                .parse::<SkillOverrideValue>()
                .unwrap(),
            SkillOverrideValue::UserInvocableOnly
        );
        assert_eq!(
            "  off  ".parse::<SkillOverrideValue>().unwrap(),
            SkillOverrideValue::Off
        );
        assert!(matches!(
            "disabled".parse::<SkillOverrideValue>(),
            Err(CoreError::InvalidInput(_))
        ));

        // 헬퍼 메서드 검증
        assert!(SkillOverrideValue::On.is_active());
        assert!(SkillOverrideValue::NameOnly.is_active());
        assert!(SkillOverrideValue::UserInvocableOnly.is_active());
        assert!(!SkillOverrideValue::Off.is_active());

        assert!(!SkillOverrideValue::On.is_disabled());
        assert!(!SkillOverrideValue::NameOnly.is_disabled());
        assert!(!SkillOverrideValue::UserInvocableOnly.is_disabled());
        assert!(SkillOverrideValue::Off.is_disabled());
    }
}
