use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use fs4::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::app_data_file::{read_private_json_or_default, write_private_json};
use crate::clock::now_ms;
use crate::domain::{ChatOrigin, ChatOriginKind};
use crate::quiet_hours::QuietSchedule;
use crate::session_context::{
    reconcile_settings, resolve_run_session_read, ScheduleRunSessionRead, SessionReadActor,
    SessionReadSettings,
};
use crate::store::{self, SupplementOrigin};
use crate::system_workflows::WorkflowTrigger;
use crate::{
    AccountSupervisor, ChatApprovalMode, ChatAttachment, ChatEvent, ChatMode, ChatPhase,
    ChatProfile, ChatStartRequest, ChatSupervisor, CoreError, ProviderId, ReasoningEffort,
    RunReadiness,
};

const STORE_FILE_NAME: &str = "scheduled-requests-v2.json";
const STORE_LOCK_FILE: &str = "scheduled-requests-v2.lock";
const RUNNER_LOCK_FILE: &str = "scheduler-runner.lock";
const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_RUNS_PER_SCHEDULE: usize = 50;
const TICK_INTERVAL: Duration = Duration::from_secs(15);
const WAKE_GAP_MS: i64 = 90_000;
const MAX_PROVIDER_STARTUP_DURATION: Duration = Duration::from_secs(5 * 60);
const MAX_RUN_DURATION: Duration = Duration::from_secs(6 * 60 * 60);
const RUN_LEASE_EXPIRY: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleFrequency {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
    Cron,
    /// 시스템이 정한 간격으로 돈다. 간격은 사용량 예산 정책의 가드 창 길이(없으면
    /// 5시간)이고, 벽시계 정렬 없이 지금부터 그 간격 뒤가 다음 실행이다. 페이싱 회차가
    /// 짧은 창마다 정확히 한 번 돌게 하는 용도라 `interval`·`hour`·`minute`은 쓰지 않는다.
    Auto,
}

impl ScheduleFrequency {
    #[cfg(test)]
    pub const ALL: [Self; 6] = [
        Self::Hourly,
        Self::Daily,
        Self::Weekdays,
        Self::Weekly,
        Self::Cron,
        Self::Auto,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hourly => "hourly",
            Self::Daily => "daily",
            Self::Weekdays => "weekdays",
            Self::Weekly => "weekly",
            Self::Cron => "cron",
            Self::Auto => "auto",
        }
    }
}

impl std::fmt::Display for ScheduleFrequency {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ScheduleFrequency {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "hourly" => Ok(Self::Hourly),
            "daily" => Ok(Self::Daily),
            "weekdays" => Ok(Self::Weekdays),
            "weekly" => Ok(Self::Weekly),
            "cron" => Ok(Self::Cron),
            "auto" => Ok(Self::Auto),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 스케줄 주기입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecurrence {
    pub frequency: ScheduleFrequency,
    #[serde(default = "default_interval")]
    pub interval: u32,
    #[serde(default)]
    pub hour: u8,
    #[serde(default)]
    pub minute: u8,
    #[serde(default = "default_weekday")]
    pub weekday: u8,
    #[serde(default)]
    pub cron: Option<String>,
    pub timezone: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleSessionStrategy {
    NewChat,
    Continue,
}

impl ScheduleSessionStrategy {
    #[cfg(test)]
    pub const ALL: [Self; 2] = [Self::NewChat, Self::Continue];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewChat => "newChat",
            Self::Continue => "continue",
        }
    }
}

impl std::fmt::Display for ScheduleSessionStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ScheduleSessionStrategy {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "newChat" => Ok(Self::NewChat),
            "continue" => Ok(Self::Continue),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 스케줄 세션 방식입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResumeFailurePolicy {
    Pause,
    NewChat,
    RetryThenNewChat,
}

impl ResumeFailurePolicy {
    #[cfg(test)]
    pub const ALL: [Self; 3] = [Self::Pause, Self::NewChat, Self::RetryThenNewChat];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pause => "pause",
            Self::NewChat => "newChat",
            Self::RetryThenNewChat => "retryThenNewChat",
        }
    }
}

impl std::fmt::Display for ResumeFailurePolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ResumeFailurePolicy {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "pause" => Ok(Self::Pause),
            "newChat" => Ok(Self::NewChat),
            "retryThenNewChat" => Ok(Self::RetryThenNewChat),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 세션 재개 실패 정책입니다: {s}"
            ))),
        }
    }
}

/// 반복 실행이 공급자 채팅 대신 등록된 시스템 워크플로를 돌릴 때의 대상. 문서 트리거와
/// 같은 규칙으로 승인 버전을 함께 고정해, 워크플로가 바뀌면 다시 승인받기 전까지
/// 실행하지 않는다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleWorkflowAction {
    pub workflow_id: String,
    pub approved_version: u32,
    #[serde(default = "empty_workflow_arguments")]
    pub arguments: Value,
    /// 페이싱 회차 설정. 페이싱 회차 계약(`paced`)을 도는 반복 요청만 쓰고, 계약 입력이
    /// 아니라 이 반복 요청이 소유한다. 없으면 병렬 실행 없이 한 건씩 돈다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pacing: Option<SchedulePacing>,
}

/// 회차 하나의 페이싱 설정.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePacing {
    /// 한 회차에 동시에 띄울 최대 건수(병렬 실행). 1이면 한 건씩 돈다. 상한은 없다 — 실제
    /// 동시 건수는 계획이 계정 여력·가드 창으로 자른다.
    #[serde(default = "default_max_runs")]
    pub max_runs: u32,
}

/// 병렬 실행 설정이 없을 때의 건수. 수동·AIA 실행과 같은 "한 건씩"이다.
pub(crate) const DEFAULT_MAX_RUNS: u32 = 1;

fn default_max_runs() -> u32 {
    DEFAULT_MAX_RUNS
}

impl ScheduleWorkflowAction {
    /// 회차 봉투에 넘길 병렬 실행 건수. 설정이 없으면 1.
    pub fn max_runs(&self) -> u32 {
        self.pacing
            .as_ref()
            .map_or(DEFAULT_MAX_RUNS, |pacing| pacing.max_runs)
    }
}

fn empty_workflow_arguments() -> Value {
    json!({})
}

/// 반복 실행이 시스템 워크플로를 돌릴 때 쓰는 통로. 워크플로 단계는 등록된 기본 작업
/// 호출로만 표현되고 그 호출을 처리하는 문맥(카탈로그·채팅·터미널·번역 계층)은 백엔드
/// 상태가 들고 있으므로, 스케줄러는 검증과 실행을 이 통로에 맡기고 결과만 기록한다.
pub trait ScheduleWorkflowExecutor: Send + Sync + 'static {
    /// 저장 시점과 실행 시점에 모두 부른다. 승인 버전이 현재 등록 버전과 같고 지금
    /// 카탈로그와 호환되는지 확인한다.
    fn validate_workflow(&self, action: &ScheduleWorkflowAction) -> Result<(), CoreError>;

    /// 한 회차를 실행한다. 끊긴 회차가 다시 시도돼도 중복 실행되지 않게 회차마다
    /// 고정된 멱등 키를 받는다.
    fn execute_workflow(
        &self,
        action: &ScheduleWorkflowAction,
        idempotency_key: &str,
        trigger: &WorkflowTrigger,
        manual_run: bool,
    ) -> Result<Value, CoreError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRequestInput {
    pub name: String,
    pub prompt: String,
    pub source: ProviderId,
    pub account_id: String,
    /// 계정을 고정하지 않고 실행 시점에 활성인 계정으로 돌린다. 켜면 `account_id`는
    /// 비어 있고, 매 실행마다 그때의 활성 계정을 다시 읽는다.
    #[serde(default)]
    pub use_active_account: bool,
    pub cwd: String,
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    pub mode: ChatMode,
    #[serde(default = "default_schedule_approval_mode")]
    pub approval_mode: ChatApprovalMode,
    pub recurrence: ScheduleRecurrence,
    pub session_strategy: ScheduleSessionStrategy,
    pub resume_failure_policy: ResumeFailurePolicy,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 이 반복 실행이 다른 에이전트 세션을 얼마나 읽을 수 있는지. 없으면 세션 참조를
    /// 쓰지 않는다. 필드를 모르던 예전 저장본은 그대로 `None`이 되어 지금 동작이 바뀌지
    /// 않고, 이 필드를 보내지 않는 클라이언트가 다른 항목만 고쳐도 정책이 사라지지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_reference: Option<SessionReadSettings>,
    /// AIA가 사용자가 직접 지정한 세션 참조 정책을 대신 바꾸려면 이 요청 플래그를 명시해야
    /// 한다. 요청에만 있고 저장되지 않는다.
    #[serde(default, skip_serializing)]
    pub session_reference_replace_manual: bool,
    /// 채팅 대신 등록된 시스템 워크플로를 돌리는 반복 요청. 없으면 지금까지처럼 공급자
    /// 채팅에 프롬프트를 보낸다. 필드를 모르던 예전 저장본은 그대로 `None`이 되어 동작이
    /// 바뀌지 않고, 값이 없는 저장본은 이 필드가 없던 때와 바이트까지 같다.
    ///
    /// 채팅 실행에만 쓰이는 값(프롬프트·계정·작업 경로·모델·세션 참조)은 워크플로 반복
    /// 요청에서 저장 시점에 비워진다. 실행에 쓰이지 않는 값을 남겨 두면 화면과 AIA가
    /// 어느 쪽이 실제로 도는지 저장본만 보고 알 수 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<ScheduleWorkflowAction>,
    /// 이 반복 요청이 예약 실행을 시작하는 절대 시각(epoch ms). 없으면 시작 제한이
    /// 없다. 이 시각 이전의 발화는 건너뛰므로 창이 열릴 때 밀린 회차가 몰아서 나가지
    /// 않는다. 값이 없는 저장본은 이 필드가 없던 때와 바이트까지 같다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_from: Option<i64>,
    /// 이 반복 요청이 예약 실행을 끝내는 절대 시각(epoch ms). 없으면 종료 제한이
    /// 없다. 이 시각을 지나면 더 이상 claim하지 않지만 `enabled`는 건드리지 않는다 —
    /// 사용자가 종료 시각을 뒤로 미루면 그대로 다시 돈다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRequest {
    pub id: String,
    #[serde(flatten)]
    pub input: ScheduledRequestInput,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_run_at: i64,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub manual_run_requested_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleRunStatus {
    WaitingForAccount,
    /// 실행 계정의 사용량이 소진돼 복구될 때까지 이 회차를 멈춰 둔 상태. 계정 준비
    /// 대기와 달리 사용자가 할 수 있는 일이 없고 리셋 시각을 기다리면 되므로,
    /// 실패로 확정하지 않고 따로 표시한다.
    WaitingForUsage,
    Running,
    Completed,
    Failed,
    Skipped,
    Cancelled,
}

impl ScheduleRunStatus {
    #[cfg(test)]
    pub const ALL: [Self; 7] = [
        Self::WaitingForAccount,
        Self::WaitingForUsage,
        Self::Running,
        Self::Completed,
        Self::Failed,
        Self::Skipped,
        Self::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::WaitingForAccount => "waitingForAccount",
            Self::WaitingForUsage => "waitingForUsage",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }

    /// 다음 틱에서 같은 회차를 이어서 다시 시도하는 상태인지. 대기 사유가 늘어날 때
    /// 재개 경로를 한 군데에서만 고치도록 여기에 모아 둔다.
    pub fn is_waiting(self) -> bool {
        matches!(self, Self::WaitingForAccount | Self::WaitingForUsage)
    }

    /// 최종 종료 상태인지 확인합니다.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Skipped | Self::Cancelled
        )
    }
}

impl std::fmt::Display for ScheduleRunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ScheduleRunStatus {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "waitingForAccount" => Ok(Self::WaitingForAccount),
            "waitingForUsage" => Ok(Self::WaitingForUsage),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "skipped" => Ok(Self::Skipped),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 스케줄 실행 상태입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub id: String,
    pub schedule_id: String,
    pub scheduled_for: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub status: ScheduleRunStatus,
    pub requested_account_id: String,
    pub actual_account_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub previous_provider_session_id: Option<String>,
    pub session_replaced: bool,
    pub retry_count: u8,
    pub summary: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub last_heartbeat_at: Option<i64>,
    #[serde(default)]
    pub cancellation_requested_at: Option<i64>,
    #[serde(default)]
    pub recovery_error: Option<String>,
    /// 사용자가 카드에서 직접 누른 실행. 전체 일시정지는 예약 실행만 멈추므로,
    /// 계정을 기다리는 실행도 이 표시가 있으면 일시정지 중에 계속 이어간다.
    #[serde(default)]
    pub manual: bool,
    /// 문서 변경 트리거가 시작한 실행이면 원본 이벤트를 비밀값 없이 식별한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_trigger: Option<ScheduledDocumentTriggerContext>,
    /// 이 실행에 붙은 세션 참조 결과. 확정된 구간과 부분 보고 사유, 실제 사용량이 남는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_reference: Option<ScheduleRunSessionRead>,
    /// 페이싱 회차 봉투가 이 실행에서 실제로 무엇을 했는지. 회차는 기동이 0건이어도
    /// 성공이므로 `status`만으로는 일한 회차와 쉰 회차를 가릴 수 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<ScheduleRunRound>,
}

/// 페이싱 회차 한 번의 집계. 봉투 접수증의 `round`를 그대로 옮긴다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunRound {
    /// 예산이 이번 회차에 배정한 건수.
    pub planned_runs: u32,
    /// 실제로 띄운 건수. 0이면 쉰 회차다.
    pub launched_runs: u32,
    /// 지난 회차에서 남아 정리한 런타임 수.
    pub stale_runs: u32,
    /// 이 회차의 병렬 상한.
    pub max_runs: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledDocumentTriggerContext {
    pub trigger_id: String,
    pub event_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunCancellationReceipt {
    pub run: ScheduleRun,
    pub already_terminal: bool,
    pub owner_was_active: bool,
    pub stop_attempted: bool,
    pub stop_error: Option<String>,
    pub stale_reasons: Vec<String>,
}

/// 경량 스냅샷에 담는 본문 미리보기 상한. 카드 한 줄과 접힌 실행 이력 요약을
/// 채우기에 충분하고, 24건을 담아도 폴링 페이로드가 수 KB에 머문다.
const PREVIEW_BYTES: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerSnapshot {
    pub paused: bool,
    pub runner_active: bool,
    pub schedules: Vec<ScheduledRequest>,
    pub runs: Vec<ScheduleRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SchedulerEvent {
    Completed {
        schedule: ScheduledRequest,
        run: ScheduleRun,
    },
    Failed {
        schedule: ScheduledRequest,
        run: ScheduleRun,
    },
    SessionReplaced {
        schedule: ScheduledRequest,
        run: ScheduleRun,
    },
    Paused {
        schedule: ScheduledRequest,
        run: ScheduleRun,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerStore {
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    schedules: Vec<ScheduledRequest>,
    #[serde(default)]
    runs: Vec<ScheduleRun>,
    #[serde(default)]
    pending_document_runs: Vec<PendingDocumentRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingDocumentRun {
    schedule_id: String,
    requested_at: i64,
    context: ScheduledDocumentTriggerContext,
}

pub struct SchedulerAttachment {
    pub events: Receiver<SchedulerEvent>,
}

#[derive(Clone)]
pub struct SchedulerSupervisor {
    inner: Arc<SchedulerInner>,
}

/// 스케줄러를 강하게 붙잡지 않고 다시 얻는 손잡이. 워크플로 실행 통로는 스케줄러가
/// 들고 있고, 그 통로는 작업 호출 문맥에 스케줄러를 다시 넣어야 하므로, 강한 참조로
/// 이으면 서로를 살려 두는 고리가 된다.
#[derive(Clone)]
pub struct SchedulerHandle {
    inner: Weak<SchedulerInner>,
}

impl SchedulerHandle {
    pub fn upgrade(&self) -> Option<SchedulerSupervisor> {
        self.inner
            .upgrade()
            .map(|inner| SchedulerSupervisor { inner })
    }
}

struct SchedulerInner {
    app_data_dir: PathBuf,
    chats: ChatSupervisor,
    accounts: Option<AccountSupervisor>,
    stop: AtomicBool,
    runner_active: bool,
    _runner_lock: Option<File>,
    running: Mutex<HashSet<String>>,
    executions: Mutex<HashMap<String, Arc<ActiveRunControl>>>,
    subscriber: Mutex<Option<SyncSender<SchedulerEvent>>>,
    /// 워크플로 반복 요청의 검증·실행 통로. 백엔드가 모든 계층을 만든 뒤 연결한다.
    workflows: Mutex<Option<Arc<dyn ScheduleWorkflowExecutor>>>,
}

impl SchedulerInner {
    fn workflow_executor(&self) -> Option<Arc<dyn ScheduleWorkflowExecutor>> {
        self.workflows.lock().ok()?.clone()
    }
}

#[derive(Default)]
struct ActiveRunControl {
    cancelled: Arc<AtomicBool>,
    chat_id: Mutex<Option<String>>,
    last_heartbeat_at: AtomicI64,
}

impl SchedulerSupervisor {
    pub fn new(app_data_dir: PathBuf, chats: ChatSupervisor) -> Result<Self, CoreError> {
        Self::new_with_background_runner(app_data_dir, chats, true)
    }

    fn new_with_background_runner(
        app_data_dir: PathBuf,
        chats: ChatSupervisor,
        start_background_runner: bool,
    ) -> Result<Self, CoreError> {
        fs::create_dir_all(&app_data_dir)?;
        backfill_completed_summaries(&app_data_dir)?;
        backfill_scheduled_session_working_directories(&app_data_dir)?;
        let runner_lock = open_lock(&app_data_dir.join(RUNNER_LOCK_FILE))?;
        let runner_lock = match FileExt::try_lock(&runner_lock) {
            Ok(()) => Some(runner_lock),
            Err(fs4::TryLockError::WouldBlock) => None,
            Err(error) => {
                return Err(CoreError::Runtime(format!(
                    "반복 요청 실행 잠금을 만들지 못했습니다: {error}"
                )))
            }
        };
        let runner_active = runner_lock.is_some();
        if runner_active {
            reconcile_interrupted_runs(&app_data_dir)?;
        }
        let inner = Arc::new(SchedulerInner {
            app_data_dir,
            accounts: chats.accounts(),
            chats,
            stop: AtomicBool::new(false),
            runner_active,
            _runner_lock: runner_lock,
            running: Mutex::new(HashSet::new()),
            executions: Mutex::new(HashMap::new()),
            subscriber: Mutex::new(None),
            workflows: Mutex::new(None),
        });
        if runner_active && start_background_runner {
            spawn_scheduler_loop(Arc::downgrade(&inner));
        }
        Ok(Self { inner })
    }

    #[cfg(test)]
    fn new_without_background_runner(
        app_data_dir: PathBuf,
        chats: ChatSupervisor,
    ) -> Result<Self, CoreError> {
        Self::new_with_background_runner(app_data_dir, chats, false)
    }

    /// 주기 폴링용 경량 스냅샷. 목록 렌더에 필요 없는 본문(요청 프롬프트, 실행 요약)은
    /// 미리보기로 자른다. 전문은 `get_scheduled_request_detail`,
    /// `get_scheduled_run_detail`로 항목을 열 때만 받는다.
    pub fn preview_snapshot(&self) -> Result<SchedulerSnapshot, CoreError> {
        let mut snapshot = self.snapshot()?;
        for schedule in &mut snapshot.schedules {
            schedule.input.prompt =
                crate::session_management::truncate_text(&schedule.input.prompt, PREVIEW_BYTES);
        }
        for run in &mut snapshot.runs {
            run.summary = run
                .summary
                .as_deref()
                .map(|summary| crate::session_management::truncate_text(summary, PREVIEW_BYTES));
        }
        Ok(snapshot)
    }

    pub fn snapshot(&self) -> Result<SchedulerSnapshot, CoreError> {
        let store = read_store(&self.inner.app_data_dir)?;
        Ok(SchedulerSnapshot {
            paused: store.paused,
            runner_active: self.inner.runner_active,
            schedules: sorted_schedules(store.schedules),
            runs: sorted_runs(store.runs),
        })
    }

    pub fn create(
        &self,
        input: ScheduledRequestInput,
        actor: SessionReadActor,
    ) -> Result<ScheduledRequest, CoreError> {
        let mut input = validate_input(input)?;
        self.validate_account(&input)?;
        self.validate_workflow(&input)?;
        input.session_reference = reconcile_settings(
            None,
            input.session_reference.take(),
            actor,
            input.session_reference_replace_manual,
        )?;
        self.validate_session_reference(&input)?;
        drop_unused_session_reference(&mut input);
        let now = now_ms();
        // 해석기는 락 밖에서 읽고(ABBA 교착 방지), 간격은 락 안에서 일시정지 목록을 보며 정한다.
        let auto = auto_cadence(&self.inner.app_data_dir);
        let app_data_dir = self.inner.app_data_dir.clone();
        with_store(&self.inner.app_data_dir, |store| {
            if input.enabled {
                if let Some(action) = input.workflow.as_ref() {
                    ensure_single_active_paced_round(
                        &app_data_dir,
                        &store.schedules,
                        &action.workflow_id,
                        None,
                    )?;
                }
            }
            // 창을 나눠 쓸 회차 수에 이 새 회차 자신도 든다. id를 먼저 정해 그 사실을
            // 간격 계산에 알린다 — 저장본에는 아직 없어 목록만 봐서는 셀 수 없다.
            let id = format!("schedule-{}", Uuid::new_v4());
            let auto_minutes = auto.minutes_for(
                auto_workflow_id(&input),
                &store.schedules,
                Some((&id, &input)),
                now,
            );
            let next_run_at =
                next_run_in_window(&input, now, auto_minutes, auto.round_quiet(&input))?;
            let schedule = ScheduledRequest {
                id,
                input,
                created_at: now,
                updated_at: now,
                next_run_at,
                last_run_at: None,
                manual_run_requested_at: None,
            };
            store.schedules.push(schedule.clone());
            Ok(schedule)
        })
    }

    pub fn update(
        &self,
        id: &str,
        input: ScheduledRequestInput,
        actor: SessionReadActor,
    ) -> Result<ScheduledRequest, CoreError> {
        let mut input = validate_input(input)?;
        self.validate_account(&input)?;
        self.validate_workflow(&input)?;
        let stored = self.stored_session_reference(id)?;
        input.session_reference = reconcile_settings(
            stored.as_ref(),
            input.session_reference.take(),
            actor,
            input.session_reference_replace_manual,
        )?;
        self.validate_session_reference(&input)?;
        drop_unused_session_reference(&mut input);
        let now = now_ms();
        // 해석기는 락 밖에서 읽고(ABBA 교착 방지), 간격은 락 안에서 일시정지 목록을 보며 정한다.
        let auto = auto_cadence(&self.inner.app_data_dir);
        let app_data_dir = self.inner.app_data_dir.clone();
        with_store(&self.inner.app_data_dir, |store| {
            if input.enabled {
                if let Some(action) = input.workflow.as_ref() {
                    ensure_single_active_paced_round(
                        &app_data_dir,
                        &store.schedules,
                        &action.workflow_id,
                        Some(id),
                    )?;
                }
            }
            // 이 요청 자신은 저장본이 아니라 저장되는 상태(input.enabled)로 센다.
            let auto_minutes = auto.minutes_for(
                auto_workflow_id(&input),
                &store.schedules,
                Some((id, &input)),
                now,
            );
            let next_run_at =
                next_run_in_window(&input, now, auto_minutes, auto.round_quiet(&input))?;
            let schedule = store
                .schedules
                .iter_mut()
                .find(|schedule| schedule.id == id)
                .ok_or_else(|| CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned()))?;
            schedule.input = input;
            schedule.updated_at = now;
            schedule.next_run_at = next_run_at;
            Ok(schedule.clone())
        })
    }

    fn stored_session_reference(&self, id: &str) -> Result<Option<SessionReadSettings>, CoreError> {
        let store = read_store(&self.inner.app_data_dir)?;
        Ok(store
            .schedules
            .iter()
            .find(|schedule| schedule.id == id)
            .and_then(|schedule| schedule.input.session_reference.clone()))
    }

    /// 저장 시점에도 등록 프로젝트 소속을 확인한다. 실행 시점 검증이 최종 관문이지만,
    /// 화면과 AIA가 잘못된 경로를 저장한 채 다음 실행까지 모르는 상태를 만들지 않는다.
    fn validate_session_reference(&self, input: &ScheduledRequestInput) -> Result<(), CoreError> {
        let Some(settings) = input.session_reference.as_ref() else {
            return Ok(());
        };
        if !settings.policy.enabled || settings.policy.projects.is_empty() {
            return Ok(());
        }
        let registered = registered_project_paths(&self.inner.app_data_dir)?;
        for requested in &settings.policy.projects {
            let canonical = fs::canonicalize(requested).map_err(|error| {
                CoreError::InvalidInput(format!(
                    "세션 참조 프로젝트 경로를 열 수 없습니다: {requested} ({error})"
                ))
            })?;
            if !registered.contains(&canonical) {
                return Err(CoreError::InvalidInput(format!(
                    "Agent Manager 등록 프로젝트가 아닙니다: {requested}"
                )));
            }
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), CoreError> {
        with_store(&self.inner.app_data_dir, |store| {
            let previous = store.schedules.len();
            store.schedules.retain(|schedule| schedule.id != id);
            if previous == store.schedules.len() {
                return Err(CoreError::NotFound(
                    "반복 요청을 찾을 수 없습니다".to_owned(),
                ));
            }
            store.runs.retain(|run| run.schedule_id != id);
            store
                .pending_document_runs
                .retain(|pending| pending.schedule_id != id);
            Ok(())
        })
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ScheduledRequest, CoreError> {
        let auto = auto_cadence(&self.inner.app_data_dir);
        let app_data_dir = self.inner.app_data_dir.clone();
        with_store(&self.inner.app_data_dir, |store| {
            let now = now_ms();
            if enabled {
                let workflow_id = store
                    .schedules
                    .iter()
                    .find(|schedule| schedule.id == id)
                    .and_then(|schedule| schedule.input.workflow.as_ref())
                    .map(|action| action.workflow_id.clone());
                if let Some(workflow_id) = workflow_id {
                    ensure_single_active_paced_round(
                        &app_data_dir,
                        &store.schedules,
                        &workflow_id,
                        Some(id),
                    )?;
                }
            }
            // 켜고 끄는 요청 자신은 저장본이 아직 옛 상태다. 활성 창·계정 범위까지 새 입력으로
            // 계산해야 다른 회차의 몫과 이 회차의 다음 실행이 같은 설정을 본다.
            let mut pending_input = store
                .schedules
                .iter()
                .find(|schedule| schedule.id == id)
                .map(|schedule| schedule.input.clone())
                .ok_or_else(|| CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned()))?;
            pending_input.enabled = enabled;
            let enabled_auto_minutes = enabled.then(|| {
                auto.minutes_for(
                    auto_workflow_id(&pending_input),
                    &store.schedules,
                    Some((id, &pending_input)),
                    now,
                )
            });
            let updated = {
                let schedule = store
                    .schedules
                    .iter_mut()
                    .find(|schedule| schedule.id == id)
                    .ok_or_else(|| {
                        CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned())
                    })?;
                schedule.input.enabled = enabled;
                schedule.updated_at = now;
                if let Some(auto_minutes) = enabled_auto_minutes {
                    schedule.next_run_at = next_run_in_window(
                        &schedule.input,
                        now,
                        auto_minutes,
                        auto.round_quiet(&schedule.input),
                    )?;
                } else {
                    schedule.manual_run_requested_at = None;
                }
                schedule.clone()
            };
            if !enabled {
                store
                    .pending_document_runs
                    .retain(|pending| pending.schedule_id != id);
                for run in store
                    .runs
                    .iter_mut()
                    .filter(|run| run.schedule_id == id && run.status.is_waiting())
                {
                    run.status = ScheduleRunStatus::Skipped;
                    run.finished_at = Some(now);
                    run.error =
                        Some("반복 요청이 비활성화되어 대기 실행을 취소했습니다".to_owned());
                }
            }
            Ok(updated)
        })
    }

    pub fn set_paused(&self, paused: bool) -> Result<SchedulerSnapshot, CoreError> {
        with_store(&self.inner.app_data_dir, |store| {
            store.paused = paused;
            Ok(())
        })?;
        self.snapshot()
    }

    /// 예산 목표·계정 범위·참여 회차가 바뀐 직후 켜진 Auto 워크플로 회차의 다음 시각을
    /// 새 정책으로 다시 잡는다. 페이싱을 끈 워크플로도 기본 간격으로 돌아와야 하므로 Auto
    /// 워크플로 전체를 본다. 다음 만기 때까지 옛 간격을 유지하면 화면은 10분이라면서 실제
    /// 첫 회차는 몇 시간 뒤에 도는 불일치가 생긴다.
    pub(crate) fn refresh_paced_auto_cadence(&self) -> Result<usize, CoreError> {
        // 정책과 페이싱 저장소는 스케줄러 락 밖에서 읽어 락 순서를 지킨다.
        let auto = auto_cadence(&self.inner.app_data_dir);
        let now = now_ms();
        with_store(&self.inner.app_data_dir, |store| {
            let snapshot = store.schedules.clone();
            let updates: Result<Vec<(String, i64)>, CoreError> = snapshot
                .iter()
                .filter(|schedule| {
                    schedule.input.enabled
                        && schedule.input.recurrence.frequency == ScheduleFrequency::Auto
                        && schedule.input.workflow.is_some()
                })
                .map(|schedule| {
                    let minutes =
                        auto.minutes_for(auto_workflow_id(&schedule.input), &snapshot, None, now);
                    let recalculated = next_run_in_window(
                        &schedule.input,
                        now,
                        minutes,
                        auto.round_quiet(&schedule.input),
                    )?;
                    // 이미 기다린 시간은 버리지 않는다. 새 간격이 짧아졌을 때만 앞당기고,
                    // 길어졌다면 현재 한 회차를 그대로 둔 뒤 다음 claim부터 새 간격을 쓴다.
                    // 다만 새 활성 시작·제한 시간대는 즉시 지켜야 하므로 기존 시각도 그 경계
                    // 밖으로 정규화한다.
                    // 이미 만기였다면 과거 시각을 다시 저장하지 않고 지금 즉시 실행 가능한
                    // 상태로 둔다. 제한 시간대라면 아래 정규화가 그 재개 시각으로 보낸다.
                    let mut existing = schedule.next_run_at.max(now);
                    if let Some(from) = schedule.input.active_from {
                        existing = existing.max(from);
                    }
                    if let Some(quiet) = auto.round_quiet(&schedule.input) {
                        existing = quiet.resume_at(existing);
                    }
                    Ok((schedule.id.clone(), existing.min(recalculated)))
                })
                .collect();
            let updates = updates?;
            for (id, next_run_at) in &updates {
                if let Some(schedule) = store.schedules.iter_mut().find(|item| item.id == *id) {
                    schedule.next_run_at = *next_run_at;
                }
            }
            Ok(updates.len())
        })
    }

    pub fn run_now(&self, id: &str) -> Result<ScheduledRequest, CoreError> {
        with_store(&self.inner.app_data_dir, |store| {
            let schedule = store
                .schedules
                .iter_mut()
                .find(|schedule| schedule.id == id)
                .ok_or_else(|| CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned()))?;
            schedule.manual_run_requested_at = Some(now_ms());
            Ok(schedule.clone())
        })
    }

    pub fn run_now_from_document_trigger(
        &self,
        id: &str,
        context: ScheduledDocumentTriggerContext,
    ) -> Result<ScheduledRequest, CoreError> {
        with_store(&self.inner.app_data_dir, |store| {
            let schedule = store
                .schedules
                .iter()
                .find(|schedule| schedule.id == id)
                .cloned()
                .ok_or_else(|| CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned()))?;
            if !schedule.input.enabled {
                return Err(CoreError::Conflict(
                    "비활성 반복 요청은 문서 트리거로 실행할 수 없습니다".to_owned(),
                ));
            }
            if store.pending_document_runs.iter().any(|pending| {
                pending.schedule_id == id && pending.context.event_id == context.event_id
            }) || store.runs.iter().any(|run| {
                run.schedule_id == id
                    && run
                        .document_trigger
                        .as_ref()
                        .is_some_and(|existing| existing.event_id == context.event_id)
            }) {
                return Ok(schedule);
            }
            store.pending_document_runs.push(PendingDocumentRun {
                schedule_id: id.to_owned(),
                requested_at: now_ms(),
                context,
            });
            Ok(schedule)
        })
    }

    /// run ID의 현재 소유 실행을 먼저 취소하고, 소유 실행이 없다면 heartbeat와
    /// runtimeCount를 검증해 고아 run만 terminal 상태로 영속화한다.
    pub fn cancel_run(
        &self,
        run_id: &str,
        reason: Option<&str>,
    ) -> Result<ScheduledRunCancellationReceipt, CoreError> {
        let reason = normalize_cancel_reason(reason);
        let snapshot = read_store(&self.inner.app_data_dir)?;
        let current = snapshot
            .runs
            .iter()
            .find(|run| run.id == run_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("반복 요청 실행을 찾을 수 없습니다".to_owned()))?;
        if current.status.is_terminal() {
            return Ok(ScheduledRunCancellationReceipt {
                run: current,
                already_terminal: true,
                owner_was_active: false,
                stop_attempted: false,
                stop_error: None,
                stale_reasons: Vec::new(),
            });
        }
        let schedule = snapshot
            .schedules
            .iter()
            .find(|schedule| schedule.id == current.schedule_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned()))?;
        let control = self
            .inner
            .executions
            .lock()
            .map_err(|_| CoreError::Runtime("반복 실행 소유권 잠금이 손상되었습니다".to_owned()))?
            .get(run_id)
            .cloned();
        let owner_was_active = control.is_some();
        let mut stop_attempted = false;
        let mut stop_error = None;
        let mut stale_reasons = stale_run_reasons(&current, now_ms());
        if let Some(control) = control {
            control.cancelled.store(true, Ordering::Release);
            if let Some(chat_id) = control
                .chat_id
                .lock()
                .map_err(|_| CoreError::Runtime("반복 실행 채팅 잠금이 손상되었습니다".to_owned()))?
                .clone()
            {
                stop_attempted = true;
                if let Err(error) = self.inner.chats.stop_managed(&chat_id) {
                    stop_error = Some(error.to_string());
                }
            } else {
                stale_reasons.push("provider startup 이전 구간에서 취소를 요청했습니다".to_owned());
            }
        } else {
            let runtime_count = self
                .inner
                .accounts
                .as_ref()
                .map(|accounts| accounts.provider_runtime_count(schedule.input.source))
                .transpose()?
                .unwrap_or(0);
            if runtime_count > 0 {
                return Err(CoreError::Conflict(format!(
                    "실행 소유권은 없지만 공급자 runtimeCount={runtime_count}이므로 고아 run으로 확정할 수 없습니다"
                )));
            }
            stale_reasons.push("현재 프로세스에 run 실행 소유권이 없습니다".to_owned());
            stale_reasons.push("공급자 runtimeCount=0".to_owned());
        }
        let now = now_ms();
        let saved = with_store(&self.inner.app_data_dir, |store| {
            let run = store
                .runs
                .iter_mut()
                .find(|run| run.id == run_id)
                .ok_or_else(|| {
                    CoreError::NotFound("반복 요청 실행을 찾을 수 없습니다".to_owned())
                })?;
            if !run.status.is_terminal() {
                run.status = ScheduleRunStatus::Cancelled;
                run.finished_at = Some(now);
                run.cancellation_requested_at = Some(now);
                run.last_heartbeat_at = Some(now);
                run.error = Some(reason.clone());
                if let Some(error) = stop_error.as_ref() {
                    run.recovery_error = Some(format!("런타임 종료 확인 실패: {error}"));
                }
            }
            Ok(run.clone())
        })?;
        Ok(ScheduledRunCancellationReceipt {
            run: saved,
            already_terminal: false,
            owner_was_active,
            stop_attempted,
            stop_error,
            stale_reasons,
        })
    }

    pub fn attach(&self) -> Result<SchedulerAttachment, CoreError> {
        let (sender, receiver) = mpsc::sync_channel(64);
        let mut subscriber = self
            .inner
            .subscriber
            .lock()
            .map_err(|_| CoreError::Runtime("스케줄 알림 잠금이 손상되었습니다".to_owned()))?;
        *subscriber = Some(sender);
        Ok(SchedulerAttachment { events: receiver })
    }

    pub fn account_reference_count(&self, account_id: &str) -> Result<usize, CoreError> {
        Ok(read_store(&self.inner.app_data_dir)?
            .schedules
            .iter()
            .filter(|schedule| {
                // 실행 시점 활성 계정을 쓰는 반복 요청은 특정 계정을 붙잡지 않으므로
                // 계정 삭제를 막을 근거가 되지 않는다.
                !schedule.input.use_active_account && schedule.input.account_id == account_id
            })
            .count())
    }

    pub fn handle(&self) -> SchedulerHandle {
        SchedulerHandle {
            inner: Arc::downgrade(&self.inner),
        }
    }

    /// 워크플로 실행 통로를 연결한다. 백엔드가 모든 계층을 만든 뒤 한 번 부른다.
    /// 연결 전에는 워크플로 반복 요청을 저장할 수 없고, 저장본이 있어도 실행하지 않는다.
    pub fn set_workflow_executor(
        &self,
        executor: Arc<dyn ScheduleWorkflowExecutor>,
    ) -> Result<(), CoreError> {
        let mut slot = self.inner.workflows.lock().map_err(|_| {
            CoreError::Runtime("워크플로 실행 통로 잠금이 손상되었습니다".to_owned())
        })?;
        *slot = Some(executor);
        Ok(())
    }

    /// 워크플로 반복 요청은 저장 시점에 승인 버전과 카탈로그 호환성을 확인한다. 검증할
    /// 통로가 없으면 승인되지 않은 계약을 저장하게 되므로 저장 자체를 거절한다.
    fn validate_workflow(&self, input: &ScheduledRequestInput) -> Result<(), CoreError> {
        let Some(action) = input.workflow.as_ref() else {
            return Ok(());
        };
        let Some(executor) = self.inner.workflow_executor() else {
            return Err(CoreError::Runtime(
                "워크플로 실행 계층을 사용할 수 없어 워크플로 반복 요청을 저장할 수 없습니다"
                    .to_owned(),
            ));
        };
        executor.validate_workflow(action)
    }

    fn validate_account(&self, input: &ScheduledRequestInput) -> Result<(), CoreError> {
        if input.workflow.is_some() {
            // 워크플로 실행은 공급자 CLI를 띄우지 않아 실행 계정이 없다.
            return Ok(());
        }
        if input.use_active_account {
            // 실행 시점에 활성 계정을 읽으므로 저장 시점에 검증할 계정이 없다.
            // 그때 활성 계정이 없거나 쓸 수 없으면 실행이 대기·실패로 알린다.
            return Ok(());
        }
        if !input.source.manages_accounts() {
            // 계정 레지스트리가 담지 않는 공급자는 검증할 계정 자체가 없다.
            // `validate_input`이 이미 계정 값을 비웠으므로 여기서 조회하면 항상 실패한다.
            return Ok(());
        }
        if let Some(accounts) = &self.inner.accounts {
            if !accounts.account_is_enabled_for_provider(input.source, &input.account_id)? {
                return Err(CoreError::Conflict(
                    "반복 요청의 실행 계정을 사용할 수 없습니다".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

impl Drop for SchedulerInner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn backfill_completed_summaries(app_data_dir: &Path) -> Result<(), CoreError> {
    let scheduled = read_store(app_data_dir)?;
    let sources = scheduled
        .schedules
        .iter()
        .map(|schedule| (schedule.id.as_str(), schedule.input.source))
        .collect::<HashMap<_, _>>();
    for run in scheduled.runs {
        if run.status != ScheduleRunStatus::Completed {
            continue;
        }
        let (Some(source), Some(session_id), Some(summary)) = (
            sources.get(run.schedule_id.as_str()).copied(),
            run.provider_session_id.as_deref(),
            run.summary.filter(|summary| !summary.trim().is_empty()),
        ) else {
            continue;
        };
        store::persist_captured_turn_if_absent(
            app_data_dir,
            source,
            session_id,
            &run.id,
            run.finished_at.unwrap_or(run.scheduled_for),
            summary,
            SupplementOrigin::Scheduled,
        )?;
    }
    Ok(())
}

fn reconcile_interrupted_runs(app_data_dir: &Path) -> Result<(), CoreError> {
    let now = now_ms();
    with_store(app_data_dir, |store| {
        let mut interrupted_schedule_ids = HashSet::new();
        for run in &mut store.runs {
            if run.status != ScheduleRunStatus::Running {
                continue;
            }
            run.status = ScheduleRunStatus::Failed;
            run.finished_at = Some(now);
            run.error =
                Some("이전 Agent Manager 실행이 종료되어 반복 요청이 중단되었습니다".to_owned());
            interrupted_schedule_ids.insert(run.schedule_id.clone());
        }
        for schedule in &mut store.schedules {
            if interrupted_schedule_ids.contains(&schedule.id) {
                schedule.last_run_at = Some(now);
                schedule.updated_at = now;
            }
        }
        Ok(())
    })
}

fn spawn_scheduler_loop(inner: Weak<SchedulerInner>) {
    thread::spawn(move || {
        let mut last_tick = 0_i64;
        loop {
            let Some(inner) = inner.upgrade() else { break };
            if inner.stop.load(Ordering::Relaxed) {
                break;
            }
            let now = now_ms();
            if last_tick == 0 || now.saturating_sub(last_tick) > WAKE_GAP_MS {
                let _ = skip_missed(&inner.app_data_dir, now);
            }
            let _ = reconcile_expired_runs(&inner, now);
            last_tick = now;
            if let Ok(due) = claim_due(&inner, now) {
                for claimed in due {
                    let execution_inner = Arc::clone(&inner);
                    thread::spawn(move || execute_claim(execution_inner, claimed));
                }
            }
            drop(inner);
            thread::sleep(TICK_INTERVAL);
        }
    });
}

#[derive(Clone)]
struct ClaimedRun {
    schedule: ScheduledRequest,
    run: ScheduleRun,
}

fn skip_missed(app_data_dir: &Path, now: i64) -> Result<(), CoreError> {
    let auto = auto_cadence(app_data_dir);
    with_store(app_data_dir, |store| {
        let schedule_snapshot = store.schedules.clone();
        for schedule in &mut store.schedules {
            // 꺼진 페이싱 회차는 건너뛴 발화를 정리하지도 않는다. 여기서 다음 실행을 미래로
            // 밀면 스위치를 다시 켰을 때 만기가 사라져, 껐다 켠 것만으로 한 주기를 통째로
            // 건너뛴다.
            if auto.round_paused(&schedule.input) {
                continue;
            }
            if schedule.input.enabled && schedule.next_run_at <= now {
                let auto_minutes = auto.minutes_for(
                    auto_workflow_id(&schedule.input),
                    &schedule_snapshot,
                    None,
                    now,
                );
                schedule.next_run_at = next_run_in_window(
                    &schedule.input,
                    now,
                    auto_minutes,
                    auto.round_quiet(&schedule.input),
                )?;
            }
        }
        Ok(())
    })
}

/// 전체 일시정지는 예약 실행만 멈춘다. 사용자가 카드에서 직접 누른 실행은
/// 일시정지 중에도 그대로 나가야 하므로, 일시정지일 때는 수동 요청만 claim한다.
fn claim_due(inner: &Arc<SchedulerInner>, now: i64) -> Result<Vec<ClaimedRun>, CoreError> {
    let running = inner
        .running
        .lock()
        .map_err(|_| CoreError::Runtime("반복 요청 실행 잠금이 손상되었습니다".to_owned()))?
        .clone();
    let mut claimed = Vec::new();
    let auto = auto_cadence(&inner.app_data_dir);
    with_store(&inner.app_data_dir, |store| {
        let paused = store.paused;
        let schedule_snapshot = store.schedules.clone();
        let schedules = &mut store.schedules;
        let runs = &mut store.runs;
        let pending_document_runs = &mut store.pending_document_runs;
        for schedule in schedules {
            let manual = schedule.manual_run_requested_at.take();
            let document = pending_document_runs
                .iter()
                .position(|pending| pending.schedule_id == schedule.id)
                .map(|index| pending_document_runs.remove(index));
            // 활성 창 밖에서는 예약 실행을 하지 않는다. 일시정지와 달리 밀린 발화를
            // 쌓아 두지도 않는다 — 창이 열리는 순간 지나간 회차가 몰아서 나가면
            // '오늘 23시까지만'이 다음 날 몰아치기가 된다. 수동 실행은 아래에서
            // 창과 무관하게 그대로 claim한다.
            //
            // 페이싱 회차의 제한 시간대(페이싱 스케줄)는 다르다: 제한 중에 만기가 온 회차는
            // 버리지 않고 **재개 시각으로 미룬다**. 제한은 매일 풀리므로 재개 시각에 한 건만
            // 잡히고, 그 회차가 몇 건을 띄울지는 계획 단계의 직선 판정이 열린 시간 기준으로
            // 정하므로 몰아치기가 되지 않는다.
            let regular_scheduled_for = schedule.next_run_at;
            let regular_due =
                advance_next_run_at(schedule, &schedule_snapshot, &auto, paused, now)?;
            if let Some(waiting) =
                merge_into_waiting_run(runs, &schedule.id, manual, document.as_ref())
            {
                if (!paused || waiting.manual) && !running.contains(&schedule.id) {
                    claimed.push(ClaimedRun {
                        schedule: schedule_for_document_trigger(schedule, document.as_ref()),
                        run: waiting,
                    });
                }
                continue;
            }
            if manual.is_none() && document.is_none() && !regular_due {
                continue;
            }
            let mut run =
                new_scheduled_run(schedule, manual, document.as_ref(), regular_scheduled_for);
            if running.contains(&schedule.id) {
                run.status = ScheduleRunStatus::Skipped;
                run.finished_at = Some(now);
                run.error = Some("이전 실행이 끝나지 않아 건너뛰었습니다".to_owned());
            } else {
                claimed.push(ClaimedRun {
                    schedule: schedule_for_document_trigger(schedule, document.as_ref()),
                    run: run.clone(),
                });
            }
            runs.push(run);
        }
        trim_runs(store);
        Ok(())
    })?;
    if let Ok(mut active) = inner.running.lock() {
        for item in &claimed {
            active.insert(item.schedule.id.clone());
        }
    }
    Ok(claimed)
}

/// 이번 훑기에서 이 스케줄이 정규 발화 대상인지 판정하고, 그 판정에 맞춰 다음 실행 시각을
/// 앞당긴다. 판정과 갱신이 한 덩어리인 것은 둘이 같은 창·제한 계산을 공유하기 때문이다.
fn advance_next_run_at(
    schedule: &mut ScheduledRequest,
    snapshot: &[ScheduledRequest],
    auto: &crate::usage_pacing::AutoCadence,
    paused: bool,
    now: i64,
) -> Result<bool, CoreError> {
    // 페이싱 기능이 꺼져 있으면 페이싱 회차는 발화도 하지 않고 다음 실행 시각도 그대로
    // 둔다. 전체 일시정지와 같은 규칙이다 — 다시 켰을 때 만기가 지난 회차 한 건이 곧바로
    // 잡히고, 그동안 쌓인 발화를 몰아 내보내지 않는다.
    if auto.round_paused(&schedule.input) {
        return Ok(false);
    }
    let window_open = active_window_open(&schedule.input, now);
    let quiet = auto.round_quiet(&schedule.input);
    let quiet_open = quiet.is_none_or(|quiet| !quiet.blocked_at(now));
    let regular_elapsed = schedule.input.enabled && schedule.next_run_at <= now;
    let regular_due = !paused && window_open && quiet_open && regular_elapsed;
    if regular_due || (regular_elapsed && !window_open) {
        let auto_minutes = auto.minutes_for(auto_workflow_id(&schedule.input), snapshot, None, now);
        schedule.next_run_at = next_run_in_window(&schedule.input, now, auto_minutes, quiet)?;
    } else if regular_elapsed && !quiet_open {
        schedule.next_run_at = quiet.map_or(now, |quiet| quiet.resume_at(now));
    } else if let Some(quiet) = quiet {
        // 스케줄을 켠(또는 요일을 더한) 직후 저장된 다음 실행이 제한 안에 남아 있으면
        // 화면의 "다음 실행"이 거짓이 된다. 재개 시각으로 옮겨 둔다.
        if schedule.next_run_at > now && quiet.blocked_at(schedule.next_run_at) {
            schedule.next_run_at = quiet.resume_at(schedule.next_run_at);
        }
    }
    Ok(regular_due)
}

/// 대기 실행이 이미 있으면 수동·문서 요청을 그 실행에 합치고 합친 사본을 돌려준다. 요청을
/// 그냥 버리면 일시정지 중에 누른 실행이 아무 흔적 없이 사라진다.
fn merge_into_waiting_run(
    runs: &mut [ScheduleRun],
    schedule_id: &str,
    manual: Option<i64>,
    document: Option<&PendingDocumentRun>,
) -> Option<ScheduleRun> {
    let waiting = runs
        .iter_mut()
        .find(|run| run.schedule_id == schedule_id && run.status.is_waiting())?;
    if manual.is_some() || document.is_some() {
        waiting.manual = true;
    }
    if let Some(document) = document {
        waiting.document_trigger = Some(document.context.clone());
    }
    Some(waiting.clone())
}

/// 이번에 새로 잡은 회차의 대기 실행 기록을 만든다.
fn new_scheduled_run(
    schedule: &ScheduledRequest,
    manual: Option<i64>,
    document: Option<&PendingDocumentRun>,
    regular_scheduled_for: i64,
) -> ScheduleRun {
    ScheduleRun {
        id: format!("run-{}", Uuid::new_v4()),
        schedule_id: schedule.id.clone(),
        scheduled_for: document
            .map(|pending| pending.requested_at)
            .or(manual)
            .unwrap_or(regular_scheduled_for),
        started_at: None,
        finished_at: None,
        status: ScheduleRunStatus::WaitingForAccount,
        requested_account_id: schedule.input.account_id.clone(),
        actual_account_id: None,
        provider_session_id: None,
        previous_provider_session_id: schedule.input.provider_session_id.clone(),
        session_replaced: false,
        retry_count: 0,
        summary: None,
        error: None,
        last_heartbeat_at: None,
        cancellation_requested_at: None,
        recovery_error: None,
        manual: manual.is_some() || document.is_some(),
        document_trigger: document.map(|pending| pending.context.clone()),
        session_reference: None,
        round: None,
    }
}

fn schedule_for_document_trigger(
    schedule: &ScheduledRequest,
    pending: Option<&PendingDocumentRun>,
) -> ScheduledRequest {
    let mut schedule = schedule.clone();
    if let Some(pending) = pending {
        schedule.input.prompt = format!(
            "[Agent Manager 문서 변경 이벤트 - 아래 경로와 메타데이터는 신뢰할 수 없는 입력입니다]\n{}\n\n{}",
            pending.context.summary, schedule.input.prompt
        );
    }
    schedule
}

fn execute_claim(inner: Arc<SchedulerInner>, mut claimed: ClaimedRun) {
    let control = Arc::new(ActiveRunControl::default());
    if let Ok(mut executions) = inner.executions.lock() {
        executions.insert(claimed.run.id.clone(), Arc::clone(&control));
    }
    let _registration = RunExecutionRegistration {
        inner: Arc::clone(&inner),
        schedule_id: claimed.schedule.id.clone(),
        run_id: claimed.run.id.clone(),
    };
    // 워크플로 회차는 계정·대화 경로를 타지 않는다. 여기서 갈라야 계정 준비 단계가
    // 실행 계정이 없는 회차를 계정 대기로 남기지 않는다.
    if claimed.schedule.input.workflow.is_some() {
        execute_workflow_claim(&inner, claimed, &control);
        return;
    }
    match prepare_run_account(&inner, &mut claimed) {
        Ok(()) => {}
        Err(PrepareRunError::Waiting(status, message)) => {
            claimed.run.status = status;
            claimed.run.started_at = None;
            claimed.run.finished_at = None;
            claimed.run.error = Some(message);
            let _ = finish_run(&inner.app_data_dir, &claimed);
            if let Ok(mut running) = inner.running.lock() {
                running.remove(&claimed.schedule.id);
            }
            return;
        }
        Err(PrepareRunError::Failed(message)) => {
            claimed.run.status = ScheduleRunStatus::Failed;
            claimed.run.finished_at = Some(now_ms());
            claimed.run.error = Some(message);
            claimed.schedule.last_run_at = claimed.run.finished_at;
            let saved =
                finish_run(&inner.app_data_dir, &claimed).unwrap_or_else(|_| claimed.clone());
            emit_result(&inner, &saved);
            if let Ok(mut running) = inner.running.lock() {
                running.remove(&claimed.schedule.id);
            }
            return;
        }
    };
    claimed.run.status = ScheduleRunStatus::Running;
    claimed.run.started_at = Some(now_ms());
    claimed.run.last_heartbeat_at = claimed.run.started_at;
    claimed.run.error = None;
    match finish_run(&inner.app_data_dir, &claimed) {
        Ok(saved) if saved.run.status == ScheduleRunStatus::Running => claimed = saved,
        Ok(_) => {
            if let Ok(mut running) = inner.running.lock() {
                running.remove(&claimed.schedule.id);
            }
            return;
        }
        Err(error) => {
            claimed.run.status = ScheduleRunStatus::Failed;
            claimed.run.finished_at = Some(now_ms());
            claimed.run.error = Some(format!("반복 실행 상태를 저장하지 못했습니다: {error}"));
            emit_result(&inner, &claimed);
            if let Ok(mut running) = inner.running.lock() {
                running.remove(&claimed.schedule.id);
            }
            return;
        }
    }
    // 세션 참조는 실행 시작에 한 번 확정한다. 저장된 정책만 쓰고, 상대 날짜가 절대 구간이
    // 되는 것은 여기 한 번뿐이다. 확정된 정책은 프롬프트 앞에 붙어 전달된다.
    let (session_preamble, session_record) = resolve_run_session_read_for_run(&inner, &claimed);
    claimed.run.session_reference = Some(session_record);
    let _ = finish_run(&inner.app_data_dir, &claimed);
    let previous = claimed.schedule.input.provider_session_id.clone();
    let use_resume = claimed.schedule.input.session_strategy == ScheduleSessionStrategy::Continue;
    let first = execute_once(
        &inner.chats,
        &claimed.schedule,
        claimed.run.actual_account_id.as_deref(),
        &claimed.run.id,
        use_resume.then_some(previous.as_deref()).flatten(),
        &control,
        &inner.app_data_dir,
        session_preamble.as_deref(),
    );
    let result = match first {
        Err(error) if error.resume_failed && use_resume && previous.is_some() => {
            handle_resume_failure(
                &inner,
                &mut claimed,
                error.message,
                &control,
                &inner.app_data_dir,
                session_preamble.as_deref(),
            )
        }
        result => result.map_err(|error| error.message),
    };
    let now = now_ms();
    match result {
        Ok(outcome) => {
            claimed.run.status = ScheduleRunStatus::Completed;
            claimed.run.provider_session_id = outcome.provider_session_id.clone();
            claimed.run.summary = outcome.summary;
            claimed.run.finished_at = Some(now);
            if use_resume {
                claimed.schedule.input.provider_session_id = outcome.provider_session_id;
            }
        }
        Err(error) => {
            claimed.run.status = if control.cancelled.load(Ordering::Acquire) {
                ScheduleRunStatus::Cancelled
            } else if crate::chat::is_usage_limit_message(&error) {
                // 실행 도중 한도에 걸린 것은 이 회차의 잘못이 아니다. 세션이 한도 응답을
                // 받으면 계정이 이미 제한 상태로 표시되므로, 다음 틱의 사전 점검이 CLI를
                // 다시 띄우지 않고 복구될 때까지 이 회차를 대기시킨다.
                ScheduleRunStatus::WaitingForUsage
            } else {
                ScheduleRunStatus::Failed
            };
            claimed.run.error = Some(error);
            // 대기로 남긴 회차는 아직 끝나지 않았다. 시작·종료 시각을 지워 다음 틱이
            // 같은 회차를 처음부터 다시 시도하게 한다.
            if claimed.run.status.is_waiting() {
                claimed.run.started_at = None;
                claimed.run.finished_at = None;
            } else {
                claimed.run.finished_at = Some(now);
            }
        }
    }
    // 사용량 복구를 기다리는 회차는 아직 돈 것이 아니므로 마지막 실행 시각을 옮기지
    // 않는다. 옮기면 다음 예약 시각 계산이 돌지 않은 회차를 돈 것으로 센다.
    if !claimed.run.status.is_waiting() {
        claimed.schedule.last_run_at = Some(now);
    }
    claimed.schedule.updated_at = now;
    let saved = finish_run(&inner.app_data_dir, &claimed).unwrap_or_else(|_| claimed.clone());
    emit_result(&inner, &saved);
    if let Ok(mut running) = inner.running.lock() {
        running.remove(&claimed.schedule.id);
    }
}

/// 워크플로 반복 실행 한 회차. 공급자 CLI를 띄우지 않으므로 계정 준비·대화 재개·세션
/// 참조 경로를 타지 않고, 승인 검증과 실행 결과 기록만 한다.
fn execute_workflow_claim(
    inner: &Arc<SchedulerInner>,
    mut claimed: ClaimedRun,
    control: &Arc<ActiveRunControl>,
) {
    claimed.run.status = ScheduleRunStatus::Running;
    claimed.run.started_at = Some(now_ms());
    claimed.run.last_heartbeat_at = claimed.run.started_at;
    claimed.run.error = None;
    match finish_run(&inner.app_data_dir, &claimed) {
        Ok(saved) if saved.run.status == ScheduleRunStatus::Running => claimed = saved,
        // 이미 terminal로 확정된 회차(취소 등)는 여기서 다시 쓰지 않는다.
        Ok(_) => return,
        Err(error) => {
            claimed.run.status = ScheduleRunStatus::Failed;
            claimed.run.finished_at = Some(now_ms());
            claimed.run.error = Some(format!("반복 실행 상태를 저장하지 못했습니다: {error}"));
            emit_result(inner, &claimed);
            return;
        }
    }
    let Some(action) = claimed.schedule.input.workflow.clone() else {
        return;
    };
    let outcome = run_workflow_action(
        inner,
        &action,
        &claimed.schedule.id,
        &claimed.run.id,
        // `manual`에는 문서 변경 트리거도 포함된다. 계획 0건을 한 건으로 바꾸는 것은
        // 사용자가 누른 `지금 실행`에만 적용한다.
        claimed.run.manual && claimed.run.document_trigger.is_none(),
        control,
    );
    let now = now_ms();
    match outcome {
        Ok(receipt) => {
            let report = summarize_workflow_run(&action, &receipt);
            claimed.run.status = if report.succeeded {
                ScheduleRunStatus::Completed
            } else {
                ScheduleRunStatus::Failed
            };
            claimed.run.summary = clean_summary(report.summary);
            claimed.run.error = report.failure;
            claimed.run.round = report.round;
        }
        Err(failure) => {
            claimed.run.status = ScheduleRunStatus::Failed;
            claimed.run.error = Some(failure.message);
            // 승인 버전이 어긋난 워크플로는 다음 회차도 같은 이유로 실패한다. 주기마다
            // 실패만 쌓지 않고 멈춰 세워, 수정 화면에서 다시 승인하도록 남긴다.
            if failure.pause_schedule {
                claimed.schedule.input.enabled = false;
            }
        }
    }
    claimed.run.finished_at = Some(now);
    claimed.run.last_heartbeat_at = Some(now);
    claimed.schedule.last_run_at = Some(now);
    claimed.schedule.updated_at = now;
    let saved = finish_run(&inner.app_data_dir, &claimed).unwrap_or_else(|_| claimed.clone());
    emit_result(inner, &saved);
}

struct WorkflowRunFailure {
    message: String,
    /// 다시 승인받아야 하는 사유. 같은 이유로 매 주기 실패하지 않게 반복 요청을 멈춘다.
    pause_schedule: bool,
}

/// 워크플로를 별도 스레드에서 돌리고, 기다리는 동안 회차 heartbeat를 갱신한다. 갱신하지
/// 않으면 lease 만료 정리가 오래 도는 워크플로를 끊긴 실행으로 오인한다. 워크플로 단계는
/// 중간에 끊을 수 없으므로 취소 요청은 회차 기록만 확정하고 실행은 끝까지 간다.
fn run_workflow_action(
    inner: &Arc<SchedulerInner>,
    action: &ScheduleWorkflowAction,
    schedule_id: &str,
    run_id: &str,
    manual_run: bool,
    control: &Arc<ActiveRunControl>,
) -> Result<Value, WorkflowRunFailure> {
    let Some(executor) = inner.workflow_executor() else {
        return Err(WorkflowRunFailure {
            message: "워크플로 실행 계층을 사용할 수 없어 이 회차를 실행하지 않았습니다".to_owned(),
            pause_schedule: false,
        });
    };
    executor
        .validate_workflow(action)
        .map_err(|error| WorkflowRunFailure {
            message: format!("워크플로를 실행할 수 없어 반복 요청을 일시정지했습니다: {error}"),
            pause_schedule: true,
        })?;
    let idempotency_key = format!("schedule-workflow-{run_id}");
    // 워크플로 단계가 띄우는 채팅에 실릴 출처. 어느 반복 요청의 회차인지가 사용량
    // 페이싱의 소비자 식별 근거다.
    let trigger = WorkflowTrigger {
        schedule_id: schedule_id.to_owned(),
        run_id: run_id.to_owned(),
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker_action = action.clone();
    thread::spawn(move || {
        let _ = sender.send(executor.execute_workflow(
            &worker_action,
            &idempotency_key,
            &trigger,
            manual_run,
        ));
    });
    let started = SystemTime::now();
    loop {
        match receiver.recv_timeout(TICK_INTERVAL) {
            Ok(result) => {
                return result.map_err(|error| WorkflowRunFailure {
                    message: error.to_string(),
                    pause_schedule: false,
                })
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = touch_run_heartbeat(&inner.app_data_dir, run_id, control);
                if startup_deadline_exceeded(started, MAX_RUN_DURATION) {
                    return Err(WorkflowRunFailure {
                        message: format!(
                            "워크플로가 {}시간 안에 끝나지 않아 이 회차를 실패로 확정했습니다",
                            MAX_RUN_DURATION.as_secs() / 3600
                        ),
                        pause_schedule: false,
                    });
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(WorkflowRunFailure {
                    message: "워크플로 실행 작업이 결과 없이 종료되었습니다".to_owned(),
                    pause_schedule: false,
                })
            }
        }
    }
}

/// 회차 기록에 남길 요약. 인자와 단계 결과 원문은 담지 않고 단계 상태만 옮긴다.
struct WorkflowRunReport {
    succeeded: bool,
    summary: String,
    failure: Option<String>,
    /// 페이싱 회차 봉투였으면 그 집계. 아니면 None.
    round: Option<ScheduleRunRound>,
}

fn summarize_workflow_run(action: &ScheduleWorkflowAction, receipt: &Value) -> WorkflowRunReport {
    let succeeded = receipt["succeeded"].as_bool().unwrap_or(false);
    let steps = receipt["steps"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let version = receipt["version"]
        .as_u64()
        .unwrap_or(u64::from(action.approved_version));
    let mut lines = vec![format!(
        "워크플로 {} v{version} · 실행 {} · 단계 {}개 · {}",
        action.workflow_id,
        receipt["executionId"].as_str().unwrap_or("-"),
        steps.len(),
        if succeeded { "성공" } else { "실패" },
    )];
    for step in steps {
        let error = step["error"]
            .as_str()
            .map(|error| format!(" · {error}"))
            .unwrap_or_default();
        lines.push(format!(
            "- {} · {} · {}{error}",
            step["stepId"].as_str().unwrap_or("-"),
            step["operation"].as_str().unwrap_or("-"),
            step["status"].as_str().unwrap_or("-"),
        ));
    }
    // 회차 봉투는 기동이 0건이어도 성공이다. 왜 0건인지(예산 판정)가 기록에 남아야 한다.
    let mut round_counts = None;
    if receipt["paced"].as_bool().unwrap_or(false) {
        let round = &receipt["round"];
        let count = |key: &str, fallback: u64| {
            u32::try_from(round[key].as_u64().unwrap_or(fallback)).unwrap_or(u32::MAX)
        };
        let counts = ScheduleRunRound {
            planned_runs: count("plannedRuns", 0),
            launched_runs: count("launchedRuns", 0),
            stale_runs: count("staleRuns", 0),
            max_runs: count("maxRuns", 1),
        };
        lines.push(format!(
            "- 회차 · 계획 {}건 · 기동 {}건 · 정리 {}건 · 병렬 {}건",
            counts.planned_runs, counts.launched_runs, counts.stale_runs, counts.max_runs,
        ));
        round_counts = Some(counts);
        for reason in round["reasoning"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .take(5)
        {
            lines.push(format!("  · {reason}"));
        }
    }
    let failure = (!succeeded).then(|| {
        let reason = receipt["failure"]
            .as_str()
            .unwrap_or("워크플로 단계가 실패했습니다");
        match receipt["failedStepId"].as_str() {
            Some(step) => format!("단계 {step} 실패: {reason}"),
            None => reason.to_owned(),
        }
    });
    WorkflowRunReport {
        succeeded,
        summary: lines.join("\n"),
        failure,
        round: round_counts,
    }
}

struct RunExecutionRegistration {
    inner: Arc<SchedulerInner>,
    schedule_id: String,
    run_id: String,
}

impl Drop for RunExecutionRegistration {
    fn drop(&mut self) {
        if let Ok(mut executions) = self.inner.executions.lock() {
            executions.remove(&self.run_id);
        }
        if let Ok(mut running) = self.inner.running.lock() {
            running.remove(&self.schedule_id);
        }
        let now = now_ms();
        let _ = with_store(&self.inner.app_data_dir, |store| {
            if let Some(run) = store.runs.iter_mut().find(|run| run.id == self.run_id) {
                if matches!(run.status, ScheduleRunStatus::Running) {
                    run.status = ScheduleRunStatus::Failed;
                    run.finished_at = Some(now);
                    run.last_heartbeat_at = Some(now);
                    run.error = Some(
                        "반복 실행 소유 작업이 terminal 상태를 저장하기 전에 종료되었습니다"
                            .to_owned(),
                    );
                }
            }
            Ok(())
        });
    }
}

#[derive(Debug)]
enum PrepareRunError {
    /// 이 회차를 실패로 확정하지 않고 다음 틱에서 다시 시도한다. 대기로 남길 상태는
    /// 사유마다 다르므로 함께 들고 다닌다.
    Waiting(ScheduleRunStatus, String),
    Failed(String),
}

/// 실행 계정으로 바로 시작할 수 있는지 확인한다. 자격증명이 계정별 프로필로 갈려
/// 있으면 활성 계정이 아니어도 공유 CLI 홈을 읽지 않으므로, 반복 실행은 계정을
/// 전환하지 않는다. 전환은 공유 홈의 로그인 계정을 바꿔 앱 밖의 CLI까지 영향을
/// 주고, 되돌리는 동안 수동 전환과 다른 채팅을 모두 멈춰 세웠다.
fn prepare_run_account(
    inner: &SchedulerInner,
    claimed: &mut ClaimedRun,
) -> Result<(), PrepareRunError> {
    let source = claimed.schedule.input.source;
    // 계정 레지스트리는 다중 계정을 관리하는 공급자만 담는다. Antigravity처럼 담기지
    // 않는 공급자는 활성 계정 조회 자체가 "지원하지 않는 계정 공급자"로 거절되어, 준비
    // 단계에서 회차가 통째로 실패했다. 채팅 시작 경로는 이미 이 공급자를 계정 미귀속으로
    // 시작하므로(`chat::resolve_start_account_id`) 회차도 같은 규칙을 따른다.
    if !source.manages_accounts() {
        claimed.run.actual_account_id = None;
        return Ok(());
    }
    let follow_active = claimed.schedule.input.use_active_account;
    let Some(accounts) = &inner.accounts else {
        claimed.run.actual_account_id = pinned_account_id(&claimed.schedule.input);
        return Ok(());
    };
    let requested = if follow_active {
        // 기본 계정이 아직 없으면 실패로 확정하지 않는다. 사용자가 기본 계정을 고르면
        // 다음 틱에서 그대로 이어 실행된다.
        accounts
            .active_account_id(source)
            .map_err(|error| PrepareRunError::Failed(error.to_string()))?
            .ok_or_else(|| {
                PrepareRunError::Waiting(
                    ScheduleRunStatus::WaitingForAccount,
                    "실행 시점 기본 계정이 없어 대기합니다. 공급자의 기본 계정을 먼저 선택하세요"
                        .to_owned(),
                )
            })?
    } else {
        claimed.schedule.input.account_id.clone()
    };
    let requested = requested.as_str();
    let subject = if follow_active {
        "실행 시점 기본 계정"
    } else {
        "반복 요청의 실행 계정"
    };
    match accounts
        .run_readiness(source, requested)
        .map_err(|error| PrepareRunError::Failed(error.to_string()))?
    {
        RunReadiness::Ready => {}
        // 사용자가 끈 계정은 저절로 돌아오지 않으므로 이 회차를 실패로 확정한다.
        RunReadiness::Disabled => {
            return Err(PrepareRunError::Failed(format!(
                "{subject}이 비활성화되었습니다"
            )));
        }
        // 인증 상태를 잃은 것은 일시 상태일 수 있다. 공유 홈 자격증명 확인이 401이나
        // 중간에 끊긴 기록을 만나면 붙었다가 다음 조회가 성공하면 풀린다. 실패로
        // 확정하면 몇 분 뒤면 회복될 상태 때문에 예약된 회차가 통째로 날아가므로
        // 대기로 남겨 다음 틱에서 다시 확인한다.
        RunReadiness::NeedsReauthentication => {
            return Err(PrepareRunError::Waiting(
                ScheduleRunStatus::WaitingForAccount,
                format!(
                    "{subject}의 인증이 확인되지 않아 대기합니다. 상태가 계속되면 이 계정을 다시 인증하세요"
                ),
            ));
        }
        // 확인하지 못한 인증은 대기 시각이 지나면 그냥 실행해 본다. 실행되면 CLI가
        // 토큰을 회전시켜 계정이 스스로 낫고, 정말 거부된 자격증명이면 그 실행이
        // 실패하며 정확한 상태를 다시 만든다. 무한정 대기시키는 쪽이 오히려
        // 회복 경로를 닫는다.
        RunReadiness::AuthUnverified { retry_after } => {
            if let Some(retry_after) = retry_after.filter(|retry_after| *retry_after > now_ms()) {
                return Err(PrepareRunError::Waiting(
                    ScheduleRunStatus::WaitingForAccount,
                    match format_local_time(retry_after, &claimed.schedule.input.recurrence.timezone)
                    {
                        Some(when) => format!(
                            "{subject}의 인증을 확인하지 못해 대기합니다 · {when} 이후 재시도"
                        ),
                        None => format!(
                            "{subject}의 인증을 확인하지 못해 대기합니다. 갱신 제한이 풀리면 이 회차를 이어서 실행합니다"
                        ),
                    },
                ));
            }
        }
        // 한도는 시간이 지나면 저절로 풀린다. 여기서 실패로 확정하면 사용자가 손댈 수
        // 없는 이유로 예약된 회차가 사라지므로, 복구될 때까지 이 회차를 그대로 멈춰 둔다.
        RunReadiness::UsageExhausted { resume_at } => {
            return Err(PrepareRunError::Waiting(
                ScheduleRunStatus::WaitingForUsage,
                usage_wait_message(subject, resume_at, &claimed.schedule.input.recurrence),
            ));
        }
    }
    // 모든 계정은 자기 격리 프로필로 실행된다. 프로브는 공급자 CLI를 실제로 띄우므로
    // 실행 직전에 한 번만 돌린다.
    if !accounts.ensure_credential_isolation(source, requested) {
        // 격리 준비 실패는 CLI 탐색 실패나 일시적 입출력으로도 생긴다. 실행을
        // 실패로 확정하지 않고 대기로 남긴다. 실패 판정은 재시도 시각까지만
        // 캐시되므로, 원인을 고치면 이후 틱에서 프로브가 다시 돌아 회복된다.
        return Err(PrepareRunError::Waiting(
            ScheduleRunStatus::WaitingForAccount,
            match accounts.credential_profile_fallback_reason(requested) {
                Some(reason) => {
                    format!("실행 계정의 자격증명 격리를 준비하지 못해 대기합니다: {reason}")
                }
                None => "실행 계정의 자격증명 격리를 준비하지 못해 대기합니다".to_owned(),
            },
        ));
    }
    claimed.run.actual_account_id = Some(requested.to_owned());
    Ok(())
}

/// 사용량 복구를 기다리는 회차에 남길 문구. 언제 다시 도는지가 이 상태에서 사용자가
/// 알고 싶은 전부이므로, 리셋 시각을 알면 반복 요청이 쓰는 시간대로 함께 적는다.
fn usage_wait_message(
    subject: &str,
    resume_at: Option<i64>,
    recurrence: &ScheduleRecurrence,
) -> String {
    match resume_at.and_then(|resume_at| format_local_time(resume_at, &recurrence.timezone)) {
        Some(when) => {
            format!("{subject}의 사용량이 소진되어 복구까지 일시중단합니다 · {when} 이후 재개")
        }
        None => format!(
            "{subject}의 사용량이 소진되어 복구까지 일시중단합니다. 사용량이 돌아오면 이 회차를 이어서 실행합니다"
        ),
    }
}

/// 반복 요청이 쓰는 시간대로 옮겨 적은 시각. 시간대를 읽을 수 없으면 임의의 시간대로
/// 바꿔 적는 대신 시각을 아예 빼, 화면에 틀린 시각이 남지 않게 한다.
fn format_local_time(at_ms: i64, timezone: &str) -> Option<String> {
    let zone = timezone.parse::<Tz>().ok()?;
    Some(
        DateTime::<Utc>::from_timestamp_millis(at_ms)?
            .with_timezone(&zone)
            .format("%Y-%m-%d %H:%M %Z")
            .to_string(),
    )
}

/// 반복 요청이 고정해 둔 실행 계정. 실행 시점 활성 계정을 쓰는 요청은 고정 계정이
/// 없으므로 공급자가 활성 계정을 고르게 비워 둔다.
fn pinned_account_id(input: &ScheduledRequestInput) -> Option<String> {
    (!input.use_active_account && !input.account_id.is_empty()).then(|| input.account_id.clone())
}

fn handle_resume_failure(
    inner: &Arc<SchedulerInner>,
    claimed: &mut ClaimedRun,
    first_error: String,
    control: &Arc<ActiveRunControl>,
    app_data_dir: &Path,
    session_preamble: Option<&str>,
) -> Result<RunOutcome, String> {
    // 재개 실패로 새 대화를 열어도 처음 실행이 고른 계정을 그대로 쓴다. 실행 도중
    // 활성 계정이 바뀌어도 한 실행 안에서 계정이 갈리지 않는다.
    let account_id = claimed.run.actual_account_id.clone();
    match claimed.schedule.input.resume_failure_policy {
        ResumeFailurePolicy::Pause => {
            claimed.schedule.input.enabled = false;
            Err(format!(
                "대화 재개에 실패해 반복 요청을 일시정지했습니다: {first_error}"
            ))
        }
        ResumeFailurePolicy::NewChat => {
            claimed.run.session_replaced = true;
            execute_once(
                &inner.chats,
                &claimed.schedule,
                account_id.as_deref(),
                &claimed.run.id,
                None,
                control,
                app_data_dir,
                session_preamble,
            )
            .map_err(|error| error.message)
        }
        ResumeFailurePolicy::RetryThenNewChat => {
            claimed.run.retry_count = 1;
            match execute_once(
                &inner.chats,
                &claimed.schedule,
                account_id.as_deref(),
                &claimed.run.id,
                claimed.schedule.input.provider_session_id.as_deref(),
                control,
                app_data_dir,
                session_preamble,
            ) {
                Ok(outcome) => Ok(outcome),
                Err(error) if error.resume_failed => {
                    claimed.run.session_replaced = true;
                    execute_once(
                        &inner.chats,
                        &claimed.schedule,
                        account_id.as_deref(),
                        &claimed.run.id,
                        None,
                        control,
                        app_data_dir,
                        session_preamble,
                    )
                    .map_err(|error| error.message)
                }
                Err(error) => Err(error.message),
            }
        }
    }
}

struct RunOutcome {
    provider_session_id: Option<String>,
    summary: Option<String>,
}

struct RunAttemptError {
    message: String,
    resume_failed: bool,
}

impl RunAttemptError {
    /// 재개(resume) 자체와 무관한 실행 실패.
    fn plain(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            resume_failed: false,
        }
    }
}

/// 실행에 붙일 세션 컨텍스트 채널. 정책이 꺼져 있거나 계층이 연결되지 않았으면 채널 없이
/// 사유만 남기고, 실행 자체는 그대로 이어진다.
/// Agent Manager가 세션에서 확인한 등록 프로젝트. 세션 참조 범위는 이 목록 안으로만
/// 좁혀지고, 목록에 없는 경로는 사유만 남기고 빠진다.
fn registered_project_paths(app_data_dir: &Path) -> Result<Vec<PathBuf>, CoreError> {
    let catalog = crate::SessionCatalog::open(app_data_dir.to_path_buf())?;
    Ok(crate::skill_library::project_paths_from_sessions(
        &catalog.manager_snapshot()?.sessions,
    ))
}

/// 이 회차가 다른 에이전트 세션을 읽을 범위를 확정한다. 확정된 정책은 실행 프롬프트 앞에
/// 붙어 에이전트가 `session-context` 스킬에 그대로 넘길 수 있는 형태로 전달된다.
fn resolve_run_session_read_for_run(
    inner: &Arc<SchedulerInner>,
    claimed: &ClaimedRun,
) -> (Option<String>, ScheduleRunSessionRead) {
    let Some(settings) = claimed.schedule.input.session_reference.as_ref() else {
        return (
            None,
            ScheduleRunSessionRead {
                granted: false,
                summary: "세션 참조 사용 안 함".to_owned(),
                window_from: None,
                window_to: None,
                notes: Vec::new(),
            },
        );
    };
    let summary = crate::session_context::describe_policy(&settings.policy);
    if !settings.policy.enabled {
        return (
            None,
            ScheduleRunSessionRead {
                granted: false,
                summary,
                window_from: None,
                window_to: None,
                notes: Vec::new(),
            },
        );
    }
    let registered = match registered_project_paths(&inner.app_data_dir) {
        Ok(registered) => registered,
        Err(error) => {
            return (
                None,
                ScheduleRunSessionRead {
                    granted: false,
                    summary,
                    window_from: None,
                    window_to: None,
                    notes: vec![format!(
                        "등록 프로젝트를 확인하지 못해 세션 참조를 안내하지 않았습니다: {error}"
                    )],
                },
            )
        }
    };
    resolve_run_session_read(
        &registered,
        &settings.policy,
        &claimed.schedule.input.cwd,
        &claimed.schedule.input.recurrence,
        claimed.schedule.last_run_at,
        now_ms(),
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_once(
    chats: &ChatSupervisor,
    schedule: &ScheduledRequest,
    account_id: Option<&str>,
    capture_id: &str,
    resume_session_id: Option<&str>,
    control: &Arc<ActiveRunControl>,
    app_data_dir: &Path,
    session_preamble: Option<&str>,
) -> Result<RunOutcome, RunAttemptError> {
    let request = run_start_request(schedule, account_id, capture_id, resume_session_id, control);
    let attachment = await_run_startup(chats, request, control, app_data_dir, capture_id)?;
    let chat_id = attachment.info.chat_id.clone();
    if let Ok(mut active_chat_id) = control.chat_id.lock() {
        *active_chat_id = Some(chat_id.clone());
    }
    if control.cancelled.load(Ordering::Acquire) {
        let _ = chats.stop(&chat_id);
        return Err(RunAttemptError::plain("반복 요청 실행이 취소되었습니다"));
    }
    let prompt = match session_preamble {
        Some(preamble) => format!("{preamble}\n{}", schedule.input.prompt),
        None => schedule.input.prompt.clone(),
    };
    if let Err(error) = chats.send(&chat_id, &prompt) {
        let _ = chats.stop(&chat_id);
        return Err(RunAttemptError {
            message: error.to_string(),
            resume_failed: resume_session_id.is_some(),
        });
    }
    drain_run_events(
        chats,
        attachment,
        &chat_id,
        control,
        app_data_dir,
        capture_id,
        resume_session_id,
    )
}

/// 회차 한 번을 띄우는 채팅 시작 요청. 반복 요청은 언제나 unattended 실행이고 회차마다
/// 계정을 고정하지 않는다.
fn run_start_request(
    schedule: &ScheduledRequest,
    account_id: Option<&str>,
    capture_id: &str,
    resume_session_id: Option<&str>,
    control: &Arc<ActiveRunControl>,
) -> ChatStartRequest {
    ChatStartRequest {
        source: schedule.input.source,
        account_id: account_id.map(str::to_owned),
        cwd: schedule.input.cwd.clone(),
        model: schedule.input.model.clone(),
        reasoning_effort: schedule.input.reasoning_effort.clone(),
        mode: schedule.input.mode,
        approval_mode: schedule.input.approval_mode,
        resume_session_id: resume_session_id.map(str::to_owned),
        handoff_origin: None,
        origin: Some(ChatOrigin {
            kind: ChatOriginKind::Schedule,
            workflow_id: None,
            execution_id: None,
            schedule_id: Some(schedule.id.clone()),
            run_id: Some(capture_id.to_owned()),
            consumer_id: None,
        }),
        capture_id: Some(capture_id.to_owned()),
        unattended: true,
        // 반복 실행의 계정은 `useActiveAccount`와 저장된 accountId가 정하고, 세션 고정은
        // 사용자가 세션 메타에서 따로 건다. 회차마다 자동으로 고정하지 않는다.
        pin_account: false,
        profile: ChatProfile::Standard,
        decision_policy: Default::default(),
        aia_runtime: None,
        settings: Default::default(),
        startup_cancel: Some(Arc::clone(&control.cancelled)),
    }
}

/// provider가 뜰 때까지 기다린다. 시작은 별도 스레드에 맡기고 이 쪽은 1초마다 깨어나
/// 취소·시작 시한을 확인하고 heartbeat을 남긴다.
fn await_run_startup(
    chats: &ChatSupervisor,
    request: ChatStartRequest,
    control: &Arc<ActiveRunControl>,
    app_data_dir: &Path,
    capture_id: &str,
) -> Result<ChatAttachment, RunAttemptError> {
    let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
    let startup_chats = chats.clone();
    thread::spawn(move || {
        let _ = startup_sender.send(startup_chats.start(request));
    });
    let startup_started = SystemTime::now();
    loop {
        if control.cancelled.load(Ordering::Acquire) {
            return Err(RunAttemptError::plain(
                "반복 요청 실행 취소로 provider startup을 중단했습니다",
            ));
        }
        if startup_deadline_exceeded(startup_started, MAX_PROVIDER_STARTUP_DURATION) {
            control.cancelled.store(true, Ordering::Release);
            return Err(RunAttemptError::plain(
                "에이전트 provider startup이 5분을 초과했습니다. 작업 경로와 CLI 탐색 상태를 확인하세요",
            ));
        }
        let _ = touch_run_heartbeat(app_data_dir, capture_id, control);
        match startup_receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(attachment)) => return Ok(attachment),
            Ok(Err(error)) => {
                let resume_failed = matches!(&error, CoreError::ResumeFailed(_));
                return Err(RunAttemptError {
                    message: error.to_string(),
                    resume_failed,
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(RunAttemptError::plain(
                    "provider startup 작업이 예기치 않게 종료되었습니다",
                ));
            }
        }
    }
}

/// 프롬프트를 보낸 뒤 턴이 끝날 때까지 이벤트를 훑는다. 아직 provider가 아무 반응도
/// 내놓지 않은 상태에서 실패하면 재개(resume) 실패로 되돌릴 수 있게 표시한다.
#[allow(clippy::too_many_arguments)]
fn drain_run_events(
    chats: &ChatSupervisor,
    attachment: ChatAttachment,
    chat_id: &str,
    control: &Arc<ActiveRunControl>,
    app_data_dir: &Path,
    capture_id: &str,
    resume_session_id: Option<&str>,
) -> Result<RunOutcome, RunAttemptError> {
    let mut provider_session_id = attachment.info.provider_session_id.clone();
    let started = SystemTime::now();
    let mut summary = String::new();
    let mut last_error = None;
    let mut provider_activity = false;
    // provider가 한 번이라도 반응한 뒤의 실패는 재개 자체가 깨진 것이 아니다.
    let resume_broken = |provider_activity: bool| resume_session_id.is_some() && !provider_activity;
    loop {
        let _ = touch_run_heartbeat(app_data_dir, capture_id, control);
        if control.cancelled.load(Ordering::Acquire) {
            let _ = chats.stop(chat_id);
            return Err(RunAttemptError::plain("반복 요청 실행이 취소되었습니다"));
        }
        let elapsed = started.elapsed().unwrap_or_default();
        if elapsed > MAX_RUN_DURATION {
            let _ = chats.stop(chat_id);
            return Err(RunAttemptError::plain(
                "반복 요청 실행 시간이 6시간을 초과했습니다",
            ));
        }
        if !provider_activity && elapsed > MAX_PROVIDER_STARTUP_DURATION {
            let _ = chats.stop(chat_id);
            return Err(RunAttemptError::plain(
                "에이전트가 5분 안에 응답을 시작하지 않았습니다. 작업 경로 접근 권한을 확인하세요",
            ));
        }
        match attachment.events.recv_timeout(Duration::from_secs(1)) {
            Ok(ChatEvent::State { session }) => {
                provider_session_id = session.provider_session_id;
                if matches!(session.state, ChatPhase::Stopped | ChatPhase::Failed) {
                    return Err(RunAttemptError {
                        message: "scheduler 소유 unattended runtime이 종료되어 반복 실행을 finalize했습니다".to_owned(),
                        resume_failed: resume_broken(provider_activity),
                    });
                }
            }
            Ok(ChatEvent::MessageDelta {
                role, kind, delta, ..
            }) if role == "assistant" && kind == "message" => {
                provider_activity = true;
                summary.push_str(&delta);
                if summary.chars().count() > 2_000 {
                    summary = summary.chars().take(2_000).collect();
                }
            }
            Ok(ChatEvent::MessageDelta { role, .. }) if role == "assistant" => {
                provider_activity = true;
            }
            Ok(ChatEvent::Tool { status, .. }) if status != "log" => {
                provider_activity = true;
            }
            Ok(ChatEvent::Approval { .. }) | Ok(ChatEvent::ApprovalResolved { .. }) => {
                provider_activity = true;
            }
            Ok(ChatEvent::Error { message }) => last_error = Some(message),
            Ok(ChatEvent::Turn { status, .. }) if status != "started" => {
                let _ = chats.stop(chat_id);
                if status == "completed" {
                    return Ok(RunOutcome {
                        provider_session_id,
                        summary: clean_summary(summary),
                    });
                }
                return Err(RunAttemptError {
                    message: last_error.unwrap_or_else(|| format!("에이전트 실행 상태: {status}")),
                    resume_failed: resume_broken(provider_activity),
                });
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = chats.stop(chat_id);
                return Err(RunAttemptError {
                    message: "반복 요청 채팅 연결이 종료되었습니다".to_owned(),
                    resume_failed: resume_broken(provider_activity),
                });
            }
        }
    }
}

fn finish_run(app_data_dir: &Path, claimed: &ClaimedRun) -> Result<ClaimedRun, CoreError> {
    with_store(app_data_dir, |store| {
        let mut saved = claimed.clone();
        if let Some(schedule) = store
            .schedules
            .iter_mut()
            .find(|schedule| schedule.id == claimed.schedule.id)
        {
            if !claimed.schedule.input.enabled {
                schedule.input.enabled = false;
            }
            schedule.input.provider_session_id = claimed.schedule.input.provider_session_id.clone();
            schedule.last_run_at = claimed.schedule.last_run_at;
            schedule.updated_at = claimed.schedule.updated_at;
            saved.schedule = schedule.clone();
        }
        if let Some(run) = store.runs.iter_mut().find(|run| run.id == claimed.run.id) {
            if !run.status.is_terminal() {
                *run = claimed.run.clone();
            }
            saved.run = run.clone();
        }
        trim_runs(store);
        Ok(saved)
    })
}

fn touch_run_heartbeat(
    app_data_dir: &Path,
    run_id: &str,
    control: &ActiveRunControl,
) -> Result<(), CoreError> {
    let now = now_ms();
    let previous = control.last_heartbeat_at.load(Ordering::Relaxed);
    if previous > 0 && now.saturating_sub(previous) < TICK_INTERVAL.as_millis() as i64 {
        return Ok(());
    }
    control.last_heartbeat_at.store(now, Ordering::Relaxed);
    with_store(app_data_dir, |store| {
        if let Some(run) = store.runs.iter_mut().find(|run| run.id == run_id) {
            if matches!(run.status, ScheduleRunStatus::Running) {
                run.last_heartbeat_at = Some(now);
            }
        }
        Ok(())
    })
}

fn reconcile_expired_runs(inner: &Arc<SchedulerInner>, now: i64) -> Result<(), CoreError> {
    let expired_before =
        now.saturating_sub(i64::try_from(RUN_LEASE_EXPIRY.as_millis()).unwrap_or(i64::MAX));
    let persisted = read_store(&inner.app_data_dir)?;
    let expired = persisted
        .runs
        .into_iter()
        .filter(|run| {
            run.status == ScheduleRunStatus::Running
                && run
                    .last_heartbeat_at
                    .or(run.started_at)
                    .is_none_or(|heartbeat| heartbeat < expired_before)
        })
        .collect::<Vec<_>>();
    for run in expired {
        let control = inner
            .executions
            .lock()
            .ok()
            .and_then(|executions| executions.get(&run.id).cloned());
        if let Some(control) = control {
            control.cancelled.store(true, Ordering::Release);
            if let Some(chat_id) = control
                .chat_id
                .lock()
                .ok()
                .and_then(|chat_id| chat_id.clone())
            {
                let _ = inner.chats.stop_managed(&chat_id);
            }
        }
        with_store(&inner.app_data_dir, |store| {
            if let Some(saved) = store.runs.iter_mut().find(|saved| saved.id == run.id) {
                if saved.status == ScheduleRunStatus::Running {
                    saved.status = ScheduleRunStatus::Failed;
                    saved.finished_at = Some(now);
                    saved.last_heartbeat_at = Some(now);
                    saved.error = Some(format!(
                        "scheduler heartbeat가 {}초 동안 갱신되지 않아 실행 lease를 만료했습니다",
                        RUN_LEASE_EXPIRY.as_secs()
                    ));
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

const DEFAULT_CANCEL_REASON: &str = "운영자가 반복 요청 실행을 취소했습니다";

fn normalize_cancel_reason(reason: Option<&str>) -> String {
    let reason = reason
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(DEFAULT_CANCEL_REASON);
    reason.chars().take(500).collect()
}

fn stale_run_reasons(run: &ScheduleRun, now: i64) -> Vec<String> {
    let mut reasons = Vec::new();
    if run.provider_session_id.is_none() {
        reasons.push("providerSessionId가 아직 없습니다".to_owned());
    }
    if let Some(heartbeat) = run.last_heartbeat_at.or(run.started_at) {
        let age_ms = now.saturating_sub(heartbeat);
        reasons.push(format!("마지막 heartbeat {}초 전", age_ms / 1_000));
        if age_ms > i64::try_from(RUN_LEASE_EXPIRY.as_millis()).unwrap_or(i64::MAX) {
            reasons.push("scheduler lease 만료 기준을 초과했습니다".to_owned());
        }
    } else {
        reasons.push("heartbeat 기록이 없습니다".to_owned());
    }
    reasons
}

fn startup_deadline_exceeded(started: SystemTime, timeout: Duration) -> bool {
    started.elapsed().unwrap_or_default() > timeout
}

fn emit_result(inner: &SchedulerInner, claimed: &ClaimedRun) {
    // 대기로 남긴 회차는 아직 결과가 없다. 여기서 알리면 복구를 기다리는 동안 매 틱마다
    // 실패 알림이 나간다. 다음 시도가 끝나면 그때 실제 결과가 나간다.
    if claimed.run.status.is_waiting() {
        return;
    }
    let event = if !claimed.schedule.input.enabled
        && claimed.run.status == ScheduleRunStatus::Failed
    {
        SchedulerEvent::Paused {
            schedule: claimed.schedule.clone(),
            run: claimed.run.clone(),
        }
    } else if claimed.run.session_replaced && claimed.run.status == ScheduleRunStatus::Completed {
        SchedulerEvent::SessionReplaced {
            schedule: claimed.schedule.clone(),
            run: claimed.run.clone(),
        }
    } else if claimed.run.status == ScheduleRunStatus::Completed {
        SchedulerEvent::Completed {
            schedule: claimed.schedule.clone(),
            run: claimed.run.clone(),
        }
    } else {
        SchedulerEvent::Failed {
            schedule: claimed.schedule.clone(),
            run: claimed.run.clone(),
        }
    };
    if let Ok(mut subscriber) = inner.subscriber.lock() {
        if let Some(sender) = subscriber.as_ref() {
            if matches!(sender.try_send(event), Err(TrySendError::Disconnected(_))) {
                *subscriber = None;
            }
        }
    }
}

/// 페이싱 대상 워크플로의 활성 회차는 하나여야 한다. 간격 역조회는 여러 개가 걸리면 가장
/// 짧은 주기를 골라 버리고, 수동·AIA 호출의 소비자 식별은 활성 회차가 둘이면 워크플로 id로
/// 뭉개진다 — 두 번째 트리거는 통합이 아니라 같은 작업을 두 소비자로 갈라 서로 예산을
/// 경쟁하게 만들 뿐이다. 페이싱 밖 워크플로는 시각이 다른 트리거 여러 개가 정당하므로
/// 검사하지 않는다.
fn ensure_single_active_paced_round(
    app_data_dir: &Path,
    schedules: &[ScheduledRequest],
    workflow_id: &str,
    exclude_id: Option<&str>,
) -> Result<(), CoreError> {
    let Some(duplicate) = schedules.iter().find(|schedule| {
        exclude_id != Some(schedule.id.as_str())
            && schedule.input.enabled
            && schedule
                .input
                .workflow
                .as_ref()
                .is_some_and(|action| action.workflow_id == workflow_id)
    }) else {
        return Ok(());
    };
    let policy = crate::usage_budget_policy::load_optional(app_data_dir)?;
    if !crate::remote::pacing_workflow_ids(app_data_dir, policy.as_ref())?.contains(workflow_id) {
        return Ok(());
    }
    Err(CoreError::Conflict(format!(
        "이 워크플로를 돌리는 활성 회차가 이미 있습니다({}). 페이싱 워크플로는 활성 회차를 하나만 둘 수 있으니 기존 회차를 수정하거나 일시정지한 뒤 진행하세요",
        duplicate.input.name
    )))
}

fn validate_input(mut input: ScheduledRequestInput) -> Result<ScheduledRequestInput, CoreError> {
    input.name = input.name.trim().chars().take(120).collect();
    if input.name.is_empty() {
        return Err(CoreError::InvalidInput(
            "반복 요청 이름을 입력하세요".to_owned(),
        ));
    }
    let workflow_run = validate_workflow_action(input.workflow.as_mut())?;
    input.prompt = input.prompt.trim().to_owned();
    if workflow_run {
        // 워크플로 회차는 등록된 작업 호출만 돌린다. 프롬프트·계정·작업 경로·모델은
        // 실행에 쓰이지 않으므로 저장본에서 비운다.
        input.prompt = String::new();
        input.account_id = String::new();
        input.use_active_account = false;
        input.cwd = String::new();
        input.model = None;
        input.reasoning_effort = None;
        input.session_strategy = ScheduleSessionStrategy::NewChat;
    } else {
        if input.prompt.is_empty() {
            return Err(CoreError::InvalidInput(
                "반복할 요청을 입력하세요".to_owned(),
            ));
        }
        if input.prompt.len() > MAX_PROMPT_BYTES {
            return Err(CoreError::TooLarge(MAX_PROMPT_BYTES as u64));
        }
        input.account_id = input.account_id.trim().to_owned();
        if !input.source.manages_accounts() {
            // 계정 레지스트리가 담지 않는 공급자(Antigravity)에는 고정할 계정도 활성
            // 계정도 없다. 채팅 시작 경로가 계정 미귀속으로 실행하므로 저장본에서도
            // 비워 둔다 — 값이 남아 있으면 화면이 쓰이지도 않는 계정을 보여 준다.
            input.account_id = String::new();
            input.use_active_account = false;
        } else if input.use_active_account {
            // 고정 계정과 실행 시점 조회가 동시에 남으면 어느 쪽이 쓰였는지 화면에서
            // 알 수 없다. 고정 값은 지우고 실행 시점에만 활성 계정을 읽는다.
            input.account_id = String::new();
        } else if input.account_id.is_empty() {
            return Err(CoreError::InvalidInput(
                "반복 요청의 실행 계정을 선택하세요".to_owned(),
            ));
        }
        let cwd = fs::canonicalize(input.cwd.trim())?;
        if !cwd.is_dir() {
            return Err(CoreError::InvalidInput(
                "작업 경로가 폴더가 아닙니다".to_owned(),
            ));
        }
        input.cwd = cwd.to_string_lossy().into_owned();
        input.model = input
            .model
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty());
    }
    validate_recurrence(&input.recurrence)?;
    // 이미 지난 창을 저장하는 것은 막지 않는다. 뒤집힌 창만 거절한다.
    if let (Some(from), Some(until)) = (input.active_from, input.active_until) {
        if until <= from {
            return Err(CoreError::InvalidInput(
                "활성 종료 일시는 활성 시작 일시보다 뒤여야 합니다".to_owned(),
            ));
        }
    }
    if input.session_strategy == ScheduleSessionStrategy::NewChat {
        input.provider_session_id = None;
    }
    Ok(input)
}

/// 워크플로 대상을 정리하고, 이 반복 요청이 워크플로 회차인지 알려준다. 승인 버전과
/// 카탈로그 호환성은 실행 통로가 확인하므로 여기서는 형식만 본다.
fn validate_workflow_action(
    action: Option<&mut ScheduleWorkflowAction>,
) -> Result<bool, CoreError> {
    let Some(action) = action else {
        return Ok(false);
    };
    action.workflow_id = action.workflow_id.trim().to_owned();
    if action.workflow_id.is_empty() {
        return Err(CoreError::InvalidInput(
            "실행할 워크플로를 선택하세요".to_owned(),
        ));
    }
    if action.approved_version == 0 {
        return Err(CoreError::InvalidInput(
            "워크플로 승인 버전이 없습니다. 워크플로를 다시 선택해 승인하세요".to_owned(),
        ));
    }
    if !action.arguments.is_object() {
        return Err(CoreError::InvalidInput(
            "워크플로 입력값은 객체여야 합니다".to_owned(),
        ));
    }
    if action
        .pacing
        .as_ref()
        .is_some_and(|pacing| pacing.max_runs == 0)
    {
        return Err(CoreError::InvalidInput(
            "병렬 실행 건수는 1 이상이어야 합니다".to_owned(),
        ));
    }
    Ok(true)
}

/// 워크플로 회차는 프롬프트가 없어 세션 참조를 붙일 곳이 없다. 저장해 두면 화면에는
/// 참조 범위가 보이는데 실행은 아무 세션도 읽지 않는 상태가 된다.
fn drop_unused_session_reference(input: &mut ScheduledRequestInput) {
    if input.workflow.is_some() {
        input.session_reference = None;
    }
}

fn validate_recurrence(recurrence: &ScheduleRecurrence) -> Result<(), CoreError> {
    // Auto는 간격을 쓰지 않는다. 화면이 hourly 시절 상태로 남긴 값이 범위를 벗어나도
    // 저장을 막을 이유가 없다.
    if recurrence.frequency != ScheduleFrequency::Auto
        && (recurrence.interval == 0 || recurrence.interval > 168)
    {
        return Err(CoreError::InvalidInput(
            "반복 간격은 1~168이어야 합니다".to_owned(),
        ));
    }
    if recurrence.hour > 23 || recurrence.minute > 59 || recurrence.weekday > 6 {
        return Err(CoreError::InvalidInput(
            "반복 시각이 올바르지 않습니다".to_owned(),
        ));
    }
    recurrence
        .timezone
        .parse::<Tz>()
        .map_err(|_| CoreError::InvalidInput("시간대를 확인할 수 없습니다".to_owned()))?;
    // Auto는 벽시계 정렬이 없는 간격 기반이라 Cron 표현식을 만들지 않는다.
    if recurrence.frequency != ScheduleFrequency::Auto {
        schedule_expression(recurrence)?;
    }
    Ok(())
}

/// "자동" 주기 해석기. 예산 정책과 페이싱 저장소를 읽으므로 스케줄러 저장소 락
/// **밖에서** 만들어야 한다 — 정책의 seed 경로가 반대 순서로 스케줄러 저장소를 읽어,
/// 락 안에서 부르면 ABBA 교착이 된다.
fn auto_cadence(app_data_dir: &Path) -> crate::usage_pacing::AutoCadence {
    crate::usage_pacing::AutoCadence::load(app_data_dir)
}

/// 이 반복 요청이 자동 주기로 도는 워크플로. 자동 주기는 워크플로마다 다르게 나오고,
/// 다른 주기는 이 값을 쓰지 않으므로 해석(표본 저장소 읽기)도 건너뛴다.
fn auto_workflow_id(input: &ScheduledRequestInput) -> Option<&str> {
    if input.recurrence.frequency != ScheduleFrequency::Auto {
        return None;
    }
    input
        .workflow
        .as_ref()
        .map(|action| action.workflow_id.as_str())
}

/// 지금이 이 반복 요청의 활성 창 안인지. 창을 지정하지 않은 반복 요청은 언제나 열려
/// 있다. 예약 실행만 이 판정을 따르고 수동 실행은 창과 무관하게 나간다.
fn active_window_open(input: &ScheduledRequestInput, now: i64) -> bool {
    if input.active_from.is_some_and(|from| now < from) {
        return false;
    }
    !input.active_until.is_some_and(|until| now > until)
}

/// 활성 창과 페이싱 스케줄을 반영한 다음 실행 시각. 활성 시작 이전의 발화는 건너뛰고 시작
/// 이후 첫 발화를 고른다. 계산 결과가 활성 종료를 넘어도 그대로 둔다 — 그 시각에는 창이 닫혀
/// claim되지 않고, 사용자가 종료를 미루면 저장된 값이 다시 유효해진다.
///
/// `quiet`(페이싱 회차의 제한 시간대)가 있으면 결과를 제한 밖으로 옮긴다. 자동 주기는 기준
/// 시각이 제한 중이면 **재개 시각이 첫 회차**(활성 시작과 같은 규칙)이고, 열린 시간에 계산한
/// 다음 실행이 제한 안에 떨어지면 그 구간의 재개 시각으로 붙는다. 벽시계 주기도 제한 안의
/// 발화는 재개 시각으로 미룬다(건너뛰면 "매일 12시" 회차가 체크 안 한 요일에만 돈다).
fn next_run_in_window(
    input: &ScheduledRequestInput,
    after_ms: i64,
    auto_minutes: u32,
    quiet: Option<&QuietSchedule>,
) -> Result<i64, CoreError> {
    let auto = input.recurrence.frequency == ScheduleFrequency::Auto;
    let after = match input.active_from {
        // 자동 주기는 벽시계 정렬이 없어 창이 열리는 순간이 그대로 첫 회차다.
        Some(from) if from > after_ms => {
            if auto {
                return Ok(quiet.map_or(from, |quiet| quiet.resume_at(from)));
            }
            from.saturating_sub(1)
        }
        _ => after_ms,
    };
    let Some(quiet) = quiet else {
        return next_run_after(&input.recurrence, after, auto_minutes);
    };
    if auto && quiet.blocked_at(after) {
        return Ok(quiet.resume_at(after));
    }
    Ok(quiet.resume_at(next_run_after(&input.recurrence, after, auto_minutes)?))
}

fn next_run_after(
    recurrence: &ScheduleRecurrence,
    after_ms: i64,
    auto_minutes: u32,
) -> Result<i64, CoreError> {
    if recurrence.frequency == ScheduleFrequency::Auto {
        return Ok(after_ms.saturating_add(i64::from(auto_minutes.max(1)) * 60_000));
    }
    let timezone = recurrence
        .timezone
        .parse::<Tz>()
        .map_err(|_| CoreError::InvalidInput("시간대를 확인할 수 없습니다".to_owned()))?;
    let expression = schedule_expression(recurrence)?;
    let schedule = Schedule::from_str(&expression).map_err(|error| {
        CoreError::InvalidInput(format!("Cron 표현식이 올바르지 않습니다: {error}"))
    })?;
    let after = DateTime::<Utc>::from_timestamp_millis(after_ms)
        .ok_or_else(|| CoreError::InvalidInput("기준 시각이 올바르지 않습니다".to_owned()))?
        .with_timezone(&timezone);
    schedule
        .after(&after)
        .next()
        .map(|next| next.timestamp_millis())
        .ok_or_else(|| CoreError::InvalidInput("다음 실행 시각을 계산할 수 없습니다".to_owned()))
}

/// 반복 규칙의 평균 간격(분). 고정 규칙은 달력상의 평균을 바로 쓰고, 임의 Cron은
/// 다음 발생 시각들을 실제 시간대에서 펼쳐 불규칙한 평일·월말·DST 간격까지 평균낸다.
///
/// 저장 시 검증된 규칙을 조회 화면과 페이싱 계산에서 다시 읽는 경로라, 손상된 저장본은
/// `None`으로 돌려 처리량을 근거 없이 낙관하지 않는다. 올림하는 것도 같은 이유다.
pub(crate) fn recurrence_average_minutes(
    recurrence: &ScheduleRecurrence,
    after_ms: i64,
    auto_minutes: u32,
) -> Option<u32> {
    let interval = recurrence.interval.max(1);
    match recurrence.frequency {
        ScheduleFrequency::Hourly => Some(interval.saturating_mul(60)),
        ScheduleFrequency::Daily => Some(interval.saturating_mul(24 * 60)),
        ScheduleFrequency::Weekdays => Some(interval.saturating_mul(7 * 24 * 60 / 5)),
        ScheduleFrequency::Weekly => Some(interval.saturating_mul(7 * 24 * 60)),
        ScheduleFrequency::Auto => Some(auto_minutes.max(1)),
        ScheduleFrequency::Cron => {
            const GAPS: usize = 64;
            let timezone = recurrence.timezone.parse::<Tz>().ok()?;
            let expression = schedule_expression(recurrence).ok()?;
            let schedule = Schedule::from_str(&expression).ok()?;
            let after = DateTime::<Utc>::from_timestamp_millis(after_ms)?.with_timezone(&timezone);
            let occurrences: Vec<i64> = schedule
                .after(&after)
                .take(GAPS + 1)
                .map(|next| next.timestamp_millis())
                .collect();
            if occurrences.len() < 2 {
                return None;
            }
            let first = i128::from(*occurrences.first()?);
            let last = i128::from(*occurrences.last()?);
            let gaps = i128::try_from(occurrences.len() - 1).ok()?;
            let denominator = gaps.saturating_mul(60_000);
            let span = last.saturating_sub(first);
            if span <= 0 || denominator <= 0 {
                return None;
            }
            let minutes = span.saturating_add(denominator - 1) / denominator;
            Some(u32::try_from(minutes).unwrap_or(u32::MAX).max(1))
        }
    }
}

fn schedule_expression(recurrence: &ScheduleRecurrence) -> Result<String, CoreError> {
    let five = match recurrence.frequency {
        ScheduleFrequency::Hourly => {
            format!("{} */{} * * *", recurrence.minute, recurrence.interval)
        }
        ScheduleFrequency::Daily => {
            format!(
                "{} {} */{} * *",
                recurrence.minute, recurrence.hour, recurrence.interval
            )
        }
        ScheduleFrequency::Weekdays => {
            format!("{} {} * * 1-5", recurrence.minute, recurrence.hour)
        }
        ScheduleFrequency::Weekly => format!(
            "{} {} * * {}",
            recurrence.minute, recurrence.hour, recurrence.weekday
        ),
        ScheduleFrequency::Cron => recurrence
            .cron
            .as_deref()
            .map(str::trim)
            .filter(|cron| !cron.is_empty())
            .ok_or_else(|| CoreError::InvalidInput("Cron 표현식을 입력하세요".to_owned()))?
            .to_owned(),
        // Auto는 벽시계 정렬이 없어 next_run_after가 간격으로 직접 계산한다.
        ScheduleFrequency::Auto => {
            return Err(CoreError::InvalidInput(
                "자동 주기는 Cron으로 표현하지 않습니다".to_owned(),
            ))
        }
    };
    if five.split_whitespace().count() != 5 {
        return Err(CoreError::InvalidInput(
            "Cron은 분 시 일 월 요일의 5개 필드여야 합니다".to_owned(),
        ));
    }
    Ok(format!("0 {five}"))
}

/// 레거시 5단계 페이싱 계약을 회차 봉투 계약으로 이관한 뒤, 그 워크플로를 도는 반복 요청을
/// 새 버전에 맞춘다: 승인 버전을 올리고, 계약 입력이던 `maxRuns`를 반복 요청의 병렬 실행
/// 설정으로 옮긴다(인자에 없으면 옛 계약의 기본값, 그것도 없으면 1). 시스템이 결정적으로
/// 만든 버전이라 사용자 재승인을 요구하지 않는다. 맞춘 반복 요청 수를 돌려준다.
///
/// 실행기(SchedulerSupervisor)가 뜨기 **전에** 부른다 — 감독자는 만들어지는 순간 실행 루프를
/// 돌려 만기 회차를 바로 집는데, 그때 반복 요청이 옛 버전에 묶여 있으면 이관 전의 계약으로
/// 실패한 회차 기록이 남는다.
pub fn migrate_paced_bindings(
    app_data_dir: &Path,
    workflow_id: &str,
    legacy_version: u32,
    version: u32,
    legacy_max_runs_default: Option<u32>,
) -> Result<usize, CoreError> {
    let now = now_ms();
    with_store(app_data_dir, |store| {
        let mut count = 0usize;
        for schedule in store.schedules.iter_mut() {
            let Some(action) = schedule.input.workflow.as_mut() else {
                continue;
            };
            // 옮긴 옛 버전에 묶인 회차만 올린다. 그보다 옛 버전에 묶여 재승인을 기다리던
            // 회차를 함께 올리면 사용자가 보지 않은 변경을 승인한 셈이 된다.
            if action.workflow_id != workflow_id || action.approved_version != legacy_version {
                continue;
            }
            let legacy_max_runs = action
                .arguments
                .as_object_mut()
                .and_then(|arguments| arguments.remove("maxRuns"))
                .as_ref()
                .and_then(crate::system_workflows::max_runs_from_value);
            let max_runs = legacy_max_runs
                .or(legacy_max_runs_default)
                .unwrap_or(DEFAULT_MAX_RUNS)
                .max(1);
            action.pacing = Some(SchedulePacing { max_runs });
            action.approved_version = version;
            schedule.updated_at = now;
            count += 1;
        }
        Ok(count)
    })
}

fn with_store<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut SchedulerStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let lock = open_lock(&app_data_dir.join(STORE_LOCK_FILE))?;
    FileExt::lock(&lock)?;
    let mut store = load_store_unlocked(app_data_dir)?;
    let result = action(&mut store)?;
    save_store_unlocked(app_data_dir, &store)?;
    Ok(result)
}

fn read_store(app_data_dir: &Path) -> Result<SchedulerStore, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let lock = open_lock(&app_data_dir.join(STORE_LOCK_FILE))?;
    FileExt::lock(&lock)?;
    load_store_unlocked(app_data_dir)
}

fn load_store_unlocked(app_data_dir: &Path) -> Result<SchedulerStore, CoreError> {
    read_private_json_or_default(&app_data_dir.join(STORE_FILE_NAME))
}

/// 반복 요청이 가리킨 작업 경로를 세션 출처의 schedule id와 연결한다. 워크플로 회차는
/// 실행 필드가 비어 있으므로 고정 인자 `projectPath`를 쓰고, 일반 반복 요청은 cwd를 쓴다.
fn backfill_scheduled_session_working_directories(app_data_dir: &Path) -> Result<usize, CoreError> {
    let scheduler_store = read_store(app_data_dir)?;
    let working_directories = scheduler_store
        .schedules
        .iter()
        .filter_map(|schedule| {
            let workflow_path = schedule
                .input
                .workflow
                .as_ref()
                .and_then(|workflow| workflow.arguments.get("projectPath"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty());
            let cwd = workflow_path.unwrap_or_else(|| schedule.input.cwd.trim());
            (!cwd.is_empty()).then(|| (schedule.id.clone(), PathBuf::from(cwd)))
        })
        .collect::<HashMap<_, _>>();
    store::backfill_scheduled_session_working_directories(app_data_dir, &working_directories)
}

fn save_store_unlocked(app_data_dir: &Path, store: &SchedulerStore) -> Result<(), CoreError> {
    write_private_json(&app_data_dir.join(STORE_FILE_NAME), store)
}

fn open_lock(path: &Path) -> Result<File, CoreError> {
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .map_err(CoreError::Io)
}

fn trim_runs(store: &mut SchedulerStore) {
    let mut kept = Vec::new();
    let mut counts = HashMap::<String, usize>::new();
    for run in store.runs.iter().rev() {
        let count = counts.entry(run.schedule_id.clone()).or_default();
        if *count < MAX_RUNS_PER_SCHEDULE {
            kept.push(run.clone());
            *count += 1;
        }
    }
    kept.reverse();
    store.runs = kept;
}

fn sorted_schedules(mut schedules: Vec<ScheduledRequest>) -> Vec<ScheduledRequest> {
    schedules.sort_by_key(|schedule| schedule.created_at);
    schedules
}

fn sorted_runs(mut runs: Vec<ScheduleRun>) -> Vec<ScheduleRun> {
    runs.sort_by_key(|run| std::cmp::Reverse(run.scheduled_for));
    runs
}

fn clean_summary(summary: String) -> Option<String> {
    let summary = summary.trim().chars().take(2_000).collect::<String>();
    (!summary.is_empty()).then_some(summary)
}

const fn default_interval() -> u32 {
    1
}
const fn default_weekday() -> u8 {
    1
}
const fn default_enabled() -> bool {
    true
}
const fn default_schedule_approval_mode() -> ChatApprovalMode {
    ChatApprovalMode::Never
}

#[cfg(test)]
mod tests {
    use std::time::UNIX_EPOCH;

    use super::*;
    use serde_json::json;

    fn recurrence(frequency: ScheduleFrequency) -> ScheduleRecurrence {
        ScheduleRecurrence {
            frequency,
            interval: 1,
            hour: 9,
            minute: 30,
            weekday: 1,
            cron: None,
            timezone: "Asia/Seoul".to_owned(),
        }
    }

    fn input(cwd: &Path) -> ScheduledRequestInput {
        ScheduledRequestInput {
            name: "매일 점검".to_owned(),
            prompt: "상태를 점검해줘".to_owned(),
            source: ProviderId::Codex,
            account_id: "codex-account-1".to_owned(),
            use_active_account: false,
            cwd: cwd.to_string_lossy().into_owned(),
            model: None,
            reasoning_effort: None,
            mode: ChatMode::Workspace,
            approval_mode: ChatApprovalMode::AutoReview,
            recurrence: recurrence(ScheduleFrequency::Daily),
            session_strategy: ScheduleSessionStrategy::Continue,
            resume_failure_policy: ResumeFailurePolicy::RetryThenNewChat,
            provider_session_id: Some("thread-123".to_owned()),
            enabled: true,
            session_reference: None,
            session_reference_replace_manual: false,
            workflow: None,
            active_from: None,
            active_until: None,
        }
    }

    fn test_supervisor(app_data_dir: &Path, chats: ChatSupervisor) -> SchedulerSupervisor {
        SchedulerSupervisor::new_without_background_runner(app_data_dir.to_path_buf(), chats)
            .expect("scheduler test supervisor")
    }

    #[test]
    fn scheduler_start_backfills_scheduled_session_working_directories() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data_dir = temp.path().join("app-data");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&app_data_dir).expect("app data directory must exist");
        fs::create_dir_all(&workspace).expect("workspace must exist");
        let mut request = workflow_input(&workspace);
        request.cwd.clear();
        request
            .workflow
            .as_mut()
            .expect("workflow must exist")
            .arguments = json!({"projectPath": workspace.to_string_lossy()});
        save_store_unlocked(
            &app_data_dir,
            &SchedulerStore {
                schedules: vec![ScheduledRequest {
                    id: "schedule-123".to_owned(),
                    input: request,
                    created_at: 1,
                    updated_at: 1,
                    next_run_at: i64::MAX,
                    last_run_at: None,
                    manual_run_requested_at: None,
                }],
                ..SchedulerStore::default()
            },
        )
        .expect("scheduler store must save");
        store::persist_session_origin(
            &app_data_dir,
            ProviderId::Antigravity,
            "session-1234567890",
            &ChatOrigin {
                kind: ChatOriginKind::Workflow,
                workflow_id: Some("wf-usage".to_owned()),
                execution_id: Some("execution-123".to_owned()),
                schedule_id: Some("schedule-123".to_owned()),
                run_id: Some("run-123".to_owned()),
                consumer_id: Some("schedule-123".to_owned()),
            },
        )
        .expect("session origin must save");

        let _supervisor = test_supervisor(&app_data_dir, ChatSupervisor::new());

        let metadata = store::load_metadata(&app_data_dir).expect("metadata must load");
        assert_eq!(
            metadata.session_working_directories["antigravity:session-1234567890"],
            fs::canonicalize(workspace)
                .expect("workspace must canonicalize")
                .to_string_lossy()
        );
    }

    #[test]
    fn preview_snapshot_truncates_bodies_and_keeps_full_text_in_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let mut long = input(temp.path());
        long.prompt = "가".repeat(4_000);
        let schedule = supervisor.create(long, SessionReadActor::User).unwrap();
        let mut run = schedule_run(&schedule);
        run.status = ScheduleRunStatus::Completed;
        run.summary = Some("결과".repeat(4_000));
        with_store(temp.path(), |store| {
            store.runs.push(run.clone());
            Ok(())
        })
        .unwrap();

        let preview = supervisor.preview_snapshot().unwrap();
        let previewed_prompt = &preview.schedules[0].input.prompt;
        let previewed_summary = preview.runs[0].summary.as_deref().unwrap();
        assert!(previewed_prompt.len() <= PREVIEW_BYTES);
        assert!(previewed_summary.len() <= PREVIEW_BYTES);
        assert!(previewed_prompt.ends_with("…[truncated]"));
        assert!(previewed_summary.ends_with("…[truncated]"));

        // 전문 경로는 그대로 남아야 한다. 상세 조회와 스케줄러 내부 로직이 이를 쓴다.
        let full = supervisor.snapshot().unwrap();
        assert_eq!(full.schedules[0].input.prompt.chars().count(), 4_000);
        assert_eq!(
            full.runs[0].summary.as_deref().unwrap().chars().count(),
            8_000
        );
    }

    #[test]
    fn preview_snapshot_leaves_short_bodies_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(temp.path()), SessionReadActor::User)
            .unwrap();
        let mut run = schedule_run(&schedule);
        run.summary = Some("짧은 결과".to_owned());
        run.error = Some("짧은 오류".to_owned());
        with_store(temp.path(), |store| {
            store.runs.push(run);
            Ok(())
        })
        .unwrap();

        let preview = supervisor.preview_snapshot().unwrap();
        assert_eq!(preview.schedules[0].input.prompt, schedule.input.prompt);
        assert_eq!(preview.runs[0].summary.as_deref(), Some("짧은 결과"));
        // 오류 본문은 목록에서 바로 보여주므로 자르지 않는다.
        assert_eq!(preview.runs[0].error.as_deref(), Some("짧은 오류"));
    }

    /// 세션 참조를 모르던 저장본은 정책 없이 읽히고, 저장 형태도 예전과 같아야 한다.
    /// 마이그레이션으로 세션 참조가 켜지는 일은 없다.
    #[test]
    fn schedules_saved_before_session_reference_stay_disabled_and_byte_compatible() {
        let legacy = json!({
            "name": "예전 반복 요청",
            "prompt": "보고서 작성",
            "source": "codex",
            "accountId": "acc-1",
            "cwd": "/tmp",
            "model": null,
            "mode": "workspace",
            "recurrence": {"frequency": "daily", "hour": 9, "minute": 0, "timezone": "UTC"},
            "sessionStrategy": "newChat",
            "resumeFailurePolicy": "pause"
        });
        let parsed: ScheduledRequestInput = serde_json::from_value(legacy).unwrap();
        assert!(parsed.session_reference.is_none());
        assert!(!parsed.session_reference_replace_manual);
        // 정책이 없으면 직렬화에도 나타나지 않아, 저장 파일이 예전과 동일하게 남는다.
        let round_trip = serde_json::to_value(&parsed).unwrap();
        assert!(round_trip.get("sessionReference").is_none());
        assert!(round_trip.get("sessionReferenceReplaceManual").is_none());
    }

    /// 요청 전용 플래그는 저장되지 않는다. 저장본을 다시 읽어도 AIA가 예전에 보낸
    /// 덮어쓰기 승인이 되살아나지 않아야 한다.
    #[test]
    fn the_replace_manual_flag_is_never_persisted() {
        let mut request = input(Path::new("/tmp"));
        request.session_reference_replace_manual = true;
        let stored = serde_json::to_value(&request).unwrap();
        assert!(stored.get("sessionReferenceReplaceManual").is_none());
        let parsed: ScheduledRequestInput = serde_json::from_value(stored).unwrap();
        assert!(!parsed.session_reference_replace_manual);
    }

    /// 실행 이력도 세션 참조 기록을 모르던 저장본을 그대로 읽는다.
    #[test]
    fn runs_saved_before_session_reference_still_load() {
        let mut value = serde_json::to_value(schedule_run(&ScheduledRequest {
            id: "schedule-1".to_owned(),
            input: input(Path::new("/tmp")),
            created_at: 0,
            updated_at: 0,
            next_run_at: 0,
            last_run_at: None,
            manual_run_requested_at: None,
        }))
        .unwrap();
        value.as_object_mut().unwrap().remove("sessionReference");
        let parsed: ScheduleRun = serde_json::from_value(value).unwrap();
        assert!(parsed.session_reference.is_none());
    }

    #[test]
    fn user_saved_session_reference_is_manual_and_aia_must_ask_before_replacing() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let mut request = input(temp.path());
        request.session_reference = Some(SessionReadSettings {
            policy: crate::SessionReadPolicy {
                enabled: true,
                project_scope: crate::SessionReadProjectScope::AllRegistered,
                providers: vec![ProviderId::Codex],
                detail: crate::SessionReadDetail::WorkRationale,
                max_sessions: 100,
                ..Default::default()
            },
            ..Default::default()
        });
        let created = supervisor
            .create(request.clone(), SessionReadActor::User)
            .unwrap();
        let stored = created.input.session_reference.clone().unwrap();
        assert_eq!(stored.origin, crate::SessionReadOrigin::Manual);
        assert!(stored.policy.enabled);

        // AIA가 다른 정책으로 바꾸려면 명시적 승인이 필요하다.
        let mut aia_request = input(temp.path());
        aia_request.session_reference = Some(SessionReadSettings {
            policy: crate::SessionReadPolicy {
                enabled: true,
                detail: crate::SessionReadDetail::LimitedTranscript,
                ..Default::default()
            },
            ..Default::default()
        });
        let refused = supervisor
            .update(&created.id, aia_request.clone(), SessionReadActor::Aia)
            .expect_err("AIA는 사용자 설정을 조용히 덮어쓸 수 없다");
        assert!(refused.to_string().contains("사용자가 직접 지정"));

        aia_request.session_reference_replace_manual = true;
        let replaced = supervisor
            .update(&created.id, aia_request, SessionReadActor::Aia)
            .unwrap();
        let settings = replaced.input.session_reference.unwrap();
        assert_eq!(settings.origin, crate::SessionReadOrigin::Aia);
        assert_eq!(
            settings.policy.detail,
            crate::SessionReadDetail::LimitedTranscript
        );
    }

    /// 세션 참조를 모르는 클라이언트가 다른 항목만 고쳐도 저장된 정책은 남는다.
    #[test]
    fn updating_without_the_field_keeps_the_stored_session_reference() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let mut request = input(temp.path());
        request.session_reference = Some(SessionReadSettings {
            policy: crate::SessionReadPolicy {
                enabled: true,
                max_sessions: 33,
                ..Default::default()
            },
            ..Default::default()
        });
        let created = supervisor.create(request, SessionReadActor::User).unwrap();
        let mut legacy_edit = input(temp.path());
        legacy_edit.name = "이름만 변경".to_owned();
        let updated = supervisor
            .update(&created.id, legacy_edit, SessionReadActor::User)
            .unwrap();
        let settings = updated
            .input
            .session_reference
            .expect("정책이 유지되어야 한다");
        assert!(settings.policy.enabled);
        assert_eq!(settings.policy.max_sessions, 33);
    }

    /// 계정 전환 옵션을 저장해 둔 예전 반복 요청도 그대로 읽혀야 한다. 두 필드는
    /// 사라졌지만 저장본에는 남아 있다.
    #[test]
    fn stored_schedules_with_removed_switch_options_still_load() {
        let mut value = serde_json::to_value(input(Path::new("/tmp"))).unwrap();
        let object = value.as_object_mut().unwrap();
        object.insert("autoSwitchWhenIdle".to_owned(), json!(true));
        object.insert("forceSessionCleanup".to_owned(), json!(true));
        let parsed: ScheduledRequestInput = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.account_id, "codex-account-1");
    }

    fn schedule_run(schedule: &ScheduledRequest) -> ScheduleRun {
        ScheduleRun {
            id: "run-test".to_owned(),
            schedule_id: schedule.id.clone(),
            scheduled_for: now_ms(),
            started_at: None,
            finished_at: None,
            status: ScheduleRunStatus::WaitingForAccount,
            requested_account_id: schedule.input.account_id.clone(),
            actual_account_id: None,
            provider_session_id: None,
            previous_provider_session_id: schedule.input.provider_session_id.clone(),
            session_replaced: false,
            retry_count: 0,
            summary: None,
            error: None,
            last_heartbeat_at: None,
            cancellation_requested_at: None,
            recovery_error: None,
            manual: false,
            document_trigger: None,
            session_reference: None,
            round: None,
        }
    }

    /// 워크플로 검증·실행 결과를 시험이 정하는 통로. 회차마다 받은 멱등 키를 남긴다.
    struct FakeWorkflows {
        reject: Option<String>,
        succeed: bool,
        keys: Mutex<Vec<String>>,
        manual_runs: Mutex<Vec<bool>>,
    }

    impl FakeWorkflows {
        fn new(reject: Option<&str>, succeed: bool) -> Arc<Self> {
            Arc::new(Self {
                reject: reject.map(str::to_owned),
                succeed,
                keys: Mutex::new(Vec::new()),
                manual_runs: Mutex::new(Vec::new()),
            })
        }
    }

    impl ScheduleWorkflowExecutor for FakeWorkflows {
        fn validate_workflow(&self, _action: &ScheduleWorkflowAction) -> Result<(), CoreError> {
            match self.reject.as_ref() {
                Some(reason) => Err(CoreError::Conflict(reason.clone())),
                None => Ok(()),
            }
        }

        fn execute_workflow(
            &self,
            action: &ScheduleWorkflowAction,
            idempotency_key: &str,
            _trigger: &WorkflowTrigger,
            manual_run: bool,
        ) -> Result<Value, CoreError> {
            self.keys.lock().unwrap().push(idempotency_key.to_owned());
            self.manual_runs.lock().unwrap().push(manual_run);
            let error = if self.succeed {
                Value::Null
            } else {
                json!("작업이 거절되었습니다")
            };
            Ok(json!({
                "workflowId": action.workflow_id,
                "version": action.approved_version,
                "executionId": "wfexec-test",
                "succeeded": self.succeed,
                "failedStepId": if self.succeed { Value::Null } else { json!("step-2") },
                "failure": error.clone(),
                "steps": [
                    {"stepId": "step-1", "operation": "list_provider_accounts", "status": "succeeded", "error": Value::Null},
                    {"stepId": "step-2", "operation": "list_scheduled_requests", "status": if self.succeed { "succeeded" } else { "failed" }, "error": error},
                ],
            }))
        }
    }

    fn workflow_input(cwd: &Path) -> ScheduledRequestInput {
        let mut request = input(cwd);
        request.workflow = Some(ScheduleWorkflowAction {
            workflow_id: " wf-usage ".to_owned(),
            approved_version: 3,
            arguments: json!({"provider": "codex"}),
            pacing: None,
        });
        request
    }

    fn workflow_inner(
        app_data_dir: &Path,
        executor: Arc<dyn ScheduleWorkflowExecutor>,
    ) -> Arc<SchedulerInner> {
        Arc::new(SchedulerInner {
            app_data_dir: app_data_dir.to_path_buf(),
            accounts: None,
            chats: ChatSupervisor::new(),
            stop: AtomicBool::new(false),
            runner_active: false,
            _runner_lock: None,
            running: Mutex::new(HashSet::new()),
            executions: Mutex::new(HashMap::new()),
            subscriber: Mutex::new(None),
            workflows: Mutex::new(Some(executor)),
        })
    }

    /// 저장된 워크플로 반복 요청과 그 회차를 store에 넣고 실행 대상으로 돌려준다.
    fn stored_workflow_claim(app_data_dir: &Path) -> ClaimedRun {
        let now = now_ms();
        let schedule = ScheduledRequest {
            id: "schedule-workflow".to_owned(),
            input: validate_input(workflow_input(app_data_dir)).expect("워크플로 입력"),
            created_at: now,
            updated_at: now,
            next_run_at: now + 60_000,
            last_run_at: None,
            manual_run_requested_at: None,
        };
        let run = schedule_run(&schedule);
        with_store(app_data_dir, |store| {
            store.schedules.push(schedule.clone());
            store.runs.push(run.clone());
            Ok(())
        })
        .unwrap();
        ClaimedRun { schedule, run }
    }

    #[test]
    fn a_workflow_schedule_drops_the_chat_only_fields_and_needs_no_account() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        supervisor
            .set_workflow_executor(FakeWorkflows::new(None, true))
            .unwrap();
        let mut request = workflow_input(temp.path());
        request.account_id = String::new();
        request.cwd = "/없는/경로".to_owned();
        request.prompt = "  ".to_owned();
        request.session_reference = Some(SessionReadSettings {
            policy: crate::SessionReadPolicy {
                enabled: true,
                ..Default::default()
            },
            ..Default::default()
        });
        let saved = supervisor.create(request, SessionReadActor::User).unwrap();
        let action = saved.input.workflow.as_ref().expect("워크플로 대상");
        assert_eq!(action.workflow_id, "wf-usage");
        assert_eq!(action.approved_version, 3);
        assert!(saved.input.prompt.is_empty());
        assert!(saved.input.cwd.is_empty());
        assert!(saved.input.account_id.is_empty());
        assert!(!saved.input.use_active_account);
        assert!(saved.input.session_reference.is_none());
        assert_eq!(
            saved.input.session_strategy,
            ScheduleSessionStrategy::NewChat
        );
        assert!(saved.input.provider_session_id.is_none());
    }

    #[test]
    fn legacy_paced_bindings_move_max_runs_into_pacing_and_bump_the_version() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        supervisor
            .set_workflow_executor(FakeWorkflows::new(None, true))
            .unwrap();
        // 인자에 maxRuns가 있는 회차(실수 표기), 없는 회차(옛 계약 기본값을 받음), 더 옛 버전에
        // 묶여 재승인을 기다리는 회차, 다른 워크플로의 회차.
        let mut with_max = workflow_input(temp.path());
        with_max.workflow.as_mut().unwrap().arguments =
            json!({"provider": "codex", "maxRuns": 4.0});
        let with_max = supervisor.create(with_max, SessionReadActor::User).unwrap();
        let mut without = workflow_input(temp.path());
        without.enabled = false;
        let without = supervisor.create(without, SessionReadActor::User).unwrap();
        let mut stale = workflow_input(temp.path());
        stale.enabled = false;
        stale.workflow.as_mut().unwrap().approved_version = 2;
        stale.workflow.as_mut().unwrap().arguments = json!({"provider": "codex", "maxRuns": 3});
        let stale = supervisor.create(stale, SessionReadActor::User).unwrap();
        let mut other = workflow_input(temp.path());
        other.workflow.as_mut().unwrap().workflow_id = "wf-other".to_owned();
        let other = supervisor.create(other, SessionReadActor::User).unwrap();
        // 옛 상한(12)을 넘는 인자도 그대로 옮긴다 — 병렬 실행에는 상한이 없다.
        let mut big = workflow_input(temp.path());
        big.enabled = false;
        big.workflow.as_mut().unwrap().arguments = json!({"provider": "codex", "maxRuns": 20});
        let big = supervisor.create(big, SessionReadActor::User).unwrap();

        let moved = migrate_paced_bindings(temp.path(), "wf-usage", 3, 4, Some(2)).unwrap();
        assert_eq!(moved, 3);
        let schedules = supervisor.snapshot().unwrap().schedules;
        let binding = |id: &str| {
            schedules
                .iter()
                .find(|schedule| schedule.id == id)
                .and_then(|schedule| schedule.input.workflow.clone())
                .expect("workflow binding")
        };
        let a = binding(&with_max.id);
        assert_eq!(a.approved_version, 4);
        assert_eq!(a.pacing, Some(SchedulePacing { max_runs: 4 }));
        assert!(a.arguments.get("maxRuns").is_none());
        assert_eq!(a.arguments["provider"], "codex");
        let b = binding(&without.id);
        assert_eq!(b.approved_version, 4);
        assert_eq!(b.max_runs(), 2);
        // v2에 묶인 회차는 사용자가 v3을 승인한 적이 없으므로 그대로 둔다.
        let c = binding(&stale.id);
        assert_eq!(c.approved_version, 2);
        assert!(c.pacing.is_none());
        assert_eq!(c.arguments["maxRuns"], 3);
        let d = binding(&other.id);
        assert_eq!(d.approved_version, 3);
        assert!(d.pacing.is_none());
        let e = binding(&big.id);
        assert_eq!(e.approved_version, 4);
        assert_eq!(e.pacing, Some(SchedulePacing { max_runs: 20 }));
        // 다시 돌려도 이미 새 버전인 회차는 건드리지 않는다.
        assert_eq!(
            migrate_paced_bindings(temp.path(), "wf-usage", 3, 4, Some(2)).unwrap(),
            0
        );
        // 저장 검증은 하한(1)만 지킨다. 상한은 없다 — 실제 동시 건수는 계획이 계정 여력으로
        // 자르므로 13건도 그대로 저장된다.
        let mut zero = workflow_input(temp.path());
        zero.workflow.as_mut().unwrap().pacing = Some(SchedulePacing { max_runs: 0 });
        zero.workflow.as_mut().unwrap().workflow_id = "wf-third".to_owned();
        assert!(matches!(
            supervisor.create(zero, SessionReadActor::User),
            Err(CoreError::InvalidInput(message)) if message.contains("병렬 실행")
        ));
        let mut many = workflow_input(temp.path());
        many.workflow.as_mut().unwrap().pacing = Some(SchedulePacing { max_runs: 13 });
        many.workflow.as_mut().unwrap().workflow_id = "wf-third".to_owned();
        let many = supervisor.create(many, SessionReadActor::User).unwrap();
        assert_eq!(many.input.workflow.unwrap().max_runs(), 13);
    }

    #[test]
    fn a_paced_round_summary_reports_the_round_counts_and_reasoning() {
        // 기동 0건인 회차도 성공이다. 요약에 계획·기동 건수와 예산 판정 사유가 남아야 왜 안
        // 띄웠는지 기록에서 읽을 수 있다.
        let action = ScheduleWorkflowAction {
            workflow_id: "wf-usage".to_owned(),
            approved_version: 4,
            arguments: json!({}),
            pacing: Some(SchedulePacing { max_runs: 2 }),
        };
        let receipt = json!({
            "version": 4, "executionId": "wfround-abc", "succeeded": true, "paced": true,
            "steps": [
                {"stepId": "refresh", "operation": "refresh_provider_account_usages", "status": "succeeded", "error": null},
                {"stepId": "plan", "operation": "plan_usage_paced_runs", "status": "succeeded", "error": null}
            ],
            "round": {"maxRuns": 2, "plannedRuns": 0, "launchedRuns": 0, "staleRuns": 0,
                      "reasoning": ["목표 사용률 도달", "이번 회차는 기동할 계정이 없습니다"]}
        });
        let report = summarize_workflow_run(&action, &receipt);
        assert!(report.succeeded);
        assert!(
            report.summary.contains("계획 0건 · 기동 0건"),
            "{}",
            report.summary
        );
        assert!(report.summary.contains("병렬 2건"), "{}", report.summary);
        assert!(
            report.summary.contains("목표 사용률 도달"),
            "{}",
            report.summary
        );
        // 요약 본문을 파싱하지 않고도 쉰 회차를 가릴 수 있어야 한다.
        assert_eq!(
            report.round,
            Some(ScheduleRunRound {
                planned_runs: 0,
                launched_runs: 0,
                stale_runs: 0,
                max_runs: 2,
            })
        );
    }

    #[test]
    fn a_round_that_launched_work_keeps_its_launched_count() {
        let action = ScheduleWorkflowAction {
            workflow_id: "wf-usage".to_owned(),
            approved_version: 4,
            arguments: json!({}),
            pacing: Some(SchedulePacing { max_runs: 5 }),
        };
        let receipt = json!({
            "version": 4, "executionId": "wfround-def", "succeeded": true, "paced": true,
            "steps": [{"stepId": "plan", "operation": "plan_usage_paced_runs", "status": "succeeded", "error": null}],
            "round": {"maxRuns": 5, "plannedRuns": 3, "launchedRuns": 2, "staleRuns": 1, "reasoning": []}
        });
        let report = summarize_workflow_run(&action, &receipt);
        let round = report.round.expect("회차 집계");
        assert_eq!(round.planned_runs, 3);
        assert_eq!(round.launched_runs, 2);
        assert_eq!(round.stale_runs, 1);
    }

    #[test]
    fn a_workflow_run_that_is_not_paced_has_no_round_counts() {
        let action = ScheduleWorkflowAction {
            workflow_id: "wf-plain".to_owned(),
            approved_version: 1,
            arguments: json!({}),
            pacing: None,
        };
        let receipt = json!({
            "version": 1, "executionId": "wf-1", "succeeded": true, "paced": false,
            "steps": [{"stepId": "a", "operation": "put_doc", "status": "succeeded", "error": null}]
        });
        assert_eq!(summarize_workflow_run(&action, &receipt).round, None);
    }

    #[test]
    fn a_second_active_round_for_a_paced_workflow_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        supervisor
            .set_workflow_executor(FakeWorkflows::new(None, true))
            .unwrap();
        crate::usage_budget_policy::set_workflow(
            temp.path(),
            || Ok(crate::usage_budget_policy::PolicySeed::default()),
            crate::SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-usage".to_owned(),
                pacing_enabled: true,
                accounts: None,
            },
        )
        .unwrap();
        supervisor
            .create(workflow_input(temp.path()), SessionReadActor::User)
            .unwrap();
        // 같은 워크플로의 두 번째 활성 회차는 같은 작업을 두 소비자로 가르므로 거절된다.
        let error = supervisor
            .create(workflow_input(temp.path()), SessionReadActor::User)
            .expect_err("두 번째 활성 회차");
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(error.to_string().contains("활성 회차가 이미"));
        // 꺼진 채로는 저장할 수 있지만, 켜는 순간 같은 검사에 걸린다.
        let mut paused = workflow_input(temp.path());
        paused.enabled = false;
        let stored = supervisor
            .create(paused, SessionReadActor::User)
            .expect("꺼진 회차 저장");
        let error = supervisor
            .set_enabled(&stored.id, true)
            .expect_err("꺼진 회차 켜기");
        assert!(matches!(error, CoreError::Conflict(_)));
    }

    #[test]
    fn duplicate_rounds_for_an_unpaced_workflow_stay_allowed() {
        // 페이싱 밖 워크플로는 시각이 다른 트리거 여러 개가 정당하다 — 검사가 걸리면 안 된다.
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        supervisor
            .set_workflow_executor(FakeWorkflows::new(None, true))
            .unwrap();
        supervisor
            .create(workflow_input(temp.path()), SessionReadActor::User)
            .unwrap();
        supervisor
            .create(workflow_input(temp.path()), SessionReadActor::User)
            .expect("페이싱 밖 워크플로의 중복 트리거");
    }

    #[test]
    fn a_workflow_schedule_is_refused_while_no_execution_channel_is_connected() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let error = supervisor
            .create(workflow_input(temp.path()), SessionReadActor::User)
            .expect_err("검증 통로 없이는 승인 버전을 확인할 수 없다");
        assert!(error.to_string().contains("워크플로 실행 계층"));
    }

    #[test]
    fn a_workflow_target_without_an_approved_version_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        supervisor
            .set_workflow_executor(FakeWorkflows::new(None, true))
            .unwrap();
        let mut request = workflow_input(temp.path());
        request.workflow.as_mut().unwrap().approved_version = 0;
        let error = supervisor
            .create(request, SessionReadActor::User)
            .expect_err("승인 버전 없는 대상은 저장하지 않는다");
        assert!(error.to_string().contains("승인 버전"));
    }

    #[test]
    fn a_workflow_run_records_step_status_and_one_idempotency_key_per_run() {
        let temp = tempfile::tempdir().unwrap();
        let fake = FakeWorkflows::new(None, true);
        let inner = workflow_inner(temp.path(), fake.clone());
        let claimed = stored_workflow_claim(temp.path());
        execute_workflow_claim(&inner, claimed, &Arc::new(ActiveRunControl::default()));
        let store = read_store(temp.path()).unwrap();
        let run = &store.runs[0];
        assert_eq!(run.status, ScheduleRunStatus::Completed);
        let summary = run.summary.as_deref().unwrap_or_default();
        assert!(summary.contains("wf-usage v3"), "{summary}");
        assert!(summary.contains("step-1"), "{summary}");
        assert!(run.error.is_none());
        assert!(store.schedules[0].input.enabled);
        assert_eq!(
            fake.keys.lock().unwrap().as_slice(),
            ["schedule-workflow-run-test".to_owned()]
        );
        assert_eq!(fake.manual_runs.lock().unwrap().as_slice(), [false]);
    }

    #[test]
    fn run_now_marks_only_the_user_started_workflow_run_as_manual() {
        let temp = tempfile::tempdir().unwrap();
        let fake = FakeWorkflows::new(None, true);
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        supervisor.set_workflow_executor(fake.clone()).unwrap();
        let schedule = supervisor
            .create(workflow_input(temp.path()), SessionReadActor::User)
            .unwrap();
        supervisor.run_now(&schedule.id).unwrap();
        let mut claimed = claim_due(&supervisor.inner, now_ms()).unwrap();
        assert_eq!(claimed.len(), 1);
        execute_workflow_claim(
            &supervisor.inner,
            claimed.remove(0),
            &Arc::new(ActiveRunControl::default()),
        );
        assert_eq!(fake.manual_runs.lock().unwrap().as_slice(), [true]);
    }

    #[test]
    fn a_failed_workflow_step_fails_the_run_and_leaves_the_schedule_enabled() {
        let temp = tempfile::tempdir().unwrap();
        let inner = workflow_inner(temp.path(), FakeWorkflows::new(None, false));
        let claimed = stored_workflow_claim(temp.path());
        execute_workflow_claim(&inner, claimed, &Arc::new(ActiveRunControl::default()));
        let store = read_store(temp.path()).unwrap();
        let run = &store.runs[0];
        assert_eq!(run.status, ScheduleRunStatus::Failed);
        assert!(run.error.as_deref().unwrap().contains("단계 step-2 실패"));
        assert!(store.schedules[0].input.enabled);
    }

    /// 승인 후 워크플로가 바뀐 회차는 실행하지 않고 반복 요청을 멈춘다. 매 주기 같은
    /// 이유로 실패만 쌓이면 사용자가 재승인해야 하는 것을 알기 어렵다.
    #[test]
    fn a_workflow_changed_after_approval_pauses_the_schedule_without_running() {
        let temp = tempfile::tempdir().unwrap();
        let fake = FakeWorkflows::new(Some("워크플로가 승인 후 변경되었습니다"), true);
        let inner = workflow_inner(temp.path(), fake.clone());
        let claimed = stored_workflow_claim(temp.path());
        execute_workflow_claim(&inner, claimed, &Arc::new(ActiveRunControl::default()));
        let store = read_store(temp.path()).unwrap();
        let run = &store.runs[0];
        assert_eq!(run.status, ScheduleRunStatus::Failed);
        assert!(run.error.as_deref().unwrap().contains("일시정지"));
        assert!(!store.schedules[0].input.enabled);
        assert!(fake.keys.lock().unwrap().is_empty());
    }

    /// 워크플로 필드를 모르던 저장본은 채팅 실행으로 그대로 읽히고, 값이 없으면
    /// 직렬화 결과에도 나타나지 않는다.
    #[test]
    fn schedules_saved_before_the_workflow_field_stay_chat_runs() {
        let value = serde_json::to_value(input(Path::new("/tmp"))).unwrap();
        assert!(value.get("workflow").is_none());
        let parsed: ScheduledRequestInput = serde_json::from_value(value).unwrap();
        assert!(parsed.workflow.is_none());
        let action: ScheduleWorkflowAction =
            serde_json::from_value(json!({"workflowId": "wf-usage", "approvedVersion": 2}))
                .unwrap();
        assert_eq!(action.arguments, json!({}));
    }

    /// 프로필 격리를 쓸 수 없는 감독자. 대부분의 스케줄러 테스트는 격리 여부와
    /// 무관하므로 CLI를 띄우지 않는 기본 프로브를 쓴다.
    fn two_accounts(data: &Path, home: &Path) -> (AccountSupervisor, String, String) {
        two_accounts_with_probe(data, home, || {
            crate::credential_profiles::ProbeOutcome::Unavailable(
                "테스트에서는 CLI 프로브를 실행하지 않습니다".to_owned(),
            )
        })
    }

    /// 활성 Codex 계정 A와 비활성 계정 B를 등록한 감독자. 프로브 결과를 지정해
    /// 격리가 되는 경우와 안 되는 경우를 모두 재현한다.
    fn two_accounts_with_probe(
        data: &Path,
        home: &Path,
        outcome: fn() -> crate::credential_profiles::ProbeOutcome,
    ) -> (AccountSupervisor, String, String) {
        let codex_home = home.join(".codex");
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(
            codex_home.join("auth.json"),
            json!({"tokens": {"account_id": "account-a", "access_token": "secret-a"}}).to_string(),
        )
        .unwrap();
        let accounts = AccountSupervisor::open_for_test_with_credential_probe(
            data,
            home,
            Arc::new(move |_provider, _env| outcome()),
        )
        .unwrap();
        accounts
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap();
        fs::write(
            codex_home.join("auth.json"),
            json!({"tokens": {"account_id": "account-b", "access_token": "secret-b"}}).to_string(),
        )
        .unwrap();
        accounts
            .register_current(ProviderId::Codex, Some("B".to_owned()))
            .unwrap();
        let snapshot = accounts.snapshot().unwrap();
        let a = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-a")
            .unwrap()
            .id
            .clone();
        let b = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-b")
            .unwrap()
            .id
            .clone();
        accounts.set_default(&a).unwrap();
        (accounts, a, b)
    }

    #[test]
    fn presets_produce_future_times() {
        let after = 1_735_689_600_000_i64;
        for frequency in [
            ScheduleFrequency::Hourly,
            ScheduleFrequency::Daily,
            ScheduleFrequency::Weekdays,
            ScheduleFrequency::Weekly,
        ] {
            assert!(next_run_after(&recurrence(frequency), after, 300).unwrap() > after);
        }
    }

    #[test]
    fn auto_frequency_runs_at_the_given_interval_without_wall_alignment() {
        let after = 1_735_689_600_000_i64;
        let mut value = recurrence(ScheduleFrequency::Auto);
        assert!(validate_recurrence(&value).is_ok());
        // 화면이 간격 입력을 비운 채(0) 자동으로 전환해도 저장이 막히지 않는다.
        value.interval = 0;
        assert!(validate_recurrence(&value).is_ok());
        assert_eq!(
            next_run_after(&value, after, 300).unwrap(),
            after + 300 * 60_000
        );
    }

    #[test]
    fn five_field_cron_is_validated() {
        let mut value = recurrence(ScheduleFrequency::Cron);
        value.cron = Some("*/15 * * * *".to_owned());
        assert!(next_run_after(&value, 1_735_689_600_000, 300).is_ok());
        value.cron = Some("broken".to_owned());
        assert!(validate_recurrence(&value).is_err());
    }

    #[test]
    fn store_keeps_only_recent_runs_per_schedule() {
        let mut store = SchedulerStore::default();
        for index in 0..55 {
            store.runs.push(ScheduleRun {
                id: format!("run-{index}"),
                schedule_id: "schedule-1".to_owned(),
                scheduled_for: index,
                started_at: None,
                finished_at: None,
                status: ScheduleRunStatus::Skipped,
                requested_account_id: "codex-account-1".to_owned(),
                actual_account_id: None,
                provider_session_id: None,
                previous_provider_session_id: None,
                session_replaced: false,
                retry_count: 0,
                summary: None,
                error: None,
                last_heartbeat_at: None,
                cancellation_requested_at: None,
                recovery_error: None,
                manual: false,
                document_trigger: None,
                session_reference: None,
                round: None,
            });
        }
        trim_runs(&mut store);
        assert_eq!(store.runs.len(), 50);
        assert_eq!(store.runs[0].id, "run-5");
    }

    #[test]
    fn schedules_are_sorted_by_creation_time() {
        let older = ScheduledRequest {
            id: "schedule-older".to_owned(),
            input: input(Path::new("/tmp")),
            created_at: 100,
            updated_at: 900,
            next_run_at: 900,
            last_run_at: None,
            manual_run_requested_at: None,
        };
        let newer = ScheduledRequest {
            id: "schedule-newer".to_owned(),
            input: input(Path::new("/tmp")),
            created_at: 200,
            updated_at: 100,
            next_run_at: 100,
            last_run_at: None,
            manual_run_requested_at: None,
        };

        let sorted = sorted_schedules(vec![newer, older]);
        assert_eq!(
            sorted
                .iter()
                .map(|schedule| schedule.id.as_str())
                .collect::<Vec<_>>(),
            vec!["schedule-older", "schedule-newer"]
        );
    }

    /// 격리가 준비된 비활성 계정은 전환 없이 그대로 실행한다. 공유 홈의 활성
    /// 계정은 그대로 남아 앱 밖의 CLI가 쓰던 로그인이 바뀌지 않는다.
    #[test]
    fn isolated_inactive_account_runs_without_switching_the_active_account() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, a, b) = two_accounts_with_probe(data.path(), home.path(), || {
            crate::credential_profiles::ProbeOutcome::Ready
        });
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = test_supervisor(data.path(), chats);
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b.clone();
        schedule_input.provider_session_id = Some("same-provider-session".to_owned());
        let schedule = supervisor
            .create(schedule_input, SessionReadActor::User)
            .unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };

        prepare_run_account(&supervisor.inner, &mut claimed).unwrap();

        assert_eq!(claimed.run.actual_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(
            claimed.schedule.input.provider_session_id.as_deref(),
            Some("same-provider-session")
        );
        assert_eq!(
            accounts
                .active_account_id(ProviderId::Codex)
                .unwrap()
                .as_deref(),
            Some(a.as_str())
        );
    }

    /// 실행 시점 활성 계정 옵션은 저장된 계정이 아니라 매 실행 때의 활성 계정을
    /// 읽는다. 활성 계정을 바꾸면 다음 실행부터 바뀐 계정으로 돌아야 한다.
    #[test]
    fn active_account_option_follows_the_account_active_at_run_time() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        // 기본 계정도 격리 프로필로 실행되므로 프로브가 격리를 확인해야 회차가 준비된다.
        let (accounts, a, b) = two_accounts_with_probe(data.path(), home.path(), || {
            crate::credential_profiles::ProbeOutcome::Ready
        });
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = test_supervisor(data.path(), chats);
        let mut schedule_input = input(data.path());
        schedule_input.account_id = "codex-account-1".to_owned();
        schedule_input.use_active_account = true;
        let schedule = supervisor
            .create(schedule_input, SessionReadActor::User)
            .unwrap();
        // 고정 계정 값은 저장 시점에 지워져 실행 시점 조회와 섞이지 않는다.
        assert!(schedule.input.account_id.is_empty());
        assert_eq!(supervisor.account_reference_count(&a).unwrap(), 0);

        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule: schedule.clone(),
        };
        prepare_run_account(&supervisor.inner, &mut claimed).unwrap();
        assert_eq!(claimed.run.actual_account_id.as_deref(), Some(a.as_str()));

        accounts.set_default(&b).unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        prepare_run_account(&supervisor.inner, &mut claimed).unwrap();
        assert_eq!(claimed.run.actual_account_id.as_deref(), Some(b.as_str()));
    }

    /// 격리를 준비하지 못하면 공유 홈으로 되돌리는 대신 대기한다. 되돌리면 활성
    /// 계정 자격증명으로 요청이 나가 계정이 뒤바뀐다.
    #[test]
    fn non_isolated_inactive_account_waits_instead_of_running() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, a, b) = two_accounts(data.path(), home.path());
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = test_supervisor(data.path(), chats);
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b;
        let schedule = supervisor
            .create(schedule_input, SessionReadActor::User)
            .unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };

        let error = prepare_run_account(&supervisor.inner, &mut claimed).unwrap_err();

        let PrepareRunError::Waiting(status, message) = error else {
            panic!("격리를 못 쓰면 실패가 아니라 대기여야 합니다: {error:?}");
        };
        assert_eq!(status, ScheduleRunStatus::WaitingForAccount);
        assert!(message.contains("자격증명 격리"));
        assert!(claimed.run.actual_account_id.is_none());
        assert_eq!(
            accounts
                .active_account_id(ProviderId::Codex)
                .unwrap()
                .as_deref(),
            Some(a.as_str())
        );
    }

    /// 계정 레지스트리가 담지 않는 공급자(Antigravity)는 계정 준비 단계를 건너뛴다.
    /// 건너뛰지 않으면 활성 계정 조회가 "지원하지 않는 계정 공급자"로 거절되어 회차가
    /// 매번 실패한다 — 채팅 화면에서는 같은 공급자가 계정 미귀속으로 잘 돈다.
    #[test]
    fn a_provider_without_an_account_registry_runs_unattributed() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, _a, _b) = two_accounts_with_probe(data.path(), home.path(), || {
            crate::credential_profiles::ProbeOutcome::Ready
        });
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = test_supervisor(data.path(), chats);
        let mut schedule_input = input(data.path());
        schedule_input.source = ProviderId::Antigravity;
        schedule_input.account_id = "codex-account-1".to_owned();
        schedule_input.use_active_account = true;

        let schedule = supervisor
            .create(schedule_input, SessionReadActor::User)
            .expect("계정 없이도 저장된다");
        // 쓰이지 않는 값은 저장본에서 비운다. 남겨 두면 화면이 없는 계정을 보여 준다.
        assert_eq!(schedule.input.account_id, "");
        assert!(!schedule.input.use_active_account);

        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        prepare_run_account(&supervisor.inner, &mut claimed).expect("계정 준비를 건너뛴다");
        assert!(claimed.run.actual_account_id.is_none());
    }

    /// 인증 상태를 잃은 것은 일시 상태다. 공유 홈 자격증명 확인이 401이나 중간에
    /// 끊긴 기록을 만나면 붙었다가 다음 조회가 성공하면 풀린다. 실패로 확정하면 몇 분
    /// 뒤면 회복될 상태 때문에 예약된 회차가 통째로 날아간다.
    #[test]
    fn an_account_that_lost_its_auth_status_waits_instead_of_failing() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, _a, b) = two_accounts_with_probe(data.path(), home.path(), || {
            crate::credential_profiles::ProbeOutcome::Ready
        });
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = test_supervisor(data.path(), chats);
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b.clone();
        let schedule = supervisor
            .create(schedule_input, SessionReadActor::User)
            .unwrap();
        accounts
            .force_auth_status_for_test(&b, crate::AccountAuthStatus::Error)
            .unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };

        let error = prepare_run_account(&supervisor.inner, &mut claimed).unwrap_err();

        let PrepareRunError::Waiting(status, message) = error else {
            panic!("일시적인 인증 실패는 실패가 아니라 대기여야 합니다: {error:?}");
        };
        assert_eq!(status, ScheduleRunStatus::WaitingForAccount);
        assert!(message.contains("인증이 확인되지 않아"));
        assert!(claimed.run.actual_account_id.is_none());
    }

    /// 사용자가 끈 계정은 저절로 돌아오지 않으므로 대기가 아니라 실패다. 대기로
    /// 두면 매 틱마다 되살아나지 않을 계정을 계속 확인한다.
    #[test]
    fn a_disabled_account_fails_the_run_instead_of_waiting() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, _a, b) = two_accounts_with_probe(data.path(), home.path(), || {
            crate::credential_profiles::ProbeOutcome::Ready
        });
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = test_supervisor(data.path(), chats);
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b.clone();
        let schedule = supervisor
            .create(schedule_input, SessionReadActor::User)
            .unwrap();
        accounts.set_disabled(&b, true).unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };

        let error = prepare_run_account(&supervisor.inner, &mut claimed).unwrap_err();

        let PrepareRunError::Failed(message) = error else {
            panic!("꺼 둔 계정은 대기가 아니라 실패여야 합니다: {error:?}");
        };
        assert!(message.contains("비활성화"));
    }

    #[test]
    fn repeated_due_ticks_merge_into_one_waiting_run() {
        let data = tempfile::tempdir().unwrap();
        let chats = ChatSupervisor::new();
        let inner = Arc::new(SchedulerInner {
            app_data_dir: data.path().to_path_buf(),
            accounts: None,
            chats,
            stop: AtomicBool::new(false),
            runner_active: false,
            _runner_lock: None,
            running: Mutex::new(HashSet::new()),
            executions: Mutex::new(HashMap::new()),
            subscriber: Mutex::new(None),
            workflows: Mutex::new(None),
        });
        let now = now_ms();
        with_store(data.path(), |store| {
            store.schedules.push(ScheduledRequest {
                id: "schedule-waiting".to_owned(),
                input: input(data.path()),
                created_at: now,
                updated_at: now,
                next_run_at: 1,
                last_run_at: None,
                manual_run_requested_at: None,
            });
            Ok(())
        })
        .unwrap();
        let first = claim_due(&inner, now).unwrap();
        assert_eq!(first.len(), 1);
        inner.running.lock().unwrap().clear();
        let second = claim_due(&inner, now + 1_000).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].run.id, second[0].run.id);
        assert_eq!(read_store(data.path()).unwrap().runs.len(), 1);
    }

    /// 전체 일시정지는 예약 실행만 멈춘다. 카드에서 직접 누른 실행은 그 상태에서도
    /// 나가야 하고, 멈춰 둔 예약 시각은 그대로 남아야 한다.
    #[test]
    fn manual_run_is_claimed_while_the_scheduler_is_paused() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(data.path()), SessionReadActor::User)
            .unwrap();
        with_store(data.path(), |store| {
            store.paused = true;
            store.schedules[0].next_run_at = 1;
            Ok(())
        })
        .unwrap();
        let now = now_ms();

        assert!(claim_due(&supervisor.inner, now).unwrap().is_empty());
        supervisor.run_now(&schedule.id).unwrap();
        let claimed = claim_due(&supervisor.inner, now).unwrap();

        assert_eq!(claimed.len(), 1);
        assert!(claimed[0].run.manual);
        let store = read_store(data.path()).unwrap();
        assert_eq!(store.schedules[0].next_run_at, 1);
        assert!(store.schedules[0].manual_run_requested_at.is_none());
    }

    /// 활성 시작 전에는 예약 실행을 하지 않는다. 창이 열리기 전에 지나간 발화는 다음
    /// 실행 시각을 창 안으로 밀어 두기만 하고 밀린 회차로 쌓이지 않는다.
    #[test]
    fn scheduled_run_is_not_claimed_before_the_active_window_opens() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let now = now_ms();
        let opens_at = now + 6 * 60 * 60 * 1_000;
        let mut value = input(data.path());
        value.active_from = Some(opens_at);
        supervisor.create(value, SessionReadActor::User).unwrap();
        assert!(read_store(data.path()).unwrap().schedules[0].next_run_at >= opens_at);
        with_store(data.path(), |store| {
            store.schedules[0].next_run_at = 1;
            Ok(())
        })
        .unwrap();

        assert!(claim_due(&supervisor.inner, now).unwrap().is_empty());

        let store = read_store(data.path()).unwrap();
        assert!(store.runs.is_empty());
        assert!(store.schedules[0].next_run_at >= opens_at);
    }

    /// 활성 종료가 지나면 예약 실행을 하지 않는다. 사용자가 종료를 뒤로 미루면 그대로
    /// 다시 살아나야 하므로 enabled는 건드리지 않는다.
    #[test]
    fn scheduled_run_is_not_claimed_after_the_active_window_closes() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let now = now_ms();
        let mut value = input(data.path());
        value.active_until = Some(now - 60_000);
        supervisor.create(value, SessionReadActor::User).unwrap();
        with_store(data.path(), |store| {
            store.schedules[0].next_run_at = 1;
            Ok(())
        })
        .unwrap();

        assert!(claim_due(&supervisor.inner, now).unwrap().is_empty());

        let store = read_store(data.path()).unwrap();
        assert!(store.runs.is_empty());
        assert!(store.schedules[0].input.enabled);
    }

    /// 수동 실행은 활성 창과 무관하게 나간다. 전체 일시정지 중에도 카드에서 누른
    /// 실행이 나가는 것과 같은 취급이다.
    #[test]
    fn manual_run_is_claimed_outside_the_active_window() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let now = now_ms();
        let mut value = input(data.path());
        value.active_until = Some(now - 60_000);
        let schedule = supervisor.create(value, SessionReadActor::User).unwrap();

        assert!(claim_due(&supervisor.inner, now).unwrap().is_empty());
        supervisor.run_now(&schedule.id).unwrap();
        let claimed = claim_due(&supervisor.inner, now).unwrap();

        assert_eq!(claimed.len(), 1);
        assert!(claimed[0].run.manual);
    }

    /// 활성 창을 쓰지 않는 저장본은 이 필드가 없던 때와 바이트까지 같고, 예약 실행도
    /// 그대로 나간다.
    #[test]
    fn schedules_without_an_active_window_behave_as_before() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(data.path()), SessionReadActor::User)
            .unwrap();
        let stored = serde_json::to_value(&schedule).unwrap();
        assert!(stored.get("activeFrom").is_none());
        assert!(stored.get("activeUntil").is_none());
        let restored: ScheduledRequest = serde_json::from_value(stored).unwrap();
        assert!(restored.input.active_from.is_none());
        assert!(restored.input.active_until.is_none());
        with_store(data.path(), |store| {
            store.schedules[0].next_run_at = 1;
            Ok(())
        })
        .unwrap();

        let claimed = claim_due(&supervisor.inner, now_ms()).unwrap();

        assert_eq!(claimed.len(), 1);
        assert!(!claimed[0].run.manual);
    }

    /// 이미 끝난 창을 저장하는 것은 사용자 자유지만, 뒤집힌 창은 거절한다.
    #[test]
    fn inverted_active_window_is_rejected() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let mut value = input(data.path());
        value.active_from = Some(2_000_000);
        value.active_until = Some(2_000_000);

        let error = supervisor
            .create(value, SessionReadActor::User)
            .unwrap_err();

        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    /// 자동 주기는 벽시계 정렬이 없으므로 창이 열리는 순간이 그대로 첫 회차다.
    #[test]
    fn auto_cadence_round_starts_when_the_active_window_opens() {
        let data = tempfile::tempdir().unwrap();
        let mut value = input(data.path());
        value.recurrence = recurrence(ScheduleFrequency::Auto);
        value.active_from = Some(5_000_000);
        value.active_until = Some(9_000_000);

        assert_eq!(
            next_run_in_window(&value, 1_000_000, 60, None).unwrap(),
            5_000_000
        );
        assert!(!active_window_open(&value, 4_999_999));
        assert!(active_window_open(&value, 5_000_000));
        assert!(!active_window_open(&value, 9_000_001));
    }

    /// 정책에서 자동 간격을 줄인 직후 기존 회차도 새 시각으로 앞당겨져야 한다. 저장된
    /// `next_run_at`을 그대로 두면 화면에는 1시간으로 보이는데 첫 실행은 5시간 뒤에 뜬다.
    #[test]
    fn refreshing_paced_auto_cadence_moves_an_existing_round_earlier() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        supervisor
            .set_workflow_executor(FakeWorkflows::new(None, true))
            .unwrap();
        let seed = || Ok(crate::usage_budget_policy::PolicySeed::default());
        crate::usage_budget_policy::set_workflow(
            data.path(),
            seed,
            crate::SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-usage".to_owned(),
                pacing_enabled: true,
                accounts: None,
            },
        )
        .unwrap();
        crate::usage_budget_policy::set_defaults(
            data.path(),
            seed,
            crate::UsageBudgetDefaults {
                guard_window_label: Some("5시간".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let mut request = workflow_input(data.path());
        request.recurrence = recurrence(ScheduleFrequency::Auto);
        let created = supervisor.create(request, SessionReadActor::User).unwrap();
        assert_eq!(created.next_run_at - created.created_at, 5 * 60 * 60_000);

        crate::usage_budget_policy::set_defaults(
            data.path(),
            seed,
            crate::UsageBudgetDefaults {
                guard_window_label: Some("1시간".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let before_refresh = now_ms();
        assert_eq!(supervisor.refresh_paced_auto_cadence().unwrap(), 1);
        let refreshed = supervisor
            .snapshot()
            .unwrap()
            .schedules
            .into_iter()
            .find(|schedule| schedule.id == created.id)
            .unwrap();
        assert!(refreshed.next_run_at > before_refresh);
        assert!(refreshed.next_run_at <= before_refresh + 61 * 60_000);
        assert!(refreshed.next_run_at < created.next_run_at);

        // 페이싱을 끈 직후에도 Auto 주기 자체는 유효하다. 이 회차를 새로고침 대상에서
        // 빼면 이후 기본 간격 변경을 영원히 반영하지 못한다.
        crate::usage_budget_policy::set_workflow(
            data.path(),
            seed,
            crate::SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-usage".to_owned(),
                pacing_enabled: false,
                accounts: None,
            },
        )
        .unwrap();
        crate::usage_budget_policy::set_defaults(
            data.path(),
            seed,
            crate::UsageBudgetDefaults {
                guard_window_label: Some("30분".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let before_unpaced_refresh = now_ms();
        assert_eq!(supervisor.refresh_paced_auto_cadence().unwrap(), 1);
        let unpaced = supervisor
            .snapshot()
            .unwrap()
            .schedules
            .into_iter()
            .find(|schedule| schedule.id == created.id)
            .unwrap();
        assert!(unpaced.next_run_at > before_unpaced_refresh);
        assert!(unpaced.next_run_at <= before_unpaced_refresh + 31 * 60_000);
        assert!(unpaced.next_run_at < refreshed.next_run_at);
    }

    /// 서울 2026-09-09(수) 기준 벽시계 → ms. 9/12는 토요일.
    fn seoul(day: u32, hour: u32, minute: u32) -> i64 {
        let zone: Tz = "Asia/Seoul".parse().unwrap();
        chrono::TimeZone::with_ymd_and_hms(&zone, 2026, 9, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    /// 평일 09:00~18:00 제한.
    fn weekday_quiet_hours() -> crate::QuietHours {
        crate::QuietHours {
            enabled: true,
            start: "09:00".to_owned(),
            end: "18:00".to_owned(),
            timezone: "Asia/Seoul".to_owned(),
            weekdays: (1..=5).collect(),
        }
    }

    #[test]
    fn paced_round_inside_quiet_hours_waits_for_the_resume_time() {
        let data = tempfile::tempdir().unwrap();
        let quiet = QuietSchedule::parse(&weekday_quiet_hours())
            .unwrap()
            .unwrap();
        let mut value = input(data.path());
        value.recurrence = recurrence(ScheduleFrequency::Auto);
        // 제한 중이면 재개 시각이 첫 회차다.
        assert_eq!(
            next_run_in_window(&value, seoul(9, 14, 0), 60, Some(&quiet)).unwrap(),
            seoul(9, 18, 0)
        );
        // 열린 시간에 계산한 다음 회차가 제한 안에 떨어지면 재개 시각으로 붙는다.
        assert_eq!(
            next_run_in_window(&value, seoul(9, 8, 30), 45, Some(&quiet)).unwrap(),
            seoul(9, 18, 0)
        );
        // 열린 시간 안에서는 간격 그대로다.
        assert_eq!(
            next_run_in_window(&value, seoul(9, 20, 0), 60, Some(&quiet)).unwrap(),
            seoul(9, 21, 0)
        );
        // 체크 안 한 요일(토)은 제한이 없다.
        assert_eq!(
            next_run_in_window(&value, seoul(12, 14, 0), 60, Some(&quiet)).unwrap(),
            seoul(12, 15, 0)
        );
        // 스케줄이 없으면 이전과 같다.
        assert_eq!(
            next_run_in_window(&value, seoul(9, 14, 0), 60, None).unwrap(),
            seoul(9, 15, 0)
        );
        // 벽시계 주기도 제한 안의 발화는 재개 시각으로 미룬다: 매일 12:00 → 수 18:00.
        let mut daily = input(data.path());
        daily.recurrence = recurrence(ScheduleFrequency::Daily);
        daily.recurrence.hour = 12;
        daily.recurrence.minute = 0;
        assert_eq!(
            next_run_in_window(&daily, seoul(8, 20, 0), 60, Some(&quiet)).unwrap(),
            seoul(9, 18, 0)
        );
    }

    #[test]
    fn claim_due_defers_paced_rounds_in_quiet_hours_but_not_manual_or_unpaced_runs() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        supervisor
            .set_workflow_executor(FakeWorkflows::new(None, true))
            .unwrap();
        let seed = || Ok(crate::usage_budget_policy::PolicySeed::default());
        crate::usage_budget_policy::set_workflow(
            temp.path(),
            seed,
            crate::SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-usage".to_owned(),
                pacing_enabled: true,
                accounts: None,
            },
        )
        .unwrap();
        crate::usage_budget_policy::set_defaults(
            temp.path(),
            seed,
            crate::UsageBudgetDefaults {
                quiet_hours: Some(weekday_quiet_hours()),
                ..Default::default()
            },
        )
        .unwrap();
        let paced = supervisor
            .create(workflow_input(temp.path()), SessionReadActor::User)
            .unwrap();
        let plain = supervisor
            .create(input(temp.path()), SessionReadActor::User)
            .unwrap();
        let set_next = |id: &str, at: i64| {
            with_store(temp.path(), |store| {
                store
                    .schedules
                    .iter_mut()
                    .find(|schedule| schedule.id == id)
                    .unwrap()
                    .next_run_at = at;
                Ok(())
            })
            .unwrap();
        };
        let next_of = |id: &str| {
            supervisor
                .snapshot()
                .unwrap()
                .schedules
                .into_iter()
                .find(|schedule| schedule.id == id)
                .unwrap()
                .next_run_at
        };

        // 수요일 14:00에 둘 다 13:00 만기. 페이싱 회차는 18:00으로 미뤄지고(버려지지 않음) 일반
        // 반복 요청은 제한과 무관하게 잡힌다.
        set_next(&paced.id, seoul(9, 13, 0));
        set_next(&plain.id, seoul(9, 13, 0));
        let claimed = claim_due(&supervisor.inner, seoul(9, 14, 0)).unwrap();
        assert_eq!(
            claimed
                .iter()
                .map(|claim| claim.schedule.id.as_str())
                .collect::<Vec<_>>(),
            vec![plain.id.as_str()]
        );
        assert_eq!(next_of(&paced.id), seoul(9, 18, 0));
        // 저장된 다음 실행이 제한 안(16:00)이면 틱이 재개 시각으로 옮긴다.
        set_next(&paced.id, seoul(9, 16, 0));
        assert!(claim_due(&supervisor.inner, seoul(9, 14, 0))
            .unwrap()
            .is_empty());
        assert_eq!(next_of(&paced.id), seoul(9, 18, 0));
        // 수동 실행은 제한 중에도 그대로 나간다.
        supervisor.run_now(&paced.id).unwrap();
        let claimed = claim_due(&supervisor.inner, seoul(9, 14, 30)).unwrap();
        assert!(claimed
            .iter()
            .any(|claim| claim.schedule.id == paced.id && claim.run.manual));
    }

    #[test]
    fn document_trigger_run_is_claimed_with_untrusted_context_while_paused() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(data.path()), SessionReadActor::User)
            .unwrap();
        supervisor.set_paused(true).unwrap();
        supervisor
            .run_now_from_document_trigger(
                &schedule.id,
                ScheduledDocumentTriggerContext {
                    trigger_id: "trigger-1".to_owned(),
                    event_id: "event-1".to_owned(),
                    summary: "modified: report.md".to_owned(),
                },
            )
            .unwrap();

        let claimed = claim_due(&supervisor.inner, now_ms()).unwrap();
        assert_eq!(claimed.len(), 1);
        assert!(claimed[0].run.manual);
        assert_eq!(
            claimed[0]
                .run
                .document_trigger
                .as_ref()
                .map(|context| context.event_id.as_str()),
            Some("event-1")
        );
        assert!(claimed[0]
            .schedule
            .input
            .prompt
            .contains("신뢰할 수 없는 입력"));
        assert!(claimed[0].schedule.input.prompt.contains("report.md"));
        supervisor
            .run_now_from_document_trigger(
                &schedule.id,
                ScheduledDocumentTriggerContext {
                    trigger_id: "trigger-1".to_owned(),
                    event_id: "event-1".to_owned(),
                    summary: "modified: report.md".to_owned(),
                },
            )
            .unwrap();
        assert!(read_store(data.path())
            .unwrap()
            .pending_document_runs
            .is_empty());
    }

    /// 계정을 기다리는 실행이 이미 있으면 수동 요청은 그 실행에 합쳐진다. 일시정지
    /// 중에 합쳐진 실행까지 멈추면 사용자가 누른 실행이 흔적 없이 사라진다.
    #[test]
    fn manual_request_resumes_a_waiting_run_while_paused() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(data.path()), SessionReadActor::User)
            .unwrap();
        with_store(data.path(), |store| {
            store.paused = true;
            store.runs.push(schedule_run(&schedule));
            Ok(())
        })
        .unwrap();
        let now = now_ms();

        assert!(claim_due(&supervisor.inner, now).unwrap().is_empty());
        supervisor.run_now(&schedule.id).unwrap();
        let claimed = claim_due(&supervisor.inner, now).unwrap();

        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].run.id, "run-test");
        assert!(claimed[0].run.manual);
        assert!(read_store(data.path()).unwrap().runs[0].manual);
    }

    #[test]
    fn disabling_a_schedule_cancels_its_waiting_account_run() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(data.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(data.path()), SessionReadActor::User)
            .unwrap();
        with_store(data.path(), |store| {
            store.paused = true;
            store.runs.push(schedule_run(&schedule));
            Ok(())
        })
        .unwrap();
        supervisor.set_enabled(&schedule.id, false).unwrap();
        let snapshot = supervisor.snapshot().unwrap();
        assert_eq!(snapshot.runs[0].status, ScheduleRunStatus::Skipped);
        assert!(snapshot.runs[0].finished_at.is_some());
    }

    #[test]
    fn resume_failure_policy_is_saved_per_request() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let created = supervisor
            .create(input(temp.path()), SessionReadActor::User)
            .expect("create schedule");
        assert_eq!(
            created.input.resume_failure_policy,
            ResumeFailurePolicy::RetryThenNewChat
        );
        let mut changed = created.input;
        changed.resume_failure_policy = ResumeFailurePolicy::Pause;
        let updated = supervisor
            .update(&created.id, changed, SessionReadActor::User)
            .expect("update schedule");
        assert_eq!(
            updated.input.resume_failure_policy,
            ResumeFailurePolicy::Pause
        );
        assert_eq!(
            supervisor.snapshot().expect("snapshot").schedules[0]
                .input
                .resume_failure_policy,
            ResumeFailurePolicy::Pause
        );
    }

    #[test]
    fn startup_marks_persisted_running_runs_as_failed() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let now = now_ms();
        with_store(temp.path(), |store| {
            store.schedules.push(ScheduledRequest {
                id: "schedule-interrupted".to_owned(),
                input: input(temp.path()),
                created_at: now - 2_000,
                updated_at: now - 2_000,
                next_run_at: now + 60_000,
                last_run_at: None,
                manual_run_requested_at: None,
            });
            store.runs.push(ScheduleRun {
                id: "run-interrupted".to_owned(),
                schedule_id: "schedule-interrupted".to_owned(),
                scheduled_for: now - 1_000,
                started_at: Some(now - 1_000),
                finished_at: None,
                status: ScheduleRunStatus::Running,
                requested_account_id: "codex-account-1".to_owned(),
                actual_account_id: Some("codex-account-1".to_owned()),
                provider_session_id: None,
                previous_provider_session_id: Some("thread-123".to_owned()),
                session_replaced: false,
                retry_count: 0,
                summary: None,
                error: None,
                last_heartbeat_at: Some(now - 1_000),
                cancellation_requested_at: None,
                recovery_error: None,
                manual: false,
                document_trigger: None,
                session_reference: None,
                round: None,
            });
            Ok(())
        })
        .expect("seed scheduler store");

        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let snapshot = supervisor.snapshot().expect("snapshot");
        let run = snapshot
            .runs
            .iter()
            .find(|run| run.id == "run-interrupted")
            .expect("interrupted run");
        assert_eq!(run.status, ScheduleRunStatus::Failed);
        assert!(run.finished_at.is_some());
        assert_eq!(
            run.error.as_deref(),
            Some("이전 Agent Manager 실행이 종료되어 반복 요청이 중단되었습니다")
        );
        assert!(snapshot.schedules[0].last_run_at.is_some());
    }

    #[test]
    fn orphan_running_run_without_session_is_cancelled_and_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(temp.path()), SessionReadActor::User)
            .unwrap();
        let mut run = schedule_run(&schedule);
        run.status = ScheduleRunStatus::Running;
        run.started_at = Some(now_ms() - 120_000);
        run.last_heartbeat_at = None;
        run.actual_account_id = Some(schedule.input.account_id.clone());
        with_store(temp.path(), |store| {
            store.runs.push(run.clone());
            Ok(())
        })
        .unwrap();

        let receipt = supervisor
            .cancel_run(&run.id, Some("고아 실행 복구 테스트"))
            .unwrap();

        assert_eq!(receipt.run.status, ScheduleRunStatus::Cancelled);
        assert!(receipt.run.finished_at.is_some());
        assert!(receipt.run.provider_session_id.is_none());
        assert!(!receipt.owner_was_active);
        assert!(receipt
            .stale_reasons
            .iter()
            .any(|reason| reason.contains("runtimeCount=0")));
    }

    #[test]
    fn cancelling_terminal_run_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(temp.path()), SessionReadActor::User)
            .unwrap();
        let mut run = schedule_run(&schedule);
        run.status = ScheduleRunStatus::Completed;
        run.finished_at = Some(now_ms());
        with_store(temp.path(), |store| {
            store.runs.push(run.clone());
            Ok(())
        })
        .unwrap();

        let receipt = supervisor.cancel_run(&run.id, None).unwrap();
        assert!(receipt.already_terminal);
        assert_eq!(receipt.run.status, ScheduleRunStatus::Completed);
        assert_eq!(receipt.run.finished_at, run.finished_at);
    }

    #[test]
    fn provider_startup_cancel_finalizes_run_before_provider_session_exists() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let schedule = supervisor
            .create(input(temp.path()), SessionReadActor::User)
            .unwrap();
        let mut run = schedule_run(&schedule);
        run.status = ScheduleRunStatus::Running;
        run.started_at = Some(now_ms());
        with_store(temp.path(), |store| {
            store.runs.push(run.clone());
            Ok(())
        })
        .unwrap();
        let control = Arc::new(ActiveRunControl::default());
        supervisor
            .inner
            .executions
            .lock()
            .unwrap()
            .insert(run.id.clone(), Arc::clone(&control));

        let receipt = supervisor.cancel_run(&run.id, None).unwrap();

        assert!(receipt.owner_was_active);
        assert!(control.cancelled.load(Ordering::Acquire));
        assert_eq!(receipt.run.status, ScheduleRunStatus::Cancelled);
        assert!(receipt.run.provider_session_id.is_none());
    }

    #[test]
    fn startup_deadline_detects_a_hung_provider_start() {
        assert!(startup_deadline_exceeded(
            UNIX_EPOCH,
            Duration::from_millis(1)
        ));
    }

    #[test]
    fn missed_runs_advance_without_creating_history() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let supervisor = test_supervisor(temp.path(), ChatSupervisor::new());
        let created = supervisor
            .create(input(temp.path()), SessionReadActor::User)
            .expect("create schedule");
        with_store(temp.path(), |store| {
            // Keep the background claim loop from racing this direct skip_missed check.
            store.paused = true;
            store.schedules[0].next_run_at = 1;
            Ok(())
        })
        .expect("prepare missed run");
        let now = now_ms();
        skip_missed(temp.path(), now).expect("skip missed run");
        let snapshot = supervisor.snapshot().expect("snapshot");
        assert!(snapshot.schedules[0].next_run_at > now);
        assert!(snapshot.runs.is_empty());
        assert_eq!(snapshot.schedules[0].id, created.id);
    }

    #[test]
    fn schedule_frequency_display_and_from_str_round_trip() {
        assert_eq!(
            ScheduleFrequency::ALL,
            [
                ScheduleFrequency::Hourly,
                ScheduleFrequency::Daily,
                ScheduleFrequency::Weekdays,
                ScheduleFrequency::Weekly,
                ScheduleFrequency::Cron,
                ScheduleFrequency::Auto,
            ]
        );
        for frequency in ScheduleFrequency::ALL {
            assert_eq!(frequency.to_string(), frequency.as_str());
            assert_eq!(
                frequency.as_str().parse::<ScheduleFrequency>().unwrap(),
                frequency
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&frequency).unwrap();
            assert_eq!(serialized, format!("\"{}\"", frequency.as_str()));
            let deserialized: ScheduleFrequency = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, frequency);
        }
        assert_eq!(
            "  weekdays  ".parse::<ScheduleFrequency>().unwrap(),
            ScheduleFrequency::Weekdays
        );
        assert!(matches!(
            "invalid".parse::<ScheduleFrequency>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn schedule_session_strategy_display_and_from_str_round_trip() {
        assert_eq!(
            ScheduleSessionStrategy::ALL,
            [
                ScheduleSessionStrategy::NewChat,
                ScheduleSessionStrategy::Continue,
            ]
        );
        for strategy in ScheduleSessionStrategy::ALL {
            assert_eq!(strategy.to_string(), strategy.as_str());
            assert_eq!(
                strategy
                    .as_str()
                    .parse::<ScheduleSessionStrategy>()
                    .unwrap(),
                strategy
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&strategy).unwrap();
            assert_eq!(serialized, format!("\"{}\"", strategy.as_str()));
            let deserialized: ScheduleSessionStrategy = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, strategy);
        }
        assert_eq!(
            "  continue  ".parse::<ScheduleSessionStrategy>().unwrap(),
            ScheduleSessionStrategy::Continue
        );
        assert!(matches!(
            "invalid".parse::<ScheduleSessionStrategy>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn resume_failure_policy_display_and_from_str_round_trip() {
        assert_eq!(
            ResumeFailurePolicy::ALL,
            [
                ResumeFailurePolicy::Pause,
                ResumeFailurePolicy::NewChat,
                ResumeFailurePolicy::RetryThenNewChat,
            ]
        );
        for policy in ResumeFailurePolicy::ALL {
            assert_eq!(policy.to_string(), policy.as_str());
            assert_eq!(
                policy.as_str().parse::<ResumeFailurePolicy>().unwrap(),
                policy
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&policy).unwrap();
            assert_eq!(serialized, format!("\"{}\"", policy.as_str()));
            let deserialized: ResumeFailurePolicy = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, policy);
        }
        assert_eq!(
            "  retryThenNewChat  "
                .parse::<ResumeFailurePolicy>()
                .unwrap(),
            ResumeFailurePolicy::RetryThenNewChat
        );
        assert!(matches!(
            "invalid".parse::<ResumeFailurePolicy>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn schedule_run_status_display_and_from_str_round_trip() {
        assert_eq!(
            ScheduleRunStatus::ALL,
            [
                ScheduleRunStatus::WaitingForAccount,
                ScheduleRunStatus::WaitingForUsage,
                ScheduleRunStatus::Running,
                ScheduleRunStatus::Completed,
                ScheduleRunStatus::Failed,
                ScheduleRunStatus::Skipped,
                ScheduleRunStatus::Cancelled,
            ]
        );
        for status in ScheduleRunStatus::ALL {
            assert_eq!(status.to_string(), status.as_str());
            assert_eq!(
                status.as_str().parse::<ScheduleRunStatus>().unwrap(),
                status
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, format!("\"{}\"", status.as_str()));
            let deserialized: ScheduleRunStatus = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, status);
        }
        assert_eq!(
            "  waitingForAccount  "
                .parse::<ScheduleRunStatus>()
                .unwrap(),
            ScheduleRunStatus::WaitingForAccount
        );
        assert!(matches!(
            "invalid".parse::<ScheduleRunStatus>(),
            Err(crate::CoreError::InvalidInput(_))
        ));

        // is_waiting 및 is_terminal 동작 검증
        assert!(ScheduleRunStatus::WaitingForAccount.is_waiting());
        assert!(ScheduleRunStatus::WaitingForUsage.is_waiting());
        assert!(!ScheduleRunStatus::Running.is_waiting());

        assert!(ScheduleRunStatus::Completed.is_terminal());
        assert!(ScheduleRunStatus::Failed.is_terminal());
        assert!(ScheduleRunStatus::Skipped.is_terminal());
        assert!(ScheduleRunStatus::Cancelled.is_terminal());
        assert!(!ScheduleRunStatus::Running.is_terminal());
        assert!(!ScheduleRunStatus::WaitingForAccount.is_terminal());
    }
}
