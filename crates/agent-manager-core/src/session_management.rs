use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::identity;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use fs4::FileExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app_data_file::{read_private_json, read_private_json_or_default, write_private_json};
use crate::catalog::{INTERRUPTED_ROLE, RUNTIME_FAILURE_ROLE};
use crate::clock::now_ms;
use crate::domain::wire_enum;
use crate::text_limit;
use crate::{
    load_session_detail_with_limit, AccountSnapshot, AccountSupervisor, AutoSwitchEventView,
    AutoSwitchReason, AutoSwitchSignal, ChatDeliveryStatus, ChatMessageDelivery, ChatPhase,
    ChatProfile, ChatSessionInfo, ChatStartRequest, ChatSupervisor, ContentBlock, CoreError,
    ProviderId, ScheduleFrequency, ScheduleRun, ScheduleRunRound, ScheduleRunStatus,
    ScheduleSessionStrategy, ScheduledRequest, SchedulerSupervisor, SessionCatalog, SessionSummary,
    SessionTranscriptLimit, TerminalSupervisor, TranscriptItem,
};

/// 저장본·요청 본문에서 문자열 하나와 1:1로 대응하는 열거형에 `ALL`·
/// `as_str`·`Display`·`FromStr` 네 벌을 변이-문자열 표 하나에서 만든다. 네 벌이 각자
/// 적혀 있으면 변이를 하나 늘릴 때 한 곳을 빠뜨려도 컴파일은 지나가고, 허용값을 나열한
/// 오류 문구만 조용히 낡는다. 여기서는 허용값 목록도 같은 표에서 뽑으므로 어긋날 수 없다.
/// `$label`은 오류 문구 앞머리이고, `=> "주표현" | "별칭"`으로 되읽기 전용 별칭을 덧붙인다
/// (`as_str`는 언제나 주표현을 돌려준다).
///
/// `ALL`은 시험 전용이다. 이 표를 쓰는 열거형의 변이를 전수로 훑는 곳은 왕복 시험뿐이라
/// 비테스트 빌드에 내면 생산 코드가 쓰지 않는 상수가 되고, `pub`이라 `dead_code`에도
/// 걸리지 않은 채 공개 API로만 남는다. 그래서 `#[cfg(test)]`로 한정한다 — 훑을 일이
/// 없는 열거형만 따로 고르던 `no_all` 갈래가 필요 없어지는 이유이기도 하다.
macro_rules! session_string_enum {
    ($ty:ident, $label:literal, {
        $($variant:ident => $value:literal $(| $alias:literal)*),+ $(,)?
    }) => {
        impl $ty {
            #[cfg(test)]
            pub(crate) const ALL: [Self; [$(stringify!($variant)),+].len()] =
                [$(Self::$variant),+];

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
            type Err = $crate::CoreError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s.trim() {
                    $($value $(| $alias)* => Ok(Self::$variant),)+
                    _ => Err($crate::CoreError::InvalidInput(format!(
                        "{}: {}. {} 중 하나를 쓰세요",
                        $label,
                        s,
                        [$($value),+].join("|")
                    ))),
                }
            }
        }
    };
}

/// 세션 참조 정책·스킬 저장소 모듈도 이 표 한 벌을 쓴다. `domain::wire_enum!(choices …)`가
/// 같은 문구를 만들지만 거기에 딸려 오는 `WIRE_CHOICES` 상수를 쓰지 않는 모듈에서는
/// `dead_code`가 되므로, 허용값만 알리면 되는 자리는 이 표를 쓴다. 둘을 한 매크로로
/// 합치는 일은 `domain.rs`를 소유한 쪽 몫이다.
pub(crate) use session_string_enum;

const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 200;
const MAX_TRANSCRIPT_PAGE_SIZE: usize = 100;
const TRANSCRIPT_CLASSIFICATION_BASIS: [&str; 4] = [
    "user 역할은 userRequest로 분류합니다.",
    "오류 도구 결과와 실패·중단 표시는 incompleteItem으로 분류합니다.",
    "성공 도구 결과와 test·verify·check 표시는 verificationResult로 분류합니다.",
    "그 밖의 assistant 및 도구 호출은 workPerformed로 분류합니다.",
];
const MAX_TRANSCRIPT_BLOCK_BYTES: usize = 8 * 1024;
const MAX_TRANSCRIPT_ITEM_BYTES: usize = 12 * 1024;
const MAX_TRANSCRIPT_PAGE_TEXT_BYTES: usize = 192 * 1024;
const MAX_TRANSCRIPT_BLOCKS_PER_ITEM: usize = 32;
const MAX_STATISTIC_PROJECT_GROUPS: usize = 500;
const MAX_RUN_SUMMARY_BYTES: usize = 256 * 1024;
const MAX_RUN_ERROR_BYTES: usize = 32 * 1024;
const IDEMPOTENCY_FILE: &str = "aia-session-idempotency-v1.json";
const IDEMPOTENCY_LOCK_FILE: &str = "aia-session-idempotency-v1.lock";
const MAX_IDEMPOTENCY_RECORDS: usize = 1_000;
const AUDIT_FILE: &str = "aia-system-audit-v1.jsonl";
const AUDIT_LOCK_FILE: &str = "aia-system-audit-v1.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionManagementStatus {
    Ready,
    Running,
    WaitingApproval,
    Completed,
    Failed,
    Interrupted,
    Stopped,
    Archived,
    Unavailable,
}

impl SessionManagementStatus {
    #[cfg(test)]
    pub(crate) const ALL: &'static [Self] = &[
        Self::Ready,
        Self::Running,
        Self::WaitingApproval,
        Self::Completed,
        Self::Failed,
        Self::Interrupted,
        Self::Stopped,
        Self::Archived,
        Self::Unavailable,
    ];

    fn is_active(self) -> bool {
        matches!(self, Self::Ready | Self::Running | Self::WaitingApproval)
    }
}

wire_enum!(trimmed SessionManagementStatus, "알 수 없는 세션 상태입니다", {
    Ready => "ready",
    Running => "running",
    WaitingApproval => "waitingApproval",
    Completed => "completed",
    Failed => "failed",
    Interrupted => "interrupted",
    Stopped => "stopped",
    Archived => "archived",
    Unavailable => "unavailable",
});

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionSortField {
    CreatedAt,
    #[default]
    UpdatedAt,
    Title,
    TurnCount,
}

impl SessionSortField {
    #[cfg(test)]
    pub(crate) const ALL: &'static [Self] = &[
        Self::CreatedAt,
        Self::UpdatedAt,
        Self::Title,
        Self::TurnCount,
    ];
}

wire_enum!(trimmed SessionSortField, "알 수 없는 정렬 필드입니다", {
    CreatedAt => "createdAt",
    UpdatedAt => "updatedAt",
    Title => "title",
    TurnCount => "turnCount",
});

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    #[default]
    Desc,
}

impl SortDirection {
    #[cfg(test)]
    pub(crate) const ALL: &'static [Self] = &[Self::Asc, Self::Desc];
}

wire_enum!(trimmed SortDirection, "알 수 없는 정렬 방향입니다", {
    Asc => "asc",
    Desc => "desc",
});

/// 세션 목록과 통계가 함께 받는 범위 필터. 두 요청이 같은 축을 각자 적어 두면
/// 한쪽에만 축이 늘어나 조회 결과가 갈라진다. 축의 정의와 기본값을 여기 한 벌로
/// 두고 두 요청이 평평하게 펼쳐 받는다(바깥에서 보는 JSON 모양은 그대로다).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionScopeFilters {
    #[serde(default)]
    pub source: Option<ProviderId>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// 여러 공급자를 한 번에 좁히는 필터. 비우면 제약이 없고, `source`와 함께 주면
    /// 둘 다 만족하는 세션만 남는다. 세션 컨텍스트 정책이 공급자 목록을 그대로 넘긴다.
    ///
    /// 다중 축은 비어 있으면 직렬화에서 뺀다. 적용 필터 응답이 "그 축에 제약이
    /// 없었다"를 빈 배열이 아니라 키 없음으로 알려 온 계약을 그대로 잇는다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<ProviderId>,
    /// 여러 프로젝트를 한 번에 좁히는 필터. 통합 보고서가 프로젝트별로 카탈로그를 다시
    /// 훑지 않도록, 허용된 경로 집합을 한 번에 받는다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cwds: Vec<String>,
    /// 여러 상태를 한 번에 좁히는 필터. 비우면 전체 상태다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<SessionManagementStatus>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
}

impl SessionScopeFilters {
    /// 범위 축을 그대로 옮긴 적용 필터. 목록에만 있는 축(`status`·`search`)은
    /// 호출부가 채운다 — 통계는 둘 다 쓰지 않으므로 `None`을 준다.
    fn applied(
        &self,
        status: Option<SessionManagementStatus>,
        search: Option<String>,
    ) -> SessionAppliedFilters {
        SessionAppliedFilters {
            scope: self.clone(),
            status,
            search,
            unfiled: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListRequest {
    #[serde(flatten)]
    pub scope: SessionScopeFilters,
    #[serde(default)]
    pub status: Option<SessionManagementStatus>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort: SessionSortField,
    #[serde(default)]
    pub direction: SortDirection,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    /// true 면 어느 폴더에도 넣지 않은 세션만 돌려준다.
    #[serde(default)]
    pub unfiled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessionSummary {
    pub session_id: String,
    pub chat_id: Option<String>,
    pub source: ProviderId,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub title: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub turn_count: u64,
    pub status: SessionManagementStatus,
    pub last_turn_status: Option<String>,
    /// 이 세션이 들어 있는 폴더 id. 비어 있으면 아직 어느 폴더에도 넣지 않은 세션이다.
    /// 반복 요청이 "미분류만" 을 고르려면 목록에서 바로 보여야 한다 — 세션마다 메타를
    /// 따로 묻게 하면 245개 세션에 245번 왕복이다.
    #[serde(default)]
    pub folder_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListResponse {
    pub items: Vec<ManagedSessionSummary>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub applied_filters: SessionAppliedFilters,
    pub sort: SessionSortField,
    pub direction: SortDirection,
    pub counting_basis: &'static str,
}

/// 응답에 실어 보내는 적용 필터. 범위 축은 [`SessionScopeFilters`]를 그대로 품는다 —
/// 축 목록을 여기 한 번 더 베껴 두면 한쪽에만 축이 늘어 요청은 걸렀는데 응답은
/// 안 걸렀다고 말하는 상태가 된다. 펼쳐 실으므로 바깥에서 보는 JSON 모양은 그대로다.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAppliedFilters {
    #[serde(flatten)]
    pub scope: SessionScopeFilters,
    pub status: Option<SessionManagementStatus>,
    pub search: Option<String>,
    /// 폴더 없는 세션만 남겼는지. 목록에만 있는 축이라 통계는 늘 `false`다.
    #[serde(default)]
    pub unfiled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatisticsRequest {
    #[serde(flatten)]
    pub scope: SessionScopeFilters,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatisticsTotals {
    pub session_count: usize,
    pub turn_count: u64,
    pub completed: usize,
    pub failed: usize,
    pub interrupted: usize,
    pub active: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionStatistics {
    pub source: ProviderId,
    #[serde(flatten)]
    pub totals: SessionStatisticsTotals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionStatistics {
    pub project: String,
    pub cwd: Option<String>,
    #[serde(flatten)]
    pub totals: SessionStatisticsTotals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatisticsResponse {
    pub totals: SessionStatisticsTotals,
    pub by_provider: Vec<ProviderSessionStatistics>,
    pub by_project: Vec<ProjectSessionStatistics>,
    pub applied_filters: SessionAppliedFilters,
    pub criteria: Vec<&'static str>,
    pub total_project_groups: usize,
    pub project_groups_truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptPageRequest {
    pub source: ProviderId,
    pub id: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub page_size: Option<usize>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default)]
    pub turn_start: Option<usize>,
    #[serde(default)]
    pub turn_end: Option<usize>,
}

impl SessionTranscriptPageRequest {
    pub fn requests_page(&self) -> bool {
        self.cursor.is_some()
            || self.page_size.is_some()
            || self.from.is_some()
            || self.to.is_some()
            || self.turn_start.is_some()
            || self.turn_end.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptCategory {
    SessionSummary,
    UserRequest,
    WorkPerformed,
    VerificationResult,
    IncompleteItem,
}

session_string_enum!(TranscriptCategory, "알 수 없는 대화 기록 범주입니다", {
    SessionSummary => "sessionSummary" | "session_summary",
    UserRequest => "userRequest" | "user_request",
    WorkPerformed => "workPerformed" | "work_performed",
    VerificationResult => "verificationResult" | "verification_result",
    IncompleteItem => "incompleteItem" | "incomplete_item",
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTranscriptItem {
    pub index: usize,
    pub category: TranscriptCategory,
    pub role: String,
    pub timestamp: Option<i64>,
    pub model: Option<String>,
    pub type_label: Option<String>,
    pub blocks: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptPageResponse {
    pub session_summary: ManagedSessionSummary,
    pub items: Vec<ManagedTranscriptItem>,
    pub next_cursor: Option<String>,
    pub total_matching: usize,
    pub page_size: usize,
    pub applied_filters: TranscriptAppliedFilters,
    pub classification_basis: Vec<&'static str>,
    pub transcript_truncated: bool,
    pub skipped_lines: usize,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAppliedFilters {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub turn_start: Option<usize>,
    pub turn_end: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRequestListRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub source: Option<ProviderId>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRequestSummary {
    pub id: String,
    pub name: String,
    pub source: ProviderId,
    pub account_id: String,
    pub use_active_account: bool,
    pub cwd: String,
    pub enabled: bool,
    pub frequency: ScheduleFrequency,
    pub session_strategy: ScheduleSessionStrategy,
    pub provider_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_run_at: i64,
    pub last_run_at: Option<i64>,
    /// 이 실행이 다른 에이전트 세션을 읽는 범위 요약. 정책이 없거나 꺼져 있으면 비어 있다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_reference: Option<String>,
    /// 세션 참조 설정의 출처. 사용자가 직접 지정한 정책은 AIA가 명시적 요청 없이
    /// 바꿀 수 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_reference_origin: Option<crate::SessionReadOrigin>,
    /// 채팅 대신 등록된 워크플로를 돌리는 반복 요청이면 그 대상과 승인 버전. 이 값이
    /// 있으면 accountId·cwd는 비어 있고 실행에 쓰이지 않는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<crate::ScheduleWorkflowAction>,
    /// 예약 실행이 시작되는 절대 시각(epoch ms). 없으면 시작 제한이 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_from: Option<i64>,
    /// 예약 실행이 끝나는 절대 시각(epoch ms). 이 시각을 지나면 nextRunAt이 있어도
    /// 예약 실행은 나가지 않는다(수동 실행은 그대로 나간다).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRequestListResponse {
    pub items: Vec<ScheduledRequestSummary>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub prompt_included: bool,
    pub period_basis: &'static str,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunListRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub schedule_id: Option<String>,
    #[serde(default)]
    pub status: Option<ScheduleRunStatus>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunSummary {
    pub id: String,
    pub schedule_id: String,
    pub scheduled_for: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub status: ScheduleRunStatus,
    pub requested_account_id: String,
    pub actual_account_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub retry_count: u8,
    pub has_summary: bool,
    pub has_error: bool,
    /// 페이싱 회차였으면 계획·기동 건수. 목록에서 일한 회차와 쉰 회차를 가르는 값이라
    /// 요약 본문을 열지 않고도 보이도록 경량 응답에 함께 싣는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round: Option<ScheduleRunRound>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunListResponse {
    pub items: Vec<ScheduleRunSummary>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub detail_included: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunDetailResponse {
    pub run: ScheduleRun,
    pub summary_truncated: bool,
    pub error_truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendChatMessageRequest {
    pub chat_id: String,
    pub message: String,
    pub idempotency_key: String,
    #[serde(default)]
    pub queue_if_running: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChatRequest {
    pub chat: ChatStartRequest,
    pub message: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChatDelivery {
    pub chat_id: String,
    pub provider_session_id: Option<String>,
    pub turn_id: Option<String>,
    pub queued_at: i64,
    pub delivery_status: ChatDeliveryStatus,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDeliveryLookup {
    pub operation: String,
    pub status: String,
    pub updated_at: i64,
    pub receipt: Option<Value>,
}

fn default_stop_running_chats() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchActiveProviderAccountRequest {
    pub account_id: String,
    /// 이전 wire 계약 호환용 필드. 기본 계정 변경은 자격증명을 바꾸지 않으므로 세션을
    /// 종료할 이유가 없고, 이 값은 읽지 않는다.
    #[serde(default = "default_stop_running_chats")]
    pub stop_running_chats: bool,
    /// 이전 wire 계약 호환용 필드. 읽지 않는다.
    #[serde(default = "default_stop_running_chats")]
    pub stop_external_processes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchActiveProviderAccountReceipt {
    pub provider: ProviderId,
    pub previous_account_id: Option<String>,
    pub target_account_id: String,
    pub active_account_id: Option<String>,
    pub usage_refreshed: bool,
    pub snapshot: AccountSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdempotencyRecord {
    key_hash: String,
    request_hash: String,
    operation: String,
    status: IdempotencyStatus,
    created_at: i64,
    updated_at: i64,
    receipt: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum IdempotencyStatus {
    Pending,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdempotencyStore {
    #[serde(default)]
    records: Vec<IdempotencyRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAuditRecord {
    pub id: String,
    pub timestamp: i64,
    pub actor: String,
    pub operation: String,
    pub arguments_sha256: String,
    pub approved: bool,
    pub phase: SystemAuditPhase,
    pub success: Option<bool>,
    /// 실패한 까닭. 성공·시도 기록에는 없다.
    ///
    /// 예전에는 성공 여부만 남겨, 실패한 작업의 원인을 감사 기록만으로는 알 수 없었다.
    /// 페이싱 회차가 같은 자리에서 스무 번 넘게 떨어지는 동안 무엇이 틀렸는지 알아내려고
    /// 계약을 세 번 갈아 끼우고서야 원인을 찾았다 — 그 문구는 내내 여기 있었어야 했다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 이 기록이 어느 실행·대화에 속하는지. 세션 컨텍스트 조회는 인자 해시만으로는
    /// 어느 grant가 썼는지 알 수 없어, principal 라벨을 함께 남긴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemAuditPhase {
    Attempted,
    Completed,
}

session_string_enum!(SystemAuditPhase, "알 수 없는 감사 단계입니다", {
    Attempted => "attempted",
    Completed => "completed",
});

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAuditListRequest {
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAuditListResponse {
    pub items: Vec<SystemAuditRecord>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PageCursor {
    version: u8,
    kind: String,
    fingerprint: String,
    offset: usize,
}

pub fn list_sessions(
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    request: SessionListRequest,
) -> Result<SessionListResponse, CoreError> {
    let scope = SessionFilterScope::resolve(
        request
            .scope
            .applied(request.status, normalized_search(request.search.as_deref())),
    )?;
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let pager = CursorPager::open_window(
        "sessions",
        request.cursor.as_deref(),
        [
            ("source", json!(request.scope.source)),
            ("cwd", json!(scope.canonical_cwd)),
            ("sources", json!(request.scope.sources)),
            ("cwds", json!(scope.canonical_cwds)),
            ("statuses", json!(request.scope.statuses)),
            ("status", json!(request.status)),
            ("search", json!(scope.applied.search)),
            ("sort", json!(request.sort)),
            ("direction", json!(request.direction)),
            ("unfiled", json!(request.unfiled)),
        ],
        ListWindow {
            range: scope.range,
            limit,
        },
    )?;
    let mut items = scope.collect_matching(catalog, chats)?;
    if request.unfiled {
        retain_unfiled(&mut items);
    }
    sort_sessions(&mut items, request.sort, request.direction);
    let (items, next_cursor, total) = pager.cut(items, identity)?;
    Ok(SessionListResponse {
        items,
        next_cursor,
        total,
        applied_filters: SessionAppliedFilters {
            unfiled: request.unfiled,
            ..scope.applied
        },
        sort: request.sort,
        direction: request.direction,
        counting_basis: "저장 세션은 카탈로그 messageCount, 라이브 채팅은 런타임 turnCount를 사용하며 라이브 상태는 chatId 기준으로 중복 제거합니다.",
    })
}

/// 폴더에 넣지 않은 세션만 남긴다. 라이브 채팅뿐인 항목은 폴더가 없으므로 남는다.
fn retain_unfiled(items: &mut Vec<ManagedSessionSummary>) {
    items.retain(|item| item.folder_ids.is_empty());
}

pub fn get_session_statistics(
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    request: SessionStatisticsRequest,
) -> Result<SessionStatisticsResponse, CoreError> {
    let scope = SessionFilterScope::resolve(request.scope.applied(None, None))?;
    let items = scope.collect_matching(catalog, chats)?;

    let mut totals = SessionStatisticsTotals::default();
    let mut providers: BTreeMap<String, (ProviderId, SessionStatisticsTotals)> = BTreeMap::new();
    let mut projects: BTreeMap<String, (String, Option<String>, SessionStatisticsTotals)> =
        BTreeMap::new();
    for item in &items {
        accumulate_totals(&mut totals, item);
        let provider_key = item.source.to_string();
        let provider = providers
            .entry(provider_key)
            .or_insert_with(|| (item.source, SessionStatisticsTotals::default()));
        accumulate_totals(&mut provider.1, item);

        let project_name = item
            .project
            .clone()
            .or_else(|| item.cwd.clone())
            .unwrap_or_else(|| "미지정".to_owned());
        let project_key = format!("{}\u{0}{}", project_name, item.cwd.as_deref().unwrap_or(""));
        let project = projects.entry(project_key).or_insert_with(|| {
            (
                project_name.clone(),
                item.cwd.clone(),
                SessionStatisticsTotals::default(),
            )
        });
        accumulate_totals(&mut project.2, item);
    }

    let total_project_groups = projects.len();
    let project_groups_truncated = total_project_groups > MAX_STATISTIC_PROJECT_GROUPS;
    Ok(SessionStatisticsResponse {
        totals,
        by_provider: providers
            .into_values()
            .map(|(source, totals)| ProviderSessionStatistics { source, totals })
            .collect(),
        by_project: projects
            .into_values()
            .take(MAX_STATISTIC_PROJECT_GROUPS)
            .map(|(project, cwd, totals)| ProjectSessionStatistics {
                project,
                cwd,
                totals,
            })
            .collect(),
        applied_filters: scope.applied,
        criteria: vec![
            "기간은 updatedAt(없으면 createdAt)을 기준으로 양 끝을 포함합니다.",
            "라이브 채팅은 chatId 기준으로 중복 제거하고 같은 공급자 세션의 카탈로그 항목에 최신 런타임 상태를 합칩니다.",
            "완료·실패·중단은 카탈로그와 런타임의 마지막 확인 상태를 기준으로 분류합니다.",
        ],
        total_project_groups,
        project_groups_truncated,
    })
}

pub fn get_session_transcript_page(
    app_data_dir: &Path,
    chats: &ChatSupervisor,
    request: SessionTranscriptPageRequest,
) -> Result<SessionTranscriptPageResponse, CoreError> {
    let page_size = validate_transcript_page_request(&request)?;
    let detail = load_session_detail_with_limit(
        app_data_dir,
        request.source,
        &request.id,
        SessionTranscriptLimit::All,
    )?;
    let page = transcript_page(&detail.transcript, &request, page_size)?;
    let live = chats
        .all_chats()?
        .into_iter()
        .filter(|chat| {
            chat.source == request.source
                && chat.provider_session_id.as_deref() == Some(&request.id)
        })
        .max_by_key(|chat| chat.started_at);
    let session_summary = managed_summary_from_session(&detail.session, live.as_ref());
    Ok(SessionTranscriptPageResponse {
        session_summary,
        items: page.items,
        next_cursor: page.next_cursor,
        total_matching: page.total_matching,
        page_size,
        applied_filters: TranscriptAppliedFilters {
            from: request.from,
            to: request.to,
            turn_start: request.turn_start,
            turn_end: request.turn_end,
        },
        classification_basis: TRANSCRIPT_CLASSIFICATION_BASIS.to_vec(),
        transcript_truncated: detail.truncated,
        skipped_lines: detail.skipped_lines,
        unavailable_reason: detail.unavailable_reason,
    })
}

/// 요청의 범위 조건을 모두 검사하고 확정된 쪽 크기를 돌려준다.
fn validate_transcript_page_request(
    request: &SessionTranscriptPageRequest,
) -> Result<usize, CoreError> {
    InclusiveRange::new(request.from, request.to).validated(TIME_RANGE_MESSAGE)?;
    InclusiveRange::new(request.turn_start, request.turn_end)
        .validated("turnStart는 turnEnd보다 클 수 없습니다")?;
    page_size(request.page_size, MAX_TRANSCRIPT_PAGE_SIZE)
}

struct TranscriptPage {
    items: Vec<ManagedTranscriptItem>,
    next_cursor: Option<String>,
    total_matching: usize,
}

/// 거르기·정렬·뒤에서부터 자르기와 쪽 글자 예산을 한 곳에 모은다.
fn transcript_page(
    transcript: &[TranscriptItem],
    request: &SessionTranscriptPageRequest,
    page_size: usize,
) -> Result<TranscriptPage, CoreError> {
    let pager = CursorPager::open(
        "session-transcript",
        request.cursor.as_deref(),
        &json!({
            "source": request.source,
            "id": request.id,
            "from": request.from,
            "to": request.to,
            "turnStart": request.turn_start,
            "turnEnd": request.turn_end,
            "pageSize": page_size,
        }),
        page_size,
    )?;
    let mut matching = transcript
        .iter()
        .filter(|item| transcript_matches(item, request))
        .cloned()
        .collect::<Vec<_>>();
    // 순번은 원본 파일의 읽은 차례라, 앱이 끼운 실행 실패·보완 저장 결과는 순번만으로
    // 정렬하면 일어난 시각과 무관하게 끝으로 몰린다. 시각을 먼저 보고 순번으로 가른다.
    matching.sort_by_key(|item| (item.timestamp.unwrap_or(i64::MIN), item.index));
    let mut page_text_budget = MAX_TRANSCRIPT_PAGE_TEXT_BYTES;
    let (items, next_cursor, total_matching) = pager.cut_tail(&matching, |item| {
        managed_transcript_item(item, &mut page_text_budget)
    })?;
    Ok(TranscriptPage {
        items,
        next_cursor,
        total_matching,
    })
}

pub fn list_scheduled_requests(
    scheduler: &SchedulerSupervisor,
    request: ScheduledRequestListRequest,
) -> Result<ScheduledRequestListResponse, CoreError> {
    let range = InclusiveRange::new(request.from, request.to).validated(TIME_RANGE_MESSAGE)?;
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let canonical_cwd = canonical_filter_path(request.cwd.as_deref())?;
    let search = normalized_search(request.search.as_deref());
    let pager = CursorPager::open_window(
        "scheduled-requests",
        request.cursor.as_deref(),
        [
            ("id", json!(request.id)),
            ("source", json!(request.source)),
            ("cwd", json!(canonical_cwd)),
            ("accountId", json!(request.account_id)),
            ("enabled", json!(request.enabled)),
            ("search", json!(search)),
        ],
        ListWindow { range, limit },
    )?;
    let mut items = scheduler.snapshot()?.schedules;
    items.retain(|item| {
        scheduled_request_matches(
            item,
            &request,
            range,
            canonical_cwd.as_deref(),
            search.as_deref(),
        )
    });
    sort_newest_first(&mut items, |item| (item.updated_at, &item.id));
    let (items, next_cursor, total) = pager.cut(items, schedule_summary)?;
    Ok(ScheduledRequestListResponse {
        items,
        next_cursor,
        total,
        prompt_included: false,
        period_basis: "기간 필터는 nextRunAt을 기준으로 양 끝을 포함합니다.",
    })
}

fn scheduled_request_matches(
    item: &ScheduledRequest,
    request: &ScheduledRequestListRequest,
    range: InclusiveRange<i64>,
    canonical_cwd: Option<&Path>,
    search: Option<&str>,
) -> bool {
    request.id.as_ref().is_none_or(|id| &item.id == id)
        && request
            .source
            .is_none_or(|source| item.input.source == source)
        && request
            .account_id
            .as_ref()
            .is_none_or(|account_id| &item.input.account_id == account_id)
        && request
            .enabled
            .is_none_or(|enabled| item.input.enabled == enabled)
        && range.contains(item.next_run_at)
        && canonical_cwd.is_none_or(|cwd| same_cwd(&item.input.cwd, cwd))
        && search.is_none_or(|needle| {
            searchable(&[
                &item.id,
                &item.input.name,
                &item.input.cwd,
                &item.input.account_id,
            ])
            .contains(needle)
        })
}

pub fn get_scheduled_request_detail(
    scheduler: &SchedulerSupervisor,
    id: &str,
) -> Result<ScheduledRequest, CoreError> {
    scheduler
        .snapshot()?
        .schedules
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned()))
}

pub fn list_scheduled_runs(
    scheduler: &SchedulerSupervisor,
    request: ScheduleRunListRequest,
) -> Result<ScheduleRunListResponse, CoreError> {
    let range = InclusiveRange::new(request.from, request.to).validated(TIME_RANGE_MESSAGE)?;
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let pager = CursorPager::open_window(
        "scheduled-runs",
        request.cursor.as_deref(),
        [
            ("id", json!(request.id)),
            ("scheduleId", json!(request.schedule_id)),
            ("status", json!(request.status)),
        ],
        ListWindow { range, limit },
    )?;
    let mut items = scheduler.snapshot()?.runs;
    items.retain(|item| schedule_run_matches(item, &request, range));
    sort_newest_first(&mut items, |item| (item.scheduled_for, &item.id));
    let (items, next_cursor, total) = pager.cut(items, run_summary)?;
    Ok(ScheduleRunListResponse {
        items,
        next_cursor,
        total,
        detail_included: false,
    })
}

fn schedule_run_matches(
    item: &ScheduleRun,
    request: &ScheduleRunListRequest,
    range: InclusiveRange<i64>,
) -> bool {
    request.id.as_ref().is_none_or(|id| &item.id == id)
        && request
            .schedule_id
            .as_ref()
            .is_none_or(|id| &item.schedule_id == id)
        && request.status.is_none_or(|status| item.status == status)
        && range.contains(item.scheduled_for)
}

pub fn get_scheduled_run_detail(
    scheduler: &SchedulerSupervisor,
    id: &str,
) -> Result<ScheduleRunDetailResponse, CoreError> {
    let mut run = scheduler
        .snapshot()?
        .runs
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| CoreError::NotFound("반복 요청 실행 이력을 찾을 수 없습니다".to_owned()))?;
    let (summary, summary_truncated) =
        truncate_optional_text(run.summary.as_deref(), MAX_RUN_SUMMARY_BYTES);
    let (error, error_truncated) =
        truncate_optional_text(run.error.as_deref(), MAX_RUN_ERROR_BYTES);
    run.summary = summary;
    run.error = error;
    Ok(ScheduleRunDetailResponse {
        run,
        summary_truncated,
        error_truncated,
    })
}

/// 선택 본문의 길이 제한과 잘림 표시를 같은 판정에서 만든다.
fn truncate_optional_text(value: Option<&str>, max_bytes: usize) -> (Option<String>, bool) {
    let truncated = value.is_some_and(|value| value.len() > max_bytes);
    (
        value.map(|value| truncate_text(value, max_bytes)),
        truncated,
    )
}

pub fn send_chat_message(
    app_data_dir: &Path,
    chats: &ChatSupervisor,
    request: SendChatMessageRequest,
) -> Result<ChatMessageDelivery, CoreError> {
    validate_idempotency_key(&request.idempotency_key)?;
    let request_hash = fingerprint(&json!({
        "chatId": request.chat_id,
        "message": request.message,
        "queueIfRunning": request.queue_if_running,
    }))?;
    execute_idempotent(
        app_data_dir,
        "send_chat_message",
        &request.idempotency_key,
        &request_hash,
        || {
            chats.send_managed(
                request.chat_id.trim(),
                &request.message,
                request.queue_if_running,
            )
        },
    )
}

pub fn start_chat(
    app_data_dir: &Path,
    chats: &ChatSupervisor,
    request: StartChatRequest,
) -> Result<StartChatDelivery, CoreError> {
    validate_idempotency_key(&request.idempotency_key)?;
    let request_hash = fingerprint(&json!({
        "chat": request.chat,
        "message": request.message,
    }))?;
    execute_idempotent(
        app_data_dir,
        "start_chat",
        &request.idempotency_key,
        &request_hash,
        || {
            let attachment = chats.start(request.chat)?;
            let chat_id = attachment.info.chat_id.clone();
            let initial_provider_session_id = attachment.info.provider_session_id.clone();
            let delivery = match chats.send_managed(&chat_id, &request.message, false) {
                Ok(delivery) => delivery,
                Err(error) => {
                    let _ = chats.stop(&chat_id);
                    return Err(error);
                }
            };
            // 내부에서 만든 이 연결만 분리한다. 같은 채팅을 보고 있는 화면이 있으면 남긴다.
            chats.detach_attachment(&chat_id, attachment.generation)?;
            let provider_session_id = chats
                .all_chats()?
                .into_iter()
                .find(|chat| chat.chat_id == chat_id)
                .and_then(|chat| chat.provider_session_id)
                .or(initial_provider_session_id);
            Ok(StartChatDelivery {
                chat_id,
                provider_session_id,
                turn_id: delivery.turn_id,
                queued_at: delivery.queued_at,
                delivery_status: delivery.delivery_status,
                detached: true,
            })
        },
    )
}

/// 채팅 쓰기 작업들이 공유하는 멱등성 수명주기. 기존 영수증이 있으면 실제 작업을
/// 다시 실행하지 않고 되돌리며, 새 실행의 성공 여부와 영수증 저장 순서를 한곳에서 지킨다.
fn execute_idempotent<T>(
    app_data_dir: &Path,
    operation: &str,
    idempotency_key: &str,
    request_hash: &str,
    execute: impl FnOnce() -> Result<T, CoreError>,
) -> Result<T, CoreError>
where
    T: DeserializeOwned + Serialize,
{
    let key_hash = hash_text(idempotency_key);
    if let Some(receipt) = claim_idempotency(app_data_dir, operation, &key_hash, request_hash)? {
        return serde_json::from_value(receipt).map_err(CoreError::from);
    }

    let result = execute();
    complete_idempotency(
        app_data_dir,
        &key_hash,
        result
            .as_ref()
            .ok()
            .and_then(|receipt| serde_json::to_value(receipt).ok()),
        result.is_ok(),
    )?;
    result
}

/// 기본 계정을 바꾼다. 자격증명 교체가 없으므로 실행 중 세션을 종료하지 않는다 — 모든
/// 계정은 자기 격리 프로필로 실행되고 앱은 공유 CLI 홈에 쓰지 않는다. 요청의
/// `stopRunningChats`·`stopExternalProcesses`는 이전 wire 계약 호환용으로만 받고 읽지 않는다.
pub fn switch_active_provider_account(
    chats: &ChatSupervisor,
    _terminals: &TerminalSupervisor,
    request: SwitchActiveProviderAccountRequest,
) -> Result<SwitchActiveProviderAccountReceipt, CoreError> {
    let accounts = chats
        .accounts()
        .ok_or_else(|| CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned()))?;
    let account_id = request.account_id.trim().to_owned();
    if account_id.is_empty() {
        return Err(CoreError::InvalidInput("accountId가 필요합니다".to_owned()));
    }
    let provider = accounts.account_provider(&account_id)?;
    let previous_account_id = accounts.active_account_id(provider)?;
    let snapshot = accounts.set_active(&account_id)?;
    // 사용량 재조회는 전환 결과를 바꾸지 않는 사후 단계다. 실패해도 전환은 유지한다.
    let (usage_refreshed, snapshot) = match accounts.refresh_usage(&account_id) {
        Ok(refreshed) => (true, refreshed),
        Err(_) => (false, snapshot),
    };
    let active_account_id = accounts.active_account_id(provider)?;
    Ok(SwitchActiveProviderAccountReceipt {
        provider,
        previous_account_id,
        target_account_id: account_id,
        active_account_id,
        usage_refreshed,
        snapshot,
    })
}

/// 자동전환 트리거 신호를 받아 계정을 순환 전환하는 백그라운드 실행기를 시작한다.
/// 검증과 후보 선택은 `AccountSupervisor::plan_auto_switches`가 담당하고, 전환 자체는 세션
/// 재바인딩(`resume_interrupted_sessions`)과 기본 계정 회전
/// (`AccountSupervisor::request_active_account_rotation`)으로 한다.
pub fn spawn_auto_switch_loop(
    chats: ChatSupervisor,
    _terminals: TerminalSupervisor,
    signals: Receiver<AutoSwitchSignal>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while let Ok(signal) = signals.recv() {
            if let Err(error) = handle_auto_switch_signal(&chats, &signal) {
                eprintln!(
                    "[auto-switch] {} 계정 자동전환 실패: {error}",
                    signal.provider
                );
            }
        }
    })
}

fn handle_auto_switch_signal(
    chats: &ChatSupervisor,
    signal: &AutoSwitchSignal,
) -> Result<(), CoreError> {
    let accounts = chats
        .accounts()
        .ok_or_else(|| CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned()))?;
    // 쿨다운 안이거나 자동전환이 꺼진 계정의 신호는 여기서 끝낸다. 살아 있는 채팅을 훑고
    // 고정 세션마다 로그를 남기는 일을 거절될 신호에 되풀이하지 않는다.
    if !accounts.auto_switch_admissible(signal)? {
        return Ok(());
    }
    // 이 신호는 두 질문에 답해야 한다. 하나는 "이 계정에 묶인 세션들을 어디로 옮기나" —
    // 그 세션들이 쓰는 모델군만 보면 된다. 다른 하나는 "기본 계정을 어디로 옮기나" — 앞으로
    // 열릴 모든 대화의 자리라 지정 계정에서 열려 있던 모델군을 잃지 않는 곳이어야 한다. 한
    // 후보로 둘을 답하면 Gemini 세션을 살리려고 고른 계정이 Claude·GPT가 다 찬 곳이어서
    // 그 뒤의 Claude 대화가 전부 막힌 계정에서 열리거나, 세션들이 멀쩡하다는 이유로 소진된
    // 기본 계정이 그대로 남는다. 부작용(세션 중단·재바인딩) 앞에서 두 답을 모두 정한다.
    let sessions = rebindable_sessions(chats, signal)?;
    let session_owned;
    let models: &[String] = if signal.models.is_empty() {
        session_owned = session_models(&sessions);
        &session_owned
    } else {
        &signal.models
    };
    // 두 질문을 한 잠금 안에서 답한다 — 옮길 세션이 없으면 재바인딩은 묻지 않고, 지정
    // 계정이 기본 계정일 때만 회전을 묻는다(`plan_auto_switches`).
    let plan = accounts.plan_auto_switches(signal, (!sessions.is_empty()).then_some(models))?;
    // 모든 계정은 자기 격리 프로필로 실행되므로 한도에 걸린 세션만 다른 계정에 다시 묶고,
    // 나머지 세션은 자기 계정으로 계속 돌아간다. 격리가 준비되지 않은 계정으로는 세션도
    // 기본 계정도 옮기지 않는다 — 옮겨 놓으면 그 계정의 실행 시작이 거부된다. 세션 복구를
    // 먼저 끝낸다: 회전 목적지의 프로브(공급자 CLI, 최대 20초)가 세션 복구를 늦출 이유는 없다.
    let rebind_probe = plan
        .rebind_target
        .as_deref()
        .map(|target| accounts.ensure_credential_isolation(signal.provider, target));
    let rebind_target = plan
        .rebind_target
        .as_deref()
        .filter(|_| rebind_probe == Some(true));
    let rebound = match rebind_target {
        Some(target) => resume_interrupted_sessions(chats, sessions, Some(target)),
        None => 0,
    };
    // 세션 재바인딩만으로는 새 채팅이 계속 소진된 계정에서 열린다
    // (`resolve_start_account_id`가 기본 계정으로 떨어진다). 한도에 걸린 계정이 곧 기본
    // 계정일 때만 기본 계정도 함께 옮기며, 그 확인은 교체 직전에 다시 한다
    // (`request_active_account_rotation`). 같은 계정의 프로브를 두 번 돌리지 않는다 —
    // 재바인딩 쪽에서 이미 실패한 계정이면 그 결과를 그대로 쓴다.
    let rotate_target = plan.rotate_target.as_deref().filter(|target| {
        if plan.rebind_target.as_deref() == Some(*target) {
            rebind_probe == Some(true)
        } else {
            accounts.ensure_credential_isolation(signal.provider, target)
        }
    });
    let rotated = rotate_target
        .is_some_and(|target| rotate_active_account(&accounts, &signal.account_id, target));
    let Some(to_account_id) = switch_destination(rebind_target, rebound, rotate_target, rotated)
    else {
        return Ok(());
    };
    // 이벤트에 무엇을 담는지는 기록이 정한다(`record_auto_switch`). 알림은 기록된 이벤트
    // 하나만 읽어 같은 말을 한다 — 기록하지 못했으면 알림도 내지 않는다.
    let recorded = accounts.record_auto_switch(
        signal.provider,
        &signal.account_id,
        to_account_id,
        signal.reason,
        rebound,
        rotated,
        rebind_target,
    )?;
    chats.record_account_switch_attention(
        signal.provider,
        auto_switch_attention_detail(&accounts, &recorded),
    );
    Ok(())
}

/// 이번 신호가 기록에 남길 목적지. 실제로 움직인 쪽만 셈한다 — 세션을 하나도 옮기지 못하고
/// 기본 계정만 바뀌었으면 그 계정이고, 둘 다 움직였으면 기본 계정이 앞선다(새 대화가 열리는
/// 자리라 사용자가 가장 먼저 보는 변화다). 아무것도 움직이지 않았으면 None — 전환이 아니다.
///
/// 전에는 분산 교체만 걸렀고, 소진·한도 신호는 결과가 0건이어도 "A → B · 사유" 알림을 띄웠다.
/// 소진된 계정이 기본 계정도 아니고 그 계정에 묶인 세션도 없으면 옮길 것이 없는데, 알림만
/// 보면 기본 계정이 옮겨진 것처럼 읽힌다(2026-09-03 실측). 기록하지 않으면 60초 쿨다운도
/// 소모되지 않아 다음 조회에서 다시 판정한다.
fn switch_destination<'a>(
    rebind_target: Option<&'a str>,
    rebound: usize,
    rotate_target: Option<&'a str>,
    rotated: bool,
) -> Option<&'a str> {
    rotate_target
        .filter(|_| rotated)
        .or(rebind_target.filter(|_| rebound > 0))
}

/// 알림창에 남길 전환 문구. 기록된 이벤트의 계정 id를 표시 이름으로 바꿔 넣는다. 이름을 못
/// 찾으면(삭제됐거나 잠금 실패) id를 그대로 써서 어느 계정 사이의 일인지는 남긴다.
fn auto_switch_attention_detail(
    accounts: &AccountSupervisor,
    event: &AutoSwitchEventView,
) -> String {
    let ids = [
        event.from_account_id.as_str(),
        event.to_account_id.as_str(),
        event.sessions_to_account_id.as_deref().unwrap_or_default(),
    ];
    let names = accounts.display_names(&ids).unwrap_or_default();
    auto_switch_attention_text(event, |id| {
        names.get(id).cloned().unwrap_or_else(|| id.to_owned())
    })
}

/// 전환 알림 한 줄. 화면 요약(`src/lib/autoSwitchEvent.ts`의 transition)과 같은 모양이다 —
/// "A → B · 사유", 기본 계정이 그대로면 "· 기본 계정 유지", 세션을 옮겼으면 "· 세션 N개 복원"
/// 이고 세션이 기본 계정과 다른 곳으로 갔으면 그 행방까지 말한다. 입력은 기록된 이벤트 하나다.
fn auto_switch_attention_text(
    event: &AutoSwitchEventView,
    name: impl Fn(&str) -> String,
) -> String {
    let from = name(&event.from_account_id);
    let to = name(&event.to_account_id);
    let sessions_went_to = event.sessions_to_account_id.as_deref().map(&name);
    let default_rotated = event.default_rotated;
    let reason = event.reason;
    let resumed_session_count = event.resumed_session_count;
    let mut detail = format!("{from} → {to} · {}", reason.label());
    if !default_rotated {
        detail.push_str(" · 기본 계정 유지");
    }
    if resumed_session_count > 0 {
        match sessions_went_to {
            Some(sessions_to) => detail.push_str(&format!(
                " · 세션 {resumed_session_count}개는 {sessions_to}로 복원"
            )),
            None => detail.push_str(&format!(" · 세션 {resumed_session_count}개 복원")),
        }
    }
    detail
}

/// 새 채팅과 이어가기가 열릴 계정(활성 계정)을 대상 계정으로 옮긴다. 실패는 이미
/// 끝난 세션 재바인딩을 되돌릴 이유가 아니므로 로그만 남기고 넘어간다.
/// 예약이 실제로 잡혔으면 true.
fn rotate_active_account(
    accounts: &AccountSupervisor,
    from_account_id: &str,
    target_account_id: &str,
) -> bool {
    match accounts.request_active_account_rotation(from_account_id, target_account_id) {
        Ok(rotated) => rotated,
        Err(error) => {
            eprintln!("[auto-switch] 활성 계정을 {target_account_id}로 옮기지 못했습니다: {error}");
            false
        }
    }
}

/// 자동전환으로 종료될, 이어서 재시작할 수 있는 관리 채팅과 그 채팅에서
/// 아직 응답을 받지 못한 사용자 입력(한도로 끊긴 턴·실행 중 턴·대기열).
struct ResumableChatSession {
    info: ChatSessionInfo,
    pending_inputs: Vec<String>,
}

/// 옮길 세션들이 쓰는 모델. 하나라도 모델을 모르는 세션(공급자 기본 모델로 연 채팅)이
/// 있으면 비운다 — 아는 것만 넘기면 그 세션들이 목적지를 정하고, 모르는 세션은 자기
/// 모델군이 막힌 계정으로 끌려가 곧바로 한도에 걸린다. 비어 있으면 후보 선택이 계정 전체
/// 판정으로 폴백한다.
fn session_models(sessions: &[ResumableChatSession]) -> Vec<String> {
    let mut models = Vec::new();
    for session in sessions {
        let Some(model) = session.info.model.clone() else {
            return Vec::new();
        };
        models.push(model);
    }
    models.sort();
    models.dedup();
    models
}

/// 한도에 걸린 계정에서 다른 계정으로 옮길 채팅. 신호가 채팅을 지목하면 그 채팅만,
/// 사용량 100% 트리거처럼 지목하지 않으면 그 계정에 묶인 세션 전체가 대상이다.
/// 분산 교체 트리거에서는 유휴 세션만 옮긴다 — 아직 쓸 수 있는 계정이라 진행 중인
/// 턴을 끊을 이유가 없고, 남은 세션은 턴이 끝난 뒤 다음 갱신에서 다시 걸린다.
fn rebindable_sessions(
    chats: &ChatSupervisor,
    signal: &AutoSwitchSignal,
) -> Result<Vec<ResumableChatSession>, CoreError> {
    // AgentLimited는 채팅이 오류를 기록한 직후 Claude 프로세스를 닫는다. 그래야 이미
    // 실행된 백그라운드 에이전트의 후속 알림이 같은 제한 계정으로 API 요청을 반복하지
    // 않는다. 자동전환 신호는 별도 스레드에서 처리되므로 그때는 대상이 live 목록에서
    // 빠졌을 수 있다. 신호가 정확한 chat_id를 지목한 경우에만 종료된 런타임까지 후보로
    // 읽고, 아래의 동일 id 필터로 범위를 다시 좁힌다. 사용량 조회가 만든 계정 단위 신호와
    // 사용자가 직접 멈춘 다른 채팅은 계속 live 목록만 본다.
    let candidates = if signal.reason == AutoSwitchReason::AgentLimited && signal.chat_id.is_some()
    {
        chats.all_chats()?
    } else {
        chats.live_chats(ChatProfile::Standard)?
    };
    Ok(candidates
        .into_iter()
        .filter(|info| {
            info.profile == ChatProfile::Standard
                && info.source == signal.provider
                && info.provider_session_id.is_some()
                && info.account_id.as_deref() == Some(signal.account_id.as_str())
                && signal
                    .chat_id
                    .as_deref()
                    .is_none_or(|chat_id| info.chat_id == chat_id)
        })
        .filter(|info| {
            signal.reason != AutoSwitchReason::UsageSpread || info.state == ChatPhase::Ready
        })
        // 실행 계정을 고정한 세션은 페일오버가 옮기지 않는다. 고정은 "이 계정에서만
        // 돌린다"는 뜻이라, 한도에 걸리면 다른 계정으로 새는 대신 그대로 멈춘다.
        .filter(|info| {
            let pinned = info.provider_session_id.as_deref().and_then(|session_id| {
                chats.session_pinned_account_id(info.source, session_id)
            });
            match pinned {
                Some(account_id) => {
                    eprintln!(
                        "[auto-switch] {} 세션은 계정 {account_id}에 고정되어 페일오버 대상에서 제외합니다",
                        info.provider_session_id.as_deref().unwrap_or("-")
                    );
                    false
                }
                None => true,
            }
        })
        .map(|info| {
            let pending_inputs = chats.pending_input_texts(&info.chat_id).unwrap_or_default();
            ResumableChatSession {
                info,
                pending_inputs,
            }
        })
        .collect())
}

/// 전환 직전에 캡처한 세션들을 새 활성 계정에서 resume으로 재시작하고, 한도로
/// 응답을 받지 못한 사용자 입력을 새 세션에 순서대로 다시 보낸다.
/// 실패한 세션은 카탈로그에 남아 있어 수동으로 다시 열 수 있으므로 로그만 남긴다.
/// `account_id`를 주면 그 계정으로 다시 묶어 재시작한다(세션 단위 페일오버).
/// None이면 새 활성 계정을 쓰는 기존 공유 홈 전환 경로다. 세션 단위 경로에서는
/// 대상 채팅을 여기서 먼저 종료해, 같은 공급자의 다른 세션을 건드리지 않는다.
fn resume_interrupted_sessions(
    chats: &ChatSupervisor,
    sessions: Vec<ResumableChatSession>,
    account_id: Option<&str>,
) -> usize {
    let mut resumed = 0;
    for session in sessions {
        let ResumableChatSession {
            info,
            pending_inputs,
        } = session;
        let session_id = info.provider_session_id.clone();
        if account_id.is_some() {
            if let Err(error) = chats.stop(&info.chat_id) {
                eprintln!(
                    "[auto-switch] 재바인딩 대상 채팅을 종료하지 못했습니다({}): {error}",
                    session_id.as_deref().unwrap_or("-")
                );
                continue;
            }
        }
        let request = ChatStartRequest {
            // 다시 붙이는 것이지 새로 여는 것이 아니다. 원래 채팅이 쥐고 있던 것을 그대로
            // 물려준다 — 계정만 바꾸는 자리에서 권한이 조용히 달라지면 안 된다.
            system_tools: info.system_tools,
            source: info.source,
            account_id: account_id.map(str::to_owned),
            cwd: info.cwd,
            model: info.model,
            local_connection_id: info.local_connection_id,
            reasoning_effort: info.reasoning_effort,
            mode: info.mode,
            approval_mode: info.approval_mode,
            resume_session_id: session_id.clone(),
            handoff_origin: None,
            origin: None,
            capture_id: None,
            unattended: false,
            // 재바인딩은 세션을 다른 계정으로 옮기는 복구다. 여기서 고정하면 자동전환이
            // 옮긴 계정을 그대로 못 박아 다음 페일오버를 막는다.
            pin_account: false,
            profile: ChatProfile::Standard,
            decision_policy: Default::default(),
            aia_runtime: None,
            record_session: false,
            settings: info.settings,
            startup_cancel: None,
        };
        match chats.start(request) {
            Ok(attachment) => {
                // start()가 돌려주는 화면 연결은 즉시 분리해, 다른 detached
                // 런타임처럼 채팅 목록에서 다시 연결하도록 둔다.
                let chat_id = attachment.info.chat_id.clone();
                let generation = attachment.generation;
                drop(attachment);
                let _ = chats.detach_attachment(&chat_id, generation);
                // 한도로 끊긴 요청과 대기열 메시지를 새 계정 세션에서 이어 보낸다.
                // 첫 메시지가 턴을 시작하고 나머지는 대기열로 순서가 유지된다.
                for input in &pending_inputs {
                    if let Err(error) = chats.send(&chat_id, input) {
                        eprintln!(
                            "[auto-switch] 끊긴 요청 재전송 실패({}): {error}",
                            session_id.as_deref().unwrap_or("-")
                        );
                    }
                }
                resumed += 1;
            }
            Err(error) => eprintln!(
                "[auto-switch] 세션 복원 실패({}): {error}",
                session_id.as_deref().unwrap_or("-")
            ),
        }
    }
    resumed
}

pub fn get_chat_delivery_status(
    app_data_dir: &Path,
    idempotency_key: &str,
) -> Result<ChatDeliveryLookup, CoreError> {
    validate_idempotency_key(idempotency_key)?;
    let key_hash = hash_text(idempotency_key);
    fs::create_dir_all(app_data_dir)?;
    let lock_file = open_lock(&app_data_dir.join(IDEMPOTENCY_LOCK_FILE))?;
    FileExt::lock(&lock_file)?;
    let result = (|| {
        let store: IdempotencyStore = read_private_json(&app_data_dir.join(IDEMPOTENCY_FILE))?
            .ok_or_else(|| {
                CoreError::NotFound("해당 멱등 키의 채팅 전달 기록을 찾을 수 없습니다".to_owned())
            })?;
        let record = store
            .records
            .into_iter()
            .find(|record| record.key_hash == key_hash)
            .ok_or_else(|| {
                CoreError::NotFound("해당 멱등 키의 채팅 전달 기록을 찾을 수 없습니다".to_owned())
            })?;
        Ok(ChatDeliveryLookup {
            operation: record.operation,
            status: match record.status {
                IdempotencyStatus::Pending => "pending",
                IdempotencyStatus::Succeeded => "succeeded",
                IdempotencyStatus::Failed => "failed",
            }
            .to_owned(),
            updated_at: record.updated_at,
            receipt: record.receipt,
        })
    })();
    let _ = FileExt::unlock(&lock_file);
    result
}

///
/// `subject` 는 **이 호출이 어느 채팅에서 왔는지**다. 무인 반복 실행이 시스템 도구를
/// 쥐게 되면서(2026-09-27) 같은 `aia` 행위자 아래 사람이 시킨 것과 예약 실행이 섞인다.
/// 사후에 가르려면 호출자가 남아야 한다.
pub fn append_system_audit(
    app_data_dir: &Path,
    operation: &str,
    arguments: &Value,
    phase: SystemAuditPhase,
    success: Option<bool>,
    error: Option<&str>,
    subject: Option<&str>,
) -> Result<SystemAuditRecord, CoreError> {
    append_audit_as(
        app_data_dir,
        "aia",
        subject,
        operation,
        arguments,
        AuditOutcome {
            phase,
            success,
            error,
        },
    )
}

/// 세션 컨텍스트 읽기 도구의 감사 기록. 주체는 AIA가 아니라 grant를 받은 실행 또는 턴이라,
/// actor를 나누고 principal 라벨을 subject로 남긴다. 감사 기록은 사용자가 해제할 수 없는
/// 고정 안전장치이므로 기록 실패는 조회 실패로 다룬다.
pub fn append_session_context_audit(
    app_data_dir: &Path,
    operation: &str,
    arguments: &Value,
    subject: Option<&str>,
    phase: SystemAuditPhase,
    success: Option<bool>,
) -> Result<SystemAuditRecord, CoreError> {
    append_audit_as(
        app_data_dir,
        "sessionContext",
        subject,
        operation,
        arguments,
        AuditOutcome {
            phase,
            success,
            error: None,
        },
    )
}

/// 한 기록이 말하는 "무슨 일이 있었나". 셋은 늘 함께 다니고 따로 쓰이지 않는다.
struct AuditOutcome<'a> {
    phase: SystemAuditPhase,
    success: Option<bool>,
    error: Option<&'a str>,
}

fn append_audit_as(
    app_data_dir: &Path,
    actor: &str,
    subject: Option<&str>,
    operation: &str,
    arguments: &Value,
    outcome: AuditOutcome<'_>,
) -> Result<SystemAuditRecord, CoreError> {
    let AuditOutcome {
        phase,
        success,
        error,
    } = outcome;
    validate_operation_name(operation)?;
    fs::create_dir_all(app_data_dir)?;
    let lock_file = open_lock(&app_data_dir.join(AUDIT_LOCK_FILE))?;
    FileExt::lock(&lock_file)?;
    let record = SystemAuditRecord {
        id: format!("audit-{}", Uuid::new_v4()),
        timestamp: now_ms(),
        actor: actor.to_owned(),
        operation: operation.to_owned(),
        arguments_sha256: fingerprint(arguments)?,
        approved: true,
        phase,
        success,
        error: error.map(str::to_owned),
        subject: subject.map(str::to_owned),
    };
    let result = (|| {
        let path = app_data_dir.join(AUDIT_FILE);
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        serde_json::to_writer(&mut file, &record)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok::<(), CoreError>(())
    })();
    let _ = FileExt::unlock(&lock_file);
    result?;
    Ok(record)
}

pub fn list_system_audit(
    app_data_dir: &Path,
    request: SystemAuditListRequest,
) -> Result<SystemAuditListResponse, CoreError> {
    let range = InclusiveRange::new(request.from, request.to).validated(TIME_RANGE_MESSAGE)?;
    if let Some(operation) = request.operation.as_deref() {
        validate_operation_name(operation)?;
    }
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let pager = CursorPager::open_window(
        "system-audit",
        request.cursor.as_deref(),
        [
            ("operation", json!(request.operation)),
            ("success", json!(request.success)),
        ],
        ListWindow { range, limit },
    )?;
    let path = app_data_dir.join(AUDIT_FILE);
    let mut items = if path.is_file() {
        BufReader::new(File::open(path)?)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<SystemAuditRecord>(&line).ok())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    items.retain(|item| {
        request
            .operation
            .as_ref()
            .is_none_or(|operation| &item.operation == operation)
            && request
                .success
                .is_none_or(|success| item.success == Some(success))
            && range.contains(item.timestamp)
    });
    sort_newest_first(&mut items, |item| (item.timestamp, &item.id));
    let (items, next_cursor, total) = pager.cut(items, identity)?;
    Ok(SystemAuditListResponse {
        items,
        next_cursor,
        total,
    })
}

fn collect_session_summaries(
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
) -> Result<Vec<ManagedSessionSummary>, CoreError> {
    let mut live_by_session: HashMap<(ProviderId, String), Vec<ChatSessionInfo>> = HashMap::new();
    let mut all_live = chats.all_chats()?;
    all_live.sort_by_key(|chat| chat.started_at);
    for chat in &all_live {
        if let Some(id) = &chat.provider_session_id {
            live_by_session
                .entry((chat.source, id.clone()))
                .or_default()
                .push(chat.clone());
        }
    }
    let mut consumed_chats = HashSet::new();
    let mut items = Vec::new();
    for session in catalog.manager_snapshot()?.sessions {
        if session.meta.hidden {
            continue;
        }
        let live = live_by_session
            .get(&(session.source, session.id.clone()))
            .and_then(|items| items.last());
        if let Some(live) = live {
            consumed_chats.insert(live.chat_id.clone());
        }
        items.push(managed_summary_from_session(&session, live));
    }
    for chat in all_live {
        if consumed_chats.contains(&chat.chat_id) {
            continue;
        }
        items.push(managed_summary_from_chat(&chat));
    }
    Ok(items)
}

fn managed_summary_from_session(
    session: &SessionSummary,
    live: Option<&ChatSessionInfo>,
) -> ManagedSessionSummary {
    ManagedSessionSummary {
        session_id: session.id.clone(),
        chat_id: live.map(|chat| chat.chat_id.clone()),
        source: session.source,
        cwd: session.cwd.clone(),
        project: session.project.clone(),
        title: session.title.clone(),
        created_at: session
            .started_at
            .or_else(|| live.map(|chat| chat.started_at)),
        updated_at: session.updated_at.or(session.started_at),
        turn_count: live
            .map(|chat| chat.turn_count)
            .unwrap_or_default()
            .max(session.message_count.unwrap_or_default()),
        status: live.map_or_else(|| persisted_status(session), live_status),
        last_turn_status: live.and_then(|chat| chat.last_turn_status.clone()),
        folder_ids: session.meta.folder_ids.clone(),
    }
}

fn managed_summary_from_chat(chat: &ChatSessionInfo) -> ManagedSessionSummary {
    ManagedSessionSummary {
        session_id: chat
            .provider_session_id
            .clone()
            .unwrap_or_else(|| format!("live:{}", chat.chat_id)),
        chat_id: Some(chat.chat_id.clone()),
        source: chat.source,
        cwd: Some(chat.cwd.clone()),
        project: Path::new(&chat.cwd)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        title: format!("{} 라이브 채팅", chat.source),
        created_at: Some(chat.started_at),
        updated_at: Some(chat.started_at),
        turn_count: chat.turn_count,
        status: live_status(chat),
        last_turn_status: chat.last_turn_status.clone(),
        folder_ids: Vec::new(),
    }
}

fn persisted_status(session: &SessionSummary) -> SessionManagementStatus {
    if session.archived {
        SessionManagementStatus::Archived
    } else if !session.readable {
        SessionManagementStatus::Unavailable
    } else {
        SessionManagementStatus::Completed
    }
}

fn live_status(chat: &ChatSessionInfo) -> SessionManagementStatus {
    match chat.state {
        ChatPhase::Ready => match chat.last_turn_status.as_deref() {
            Some("failed" | "error") => SessionManagementStatus::Failed,
            Some("interrupted" | "cancelled" | "canceled") => SessionManagementStatus::Interrupted,
            Some("completed") => SessionManagementStatus::Completed,
            _ => SessionManagementStatus::Ready,
        },
        ChatPhase::Running => SessionManagementStatus::Running,
        ChatPhase::WaitingApproval => SessionManagementStatus::WaitingApproval,
        ChatPhase::Stopped => match chat.last_turn_status.as_deref() {
            Some("completed") => SessionManagementStatus::Stopped,
            Some("failed" | "error") => SessionManagementStatus::Failed,
            _ => SessionManagementStatus::Interrupted,
        },
        ChatPhase::Failed => SessionManagementStatus::Failed,
    }
}

/// 목록과 통계가 같은 필터 축을 각자 해석하던 것을 한 자리로 모은다. 정규화한 경로는
/// 걸러내기와 지문 계산에 그대로 쓰고, 응답에 실을 적용 필터는 정규화 결과를 반영한
/// 한 벌만 남긴다.
struct SessionFilterScope {
    applied: SessionAppliedFilters,
    range: InclusiveRange<i64>,
    canonical_cwd: Option<PathBuf>,
    canonical_cwds: Vec<PathBuf>,
}

impl SessionFilterScope {
    /// `raw`의 `cwd`·`cwds`는 요청이 준 날것이고, 여기서 정규화한 값으로 덮어쓴다.
    /// 시각 범위 검사도 여기서 한다 — 목록과 통계가 같은 축을 쓰는데 검사를 창구마다
    /// 적으면 한쪽만 빠져도 뒤집힌 범위가 조건 오류 대신 빈 결과로 나간다.
    fn resolve(mut raw: SessionAppliedFilters) -> Result<Self, CoreError> {
        let range =
            InclusiveRange::new(raw.scope.from, raw.scope.to).validated(TIME_RANGE_MESSAGE)?;
        let canonical_cwd = canonical_filter_path(raw.scope.cwd.as_deref())?;
        let canonical_cwds = canonical_filter_paths(&raw.scope.cwds);
        raw.scope.cwd = canonical_cwd
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        raw.scope.cwds = canonical_cwds
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let applied = raw;
        Ok(Self {
            applied,
            range,
            canonical_cwd,
            canonical_cwds,
        })
    }

    fn collect_matching(
        &self,
        catalog: &SessionCatalog,
        chats: &ChatSupervisor,
    ) -> Result<Vec<ManagedSessionSummary>, CoreError> {
        let mut items = collect_session_summaries(catalog, chats)?;
        items.retain(|item| self.matches(item));
        Ok(items)
    }

    fn matches(&self, item: &ManagedSessionSummary) -> bool {
        let filters = &self.applied;
        let scope = &filters.scope;
        scope.source.is_none_or(|source| item.source == source)
            && (scope.sources.is_empty() || scope.sources.contains(&item.source))
            && (scope.statuses.is_empty() || scope.statuses.contains(&item.status))
            && self.canonical_cwd.as_deref().is_none_or(|cwd| {
                item.cwd
                    .as_deref()
                    .is_some_and(|item_cwd| same_cwd(item_cwd, cwd))
            })
            && matches_any_cwd(item.cwd.as_deref(), &self.canonical_cwds)
            && self.range.contains(session_time(item))
            && filters.status.is_none_or(|status| item.status == status)
            && filters.search.as_deref().is_none_or(|needle| {
                searchable(&[
                    &item.session_id,
                    &item.title,
                    item.project.as_deref().unwrap_or(""),
                    item.cwd.as_deref().unwrap_or(""),
                    item.source.as_str(),
                ])
                .contains(needle)
            })
    }
}

fn session_time(item: &ManagedSessionSummary) -> i64 {
    item.updated_at.or(item.created_at).unwrap_or_default()
}

/// 커서 목록 세 자리(반복 요청·실행 이력·감사 기록)가 같이 쓰는 정렬. 최신이 먼저
/// 오고 같은 시각이면 ID 오름차순으로 끊어, 같은 필터로 다시 물어도 페이지 경계가
/// 흔들리지 않게 한다.
fn sort_newest_first<T>(items: &mut [T], key: impl Fn(&T) -> (i64, &str)) {
    items.sort_by(|left, right| {
        let (left_time, left_id) = key(left);
        let (right_time, right_id) = key(right);
        right_time
            .cmp(&left_time)
            .then_with(|| left_id.cmp(right_id))
    });
}

fn sort_sessions(
    items: &mut [ManagedSessionSummary],
    field: SessionSortField,
    direction: SortDirection,
) {
    items.sort_by(|left, right| {
        let order = match field {
            SessionSortField::CreatedAt => left.created_at.cmp(&right.created_at),
            SessionSortField::UpdatedAt => left.updated_at.cmp(&right.updated_at),
            SessionSortField::Title => left.title.to_lowercase().cmp(&right.title.to_lowercase()),
            SessionSortField::TurnCount => left.turn_count.cmp(&right.turn_count),
        }
        .then_with(|| left.session_id.cmp(&right.session_id));
        if direction == SortDirection::Desc {
            order.reverse()
        } else {
            order
        }
    });
}

fn accumulate_totals(totals: &mut SessionStatisticsTotals, item: &ManagedSessionSummary) {
    totals.session_count = totals.session_count.saturating_add(1);
    totals.turn_count = totals.turn_count.saturating_add(item.turn_count);
    match item.status {
        SessionManagementStatus::Completed
        | SessionManagementStatus::Archived
        | SessionManagementStatus::Stopped => totals.completed = totals.completed.saturating_add(1),
        SessionManagementStatus::Failed => totals.failed = totals.failed.saturating_add(1),
        SessionManagementStatus::Interrupted => {
            totals.interrupted = totals.interrupted.saturating_add(1)
        }
        status if status.is_active() => totals.active = totals.active.saturating_add(1),
        SessionManagementStatus::Unavailable => {}
        _ => {}
    }
}

fn transcript_matches(item: &TranscriptItem, request: &SessionTranscriptPageRequest) -> bool {
    InclusiveRange::new(request.from, request.to).contains_known(item.timestamp)
        && InclusiveRange::new(request.turn_start, request.turn_end).contains(item.index)
}

fn managed_transcript_item(
    item: &TranscriptItem,
    page_text_budget: &mut usize,
) -> ManagedTranscriptItem {
    let mut item_budget = MAX_TRANSCRIPT_ITEM_BYTES.min(*page_text_budget);
    let mut blocks = Vec::new();
    for block in item.blocks.iter().take(MAX_TRANSCRIPT_BLOCKS_PER_ITEM) {
        if item_budget == 0 || *page_text_budget == 0 {
            break;
        }
        let block_budget = item_budget
            .min(*page_text_budget)
            .min(MAX_TRANSCRIPT_BLOCK_BYTES);
        if block_budget < 32 {
            break;
        }
        let sanitized = sanitize_block(block, block_budget);
        let used = block_payload_len(&sanitized).min(block_budget);
        item_budget = item_budget.saturating_sub(used);
        *page_text_budget = (*page_text_budget).saturating_sub(used);
        blocks.push(sanitized);
    }
    ManagedTranscriptItem {
        index: item.index,
        category: classify_transcript(item),
        role: truncate_text(&item.role, 128),
        timestamp: item.timestamp,
        model: item.model.as_deref().map(|value| truncate_text(value, 256)),
        type_label: item
            .type_label
            .as_deref()
            .map(|value| truncate_text(value, 256)),
        blocks,
    }
}

fn classify_transcript(item: &TranscriptItem) -> TranscriptCategory {
    // 실패 표식은 문구가 어떻든 끝나지 못한 지점이다. "You've hit your session limit"처럼
    // 아래 낱말 목록에 걸리지 않는 실패 안내가 정상 작업으로 분류되지 않게 먼저 본다.
    if item.role == INTERRUPTED_ROLE || item.role == RUNTIME_FAILURE_ROLE {
        return TranscriptCategory::IncompleteItem;
    }
    if item
        .blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::RuntimeFailure { .. }))
    {
        return TranscriptCategory::IncompleteItem;
    }
    if item.role.eq_ignore_ascii_case("user") {
        return TranscriptCategory::UserRequest;
    }
    if item.blocks.iter().any(|block| {
        matches!(block, ContentBlock::ToolResult { is_error: true, .. })
            || block_text(block).is_some_and(|text| {
                contains_any(
                    text,
                    &["failed", "error", "interrupted", "실패", "중단", "오류"],
                )
            })
    }) {
        return TranscriptCategory::IncompleteItem;
    }
    if item.blocks.iter().any(|block| {
        matches!(
            block,
            ContentBlock::ToolResult {
                is_error: false,
                ..
            }
        ) || block_text(block).is_some_and(|text| {
            contains_any(
                text,
                &[
                    "test",
                    "verify",
                    "verified",
                    "check",
                    "검증",
                    "테스트",
                    "확인",
                ],
            )
        })
    }) {
        return TranscriptCategory::VerificationResult;
    }
    if item.blocks.iter().any(|block| {
        matches!(
            block,
            ContentBlock::SessionInfo(_) | ContentBlock::Context { .. }
        )
    }) {
        return TranscriptCategory::SessionSummary;
    }
    TranscriptCategory::WorkPerformed
}

fn block_text(block: &ContentBlock) -> Option<&str> {
    match block {
        ContentBlock::Text { text }
        | ContentBlock::Thinking { text }
        | ContentBlock::ToolResult { text, .. }
        | ContentBlock::RuntimeFailure { text, .. }
        | ContentBlock::Context { text, .. } => Some(text),
        ContentBlock::ToolUse { input_json, .. } => Some(input_json),
        ContentBlock::Raw { json } => Some(json),
        ContentBlock::SessionInfo(_) | ContentBlock::Image(_) => None,
    }
}

fn sanitize_block(block: &ContentBlock, max_text_bytes: usize) -> ContentBlock {
    match block {
        ContentBlock::Text { text } => ContentBlock::Text {
            text: truncate_text(text, max_text_bytes),
        },
        ContentBlock::Context { label, text } => ContentBlock::Context {
            label: truncate_text(label, 256),
            text: truncate_text(text, max_text_bytes),
        },
        ContentBlock::Thinking { text } => ContentBlock::Thinking {
            text: truncate_text(text, max_text_bytes),
        },
        ContentBlock::ToolUse { name, input_json } => ContentBlock::ToolUse {
            name: truncate_text(name, 256),
            input_json: truncate_text(input_json, max_text_bytes),
        },
        ContentBlock::RuntimeFailure { status, code, text } => ContentBlock::RuntimeFailure {
            status: truncate_text(status, 64),
            code: truncate_text(code, 256),
            text: truncate_text(text, max_text_bytes),
        },
        ContentBlock::ToolResult { text, is_error } => ContentBlock::ToolResult {
            text: truncate_text(text, max_text_bytes),
            is_error: *is_error,
        },
        ContentBlock::SessionInfo(info) => {
            let mut info = (**info).clone();
            let raw_was_truncated = info.raw_json.len() > max_text_bytes;
            info.id = info.id.as_deref().map(|value| truncate_text(value, 512));
            info.cwd = info.cwd.as_deref().map(|value| truncate_text(value, 2_048));
            info.originator = info
                .originator
                .as_deref()
                .map(|value| truncate_text(value, 512));
            info.cli_version = info
                .cli_version
                .as_deref()
                .map(|value| truncate_text(value, 256));
            info.source = info
                .source
                .as_deref()
                .map(|value| truncate_text(value, 256));
            info.model_provider = info
                .model_provider
                .as_deref()
                .map(|value| truncate_text(value, 256));
            info.thread_source = info
                .thread_source
                .as_deref()
                .map(|value| truncate_text(value, 256));
            info.history_mode = info
                .history_mode
                .as_deref()
                .map(|value| truncate_text(value, 256));
            info.context_window_id = info
                .context_window_id
                .as_deref()
                .map(|value| truncate_text(value, 512));
            info.raw_json = truncate_text(&info.raw_json, max_text_bytes);
            info.raw_truncated = info.raw_truncated || raw_was_truncated;
            ContentBlock::SessionInfo(Box::new(info))
        }
        ContentBlock::Raw { json } => ContentBlock::Raw {
            json: truncate_text(json, max_text_bytes),
        },
        ContentBlock::Image(image) => {
            let mut image = (**image).clone();
            image.media_type = truncate_text(&image.media_type, 128);
            image.source_pointer = truncate_text(&image.source_pointer, 256);
            ContentBlock::Image(Box::new(image))
        }
    }
}

fn block_payload_len(block: &ContentBlock) -> usize {
    match block {
        ContentBlock::Text { text }
        | ContentBlock::Thinking { text }
        | ContentBlock::ToolResult { text, .. }
        | ContentBlock::RuntimeFailure { text, .. }
        | ContentBlock::Context { text, .. } => text.len(),
        ContentBlock::ToolUse { input_json, .. } => input_json.len(),
        ContentBlock::Raw { json } => json.len(),
        ContentBlock::SessionInfo(info) => info.raw_json.len(),
        ContentBlock::Image(image) => image.source_pointer.len(),
    }
}

fn schedule_summary(item: ScheduledRequest) -> ScheduledRequestSummary {
    let ScheduledRequest {
        id,
        input,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        ..
    } = item;
    ScheduledRequestSummary {
        id,
        name: input.name,
        source: input.source,
        account_id: input.account_id,
        use_active_account: input.use_active_account,
        cwd: input.cwd,
        enabled: input.enabled,
        frequency: input.recurrence.frequency,
        session_strategy: input.session_strategy,
        provider_session_id: input.provider_session_id,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        session_reference: input
            .session_reference
            .as_ref()
            .filter(|settings| settings.policy.enabled)
            .map(|settings| crate::describe_session_read_policy(&settings.policy)),
        workflow: input.workflow,
        active_from: input.active_from,
        active_until: input.active_until,
        session_reference_origin: input
            .session_reference
            .as_ref()
            .filter(|settings| settings.policy.enabled)
            .map(|settings| settings.origin),
    }
}

fn run_summary(item: ScheduleRun) -> ScheduleRunSummary {
    ScheduleRunSummary {
        id: item.id,
        schedule_id: item.schedule_id,
        scheduled_for: item.scheduled_for,
        started_at: item.started_at,
        finished_at: item.finished_at,
        status: item.status,
        requested_account_id: item.requested_account_id,
        actual_account_id: item.actual_account_id,
        provider_session_id: item.provider_session_id,
        retry_count: item.retry_count,
        has_summary: item.summary.is_some(),
        has_error: item.error.is_some(),
        round: item.round,
    }
}

pub(crate) fn claim_idempotency(
    app_data_dir: &Path,
    operation: &str,
    key_hash: &str,
    request_hash: &str,
) -> Result<Option<Value>, CoreError> {
    with_idempotency_store(app_data_dir, |store| {
        if let Some(record) = store
            .records
            .iter()
            .find(|record| record.key_hash == key_hash)
        {
            if record.operation != operation || record.request_hash != request_hash {
                return Err(CoreError::Conflict(
                    "같은 idempotencyKey가 다른 요청에 사용되었습니다".to_owned(),
                ));
            }
            return match record.status {
                IdempotencyStatus::Succeeded => record.receipt.clone().map(Some).ok_or_else(|| {
                    CoreError::Runtime("멱등 실행 결과가 손상되었습니다".to_owned())
                }),
                IdempotencyStatus::Pending => Err(CoreError::Conflict(
                    "같은 요청이 이미 처리 중입니다".to_owned(),
                )),
                IdempotencyStatus::Failed => Err(CoreError::Conflict(
                    "같은 멱등 요청이 이전에 실패했습니다. 새 idempotencyKey를 사용하세요"
                        .to_owned(),
                )),
            };
        }
        let now = now_ms();
        store.records.push(IdempotencyRecord {
            key_hash: key_hash.to_owned(),
            request_hash: request_hash.to_owned(),
            operation: operation.to_owned(),
            status: IdempotencyStatus::Pending,
            created_at: now,
            updated_at: now,
            receipt: None,
        });
        if store.records.len() > MAX_IDEMPOTENCY_RECORDS {
            store.records.sort_by_key(|record| record.updated_at);
            let remove = store.records.len() - MAX_IDEMPOTENCY_RECORDS;
            store.records.drain(..remove);
        }
        Ok(None)
    })
}

pub(crate) fn complete_idempotency(
    app_data_dir: &Path,
    key_hash: &str,
    receipt: Option<Value>,
    succeeded: bool,
) -> Result<(), CoreError> {
    with_idempotency_store(app_data_dir, |store| {
        let record = store
            .records
            .iter_mut()
            .find(|record| record.key_hash == key_hash)
            .ok_or_else(|| CoreError::Runtime("멱등 실행 상태를 찾을 수 없습니다".to_owned()))?;
        record.status = if succeeded {
            IdempotencyStatus::Succeeded
        } else {
            IdempotencyStatus::Failed
        };
        record.updated_at = now_ms();
        record.receipt = receipt;
        Ok(())
    })
}

fn with_idempotency_store<T>(
    app_data_dir: &Path,
    update: impl FnOnce(&mut IdempotencyStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let lock_file = open_lock(&app_data_dir.join(IDEMPOTENCY_LOCK_FILE))?;
    FileExt::lock(&lock_file)?;
    let result = (|| {
        let path = app_data_dir.join(IDEMPOTENCY_FILE);
        let mut store: IdempotencyStore = read_private_json_or_default(&path)?;
        let result = update(&mut store)?;
        write_private_json(&path, &store)?;
        Ok(result)
    })();
    let _ = FileExt::unlock(&lock_file);
    result
}

fn open_lock(path: &Path) -> Result<File, CoreError> {
    Ok(OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?)
}

fn canonical_filter_path(path: Option<&str>) -> Result<Option<PathBuf>, CoreError> {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let canonical = fs::canonicalize(path).map_err(|error| {
        CoreError::InvalidInput(format!("cwd 필터 경로를 열 수 없습니다: {error}"))
    })?;
    if !canonical.is_dir() {
        return Err(CoreError::InvalidInput(
            "cwd 필터 경로가 디렉터리가 아닙니다".to_owned(),
        ));
    }
    Ok(Some(canonical))
}

fn same_cwd(value: &str, canonical: &Path) -> bool {
    fs::canonicalize(value).is_ok_and(|value| value == canonical)
}

/// 여러 프로젝트 필터를 한 번에 정규화한다. 실체가 없는 경로는 거부하지 않고 버린다.
/// 세션 컨텍스트 정책은 등록 프로젝트만 넘기는데, 그 사이 폴더가 사라졌다고 조회 전체가
/// 실패하면 부분 보고조차 못 하게 된다.
fn canonical_filter_paths(paths: &[String]) -> Vec<PathBuf> {
    let mut canonical = Vec::with_capacity(paths.len());
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(resolved) = fs::canonicalize(trimmed) {
            if resolved.is_dir() && !canonical.contains(&resolved) {
                canonical.push(resolved);
            }
        }
    }
    canonical
}

/// 다중 프로젝트 필터. 비어 있으면 제약이 없고, 그렇지 않으면 정규화 결과가 목록에
/// 정확히 있어야 한다. 세션 경로를 한 번만 정규화해 N×M 비교를 피한다.
fn matches_any_cwd(value: Option<&str>, canonical: &[PathBuf]) -> bool {
    if canonical.is_empty() {
        return true;
    }
    value
        .and_then(|value| fs::canonicalize(value).ok())
        .is_some_and(|value| canonical.contains(&value))
}

fn normalized_search(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
}

fn searchable(values: &[&str]) -> String {
    values.join("\n").to_lowercase()
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    let text = text.to_lowercase();
    needles.iter().any(|needle| text.contains(needle))
}

/// 전사 저장본은 바이트 상한이 곧 저장 크기 계약이라, 표시 문구까지 상한 안에 들어간다.
const TRANSCRIPT_TRUNCATION_MARKER: &str = "\n…[truncated]";

pub(crate) fn truncate_text(value: &str, max_bytes: usize) -> String {
    text_limit::truncate_bytes_with(value, max_bytes, TRANSCRIPT_TRUNCATION_MARKER)
}

/// 목록 창구가 같이 쓰는 양 끝 포함 범위. 어느 쪽이 없으면 그쪽은 열려 있다.
/// 시각(`i64`)과 턴 번호(`usize`)가 같은 규칙을 쓰므로 축 타입은 열어 둔다.
#[derive(Debug, Clone, Copy)]
struct InclusiveRange<T> {
    from: Option<T>,
    to: Option<T>,
}

impl<T: Copy + Ord> InclusiveRange<T> {
    fn new(from: Option<T>, to: Option<T>) -> Self {
        Self { from, to }
    }

    /// 뒤집힌 범위를 거른다. 문구는 축마다 달라 그대로 받는다.
    fn validated(self, message: &str) -> Result<Self, CoreError> {
        if self.from.zip(self.to).is_some_and(|(from, to)| from > to) {
            return Err(CoreError::InvalidInput(message.to_owned()));
        }
        Ok(self)
    }

    /// 값이 범위 안인지. 양 끝을 포함한다.
    fn contains(self, value: T) -> bool {
        self.from.is_none_or(|from| value >= from) && self.to.is_none_or(|to| value <= to)
    }

    /// 축 값이 없는 항목은 그 축에 조건이 걸린 쪽에서 제외된다. 시각이 비어 있는
    /// 대화 기록 항목을 시각 범위로 좁힐 때의 기존 판정이다.
    fn contains_known(self, value: Option<T>) -> bool {
        self.from
            .is_none_or(|from| value.is_some_and(|value| value >= from))
            && self
                .to
                .is_none_or(|to| value.is_some_and(|value| value <= to))
    }
}

/// 시각 범위가 뒤집혔을 때 창구가 함께 쓰는 문구.
const TIME_RANGE_MESSAGE: &str = "from은 to보다 클 수 없습니다";

fn validate_operation_name(operation: &str) -> Result<(), CoreError> {
    if operation.is_empty()
        || operation.len() > 96
        || !operation
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(CoreError::InvalidInput(
            "시스템 작업 이름이 올바르지 않습니다".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_idempotency_key(key: &str) -> Result<(), CoreError> {
    if key.is_empty()
        || key.len() > 200
        || key
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(CoreError::InvalidInput(
            "idempotencyKey는 공백 없는 1~200자여야 합니다".to_owned(),
        ));
    }
    Ok(())
}

fn page_size(value: Option<usize>, max: usize) -> Result<usize, CoreError> {
    let value = value.unwrap_or(DEFAULT_PAGE_SIZE);
    if value == 0 || value > max {
        return Err(CoreError::InvalidInput(format!(
            "limit/pageSize는 1~{max} 범위여야 합니다"
        )));
    }
    Ok(value)
}

pub(crate) fn fingerprint(value: &Value) -> Result<String, CoreError> {
    Ok(hash_bytes(&serde_json::to_vec(value)?))
}

pub(crate) fn hash_text(value: &str) -> String {
    hash_bytes(value.as_bytes())
}

fn hash_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("{:x}", hasher.finalize())
}

fn encode_cursor(kind: &str, fingerprint: &str, offset: usize) -> Result<String, CoreError> {
    let cursor = PageCursor {
        version: 1,
        kind: kind.to_owned(),
        fingerprint: fingerprint.to_owned(),
        offset,
    };
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor)?))
}

fn invalid_page_cursor() -> CoreError {
    CoreError::InvalidInput("페이지 커서가 올바르지 않습니다".to_owned())
}

fn cursor_offset(cursor: Option<&str>, kind: &str, fingerprint: &str) -> Result<usize, CoreError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid_page_cursor())?;
    let cursor: PageCursor = serde_json::from_slice(&bytes).map_err(|_| invalid_page_cursor())?;
    if cursor.version != 1 || cursor.kind != kind || cursor.fingerprint != fingerprint {
        return Err(CoreError::InvalidInput(
            "페이지 커서가 현재 조회 조건과 일치하지 않습니다".to_owned(),
        ));
    }
    Ok(cursor.offset)
}

/// 한 방향으로만 넘기는 목록 조회의 커서 해석과 다음 커서 발급을 한 곳에 모은다.
struct CursorPager {
    kind: &'static str,
    fingerprint: String,
    offset: usize,
    limit: usize,
}

/// 목록 창구 지문에 창구와 무관하게 같은 모양으로 들어가는 값들. 시각 범위는 조건이고
/// 쪽 크기는 오프셋 해석의 전제라, 둘 다 지문에 들어가야 커서가 조건 변경을 잡아낸다.
struct ListWindow {
    range: InclusiveRange<i64>,
    limit: usize,
}

impl CursorPager {
    /// 창구별 조건에 [`ListWindow`]를 합쳐 지문을 만들고 커서를 연다. 시각 범위와 쪽
    /// 크기를 창구마다 손으로 다시 적으면 `limit`를 지문과 자르기 인자 두 자리에 적게
    /// 되어 한쪽만 바뀌는 어긋남이 생긴다.
    fn open_window<const N: usize>(
        kind: &'static str,
        cursor: Option<&str>,
        filters: [(&str, Value); N],
        window: ListWindow,
    ) -> Result<Self, CoreError> {
        let mut criteria = serde_json::Map::new();
        for (key, value) in filters {
            criteria.insert(key.to_owned(), value);
        }
        criteria.insert("from".to_owned(), json!(window.range.from));
        criteria.insert("to".to_owned(), json!(window.range.to));
        criteria.insert("limit".to_owned(), json!(window.limit));
        Self::open(kind, cursor, &Value::Object(criteria), window.limit)
    }

    /// 조회 조건을 지문으로 굳히고 들어온 커서가 그 조건에서 나온 것인지 확인한다.
    fn open(
        kind: &'static str,
        cursor: Option<&str>,
        criteria: &Value,
        limit: usize,
    ) -> Result<Self, CoreError> {
        let fingerprint = fingerprint(criteria)?;
        let offset = cursor_offset(cursor, kind, &fingerprint)?;
        Ok(Self {
            kind,
            fingerprint,
            offset,
            limit,
        })
    }

    /// 걸러 정렬된 전체에서 이번 쪽을 잘라내고 (항목, 다음 커서, 전체 수)를 돌려준다.
    fn cut<T, U>(
        &self,
        items: Vec<T>,
        map: impl FnMut(T) -> U,
    ) -> Result<(Vec<U>, Option<String>, usize), CoreError> {
        let total = items.len();
        let items = items
            .into_iter()
            .skip(self.offset)
            .take(self.limit)
            .map(map)
            .collect::<Vec<_>>();
        let next_offset = self.offset.saturating_add(items.len());
        let next_cursor = (next_offset < total)
            .then(|| encode_cursor(self.kind, &self.fingerprint, next_offset))
            .transpose()?;
        Ok((items, next_cursor, total))
    }

    /// 걸러 정렬된 전체의 **끝에서부터** 이번 쪽을 잘라낸다. 대화 기록처럼 최신이 뒤에
    /// 쌓이는 목록은 뒤에서 앞으로 넘기므로, 커서 오프셋은 이미 넘긴 항목 수를 센다.
    fn cut_tail<T, U>(
        &self,
        items: &[T],
        map: impl FnMut(&T) -> U,
    ) -> Result<(Vec<U>, Option<String>, usize), CoreError> {
        let total = items.len();
        let end = total.saturating_sub(self.offset);
        let start = end.saturating_sub(self.limit);
        let page = items[start..end].iter().map(map).collect::<Vec<_>>();
        let next_cursor = (start > 0)
            .then(|| encode_cursor(self.kind, &self.fingerprint, total.saturating_sub(start)))
            .transpose()?;
        Ok((page, next_cursor, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 기록의 목적지는 실제로 움직인 쪽이다. 결과가 0건인 신호는 사유와 무관하게 전환으로
    /// 남지 않는다 — 소진·한도 신호에 예외를 다시 두면 계정 배치가 그대로인데 "A → B" 알림이
    /// 뜬다. 둘 다 움직였고 목적지가 다르면 기본 계정이 앞선다.
    #[test]
    fn the_recorded_destination_is_the_side_that_actually_moved() {
        assert_eq!(switch_destination(Some("x"), 2, None, false), Some("x"));
        assert_eq!(switch_destination(None, 0, Some("y"), true), Some("y"));
        assert_eq!(switch_destination(Some("x"), 2, Some("y"), true), Some("y"));
        // 재바인딩 후보는 있었지만 한 세션도 옮기지 못했다 — 회전만 남는다.
        assert_eq!(switch_destination(Some("x"), 0, Some("y"), true), Some("y"));
        // 회전 후보는 있었지만 실제로 바뀌지 않았다.
        assert_eq!(
            switch_destination(Some("x"), 2, Some("y"), false),
            Some("x")
        );
        assert_eq!(switch_destination(Some("x"), 0, Some("y"), false), None);
        assert_eq!(switch_destination(None, 0, None, false), None);
    }

    fn attention_event(
        resumed_session_count: usize,
        default_rotated: bool,
        sessions_to: Option<&str>,
        reason: AutoSwitchReason,
    ) -> AutoSwitchEventView {
        AutoSwitchEventView {
            from_account_id: "a".into(),
            to_account_id: "b".into(),
            reason,
            at: 0,
            resumed_session_count,
            default_rotated,
            sessions_to_account_id: sessions_to.map(str::to_owned),
        }
    }

    /// 알림은 기록된 이벤트 하나로 말한다. 세션이 기본 계정과 다른 곳으로 갔으면 그 행방을,
    /// 기본 계정이 그대로면 그 사실을 함께 말한다.
    #[test]
    fn the_attention_text_names_where_sessions_went_when_it_differs() {
        let name = |id: &str| id.to_uppercase();
        assert_eq!(
            auto_switch_attention_text(
                &attention_event(2, true, None, AutoSwitchReason::AgentLimited),
                name
            ),
            format!(
                "A → B · {} · 세션 2개 복원",
                AutoSwitchReason::AgentLimited.label()
            )
        );
        assert_eq!(
            auto_switch_attention_text(
                &attention_event(2, true, Some("x"), AutoSwitchReason::AgentLimited),
                name
            ),
            format!(
                "A → B · {} · 세션 2개는 X로 복원",
                AutoSwitchReason::AgentLimited.label()
            )
        );
        assert_eq!(
            auto_switch_attention_text(
                &attention_event(0, true, Some("x"), AutoSwitchReason::UsageExhausted),
                name
            ),
            format!("A → B · {}", AutoSwitchReason::UsageExhausted.label())
        );
        // 기본 계정이 그대로면 화면 요약과 같은 자리에서 그렇다고 말한다.
        assert_eq!(
            auto_switch_attention_text(
                &attention_event(2, false, None, AutoSwitchReason::UsageExhausted),
                name
            ),
            format!(
                "A → B · {} · 기본 계정 유지 · 세션 2개 복원",
                AutoSwitchReason::UsageExhausted.label()
            )
        );
    }

    #[test]
    fn cursor_is_bound_to_query_fingerprint() {
        let cursor = encode_cursor("sessions", "one", 50).expect("cursor");
        assert_eq!(cursor_offset(Some(&cursor), "sessions", "one").unwrap(), 50);
        assert!(cursor_offset(Some(&cursor), "sessions", "two").is_err());
        assert!(cursor_offset(Some(&cursor), "scheduled-runs", "one").is_err());
    }

    #[test]
    fn transcript_text_is_bounded_on_utf8_boundary() {
        let text = "가".repeat(MAX_TRANSCRIPT_BLOCK_BYTES);
        let truncated = truncate_text(&text, MAX_TRANSCRIPT_BLOCK_BYTES);
        assert!(truncated.len() <= MAX_TRANSCRIPT_BLOCK_BYTES);
        assert!(truncated.ends_with("…[truncated]"));
    }

    #[test]
    fn optional_text_returns_the_text_and_its_truncation_state_together() {
        assert_eq!(truncate_optional_text(None, 3), (None, false));
        assert_eq!(
            truncate_optional_text(Some("abc"), 3),
            (Some("abc".to_owned()), false)
        );

        let (text, truncated) = truncate_optional_text(Some(&"가".repeat(8)), 16);
        assert!(truncated);
        assert!(text.expect("truncated text").ends_with("…[truncated]"));
    }

    #[test]
    fn idempotency_key_rejects_whitespace() {
        assert!(validate_idempotency_key("same request").is_err());
        assert!(validate_idempotency_key("same-request").is_ok());
    }

    #[test]
    fn idempotency_store_keeps_only_hashes_and_replays_receipt() {
        let data = tempfile::tempdir().expect("app data");
        let key = "delivery-key-1";
        let key_hash = hash_text(key);
        let request_hash = hash_text("private message");
        assert!(
            claim_idempotency(data.path(), "send_chat_message", &key_hash, &request_hash,)
                .expect("claim")
                .is_none()
        );
        let receipt = json!({"chatId":"chat-1","turnId":"turn-1"});
        complete_idempotency(data.path(), &key_hash, Some(receipt.clone()), true)
            .expect("complete");
        let replay = claim_idempotency(data.path(), "send_chat_message", &key_hash, &request_hash)
            .expect("replay");
        assert_eq!(replay, Some(receipt));
        let stored = fs::read_to_string(data.path().join(IDEMPOTENCY_FILE)).expect("stored state");
        assert!(!stored.contains(key));
        assert!(!stored.contains("private message"));
    }

    #[test]
    fn idempotent_execution_replays_receipt_without_running_again() {
        let data = tempfile::tempdir().expect("app data");
        let mut executions = 0;
        let first = execute_idempotent(
            data.path(),
            "test_operation",
            "same-key",
            "same-request",
            || {
                executions += 1;
                Ok(json!({"delivery":"first"}))
            },
        )
        .expect("first execution");
        let replay = execute_idempotent(
            data.path(),
            "test_operation",
            "same-key",
            "same-request",
            || {
                executions += 1;
                Ok(json!({"delivery":"second"}))
            },
        )
        .expect("replay");

        assert_eq!(executions, 1);
        assert_eq!(replay, first);
    }

    #[test]
    fn audit_records_hash_but_not_original_arguments() {
        let data = tempfile::tempdir().expect("app data");
        append_system_audit(
            data.path(),
            "send_chat_message",
            &json!({"message":"private-message"}),
            SystemAuditPhase::Completed,
            Some(true),
            None,
            Some("chat-1"),
        )
        .expect("audit");
        let stored = fs::read_to_string(data.path().join(AUDIT_FILE)).expect("audit file");
        assert!(!stored.contains("private-message"));
        // 호출자는 남는다 — 무인 반복 실행이 시스템 도구를 쥐면서 사람이 시킨 것과
        // 예약 실행을 사후에 갈라야 한다(2026-09-27).
        assert!(stored.contains("chat-1"), "{stored}");
        let page =
            list_system_audit(data.path(), SystemAuditListRequest::default()).expect("audit page");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].success, Some(true));
    }

    #[test]
    fn transcript_item_and_page_text_are_bounded() {
        let item = TranscriptItem {
            index: 1,
            role: "assistant".to_owned(),
            timestamp: Some(1),
            model: None,
            type_label: None,
            blocks: (0..100)
                .map(|_| ContentBlock::Text {
                    text: "x".repeat(MAX_TRANSCRIPT_BLOCK_BYTES * 2),
                })
                .collect(),
            usage: None,
        };
        let mut page_budget = MAX_TRANSCRIPT_PAGE_TEXT_BYTES;
        let managed = managed_transcript_item(&item, &mut page_budget);
        assert!(managed.blocks.len() <= MAX_TRANSCRIPT_BLOCKS_PER_ITEM);
        assert!(
            managed.blocks.iter().map(block_payload_len).sum::<usize>()
                <= MAX_TRANSCRIPT_ITEM_BYTES
        );
    }

    #[test]
    fn runtime_failures_are_read_as_incomplete_items() {
        // 실패 안내에 "실패"·"오류" 같은 낱말이 없어도 끝나지 못한 지점으로 봐야 한다.
        let item = TranscriptItem {
            index: 3,
            role: RUNTIME_FAILURE_ROLE.to_owned(),
            timestamp: Some(1),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::RuntimeFailure {
                status: "failed".to_owned(),
                code: "rate_limit".to_owned(),
                text: "You've hit your session limit".to_owned(),
            }],
            usage: None,
        };
        assert!(matches!(
            classify_transcript(&item),
            TranscriptCategory::IncompleteItem
        ));
    }

    // 2026-09-27: 반복 요청이 "미분류 세션" 을 고르려면 목록에서 폴더 유무가 보여야 한다.
    #[test]
    fn list_request_without_unfiled_defaults_to_false_and_accepts_true() {
        let request: SessionListRequest =
            serde_json::from_value(serde_json::json!({"source": "codex", "limit": 5})).unwrap();
        assert!(!request.unfiled);
        let request: SessionListRequest =
            serde_json::from_value(serde_json::json!({"unfiled": true})).unwrap();
        assert!(request.unfiled);
        // 적용 필터에도 그대로 실린다 — 호출자가 무엇이 걸러졌는지 응답만 보고 안다.
        let applied = SessionAppliedFilters {
            unfiled: request.unfiled,
            ..SessionAppliedFilters::default()
        };
        assert_eq!(
            serde_json::to_value(&applied).unwrap()["unfiled"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn unfiled_filter_keeps_only_sessions_without_a_folder() {
        let summary = |id: &str, folders: &[&str]| ManagedSessionSummary {
            session_id: id.to_owned(),
            chat_id: None,
            source: ProviderId::Local,
            cwd: None,
            project: None,
            title: id.to_owned(),
            created_at: None,
            updated_at: None,
            turn_count: 0,
            status: SessionManagementStatus::Completed,
            last_turn_status: None,
            folder_ids: folders.iter().map(|f| (*f).to_owned()).collect(),
        };
        let mut items = vec![
            summary("filed", &["folder-a"]),
            summary("bare", &[]),
            summary("twice", &["folder-a", "folder-b"]),
        ];
        retain_unfiled(&mut items);
        let ids: Vec<&str> = items.iter().map(|item| item.session_id.as_str()).collect();
        assert_eq!(ids, vec!["bare"]);
        let json = serde_json::to_value(summary("x", &["folder-a"])).unwrap();
        assert_eq!(json["folderIds"], serde_json::json!(["folder-a"]));
    }

    #[test]
    fn test_session_management_status_enum() {
        use std::str::FromStr;
        for &status in SessionManagementStatus::ALL {
            let s = status.to_string();
            assert_eq!(status.as_str(), s);
            assert_eq!(SessionManagementStatus::from_str(&s).unwrap(), status);
            assert_eq!(
                SessionManagementStatus::from_str(&format!("  {s}  ")).unwrap(),
                status
            );
        }
        assert!(SessionManagementStatus::from_str("unknown").is_err());
    }

    #[test]
    fn test_session_sort_field_enum() {
        use std::str::FromStr;
        for &field in SessionSortField::ALL {
            let s = field.to_string();
            assert_eq!(field.as_str(), s);
            assert_eq!(SessionSortField::from_str(&s).unwrap(), field);
            assert_eq!(
                SessionSortField::from_str(&format!("  {s}  ")).unwrap(),
                field
            );
        }
        assert!(SessionSortField::from_str("unknown").is_err());
    }

    #[test]
    fn test_sort_direction_enum() {
        use std::str::FromStr;
        for &dir in SortDirection::ALL {
            let s = dir.to_string();
            assert_eq!(dir.as_str(), s);
            assert_eq!(SortDirection::from_str(&s).unwrap(), dir);
            assert_eq!(SortDirection::from_str(&format!("  {s}  ")).unwrap(), dir);
        }
        assert!(SortDirection::from_str("unknown").is_err());
    }

    #[test]
    fn test_transcript_category_enum() {
        use std::str::FromStr;
        for &category in &TranscriptCategory::ALL {
            let s = category.to_string();
            assert_eq!(category.as_str(), s);
            assert_eq!(TranscriptCategory::from_str(&s).unwrap(), category);
        }
        assert_eq!(
            TranscriptCategory::from_str("session_summary").unwrap(),
            TranscriptCategory::SessionSummary
        );
        assert_eq!(
            TranscriptCategory::from_str("user_request").unwrap(),
            TranscriptCategory::UserRequest
        );
        assert_eq!(
            TranscriptCategory::from_str("work_performed").unwrap(),
            TranscriptCategory::WorkPerformed
        );
        assert_eq!(
            TranscriptCategory::from_str("verification_result").unwrap(),
            TranscriptCategory::VerificationResult
        );
        assert_eq!(
            TranscriptCategory::from_str("incomplete_item").unwrap(),
            TranscriptCategory::IncompleteItem
        );
        assert!(TranscriptCategory::from_str("unknown").is_err());
    }

    #[test]
    fn test_system_audit_phase_enum() {
        use std::str::FromStr;
        for &phase in &SystemAuditPhase::ALL {
            let s = phase.to_string();
            assert_eq!(phase.as_str(), s);
            assert_eq!(SystemAuditPhase::from_str(&s).unwrap(), phase);
        }
        assert!(SystemAuditPhase::from_str("unknown").is_err());
    }
}
