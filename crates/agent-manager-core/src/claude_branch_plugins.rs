//! 프로젝트의 브랜치별 Claude Code 플러그인 사용 규칙(앱 소유 저장소).
//!
//! # 왜 앱이 규칙을 들고 있는가
//!
//! Claude Code의 `enabledPlugins`에는 브랜치 조건이 없다. 설정 파일 네 스코프 어디에도
//! "이 브랜치에서만"을 적을 자리가 없고, CLI는 기동할 때 그 값을 한 번 읽는다. 그래서
//! 브랜치 조건은 공급자에게 맡길 수 없고, 이 저장소가 규칙을 들고 있다가 **실행을 띄우는
//! 시점에 그 브랜치의 구체값으로 바꿔** CLI에 넘긴다.
//!
//! # 어디에도 쓰지 않는다
//!
//! 규칙을 파일로 실현하는 방법(프로젝트 `settings.local.json`을 브랜치가 바뀔 때마다
//! 다시 쓰기)은 택하지 않았다. 그 파일은 사용자가 직접 켜고 끄는 자리(C8)이고, 같은
//! 체크아웃에서 터미널로 띄운 Claude도 함께 읽는다. 앱이 그 파일을 브랜치마다 되쓰면
//! 사용자가 손으로 정한 값과 싸우게 된다. 대신 실행 하나에만 붙는 `--settings` JSON으로
//! 넘긴다 — 공급자 소유 파일은 읽지도 쓰지도 않으므로 C8의 쓰기 경계가 넓어지지 않는다.
//!
//! `--settings`는 사용자 설정보다 우선하며 켜는 쪽과 끄는 쪽 모두 덮어쓴다. 규칙이 없거나
//! 브랜치를 판정할 수 없으면(detached HEAD, git 저장소가 아님) 플래그 자체를 붙이지 않아
//! 기존 동작 그대로 둔다.
//!
//! 실행 중 세션은 브랜치를 바꿔도 달라지지 않는다. CLI가 플러그인·스킬·훅 목록을 시작할 때
//! 한 번만 읽기 때문이고, 이 규칙은 다음 실행부터 적용된다.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::git_refs;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::CoreError;

const STORE_VERSION: u32 = 1;
/// 브랜치 규칙은 기기 단위 앱 결정이므로 앱 데이터에만 둔다(G7).
const STORE: JsonStore = JsonStore {
    file: "claude-plugin-branch-rules.json",
    lock_file: "claude-plugin-branch-rules.lock",
    label: "Claude 플러그인 브랜치 규칙 저장소",
    version: STORE_VERSION,
};

/// 저장할 수 있는 규칙 수 상한. 한 프로젝트에서 쓸 브랜치 패턴과 플러그인 조합을 넉넉히
/// 담으면서, 실행마다 도는 판정이 무한정 길어지지 않게 한다.
pub const MAX_BRANCH_RULES: usize = 256;
const MAX_BRANCH_CHARS: usize = 200;
const MAX_PLUGIN_ID_CHARS: usize = 200;
/// 화면에 실어 보낼 로컬 브랜치 수 상한. 레인 워크트리를 많이 쓰는 저장소도 담기면서,
/// 목록 하나가 스냅숏을 과도하게 부풀리지 않게 한다. 넘치면 사전순 앞쪽만 남는다.
const MAX_BRANCH_LIST: usize = 500;

/// 브랜치 하나에 걸린 플러그인 사용 규칙. 저장본과 화면 표시가 같은 모양이라 한 타입을
/// 함께 쓴다. `branch`는 정확한 이름이거나 `*`를 포함한 패턴(`feature/*`)이다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePluginBranchRule {
    pub project_path: String,
    pub branch: String,
    pub plugin_id: String,
    pub enabled: bool,
}

/// 화면이 "지금 어느 브랜치인가"를 함께 보여줄 수 있게 싣는 프로젝트 상태.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePluginBranchProject {
    pub path: String,
    /// 현재 체크아웃된 브랜치. detached HEAD이거나 git 저장소가 아니면 없다.
    pub current_branch: Option<String>,
    /// 그 저장소의 로컬 브랜치 이름(사전순). 화면이 타이핑 대신 목록에서 고르게 한다.
    /// git 저장소가 아니면 비어 있고, 그때는 패턴 입력만 남는다.
    pub branches: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePluginBranchRulesSnapshot {
    pub schema_version: u32,
    pub rules: Vec<ClaudePluginBranchRule>,
    pub projects: Vec<ClaudePluginBranchProject>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClaudePluginBranchRuleRequest {
    pub project_path: String,
    pub branch: String,
    pub plugin_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveClaudePluginBranchRuleRequest {
    pub project_path: String,
    pub branch: String,
    pub plugin_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchRuleStore {
    schema_version: u32,
    #[serde(default)]
    rules: Vec<ClaudePluginBranchRule>,
}

impl Default for BranchRuleStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            rules: Vec::new(),
        }
    }
}

impl SchemaVersioned for BranchRuleStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

/// 저장된 규칙과 `projects`로 받은 폴더의 현재 브랜치를 함께 돌려준다. 규칙이 걸린
/// 프로젝트는 `projects`에 없어도 목록에 들어간다 — 등록이 풀린 프로젝트의 남은 규칙을
/// 화면에서 지울 수 있어야 하기 때문이다.
pub fn load_claude_plugin_branch_rules(
    app_data_dir: &Path,
    projects: &[PathBuf],
) -> Result<ClaudePluginBranchRulesSnapshot, CoreError> {
    let store: BranchRuleStore = STORE.read(app_data_dir)?;
    Ok(snapshot(store, projects))
}

/// 규칙 하나를 더하거나 그 자리의 사용 여부를 바꾼다. `project`는 호출부가 이미 등록
/// 프로젝트로 확인하고 정규화한 경로다.
pub fn set_claude_plugin_branch_rule(
    app_data_dir: &Path,
    project: &Path,
    request: &SetClaudePluginBranchRuleRequest,
    projects: &[PathBuf],
) -> Result<ClaudePluginBranchRulesSnapshot, CoreError> {
    let branch = validated_branch(&request.branch)?;
    let plugin_id = validated_plugin_id(&request.plugin_id)?;
    let project_path = path_key(project);
    let store = STORE.update(app_data_dir, |store: &mut BranchRuleStore| {
        match store.rules.iter_mut().find(|rule| {
            rule.project_path == project_path
                && rule.branch == branch
                && rule.plugin_id == plugin_id
        }) {
            Some(existing) => existing.enabled = request.enabled,
            None => {
                if store.rules.len() >= MAX_BRANCH_RULES {
                    return Err(CoreError::InvalidInput(format!(
                        "브랜치 규칙은 최대 {MAX_BRANCH_RULES}개까지 저장할 수 있습니다"
                    )));
                }
                store.rules.push(ClaudePluginBranchRule {
                    project_path: project_path.clone(),
                    branch: branch.clone(),
                    plugin_id: plugin_id.clone(),
                    enabled: request.enabled,
                });
            }
        }
        sort_rules(&mut store.rules);
        Ok(true)
    })?;
    Ok(snapshot(store, projects))
}

/// 규칙 하나를 지운다. 등록이 풀린 프로젝트의 규칙도 지울 수 있어야 하므로 저장된
/// 경로 문자열과 정규화한 경로 양쪽으로 맞춰 본다.
pub fn remove_claude_plugin_branch_rule(
    app_data_dir: &Path,
    request: &RemoveClaudePluginBranchRuleRequest,
    projects: &[PathBuf],
) -> Result<ClaudePluginBranchRulesSnapshot, CoreError> {
    let branch = validated_branch(&request.branch)?;
    let plugin_id = validated_plugin_id(&request.plugin_id)?;
    let requested = request.project_path.trim().to_owned();
    let canonical = fs::canonicalize(&requested).map(|path| path_key(&path));
    let store = STORE.update(app_data_dir, |store: &mut BranchRuleStore| {
        let before = store.rules.len();
        store.rules.retain(|rule| {
            let same_project = rule.project_path == requested
                || canonical
                    .as_ref()
                    .is_ok_and(|canonical| &rule.project_path == canonical);
            !(same_project && rule.branch == branch && rule.plugin_id == plugin_id)
        });
        Ok(store.rules.len() != before)
    })?;
    Ok(snapshot(store, projects))
}

/// 이 실행에 붙일 `--settings` JSON. 규칙이 하나도 걸리지 않으면 None이라 플래그 자체가
/// 붙지 않는다. 저장소를 읽지 못해도 실행을 막지 않고 None으로 되돌린다 — 브랜치 규칙은
/// 실행을 시작할 조건이 아니라 그 실행에 얹는 선택이다.
///
/// 브랜치 이름을 읽지 못하는 작업 폴더(형상관리 밖이거나 detached HEAD)에서도 규칙을 본다.
/// 그 자리에서는 브랜치를 가리지 않겠다고 적은 `*` 규칙만 걸린다.
pub(crate) fn branch_plugin_settings_json(app_data_dir: &Path, cwd: &Path) -> Option<String> {
    let cwd = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let branch = git_refs::head_branch(&cwd);
    let store: BranchRuleStore = STORE.read(app_data_dir).ok()?;
    let overrides = resolve_overrides(&store.rules, &cwd, branch.as_deref());
    if overrides.is_empty() {
        return None;
    }
    Some(json!({ "enabledPlugins": overrides }).to_string())
}

fn snapshot(store: BranchRuleStore, projects: &[PathBuf]) -> ClaudePluginBranchRulesSnapshot {
    let mut paths: Vec<String> = projects.iter().map(|path| path_key(path)).collect();
    for rule in &store.rules {
        if !paths.contains(&rule.project_path) {
            paths.push(rule.project_path.clone());
        }
    }
    paths.sort();
    paths.dedup();
    ClaudePluginBranchRulesSnapshot {
        schema_version: STORE_VERSION,
        rules: store.rules,
        projects: paths
            .into_iter()
            .map(|path| ClaudePluginBranchProject {
                current_branch: git_refs::head_branch(Path::new(&path)),
                branches: local_branches(Path::new(&path)),
                path,
            })
            .collect(),
    }
}

fn sort_rules(rules: &mut [ClaudePluginBranchRule]) {
    rules.sort_by(|left, right| {
        (&left.project_path, &left.plugin_id, &left.branch).cmp(&(
            &right.project_path,
            &right.plugin_id,
            &right.branch,
        ))
    });
}

/// 규칙의 프로젝트 경로를 실제 폴더 기준으로 맞춘다. 실행 경로는 작업 폴더를 정규화한
/// 뒤 비교하므로(`/var` → `/private/var` 같은 심볼릭 링크), 저장할 때도 같은 모양으로
/// 두지 않으면 같은 폴더를 가리키는 규칙이 걸리지 않는다.
fn path_key(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .trim_end_matches('/')
        .to_owned()
}

/// git 참조 이름에 쓸 수 없는 글자를 막고, 패턴 글자 `*`만 더 허용한다.
fn validated_branch(branch: &str) -> Result<String, CoreError> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(CoreError::InvalidInput(
            "브랜치 이름을 입력하세요".to_owned(),
        ));
    }
    if branch.chars().count() > MAX_BRANCH_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "브랜치 이름은 {MAX_BRANCH_CHARS}자를 넘을 수 없습니다"
        )));
    }
    let invalid = branch.chars().any(|character| {
        character.is_whitespace()
            || character.is_control()
            || matches!(character, '~' | '^' | ':' | '?' | '[' | '\\' | '"' | '\'')
    });
    if invalid || branch.contains("..") {
        return Err(CoreError::InvalidInput(format!(
            "브랜치 이름에 쓸 수 없는 글자가 있습니다: {branch}"
        )));
    }
    Ok(branch.to_owned())
}

/// 플러그인 id는 설치 목록에서 온 `이름@마켓플레이스`다. 값을 그대로 설정 JSON의 키로
/// 싣기 때문에 모양을 확인한다.
fn validated_plugin_id(plugin_id: &str) -> Result<String, CoreError> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err(CoreError::InvalidInput("플러그인을 선택하세요".to_owned()));
    }
    if plugin_id.chars().count() > MAX_PLUGIN_ID_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "플러그인 id는 {MAX_PLUGIN_ID_CHARS}자를 넘을 수 없습니다"
        )));
    }
    let valid = plugin_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-_.@/".contains(character));
    if !valid {
        return Err(CoreError::InvalidInput(format!(
            "플러그인 id에 쓸 수 없는 글자가 있습니다: {plugin_id}"
        )));
    }
    Ok(plugin_id.to_owned())
}

/// 규칙을 플러그인마다 하나로 좁힌다. 더 깊은 프로젝트 경로가 얕은 경로를 이기고, 같은
/// 프로젝트 안에서는 정확한 브랜치 이름이 패턴을 이기며, 패턴끼리는 글자(`*` 제외)가 더
/// 많은 쪽이 이긴다. 그래도 같으면 브랜치 이름이 사전순으로 큰 쪽을 골라 판정이 저장
/// 순서에 흔들리지 않게 한다.
fn resolve_overrides(
    rules: &[ClaudePluginBranchRule],
    cwd: &Path,
    branch: Option<&str>,
) -> BTreeMap<String, bool> {
    let mut chosen: BTreeMap<String, (usize, u8, usize, String, bool)> = BTreeMap::new();
    for rule in rules {
        let Some(depth) = project_depth(&rule.project_path, cwd) else {
            continue;
        };
        if !branch_rule_applies(&rule.branch, branch) {
            continue;
        }
        let exact = u8::from(!rule.branch.contains('*'));
        let literals = rule.branch.chars().filter(|glyph| *glyph != '*').count();
        let score = (depth, exact, literals, rule.branch.clone(), rule.enabled);
        let weaker = chosen
            .get(&rule.plugin_id)
            .is_none_or(|current| *current < score);
        if weaker {
            chosen.insert(rule.plugin_id.clone(), score);
        }
    }
    chosen
        .into_iter()
        .map(|(plugin_id, score)| (plugin_id, score.4))
        .collect()
}

/// 규칙의 프로젝트 폴더가 작업 폴더 자신이거나 그 위쪽이면 경로 구성요소 수를, 아니면
/// None을 돌려준다. 문자열 앞머리 비교가 아니라 구성요소로 비교해 `/a/bc`가 `/a/b`의
/// 하위로 잡히지 않게 한다.
fn project_depth(project_path: &str, cwd: &Path) -> Option<usize> {
    let project = Path::new(project_path);
    if !cwd.starts_with(project) {
        return None;
    }
    Some(project.components().count())
}

/// 규칙이 이 작업 폴더에 걸리는지. 브랜치 이름을 읽었으면 평소처럼 패턴을 맞춰 보고,
/// 읽지 못했으면(형상관리 밖이거나 detached HEAD) 브랜치를 가리지 않겠다고 적은 `*`
/// 규칙만 받는다. 이름 있는 규칙까지 받으면 어느 브랜치를 뜻했는지 설명할 수 없다.
fn branch_rule_applies(pattern: &str, branch: Option<&str>) -> bool {
    match branch {
        Some(branch) => branch_matches(pattern, branch),
        None => pattern == "*",
    }
}

/// `*`만 지원하는 단순 글롭. `*`는 `/`를 포함해 아무 글자에나 맞는다.
fn branch_matches(pattern: &str, branch: &str) -> bool {
    let mut segments = pattern.split('*');
    let Some(first) = segments.next() else {
        return false;
    };
    if !branch.starts_with(first) {
        return false;
    }
    if !pattern.contains('*') {
        return pattern == branch;
    }
    let mut rest = &branch[first.len()..];
    let tail: Vec<&str> = segments.collect();
    for (index, segment) in tail.iter().enumerate() {
        let last = index + 1 == tail.len();
        if segment.is_empty() {
            if last {
                return true;
            }
            continue;
        }
        if last {
            return rest.len() >= segment.len() && rest.ends_with(segment);
        }
        match rest.find(segment) {
            Some(at) => rest = &rest[at + segment.len()..],
            None => return false,
        }
    }
    true
}

/// 화면에 실어 보낼 브랜치 목록. 저장할 수 없는 이름을 올리면 고르는 순간 거절당하므로,
/// 규칙 저장이 받아 주는 이름만 남긴다.
fn local_branches(path: &Path) -> Vec<String> {
    git_refs::local_branches(path, MAX_BRANCH_LIST, &|name| {
        validated_branch(name).is_ok_and(|valid| valid == *name)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn rule(project: &str, branch: &str, plugin: &str, enabled: bool) -> ClaudePluginBranchRule {
        ClaudePluginBranchRule {
            project_path: project.to_owned(),
            branch: branch.to_owned(),
            plugin_id: plugin.to_owned(),
            enabled,
        }
    }

    #[test]
    fn branch_pattern_matches_only_whole_names() {
        assert!(branch_matches("main", "main"));
        assert!(!branch_matches("main", "maintenance"));
        assert!(branch_matches("feature/*", "feature/login"));
        assert!(branch_matches("feature/*", "feature/a/b"));
        assert!(!branch_matches("feature/*", "hotfix/login"));
        assert!(branch_matches("*", "anything"));
        assert!(branch_matches("*-wip", "login-wip"));
        assert!(!branch_matches("*-wip", "login-wip-2"));
        assert!(branch_matches("release/*/rc", "release/3/rc"));
    }

    #[test]
    fn exact_branch_beats_pattern_and_deeper_project_beats_shallower() {
        let cwd = Path::new("/repo/app");
        let rules = [
            rule("/repo", "*", "demo@official", false),
            rule("/repo", "main", "demo@official", true),
            rule("/repo/app", "*", "demo@official", false),
        ];
        // 더 깊은 /repo/app 규칙이 이긴다.
        assert_eq!(
            resolve_overrides(&rules, cwd, Some("main")),
            BTreeMap::from([("demo@official".to_owned(), false)])
        );
        // 같은 깊이라면 정확한 이름이 패턴을 이긴다.
        assert_eq!(
            resolve_overrides(&rules[..2], cwd, Some("main")),
            BTreeMap::from([("demo@official".to_owned(), true)])
        );
        assert_eq!(
            resolve_overrides(&rules[..2], cwd, Some("topic")),
            BTreeMap::from([("demo@official".to_owned(), false)])
        );
    }

    #[test]
    fn rules_outside_the_working_folder_are_ignored() {
        let rules = [rule("/repo/app", "main", "demo@official", true)];
        assert!(resolve_overrides(&rules, Path::new("/repo/apple"), Some("main")).is_empty());
        assert!(resolve_overrides(&rules, Path::new("/other"), Some("main")).is_empty());
        assert_eq!(
            resolve_overrides(&rules, Path::new("/repo/app/src"), Some("main")).len(),
            1
        );
    }

    #[test]
    fn settings_json_is_absent_without_a_matching_rule() {
        let root = tempdir().expect("temp");
        let app_data = root.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data");
        let repo = root.path().join("repo");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").expect("head");
        assert_eq!(branch_plugin_settings_json(&app_data, &repo), None);

        let request = SetClaudePluginBranchRuleRequest {
            project_path: repo.to_string_lossy().into_owned(),
            branch: "release/*".to_owned(),
            plugin_id: "demo@official".to_owned(),
            enabled: true,
        };
        set_claude_plugin_branch_rule(&app_data, &repo, &request, &[]).expect("save");
        assert_eq!(
            branch_plugin_settings_json(&app_data, &repo),
            None,
            "브랜치가 패턴에 맞지 않으면 플래그를 붙이지 않는다"
        );

        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/release/1\n").expect("head");
        assert_eq!(
            branch_plugin_settings_json(&app_data, &repo).as_deref(),
            Some(r#"{"enabledPlugins":{"demo@official":true}}"#)
        );
    }

    #[test]
    fn branch_less_folders_take_only_the_any_branch_rule() {
        let rules = [
            rule("/repo/app", "*", "any@official", true),
            rule("/repo/app", "main", "named@official", true),
            rule("/repo/app", "feature/*", "pattern@official", true),
        ];
        let cwd = Path::new("/repo/app");
        assert_eq!(
            resolve_overrides(&rules, cwd, None),
            BTreeMap::from([("any@official".to_owned(), true)]),
            "브랜치를 읽지 못하면 `*` 규칙만 걸린다"
        );
        assert_eq!(
            resolve_overrides(&rules[1..], cwd, None),
            BTreeMap::new(),
            "이름과 패턴 규칙만 있으면 아무것도 걸리지 않는다"
        );
    }

    #[test]
    fn settings_json_applies_to_a_folder_outside_version_control() {
        let root = tempdir().expect("temp");
        let app_data = root.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data");
        let plain = root.path().join("plain");
        fs::create_dir_all(&plain).expect("plain dir");

        let mut request = SetClaudePluginBranchRuleRequest {
            project_path: plain.to_string_lossy().into_owned(),
            branch: "main".to_owned(),
            plugin_id: "demo@official".to_owned(),
            enabled: true,
        };
        set_claude_plugin_branch_rule(&app_data, &plain, &request, &[]).expect("save named");
        assert_eq!(
            branch_plugin_settings_json(&app_data, &plain),
            None,
            "git 저장소가 아닌 폴더에 이름 있는 규칙은 걸리지 않는다"
        );

        request.branch = "*".to_owned();
        request.enabled = false;
        set_claude_plugin_branch_rule(&app_data, &plain, &request, &[]).expect("save any");
        assert_eq!(
            branch_plugin_settings_json(&app_data, &plain).as_deref(),
            Some(r#"{"enabledPlugins":{"demo@official":false}}"#),
            "형상관리 밖이어도 `*` 규칙은 그 실행에 얹힌다"
        );
    }

    #[test]
    fn setting_the_same_rule_twice_updates_it_and_removal_clears_it() {
        let root = tempdir().expect("temp");
        let app_data = root.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data");
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        let mut request = SetClaudePluginBranchRuleRequest {
            project_path: repo.to_string_lossy().into_owned(),
            branch: "main".to_owned(),
            plugin_id: "demo@official".to_owned(),
            enabled: true,
        };
        set_claude_plugin_branch_rule(&app_data, &repo, &request, &[]).expect("save");
        request.enabled = false;
        let snapshot =
            set_claude_plugin_branch_rule(&app_data, &repo, &request, &[]).expect("update");
        assert_eq!(snapshot.rules.len(), 1);
        assert!(!snapshot.rules[0].enabled);
        assert_eq!(snapshot.projects.len(), 1, "규칙이 걸린 프로젝트가 실린다");

        let removal = RemoveClaudePluginBranchRuleRequest {
            project_path: repo.to_string_lossy().into_owned(),
            branch: "main".to_owned(),
            plugin_id: "demo@official".to_owned(),
        };
        let snapshot = remove_claude_plugin_branch_rule(&app_data, &removal, &[]).expect("remove");
        assert!(snapshot.rules.is_empty());
    }

    #[test]
    fn invalid_branch_and_plugin_values_are_refused() {
        assert!(validated_branch(" main ").is_ok());
        assert!(validated_branch("").is_err());
        assert!(validated_branch("feature login").is_err());
        assert!(validated_branch("a..b").is_err());
        assert!(validated_branch("main^").is_err());
        assert!(validated_plugin_id("demo@official").is_ok());
        assert!(validated_plugin_id("demo official").is_err());
        assert!(validated_plugin_id("").is_err());
    }
}
