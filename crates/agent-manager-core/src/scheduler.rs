use std::collections::{BTreeSet, HashMap, HashSet};
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
use crate::domain::{wire_enum, ChatOrigin, ChatOriginKind};
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

/// lease 만료 기준을 저장본과 같은 단위(epoch ms)로 옮긴 값. 만료 판정과 진단 문구가 각자
/// `try_from`을 적으면 넘침 처리가 어긋나는 순간 두 자리가 다른 기준으로 갈린다.
fn run_lease_expiry_ms() -> i64 {
    i64::try_from(RUN_LEASE_EXPIRY.as_millis()).unwrap_or(i64::MAX)
}

/// 실행 결과에 실을 요약의 상한(문자). 쌓는 쪽과 다듬는 쪽이 같은 값을 봐야 한다.
const MAX_RUN_SUMMARY_CHARS: usize = 2_000;

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
}

wire_enum!(trimmed ScheduleFrequency, "알 수 없는 스케줄 주기입니다", {
    Hourly => "hourly",
    Daily => "daily",
    Weekdays => "weekdays",
    Weekly => "weekly",
    Cron => "cron",
    Auto => "auto",
});

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
}

wire_enum!(trimmed ScheduleSessionStrategy, "알 수 없는 스케줄 세션 방식입니다", {
    NewChat => "newChat",
    Continue => "continue",
});

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
}

wire_enum!(trimmed ResumeFailurePolicy, "알 수 없는 세션 재개 실패 정책입니다", {
    Pause => "pause",
    NewChat => "newChat",
    RetryThenNewChat => "retryThenNewChat",
});

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
    /// 작업 경로. 비우면 회차가 앱의 기본 작업공간(`chat::DEFAULT_WORKSPACE_DIR`)에서 돈다.
    #[serde(default)]
    pub cwd: String,
    pub model: Option<String>,
    /// 로컬 공급자가 쓸 서빙 연결 id(M7 7.3). 없으면 기본 연결. 값이 없는 저장본은 이
    /// 필드가 없던 때와 바이트까지 같다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_connection_id: Option<String>,
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
    /// 스케줄러가 스스로 멈춘 사유. 사용자가 일부러 끈 회차와 갈라야 하는 값이다 — 자동
    /// 재승인은 자기가 멈춘 회차만 되살릴 수 있어야 하고, 그 판정을 `enabled`만 보고는
    /// 할 수 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_reason: Option<SchedulePauseReason>,
}

/// 스케줄러가 반복 요청을 스스로 멈춘 사유.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SchedulePauseReason {
    /// 승인 버전이 등록된 계약 버전과 어긋나 멈춘 회차. 계약이 다시 등록될 때
    /// `adopt_workflow_version`이 이 사유로 멈춘 회차만 되살린다.
    WorkflowVersion,
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

wire_enum!(trimmed ScheduleRunStatus, "알 수 없는 스케줄 실행 상태입니다", {
    WaitingForAccount => "waitingForAccount",
    WaitingForUsage => "waitingForUsage",
    Running => "running",
    Completed => "completed",
    Failed => "failed",
    Skipped => "skipped",
    Cancelled => "cancelled",
});

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

impl ScheduleRun {
    /// 회차를 종료 상태로 굳힌다.
    ///
    /// 종료는 늘 상태·종료 시각·사유 세 값을 함께 옮기는 일인데 호출부마다 손으로 적혀
    /// 있었다. 한 자리에서 `finished_at`을 빠뜨리면 화면은 그 회차를 끝없이 도는 중으로
    /// 읽고, 다음 틱의 "이전 실행이 끝나지 않았다" 판정까지 함께 어긋난다.
    fn finish(&mut self, status: ScheduleRunStatus, now: i64, error: Option<String>) {
        self.status = status;
        self.finished_at = Some(now);
        self.error = error;
    }

    /// 아직 끝나지 않은 회차를 대기 상태로 되돌린다. 시작·종료 시각을 지워 다음 틱이 같은
    /// 회차를 처음부터 다시 시도하게 한다.
    fn wait(&mut self, status: ScheduleRunStatus, error: Option<String>) {
        self.status = status;
        self.started_at = None;
        self.finished_at = None;
        self.error = error;
    }

    /// 실행 lease가 마지막으로 갱신된 시각. heartbeat가 아직 없으면 시작 시각이 대신한다 —
    /// 기동 직후라 heartbeat를 한 번도 못 찍은 회차를 만료로 몰지 않기 위해서다.
    fn lease_heartbeat_at(&self) -> Option<i64> {
        self.last_heartbeat_at.or(self.started_at)
    }

    /// lease가 갱신되지 않은 채 지난 시간(ms). 갱신 근거가 하나도 없으면 `None`.
    fn lease_age_ms(&self, now: i64) -> Option<i64> {
        self.lease_heartbeat_at()
            .map(|heartbeat| now.saturating_sub(heartbeat))
    }

    /// lease 만료 여부. 갱신 근거가 하나도 없는 실행도 만료로 본다 — 소유가 사라진 회차는
    /// heartbeat도 시작 시각도 남기지 못한 채 끊길 수 있다.
    fn lease_expired(&self, now: i64) -> bool {
        self.lease_age_ms(now)
            .is_none_or(|age_ms| age_ms > run_lease_expiry_ms())
    }

    /// 소유가 사라진 `Running` 회차만 실패로 굳히고 heartbeat까지 지금으로 맞춘다. 이미
    /// terminal로 저장된 회차는 건드리지 않는다.
    fn expire_running(&mut self, now: i64, error: String) {
        if self.status != ScheduleRunStatus::Running {
            return;
        }
        self.finish(ScheduleRunStatus::Failed, now, Some(error));
        self.last_heartbeat_at = Some(now);
    }
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

/// 저장본에서 id로 항목을 집는 네 갈래. 호출부마다 `iter().find(...)`를 다시 적으면
/// 같은 조회가 열 군데 넘게 흩어지고, 없을 때의 문구도 함께 흩어진다.
impl SchedulerStore {
    fn schedule(&self, id: &str) -> Option<&ScheduledRequest> {
        self.schedules.iter().find(|schedule| schedule.id == id)
    }

    fn schedule_mut(&mut self, id: &str) -> Option<&mut ScheduledRequest> {
        self.schedules.iter_mut().find(|schedule| schedule.id == id)
    }

    fn run(&self, run_id: &str) -> Option<&ScheduleRun> {
        self.runs.iter().find(|run| run.id == run_id)
    }

    fn run_mut(&mut self, run_id: &str) -> Option<&mut ScheduleRun> {
        self.runs.iter_mut().find(|run| run.id == run_id)
    }

    /// 아직 돌지 않은 반복 요청의 이어가기 대상과 실행 전후 세션을 한 벌로 모은다.
    fn referenced_session_ids(&self) -> BTreeSet<String> {
        self.schedules
            .iter()
            .filter_map(|schedule| schedule.input.provider_session_id.as_ref())
            .chain(self.runs.iter().flat_map(|run| {
                [
                    run.provider_session_id.as_ref(),
                    run.previous_provider_session_id.as_ref(),
                ]
                .into_iter()
                .flatten()
            }))
            .cloned()
            .collect()
    }
}

fn missing_schedule() -> CoreError {
    CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned())
}

fn missing_run() -> CoreError {
    CoreError::NotFound("반복 요청 실행을 찾을 수 없습니다".to_owned())
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

    /// 실행 소유권 맵에서 run의 제어권을 집는다. 이 프로세스가 소유하지 않는 run이면
    /// `None`이고, 맵 잠금이 손상됐으면 오류다. 무시해도 되는 호출부는 `.ok().flatten()`으로
    /// 둘을 같게 본다.
    fn execution_control(&self, run_id: &str) -> Result<Option<Arc<ActiveRunControl>>, CoreError> {
        Ok(self
            .executions
            .lock()
            .map_err(|_| CoreError::Runtime("반복 실행 소유권 잠금이 손상되었습니다".to_owned()))?
            .get(run_id)
            .cloned())
    }

    /// 제어권을 쥔 실행에 취소를 알리고, 채팅이 이미 떠 있으면 런타임까지 멈춘다. 채팅 id가
    /// 아직 없는 구간(provider startup 이전)에는 멈출 대상이 없으므로 깃발만 올린다.
    fn signal_cancellation(
        &self,
        control: &ActiveRunControl,
    ) -> Result<RuntimeStopOutcome, CoreError> {
        control.cancelled.store(true, Ordering::Release);
        let chat_id = control
            .chat_id
            .lock()
            .map_err(|_| CoreError::Runtime("반복 실행 채팅 잠금이 손상되었습니다".to_owned()))?
            .clone();
        let Some(chat_id) = chat_id else {
            return Ok(RuntimeStopOutcome::default());
        };
        Ok(RuntimeStopOutcome {
            stop_attempted: true,
            stop_error: self
                .chats
                .stop_managed(&chat_id)
                .err()
                .map(|error| error.to_string()),
        })
    }
}

/// 취소 신호가 런타임까지 닿았는지.
#[derive(Default)]
struct RuntimeStopOutcome {
    stop_attempted: bool,
    stop_error: Option<String>,
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

    /// 다음 실행 시각을 다시 잡는 저장 경로의 공통 문지방. 자동 주기 해석기는 스케줄러
    /// 락 **밖에서** 읽고(ABBA 교착 방지), 간격은 락 안에서 일시정지 목록을 보며 정한다.
    ///
    /// 이 두 걸음은 언제나 붙어 다니는데, 생성·수정·켜기·정책 갱신 네 자리가 각자
    /// "해석기 읽기 → 경로 복제 → 저장소 열기"를 적어 내려가고 있었다. 한 자리만 순서를
    /// 뒤집어도 락 순서가 어긋나 교착이 되는데, 그 사실은 주석으로만 지켜지고 있었다.
    /// 순서를 여기 한 벌만 둔다.
    fn with_cadence_store<T>(
        &self,
        action: impl FnOnce(
            &mut SchedulerStore,
            &Path,
            &crate::usage_pacing::AutoCadence,
        ) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let app_data_dir = self.inner.app_data_dir.clone();
        let auto = auto_cadence(&app_data_dir);
        with_store(&self.inner.app_data_dir, |store| {
            action(store, &app_data_dir, &auto)
        })
    }

    pub fn create(
        &self,
        input: ScheduledRequestInput,
        actor: SessionReadActor,
    ) -> Result<ScheduledRequest, CoreError> {
        let input = self.accept_input(input, actor, None)?;
        let now = now_ms();
        self.with_cadence_store(|store, app_data_dir, auto| {
            // 창을 나눠 쓸 회차 수에 이 새 회차 자신도 든다. id를 먼저 정해 그 사실을
            // 간격 계산에 알린다 — 저장본에는 아직 없어 목록만 봐서는 셀 수 없다.
            let id = format!("schedule-{}", Uuid::new_v4());
            let next_run_at = plan_saved_run(app_data_dir, store, auto, &id, &input, now)?;
            let schedule = ScheduledRequest {
                id,
                input,
                created_at: now,
                updated_at: now,
                next_run_at,
                last_run_at: None,
                manual_run_requested_at: None,
                paused_reason: None,
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
        let input = self.accept_input(input, actor, Some(id))?;
        let now = now_ms();
        self.with_cadence_store(|store, app_data_dir, auto| {
            let next_run_at = plan_saved_run(app_data_dir, store, auto, id, &input, now)?;
            let schedule = store.schedule_mut(id).ok_or_else(missing_schedule)?;
            schedule.input = input;
            schedule.updated_at = now;
            schedule.next_run_at = next_run_at;
            Ok(schedule.clone())
        })
    }

    /// 저장 전에 입력을 받아들이는 공통 관문. 생성과 수정이 같은 순서로 보지 않으면 같은
    /// 입력에 화면 경로마다 다른 오류가 나온다: 형식 → 계정 → 워크플로 → 세션 참조 조정 →
    /// 참조 프로젝트 확인 → 쓰지 않는 참조 버리기.
    ///
    /// `existing_id`는 수정 대상의 id다. 있으면 저장본의 세션 참조를 조정 기준으로 읽는다
    /// (생성에는 기준이 없다). 저장본 읽기를 앞당기지 않는 이유도 순서다 — 형식 오류가
    /// 저장소 읽기 실패보다 먼저 드러나야 한다.
    fn accept_input(
        &self,
        input: ScheduledRequestInput,
        actor: SessionReadActor,
        existing_id: Option<&str>,
    ) -> Result<ScheduledRequestInput, CoreError> {
        let mut input = validate_input(input)?;
        self.validate_account(&input)?;
        self.validate_workflow(&input)?;
        let stored = match existing_id {
            Some(id) => self.stored_session_reference(id)?,
            None => None,
        };
        input.session_reference = reconcile_settings(
            stored.as_ref(),
            input.session_reference.take(),
            actor,
            input.session_reference_replace_manual,
        )?;
        self.validate_session_reference(&input)?;
        drop_unused_session_reference(&mut input);
        Ok(input)
    }

    fn stored_session_reference(&self, id: &str) -> Result<Option<SessionReadSettings>, CoreError> {
        let store = read_store(&self.inner.app_data_dir)?;
        Ok(store
            .schedule(id)
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
        self.with_cadence_store(|store, app_data_dir, auto| {
            let now = now_ms();
            // 켜고 끄는 요청 자신은 저장본이 아직 옛 상태다. 활성 창·계정 범위까지 새 입력으로
            // 계산해야 다른 회차의 몫과 이 회차의 다음 실행이 같은 설정을 본다.
            let mut pending_input = store
                .schedule(id)
                .map(|schedule| schedule.input.clone())
                .ok_or_else(missing_schedule)?;
            pending_input.enabled = enabled;
            // 끄는 요청은 다음 시각을 잡지 않는다 — 아래에서 수동 실행 예약까지 지운다.
            let enabled_next_run_at = enabled
                .then(|| plan_saved_run(app_data_dir, store, auto, id, &pending_input, now))
                .transpose()?;
            let updated = {
                let schedule = store.schedule_mut(id).ok_or_else(missing_schedule)?;
                schedule.input.enabled = enabled;
                schedule.updated_at = now;
                if let Some(next_run_at) = enabled_next_run_at {
                    schedule.next_run_at = next_run_at;
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
                    run.finish(
                        ScheduleRunStatus::Skipped,
                        now,
                        Some("반복 요청이 비활성화되어 대기 실행을 취소했습니다".to_owned()),
                    );
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
        let now = now_ms();
        self.with_cadence_store(|store, _app_data_dir, auto| {
            let snapshot = store.schedules.clone();
            let updates: Result<Vec<(String, i64)>, CoreError> = snapshot
                .iter()
                .filter(|schedule| {
                    schedule.input.enabled
                        && schedule.input.recurrence.frequency == ScheduleFrequency::Auto
                        && schedule.input.workflow.is_some()
                })
                .map(|schedule| {
                    let recalculated =
                        next_run_with_cadence(&schedule.input, &snapshot, auto, None, now)?;
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
                if let Some(schedule) = store.schedule_mut(id) {
                    schedule.next_run_at = *next_run_at;
                }
            }
            Ok(updates.len())
        })
    }

    pub fn run_now(&self, id: &str) -> Result<ScheduledRequest, CoreError> {
        with_store(&self.inner.app_data_dir, |store| {
            let schedule = store.schedule_mut(id).ok_or_else(missing_schedule)?;
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
            let schedule = store.schedule(id).cloned().ok_or_else(missing_schedule)?;
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
        let current = snapshot.run(run_id).cloned().ok_or_else(missing_run)?;
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
            .schedule(&current.schedule_id)
            .cloned()
            .ok_or_else(missing_schedule)?;
        let control = self.inner.execution_control(run_id)?;
        let owner_was_active = control.is_some();
        let mut stop_attempted = false;
        let mut stop_error = None;
        let mut stale_reasons = stale_run_reasons(&current, now_ms());
        if let Some(control) = control {
            let outcome = self.inner.signal_cancellation(&control)?;
            stop_attempted = outcome.stop_attempted;
            stop_error = outcome.stop_error;
            if !stop_attempted {
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
            let run = store.run_mut(run_id).ok_or_else(missing_run)?;
            if !run.status.is_terminal() {
                run.finish(ScheduleRunStatus::Cancelled, now, Some(reason.clone()));
                run.cancellation_requested_at = Some(now);
                run.last_heartbeat_at = Some(now);
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

    /// 반복 요청이 붙잡고 있는 공급자 세션 ID. 자동정리(`C11-6`)가 이어가기 대상을
    /// 지우지 않도록 확인하는 데 쓴다. 다음 회차가 이어붙일 세션(`input`)과 이미 돈
    /// 회차가 남긴 세션(`runs`)을 함께 본다 — 회차 목록만 보면 아직 한 번도 돌지 않은
    /// 이어가기 대상이 빠지고, 입력만 보면 직전 회차가 만든 세션이 빠진다.
    pub fn referenced_session_ids(&self) -> Result<BTreeSet<String>, CoreError> {
        Ok(read_store(&self.inner.app_data_dir)?.referenced_session_ids())
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
            if !accounts.account_is_enabled_for_provider(
                input.source,
                &input.account_id,
                input.model.as_deref(),
            )? {
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
            run.finish(
                ScheduleRunStatus::Failed,
                now,
                Some("이전 Agent Manager 실행이 종료되어 반복 요청이 중단되었습니다".to_owned()),
            );
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
            if auto.round_paused(&schedule.input)
                || auto.round_completed(&schedule.id, &schedule.input)
            {
                continue;
            }
            if schedule.input.enabled && schedule.next_run_at <= now {
                schedule.next_run_at =
                    next_run_with_cadence(&schedule.input, &schedule_snapshot, &auto, None, now)?;
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
                run.finish(
                    ScheduleRunStatus::Skipped,
                    now,
                    Some("이전 실행이 끝나지 않아 건너뛰었습니다".to_owned()),
                );
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
    // 완료조건을 채운 회차도 같다 — 발화하지 않고 다음 실행 시각을 그대로 둬, "다시 시작"이
    // 완료를 지우는 순간 밀린 한 건이 곧바로 잡힌다.
    if auto.round_completed(&schedule.id, &schedule.input) {
        return Ok(false);
    }
    let window_open = active_window_open(&schedule.input, now);
    let quiet = auto.round_quiet(&schedule.input);
    let quiet_open = quiet.is_none_or(|quiet| !quiet.blocked_at(now));
    let regular_elapsed = schedule.input.enabled && schedule.next_run_at <= now;
    let regular_due = !paused && window_open && quiet_open && regular_elapsed;
    if regular_due || (regular_elapsed && !window_open) {
        schedule.next_run_at = next_run_with_cadence(&schedule.input, snapshot, auto, None, now)?;
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

/// 회차를 Running으로 확정해 저장한다. 공급자 대화 회차와 워크플로 회차가 같은 절차를
/// 밟으므로 한 군데로 모아, 시작 시각·heartbeat·저장 실패 문구가 두 경로에서 갈라지지
/// 않게 한다.
///
/// 저장본이 Running이 아니면 그 사이에 취소 등으로 terminal이 확정된 것이므로 덮어쓰지
/// 않고 멈춘다. 실행중 표시와 소유 실행 등록은 호출부의 `RunExecutionRegistration`이
/// 드롭될 때 함께 정리된다. 진행할 수 없으면 `None`을 돌려준다.
fn start_run(inner: &Arc<SchedulerInner>, mut claimed: ClaimedRun) -> Option<ClaimedRun> {
    claimed.run.status = ScheduleRunStatus::Running;
    claimed.run.started_at = Some(now_ms());
    claimed.run.last_heartbeat_at = claimed.run.started_at;
    claimed.run.error = None;
    match finish_run(&inner.app_data_dir, &claimed) {
        Ok(saved) if saved.run.status == ScheduleRunStatus::Running => Some(saved),
        Ok(_) => None,
        Err(error) => {
            claimed.run.finish(
                ScheduleRunStatus::Failed,
                now_ms(),
                Some(format!("반복 실행 상태를 저장하지 못했습니다: {error}")),
            );
            emit_result(inner, &claimed);
            None
        }
    }
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
    if let Err(error) = prepare_run_account(&inner, &mut claimed) {
        record_prepare_failure(&inner, &mut claimed, error);
        return;
    }
    let Some(started) = start_run(&inner, claimed) else {
        return;
    };
    claimed = started;
    // 세션 참조는 실행 시작에 한 번 확정한다. 저장된 정책만 쓰고, 상대 날짜가 절대 구간이
    // 되는 것은 여기 한 번뿐이다. 확정된 정책은 프롬프트 앞에 붙어 전달된다.
    let (session_preamble, session_record) = resolve_run_session_read_for_run(&inner, &claimed);
    claimed.run.session_reference = Some(session_record);
    let _ = finish_run(&inner.app_data_dir, &claimed);
    let use_resume = claimed.schedule.input.session_strategy == ScheduleSessionStrategy::Continue;
    let result = run_chat_attempts(&inner, &mut claimed, &control, session_preamble.as_deref());
    record_run_outcome(&mut claimed, result, &control, use_resume);
    finish_and_emit(&inner, &claimed);
}

/// 계정 준비 단계에서 걸린 회차를 확정한다. 대기는 다음 틱이 같은 회차를 처음부터 다시
/// 시도하도록 시작·종료 시각을 지우고 저장만 하고, 실패는 마지막 실행 시각까지 옮긴 뒤
/// 결과를 알린다.
fn record_prepare_failure(
    inner: &SchedulerInner,
    claimed: &mut ClaimedRun,
    error: PrepareRunError,
) {
    match error {
        PrepareRunError::Waiting(status, message) => {
            claimed.run.wait(status, Some(message));
            let _ = finish_run(&inner.app_data_dir, claimed);
        }
        PrepareRunError::Failed(message) => {
            claimed
                .run
                .finish(ScheduleRunStatus::Failed, now_ms(), Some(message));
            claimed.schedule.last_run_at = claimed.run.finished_at;
            finish_and_emit(inner, claimed);
        }
    }
}

/// 예약된 대화를 띄워 실행 결과를 받는다. 재개가 거절되면 정책에 따라 새 대화로 한 번 더
/// 시도하므로, 한 회차가 대화를 여는 횟수는 여기서만 늘어난다.
fn run_chat_attempts(
    inner: &Arc<SchedulerInner>,
    claimed: &mut ClaimedRun,
    control: &Arc<ActiveRunControl>,
    session_preamble: Option<&str>,
) -> Result<RunOutcome, String> {
    let previous = claimed.schedule.input.provider_session_id.clone();
    let use_resume = claimed.schedule.input.session_strategy == ScheduleSessionStrategy::Continue;
    let first = RunAttempt::new(inner, claimed, control, session_preamble)
        .run(use_resume.then_some(previous.as_deref()).flatten());
    match first {
        Err(error) if error.resume_failed && use_resume && previous.is_some() => {
            handle_resume_failure(inner, claimed, error.message, control, session_preamble)
        }
        result => result.map_err(|error| error.message),
    }
}

/// 실행 결과를 회차·반복 요청 기록에 옮긴다. 저장은 하지 않는다 — 부르는 쪽이 확정한다.
fn record_run_outcome(
    claimed: &mut ClaimedRun,
    result: Result<RunOutcome, String>,
    control: &ActiveRunControl,
    use_resume: bool,
) {
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
            let status = if control.cancelled.load(Ordering::Acquire) {
                ScheduleRunStatus::Cancelled
            } else if crate::chat::is_usage_limit_message(&error) {
                // 실행 도중 한도에 걸린 것은 이 회차의 잘못이 아니다. 세션이 한도 응답을
                // 받으면 계정이 이미 제한 상태로 표시되므로, 다음 틱의 사전 점검이 CLI를
                // 다시 띄우지 않고 복구될 때까지 이 회차를 대기시킨다.
                ScheduleRunStatus::WaitingForUsage
            } else {
                ScheduleRunStatus::Failed
            };
            // 대기로 남긴 회차는 아직 끝나지 않았다. 시작·종료 시각을 지워 다음 틱이
            // 같은 회차를 처음부터 다시 시도하게 한다.
            if status.is_waiting() {
                claimed.run.wait(status, Some(error));
            } else {
                claimed.run.finish(status, now, Some(error));
            }
        }
    }
    // 사용량 복구를 기다리는 회차는 아직 돈 것이 아니므로 마지막 실행 시각을 옮기지
    // 않는다. 옮기면 다음 예약 시각 계산이 돌지 않은 회차를 돈 것으로 센다.
    if !claimed.run.status.is_waiting() {
        claimed.schedule.last_run_at = Some(now);
    }
    claimed.schedule.updated_at = now;
}

/// 회차 기록을 저장하고 결과를 알린다. 저장이 실패해도 알림은 가야 하므로 손에 든 기록을
/// 그대로 쓴다.
fn finish_and_emit(inner: &SchedulerInner, claimed: &ClaimedRun) {
    let saved = finish_run(&inner.app_data_dir, claimed).unwrap_or_else(|_| claimed.clone());
    emit_result(inner, &saved);
}

/// 워크플로 반복 실행 한 회차. 공급자 CLI를 띄우지 않으므로 계정 준비·대화 재개·세션
/// 참조 경로를 타지 않고, 승인 검증과 실행 결과 기록만 한다.
fn execute_workflow_claim(
    inner: &Arc<SchedulerInner>,
    mut claimed: ClaimedRun,
    control: &Arc<ActiveRunControl>,
) {
    let Some(started) = start_run(inner, claimed) else {
        return;
    };
    claimed = started;
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
            // 실패만 쌓지 않고 멈춰 세운다. 사유를 함께 남기는 것은 계약이 다시 등록될 때
            // `adopt_workflow_version`이 이 회차를 되살려도 되는지 가리기 위해서다 — 사용자가
            // 일부러 끈 회차를 등록 한 번으로 켜 버리면 안 된다.
            if failure.pause_schedule {
                claimed.schedule.input.enabled = false;
                claimed.schedule.paused_reason = Some(SchedulePauseReason::WorkflowVersion);
            }
        }
    }
    claimed.run.finished_at = Some(now);
    claimed.run.last_heartbeat_at = Some(now);
    claimed.schedule.last_run_at = Some(now);
    claimed.schedule.updated_at = now;
    finish_and_emit(inner, &claimed);
}

struct WorkflowRunFailure {
    message: String,
    /// 다시 승인받아야 하는 사유. 같은 이유로 매 주기 실패하지 않게 반복 요청을 멈춘다.
    pause_schedule: bool,
}

impl WorkflowRunFailure {
    /// 이 회차만 실패로 접는다. 다음 주기는 그대로 다시 돈다.
    fn this_run(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            pause_schedule: false,
        }
    }

    /// 반복 요청까지 멈춘다. 승인 없이는 다음 주기도 같은 이유로 실패할 사유에만 쓴다.
    fn pausing(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            pause_schedule: true,
        }
    }
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
        return Err(WorkflowRunFailure::this_run(
            "워크플로 실행 계층을 사용할 수 없어 이 회차를 실행하지 않았습니다",
        ));
    };
    executor.validate_workflow(action).map_err(|error| {
        WorkflowRunFailure::pausing(format!(
            "워크플로를 실행할 수 없어 반복 요청을 일시정지했습니다: {error}"
        ))
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
                return result.map_err(|error| WorkflowRunFailure::this_run(error.to_string()))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = touch_run_heartbeat(&inner.app_data_dir, run_id, control);
                if startup_deadline_exceeded(started, MAX_RUN_DURATION) {
                    return Err(WorkflowRunFailure::this_run(format!(
                        "워크플로가 {}시간 안에 끝나지 않아 이 회차를 실패로 확정했습니다",
                        MAX_RUN_DURATION.as_secs() / 3600
                    )));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(WorkflowRunFailure::this_run(
                    "워크플로 실행 작업이 결과 없이 종료되었습니다",
                ))
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
            if let Some(run) = store.run_mut(&self.run_id) {
                run.expire_running(
                    now,
                    "반복 실행 소유 작업이 terminal 상태를 저장하기 전에 종료되었습니다".to_owned(),
                );
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
///
/// 준비는 세 단계다: 어느 계정으로 돌지 고르고 → 그 계정이 지금 쓸 수 있는지 보고 →
/// 자격증명 격리를 준비한다. 각 단계는 실패와 대기를 스스로 판별한다.
fn prepare_run_account(
    inner: &SchedulerInner,
    claimed: &mut ClaimedRun,
) -> Result<(), PrepareRunError> {
    let source = claimed.schedule.input.source;
    // 계정 레지스트리는 다중 계정을 관리하는 공급자만 담는다. 담기지 않는 공급자는 활성
    // 계정 조회 자체가 "지원하지 않는 계정 공급자"로 거절되어 준비 단계에서 회차가 통째로
    // 실패한다. 채팅 시작 경로가 그런 공급자를 계정 미귀속으로 시작하므로
    // (`chat::resolve_start_account_id`) 회차도 같은 규칙을 따른다. Antigravity는 이제
    // 레지스트리에 담기므로 이 갈래를 타지 않는다.
    if !source.manages_accounts() {
        claimed.run.actual_account_id = None;
        return Ok(());
    }
    let Some(accounts) = &inner.accounts else {
        claimed.run.actual_account_id = pinned_account_id(&claimed.schedule.input);
        return Ok(());
    };
    let (requested, subject) = requested_run_account(accounts, &claimed.schedule.input)?;
    ensure_account_ready(
        accounts,
        source,
        &requested,
        claimed.schedule.input.model.as_deref(),
        subject,
        &claimed.schedule.input.recurrence,
    )?;
    ensure_credential_isolation(accounts, source, &requested)?;
    claimed.run.actual_account_id = Some(requested);
    Ok(())
}

/// 이 회차가 쓸 계정과, 대기·실패 문구에서 그 계정을 부를 이름. 실행 시점 기본 계정을
/// 따르는 요청은 지금 기본 계정을 읽고, 고정 계정을 쓰는 요청은 저장된 값을 그대로 쓴다.
fn requested_run_account(
    accounts: &AccountSupervisor,
    input: &ScheduledRequestInput,
) -> Result<(String, &'static str), PrepareRunError> {
    if !input.use_active_account {
        return Ok((input.account_id.clone(), "반복 요청의 실행 계정"));
    }
    // 기본 계정이 아직 없으면 실패로 확정하지 않는다. 사용자가 기본 계정을 고르면
    // 다음 틱에서 그대로 이어 실행된다.
    let active = accounts
        .active_account_id(input.source)
        .map_err(|error| PrepareRunError::Failed(error.to_string()))?
        .ok_or_else(|| {
            PrepareRunError::Waiting(
                ScheduleRunStatus::WaitingForAccount,
                "실행 시점 활성 계정이 없어 대기합니다. 공급자의 활성 계정을 먼저 선택하세요"
                    .to_owned(),
            )
        })?;
    Ok((active, "실행 시점 활성 계정"))
}

/// 계정의 준비 상태를 회차의 처분으로 옮긴다. 사용자가 손대야 풀리는 상태만 실패로
/// 확정하고, 시간이 지나면 저절로 풀리는 상태는 대기로 남긴다.
fn ensure_account_ready(
    accounts: &AccountSupervisor,
    source: ProviderId,
    requested: &str,
    model: Option<&str>,
    subject: &'static str,
    recurrence: &ScheduleRecurrence,
) -> Result<(), PrepareRunError> {
    match accounts
        .run_readiness(source, requested, model)
        .map_err(|error| PrepareRunError::Failed(error.to_string()))?
    {
        RunReadiness::Ready => Ok(()),
        // 사용자가 끈 계정은 저절로 돌아오지 않으므로 이 회차를 실패로 확정한다.
        RunReadiness::Disabled => Err(PrepareRunError::Failed(format!(
            "{subject}이 비활성화되었습니다"
        ))),
        // 인증 상태를 잃은 것은 일시 상태일 수 있다. 공유 홈 자격증명 확인이 401이나
        // 중간에 끊긴 기록을 만나면 붙었다가 다음 조회가 성공하면 풀린다. 실패로
        // 확정하면 몇 분 뒤면 회복될 상태 때문에 예약된 회차가 통째로 날아가므로
        // 대기로 남겨 다음 틱에서 다시 확인한다.
        RunReadiness::NeedsReauthentication => Err(PrepareRunError::Waiting(
            ScheduleRunStatus::WaitingForAccount,
            format!(
                "{subject}의 인증이 확인되지 않아 대기합니다. 상태가 계속되면 이 계정을 다시 인증하세요"
            ),
        )),
        // 확인하지 못한 인증은 대기 시각이 지나면 그냥 실행해 본다. 실행되면 CLI가
        // 토큰을 회전시켜 계정이 스스로 낫고, 정말 거부된 자격증명이면 그 실행이
        // 실패하며 정확한 상태를 다시 만든다. 무한정 대기시키는 쪽이 오히려
        // 회복 경로를 닫는다.
        RunReadiness::AuthUnverified { retry_after } => {
            match retry_after.filter(|retry_after| *retry_after > now_ms()) {
                Some(retry_after) => Err(PrepareRunError::Waiting(
                    ScheduleRunStatus::WaitingForAccount,
                    match format_local_time(retry_after, &recurrence.timezone) {
                        Some(when) => format!(
                            "{subject}의 인증을 확인하지 못해 대기합니다 · {when} 이후 재시도"
                        ),
                        None => format!(
                            "{subject}의 인증을 확인하지 못해 대기합니다. 갱신 제한이 풀리면 이 회차를 이어서 실행합니다"
                        ),
                    },
                )),
                None => Ok(()),
            }
        }
        // 한도는 시간이 지나면 저절로 풀린다. 여기서 실패로 확정하면 사용자가 손댈 수
        // 없는 이유로 예약된 회차가 사라지므로, 복구될 때까지 이 회차를 그대로 멈춰 둔다.
        RunReadiness::UsageExhausted { resume_at } => Err(PrepareRunError::Waiting(
            ScheduleRunStatus::WaitingForUsage,
            usage_wait_message(subject, resume_at, recurrence),
        )),
    }
}

/// 모든 계정은 자기 격리 프로필로 실행된다. 프로브는 공급자 CLI를 실제로 띄우므로
/// 실행 직전에 한 번만 돌린다.
fn ensure_credential_isolation(
    accounts: &AccountSupervisor,
    source: ProviderId,
    requested: &str,
) -> Result<(), PrepareRunError> {
    if accounts.ensure_credential_isolation(source, requested) {
        return Ok(());
    }
    // 격리 준비 실패는 CLI 탐색 실패나 일시적 입출력으로도 생긴다. 실행을
    // 실패로 확정하지 않고 대기로 남긴다. 실패 판정은 재시도 시각까지만
    // 캐시되므로, 원인을 고치면 이후 틱에서 프로브가 다시 돌아 회복된다.
    Err(PrepareRunError::Waiting(
        ScheduleRunStatus::WaitingForAccount,
        match accounts.credential_profile_fallback_reason(requested) {
            Some(reason) => {
                format!("실행 계정의 자격증명 격리를 준비하지 못해 대기합니다: {reason}")
            }
            None => "실행 계정의 자격증명 격리를 준비하지 못해 대기합니다".to_owned(),
        },
    ))
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
    session_preamble: Option<&str>,
) -> Result<RunOutcome, String> {
    // 재개 실패로 새 대화를 열어도 처음 실행이 고른 계정을 그대로 쓴다(`RunAttempt`가
    // 회차에 적힌 계정을 읽는다). 실행 도중 활성 계정이 바뀌어도 계정이 갈리지 않는다.
    match claimed.schedule.input.resume_failure_policy {
        ResumeFailurePolicy::Pause => {
            claimed.schedule.input.enabled = false;
            Err(format!(
                "대화 재개에 실패해 반복 요청을 일시정지했습니다: {first_error}"
            ))
        }
        ResumeFailurePolicy::NewChat => {
            claimed.run.session_replaced = true;
            RunAttempt::new(inner, claimed, control, session_preamble)
                .fresh()
                .map_err(|error| error.message)
        }
        ResumeFailurePolicy::RetryThenNewChat => {
            claimed.run.retry_count = 1;
            let previous = claimed.schedule.input.provider_session_id.clone();
            let retried =
                RunAttempt::new(inner, claimed, control, session_preamble).run(previous.as_deref());
            match retried {
                Ok(outcome) => Ok(outcome),
                Err(error) if error.resume_failed => {
                    claimed.run.session_replaced = true;
                    RunAttempt::new(inner, claimed, control, session_preamble)
                        .fresh()
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

/// 세션 참조 없이 회차를 돌릴 때의 기록. 창을 잡지 못했으므로 `window_*`는 비고, 프롬프트
/// 앞에 붙일 안내도 없다. 사유(`summary`)와 부가 설명(`notes`)만 갈린다.
fn session_read_denied(
    summary: impl Into<String>,
    notes: Vec<String>,
) -> (Option<String>, ScheduleRunSessionRead) {
    (
        None,
        ScheduleRunSessionRead {
            granted: false,
            summary: summary.into(),
            window_from: None,
            window_to: None,
            notes,
        },
    )
}

/// 이 회차가 다른 에이전트 세션을 읽을 범위를 확정한다. 확정된 정책은 실행 프롬프트 앞에
/// 붙어 에이전트가 `session-context` 스킬에 그대로 넘길 수 있는 형태로 전달된다.
fn resolve_run_session_read_for_run(
    inner: &Arc<SchedulerInner>,
    claimed: &ClaimedRun,
) -> (Option<String>, ScheduleRunSessionRead) {
    let Some(settings) = claimed.schedule.input.session_reference.as_ref() else {
        return session_read_denied("세션 참조 사용 안 함", Vec::new());
    };
    let summary = crate::session_context::describe_policy(&settings.policy);
    if !settings.policy.enabled {
        return session_read_denied(summary, Vec::new());
    }
    let registered = match registered_project_paths(&inner.app_data_dir) {
        Ok(registered) => registered,
        Err(error) => {
            return session_read_denied(
                summary,
                vec![format!(
                    "등록 프로젝트를 확인하지 못해 세션 참조를 안내하지 않았습니다: {error}"
                )],
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

/// 회차 한 번을 띄우는 데 필요한 고정 항목 묶음. 한 회차 안에서 대화를 여러 번 열어도
/// 계정·회차 id·머리말은 그대로여야 하므로, 갈래마다 달라지는 것은 이어 붙일 세션 id
/// 하나뿐이다. 그 하나만 인자로 남기고 나머지는 회차가 확정한 값을 그대로 읽는다.
#[derive(Clone, Copy)]
struct RunAttempt<'a> {
    claimed: &'a ClaimedRun,
    chats: &'a ChatSupervisor,
    control: &'a Arc<ActiveRunControl>,
    app_data_dir: &'a Path,
    session_preamble: Option<&'a str>,
}

impl<'a> RunAttempt<'a> {
    fn new(
        inner: &'a Arc<SchedulerInner>,
        claimed: &'a ClaimedRun,
        control: &'a Arc<ActiveRunControl>,
        session_preamble: Option<&'a str>,
    ) -> Self {
        Self {
            claimed,
            chats: &inner.chats,
            control,
            app_data_dir: &inner.app_data_dir,
            session_preamble,
        }
    }

    /// 새 대화로 연다. 재개가 거절돼 갈아타는 자리에서 쓴다.
    fn fresh(&self) -> Result<RunOutcome, RunAttemptError> {
        self.run(None)
    }

    fn run(&self, resume_session_id: Option<&str>) -> Result<RunOutcome, RunAttemptError> {
        let RunAttempt {
            claimed,
            chats,
            control,
            app_data_dir,
            session_preamble,
        } = *self;
        let schedule = &claimed.schedule;
        let capture_id = claimed.run.id.as_str();
        let request = run_start_request(
            schedule,
            claimed.run.actual_account_id.as_deref(),
            capture_id,
            resume_session_id,
            control,
        );
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
        local_connection_id: schedule.input.local_connection_id.clone(),
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
        // 반복 요청은 **등록 자체가 허용**이다(2026-09-27 사용자 결정). 사람이 이 요청을
        // 만들 때 무엇을 시킬지 적었으므로, 그 실행이 Agent Manager 자신을 다루는 도구를
        // 쥐는 것까지 그 승인에 든다. 프로필은 그대로 Standard 다 — AIA 페르소나·작업
        // 경로·세션 휘발성까지 바꾸면 지금 도는 회차들이 기대는 것이 달라진다.
        system_tools: true,
        decision_policy: Default::default(),
        aia_runtime: None,
        record_session: false,
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
    let started = SystemTime::now();
    let mut progress = RunProgress::new(
        attachment.info.provider_session_id.clone(),
        resume_session_id.is_some(),
    );
    loop {
        let _ = touch_run_heartbeat(app_data_dir, capture_id, control);
        if let Some(reason) = run_abort_reason(control, started, progress.provider_activity) {
            let _ = chats.stop(chat_id);
            return Err(RunAttemptError::plain(reason));
        }
        let event = match attachment.events.recv_timeout(Duration::from_secs(1)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = chats.stop(chat_id);
                return Err(progress.failure("반복 요청 채팅 연결이 종료되었습니다".to_owned()));
            }
        };
        let Some(termination) = progress.apply(event) else {
            continue;
        };
        if termination.stops_chat() {
            let _ = chats.stop(chat_id);
        }
        return progress.finish(termination);
    }
}

/// 이벤트와 무관하게 훑기를 끊어야 하는 사유. 취소 → 총 실행 시한 → provider 무응답 순으로
/// 보고, 끊을 이유가 없으면 `None`.
fn run_abort_reason(
    control: &ActiveRunControl,
    started: SystemTime,
    provider_activity: bool,
) -> Option<&'static str> {
    if control.cancelled.load(Ordering::Acquire) {
        return Some("반복 요청 실행이 취소되었습니다");
    }
    if startup_deadline_exceeded(started, MAX_RUN_DURATION) {
        return Some("반복 요청 실행 시간이 6시간을 초과했습니다");
    }
    if !provider_activity && startup_deadline_exceeded(started, MAX_PROVIDER_STARTUP_DURATION) {
        return Some(
            "에이전트가 5분 안에 응답을 시작하지 않았습니다. 작업 경로 접근 권한을 확인하세요",
        );
    }
    None
}

/// 훑기가 끝난 사유. `stops_chat`이 이 자리에 있는 것은 "런타임이 이미 끝났다고 알려 온
/// 경우에는 다시 내리지 않는다"가 사유에 딸린 규칙이기 때문이다.
enum RunTermination {
    /// 턴이 정상으로 끝났다.
    Completed,
    /// 런타임은 아직 살아 있고 실행만 실패했다.
    Failed(String),
    /// 런타임이 스스로 종료를 알려 왔다.
    RuntimeGone(String),
}

impl RunTermination {
    fn stops_chat(&self) -> bool {
        !matches!(self, Self::RuntimeGone(_))
    }
}

/// 이벤트를 훑으며 쌓이는 것. 로그와 달리 여기 남는 값만 실행 결과에 실린다.
struct RunProgress {
    provider_session_id: Option<String>,
    summary: String,
    last_error: Option<String>,
    provider_activity: bool,
    resuming: bool,
}

impl RunProgress {
    fn new(provider_session_id: Option<String>, resuming: bool) -> Self {
        Self {
            provider_session_id,
            summary: String::new(),
            last_error: None,
            provider_activity: false,
            resuming,
        }
    }

    /// 이벤트 하나를 반영하고, 그 이벤트가 훑기를 끝내면 사유를 돌려준다.
    fn apply(&mut self, event: ChatEvent) -> Option<RunTermination> {
        match event {
            ChatEvent::State { session } => {
                self.provider_session_id = session.provider_session_id;
                matches!(session.state, ChatPhase::Stopped | ChatPhase::Failed).then(|| {
                    RunTermination::RuntimeGone(
                        "scheduler 소유 unattended runtime이 종료되어 반복 실행을 finalize했습니다"
                            .to_owned(),
                    )
                })
            }
            ChatEvent::MessageDelta {
                role, kind, delta, ..
            } if role == "assistant" => {
                self.provider_activity = true;
                if kind == "message" {
                    self.push_summary(&delta);
                }
                None
            }
            ChatEvent::Tool { status, .. } if status != "log" => {
                self.provider_activity = true;
                None
            }
            ChatEvent::Approval { .. } | ChatEvent::ApprovalResolved { .. } => {
                self.provider_activity = true;
                None
            }
            ChatEvent::Error { message } => {
                self.last_error = Some(message);
                None
            }
            ChatEvent::Turn { status, .. } if status != "started" => {
                Some(if status == "completed" {
                    RunTermination::Completed
                } else {
                    RunTermination::Failed(
                        self.last_error
                            .clone()
                            .unwrap_or_else(|| format!("에이전트 실행 상태: {status}")),
                    )
                })
            }
            _ => None,
        }
    }

    /// 요약은 앞에서부터 상한까지만 남긴다. 긴 실행에서 무한히 붙지 않게 조각마다 자른다.
    fn push_summary(&mut self, delta: &str) {
        self.summary.push_str(delta);
        if self.summary.chars().count() > MAX_RUN_SUMMARY_CHARS {
            self.summary = self.summary.chars().take(MAX_RUN_SUMMARY_CHARS).collect();
        }
    }

    /// provider가 한 번이라도 반응한 뒤의 실패는 재개 자체가 깨진 것이 아니다.
    fn failure(&self, message: String) -> RunAttemptError {
        RunAttemptError {
            message,
            resume_failed: self.resuming && !self.provider_activity,
        }
    }

    fn finish(self, termination: RunTermination) -> Result<RunOutcome, RunAttemptError> {
        match termination {
            RunTermination::Completed => Ok(RunOutcome {
                provider_session_id: self.provider_session_id,
                summary: clean_summary(self.summary),
            }),
            RunTermination::Failed(message) | RunTermination::RuntimeGone(message) => {
                Err(self.failure(message))
            }
        }
    }
}

fn finish_run(app_data_dir: &Path, claimed: &ClaimedRun) -> Result<ClaimedRun, CoreError> {
    with_store(app_data_dir, |store| {
        let mut saved = claimed.clone();
        if let Some(schedule) = store.schedule_mut(&claimed.schedule.id) {
            if !claimed.schedule.input.enabled {
                schedule.input.enabled = false;
            }
            schedule.input.provider_session_id = claimed.schedule.input.provider_session_id.clone();
            schedule.last_run_at = claimed.schedule.last_run_at;
            schedule.updated_at = claimed.schedule.updated_at;
            saved.schedule = schedule.clone();
        }
        if let Some(run) = store.run_mut(&claimed.run.id) {
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
        if let Some(run) = store.run_mut(run_id) {
            if matches!(run.status, ScheduleRunStatus::Running) {
                run.last_heartbeat_at = Some(now);
            }
        }
        Ok(())
    })
}

fn reconcile_expired_runs(inner: &Arc<SchedulerInner>, now: i64) -> Result<(), CoreError> {
    let persisted = read_store(&inner.app_data_dir)?;
    let expired = persisted
        .runs
        .into_iter()
        .filter(|run| run.status == ScheduleRunStatus::Running && run.lease_expired(now))
        .collect::<Vec<_>>();
    for run in expired {
        // 만기 정리는 잠금 손상도 정지 실패도 되돌릴 수 없으므로 결과를 버리고 저장만 이어간다.
        if let Some(control) = inner.execution_control(&run.id).ok().flatten() {
            let _ = inner.signal_cancellation(&control);
        }
        with_store(&inner.app_data_dir, |store| {
            if let Some(saved) = store.run_mut(&run.id) {
                saved.expire_running(
                    now,
                    format!(
                        "scheduler heartbeat가 {}초 동안 갱신되지 않아 실행 lease를 만료했습니다",
                        RUN_LEASE_EXPIRY.as_secs()
                    ),
                );
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
    if let Some(age_ms) = run.lease_age_ms(now) {
        reasons.push(format!("마지막 heartbeat {}초 전", age_ms / 1_000));
        if age_ms > run_lease_expiry_ms() {
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
/// 저장 락 안에서 생성·수정이 함께 하는 계산: 페이싱 회차 단독 보장 → 자동 간격 →
/// 다음 실행 시각. 자기 자신은 저장본이 아니라 저장될 상태(`input`)로 세므로 단독 보장의
/// 제외 대상도, 간격 계산에 끼워 넣는 회차도 같은 `id`다 — 생성 경로의 `id`는 방금 만든
/// UUID라 저장본에 없고, 수정 경로에서는 갱신 전 자기 행을 가린다.
fn plan_saved_run(
    app_data_dir: &Path,
    store: &SchedulerStore,
    auto: &crate::usage_pacing::AutoCadence,
    id: &str,
    input: &ScheduledRequestInput,
    now: i64,
) -> Result<i64, CoreError> {
    if input.enabled {
        if let Some(action) = input.workflow.as_ref() {
            ensure_single_active_paced_round(
                app_data_dir,
                &store.schedules,
                &action.workflow_id,
                Some(id),
            )?;
        }
    }
    next_run_with_cadence(input, &store.schedules, auto, Some((id, input)), now)
}

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

/// 반복 요청 입력을 저장 가능한 모양으로 다듬는다. 이름·반복 규칙·활성 창·세션 전략은
/// 두 실행 모양이 함께 지키고, 요청 본문에 해당하는 값(프롬프트·계정·작업 경로·모델)은
/// 워크플로 회차와 채팅 요청이 배타적으로 다룬다 — 한쪽은 쓰지 않는 값을 비우고 다른
/// 한쪽은 같은 값을 검증한다. 두 갈래를 한 몸에 두면 공통 규칙이 갈래 사이에 묻힌다.
fn validate_input(mut input: ScheduledRequestInput) -> Result<ScheduledRequestInput, CoreError> {
    input.name = input.name.trim().chars().take(120).collect();
    if input.name.is_empty() {
        return Err(CoreError::InvalidInput(
            "반복 요청 이름을 입력하세요".to_owned(),
        ));
    }
    if validate_workflow_action(input.workflow.as_mut())? {
        clear_chat_request_fields(&mut input);
    } else {
        validate_chat_request_fields(&mut input)?;
    }
    validate_recurrence(&input.recurrence)?;
    validate_active_window(&input)?;
    if input.session_strategy == ScheduleSessionStrategy::NewChat {
        input.provider_session_id = None;
    }
    Ok(input)
}

/// 워크플로 회차는 등록된 작업 호출만 돌린다. 프롬프트·계정·작업 경로·모델은 실행에
/// 쓰이지 않으므로 저장본에서 비운다.
fn clear_chat_request_fields(input: &mut ScheduledRequestInput) {
    input.prompt = String::new();
    input.account_id = String::new();
    input.use_active_account = false;
    input.cwd = String::new();
    input.model = None;
    input.local_connection_id = None;
    input.reasoning_effort = None;
    input.session_strategy = ScheduleSessionStrategy::NewChat;
}

/// 채팅 요청으로 도는 반복 요청이 실행 시점에 필요로 하는 값들을 확인하고 다듬는다.
fn validate_chat_request_fields(input: &mut ScheduledRequestInput) -> Result<(), CoreError> {
    input.prompt = input.prompt.trim().to_owned();
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
    // 작업 경로는 손으로 적는 칸이라 `user_path`가 해석한다(C6-1, C6-2). `fs::canonicalize`를
    // 직접 부르면 없는 폴더가 원시 `os error 2`로 흘러 화면이 `APP_NOT_FOUND`로만 보이고,
    // 채팅 시작과 달리 "폴더를 만들고 저장할까요"를 물을 수 없었다 — 로컬 세션에서 이어
    // 받은 옛 경로가 사라진 뒤 저장이 그렇게 막혔다.
    // 비운 경로는 그대로 비워 둔다 — 회차는 앱의 기본 작업공간에서 돈다(`resolve_start_cwd`).
    // 여기서 그 경로를 채워 넣으면 저장본이 장치별 앱 데이터 경로에 묶인다.
    input.cwd = if input.cwd.trim().is_empty() {
        String::new()
    } else {
        crate::user_path::resolve_existing_directory(&input.cwd)?
            .to_string_lossy()
            .into_owned()
    };
    input.model = input
        .model
        .take()
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty());
    // 연결 id 는 로컬 공급자에서만 뜻이 있다. 비었으면 기본 연결이라 저장하지 않는다.
    input.local_connection_id = match input.source {
        ProviderId::Local => input
            .local_connection_id
            .take()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
            .map(|id| crate::local_llm::normalize_connection_id(&id))
            .transpose()?,
        _ => None,
    };
    Ok(())
}

/// 이미 지난 창을 저장하는 것은 막지 않는다. 뒤집힌 창만 거절한다.
fn validate_active_window(input: &ScheduledRequestInput) -> Result<(), CoreError> {
    if let (Some(from), Some(until)) = (input.active_from, input.active_until) {
        if until <= from {
            return Err(CoreError::InvalidInput(
                "활성 종료 일시는 활성 시작 일시보다 뒤여야 합니다".to_owned(),
            ));
        }
    }
    Ok(())
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
    recurrence_timezone(recurrence)?;
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

/// 이 반복 요청의 다음 실행 시각을, 자동 주기 해석까지 끝내고 정한다.
///
/// 간격 해석(`minutes_for`)과 시각 계산(`next_run_in_window`)은 언제나 붙어 다니는데, 그
/// 사이에 세 가지 인자(자동 주기 워크플로 id, 세는 데 끼울 저장 전 회차, 회차의 제한
/// 시간대)를 자리마다 다시 조립해야 했다. 생성·수정·켜기·놓친 발화 정리·정책 갱신·훑기가
/// 각자 조립하다 보니 한 자리만 `round_quiet`을 빠뜨려도 그 경로에서만 제한 시간대가
/// 무시되는, 화면으로는 보이지 않는 어긋남이 생긴다. 조립을 여기 한 벌만 둔다.
///
/// `pending`은 아직 저장본에 없는(또는 저장본이 옛 상태인) 회차를 간격 계산에 끼워 넣는
/// 자리다 — 창을 나눠 쓸 회차 수에 자기 자신을 넣어야 하는 생성·수정·켜기 경로가 쓴다.
fn next_run_with_cadence(
    input: &ScheduledRequestInput,
    schedules: &[ScheduledRequest],
    auto: &crate::usage_pacing::AutoCadence,
    pending: Option<(&str, &ScheduledRequestInput)>,
    now: i64,
) -> Result<i64, CoreError> {
    let auto_minutes = auto.minutes_for(auto_workflow_id(input), schedules, pending, now);
    next_run_in_window(input, now, auto_minutes, auto.round_quiet(input))
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
    CronOccurrences::prepare(recurrence, after_ms)?
        .iter()
        .next()
        .ok_or_else(|| CoreError::InvalidInput("다음 실행 시각을 계산할 수 없습니다".to_owned()))
}

/// 저장된 반복 규칙의 시간대. 검증·다음 실행 계산·평균 간격 계산이 같은 문구로 거절해야
/// 사용자가 어느 화면에서 보든 같은 원인을 읽는다.
fn recurrence_timezone(recurrence: &ScheduleRecurrence) -> Result<Tz, CoreError> {
    recurrence
        .timezone
        .parse::<Tz>()
        .map_err(|_| CoreError::InvalidInput("시간대를 확인할 수 없습니다".to_owned()))
}

/// Cron 규칙 한 벌을 실제 발화 시각으로 펼칠 준비.
///
/// 다음 실행 시각과 평균 간격은 쓰는 개수만 다를 뿐, 그 앞에 필요한 네 걸음(시간대 파싱 →
/// 표현식 조립 → Cron 파싱 → 기준 시각을 그 시간대로 옮기기)이 완전히 같다. 두 자리가 각자
/// 적으면 순서가 어긋나는 순간 같은 손상된 저장본이 자리마다 다른 오류를 낸다 — 검사 순서가
/// 곧 오류 우선순위이기 때문이다. 그 순서를 여기 한 벌만 둔다.
struct CronOccurrences {
    schedule: Schedule,
    after: DateTime<Tz>,
}

impl CronOccurrences {
    fn prepare(recurrence: &ScheduleRecurrence, after_ms: i64) -> Result<Self, CoreError> {
        let timezone = recurrence_timezone(recurrence)?;
        let expression = schedule_expression(recurrence)?;
        let schedule = Schedule::from_str(&expression).map_err(|error| {
            CoreError::InvalidInput(format!("Cron 표현식이 올바르지 않습니다: {error}"))
        })?;
        let after = DateTime::<Utc>::from_timestamp_millis(after_ms)
            .ok_or_else(|| CoreError::InvalidInput("기준 시각이 올바르지 않습니다".to_owned()))?
            .with_timezone(&timezone);
        Ok(Self { schedule, after })
    }

    /// 기준 시각 이후의 발화를 epoch ms로 차례대로 돌려준다.
    fn iter(&self) -> impl Iterator<Item = i64> + '_ {
        self.schedule
            .after(&self.after)
            .map(|next| next.timestamp_millis())
    }
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
            let occurrences = CronOccurrences::prepare(recurrence, after_ms).ok()?;
            let occurrences: Vec<i64> = occurrences.iter().take(GAPS + 1).collect();
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

/// 워크플로가 새 버전으로 등록됐을 때 그 워크플로를 도는 회차 하나에 일어난 일.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowVersionAdoption {
    pub schedule_id: String,
    pub name: String,
    /// 승인 버전을 새 버전으로 올렸는가.
    pub adopted: bool,
    /// 버전이 어긋나 멈춰 있던 회차를 함께 되살렸는가.
    pub resumed: bool,
    /// 올리지 못한 사유. 올린 회차에는 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 새 버전이 등록된 워크플로에 묶인 회차의 승인 버전을 함께 올린다.
///
/// 승인 버전은 실행할 계약을 고정하지 않는다 — `preflight`는 언제나 최신판을 집고 번호만
/// 대조한다. 그래서 어긋난 번호가 막는 것은 "바뀐 계약"이 아니라 "사람이 한 번 누를 때까지의
/// 시간"이고, 그동안 회차는 주기마다 실패하다 멈춰 섰다. 재승인 화면이 계약 변경 내용을
/// 보여 주지도 않으므로 그 클릭은 정보를 주지도 받지도 않는다. 등록 자체가 승인을 거친
/// 조작이고 그 자리에서는 변경 요약을 보여 주므로, 동의는 거기서 받고 회차는 여기서 맞춘다.
///
/// 올리지 않는 경우는 동의가 아니라 정합성 문제 하나뿐이다: 저장된 인자가 새 입력 스키마를
/// 만족하지 못하면 올려 봐야 첫 기동에서 거절되므로, 사유를 남기고 편집기에서 채우게 한다.
pub fn adopt_workflow_version(
    app_data_dir: &Path,
    workflow_id: &str,
    version: u32,
    mut accept: impl FnMut(&Value) -> Result<(), String>,
) -> Result<Vec<WorkflowVersionAdoption>, CoreError> {
    let now = now_ms();
    with_store(app_data_dir, |store| {
        let mut report = Vec::new();
        for schedule in store.schedules.iter_mut() {
            let Some(action) = schedule.input.workflow.as_mut() else {
                continue;
            };
            if action.workflow_id != workflow_id || action.approved_version == version {
                continue;
            }
            let mut entry = WorkflowVersionAdoption {
                schedule_id: schedule.id.clone(),
                name: schedule.input.name.clone(),
                adopted: false,
                resumed: false,
                reason: None,
            };
            match accept(&action.arguments) {
                Ok(()) => {
                    action.approved_version = version;
                    entry.adopted = true;
                    // 이 사유로 멈춘 회차만 되살린다. 사용자가 끈 회차는 꺼진 채로 둔다.
                    if schedule.paused_reason == Some(SchedulePauseReason::WorkflowVersion) {
                        schedule.input.enabled = true;
                        entry.resumed = true;
                    }
                    schedule.updated_at = now;
                }
                Err(reason) => entry.reason = Some(reason),
            }
            report.push(entry);
        }
        Ok(report)
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
    // 켜져 있는 회차에는 멈춤 사유가 남지 않는다. 사유를 지우는 일을 조작마다 적으면 한
    // 자리만 빠져도 "자동 재승인이 되살리지 못하는 회차"나 "켜져 있는데 멈춤 사유가 붙은
    // 회차"가 생기므로, 저장 직전에 한 번에 맞춘다.
    for schedule in store.schedules.iter_mut() {
        if schedule.input.enabled {
            schedule.paused_reason = None;
        }
    }
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
    let mut store: SchedulerStore =
        read_private_json_or_default(&app_data_dir.join(STORE_FILE_NAME))?;
    migrate_accountless_inputs(&mut store);
    Ok(store)
}

/// 계정 없이 저장된 반복 요청을 활성 계정 실행으로 올린다.
///
/// 계정 레지스트리가 담지 않던 공급자는 저장 시점에 실행 계정이 통째로 비워졌다. 그
/// 공급자가 계정 관리를 지원하게 되면 그 저장본은 "계정도 없고 활성 계정도 쓰지 않는"
/// 값이 되어, 다음 실행이 계정을 찾지 못해 멈춘다. 지금까지의 동작이 곧 기계에 로그인된
/// 계정으로 도는 것이었으므로 활성 계정 실행으로 읽는다. 저장은 하지 않는다 — 사용자가
/// 편집할 때 그 자리에서 함께 굳는다.
fn migrate_accountless_inputs(store: &mut SchedulerStore) {
    for schedule in &mut store.schedules {
        if !schedule.input.source.manages_accounts() {
            continue;
        }
        if schedule.input.account_id.trim().is_empty() && !schedule.input.use_active_account {
            schedule.input.use_active_account = true;
        }
    }
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
    let summary = summary
        .trim()
        .chars()
        .take(MAX_RUN_SUMMARY_CHARS)
        .collect::<String>();
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
            local_connection_id: None,
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

    #[test]
    fn referenced_session_ids_collects_each_schedule_and_run_session_once() {
        let schedule = stored_schedule("schedule-1", input(Path::new("/tmp")), 1);
        let mut first_run = run_seed("run-1", &schedule.id, "account-1");
        first_run.provider_session_id = Some("thread-current".to_owned());
        first_run.previous_provider_session_id = Some("thread-123".to_owned());
        let mut second_run = run_seed("run-2", &schedule.id, "account-1");
        second_run.provider_session_id = Some("thread-second".to_owned());

        let store = SchedulerStore {
            schedules: vec![schedule],
            runs: vec![first_run, second_run],
            ..SchedulerStore::default()
        };

        assert_eq!(
            store.referenced_session_ids(),
            BTreeSet::from([
                "thread-123".to_owned(),
                "thread-current".to_owned(),
                "thread-second".to_owned(),
            ])
        );
    }

    /// C6-2: 없는 작업 경로는 화면이 "폴더를 만들까요"로 알아보는 접두사를 단 `NotFound`다.
    /// 원시 `os error 2`가 흘러가면 `APP_NOT_FOUND`로만 보여 사용자가 고칠 길이 없다.
    #[test]
    fn missing_cwd_is_reported_as_creatable_directory() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("not-yet");
        let error = validate_input(input(&missing)).expect_err("missing cwd must fail");
        match error {
            CoreError::NotFound(message) => {
                assert!(
                    message.starts_with(crate::user_path::MISSING_DIRECTORY_PREFIX),
                    "unexpected message: {message}"
                );
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    /// 작업 경로는 선택이다. 프로젝트가 없는 반복 요청(질문 하나를 매일 던지는 식)은 경로를
    /// 비워 저장하고, 회차는 앱의 기본 작업공간에서 돈다. 저장본에 그 경로를 채워 넣지 않아야
    /// 다른 장치의 앱 데이터 경로에 묶이지 않는다.
    #[test]
    fn empty_cwd_is_saved_empty_and_runs_in_the_default_workspace() {
        let mut request = input(Path::new("/unused"));
        request.cwd = "   ".to_owned();
        let saved = validate_input(request).expect("empty cwd is allowed");
        assert!(saved.cwd.is_empty());
    }

    #[test]
    fn cwd_that_is_a_file_is_invalid_input() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("plain.txt");
        fs::write(&file, b"x").unwrap();
        let error = validate_input(input(&file)).expect_err("file cwd must fail");
        assert!(matches!(error, CoreError::InvalidInput(_)), "{error:?}");
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
                    next_run_at: i64::MAX,
                    ..stored_schedule("schedule-123", request, 1)
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
        let mut value = serde_json::to_value(schedule_run(&stored_schedule(
            "schedule-1",
            input(Path::new("/tmp")),
            0,
        )))
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

    /// 아직 아무 일도 일어나지 않은 회차 기록. 시각·상태·계정만 자리를 잡고 나머지 열넷은
    /// 비어 있다. 시험은 여기에 자기가 보려는 칸만 덮어 쓴다.
    fn run_seed(id: &str, schedule_id: &str, account_id: &str) -> ScheduleRun {
        ScheduleRun {
            id: id.to_owned(),
            schedule_id: schedule_id.to_owned(),
            scheduled_for: now_ms(),
            started_at: None,
            finished_at: None,
            status: ScheduleRunStatus::WaitingForAccount,
            requested_account_id: account_id.to_owned(),
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
        }
    }

    /// 반복 요청이 방금 만들어 낸 대기 회차.
    fn schedule_run(schedule: &ScheduledRequest) -> ScheduleRun {
        ScheduleRun {
            previous_provider_session_id: schedule.input.provider_session_id.clone(),
            ..run_seed("run-test", &schedule.id, &schedule.input.account_id)
        }
    }

    /// 저장본에 바로 넣을 반복 요청 하나. 한 번도 돌지 않은 상태가 기본이고(`last_run_at`·
    /// `manual_run_requested_at`가 비어 있다), 만든·고친·다음 실행 시각은 모두 `at`이다.
    /// 시험은 자기가 보려는 시각만 덮어 쓴다.
    fn stored_schedule(id: &str, input: ScheduledRequestInput, at: i64) -> ScheduledRequest {
        ScheduledRequest {
            id: id.to_owned(),
            input,
            created_at: at,
            updated_at: at,
            next_run_at: at,
            last_run_at: None,
            manual_run_requested_at: None,
            paused_reason: None,
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

    /// 계약이 새 버전으로 등록되면 그 워크플로를 도는 회차가 승인 버전을 이어받는다.
    /// 되살리는 대상은 "이 사유로 멈춘 회차"뿐이다 — 사용자가 끈 회차를 등록 한 번으로
    /// 켜 버리면 자동 적용이 사용자 결정을 덮는다.
    #[test]
    fn adopt_workflow_version_raises_bound_rounds_and_resumes_only_its_own_pauses() {
        let temp = tempfile::tempdir().unwrap();
        let at = 1_000;
        let bound = |id: &str, enabled: bool, reason: Option<SchedulePauseReason>| {
            let mut request = workflow_input(temp.path());
            request.enabled = enabled;
            let mut schedule = stored_schedule(id, request, at);
            schedule.paused_reason = reason;
            schedule
        };
        with_store(temp.path(), |store| {
            // 버전 어긋남으로 스케줄러가 멈춘 회차.
            store.schedules.push(bound(
                "s-paused",
                false,
                Some(SchedulePauseReason::WorkflowVersion),
            ));
            // 사용자가 직접 끈 회차.
            store.schedules.push(bound("s-user-off", false, None));
            // 돌고 있는 회차.
            store.schedules.push(bound("s-live", true, None));
            // 다른 워크플로에 묶인 회차는 건드리지 않는다.
            let mut other = bound("s-other", true, None);
            other.input.workflow.as_mut().unwrap().workflow_id = "wf-other".to_owned();
            store.schedules.push(other);
            Ok(())
        })
        .unwrap();

        let report = adopt_workflow_version(temp.path(), " wf-usage ", 4, |_| Ok(())).unwrap();
        let seen: Vec<(&str, bool, bool)> = report
            .iter()
            .map(|entry| (entry.schedule_id.as_str(), entry.adopted, entry.resumed))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("s-paused", true, true),
                ("s-user-off", true, false),
                ("s-live", true, false),
            ]
        );

        let store = read_store(temp.path()).unwrap();
        let of = |id: &str| {
            store
                .schedules
                .iter()
                .find(|schedule| schedule.id == id)
                .expect("schedule")
        };
        assert_eq!(
            of("s-paused")
                .input
                .workflow
                .as_ref()
                .unwrap()
                .approved_version,
            4
        );
        assert!(
            of("s-paused").input.enabled,
            "멈춘 사유가 풀렸으면 다시 켠다"
        );
        assert_eq!(of("s-paused").paused_reason, None);
        assert!(
            !of("s-user-off").input.enabled,
            "사용자가 끈 회차는 꺼진 채로 둔다"
        );
        assert_eq!(
            of("s-user-off")
                .input
                .workflow
                .as_ref()
                .unwrap()
                .approved_version,
            4
        );
        // 다른 워크플로의 회차는 승인 버전도 그대로다.
        assert_eq!(
            of("s-other")
                .input
                .workflow
                .as_ref()
                .unwrap()
                .approved_version,
            3
        );
    }

    /// 저장된 인자가 새 입력 스키마를 못 채우면 올리지 않는다. 올려 두면 첫 기동에서
    /// 거절되어, 멈춘 회차를 켜 놓고 실패만 쌓는 지금보다 나쁜 상태가 된다.
    #[test]
    fn adopt_workflow_version_leaves_rounds_whose_arguments_no_longer_fit() {
        let temp = tempfile::tempdir().unwrap();
        with_store(temp.path(), |store| {
            let mut schedule = stored_schedule("s-stale", workflow_input(temp.path()), 1_000);
            schedule.input.enabled = false;
            schedule.paused_reason = Some(SchedulePauseReason::WorkflowVersion);
            store.schedules.push(schedule);
            Ok(())
        })
        .unwrap();

        let report = adopt_workflow_version(temp.path(), " wf-usage ", 4, |_| {
            Err("필수 입력 projectPath가 비어 있습니다".to_owned())
        })
        .unwrap();
        assert_eq!(report.len(), 1);
        assert!(!report[0].adopted);
        assert!(!report[0].resumed);
        assert_eq!(
            report[0].reason.as_deref(),
            Some("필수 입력 projectPath가 비어 있습니다")
        );

        let store = read_store(temp.path()).unwrap();
        let schedule = &store.schedules[0];
        assert_eq!(
            schedule.input.workflow.as_ref().unwrap().approved_version,
            3
        );
        assert!(!schedule.input.enabled, "올리지 못한 회차는 멈춘 채로 둔다");
        assert_eq!(
            schedule.paused_reason,
            Some(SchedulePauseReason::WorkflowVersion),
            "사유가 남아야 다음 등록에서 다시 되살릴 수 있다"
        );
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
            next_run_at: now + 60_000,
            ..stored_schedule(
                "schedule-workflow",
                validate_input(workflow_input(app_data_dir)).expect("워크플로 입력"),
                now,
            )
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
                scheduled_for: index,
                status: ScheduleRunStatus::Skipped,
                ..run_seed(&format!("run-{index}"), "schedule-1", "codex-account-1")
            });
        }
        trim_runs(&mut store);
        assert_eq!(store.runs.len(), 50);
        assert_eq!(store.runs[0].id, "run-5");
    }

    #[test]
    fn schedules_are_sorted_by_creation_time() {
        let older = ScheduledRequest {
            created_at: 100,
            ..stored_schedule("schedule-older", input(Path::new("/tmp")), 900)
        };
        let newer = ScheduledRequest {
            created_at: 200,
            ..stored_schedule("schedule-newer", input(Path::new("/tmp")), 100)
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

    /// Antigravity가 계정 공급자가 되면서 반복 요청도 실행 계정을 갖는다. 기본 계정을
    /// 고르지 않았으면 실패가 아니라 대기다 — 계정을 고르는 순간 그대로 이어져야 하고,
    /// 회차를 날려 버리면 사용자가 원인을 화면에서 찾을 수 없다.
    #[test]
    fn an_antigravity_schedule_waits_until_a_default_account_is_chosen() {
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
        // Antigravity도 계정 공급자가 되면서 실행 시점에 활성 계정을 읽는다. 고정 계정과
        // 실행 시점 조회가 동시에 남지 않도록 고정 값만 비운다.
        assert_eq!(schedule.input.account_id, "");
        assert!(schedule.input.use_active_account);

        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        let waiting = prepare_run_account(&supervisor.inner, &mut claimed)
            .expect_err("활성 계정이 없으면 대기한다");
        assert!(matches!(
            waiting,
            PrepareRunError::Waiting(ScheduleRunStatus::WaitingForAccount, _)
        ));
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
                next_run_at: 1,
                ..stored_schedule("schedule-waiting", input(data.path()), now)
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
                next_run_at: now + 60_000,
                ..stored_schedule("schedule-interrupted", input(temp.path()), now - 2_000)
            });
            store.runs.push(ScheduleRun {
                scheduled_for: now - 1_000,
                started_at: Some(now - 1_000),
                status: ScheduleRunStatus::Running,
                actual_account_id: Some("codex-account-1".to_owned()),
                previous_provider_session_id: Some("thread-123".to_owned()),
                last_heartbeat_at: Some(now - 1_000),
                ..run_seed("run-interrupted", "schedule-interrupted", "codex-account-1")
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
