//! 세션 자동정리 어댑터(`C11`).
//!
//! 세션은 늘기만 하고 줄일 방법이 없었다. 이 어댑터 이전에 세션에 대고 쓸 수 있는 값은
//! `hidden` 하나뿐이었다.
//!
//! 정리는 **두 갈래**다. 목록을 줄이는 일과 용량을 줄이는 일이 같은 일이 아니기 때문이다.
//!
//! - **툼스톤** — 세션 키를 `AppMetadata::cleaned_sessions`에 넣어 카탈로그가 다시 담지
//!   않게 한다. 목록과 스냅숏이 줄어든다.
//! - **파일 회수** — 앱 데이터 디렉터리 **안**의 실체만 휴지통으로 옮긴다. 바이트가 준다.
//!
//! 원문이 공유 공급자 홈(`~/.claude`, `~/.codex`, `~/.gemini`)에 있는 세션은 툼스톤만
//! 찍고 파일은 건드리지 않는다. 그래서 `G1`/`G2`는 그대로다. 툼스톤이 없으면 20초 주기
//! 재조사가 그 세션을 도로 담아 오므로, 툼스톤은 편의가 아니라 이 기능의 전제다.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::catalog::SessionCatalog;
use crate::chat::ChatSupervisor;
use crate::clock;
use crate::domain::{wire_enum, ChatOriginKind, ProviderId, SessionSummary};
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::scheduler::SchedulerSupervisor;
use crate::store;
use crate::trash_store;
use crate::CoreError;

const POLICY_FILE_NAME: &str = "session-cleanup-v1.json";
const TRASH_RELATIVE: &str = "trash/sessions";
const SCHEMA_VERSION: u32 = 1;

/// 영수증에 싣는 항목 수 상한. 한 회차가 2천 건을 지우는 일이 실제로 있어서, 항목을 전부
/// 실으면 영수증 파일이 정리 대상보다 커진다. 집계는 전수로 하고 항목만 자른다.
const MAX_RECEIPT_ENTRIES: usize = 100;
/// 저장하는 영수증 개수.
const MAX_RECEIPT_HISTORY: usize = 20;
/// 기동 직후에는 돌지 않는다. 부팅 때 재조사·사용량 갱신과 겹쳐 디스크를 같이 때리는 것을
/// 피한다.
const STARTUP_DELAY: Duration = Duration::from_secs(300);
/// 주기 확인 간격. 실제 실행 여부는 `last_run_at`과 `interval_hours`로 정하므로, 이 값은
/// "얼마나 자주 들여다보는가"일 뿐이다.
const TICK_INTERVAL: Duration = Duration::from_secs(600);

const DEFAULT_RETENTION_DAYS: u32 = 90;
const DEFAULT_MAX_MESSAGE_COUNT: u32 = 1;
const DEFAULT_PER_PROVIDER_CAP: u32 = 400;
/// 일정 하나가 남기는 회차 수. 사람 대화 상한보다 훨씬 작다 — 매일 도는 보고가 한 해에
/// 365건을 쌓는데 그 전부를 들고 있을 이유가 없다.
const DEFAULT_PER_AUTOMATION_CAP: u32 = 30;
const DEFAULT_HIDDEN_AFTER_DAYS: u32 = 7;
const DEFAULT_TRASH_RETENTION_DAYS: u32 = 14;
const DEFAULT_INTERVAL_HOURS: u32 = 24;

const MIN_PER_PROVIDER_CAP: u32 = 10;
/// "빈 세션" 기준의 상한. 이 조건만 방향이 반대다 — 다른 값은 크게 잡을수록 덜 지우지만
/// 이건 크게 잡을수록 더 지운다. 상한이 없으면 0을 하나 더 찍는 실수 하나로 목록 전체가
/// 대상이 된다. 100개를 주고받은 대화를 "빈 세션"이라 부를 수도 없다.
const MAX_EMPTY_MESSAGE_LIMIT: u32 = 100;
const MIN_INTERVAL_HOURS: u32 = 1;
const MAX_INTERVAL_HOURS: u32 = 24 * 30;

const DAY_MS: i64 = 86_400_000;

// ---------------------------------------------------------------------------
// 정리 루트 allowlist (C11-1, C11-2)
// ---------------------------------------------------------------------------

/// 파일을 회수할 수 있는 자리. 앱 데이터 디렉터리 기준 상대 경로로만 적는다 — 절대 경로나
/// 환경변수로 유도한 경로를 등록할 길을 아예 열어 두지 않기 위해서다.
#[derive(Debug, Clone, Copy)]
struct CleanupRootSpec {
    id: &'static str,
    label: &'static str,
    app_data_relative: &'static str,
    kind: CleanupRootKind,
}

/// 계정 프로필에서 회수할 수 있는 **대화 원문의 확장자**. 정리 루트 안에는 대화 기록만
/// 있는 것이 아니다 — 계정 프로필에는 `auth.json`(계정 자격증명)·`models_cache.json`·
/// `installation_id`가 같이 산다. 담긴 자리만 보고 지우면 세션 경로가 한 번만 잘못 들어와도
/// 자격증명을 휴지통에 넣는다.
///
/// 공급자마다 저장 모양이 다르므로 확장자도 갈라 둔다. 하나로 묶으면 한쪽을 넓힐 때 다른
/// 쪽까지 함께 넓어져, 그 공급자의 프로필에 우연히 같은 확장자를 쓰는 파일이 생기는 날
/// 조용히 회수 대상이 된다.
fn profile_transcript_extensions(provider: ProviderId) -> &'static [&'static str] {
    match provider {
        // rollout 한 건이 JSONL 파일 하나다.
        ProviderId::Codex => &["jsonl"],
        // 프로필이 Keychain 항목뿐이라 회수할 원문이 없다.
        ProviderId::Claude => &[],
        // 대화 하나가 sqlite 파일 하나다. 색인(`conversation_summaries.db`)은 세션 목록에
        // 오르지 않으므로 이 판정에 닿지 않는다.
        ProviderId::Antigravity => &["db", "pb"],
        // Codex 하네스를 빌려 쓰므로 기록도 Codex와 같은 rollout JSONL이다.
        ProviderId::Local => &["jsonl"],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanupRootKind {
    /// 계정 프로필 안에서 공급자 CLI가 쓴 대화 기록. 세션 한 건이 파일 한 개다.
    ProviderTranscript,
    /// 채팅 단위 첨부 디렉터리. 세션이 아니라 대화 ID로 묶인다.
    ChatAttachment,
}

/// 오늘 등록된 정리 루트. 늘리려면 `C11-2`에 따라 실제 배치를 확인하고,
/// [`tests::only_app_data_roots_are_allowlisted`]의 금지 목록도 함께 본다.
const CLEANUP_ROOTS: &[CleanupRootSpec] = &[
    CleanupRootSpec {
        id: "credential-profile-transcripts",
        label: "계정 프로필 대화 기록",
        app_data_relative: "credential-profiles",
        kind: CleanupRootKind::ProviderTranscript,
    },
    CleanupRootSpec {
        id: "chat-inputs",
        label: "채팅 첨부",
        app_data_relative: "chat-inputs",
        kind: CleanupRootKind::ChatAttachment,
    },
];

fn root_spec(kind: CleanupRootKind) -> &'static CleanupRootSpec {
    CLEANUP_ROOTS
        .iter()
        .find(|spec| spec.kind == kind)
        .expect("모든 정리 루트 종류는 allowlist에 등록되어 있다")
}

/// 정리 루트의 정규 경로. 앱 데이터 디렉터리 밖으로 벗어나면 거부한다(`C11-2`).
fn cleanup_root(app_data_dir: &Path, spec: &CleanupRootSpec) -> Result<Option<PathBuf>, CoreError> {
    let root = app_data_dir.join(spec.app_data_relative);
    let canonical_root = match fs::canonicalize(&root) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let canonical_app_data = fs::canonicalize(app_data_dir)?;
    if !canonical_root.starts_with(&canonical_app_data) {
        return Err(CoreError::InvalidInput(format!(
            "{} 정리 루트가 앱 데이터 디렉터리를 벗어났습니다: {}",
            spec.label,
            canonical_root.display()
        )));
    }
    Ok(Some(canonical_root))
}

/// 이름이 이 루트가 허용하는 실체 모양인지(`C11-3`).
fn has_transcript_shape(spec: &CleanupRootSpec, provider: Option<ProviderId>, path: &Path) -> bool {
    match spec.kind {
        // 디렉터리를 통째로 옮기는 루트는 모양을 따지지 않는다. 대화 ID로 묶인 첨부라
        // 공급자라는 개념 자체가 없다.
        CleanupRootKind::ChatAttachment => true,
        CleanupRootKind::ProviderTranscript => {
            // 어느 공급자 것인지 모르면 회수하지 않는다. 모양을 정하는 표가 공급자별이라,
            // 모르는 채로 통과시키면 그 표를 우회하는 길이 하나 생긴다.
            let Some(provider) = provider else {
                return false;
            };
            let allowed = profile_transcript_extensions(provider);
            // 확장자를 소문자로 맞춰 본다. 대소문자를 구분하지 않는 파일시스템에서
            // `AUTH.JSON` 같은 이름이 다른 판정을 받지 않게 한다.
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| {
                    allowed
                        .iter()
                        .any(|expected| value.eq_ignore_ascii_case(expected))
                })
        }
    }
}

/// 이 경로의 실체를 회수할 수 있는지. 등록된 루트 **안**에 있고, 그 루트가 허용하는
/// **모양**이어야 한다. 공유 공급자 홈에 있는 원문은 첫 조건에서 걸러져 툼스톤만 받고,
/// 계정 프로필의 `auth.json` 같은 이웃 파일은 둘째 조건에서 걸러진다.
fn removable_under(
    root: Option<&Path>,
    spec: &CleanupRootSpec,
    provider: Option<ProviderId>,
    path: &Path,
) -> bool {
    let (Some(root), Ok(canonical)) = (root, fs::canonicalize(path)) else {
        return false;
    };
    canonical.starts_with(root) && has_transcript_shape(spec, provider, &canonical)
}

// ---------------------------------------------------------------------------
// 정책
// ---------------------------------------------------------------------------

/// 정리 조건 한 벌.
///
/// **필드마다 `serde(default)`가 붙어 있어야 한다.** 저장본은 사람이 조건을 한 번 저장한
/// 순간부터 디스크에 남는데, 나중에 조건을 하나 더하면 그 필드가 없는 저장본은
/// `read_private_json`에서 파싱 오류가 되고(`unwrap_or_default`는 파일이 **없을** 때만
/// 쓰인다) 자동정리 조회가 영영 실패한다. 실제로 `per_automation_cap`을 더하면서 한 번
/// 밟았다. 조건은 앞으로도 늘어날 자리다.
///
/// 빠진 조건의 기본값은 **꺼짐**이다. [`Default`]가 새 설치에 주는 값(켜짐)과 일부러
/// 다르다 — 사용자가 본 적도 없는 조건이 저장본을 다시 읽었다는 이유로 혼자 켜져서
/// 세션을 지우기 시작하면 안 된다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanupPolicy {
    /// 무인 실행 스위치. 기본은 꺼짐이고, 사람이 한 번 켜야 돈다.
    #[serde(default)]
    pub enabled: bool,
    /// 마지막 갱신 이후 이 일수가 지난 세션을 정리한다.
    #[serde(default)]
    pub retention_days: Option<u32>,
    /// 메시지가 이 개수 이하인 세션을 정리한다.
    #[serde(default)]
    pub max_message_count: Option<u32>,
    /// 사람이 시작한 대화를 공급자별로 최신 이 개수만 남긴다.
    #[serde(default)]
    pub per_provider_cap: Option<u32>,
    /// 반복 요청·워크플로가 만든 세션을 **일정 하나당** 최신 이 개수만 남긴다. 사람 대화와
    /// 상한을 나눠 쓰므로, 매일 도는 보고 워크플로가 사용자의 대화를 밀어내지 못한다.
    pub per_automation_cap: Option<u32>,
    /// 보관(hidden) 세션은 **마지막 갱신 이후** 이 일수가 지나면 다른 조건과 무관하게
    /// 정리한다. 보관은 사용자가 이미 치운 것으로 본다. 보관한 시각은 따로 기록하지
    /// 않으므로 기준은 갱신 시각이다 — 오래전 대화를 오늘 보관하면 바로 대상이 된다.
    #[serde(default)]
    pub hidden_after_days: Option<u32>,
    /// 휴지통 항목을 완전 삭제하기까지의 일수(`C11-7`). 조건과 달리 꺼질 수 있는 값이
    /// 아니므로, 빠진 저장본에는 기본값을 준다 — 0이 들어가면 검증에서 막혀 조회가 실패한다.
    #[serde(default = "default_trash_retention_days")]
    pub trash_retention_days: u32,
    #[serde(default = "default_interval_hours")]
    pub interval_hours: u32,
}

fn default_trash_retention_days() -> u32 {
    DEFAULT_TRASH_RETENTION_DAYS
}

fn default_interval_hours() -> u32 {
    DEFAULT_INTERVAL_HOURS
}

impl Default for SessionCleanupPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: Some(DEFAULT_RETENTION_DAYS),
            max_message_count: Some(DEFAULT_MAX_MESSAGE_COUNT),
            per_provider_cap: Some(DEFAULT_PER_PROVIDER_CAP),
            per_automation_cap: Some(DEFAULT_PER_AUTOMATION_CAP),
            hidden_after_days: Some(DEFAULT_HIDDEN_AFTER_DAYS),
            trash_retention_days: DEFAULT_TRASH_RETENTION_DAYS,
            interval_hours: DEFAULT_INTERVAL_HOURS,
        }
    }
}

impl SessionCleanupPolicy {
    fn validate(&self) -> Result<(), CoreError> {
        if let Some(days) = self.retention_days {
            if days == 0 {
                return Err(CoreError::InvalidInput(
                    "보존 기간은 1일 이상이어야 합니다".to_owned(),
                ));
            }
        }
        if let Some(limit) = self.max_message_count {
            if limit > MAX_EMPTY_MESSAGE_LIMIT {
                return Err(CoreError::InvalidInput(format!(
                    "빈 세션 기준은 {MAX_EMPTY_MESSAGE_LIMIT}개 이하여야 합니다"
                )));
            }
        }
        if let Some(cap) = self.per_provider_cap {
            if cap < MIN_PER_PROVIDER_CAP {
                return Err(CoreError::InvalidInput(format!(
                    "공급자별 상한은 {MIN_PER_PROVIDER_CAP}건 이상이어야 합니다"
                )));
            }
        }
        if let Some(cap) = self.per_automation_cap {
            if cap == 0 {
                return Err(CoreError::InvalidInput(
                    "자동 실행 세션 상한은 1건 이상이어야 합니다".to_owned(),
                ));
            }
        }
        if let Some(days) = self.hidden_after_days {
            if days == 0 {
                return Err(CoreError::InvalidInput(
                    "보관 세션 경과일은 1일 이상이어야 합니다".to_owned(),
                ));
            }
        }
        if self.trash_retention_days == 0 {
            return Err(CoreError::InvalidInput(
                "휴지통 보관 기간은 1일 이상이어야 합니다".to_owned(),
            ));
        }
        if !(MIN_INTERVAL_HOURS..=MAX_INTERVAL_HOURS).contains(&self.interval_hours) {
            return Err(CoreError::InvalidInput(format!(
                "실행 주기는 {MIN_INTERVAL_HOURS}~{MAX_INTERVAL_HOURS}시간이어야 합니다"
            )));
        }
        if self.enabled && !self.has_any_condition() {
            return Err(CoreError::InvalidInput(
                "조건을 하나도 켜지 않으면 자동정리를 켤 수 없습니다".to_owned(),
            ));
        }
        Ok(())
    }

    fn has_any_condition(&self) -> bool {
        self.retention_days.is_some()
            || self.max_message_count.is_some()
            || self.per_provider_cap.is_some()
            || self.per_automation_cap.is_some()
            || self.hidden_after_days.is_some()
    }
}

/// 저장 요청이 싣는 조건 한 벌.
///
/// [`SessionCleanupPolicy`]와 칸은 같지만 **기본값이 없다.** 저장본과 요청은 빠진 필드의
/// 뜻이 정반대이기 때문이다.
///
/// - 저장본에서 빠진 조건은 "그 조건이 생기기 전에 저장했다"는 뜻이라 **꺼짐**으로 읽는다.
/// - 요청에서 빠진 조건은 "이 클라이언트가 그 조건을 모른다"는 뜻이다. 그대로 꺼짐으로
///   저장하면 사용자가 켜 둔 조건이 조용히 꺼진다 — 오래 열어 둔 원격 탭이 백엔드 업데이트
///   뒤에 조건 하나를 고치기만 해도 그렇게 된다. 그러니 거절해서 드러낸다.
///
/// 끄고 싶으면 `null`을 **명시**해야 한다. 키가 없는 것과 `null`은 다른 뜻이다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCleanupPolicyInput {
    pub enabled: bool,
    #[serde(deserialize_with = "present_option")]
    pub retention_days: Option<u32>,
    #[serde(deserialize_with = "present_option")]
    pub max_message_count: Option<u32>,
    #[serde(deserialize_with = "present_option")]
    pub per_provider_cap: Option<u32>,
    #[serde(deserialize_with = "present_option")]
    pub per_automation_cap: Option<u32>,
    #[serde(deserialize_with = "present_option")]
    pub hidden_after_days: Option<u32>,
    pub trash_retention_days: u32,
    pub interval_hours: u32,
}

/// `Option` 필드의 "키가 없으면 `None`" 특례를 끈다.
///
/// serde는 `Option<T>` 필드를 암묵적으로 선택 사항으로 다뤄, 키가 통째로 빠져도 조용히
/// `None`을 넣는다. 조건을 끄는 것과 조건을 모르는 것이 그렇게 같은 값이 되면, 옛
/// 클라이언트의 요청이 사용자가 켜 둔 조건을 지운다. `deserialize_with`를 달면 그 특례가
/// 꺼져 키가 없을 때 "missing field" 오류가 난다.
fn present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

impl From<SessionCleanupPolicyInput> for SessionCleanupPolicy {
    fn from(input: SessionCleanupPolicyInput) -> Self {
        Self {
            enabled: input.enabled,
            retention_days: input.retention_days,
            max_message_count: input.max_message_count,
            per_provider_cap: input.per_provider_cap,
            per_automation_cap: input.per_automation_cap,
            hidden_after_days: input.hidden_after_days,
            trash_retention_days: input.trash_retention_days,
            interval_hours: input.interval_hours,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyStore {
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    #[serde(default)]
    policy: SessionCleanupPolicy,
    #[serde(default)]
    last_run_at: Option<i64>,
    #[serde(default)]
    receipts: Vec<SessionCleanupReceipt>,
}

/// 저장본이 아예 없을 때 쓰는 기본값. `#[derive(Default)]`에 맡기면 `schema_version`이
/// 0이 되어 첫 조회가 버전 확인에서 막힌다 — `serde(default)`는 JSON 객체가 있고 그 안에
/// 필드만 빠졌을 때 작동하지, 파일 자체가 없을 때는 부르지 않는다.
impl Default for PolicyStore {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            policy: SessionCleanupPolicy::default(),
            last_run_at: None,
            receipts: Vec::new(),
        }
    }
}

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

impl SchemaVersioned for PolicyStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

/// 정책·마지막 실행 시각·영수증을 담는 앱 소유 저장소 한 벌(G7).
const STORE: JsonStore = JsonStore {
    file: POLICY_FILE_NAME,
    lock_file: "session-cleanup-v1.lock",
    label: "세션 자동정리 저장소",
    version: SCHEMA_VERSION,
};

fn load_policy_store(app_data_dir: &Path) -> Result<PolicyStore, CoreError> {
    STORE.load_unlocked(app_data_dir)
}

/// 잠금 아래에서 저장본을 고치고 언제나 다시 쓴다. 자동정리는 고친 것이 없어도 마지막
/// 실행 시각이 함께 움직이므로 무변경 조기 반환을 두지 않는다.
fn with_policy_store<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut PolicyStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    STORE.with_lock(app_data_dir, || {
        let mut store = load_policy_store(app_data_dir)?;
        let value = action(&mut store)?;
        STORE.save_unlocked(app_data_dir, &store)?;
        Ok(value)
    })
}

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionCleanupReason {
    /// 보관 중이고 마지막 갱신 이후 설정한 일수가 지났다.
    HiddenAged,
    /// 메시지가 기준 개수 이하다.
    EmptySession,
    /// 마지막 갱신 이후 보존 기간이 지났다.
    Retention,
    /// 공급자별 상한을 넘는 오래된 쪽이다.
    ProviderCap,
    /// 그 일정이 남기기로 한 회차 수를 넘는 오래된 쪽이다.
    AutomationCap,
    /// 주인 없는 채팅 첨부 디렉터리.
    OrphanAttachment,
}

impl SessionCleanupReason {
    #[cfg(test)]
    pub const ALL: [Self; 6] = [
        Self::HiddenAged,
        Self::EmptySession,
        Self::Retention,
        Self::ProviderCap,
        Self::AutomationCap,
        Self::OrphanAttachment,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::HiddenAged => "보관 중 · 갱신 후 경과",
            Self::EmptySession => "빈 세션",
            Self::Retention => "보존 기간 경과",
            Self::ProviderCap => "공급자별 상한 초과",
            Self::AutomationCap => "일정별 회차 상한 초과",
            Self::OrphanAttachment => "주인 없는 첨부",
        }
    }
}

wire_enum!(trimmed SessionCleanupReason, "알 수 없는 정리 사유입니다", {
    HiddenAged => "hiddenAged",
    EmptySession => "emptySession",
    Retention => "retention",
    ProviderCap => "providerCap",
    AutomationCap => "automationCap",
    OrphanAttachment => "orphanAttachment",
});

/// 세션을 붙잡고 있어 정리하지 않는 근거(`C11-5`, `C11-6`).
#[derive(Debug, Default)]
struct CleanupProtections {
    /// 관리 채팅이 붙어 있는 공급자 세션 ID.
    live_session_ids: BTreeSet<String>,
    /// 반복 요청이 이어갈 공급자 세션 ID.
    scheduled_session_ids: BTreeSet<String>,
    /// 인계 관계에 묶인 세션 키.
    handoff_keys: BTreeSet<String>,
}

impl CleanupProtections {
    fn reason(&self, session: &SessionSummary) -> Option<&'static str> {
        if self.live_session_ids.contains(&session.id) {
            return Some("관리 채팅이 실행 중이어서 건너뛰었습니다");
        }
        if self.scheduled_session_ids.contains(&session.id) {
            return Some("반복 요청이 이어갈 세션이어서 건너뛰었습니다");
        }
        if self
            .handoff_keys
            .contains(&store::session_key(session.source, &session.id))
        {
            return Some("인계 관계에 묶여 있어 건너뛰었습니다");
        }
        if session.meta.favorite {
            return Some("즐겨찾기여서 건너뛰었습니다");
        }
        if session.meta.note.is_some() || session.meta.custom_title.is_some() {
            return Some("메모·표시 제목이 있어 건너뛰었습니다");
        }
        None
    }
}

/// 인계 관계에 묶인 세션 키를 모은다. 원본과 대상을 양쪽 다 넣는다 — 한쪽만 지우면 남은
/// 쪽의 인계 링크가 허공을 가리킨다.
fn handoff_keys(sessions: &[SessionSummary]) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for session in sessions {
        let has_link =
            session.meta.handoff_origin.is_some() || !session.meta.handoff_targets.is_empty();
        if !has_link {
            continue;
        }
        keys.insert(store::session_key(session.source, &session.id));
        if let Some(origin) = session.meta.handoff_origin.as_ref() {
            keys.insert(store::session_key(origin.source, &origin.id));
        }
        for target in &session.meta.handoff_targets {
            keys.insert(store::session_key(target.source, &target.id));
        }
    }
    keys
}

/// 상한을 세는 단위.
///
/// 상한을 공급자 하나로만 세면 매일 도는 보고 워크플로가 최신 슬롯을 계속 차지해 사용자의
/// 대화를 밀어낸다. 시간당 한 번 도는 일정이면 한 달에 720건이고, 그 전부가 사용자의 지난
/// 대화보다 새것이다. 이 기기 실측으로도 세션 메타 3,616건 중 1,737건(48%)이 워크플로·반복
/// 요청 출처였다. 그래서 사람 대화와 자동 실행을 다른 통에 담고, 자동 실행은 다시 일정별로
/// 나눈다 — 일정 하나가 자기 몫만 쓰고 서로도 밀어내지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum CleanupBucket {
    /// 사람이 시작한 대화. 출처 기록이 없는 예전 세션도 여기로 본다 — 모르면 사람 쪽으로
    /// 기울이는 편이 안전하다.
    Human,
    /// 반복 요청·워크플로가 만든 세션. 값은 그 일정(소비자) id다.
    Automation(String),
}

fn bucket_of(session: &SessionSummary) -> CleanupBucket {
    let Some(origin) = session.meta.origin.as_ref() else {
        return CleanupBucket::Human;
    };
    match origin.kind {
        ChatOriginKind::User | ChatOriginKind::Aia => CleanupBucket::Human,
        ChatOriginKind::Schedule | ChatOriginKind::Workflow => {
            // 소비자 id가 페이싱이 쓰는 일정 단위와 같다. 없으면 일정·워크플로 id로,
            // 그것도 없으면 출처를 아는 것만으로 자동화 한 통에 몰아 넣는다.
            let key = origin
                .consumer_id
                .clone()
                .or_else(|| origin.schedule_id.clone())
                .or_else(|| origin.workflow_id.clone())
                .unwrap_or_else(|| "(미상)".to_owned());
            CleanupBucket::Automation(key)
        }
    }
}

fn age_days(session: &SessionSummary, now_ms: i64) -> Option<i64> {
    let stamp = session.updated_at.or(session.started_at)?;
    Some((now_ms - stamp).max(0) / DAY_MS)
}

/// 세션 한 건에 대한 판정. 보호 근거가 있으면 조건을 아예 보지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Verdict {
    Keep,
    Clean(SessionCleanupReason),
    Protected(&'static str),
}

/// 세션 자신만 보고 내릴 수 있는 정리 사유. 통 상한은 "남는 자리"를 세야 알 수 있어
/// 여기에 없다 — 이 함수가 보는 것은 그 세션의 나이·숨김·메시지 수뿐이다.
fn condition_reason(
    session: &SessionSummary,
    policy: &SessionCleanupPolicy,
    now_ms: i64,
) -> Option<SessionCleanupReason> {
    let age = age_days(session, now_ms);
    let aged = |days: u32| age.is_some_and(|age| age >= i64::from(days));
    if policy
        .hidden_after_days
        .is_some_and(|days| session.meta.hidden && aged(days))
    {
        return Some(SessionCleanupReason::HiddenAged);
    }
    // 메시지 수를 **아는 경우에만** 빈 세션으로 본다. Codex 세션은 색인에서 조립되어
    // `message_count`가 언제나 `None`인데(`catalog.rs`의 SQLite 갈래), 모르는 값을 0으로
    // 읽으면 실제로 오간 대화 전부가 빈 세션이 된다. 이 기기에서 Codex 1,039건이 전부
    // 그 경우였고 그중 1,004건에는 대화가 남아 있었다.
    if policy
        .max_message_count
        .zip(session.message_count)
        .is_some_and(|(limit, count)| count <= u64::from(limit))
    {
        return Some(SessionCleanupReason::EmptySession);
    }
    if policy.retention_days.is_some_and(aged) {
        return Some(SessionCleanupReason::Retention);
    }
    None
}

/// 통마다 자기 상한을 쓴다. 자동 실행이 사람 대화의 자리를 먹지 못하는 지점이다.
fn bucket_cap(
    policy: &SessionCleanupPolicy,
    bucket: &CleanupBucket,
) -> (Option<u32>, SessionCleanupReason) {
    match bucket {
        CleanupBucket::Human => (policy.per_provider_cap, SessionCleanupReason::ProviderCap),
        CleanupBucket::Automation(_) => (
            policy.per_automation_cap,
            SessionCleanupReason::AutomationCap,
        ),
    }
}

/// 목록 전체를 한 번에 판정한다. 공급자별 상한이 "남는 것"을 세는 조건이라 건별로는
/// 판정할 수 없어, 최신순으로 훑으며 남기는 자리를 채워 나간다. 보호된 세션도 자리를
/// 차지한다 — 상한은 "최신 N건만 남긴다"는 뜻이고, 보호된 세션은 남는 쪽이다.
fn evaluate(
    sessions: &[SessionSummary],
    policy: &SessionCleanupPolicy,
    protections: &CleanupProtections,
    now_ms: i64,
) -> Vec<Verdict> {
    let mut order: Vec<usize> = (0..sessions.len()).collect();
    order.sort_by_key(|&index| {
        std::cmp::Reverse(sessions[index].updated_at.or(sessions[index].started_at))
    });

    let mut verdicts = vec![Verdict::Keep; sessions.len()];
    let mut kept: BTreeMap<(ProviderId, CleanupBucket), u32> = BTreeMap::new();
    for index in order {
        let session = &sessions[index];
        let bucket = (session.source, bucket_of(session));
        if let Some(reason) = protections.reason(session) {
            verdicts[index] = Verdict::Protected(reason);
            *kept.entry(bucket).or_default() += 1;
            continue;
        }
        let (cap, cap_reason) = bucket_cap(policy, &bucket.1);
        let counted = kept.entry(bucket).or_default();
        verdicts[index] = if let Some(reason) = condition_reason(session, policy, now_ms) {
            Verdict::Clean(reason)
        } else if cap.is_some_and(|cap| *counted >= cap) {
            Verdict::Clean(cap_reason)
        } else {
            *counted += 1;
            Verdict::Keep
        };
    }
    verdicts
}

// ---------------------------------------------------------------------------
// 영수증
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanupEntry {
    pub session_key: String,
    pub source: Option<ProviderId>,
    pub title: String,
    pub reason: SessionCleanupReason,
    pub bytes_freed: u64,
    /// 목록에서 내렸는지.
    pub tombstoned: bool,
    /// 실체를 휴지통으로 옮겼는지. 공유 공급자 홈에 있는 원문은 언제나 `false`다.
    pub removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 보호 규칙이 건너뛴 이유별 건수.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanupSkipCount {
    pub reason: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanupReceipt {
    pub started_at: i64,
    pub finished_at: i64,
    /// 사람이 눌러 돌린 회차인지. 무인 회차와 구분해 보여 준다.
    pub manual: bool,
    pub tombstoned_count: usize,
    pub removed_count: usize,
    pub skipped_count: usize,
    /// 건너뛴 이유별 집계. 남은 세션이 왜 남았는지는 건수만으로는 알 수 없다.
    #[serde(default)]
    pub skipped_reasons: Vec<SessionCleanupSkipCount>,
    pub failed_count: usize,
    pub bytes_freed: u64,
    /// 보관 기간이 지나 휴지통에서 완전 삭제한 항목 수.
    pub trash_purged_count: usize,
    /// `entries`가 잘렸는지. 한 회차가 수천 건을 지우므로 항목은 상한까지만 싣는다.
    pub entries_truncated: bool,
    pub entries: Vec<SessionCleanupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionTrashManifest {
    id: String,
    group_id: String,
    deleted_at_ms: i64,
    root_id: String,
    session_key: String,
    original_path: String,
    size_bytes: u64,
}

// ---------------------------------------------------------------------------
// 상태 조회
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanupReasonCount {
    pub reason: SessionCleanupReason,
    pub label: &'static str,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanupPreview {
    /// 지금 조건에 걸리는 세션 수.
    pub target_count: usize,
    /// 그중 실체까지 회수되는 세션 수. 나머지는 목록에서만 내려간다.
    pub removable_count: usize,
    /// 회수될 바이트 추정치.
    pub removable_bytes: u64,
    /// 보호 규칙이 잡아 둔 세션 수.
    pub protected_count: usize,
    /// 정리 뒤 남는 세션 수.
    pub remaining_count: usize,
    /// 사유별 적중 건수. 어떤 조건이 실제로 일하고 있는지 설정 화면에서 바로 보이게 한다.
    pub by_reason: Vec<SessionCleanupReasonCount>,
    /// 주인 없는 채팅 첨부 디렉터리 수와 크기.
    pub orphan_attachment_count: usize,
    pub orphan_attachment_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanupStatus {
    pub policy: SessionCleanupPolicy,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    /// 현재 목록에 있는 세션 수.
    pub session_count: usize,
    /// 지금까지 목록에서 내린 세션 수.
    pub tombstone_count: usize,
    pub preview: SessionCleanupPreview,
    pub receipts: Vec<SessionCleanupReceipt>,
}

/// 보호 목록을 모은다.
///
/// 조회 실패를 삼키지 않는다. 실행 중인 대화 목록을 읽지 못한 채로 계속하면 보호 목록이
/// 빈 것과 구별되지 않아, 마침 돌고 있는 세션을 내려 버린다(`C11-5`). 반복 요청 쪽도
/// 같다(`C11-6`). 보호 근거를 확인하지 못하면 그 회차는 아예 돌지 않는 편이 맞다.
fn collect_protections(
    chats: &ChatSupervisor,
    scheduler: Option<&SchedulerSupervisor>,
    sessions: &[SessionSummary],
) -> Result<CleanupProtections, CoreError> {
    // `live_chats`가 아니라 `active_chats`를 쓴다. 앞엣것은 사용자가 보는 목록이라
    // `unattended`를 빼는데, 무인 회차가 도는 세션이야말로 이 기능이 지우려는 대상이다.
    let mut live_session_ids = BTreeSet::new();
    for chat in chats.active_chats()? {
        if let Some(id) = chat.provider_session_id {
            live_session_ids.insert(id);
        }
    }
    let scheduled_session_ids = match scheduler {
        Some(scheduler) => scheduler.referenced_session_ids()?,
        None => BTreeSet::new(),
    };
    Ok(CleanupProtections {
        live_session_ids,
        scheduled_session_ids,
        handoff_keys: handoff_keys(sessions),
    })
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        total += if metadata.is_dir() {
            directory_size(&entry.path())
        } else {
            metadata.len()
        };
    }
    total
}

/// 주인 없는 채팅 첨부 디렉터리. 첨부는 세션이 아니라 대화 ID로 묶이므로 세션 판정과
/// 별개로 훑는다. 살아 있는 대화의 것과, 보존 기간이 지나지 않은 것은 남긴다.
fn orphan_attachments(
    app_data_dir: &Path,
    chats: &ChatSupervisor,
    policy: &SessionCleanupPolicy,
    now_ms: i64,
) -> Result<Vec<(PathBuf, u64)>, CoreError> {
    let spec = root_spec(CleanupRootKind::ChatAttachment);
    let Some(root) = cleanup_root(app_data_dir, spec)? else {
        return Ok(Vec::new());
    };
    // 여기서도 조회 실패를 삼키지 않는다. 목록을 못 읽으면 살아 있는 대화의 첨부가
    // 주인 없는 것으로 보인다. 무인 회차의 첨부도 남겨야 하므로 `active_chats`를 쓴다.
    let mut live_chat_ids = BTreeSet::new();
    for chat in chats.active_chats()? {
        live_chat_ids.insert(chat.chat_id);
    }
    // 첨부에는 자기 조건이 없어 세션 보존 기간을 빌려 쓴다. 보존 조건을 껐더라도 첨부까지
    // 무기한 남길 이유는 없으므로 기본값으로 떨어진다 — 끄는 쪽이 더 공격적이 되지 않는다.
    let retention_ms = i64::from(policy.retention_days.unwrap_or(DEFAULT_RETENTION_DAYS)) * DAY_MS;
    let mut orphans = Vec::new();
    for entry in fs::read_dir(&root)?.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        // 심볼릭 링크는 건드리지 않는다(`C11-3`).
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Some(chat_id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if live_chat_ids.contains(chat_id) {
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|delta| delta.as_millis() as i64)
            .unwrap_or(0);
        if now_ms - modified_ms < retention_ms {
            continue;
        }
        orphans.push((path.clone(), directory_size(&path)));
    }
    Ok(orphans)
}

/// 지금 조건이 무엇을 얼마나 지울지. 실행과 같은 판정 경로를 쓰므로 미리보기와 실제
/// 결과가 갈라지지 않는다.
fn build_preview(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    policy: &SessionCleanupPolicy,
    protections: &CleanupProtections,
    chats: &ChatSupervisor,
    now_ms: i64,
) -> Result<SessionCleanupPreview, CoreError> {
    let verdicts = evaluate(sessions, policy, protections, now_ms);
    let transcript_spec = root_spec(CleanupRootKind::ProviderTranscript);
    let transcript_root = cleanup_root(app_data_dir, transcript_spec)?;

    let mut preview = SessionCleanupPreview {
        target_count: 0,
        removable_count: 0,
        removable_bytes: 0,
        protected_count: 0,
        remaining_count: 0,
        by_reason: Vec::new(),
        orphan_attachment_count: 0,
        orphan_attachment_bytes: 0,
    };
    let mut counts: BTreeMap<SessionCleanupReason, usize> = BTreeMap::new();
    for (session, verdict) in sessions.iter().zip(&verdicts) {
        match verdict {
            Verdict::Keep => preview.remaining_count += 1,
            Verdict::Protected(_) => {
                preview.protected_count += 1;
                preview.remaining_count += 1;
            }
            Verdict::Clean(reason) => {
                preview.target_count += 1;
                *counts.entry(*reason).or_default() += 1;
                if removable_under(
                    transcript_root.as_deref(),
                    transcript_spec,
                    Some(session.source),
                    Path::new(&session.file_path),
                ) {
                    preview.removable_count += 1;
                    preview.removable_bytes += session.size_bytes.unwrap_or(0);
                }
            }
        }
    }
    preview.by_reason = counts
        .into_iter()
        .map(|(reason, count)| SessionCleanupReasonCount {
            reason,
            label: reason.label(),
            count,
        })
        .collect();

    let orphans = orphan_attachments(app_data_dir, chats, policy, now_ms)?;
    preview.orphan_attachment_count = orphans.len();
    preview.orphan_attachment_bytes = orphans.iter().map(|(_, size)| size).sum();
    Ok(preview)
}

fn next_run_at(policy: &SessionCleanupPolicy, last_run_at: Option<i64>) -> Option<i64> {
    if !policy.enabled {
        return None;
    }
    let interval_ms = i64::from(policy.interval_hours) * 3_600_000;
    Some(last_run_at.map_or_else(clock::now_ms, |last| last + interval_ms))
}

pub fn session_cleanup_status(
    app_data_dir: &Path,
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    scheduler: Option<&SchedulerSupervisor>,
) -> Result<SessionCleanupStatus, CoreError> {
    let store = load_policy_store(app_data_dir)?;
    let sessions = catalog.manager_snapshot()?.sessions;
    let protections = collect_protections(chats, scheduler, &sessions)?;
    let now_ms = clock::now_ms();
    let preview = build_preview(
        app_data_dir,
        &sessions,
        &store.policy,
        &protections,
        chats,
        now_ms,
    )?;
    Ok(SessionCleanupStatus {
        next_run_at: next_run_at(&store.policy, store.last_run_at),
        policy: store.policy,
        last_run_at: store.last_run_at,
        session_count: sessions.len(),
        tombstone_count: store::cleaned_session_count(app_data_dir)?,
        preview,
        receipts: store.receipts,
    })
}

pub fn set_session_cleanup_policy(
    app_data_dir: &Path,
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    scheduler: Option<&SchedulerSupervisor>,
    policy: SessionCleanupPolicyInput,
) -> Result<SessionCleanupStatus, CoreError> {
    let policy = SessionCleanupPolicy::from(policy);
    policy.validate()?;
    with_policy_store(app_data_dir, |store| {
        store.policy = policy;
        Ok(())
    })?;
    session_cleanup_status(app_data_dir, catalog, chats, scheduler)
}

/// 툼스톤을 모두 지운다. 원문은 손대지 않았으므로 다음 재조사에서 세션이 되돌아온다.
pub fn clear_session_cleanup_tombstones(
    app_data_dir: &Path,
    catalog: &SessionCatalog,
) -> Result<usize, CoreError> {
    let cleared = store::clear_cleaned_sessions(app_data_dir)?;
    catalog.refresh_metadata()?;
    Ok(cleared)
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

/// 휴지통 항목 디렉터리 이름에 쓸 수 있게 다듬은 키.
///
/// 세션 키는 `공급자:세션ID` 모양이라 콜론이 들어 있다. POSIX에서는 그대로 디렉터리
/// 이름이 되지만 Windows에서는 금지 문자라 `create_dir`이 실패하고, 그러면 그 기기에서는
/// 모든 세션 정리가 실패한다. 경로 구분자도 같은 이유로 막는다.
fn trash_key(session_key: &str) -> String {
    session_key
        .chars()
        .map(|character| match character {
            ':' | '/' | '\\' | '<' | '>' | '"' | '|' | '?' | '*' => '-',
            other if (other as u32) < 0x20 => '-',
            other => other,
        })
        .collect()
}

/// 실체 한 건을 휴지통으로 옮긴다(`C11-3`, `C11-7`).
///
/// 방어 순서는 모델 캐시 정리(`cli_updates::remove_cache_file`)와 같다: 루트를 정규화하고,
/// 대상이 그 루트 아래인지 보고, 심볼릭 링크를 거부한다. 다른 점은 지우지 않고 옮긴다는
/// 것뿐이다 — 무인으로 도는 작업에 복구 경로가 없으면 안 된다.
fn move_to_trash(
    app_data_dir: &Path,
    root: &Path,
    spec: &CleanupRootSpec,
    // 이 실체가 어느 공급자의 대화인지. 첨부 디렉터리처럼 공급자가 없는 실체는 `None`이다.
    provider: Option<ProviderId>,
    target: &Path,
    session_key: &str,
    group_id: &str,
) -> Result<Option<u64>, CoreError> {
    let metadata = match fs::symlink_metadata(target) {
        // 이미 없는 것은 오류가 아니지만 "회수했다"도 아니다. 회차가 겹쳐 돌면 뒤엣것이
        // 빈손으로 지나가는데, 그것을 회수로 세면 영수증이 하지 않은 일을 보고한다.
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidInput(
            "심볼릭 링크여서 정리하지 않았습니다".to_owned(),
        ));
    }
    let canonical = fs::canonicalize(target)?;
    if !canonical.starts_with(root) {
        return Err(CoreError::InvalidInput(
            "정리 대상이 허용된 루트를 벗어났습니다".to_owned(),
        ));
    }
    // 담긴 자리와 모양을 여기서 한 번 더 본다. 판정과 실행이 갈라져도 자격증명 같은 이웃
    // 파일이 휴지통으로 넘어가지 않게 하는 마지막 문이다(`C11-3`).
    if !metadata.is_dir() && !has_transcript_shape(spec, provider, &canonical) {
        return Err(CoreError::InvalidInput(
            "정리 대상이 허용된 실체 모양이 아닙니다".to_owned(),
        ));
    }
    let size_bytes = if metadata.is_dir() {
        directory_size(&canonical)
    } else {
        metadata.len()
    };

    let trash_root = trash_store::trash_root(app_data_dir, TRASH_RELATIVE);
    let entry = trash_store::begin_entry(&trash_root, &trash_key(session_key))?;
    if let Err(error) = trash_store::move_path(&canonical, entry.content()) {
        entry.abort();
        return Err(error);
    }
    let manifest = SessionTrashManifest {
        id: entry.id().to_owned(),
        group_id: group_id.to_owned(),
        deleted_at_ms: entry.deleted_at_ms(),
        root_id: spec.id.to_owned(),
        session_key: session_key.to_owned(),
        original_path: canonical.to_string_lossy().into_owned(),
        size_bytes,
    };
    entry.commit(&manifest, &canonical)?;
    Ok(Some(size_bytes))
}

/// 보관 기간이 지난 휴지통 항목을 완전 삭제한다(`C11-7`).
///
/// 항목 하나가 실패해도 회차를 무너뜨리지 않는다. `trash_store::purge`는 항목 디렉터리가
/// 이미 없으면 `NotFound`를 돌려주는데(회차가 겹쳐 돌거나 사람이 손으로 지운 경우),
/// 그것을 그대로 올려보내면 **실체를 옮기고 툼스톤까지 찍은 뒤** 마지막에 회차가 실패해
/// 영수증도 `last_run_at`도 남지 않는다. 그러면 다음 tick이 곧바로 같은 일을 다시 한다.
/// 휴지통 비우기는 뒷정리지 이 회차의 목적이 아니므로, 성공한 것만 세고 넘어간다.
fn purge_expired_trash(app_data_dir: &Path, policy: &SessionCleanupPolicy, now_ms: i64) -> usize {
    let trash_root = trash_store::trash_root(app_data_dir, TRASH_RELATIVE);
    let Ok(entries) = trash_store::read_entries(&trash_root, |item: &SessionTrashManifest| {
        item.deleted_at_ms
    }) else {
        return 0;
    };
    let cutoff = now_ms - i64::from(policy.trash_retention_days) * DAY_MS;
    let mut purged = 0;
    for entry in entries {
        if entry.deleted_at_ms > cutoff {
            continue;
        }
        purged += trash_store::purge(&trash_root, Some(&entry.id)).unwrap_or(0);
    }
    purged
}

/// 한 회차가 모으는 영수증 항목과 수치.
///
/// 세션 원문과 주인 없는 첨부는 훑는 대상만 다르고 결과를 세는 방법은 같다. 두 갈래가
/// 각자 지역 변수를 올리던 때는 같은 네 줄을 양쪽에 적어야 했고, 한쪽만 빠뜨리면 영수증이
/// 하지 않은 일을 보고했다. 세는 자리를 여기 하나로 둔다.
#[derive(Default)]
struct CleanupTally {
    entries: Vec<SessionCleanupEntry>,
    entries_truncated: bool,
    removed_count: usize,
    skipped_count: usize,
    /// 건너뛴 이유별 건수. 항목은 상한까지만 담기지만 집계는 전수로 센다.
    skipped_by_reason: BTreeMap<&'static str, usize>,
    failed_count: usize,
    bytes_freed: u64,
}

/// 실체 하나를 옮겨 본 결과. 호출부가 뒤처리를 가르는 데만 쓴다.
enum MoveOutcome {
    Moved,
    Missing,
    Failed,
}

impl CleanupTally {
    /// 영수증에 항목을 담는다. 상한을 넘기면 담지 않고 잘렸다는 표시만 남긴다.
    fn push(&mut self, entry: SessionCleanupEntry) {
        if self.entries.len() < MAX_RECEIPT_ENTRIES {
            self.entries.push(entry);
        } else {
            self.entries_truncated = true;
        }
    }

    /// 건너뛴 항목을 사유와 함께 담는다.
    fn skip(&mut self, mut entry: SessionCleanupEntry, reason: &'static str) {
        entry.skipped_reason = Some(reason.to_owned());
        self.skip_counted(reason);
        self.push(entry);
    }

    /// 영수증 항목 없이 건너뛴 건수만 센다. 보호된 세션은 수천 건이 될 수 있어 항목으로
    /// 담으면 실제로 정리한 것들을 상한 밖으로 밀어낸다.
    fn skip_counted(&mut self, reason: &'static str) {
        self.skipped_count += 1;
        *self.skipped_by_reason.entry(reason).or_default() += 1;
    }

    /// 영수증에 실을 사유별 집계.
    fn skipped_reasons(&self) -> Vec<SessionCleanupSkipCount> {
        self.skipped_by_reason
            .iter()
            .map(|(reason, count)| SessionCleanupSkipCount {
                reason: (*reason).to_owned(),
                count: *count,
            })
            .collect()
    }

    /// [`move_to_trash`] 결과를 항목과 수치에 반영한다. `size_hint`가 있으면 옮긴 실체를
    /// 다시 재는 대신 그 값을 센다 — 첨부는 훑을 때 이미 크기를 재 둔다.
    fn record_move(
        &mut self,
        entry: &mut SessionCleanupEntry,
        moved: Result<Option<u64>, CoreError>,
        size_hint: Option<u64>,
    ) -> MoveOutcome {
        match moved {
            Ok(Some(size)) => {
                let size = size_hint.unwrap_or(size);
                entry.removed = true;
                entry.bytes_freed = size;
                self.bytes_freed += size;
                self.removed_count += 1;
                MoveOutcome::Moved
            }
            Ok(None) => {
                entry.skipped_reason = Some("실체가 이미 없었습니다".to_owned());
                MoveOutcome::Missing
            }
            Err(error) => {
                entry.error = Some(error.to_string());
                self.failed_count += 1;
                MoveOutcome::Failed
            }
        }
    }
}

/// 한 회차가 실체를 옮기는 동안 바뀌지 않는 값들. 정리 루트는 회차 시작에 한 번 정해지고
/// 휴지통 묶음 ID도 회차당 하나라, 훑기마다 손으로 넘기는 대신 여기 모아 둔다.
struct CleanupRun<'a> {
    app_data_dir: &'a Path,
    group_id: String,
    transcript_root: Option<PathBuf>,
    attachment_root: Option<PathBuf>,
}

impl<'a> CleanupRun<'a> {
    fn open(app_data_dir: &'a Path) -> Result<Self, CoreError> {
        Ok(Self {
            app_data_dir,
            group_id: trash_store::new_trash_group_id(),
            transcript_root: cleanup_root(
                app_data_dir,
                root_spec(CleanupRootKind::ProviderTranscript),
            )?,
            attachment_root: cleanup_root(
                app_data_dir,
                root_spec(CleanupRootKind::ChatAttachment),
            )?,
        })
    }

    /// 판정이 끝난 세션을 훑어 원문을 회수하고, 툼스톤을 찍을 세션 키를 모은다.
    /// `live`는 판정 뒤에 실행이 붙은 대화의 공급자 세션 ID다.
    fn sweep_sessions(
        &self,
        sessions: &[SessionSummary],
        verdicts: &[Verdict],
        live: &BTreeSet<String>,
        tally: &mut CleanupTally,
    ) -> BTreeSet<String> {
        let spec = root_spec(CleanupRootKind::ProviderTranscript);
        let mut tombstones = BTreeSet::new();
        for (session, verdict) in sessions.iter().zip(verdicts) {
            let reason = match verdict {
                Verdict::Clean(reason) => *reason,
                Verdict::Protected(reason) => {
                    tally.skip_counted(reason);
                    continue;
                }
                Verdict::Keep => continue,
            };
            let key = store::session_key(session.source, &session.id);
            let mut entry = SessionCleanupEntry {
                session_key: key.clone(),
                source: Some(session.source),
                title: session.title.clone(),
                reason,
                bytes_freed: 0,
                tombstoned: true,
                removed: false,
                skipped_reason: None,
                error: None,
            };
            if live.contains(&session.id) {
                // 판정 뒤에 실행이 붙었다. 목록에서도 내리지 않는다 — 지금 쓰고 있는 대화다.
                entry.tombstoned = false;
                tally.skip(entry, "정리 도중 실행이 시작되어 건너뛰었습니다");
                continue;
            }
            let path = Path::new(&session.file_path);
            // 공유 공급자 홈에 있는 원문은 여기서 걸러져 툼스톤만 받는다(`G2`).
            if removable_under(
                self.transcript_root.as_deref(),
                spec,
                Some(session.source),
                path,
            ) {
                let root = self
                    .transcript_root
                    .as_deref()
                    .expect("판정이 참이면 루트가 있다");
                let moved = move_to_trash(
                    self.app_data_dir,
                    root,
                    spec,
                    Some(session.source),
                    path,
                    &key,
                    &self.group_id,
                );
                if let MoveOutcome::Failed = tally.record_move(&mut entry, moved, None) {
                    // 실체를 못 옮겼으면 목록에서도 내리지 않는다. 목록에 없는데 파일은
                    // 남아 있는 상태가 가장 설명하기 어렵다.
                    entry.tombstoned = false;
                    tally.push(entry);
                    continue;
                }
            } else {
                entry.skipped_reason =
                    Some("공급자 홈의 원문이어서 목록에서만 내렸습니다".to_owned());
            }
            tombstones.insert(key);
            tally.push(entry);
        }
        tombstones
    }

    /// 주인 없는 채팅 첨부를 회수한다. 세션이 아니라 대화 ID로 묶이므로 따로 훑는다.
    fn sweep_orphan_attachments(
        &self,
        chats: &ChatSupervisor,
        policy: &SessionCleanupPolicy,
        started_at: i64,
        tally: &mut CleanupTally,
    ) -> Result<(), CoreError> {
        let Some(root) = self.attachment_root.as_deref() else {
            return Ok(());
        };
        let spec = root_spec(CleanupRootKind::ChatAttachment);
        for (path, size) in orphan_attachments(self.app_data_dir, chats, policy, started_at)? {
            let key = path
                .file_name()
                .map(|name| format!("chat-input:{}", name.to_string_lossy()))
                .unwrap_or_else(|| "chat-input".to_owned());
            let mut entry = SessionCleanupEntry {
                session_key: key.clone(),
                source: None,
                title: spec.label.to_owned(),
                reason: SessionCleanupReason::OrphanAttachment,
                bytes_freed: 0,
                tombstoned: false,
                removed: false,
                skipped_reason: None,
                error: None,
            };
            let moved = move_to_trash(
                self.app_data_dir,
                root,
                spec,
                None,
                &path,
                &key,
                &self.group_id,
            );
            tally.record_move(&mut entry, moved, Some(size));
            tally.push(entry);
        }
        Ok(())
    }
}

/// 한 회차를 돈다. 판정은 미리보기와 같은 [`evaluate`]를 쓴다.
pub fn run_session_cleanup(
    app_data_dir: &Path,
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    scheduler: Option<&SchedulerSupervisor>,
    manual: bool,
) -> Result<SessionCleanupReceipt, CoreError> {
    let store = load_policy_store(app_data_dir)?;
    let policy = store.policy.clone();
    if !manual && !policy.enabled {
        return Err(CoreError::Conflict(
            "세션 자동정리가 꺼져 있습니다".to_owned(),
        ));
    }
    if !policy.has_any_condition() {
        return Err(CoreError::InvalidInput(
            "정리 조건이 하나도 켜져 있지 않습니다".to_owned(),
        ));
    }

    let started_at = clock::now_ms();
    let sessions = catalog.manager_snapshot()?.sessions;
    let protections = collect_protections(chats, scheduler, &sessions)?;
    let verdicts = evaluate(&sessions, &policy, &protections, started_at);
    let run = CleanupRun::open(app_data_dir)?;
    // 보호 목록은 판정 직전에 한 번 읽는다. 그런데 실체를 옮기는 일은 회차당 수천 건이 될
    // 수 있어, 판정 이후 시작된 실행은 그 목록에 없다. 되돌릴 수 없는 쪽(실체 이동)에
    // 들어가기 직전에 한 번 더 읽어 창을 좁힌다.
    let live_before_removal: BTreeSet<String> = chats
        .active_chats()?
        .into_iter()
        .filter_map(|chat| chat.provider_session_id)
        .collect();

    let mut tally = CleanupTally::default();
    let tombstones = run.sweep_sessions(&sessions, &verdicts, &live_before_removal, &mut tally);
    run.sweep_orphan_attachments(chats, &policy, started_at, &mut tally)?;

    let tombstoned_count = store::record_cleaned_sessions(app_data_dir, &tombstones)?;
    tally.bytes_freed += store::prune_supplements_for(app_data_dir, &tombstones)?;
    let trash_purged_count = purge_expired_trash(app_data_dir, &policy, started_at);
    catalog.refresh_metadata()?;

    let receipt = SessionCleanupReceipt {
        started_at,
        finished_at: clock::now_ms(),
        manual,
        tombstoned_count,
        removed_count: tally.removed_count,
        skipped_count: tally.skipped_count,
        skipped_reasons: tally.skipped_reasons(),
        failed_count: tally.failed_count,
        bytes_freed: tally.bytes_freed,
        trash_purged_count,
        entries_truncated: tally.entries_truncated,
        entries: tally.entries,
    };
    with_policy_store(app_data_dir, |store| {
        store.last_run_at = Some(receipt.started_at);
        store.receipts.insert(0, receipt.clone());
        store.receipts.truncate(MAX_RECEIPT_HISTORY);
        Ok(())
    })?;
    Ok(receipt)
}

// ---------------------------------------------------------------------------
// 주기 실행
// ---------------------------------------------------------------------------

/// 주기 확인 루프. 실제 실행 여부는 `last_run_at`과 `interval_hours`가 정한다.
///
/// 카탈로그·채팅 계층은 복제해 들고, 스케줄러만 약한 손잡이로 든다. 세션 재조사 루프
/// (`catalog::spawn_periodic_reconcile`)와 같이 프로세스가 끝날 때까지 도는 스레드다.
/// 프로세스 간 단일화 잠금은 두지 않는다 — 정리는 멱등이고, 겹쳐 돌아도 저장소 잠금이
/// 순서를 지킨다.
pub fn spawn_session_cleanup_loop(
    app_data_dir: PathBuf,
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    scheduler: &SchedulerSupervisor,
) {
    let catalog = catalog.clone();
    let chats = chats.clone();
    let scheduler = scheduler.handle();
    thread::Builder::new()
        .name("session-cleanup".to_owned())
        .spawn(move || {
            thread::sleep(STARTUP_DELAY);
            loop {
                if let Err(error) = tick(&app_data_dir, &catalog, &chats, &scheduler) {
                    eprintln!("세션 자동정리 회차가 실패했습니다: {error}");
                }
                thread::sleep(TICK_INTERVAL);
            }
        })
        .ok();
}

fn tick(
    app_data_dir: &Path,
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    scheduler: &crate::scheduler::SchedulerHandle,
) -> Result<(), CoreError> {
    let store = load_policy_store(app_data_dir)?;
    if !store.policy.enabled {
        return Ok(());
    }
    let due = next_run_at(&store.policy, store.last_run_at)
        .is_some_and(|next_run_at| next_run_at <= clock::now_ms());
    if !due {
        return Ok(());
    }
    let scheduler = scheduler.upgrade();
    run_session_cleanup(app_data_dir, catalog, chats, scheduler.as_ref(), false)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{SessionLink, SessionMeta};

    fn session(
        id: &str,
        source: ProviderId,
        updated_days_ago: i64,
        messages: u64,
    ) -> SessionSummary {
        let now = clock::now_ms();
        SessionSummary {
            source,
            id: id.to_owned(),
            title: id.to_owned(),
            source_title: None,
            project: None,
            cwd: None,
            started_at: Some(now - updated_days_ago * DAY_MS),
            updated_at: Some(now - updated_days_ago * DAY_MS),
            message_count: Some(messages),
            token_total: None,
            token_usage: None,
            model: None,
            git_branch: None,
            is_subagent: false,
            aia_workspace: false,
            default_workspace: false,
            archived: false,
            readable: true,
            size_bytes: Some(1024),
            file_path: format!("/tmp/{id}.jsonl"),
            meta: SessionMeta::default(),
            last_failure: None,
        }
    }

    fn policy() -> SessionCleanupPolicy {
        SessionCleanupPolicy {
            enabled: true,
            retention_days: Some(90),
            max_message_count: Some(1),
            per_provider_cap: Some(400),
            per_automation_cap: Some(30),
            hidden_after_days: Some(7),
            trash_retention_days: 14,
            interval_hours: 24,
        }
    }

    #[test]
    fn a_save_request_missing_a_condition_is_refused_instead_of_silently_disabling_it() {
        // 저장본과 요청은 빠진 필드의 뜻이 정반대다. 요청에서 빠진 조건을 꺼짐으로
        // 저장하면, 오래 열어 둔 원격 탭이 조건 하나를 고치기만 해도 사용자가 켜 둔 다른
        // 조건이 조용히 꺼진다.
        let full = serde_json::json!({
            "enabled": false,
            "retentionDays": 90,
            "maxMessageCount": 1,
            "perProviderCap": 400,
            "perAutomationCap": 30,
            "hiddenAfterDays": 7,
            "trashRetentionDays": 14,
            "intervalHours": 24
        });
        let parsed: SessionCleanupPolicyInput =
            serde_json::from_value(full.clone()).expect("온전한 요청은 받는다");
        assert_eq!(
            SessionCleanupPolicy::from(parsed).per_automation_cap,
            Some(30)
        );

        // 조건 하나를 모르는 옛 클라이언트의 요청.
        let mut stale = full.clone();
        stale.as_object_mut().unwrap().remove("perAutomationCap");
        serde_json::from_value::<SessionCleanupPolicyInput>(stale)
            .expect_err("빠진 조건은 거절한다");

        // 끄고 싶으면 `null`을 명시해야 한다 — 키가 없는 것과는 다른 뜻이다.
        let mut explicit_off = full;
        explicit_off
            .as_object_mut()
            .unwrap()
            .insert("perAutomationCap".to_owned(), serde_json::Value::Null);
        let parsed: SessionCleanupPolicyInput =
            serde_json::from_value(explicit_off).expect("명시한 null은 받는다");
        assert_eq!(SessionCleanupPolicy::from(parsed).per_automation_cap, None);
    }

    #[test]
    fn a_policy_saved_before_a_condition_existed_still_loads_with_it_off() {
        // 조건을 하나 더하면 그 필드가 없는 저장본이 생긴다. 파싱 오류가 되면 자동정리
        // 조회가 영영 실패하고, 기본값 켜짐으로 읽으면 사용자가 본 적 없는 조건이 혼자
        // 켜져 세션을 지우기 시작한다. 둘 다 안 된다.
        let temp = tempfile::tempdir().expect("temp directory");
        let legacy = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "policy": {
                "enabled": true,
                "retentionDays": 60,
                "maxMessageCount": 2,
                "perProviderCap": 300,
                "hiddenAfterDays": 7,
                "trashRetentionDays": 7,
                "intervalHours": 12
            },
            "lastRunAt": 1_700_000_000_000i64,
            "receipts": []
        });
        fs::write(
            temp.path().join(POLICY_FILE_NAME),
            serde_json::to_vec(&legacy).expect("json"),
        )
        .expect("write");

        let store = load_policy_store(temp.path()).expect("옛 저장본도 읽는다");
        assert_eq!(store.policy.retention_days, Some(60));
        assert_eq!(store.policy.interval_hours, 12);
        assert_eq!(
            store.policy.per_automation_cap, None,
            "저장본에 없던 조건은 꺼진 채로 온다"
        );
        assert_eq!(store.last_run_at, Some(1_700_000_000_000));

        // 값이 하나도 없는 정책도 읽히고, 필수 값은 기본값으로 채워져 검증을 통과한다.
        let bare = serde_json::json!({ "schemaVersion": SCHEMA_VERSION, "policy": {} });
        fs::write(
            temp.path().join(POLICY_FILE_NAME),
            serde_json::to_vec(&bare).expect("json"),
        )
        .expect("write");
        let store = load_policy_store(temp.path()).expect("빈 정책도 읽는다");
        assert!(!store.policy.enabled);
        assert_eq!(
            store.policy.trash_retention_days,
            DEFAULT_TRASH_RETENTION_DAYS
        );
        assert_eq!(store.policy.interval_hours, DEFAULT_INTERVAL_HOURS);
        store.policy.validate().expect("기본값은 검증을 통과한다");
    }

    #[test]
    fn a_missing_policy_file_loads_the_default_schema_version() {
        // `#[derive(Default)]`에 맡기면 `schema_version`이 0이 되어 첫 조회가 버전
        // 확인에서 막힌다. 저장본이 없는 새 설치가 바로 그 경우다.
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let store = load_policy_store(temp.path()).expect("빈 디렉터리에서도 기본값을 읽는다");
        assert_eq!(store.schema_version, SCHEMA_VERSION);
        assert!(!store.policy.enabled);
        assert_eq!(store.last_run_at, None);
    }

    #[test]
    fn a_trash_key_drops_characters_windows_refuses_in_a_path() {
        // 세션 키는 `공급자:세션ID`라 콜론이 들어 있다. 그대로 디렉터리 이름에 쓰면
        // Windows에서 `create_dir`이 실패해 그 기기의 모든 정리가 실패한다.
        assert_eq!(
            trash_key("codex:019c4d52-2a9b-7ab2-8f00-000000000000"),
            "codex-019c4d52-2a9b-7ab2-8f00-000000000000"
        );
        assert_eq!(
            trash_key("chat-input:orphan-chat-0001"),
            "chat-input-orphan-chat-0001"
        );
        // 경로 구분자가 섞여 들어와도 항목 디렉터리를 벗어나지 못한다.
        assert_eq!(trash_key("a/b\\c"), "a-b-c");
        for key in [
            "codex:1", "a/b", "a\\b", "a<b", "a>b", "a\"b", "a|b", "a?b", "a*b",
        ] {
            let sanitized = trash_key(key);
            assert!(
                !sanitized.contains([':', '/', '\\', '<', '>', '"', '|', '?', '*']),
                "{key} -> {sanitized}"
            );
        }
    }

    #[test]
    fn only_app_data_roots_are_allowlisted() {
        // 정리 루트는 앱 데이터 기준 상대 경로여야 한다. 절대 경로나 상위 탈출이 등록되면
        // `cleanup_root`의 접두 검사보다 먼저 여기서 걸린다(`C11-2`).
        for spec in CLEANUP_ROOTS {
            let relative = Path::new(spec.app_data_relative);
            assert!(
                relative.is_relative(),
                "{}: 정리 루트는 상대 경로여야 한다",
                spec.id
            );
            assert!(
                !spec.app_data_relative.contains(".."),
                "{}: 상위 탈출은 등록할 수 없다",
                spec.id
            );
            assert_eq!(
                relative.components().count(),
                1,
                "{}: 정리 루트는 앱 데이터 바로 아래 한 칸이다",
                spec.id
            );
        }
        // 공유 공급자 홈과 자격증명·설정 저장소는 등록 대상이 아니다(`C11-2`, `C2-6`).
        for forbidden in [
            ".claude",
            ".codex",
            ".gemini",
            "provider-accounts-v1.json",
            "manager-state.json",
            "trash",
            "resource-repository",
        ] {
            assert!(
                !CLEANUP_ROOTS
                    .iter()
                    .any(|spec| spec.app_data_relative == forbidden),
                "{forbidden}는 정리 루트로 등록할 수 없다"
            );
        }
        // 파일을 지우는 루트는 실체 모양을 반드시 못박는다. 모양이 없으면 그 루트의 모든
        // 이웃 파일이 회수 대상이 된다(`C11-3`). 모양은 공급자별 표가 정하고, 공급자를
        // 모르는 실체는 그 표를 우회하지 못한다.
        let transcript_spec = root_spec(CleanupRootKind::ProviderTranscript);
        assert!(!has_transcript_shape(
            transcript_spec,
            None,
            Path::new("/tmp/anything.jsonl")
        ));
        assert_eq!(CLEANUP_ROOTS.len(), 2, "확인된 루트만 등록한다");
    }

    #[test]
    fn a_credential_file_next_to_the_transcripts_is_not_removable() {
        // 계정 프로필 루트에는 대화 기록만 있는 것이 아니다. `auth.json`(계정 자격증명)과
        // `models_cache.json`·`installation_id`가 같이 산다. 담긴 자리만 보고 지우면 세션
        // 경로가 한 번만 잘못 들어와도 자격증명을 휴지통에 넣는다(`C11-3`).
        let base = std::env::temp_dir().join("agent-manager-session-cleanup-shape");
        let _ = fs::remove_dir_all(&base);
        let profile = base.join("credential-profiles/codex/codex-test/sessions");
        fs::create_dir_all(&profile).expect("profile");
        let spec = root_spec(CleanupRootKind::ProviderTranscript);
        let root = cleanup_root(&base, spec)
            .expect("root")
            .expect("root exists");

        let transcript = profile.join("rollout-2026-09-01T00-00-00-abc.jsonl");
        fs::write(&transcript, b"{}").expect("transcript");
        assert!(removable_under(
            Some(&root),
            spec,
            Some(ProviderId::Codex),
            &transcript
        ));
        // 모양이 맞는 기록은 실제로 휴지통으로 넘어간다 — 모양 검사가 정상 경로까지
        // 막아 버리면 이 기능은 아무것도 회수하지 못한다.
        let moved = move_to_trash(
            &base,
            &root,
            spec,
            Some(ProviderId::Codex),
            &transcript,
            "codex:abc",
            "group",
        )
        .expect("기록은 옮긴다");
        assert_eq!(moved, Some(2));
        // 같은 대상을 다시 옮기려 하면 오류가 아니라 "없었다"로 돌아온다 — 회차가 겹쳐
        // 돌아도 뒤엣것이 하지 않은 일을 회수로 세지 않는다.
        assert_eq!(
            move_to_trash(
                &base,
                &root,
                spec,
                Some(ProviderId::Codex),
                &transcript,
                "codex:abc",
                "group"
            )
            .expect("없는 것은 오류가 아니다"),
            None
        );
        assert!(!transcript.exists(), "옮긴 뒤에는 원래 자리에 없다");

        for neighbour in [
            "auth.json",
            "models_cache.json",
            "installation_id",
            "config.toml",
            "state_5.sqlite",
            ".credentials.json",
        ] {
            let path = base
                .join("credential-profiles/codex/codex-test")
                .join(neighbour);
            fs::write(&path, b"{}").expect("neighbour");
            assert!(
                !removable_under(Some(&root), spec, Some(ProviderId::Codex), &path),
                "{neighbour}는 회수 대상이 아니다"
            );
            // 판정을 건너뛰고 실행으로 바로 들어와도 마지막 문에서 막힌다.
            let error = move_to_trash(
                &base,
                &root,
                spec,
                Some(ProviderId::Codex),
                &path,
                "codex:test",
                "group",
            )
            .expect_err("실체 모양이 아니면 옮기지 않는다");
            assert!(matches!(error, CoreError::InvalidInput(_)), "{neighbour}");
            assert!(path.is_file(), "{neighbour}가 그대로 있어야 한다");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_stale_trash_entry_does_not_break_the_pass() {
        // 항목 하나가 이미 사라졌다고 회차 전체를 실패시키면, 실체를 옮기고 툼스톤까지
        // 찍은 뒤 영수증과 `last_run_at`이 남지 않아 다음 tick이 같은 일을 또 한다.
        let temp = tempfile::tempdir().expect("temp directory");
        let trash_root = trash_store::trash_root(temp.path(), TRASH_RELATIVE);
        let entry = trash_store::begin_entry(&trash_root, "codex-stale").expect("entry");
        fs::write(entry.content(), b"x").expect("content");
        let manifest = SessionTrashManifest {
            id: entry.id().to_owned(),
            group_id: "group".to_owned(),
            deleted_at_ms: clock::now_ms() - 90 * DAY_MS,
            root_id: "credential-profile-transcripts".to_owned(),
            session_key: "codex:stale".to_owned(),
            original_path: "/tmp/stale.jsonl".to_owned(),
            size_bytes: 1,
        };
        let id = manifest.id.clone();
        entry
            .commit(&manifest, Path::new("/tmp/stale.jsonl"))
            .expect("commit");

        let policy = policy();
        // 정상 항목 하나는 지운다.
        assert_eq!(
            purge_expired_trash(temp.path(), &policy, clock::now_ms()),
            1
        );

        // manifest만 남고 실체 디렉터리가 사라진 상태를 만든다.
        let stale_dir = trash_root.join(&id);
        fs::create_dir_all(&stale_dir).expect("stale dir");
        fs::write(
            stale_dir.join("manifest.json"),
            serde_json::to_vec(&manifest).expect("json"),
        )
        .expect("manifest");
        fs::remove_dir_all(&stale_dir).ok();
        // 항목을 읽지 못해도 회차는 계속된다.
        assert_eq!(
            purge_expired_trash(temp.path(), &policy, clock::now_ms()),
            0
        );
    }

    #[test]
    fn a_cleanup_root_outside_app_data_is_refused() {
        let base = std::env::temp_dir().join("agent-manager-session-cleanup-root");
        let _ = fs::remove_dir_all(&base);
        let app_data = base.join("app-data");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).expect("bait root");
        fs::create_dir_all(&app_data).expect("app data");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, app_data.join("credential-profiles"))
                .expect("symlink");
            let spec = root_spec(CleanupRootKind::ProviderTranscript);
            let error = cleanup_root(&app_data, spec).expect_err("루트 탈출은 거부한다");
            assert!(matches!(error, CoreError::InvalidInput(_)));
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_session_is_cleaned_and_a_busy_one_is_not() {
        let sessions = vec![
            session("empty", ProviderId::Claude, 1, 0),
            session("busy", ProviderId::Claude, 1, 40),
        ];
        let verdicts = evaluate(
            &sessions,
            &policy(),
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(
            verdicts[0],
            Verdict::Clean(SessionCleanupReason::EmptySession)
        );
        assert_eq!(verdicts[1], Verdict::Keep);
    }

    #[test]
    fn an_unknown_message_count_is_not_an_empty_session() {
        // Codex 세션은 색인에서 조립되어 `message_count`가 언제나 `None`이다. 모르는 값을
        // 0으로 읽으면 실제로 오간 대화 전부가 빈 세션이 되어 한 회차에 쓸려 나간다.
        let mut unknown = session("codex-thread", ProviderId::Codex, 1, 0);
        unknown.message_count = None;
        unknown.token_total = Some(11_003_467);
        let verdicts = evaluate(
            &[unknown],
            &policy(),
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(verdicts[0], Verdict::Keep);

        // 0이라고 **알고 있는** 세션은 그대로 정리한다.
        let known = session("claude-empty", ProviderId::Claude, 1, 0);
        let verdicts = evaluate(
            &[known],
            &policy(),
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(
            verdicts[0],
            Verdict::Clean(SessionCleanupReason::EmptySession)
        );
    }

    #[test]
    fn an_unknown_message_count_still_falls_to_the_other_conditions() {
        // 메시지 수를 모른다고 해서 보존 기간·상한까지 비켜 가지는 않는다.
        let mut unknown = session("codex-old", ProviderId::Codex, 400, 0);
        unknown.message_count = None;
        let verdicts = evaluate(
            &[unknown],
            &policy(),
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(verdicts[0], Verdict::Clean(SessionCleanupReason::Retention));
    }

    #[test]
    fn a_hidden_session_is_cleaned_before_any_other_condition() {
        // 보관은 사용자가 이미 치운 것으로 본다. 메시지가 많고 최근이어도 정리한다.
        let mut hidden = session("hidden", ProviderId::Codex, 30, 500);
        hidden.meta.hidden = true;
        let verdicts = evaluate(
            &[hidden],
            &policy(),
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(
            verdicts[0],
            Verdict::Clean(SessionCleanupReason::HiddenAged)
        );
    }

    #[test]
    fn a_recently_hidden_session_still_waits_out_the_grace_period() {
        let mut hidden = session("hidden", ProviderId::Codex, 2, 500);
        hidden.meta.hidden = true;
        let verdicts = evaluate(
            &[hidden],
            &policy(),
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(verdicts[0], Verdict::Keep);
    }

    #[test]
    fn the_provider_cap_keeps_the_newest_and_counts_protected_sessions_as_kept() {
        let mut policy = policy();
        policy.max_message_count = None;
        policy.retention_days = None;
        policy.hidden_after_days = None;
        policy.per_provider_cap = Some(2);

        let sessions = vec![
            session("newest", ProviderId::Claude, 1, 10),
            session("middle", ProviderId::Claude, 2, 10),
            session("oldest", ProviderId::Claude, 3, 10),
            // 다른 공급자는 자기 상한을 따로 쓴다.
            session("other", ProviderId::Codex, 9, 10),
        ];
        let verdicts = evaluate(
            &sessions,
            &policy,
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(verdicts[0], Verdict::Keep);
        assert_eq!(verdicts[1], Verdict::Keep);
        assert_eq!(
            verdicts[2],
            Verdict::Clean(SessionCleanupReason::ProviderCap)
        );
        assert_eq!(verdicts[3], Verdict::Keep);

        // 보호된 세션이 자리를 차지하면 그만큼 덜 남는다.
        let protections = CleanupProtections {
            live_session_ids: BTreeSet::from(["newest".to_owned()]),
            ..CleanupProtections::default()
        };
        let verdicts = evaluate(&sessions, &policy, &protections, clock::now_ms());
        assert!(matches!(verdicts[0], Verdict::Protected(_)));
        assert_eq!(verdicts[1], Verdict::Keep);
        assert_eq!(
            verdicts[2],
            Verdict::Clean(SessionCleanupReason::ProviderCap)
        );
    }

    fn automated(id: &str, schedule_id: &str, days_ago: i64) -> SessionSummary {
        let mut session = session(id, ProviderId::Claude, days_ago, 10);
        session.meta.origin = Some(crate::domain::ChatOrigin {
            kind: ChatOriginKind::Workflow,
            workflow_id: Some("aia-weekly-report".to_owned()),
            execution_id: None,
            schedule_id: Some(schedule_id.to_owned()),
            run_id: None,
            consumer_id: Some(schedule_id.to_owned()),
        });
        session
    }

    #[test]
    fn a_recurring_schedule_cannot_push_out_the_users_own_conversations() {
        // 매일 도는 보고가 최신 슬롯을 차지해도 사람 대화의 자리는 줄지 않는다. 상한을
        // 공급자 하나로만 세던 때는 이 목록에서 사람 대화 둘이 전부 밀려났다.
        let mut policy = policy();
        policy.max_message_count = None;
        policy.retention_days = None;
        policy.hidden_after_days = None;
        policy.per_provider_cap = Some(2);
        policy.per_automation_cap = Some(2);

        let mut sessions = Vec::new();
        // 자동 실행 회차 다섯 건이 가장 최근이다.
        for day in 0..5 {
            sessions.push(automated(&format!("run-{day}"), "schedule-daily", day));
        }
        // 사람 대화 둘은 그보다 오래됐다.
        sessions.push(session("사람-최근", ProviderId::Claude, 10, 30));
        sessions.push(session("사람-예전", ProviderId::Claude, 11, 30));

        let verdicts = evaluate(
            &sessions,
            &policy,
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        // 자동 실행은 자기 통의 상한 2건만 남는다.
        assert_eq!(verdicts[0], Verdict::Keep);
        assert_eq!(verdicts[1], Verdict::Keep);
        for (index, verdict) in verdicts.iter().enumerate().take(5).skip(2) {
            assert_eq!(
                *verdict,
                Verdict::Clean(SessionCleanupReason::AutomationCap),
                "{index}번 자동 실행 회차"
            );
        }
        // 사람 대화는 자동 실행이 몇 건이든 자기 상한을 그대로 쓴다.
        assert_eq!(verdicts[5], Verdict::Keep);
        assert_eq!(verdicts[6], Verdict::Keep);
    }

    #[test]
    fn each_schedule_gets_its_own_quota() {
        // 일정끼리도 서로 밀어내지 않는다. 주간보고가 일간보고의 자리를 먹으면 안 된다.
        let mut policy = policy();
        policy.max_message_count = None;
        policy.retention_days = None;
        policy.hidden_after_days = None;
        policy.per_automation_cap = Some(1);

        let sessions = vec![
            automated("일간-새것", "schedule-daily", 0),
            automated("일간-헌것", "schedule-daily", 1),
            automated("주간-새것", "schedule-weekly", 2),
            automated("주간-헌것", "schedule-weekly", 3),
        ];
        let verdicts = evaluate(
            &sessions,
            &policy,
            &CleanupProtections::default(),
            clock::now_ms(),
        );
        assert_eq!(verdicts[0], Verdict::Keep);
        assert_eq!(
            verdicts[1],
            Verdict::Clean(SessionCleanupReason::AutomationCap)
        );
        assert_eq!(verdicts[2], Verdict::Keep);
        assert_eq!(
            verdicts[3],
            Verdict::Clean(SessionCleanupReason::AutomationCap)
        );
    }

    #[test]
    fn a_session_without_a_recorded_origin_counts_as_a_human_conversation() {
        // 출처를 모르는 예전 세션을 자동화로 몰면 사람 대화가 작은 통에서 밀려난다.
        assert_eq!(
            bucket_of(&session("옛것", ProviderId::Claude, 1, 5)),
            CleanupBucket::Human
        );

        let mut aia = session("aia", ProviderId::Claude, 1, 5);
        aia.meta.origin = Some(crate::domain::ChatOrigin::direct(ChatOriginKind::Aia));
        assert_eq!(bucket_of(&aia), CleanupBucket::Human);

        assert_eq!(
            bucket_of(&automated("run", "schedule-daily", 1)),
            CleanupBucket::Automation("schedule-daily".to_owned())
        );
    }

    #[test]
    fn running_scheduled_and_handoff_sessions_are_protected() {
        let mut sessions = vec![
            session("live", ProviderId::Claude, 400, 0),
            session("scheduled", ProviderId::Claude, 400, 0),
            session("handoff", ProviderId::Claude, 400, 0),
            session("favorite", ProviderId::Claude, 400, 0),
            session("noted", ProviderId::Claude, 400, 0),
        ];
        sessions[2].meta.handoff_targets = vec![SessionLink {
            source: ProviderId::Codex,
            id: "target".to_owned(),
        }];
        sessions[3].meta.favorite = true;
        sessions[4].meta.note = Some("나중에 볼 것".to_owned());

        let protections = CleanupProtections {
            live_session_ids: BTreeSet::from(["live".to_owned()]),
            scheduled_session_ids: BTreeSet::from(["scheduled".to_owned()]),
            handoff_keys: handoff_keys(&sessions),
        };
        let verdicts = evaluate(&sessions, &policy(), &protections, clock::now_ms());
        for (index, verdict) in verdicts.iter().enumerate() {
            assert!(
                matches!(verdict, Verdict::Protected(_)),
                "{index}번 세션은 보호되어야 한다: {verdict:?}"
            );
        }
    }

    #[test]
    fn a_handoff_partner_is_protected_even_without_its_own_link() {
        // 한쪽만 지우면 남은 쪽의 인계 링크가 허공을 가리킨다.
        let mut origin = session("origin", ProviderId::Claude, 400, 0);
        origin.meta.handoff_targets = vec![SessionLink {
            source: ProviderId::Codex,
            id: "target".to_owned(),
        }];
        let target = session("target", ProviderId::Codex, 400, 0);
        let sessions = vec![origin, target];
        let protections = CleanupProtections {
            handoff_keys: handoff_keys(&sessions),
            ..CleanupProtections::default()
        };
        let verdicts = evaluate(&sessions, &policy(), &protections, clock::now_ms());
        assert!(matches!(verdicts[1], Verdict::Protected(_)));
    }

    #[test]
    fn a_policy_without_any_condition_cannot_be_enabled() {
        let mut policy = policy();
        policy.retention_days = None;
        policy.max_message_count = None;
        policy.per_provider_cap = None;
        policy.per_automation_cap = None;
        policy.hidden_after_days = None;
        assert!(policy.validate().is_err());

        policy.enabled = false;
        assert!(
            policy.validate().is_ok(),
            "꺼져 있으면 조건이 없어도 저장한다"
        );
    }

    #[test]
    fn policy_bounds_are_enforced() {
        let mut policy = policy();
        policy.per_provider_cap = Some(1);
        assert!(policy.validate().is_err());

        // 빈 세션 기준만 방향이 반대다 — 크게 잡을수록 더 지운다. 0을 하나 더 찍는
        // 실수 하나로 목록 전체가 대상이 되면 안 된다.
        let mut policy = self::policy();
        policy.max_message_count = Some(MAX_EMPTY_MESSAGE_LIMIT);
        assert!(policy.validate().is_ok(), "상한값 자체는 받는다");
        policy.max_message_count = Some(MAX_EMPTY_MESSAGE_LIMIT + 1);
        assert!(policy.validate().is_err());
        policy.max_message_count = Some(10_000);
        assert!(policy.validate().is_err());

        let mut policy = self::policy();
        policy.interval_hours = 0;
        assert!(policy.validate().is_err());

        let mut policy = self::policy();
        policy.trash_retention_days = 0;
        assert!(policy.validate().is_err());
    }

    #[test]
    fn cleanup_reason_wire_names_round_trip() {
        for reason in SessionCleanupReason::ALL {
            let text = reason.to_string();
            assert_eq!(
                text.parse::<SessionCleanupReason>().expect("round trip"),
                reason
            );
        }
    }

    /// 확장자 하나로 전 공급자를 묶으면 한쪽을 넓힐 때 다른 쪽까지 넓어진다. Antigravity
    /// 대화는 sqlite 파일 하나가 대화 하나라 `db`를 받아야 하는데, 그 확장자가 Codex
    /// 프로필에서도 회수 대상이 되면 안 된다.
    #[test]
    fn transcript_shape_is_split_by_provider() {
        let spec = root_spec(CleanupRootKind::ProviderTranscript);
        let rollout = Path::new("/tmp/profile/sessions/rollout-2026-09-01T00-00-00-abc.jsonl");
        let conversation = Path::new("/tmp/profile/.gemini/antigravity-cli/conversations/abc.db");

        assert!(has_transcript_shape(spec, Some(ProviderId::Codex), rollout));
        assert!(!has_transcript_shape(
            spec,
            Some(ProviderId::Codex),
            conversation
        ));

        assert!(has_transcript_shape(
            spec,
            Some(ProviderId::Antigravity),
            conversation
        ));
        assert!(!has_transcript_shape(
            spec,
            Some(ProviderId::Antigravity),
            rollout
        ));

        // Claude 프로필은 Keychain 항목뿐이라 회수할 원문이 없다.
        assert!(!has_transcript_shape(
            spec,
            Some(ProviderId::Claude),
            rollout
        ));
    }
}
