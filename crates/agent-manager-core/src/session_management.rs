use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use fs4::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    load_session_detail_with_limit, terminate_external_provider_processes, AccountSnapshot,
    AutoSwitchSignal, ChatDeliveryStatus, ChatMessageDelivery, ChatPhase, ChatProfile,
    ChatSessionInfo, ChatStartRequest, ChatSupervisor, ContentBlock, CoreError,
    ExternalProcessFailure, ProviderId, ScheduleFrequency, ScheduleRun, ScheduleRunStatus,
    ScheduleSessionStrategy, ScheduledRequest, SchedulerSupervisor, SessionCatalog, SessionSummary,
    SessionTranscriptLimit, StopChatFailure, StopTerminalFailure, TerminalSupervisor,
    TranscriptItem,
};

const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 200;
const MAX_TRANSCRIPT_PAGE_SIZE: usize = 100;
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
    fn is_active(self) -> bool {
        matches!(self, Self::Ready | Self::Running | Self::WaitingApproval)
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    #[default]
    Desc,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListRequest {
    #[serde(default)]
    pub source: Option<ProviderId>,
    #[serde(default)]
    pub cwd: Option<String>,
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

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptCategory {
    SessionSummary,
    UserRequest,
    WorkPerformed,
    VerificationResult,
    IncompleteItem,
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
    pub cwd: String,
    pub enabled: bool,
    pub frequency: ScheduleFrequency,
    pub session_strategy: ScheduleSessionStrategy,
    pub provider_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_run_at: i64,
    pub last_run_at: Option<i64>,
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
    /// 이전 wire 계약 호환용 필드다. 보안 정책상 false여도 서버는 해당 공급자의
    /// 모든 Agent Manager 관리 채팅·터미널을 반드시 종료한다.
    #[serde(default = "default_stop_running_chats")]
    pub stop_running_chats: bool,
    /// 이전 wire 계약 호환용 필드다. false여도 외부 공급자 CLI를 반드시 종료한다.
    /// 외부 종료 실패는 기존 정책대로 receipt에만 보고하고 전환을 막지 않는다.
    #[serde(default = "default_stop_running_chats")]
    pub stop_external_processes: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SwitchCleanupPolicy {
    stop_managed_runtimes: bool,
    stop_external_processes: bool,
}

impl SwitchActiveProviderAccountRequest {
    fn enforced_cleanup_policy(&self) -> SwitchCleanupPolicy {
        // 두 bool은 구버전 클라이언트의 역직렬화 호환만 유지한다. 보안 경계는
        // 클라이언트 선택에 위임하지 않고 Core가 항상 강제한다.
        let _legacy_preferences = (self.stop_running_chats, self.stop_external_processes);
        SwitchCleanupPolicy {
            stop_managed_runtimes: true,
            stop_external_processes: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchActiveProviderAccountReceipt {
    pub provider: ProviderId,
    pub previous_account_id: Option<String>,
    pub target_account_id: String,
    pub active_account_id: Option<String>,
    pub requested_count: usize,
    pub stopped_count: usize,
    /// 정상 종료가 실패해 SIGKILL 강제 종료로 승격된 세션 수. `stopped_count`에 포함된다.
    pub forced_count: usize,
    pub failed: Vec<StopChatFailure>,
    pub terminal_requested_count: usize,
    pub terminal_stopped_count: usize,
    /// 정상 종료 유예 시간 이후 PID 기반 SIGKILL로 승격된 관리 터미널 수.
    pub terminal_forced_count: usize,
    pub terminal_failed: Vec<StopTerminalFailure>,
    pub remaining_terminal_count: usize,
    pub remaining_runtime_count: usize,
    /// 종료 대상이 된 외부 독립 실행 공급자 CLI 프로세스 수.
    pub external_requested_count: usize,
    pub external_terminated_count: usize,
    /// SIGTERM이 실패해 SIGKILL로 승격된 외부 프로세스 수. `external_terminated_count`에 포함된다.
    pub external_forced_count: usize,
    /// 강제 종료까지 실패한 외부 프로세스. 자격증명 변경은 막지 않는다.
    pub external_failed: Vec<ExternalProcessFailure>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemAuditPhase {
    Attempted,
    Completed,
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
    let canonical_cwd = canonical_filter_path(request.cwd.as_deref())?;
    let fingerprint = fingerprint(&json!({
        "source": request.source,
        "cwd": canonical_cwd,
        "from": request.from,
        "to": request.to,
        "status": request.status,
        "search": normalized_search(request.search.as_deref()),
        "sort": request.sort,
        "direction": request.direction,
        "limit": limit,
    }))?;
    let offset = cursor_offset(request.cursor.as_deref(), "sessions", &fingerprint)?;
    let applied_filters = SessionAppliedFilters {
        source: request.source,
        cwd: canonical_cwd
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        from: request.from,
        to: request.to,
        status: request.status,
        search: normalized_search(request.search.as_deref()),
    };
    let mut items = collect_session_summaries(catalog, chats)?;
    items.retain(|item| session_matches(item, &applied_filters, canonical_cwd.as_deref()));
    sort_sessions(&mut items, request.sort, request.direction);
    let total = items.len();
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(items.len());
    let next_cursor = (next_offset < total)
        .then(|| encode_cursor("sessions", &fingerprint, next_offset))
        .transpose()?;
    Ok(SessionListResponse {
        items,
        next_cursor,
        total,
        applied_filters,
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
    let canonical_cwd = canonical_filter_path(request.cwd.as_deref())?;
    let applied_filters = SessionAppliedFilters {
        source: request.source,
        cwd: canonical_cwd
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        from: request.from,
        to: request.to,
        status: None,
        search: None,
    };
    let mut items = collect_session_summaries(catalog, chats)?;
    items.retain(|item| session_matches(item, &applied_filters, canonical_cwd.as_deref()));

    let mut totals = SessionStatisticsTotals::default();
    let mut providers: BTreeMap<String, (ProviderId, SessionStatisticsTotals)> = BTreeMap::new();
    let mut projects: BTreeMap<String, (String, Option<String>, SessionStatisticsTotals)> =
        BTreeMap::new();
    for item in &items {
        accumulate_totals(&mut totals, item);
        let provider_key = provider_name(item.source).to_owned();
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
        applied_filters,
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
    let page_size = page_size(request.page_size, MAX_TRANSCRIPT_PAGE_SIZE)?;
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
    let detail = load_session_detail_with_limit(
        app_data_dir,
        request.source,
        &request.id,
        SessionTranscriptLimit::All,
    )?;
    let mut transcript = detail
        .transcript
        .iter()
        .filter(|item| transcript_matches(item, &request))
        .cloned()
        .collect::<Vec<_>>();
    transcript.sort_by_key(|item| item.index);
    let total_matching = transcript.len();
    let end = total_matching.saturating_sub(offset);
    let start = end.saturating_sub(page_size);
    let mut page_text_budget = MAX_TRANSCRIPT_PAGE_TEXT_BYTES;
    let items = transcript[start..end]
        .iter()
        .map(|item| managed_transcript_item(item, &mut page_text_budget))
        .collect::<Vec<_>>();
    let consumed = total_matching.saturating_sub(start);
    let next_cursor = (start > 0)
        .then(|| encode_cursor("session-transcript", &fingerprint, consumed))
        .transpose()?;
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
        items,
        next_cursor,
        total_matching,
        page_size,
        applied_filters: TranscriptAppliedFilters {
            from: request.from,
            to: request.to,
            turn_start: request.turn_start,
            turn_end: request.turn_end,
        },
        classification_basis: vec![
            "user 역할은 userRequest로 분류합니다.",
            "오류 도구 결과와 실패·중단 표시는 incompleteItem으로 분류합니다.",
            "성공 도구 결과와 test·verify·check 표시는 verificationResult로 분류합니다.",
            "그 밖의 assistant 및 도구 호출은 workPerformed로 분류합니다.",
        ],
        transcript_truncated: detail.truncated,
        skipped_lines: detail.skipped_lines,
        unavailable_reason: detail.unavailable_reason,
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
    let fingerprint = fingerprint(&json!({
        "id": request.id,
        "source": request.source,
        "cwd": canonical_cwd,
        "accountId": request.account_id,
        "enabled": request.enabled,
        "from": request.from,
        "to": request.to,
        "search": search,
        "limit": limit,
    }))?;
    let offset = cursor_offset(
        request.cursor.as_deref(),
        "scheduled-requests",
        &fingerprint,
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
    let total = items.len();
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(schedule_summary)
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(items.len());
    let next_cursor = (next_offset < total)
        .then(|| encode_cursor("scheduled-requests", &fingerprint, next_offset))
        .transpose()?;
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
    let fingerprint = fingerprint(&json!({
        "id": request.id,
        "scheduleId": request.schedule_id,
        "status": request.status,
        "from": request.from,
        "to": request.to,
        "limit": limit,
    }))?;
    let offset = cursor_offset(request.cursor.as_deref(), "scheduled-runs", &fingerprint)?;
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
    let total = items.len();
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(run_summary)
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(items.len());
    let next_cursor = (next_offset < total)
        .then(|| encode_cursor("scheduled-runs", &fingerprint, next_offset))
        .transpose()?;
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
        chats.detach(&chat_id)?;
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

/// 실행 중 세션을 모두 종료한 뒤 활성 계정을 변경한다.
///
/// 관리 런타임은 정상 종료가 실패하면 PID 기반 SIGKILL 강제 종료로 승격하며,
/// 강제 종료까지 실패한 관리 런타임이 하나라도 남으면 자격증명을 변경하지
/// 않는다. 외부에서 독립 실행한 공급자 CLI 프로세스(터미널·IDE 확장 등)도
/// 같은 방식(SIGTERM 후 SIGKILL 승격)으로 종료 대상에 포함하되, 외부 프로세스
/// 종료 실패는 영수증에 보고만 하고 자격증명 변경을 막지 않는다(기존에도
/// 외부 프로세스는 전환을 막지 않았다). 종료와 자격증명 교체 사이의 신규
/// 런타임 생성은 `set_active`가 공급자 전환 잠금 아래에서 runtimeCount를
/// 재검증해 명시적 충돌로 거부한다. 이미 종료된 런타임은 복원할 수 없으므로
/// 이후 단계가 실패해도 종료 결과를 오류 메시지에 남긴다.
pub fn switch_active_provider_account(
    chats: &ChatSupervisor,
    terminals: &TerminalSupervisor,
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
    let cleanup_policy = request.enforced_cleanup_policy();
    debug_assert!(cleanup_policy.stop_managed_runtimes);
    debug_assert!(cleanup_policy.stop_external_processes);

    // 한쪽 종료가 실패해도 다른 관리 런타임까지 정리를 시도한다. 두 보고서를
    // 모두 검증하기 전에는 외부 프로세스 종료나 credential 교체로 진행하지 않는다.
    let (chat_result, terminal_result) = (
        chats.stop_provider_chats(provider),
        terminals.stop_provider_terminals(provider),
    );
    let report = chat_result?;
    let terminal_report = terminal_result?;
    let remaining_runtime_count = accounts.provider_runtime_count(provider)?;
    let remaining_terminal_count = terminals.provider_terminal_count(provider)?;
    if !report.failed.is_empty()
        || !terminal_report.failed.is_empty()
        || remaining_runtime_count > 0
        || remaining_terminal_count > 0
    {
        let failed_chats = report
            .failed
            .iter()
            .map(|failure| failure.chat_id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let failed_terminals = terminal_report
            .failed
            .iter()
            .map(|failure| failure.terminal_id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(CoreError::Conflict(format!(
            "{} 관리 런타임을 완전히 종료하지 못해 계정은 변경하지 않았습니다 (채팅 요청 {}, 실패 [{}]; 터미널 요청 {}, 실패 [{}]; 잔존 account lease {}, 잔존 터미널 {})",
            provider.as_str(),
            report.requested_count,
            failed_chats,
            terminal_report.requested_count,
            failed_terminals,
            remaining_runtime_count,
            remaining_terminal_count,
        )));
    }

    // 관리 런타임 정리가 끝난 뒤 외부 독립 실행 CLI 프로세스를 종료한다.
    // 자격증명 교체 전에 수행해 이전 계정 토큰 갱신과의 경쟁을 줄인다.
    let external_report = terminate_external_provider_processes(provider)?;

    let managed_stopped_count = report.stopped_count + terminal_report.stopped_count;
    let snapshot = accounts.set_active(&account_id).map_err(|error| {
        if managed_stopped_count > 0 {
            CoreError::Conflict(format!(
                "관리 런타임 {}개는 이미 종료되었지만 계정 전환에 실패했습니다(종료된 런타임은 복원되지 않습니다): {error}",
                managed_stopped_count
            ))
        } else {
            error
        }
    })?;

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
        requested_count: report.requested_count,
        stopped_count: report.stopped_count,
        forced_count: report.forced_count,
        failed: report.failed,
        terminal_requested_count: terminal_report.requested_count,
        terminal_stopped_count: terminal_report.stopped_count,
        terminal_forced_count: terminal_report.forced_count,
        terminal_failed: terminal_report.failed,
        remaining_terminal_count,
        remaining_runtime_count,
        external_requested_count: external_report.requested_count,
        external_terminated_count: external_report.terminated_count,
        external_forced_count: external_report.forced_count,
        external_failed: external_report.failed,
        usage_refreshed,
        snapshot,
    })
}

/// 자동전환 트리거 신호를 받아 계정을 순환 전환하는 백그라운드 실행기를 시작한다.
/// 검증과 후보 선택은 AccountSupervisor::plan_auto_switch가 담당하고, 전환 자체는
/// 수동 전환과 같은 switch_active_provider_account 경로를 재사용한다.
pub fn spawn_auto_switch_loop(
    chats: ChatSupervisor,
    terminals: TerminalSupervisor,
    signals: Receiver<AutoSwitchSignal>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while let Ok(signal) = signals.recv() {
            if let Err(error) = handle_auto_switch_signal(&chats, &terminals, &signal) {
                eprintln!(
                    "[auto-switch] {} 계정 자동전환 실패: {error}",
                    signal.provider.as_str()
                );
            }
        }
    })
}

fn handle_auto_switch_signal(
    chats: &ChatSupervisor,
    terminals: &TerminalSupervisor,
    signal: &AutoSwitchSignal,
) -> Result<(), CoreError> {
    let accounts = chats
        .accounts()
        .ok_or_else(|| CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned()))?;
    let Some(target_account_id) = accounts.plan_auto_switch(signal)? else {
        return Ok(());
    };
    // 전환이 실행 중 채팅을 강제 종료하므로, 세션 복원 옵션이 켜져 있으면 종료
    // 전에 resume 재시작에 필요한 세션 정보를 캡처해 둔다.
    let resumable = if accounts.auto_switch_resume_enabled()? {
        resumable_provider_sessions(chats, signal.provider)?
    } else {
        Vec::new()
    };
    switch_active_provider_account(
        chats,
        terminals,
        SwitchActiveProviderAccountRequest {
            account_id: target_account_id.clone(),
            stop_running_chats: true,
            stop_external_processes: true,
        },
    )?;
    let resumed_session_count = resume_interrupted_sessions(chats, resumable);
    accounts.record_auto_switch(
        signal.provider,
        &signal.account_id,
        &target_account_id,
        signal.reason,
        resumed_session_count,
    );
    Ok(())
}

/// 자동전환으로 종료될, 이어서 재시작할 수 있는 관리 채팅 목록. 스케줄러가
/// 수명주기를 관리하는 unattended 실행과 이미 종료된 채팅은 live_chats에서
/// 제외되며, resume에는 공급자 세션 ID가 필요하다.
fn resumable_provider_sessions(
    chats: &ChatSupervisor,
    provider: ProviderId,
) -> Result<Vec<ChatSessionInfo>, CoreError> {
    Ok(chats
        .live_chats(ChatProfile::Standard)?
        .into_iter()
        .filter(|info| info.source == provider && info.provider_session_id.is_some())
        .collect())
}

/// 전환 직전에 캡처한 세션들을 새 활성 계정에서 resume으로 재시작한다.
/// 실패한 세션은 카탈로그에 남아 있어 수동으로 다시 열 수 있으므로 로그만 남긴다.
fn resume_interrupted_sessions(chats: &ChatSupervisor, sessions: Vec<ChatSessionInfo>) -> usize {
    let mut resumed = 0;
    for info in sessions {
        let session_id = info.provider_session_id.clone();
        let request = ChatStartRequest {
            source: info.source,
            account_id: None,
            cwd: info.cwd,
            model: info.model,
            reasoning_effort: info.reasoning_effort,
            mode: info.mode,
            approval_mode: info.approval_mode,
            resume_session_id: session_id.clone(),
            capture_id: None,
            unattended: false,
            profile: ChatProfile::Standard,
            settings: info.settings,
            account_transition_id: None,
            startup_cancel: None,
        };
        match chats.start(request) {
            Ok(attachment) => {
                // start()가 돌려주는 화면 연결은 즉시 분리해, 다른 detached
                // 런타임처럼 채팅 목록에서 다시 연결하도록 둔다.
                let chat_id = attachment.info.chat_id.clone();
                drop(attachment);
                let _ = chats.detach(&chat_id);
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
        let path = app_data_dir.join(IDEMPOTENCY_FILE);
        if !path.is_file() {
            return Err(CoreError::NotFound(
                "해당 멱등 키의 채팅 전달 기록을 찾을 수 없습니다".to_owned(),
            ));
        }
        let store: IdempotencyStore = serde_json::from_slice(&fs::read(path)?)?;
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
    validate_operation_name(operation)?;
    fs::create_dir_all(app_data_dir)?;
    let lock_file = open_lock(&app_data_dir.join(AUDIT_LOCK_FILE))?;
    FileExt::lock(&lock_file)?;
    let record = SystemAuditRecord {
        id: format!("audit-{}", Uuid::new_v4()),
        timestamp: now_ms(),
        actor: "aia".to_owned(),
        operation: operation.to_owned(),
        arguments_sha256: fingerprint(arguments)?,
        approved: true,
        phase,
        success,
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
    let fingerprint = fingerprint(&json!({
        "operation": request.operation,
        "success": request.success,
        "from": request.from,
        "to": request.to,
        "limit": limit,
    }))?;
    let offset = cursor_offset(request.cursor.as_deref(), "system-audit", &fingerprint)?;
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
    let total = items.len();
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(items.len());
    let next_cursor = (next_offset < total)
        .then(|| encode_cursor("system-audit", &fingerprint, next_offset))
        .transpose()?;
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
        title: format!("{} 라이브 채팅", provider_name(chat.source)),
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

fn session_matches(
    item: &ManagedSessionSummary,
    filters: &SessionAppliedFilters,
    canonical_cwd: Option<&Path>,
) -> bool {
    filters.source.is_none_or(|source| item.source == source)
        && canonical_cwd.is_none_or(|cwd| {
            item.cwd
                .as_deref()
                .is_some_and(|item_cwd| same_cwd(item_cwd, cwd))
        })
        && filters.from.is_none_or(|from| session_time(item) >= from)
        && filters.to.is_none_or(|to| session_time(item) <= to)
        && filters.status.is_none_or(|status| item.status == status)
        && filters.search.as_deref().is_none_or(|needle| {
            searchable(&[
                &item.session_id,
                &item.title,
                item.project.as_deref().unwrap_or(""),
                item.cwd.as_deref().unwrap_or(""),
                provider_name(item.source),
            ])
            .contains(needle)
        })
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
        | ContentBlock::Context { text, .. } => Some(text),
        ContentBlock::ToolUse { input_json, .. } => Some(input_json),
        ContentBlock::Raw { json } => Some(json),
        ContentBlock::SessionInfo(_) => None,
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
    }
}

fn block_payload_len(block: &ContentBlock) -> usize {
    match block {
        ContentBlock::Text { text }
        | ContentBlock::Thinking { text }
        | ContentBlock::ToolResult { text, .. }
        | ContentBlock::Context { text, .. } => text.len(),
        ContentBlock::ToolUse { input_json, .. } => input_json.len(),
        ContentBlock::Raw { json } => json.len(),
        ContentBlock::SessionInfo(info) => info.raw_json.len(),
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
        cwd: input.cwd,
        enabled: input.enabled,
        frequency: input.recurrence.frequency,
        session_strategy: input.session_strategy,
        provider_session_id: input.provider_session_id,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
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
        let mut store = if path.is_file() {
            serde_json::from_slice::<IdempotencyStore>(&fs::read(&path)?)?
        } else {
            IdempotencyStore::default()
        };
        let result = update(&mut store)?;
        atomic_write_json(app_data_dir, &path, &store)?;
        Ok(result)
    })();
    let _ = FileExt::unlock(&lock_file);
    result
}

fn atomic_write_json<T: Serialize>(
    directory: &Path,
    path: &Path,
    value: &T,
) -> Result<(), CoreError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CoreError::InvalidInput("저장 파일 경로가 올바르지 않습니다".to_owned()))?;
    let temporary = directory.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
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

fn normalized_search(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
}

fn searchable(values: &[&str]) -> String {
    values.join("\n").to_lowercase()
}

fn provider_name(source: ProviderId) -> &'static str {
    match source {
        ProviderId::Codex => "codex",
        ProviderId::Claude => "claude",
        ProviderId::Antigravity => "antigravity",
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    let text = text.to_lowercase();
    needles.iter().any(|needle| text.contains(needle))
}

fn truncate_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let suffix = "\n…[truncated]";
    let mut end = max_bytes.saturating_sub(suffix.len());
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}{}", &value[..end], suffix)
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_switch_cleanup_cannot_be_disabled_by_legacy_flags() {
        let request: SwitchActiveProviderAccountRequest = serde_json::from_value(json!({
            "accountId": "account-1",
            "stopRunningChats": false,
            "stopExternalProcesses": false
        }))
        .expect("switch request");

        assert_eq!(
            request.enforced_cleanup_policy(),
            SwitchCleanupPolicy {
                stop_managed_runtimes: true,
                stop_external_processes: true,
            }
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
}
