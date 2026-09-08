use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::identity;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use fs4::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app_data_file::{read_private_json, read_private_json_or_default, write_private_json};
use crate::catalog::{INTERRUPTED_ROLE, RUNTIME_FAILURE_ROLE};
use crate::clock::now_ms;
use crate::text_limit;
use crate::{
    load_session_detail_with_limit, AccountSnapshot, AccountSupervisor, AutoSwitchReason,
    AutoSwitchSignal, ChatDeliveryStatus, ChatMessageDelivery, ChatPhase, ChatProfile,
    ChatSessionInfo, ChatStartRequest, ChatSupervisor, ContentBlock, CoreError, ProviderId,
    ScheduleFrequency, ScheduleRun, ScheduleRunRound, ScheduleRunStatus, ScheduleSessionStrategy,
    ScheduledRequest, SchedulerSupervisor, SessionCatalog, SessionSummary, SessionTranscriptLimit,
    TerminalSupervisor, TranscriptItem,
};

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
    pub const ALL: &'static [Self] = &[
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

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Running => "running",
            Self::WaitingApproval => "waitingApproval",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Stopped => "stopped",
            Self::Archived => "archived",
            Self::Unavailable => "unavailable",
        }
    }

    fn is_active(self) -> bool {
        matches!(self, Self::Ready | Self::Running | Self::WaitingApproval)
    }
}

impl std::fmt::Display for SessionManagementStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SessionManagementStatus {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "ready" => Ok(Self::Ready),
            "running" => Ok(Self::Running),
            "waitingApproval" => Ok(Self::WaitingApproval),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "interrupted" => Ok(Self::Interrupted),
            "stopped" => Ok(Self::Stopped),
            "archived" => Ok(Self::Archived),
            "unavailable" => Ok(Self::Unavailable),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 세션 상태입니다: {}",
                s
            ))),
        }
    }
}

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
    pub const ALL: &'static [Self] = &[
        Self::CreatedAt,
        Self::UpdatedAt,
        Self::Title,
        Self::TurnCount,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::CreatedAt => "createdAt",
            Self::UpdatedAt => "updatedAt",
            Self::Title => "title",
            Self::TurnCount => "turnCount",
        }
    }
}

impl std::fmt::Display for SessionSortField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SessionSortField {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "createdAt" => Ok(Self::CreatedAt),
            "updatedAt" => Ok(Self::UpdatedAt),
            "title" => Ok(Self::Title),
            "turnCount" => Ok(Self::TurnCount),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 정렬 필드입니다: {}",
                s
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    #[default]
    Desc,
}

impl SortDirection {
    pub const ALL: &'static [Self] = &[Self::Asc, Self::Desc];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asc => "asc",
            Self::Desc => "desc",
        }
    }
}

impl std::fmt::Display for SortDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SortDirection {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "asc" => Ok(Self::Asc),
            "desc" => Ok(Self::Desc),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 정렬 방향입니다: {}",
                s
            ))),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListRequest {
    #[serde(default)]
    pub source: Option<ProviderId>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// 여러 공급자를 한 번에 좁히는 필터. 비우면 제약이 없고, `source`와 함께 주면
    /// 둘 다 만족하는 세션만 남는다. 세션 컨텍스트 정책이 공급자 목록을 그대로 넘긴다.
    #[serde(default)]
    pub sources: Vec<ProviderId>,
    /// 여러 프로젝트를 한 번에 좁히는 필터. 통합 보고서가 프로젝트별로 카탈로그를 다시
    /// 훑지 않도록, 허용된 경로 집합을 한 번에 받는다.
    #[serde(default)]
    pub cwds: Vec<String>,
    /// 여러 상태를 한 번에 좁히는 필터. 비우면 전체 상태다.
    #[serde(default)]
    pub statuses: Vec<SessionManagementStatus>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
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

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAppliedFilters {
    pub source: Option<ProviderId>,
    pub cwd: Option<String>,
    /// 다중 필터는 실제로 적용된 값만 담는다. 비어 있으면 그 축에 제약이 없었다는 뜻이다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<ProviderId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cwds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<SessionManagementStatus>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub status: Option<SessionManagementStatus>,
    pub search: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatisticsRequest {
    #[serde(default)]
    pub source: Option<ProviderId>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// `SessionListRequest`와 같은 다중 필터. 세션 컨텍스트 정책이 그대로 넘긴다.
    #[serde(default)]
    pub sources: Vec<ProviderId>,
    #[serde(default)]
    pub cwds: Vec<String>,
    #[serde(default)]
    pub statuses: Vec<SessionManagementStatus>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
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

impl TranscriptCategory {
    pub const ALL: [Self; 5] = [
        Self::SessionSummary,
        Self::UserRequest,
        Self::WorkPerformed,
        Self::VerificationResult,
        Self::IncompleteItem,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionSummary => "sessionSummary",
            Self::UserRequest => "userRequest",
            Self::WorkPerformed => "workPerformed",
            Self::VerificationResult => "verificationResult",
            Self::IncompleteItem => "incompleteItem",
        }
    }

    pub fn is_session_summary(self) -> bool {
        matches!(self, Self::SessionSummary)
    }

    pub fn is_user_request(self) -> bool {
        matches!(self, Self::UserRequest)
    }

    pub fn is_work_performed(self) -> bool {
        matches!(self, Self::WorkPerformed)
    }

    pub fn is_verification_result(self) -> bool {
        matches!(self, Self::VerificationResult)
    }

    pub fn is_incomplete_item(self) -> bool {
        matches!(self, Self::IncompleteItem)
    }
}

impl std::fmt::Display for TranscriptCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for TranscriptCategory {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "sessionSummary" | "session_summary" => Ok(Self::SessionSummary),
            "userRequest" | "user_request" => Ok(Self::UserRequest),
            "workPerformed" | "work_performed" => Ok(Self::WorkPerformed),
            "verificationResult" | "verification_result" => Ok(Self::VerificationResult),
            "incompleteItem" | "incomplete_item" => Ok(Self::IncompleteItem),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 대화 기록 범주입니다: {s}. sessionSummary|userRequest|workPerformed|verificationResult|incompleteItem 중 하나를 쓰세요"
            ))),
        }
    }
}

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

impl SystemAuditPhase {
    pub const ALL: [Self; 2] = [Self::Attempted, Self::Completed];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attempted => "attempted",
            Self::Completed => "completed",
        }
    }

    pub fn is_attempted(self) -> bool {
        matches!(self, Self::Attempted)
    }

    pub fn is_completed(self) -> bool {
        matches!(self, Self::Completed)
    }
}

impl std::fmt::Display for SystemAuditPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SystemAuditPhase {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "attempted" => Ok(Self::Attempted),
            "completed" => Ok(Self::Completed),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 감사 단계입니다: {s}. attempted|completed 중 하나를 쓰세요"
            ))),
        }
    }
}

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
    validate_time_range(request.from, request.to)?;
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let scope = SessionFilterScope::resolve(SessionAppliedFilters {
        source: request.source,
        cwd: request.cwd.clone(),
        sources: request.sources.clone(),
        cwds: request.cwds.clone(),
        statuses: request.statuses.clone(),
        from: request.from,
        to: request.to,
        status: request.status,
        search: normalized_search(request.search.as_deref()),
    })?;
    let pager = ForwardPager::open(
        "sessions",
        request.cursor.as_deref(),
        &json!({
            "source": request.source,
            "cwd": scope.canonical_cwd,
            "sources": request.sources,
            "cwds": scope.canonical_cwds,
            "statuses": request.statuses,
            "from": request.from,
            "to": request.to,
            "status": request.status,
            "search": scope.applied.search,
            "sort": request.sort,
            "direction": request.direction,
            "limit": limit,
        }),
        limit,
    )?;
    let mut items = scope.collect_matching(catalog, chats)?;
    sort_sessions(&mut items, request.sort, request.direction);
    let (items, next_cursor, total) = pager.cut(items, identity)?;
    Ok(SessionListResponse {
        items,
        next_cursor,
        total,
        applied_filters: scope.applied,
        sort: request.sort,
        direction: request.direction,
        counting_basis: "저장 세션은 카탈로그 messageCount, 라이브 채팅은 런타임 turnCount를 사용하며 라이브 상태는 chatId 기준으로 중복 제거합니다.",
    })
}

pub fn get_session_statistics(
    catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    request: SessionStatisticsRequest,
) -> Result<SessionStatisticsResponse, CoreError> {
    validate_time_range(request.from, request.to)?;
    let scope = SessionFilterScope::resolve(SessionAppliedFilters {
        source: request.source,
        cwd: request.cwd.clone(),
        sources: request.sources.clone(),
        cwds: request.cwds.clone(),
        statuses: request.statuses.clone(),
        from: request.from,
        to: request.to,
        status: None,
        search: None,
    })?;
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
    validate_time_range(request.from, request.to)?;
    if request
        .turn_start
        .zip(request.turn_end)
        .is_some_and(|(from, to)| from > to)
    {
        return Err(CoreError::InvalidInput(
            "turnStart는 turnEnd보다 클 수 없습니다".to_owned(),
        ));
    }
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
    let fingerprint = fingerprint(&json!({
        "source": request.source,
        "id": request.id,
        "from": request.from,
        "to": request.to,
        "turnStart": request.turn_start,
        "turnEnd": request.turn_end,
        "pageSize": page_size,
    }))?;
    let offset = cursor_offset(
        request.cursor.as_deref(),
        "session-transcript",
        &fingerprint,
    )?;
    let mut matching = transcript
        .iter()
        .filter(|item| transcript_matches(item, request))
        .cloned()
        .collect::<Vec<_>>();
    // 순번은 원본 파일의 읽은 차례라, 앱이 끼운 실행 실패·보완 저장 결과는 순번만으로
    // 정렬하면 일어난 시각과 무관하게 끝으로 몰린다. 시각을 먼저 보고 순번으로 가른다.
    matching.sort_by_key(|item| (item.timestamp.unwrap_or(i64::MIN), item.index));
    let total_matching = matching.len();
    let end = total_matching.saturating_sub(offset);
    let start = end.saturating_sub(page_size);
    let mut page_text_budget = MAX_TRANSCRIPT_PAGE_TEXT_BYTES;
    let items = matching[start..end]
        .iter()
        .map(|item| managed_transcript_item(item, &mut page_text_budget))
        .collect::<Vec<_>>();
    let consumed = total_matching.saturating_sub(start);
    let next_cursor = (start > 0)
        .then(|| encode_cursor("session-transcript", &fingerprint, consumed))
        .transpose()?;
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
    validate_time_range(request.from, request.to)?;
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let canonical_cwd = canonical_filter_path(request.cwd.as_deref())?;
    let search = normalized_search(request.search.as_deref());
    let pager = ForwardPager::open(
        "scheduled-requests",
        request.cursor.as_deref(),
        &json!({
            "id": request.id,
            "source": request.source,
            "cwd": canonical_cwd,
            "accountId": request.account_id,
            "enabled": request.enabled,
            "from": request.from,
            "to": request.to,
            "search": search,
            "limit": limit,
        }),
        limit,
    )?;
    let mut items = scheduler.snapshot()?.schedules;
    items.retain(|item| {
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
            && request.from.is_none_or(|from| item.next_run_at >= from)
            && request.to.is_none_or(|to| item.next_run_at <= to)
            && canonical_cwd
                .as_deref()
                .is_none_or(|cwd| same_cwd(&item.input.cwd, cwd))
            && search.as_deref().is_none_or(|needle| {
                searchable(&[
                    &item.id,
                    &item.input.name,
                    &item.input.cwd,
                    &item.input.account_id,
                ])
                .contains(needle)
            })
    });
    items.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let (items, next_cursor, total) = pager.cut(items, schedule_summary)?;
    Ok(ScheduledRequestListResponse {
        items,
        next_cursor,
        total,
        prompt_included: false,
        period_basis: "기간 필터는 nextRunAt을 기준으로 양 끝을 포함합니다.",
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
    validate_time_range(request.from, request.to)?;
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let pager = ForwardPager::open(
        "scheduled-runs",
        request.cursor.as_deref(),
        &json!({
            "id": request.id,
            "scheduleId": request.schedule_id,
            "status": request.status,
            "from": request.from,
            "to": request.to,
            "limit": limit,
        }),
        limit,
    )?;
    let mut items = scheduler.snapshot()?.runs;
    items.retain(|item| {
        request.id.as_ref().is_none_or(|id| &item.id == id)
            && request
                .schedule_id
                .as_ref()
                .is_none_or(|id| &item.schedule_id == id)
            && request.status.is_none_or(|status| item.status == status)
            && request.from.is_none_or(|from| item.scheduled_for >= from)
            && request.to.is_none_or(|to| item.scheduled_for <= to)
    });
    items.sort_by(|left, right| {
        right
            .scheduled_for
            .cmp(&left.scheduled_for)
            .then_with(|| left.id.cmp(&right.id))
    });
    let (items, next_cursor, total) = pager.cut(items, run_summary)?;
    Ok(ScheduleRunListResponse {
        items,
        next_cursor,
        total,
        detail_included: false,
    })
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
    let summary_truncated = run
        .summary
        .as_ref()
        .is_some_and(|summary| summary.len() > MAX_RUN_SUMMARY_BYTES);
    let error_truncated = run
        .error
        .as_ref()
        .is_some_and(|error| error.len() > MAX_RUN_ERROR_BYTES);
    run.summary = run
        .summary
        .as_deref()
        .map(|summary| truncate_text(summary, MAX_RUN_SUMMARY_BYTES));
    run.error = run
        .error
        .as_deref()
        .map(|error| truncate_text(error, MAX_RUN_ERROR_BYTES));
    Ok(ScheduleRunDetailResponse {
        run,
        summary_truncated,
        error_truncated,
    })
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
    let key_hash = hash_text(&request.idempotency_key);
    if let Some(receipt) =
        claim_idempotency(app_data_dir, "send_chat_message", &key_hash, &request_hash)?
    {
        return serde_json::from_value(receipt).map_err(CoreError::from);
    }
    let result = chats.send_managed(
        request.chat_id.trim(),
        &request.message,
        request.queue_if_running,
    );
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
    let key_hash = hash_text(&request.idempotency_key);
    if let Some(receipt) = claim_idempotency(app_data_dir, "start_chat", &key_hash, &request_hash)?
    {
        return serde_json::from_value(receipt).map_err(CoreError::from);
    }

    let result = (|| {
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
    })();
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
/// 검증과 후보 선택은 AccountSupervisor::plan_auto_switch가 담당하고, 전환 자체는
/// 수동 전환과 같은 switch_active_provider_account 경로를 재사용한다.
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
    let Some(target_account_id) = accounts.plan_auto_switch(signal)? else {
        return Ok(());
    };
    // 모든 계정은 자기 격리 프로필로 실행되므로 한도에 걸린 세션만 다른 계정에 다시 묶고,
    // 나머지 세션은 자기 계정으로 계속 돌아간다. 대상 계정의 격리가 준비되지 않으면 옮길
    // 수 없다.
    if !accounts.ensure_credential_isolation(signal.provider, &target_account_id) {
        return Ok(());
    }
    let sessions = rebindable_sessions(chats, signal)?;
    let rebound = resume_interrupted_sessions(chats, sessions, Some(&target_account_id));
    // 세션 재바인딩만으로는 새 채팅이 계속 소진된 계정에서 열린다
    // (`resolve_start_account_id`가 기본 계정으로 떨어진다). 한도에 걸린 계정이 곧 기본
    // 계정일 때만 기본 계정도 함께 옮긴다 — 격리된 다른 계정이 임계치를 넘었다고 멀쩡한
    // 기본 계정을 밀어내면 안 된다.
    let limited_is_active =
        accounts.active_account_id(signal.provider)?.as_deref() == Some(signal.account_id.as_str());
    let rotated = limited_is_active && rotate_active_account(&accounts, &target_account_id);
    if !auto_switch_moved_anything(rebound, rotated) {
        return Ok(());
    }
    accounts.record_auto_switch(
        signal.provider,
        &signal.account_id,
        &target_account_id,
        signal.reason,
        rebound,
    );
    chats.record_account_switch_attention(
        signal.provider,
        auto_switch_attention_detail(
            &accounts,
            &signal.account_id,
            &target_account_id,
            signal.reason,
            rebound,
        ),
    );
    Ok(())
}

/// 이번 신호가 계정 배치를 실제로 바꿨는지. 세션을 하나도 옮기지 않고 기본 계정도
/// 그대로면 후보만 골라 본 것이라 전환이 아니다.
///
/// 사유와 무관하게 같은 규칙을 쓴다. 전에는 분산 교체만 걸렀고, 소진·한도 신호는
/// 결과가 0건이어도 "A → B · 사유" 알림을 띄웠다. 소진된 계정이 기본 계정도 아니고
/// (기본 계정은 멀쩡하므로 밀어내지 않는다) 그 계정에 묶인 세션도 없으면 옮길 것이
/// 없는데, 알림만 보면 기본 계정이 옮겨진 것처럼 읽힌다(2026-09-03 실측: axcenter가
/// 5시간 한도를 채웠지만 살아 있는 Claude 세션은 모두 다른 계정에 묶여 있었고, 기본
/// 계정은 그대로였는데 전환 알림이 떴다). 소진 자체는 사용량 화면이 100%로 보여 준다.
///
/// 기록하지 않으면 60초 쿨다운도 소모되지 않는다. 아무것도 하지 않았으므로 다음
/// 조회에서 다시 판정하는 것이 맞다.
fn auto_switch_moved_anything(rebound: usize, rotated: bool) -> bool {
    rebound > 0 || rotated
}

/// 알림창에 남길 전환 문구. "A → B · 사유(· 세션 N개 복원)" 꼴로, 프런트
/// `autoSwitchEventSummary`의 transition과 같은 모양이다. 계정 이름을 못 찾으면
/// (삭제됐거나 스냅샷 실패) id를 그대로 써서 어느 계정 사이의 일인지는 남긴다.
fn auto_switch_attention_detail(
    accounts: &AccountSupervisor,
    from_account_id: &str,
    to_account_id: &str,
    reason: AutoSwitchReason,
    resumed_session_count: usize,
) -> String {
    let snapshot = accounts.snapshot().ok();
    let name = |id: &str| {
        snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.accounts.iter().find(|account| account.id == id))
            .map(|account| account.display_name.clone())
            .unwrap_or_else(|| id.to_owned())
    };
    let mut detail = format!(
        "{} → {} · {}",
        name(from_account_id),
        name(to_account_id),
        reason.label()
    );
    if resumed_session_count > 0 {
        detail.push_str(&format!(" · 세션 {resumed_session_count}개 복원"));
    }
    detail
}

/// 새 채팅과 이어가기가 열릴 계정(활성 계정)을 대상 계정으로 옮긴다. 실패는 이미
/// 끝난 세션 재바인딩을 되돌릴 이유가 아니므로 로그만 남기고 넘어간다.
/// 예약이 실제로 잡혔으면 true.
fn rotate_active_account(accounts: &AccountSupervisor, target_account_id: &str) -> bool {
    match accounts.request_active_account_rotation(target_account_id) {
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

/// 한도에 걸린 계정에서 다른 계정으로 옮길 채팅. 신호가 채팅을 지목하면 그 채팅만,
/// 사용량 100% 트리거처럼 지목하지 않으면 그 계정에 묶인 세션 전체가 대상이다.
/// 분산 교체 트리거에서는 유휴 세션만 옮긴다 — 아직 쓸 수 있는 계정이라 진행 중인
/// 턴을 끊을 이유가 없고, 남은 세션은 턴이 끝난 뒤 다음 갱신에서 다시 걸린다.
fn rebindable_sessions(
    chats: &ChatSupervisor,
    signal: &AutoSwitchSignal,
) -> Result<Vec<ResumableChatSession>, CoreError> {
    Ok(chats
        .live_chats(ChatProfile::Standard)?
        .into_iter()
        .filter(|info| {
            info.source == signal.provider
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
            source: info.source,
            account_id: account_id.map(str::to_owned),
            cwd: info.cwd,
            model: info.model,
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

pub fn append_system_audit(
    app_data_dir: &Path,
    operation: &str,
    arguments: &Value,
    phase: SystemAuditPhase,
    success: Option<bool>,
) -> Result<SystemAuditRecord, CoreError> {
    append_audit_as(
        app_data_dir,
        "aia",
        None,
        operation,
        arguments,
        phase,
        success,
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
        phase,
        success,
    )
}

fn append_audit_as(
    app_data_dir: &Path,
    actor: &str,
    subject: Option<&str>,
    operation: &str,
    arguments: &Value,
    phase: SystemAuditPhase,
    success: Option<bool>,
) -> Result<SystemAuditRecord, CoreError> {
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
    validate_time_range(request.from, request.to)?;
    if let Some(operation) = request.operation.as_deref() {
        validate_operation_name(operation)?;
    }
    let limit = page_size(request.limit, MAX_PAGE_SIZE)?;
    let pager = ForwardPager::open(
        "system-audit",
        request.cursor.as_deref(),
        &json!({
            "operation": request.operation,
            "success": request.success,
            "from": request.from,
            "to": request.to,
            "limit": limit,
        }),
        limit,
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
            && request.from.is_none_or(|from| item.timestamp >= from)
            && request.to.is_none_or(|to| item.timestamp <= to)
    });
    items.sort_by(|left, right| {
        right
            .timestamp
            .cmp(&left.timestamp)
            .then_with(|| left.id.cmp(&right.id))
    });
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
    canonical_cwd: Option<PathBuf>,
    canonical_cwds: Vec<PathBuf>,
}

impl SessionFilterScope {
    /// `raw`의 `cwd`·`cwds`는 요청이 준 날것이고, 여기서 정규화한 값으로 덮어쓴다.
    fn resolve(raw: SessionAppliedFilters) -> Result<Self, CoreError> {
        let canonical_cwd = canonical_filter_path(raw.cwd.as_deref())?;
        let canonical_cwds = canonical_filter_paths(&raw.cwds)?;
        let applied = SessionAppliedFilters {
            cwd: canonical_cwd
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            cwds: canonical_cwds
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            ..raw
        };
        Ok(Self {
            applied,
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
        filters.source.is_none_or(|source| item.source == source)
            && (filters.sources.is_empty() || filters.sources.contains(&item.source))
            && (filters.statuses.is_empty() || filters.statuses.contains(&item.status))
            && self.canonical_cwd.as_deref().is_none_or(|cwd| {
                item.cwd
                    .as_deref()
                    .is_some_and(|item_cwd| same_cwd(item_cwd, cwd))
            })
            && matches_any_cwd(item.cwd.as_deref(), &self.canonical_cwds)
            && filters.from.is_none_or(|from| session_time(item) >= from)
            && filters.to.is_none_or(|to| session_time(item) <= to)
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
    request
        .from
        .is_none_or(|from| item.timestamp.is_some_and(|value| value >= from))
        && request
            .to
            .is_none_or(|to| item.timestamp.is_some_and(|value| value <= to))
        && request.turn_start.is_none_or(|from| item.index >= from)
        && request.turn_end.is_none_or(|to| item.index <= to)
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
fn canonical_filter_paths(paths: &[String]) -> Result<Vec<PathBuf>, CoreError> {
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
    Ok(canonical)
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

fn validate_time_range(from: Option<i64>, to: Option<i64>) -> Result<(), CoreError> {
    if from.zip(to).is_some_and(|(from, to)| from > to) {
        return Err(CoreError::InvalidInput(
            "from은 to보다 클 수 없습니다".to_owned(),
        ));
    }
    Ok(())
}

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

fn cursor_offset(cursor: Option<&str>, kind: &str, fingerprint: &str) -> Result<usize, CoreError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| CoreError::InvalidInput("페이지 커서가 올바르지 않습니다".to_owned()))?;
    let cursor: PageCursor = serde_json::from_slice(&bytes)
        .map_err(|_| CoreError::InvalidInput("페이지 커서가 올바르지 않습니다".to_owned()))?;
    if cursor.version != 1 || cursor.kind != kind || cursor.fingerprint != fingerprint {
        return Err(CoreError::InvalidInput(
            "페이지 커서가 현재 조회 조건과 일치하지 않습니다".to_owned(),
        ));
    }
    Ok(cursor.offset)
}

/// 앞으로만 넘기는 목록 조회의 커서 해석과 다음 커서 발급을 한 곳에 모은다.
struct ForwardPager {
    kind: &'static str,
    fingerprint: String,
    offset: usize,
    limit: usize,
}

impl ForwardPager {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 결과가 0건인 신호는 사유와 무관하게 전환으로 남지 않는다. 소진·한도 신호에
    /// 예외를 다시 두면 계정 배치가 그대로인데 "A → B" 알림이 뜬다.
    #[test]
    fn auto_switch_is_recorded_only_when_something_actually_moved() {
        assert!(auto_switch_moved_anything(2, false));
        assert!(auto_switch_moved_anything(0, true));
        assert!(auto_switch_moved_anything(2, true));
        assert!(!auto_switch_moved_anything(0, false));
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
    fn audit_records_hash_but_not_original_arguments() {
        let data = tempfile::tempdir().expect("app data");
        append_system_audit(
            data.path(),
            "send_chat_message",
            &json!({"message":"private-message"}),
            SystemAuditPhase::Completed,
            Some(true),
        )
        .expect("audit");
        let stored = fs::read_to_string(data.path().join(AUDIT_FILE)).expect("audit file");
        assert!(!stored.contains("private-message"));
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

        assert!(TranscriptCategory::SessionSummary.is_session_summary());
        assert!(TranscriptCategory::UserRequest.is_user_request());
        assert!(TranscriptCategory::WorkPerformed.is_work_performed());
        assert!(TranscriptCategory::VerificationResult.is_verification_result());
        assert!(TranscriptCategory::IncompleteItem.is_incomplete_item());
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

        assert!(SystemAuditPhase::Attempted.is_attempted());
        assert!(!SystemAuditPhase::Attempted.is_completed());
        assert!(SystemAuditPhase::Completed.is_completed());
        assert!(!SystemAuditPhase::Completed.is_attempted());
    }
}
