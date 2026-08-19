use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use fs4::FileExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::store::{self, SupplementOrigin};
use crate::{
    terminate_external_provider_processes, AccountSupervisor, AccountTransitionGuard,
    ChatApprovalMode, ChatEvent, ChatMode, ChatPhase, ChatProfile, ChatStartRequest,
    ChatSupervisor, CoreError, ProviderId, ReasoningEffort,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResumeFailurePolicy {
    Pause,
    NewChat,
    RetryThenNewChat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRequestInput {
    pub name: String,
    pub prompt: String,
    pub source: ProviderId,
    pub account_id: String,
    pub auto_switch_when_idle: bool,
    /// 계정 전환이 필요할 때 실행 중인 관리 런타임과 외부 공급자 CLI
    /// 프로세스를 강제 종료하고 전환할지 여부. `auto_switch_when_idle`이
    /// 켜진 경우에만 적용된다.
    #[serde(default)]
    pub force_session_cleanup: bool,
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
    Running,
    Completed,
    Failed,
    Skipped,
    Cancelled,
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
    pub previous_active_account_id: Option<String>,
    pub account_switched: bool,
    #[serde(default)]
    pub transition_id: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTransitionRecoveryRequest {
    pub provider: ProviderId,
    pub run_id: String,
    pub transition_id: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTransitionRecoveryReceipt {
    pub provider: ProviderId,
    pub run_id: String,
    pub transition_id: String,
    pub restored: bool,
    pub lease_cleared: bool,
    pub already_recovered: bool,
    pub recovery_error: Option<String>,
    pub stale_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAndRecoverScheduledRunReceipt {
    pub cancellation: ScheduledRunCancellationReceipt,
    pub recovery: Option<ProviderTransitionRecoveryReceipt>,
    pub partial_failure: bool,
}

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
}

pub struct SchedulerAttachment {
    pub events: Receiver<SchedulerEvent>,
}

#[derive(Clone)]
pub struct SchedulerSupervisor {
    inner: Arc<SchedulerInner>,
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
}

#[derive(Default)]
struct ActiveRunControl {
    cancelled: Arc<AtomicBool>,
    chat_id: Mutex<Option<String>>,
    last_heartbeat_at: AtomicI64,
}

impl SchedulerSupervisor {
    pub fn new(app_data_dir: PathBuf, chats: ChatSupervisor) -> Result<Self, CoreError> {
        fs::create_dir_all(&app_data_dir)?;
        backfill_completed_summaries(&app_data_dir)?;
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
        });
        if runner_active {
            spawn_scheduler_loop(Arc::downgrade(&inner));
        }
        Ok(Self { inner })
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

    pub fn create(&self, input: ScheduledRequestInput) -> Result<ScheduledRequest, CoreError> {
        let input = validate_input(input)?;
        self.validate_account(&input)?;
        let now = now_ms();
        let next_run_at = next_run_after(&input.recurrence, now)?;
        with_store(&self.inner.app_data_dir, |store| {
            let schedule = ScheduledRequest {
                id: format!("schedule-{}", Uuid::new_v4()),
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
    ) -> Result<ScheduledRequest, CoreError> {
        let input = validate_input(input)?;
        self.validate_account(&input)?;
        let now = now_ms();
        let next_run_at = next_run_after(&input.recurrence, now)?;
        with_store(&self.inner.app_data_dir, |store| {
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
            Ok(())
        })
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ScheduledRequest, CoreError> {
        with_store(&self.inner.app_data_dir, |store| {
            let now = now_ms();
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
                if enabled {
                    schedule.next_run_at = next_run_after(&schedule.input.recurrence, now)?;
                } else {
                    schedule.manual_run_requested_at = None;
                }
                schedule.clone()
            };
            if !enabled {
                for run in store.runs.iter_mut().filter(|run| {
                    run.schedule_id == id && run.status == ScheduleRunStatus::WaitingForAccount
                }) {
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
        if run_status_is_terminal(current.status) {
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
            if !run_status_is_terminal(run.status) {
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

    pub fn recover_provider_transition(
        &self,
        request: ProviderTransitionRecoveryRequest,
    ) -> Result<ProviderTransitionRecoveryReceipt, CoreError> {
        let store = read_store(&self.inner.app_data_dir)?;
        let run = store
            .runs
            .iter()
            .find(|run| run.id == request.run_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("반복 요청 실행을 찾을 수 없습니다".to_owned()))?;
        let schedule = store
            .schedules
            .iter()
            .find(|schedule| schedule.id == run.schedule_id)
            .ok_or_else(|| CoreError::NotFound("반복 요청을 찾을 수 없습니다".to_owned()))?;
        if schedule.input.source != request.provider {
            return Err(CoreError::Conflict(
                "run 공급자와 복구 요청 공급자가 일치하지 않습니다".to_owned(),
            ));
        }
        if let Some(run_transition_id) = run.transition_id.as_deref() {
            if run_transition_id != request.transition_id {
                return Err(CoreError::Conflict(
                    "run이 소유한 transition token과 요청 token이 일치하지 않습니다".to_owned(),
                ));
            }
        } else if !run.account_switched {
            return Err(CoreError::Conflict(
                "이 run은 계정 전환 소유권을 기록하지 않았습니다".to_owned(),
            ));
        }
        if self
            .inner
            .executions
            .lock()
            .map_err(|_| CoreError::Runtime("반복 실행 소유권 잠금이 손상되었습니다".to_owned()))?
            .get(&run.id)
            .is_some_and(|control| !control.cancelled.load(Ordering::Acquire))
        {
            return Err(CoreError::Conflict(
                "정상 실행 소유자가 heartbeat를 갱신 중이므로 전환 복구를 거부했습니다".to_owned(),
            ));
        }
        if !run_status_is_terminal(run.status) {
            return Err(CoreError::Conflict(
                "run을 먼저 취소하거나 terminal 상태로 확정해야 합니다".to_owned(),
            ));
        }
        let previous = run.previous_active_account_id.as_deref().ok_or_else(|| {
            CoreError::Conflict("복원할 이전 활성 계정 identity가 없습니다".to_owned())
        })?;
        let target = run
            .actual_account_id
            .as_deref()
            .ok_or_else(|| CoreError::Conflict("전환 대상 계정 identity가 없습니다".to_owned()))?;
        let accounts = self
            .inner
            .accounts
            .as_ref()
            .ok_or_else(|| CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned()))?;
        let recovery = accounts.recover_provider_transition(
            request.provider,
            &request.transition_id,
            previous,
            target,
        )?;
        if let Some(error) = recovery.recovery_error.as_deref() {
            let _ = with_store(&self.inner.app_data_dir, |store| {
                if let Some(saved) = store.runs.iter_mut().find(|saved| saved.id == run.id) {
                    saved.recovery_error = Some(error.to_owned());
                }
                Ok(())
            });
        }
        Ok(ProviderTransitionRecoveryReceipt {
            provider: request.provider,
            run_id: request.run_id,
            transition_id: request.transition_id,
            restored: recovery.restored,
            lease_cleared: recovery.lease_cleared,
            already_recovered: recovery.already_recovered,
            recovery_error: recovery.recovery_error,
            stale_reasons: stale_run_reasons(&run, now_ms()),
        })
    }

    pub fn cancel_and_recover_run(
        &self,
        request: ProviderTransitionRecoveryRequest,
        reason: Option<&str>,
    ) -> Result<CancelAndRecoverScheduledRunReceipt, CoreError> {
        let cancellation = self.cancel_run(&request.run_id, reason)?;
        let deadline = SystemTime::now() + Duration::from_secs(3);
        while self
            .inner
            .executions
            .lock()
            .ok()
            .is_some_and(|executions| executions.contains_key(&request.run_id))
            && SystemTime::now() < deadline
        {
            thread::sleep(Duration::from_millis(50));
        }
        let recovery = match self.recover_provider_transition(request.clone()) {
            Ok(recovery) => recovery,
            Err(error) => ProviderTransitionRecoveryReceipt {
                provider: request.provider,
                run_id: request.run_id,
                transition_id: request.transition_id,
                restored: false,
                lease_cleared: false,
                already_recovered: false,
                recovery_error: Some(error.to_string()),
                stale_reasons: cancellation.stale_reasons.clone(),
            },
        };
        let partial_failure = cancellation.stop_error.is_some()
            || recovery.recovery_error.is_some()
            || !recovery.lease_cleared;
        Ok(CancelAndRecoverScheduledRunReceipt {
            cancellation,
            recovery: Some(recovery),
            partial_failure,
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
            .filter(|schedule| schedule.input.account_id == account_id)
            .count())
    }

    fn validate_account(&self, input: &ScheduledRequestInput) -> Result<(), CoreError> {
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
    with_store(app_data_dir, |store| {
        for schedule in &mut store.schedules {
            if schedule.input.enabled && schedule.next_run_at <= now {
                schedule.next_run_at = next_run_after(&schedule.input.recurrence, now)?;
            }
        }
        Ok(())
    })
}

fn claim_due(inner: &Arc<SchedulerInner>, now: i64) -> Result<Vec<ClaimedRun>, CoreError> {
    if read_store(&inner.app_data_dir)?.paused {
        return Ok(Vec::new());
    }
    let running = inner
        .running
        .lock()
        .map_err(|_| CoreError::Runtime("반복 요청 실행 잠금이 손상되었습니다".to_owned()))?
        .clone();
    let mut claimed = Vec::new();
    with_store(&inner.app_data_dir, |store| {
        if store.paused {
            return Ok(());
        }
        for schedule in &mut store.schedules {
            let manual = schedule.manual_run_requested_at.take();
            let regular_due = schedule.input.enabled && schedule.next_run_at <= now;
            let regular_scheduled_for = schedule.next_run_at;
            if regular_due {
                schedule.next_run_at = next_run_after(&schedule.input.recurrence, now)?;
            }
            if let Some(waiting) = store.runs.iter().find(|run| {
                run.schedule_id == schedule.id && run.status == ScheduleRunStatus::WaitingForAccount
            }) {
                if !running.contains(&schedule.id) {
                    claimed.push(ClaimedRun {
                        schedule: schedule.clone(),
                        run: waiting.clone(),
                    });
                }
                continue;
            }
            if manual.is_none() && !regular_due {
                continue;
            }
            let scheduled_for = manual.unwrap_or(regular_scheduled_for);
            let mut run = ScheduleRun {
                id: format!("run-{}", Uuid::new_v4()),
                schedule_id: schedule.id.clone(),
                scheduled_for,
                started_at: None,
                finished_at: None,
                status: ScheduleRunStatus::WaitingForAccount,
                requested_account_id: schedule.input.account_id.clone(),
                actual_account_id: None,
                previous_active_account_id: None,
                account_switched: false,
                transition_id: None,
                provider_session_id: None,
                previous_provider_session_id: schedule.input.provider_session_id.clone(),
                session_replaced: false,
                retry_count: 0,
                summary: None,
                error: None,
                last_heartbeat_at: None,
                cancellation_requested_at: None,
                recovery_error: None,
            };
            if running.contains(&schedule.id) {
                run.status = ScheduleRunStatus::Skipped;
                run.finished_at = Some(now);
                run.error = Some("이전 실행이 끝나지 않아 건너뛰었습니다".to_owned());
            } else {
                claimed.push(ClaimedRun {
                    schedule: schedule.clone(),
                    run: run.clone(),
                });
            }
            store.runs.push(run);
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
    let transition = match prepare_run_account(&inner, &mut claimed) {
        Ok(transition) => transition,
        Err(PrepareRunError::Waiting(message)) => {
            claimed.run.status = ScheduleRunStatus::WaitingForAccount;
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
    claimed.run.transition_id = transition
        .as_ref()
        .map(AccountTransitionGuard::id)
        .map(str::to_owned);
    match finish_run(&inner.app_data_dir, &claimed) {
        Ok(saved) if saved.run.status == ScheduleRunStatus::Running => claimed = saved,
        Ok(_) => {
            if let Some(transition) = transition {
                let _ = transition.restore();
            }
            if let Ok(mut running) = inner.running.lock() {
                running.remove(&claimed.schedule.id);
            }
            return;
        }
        Err(error) => {
            if let Some(transition) = transition {
                let _ = transition.restore();
            }
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
    let previous = claimed.schedule.input.provider_session_id.clone();
    let use_resume = claimed.schedule.input.session_strategy == ScheduleSessionStrategy::Continue;
    let first = execute_once(
        &inner.chats,
        &claimed.schedule,
        &claimed.run.id,
        use_resume.then_some(previous.as_deref()).flatten(),
        transition.as_ref().map(AccountTransitionGuard::id),
        &control,
        &inner.app_data_dir,
    );
    let result = match first {
        Err(error) if error.resume_failed && use_resume && previous.is_some() => {
            handle_resume_failure(
                &inner,
                &mut claimed,
                error.message,
                transition.as_ref().map(AccountTransitionGuard::id),
                &control,
                &inner.app_data_dir,
            )
        }
        result => result.map_err(|error| error.message),
    };
    let mut result = result;
    if let Some(transition) = transition {
        if let Err(error) = transition.restore() {
            result = Err(format!("이전 활성 계정을 복원하지 못했습니다: {error}"));
        }
    }
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
            } else {
                ScheduleRunStatus::Failed
            };
            claimed.run.error = Some(error);
            claimed.run.finished_at = Some(now);
        }
    }
    claimed.schedule.last_run_at = Some(now);
    claimed.schedule.updated_at = now;
    let saved = finish_run(&inner.app_data_dir, &claimed).unwrap_or_else(|_| claimed.clone());
    emit_result(&inner, &saved);
    if let Ok(mut running) = inner.running.lock() {
        running.remove(&claimed.schedule.id);
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
    Waiting(String),
    Failed(String),
}

fn prepare_run_account(
    inner: &SchedulerInner,
    claimed: &mut ClaimedRun,
) -> Result<Option<AccountTransitionGuard>, PrepareRunError> {
    let Some(accounts) = &inner.accounts else {
        claimed.run.actual_account_id = Some(claimed.schedule.input.account_id.clone());
        return Ok(None);
    };
    let requested = claimed.schedule.input.account_id.as_str();
    if !accounts
        .account_is_enabled_for_provider(claimed.schedule.input.source, requested)
        .map_err(|error| PrepareRunError::Failed(error.to_string()))?
    {
        return Err(PrepareRunError::Failed(
            "반복 요청의 실행 계정이 비활성화되었거나 재인증이 필요합니다".to_owned(),
        ));
    }
    let active = accounts
        .active_account_id(claimed.schedule.input.source)
        .map_err(|error| PrepareRunError::Failed(error.to_string()))?;
    claimed.run.previous_active_account_id = active.clone();
    if active.as_deref() == Some(requested) {
        claimed.run.actual_account_id = Some(requested.to_owned());
        claimed.run.account_switched = false;
        return Ok(None);
    }
    if !claimed.schedule.input.auto_switch_when_idle {
        return Err(PrepareRunError::Waiting(
            "선택한 실행 계정이 활성화될 때까지 대기합니다".to_owned(),
        ));
    }
    let source = claimed.schedule.input.source;
    let mut attempt = accounts.begin_temporary_switch(source, requested);
    if claimed.schedule.input.force_session_cleanup {
        // 강제 정리 옵션: 전환이 세션 충돌로 막힐 때만 정리하고 한 번 더
        // 시도한다. 유휴 상태라면 아무 세션도 종료하지 않는다.
        if matches!(&attempt, Err(CoreError::Conflict(_))) {
            cleanup_provider_sessions(inner, source)?;
            attempt = accounts.begin_temporary_switch(source, requested);
        }
    }
    match attempt {
        Ok(Some(transition)) => {
            claimed.run.actual_account_id = Some(requested.to_owned());
            claimed.run.account_switched = true;
            Ok(Some(transition))
        }
        Ok(None) => {
            claimed.run.actual_account_id = Some(requested.to_owned());
            claimed.run.account_switched = false;
            Ok(None)
        }
        Err(CoreError::Conflict(message)) => Err(PrepareRunError::Waiting(message)),
        Err(error) => Err(PrepareRunError::Failed(error.to_string())),
    }
}

/// 강제 정리 옵션이 켜진 반복 요청의 계정 전환을 위해 해당 공급자의 관리
/// 런타임과 외부 독립 실행 CLI 프로세스를 종료한다. 관리 런타임이 강제
/// 종료까지 실패하면 전환하지 않고 다음 틱에 재시도한다. 외부 프로세스
/// 종료 실패는 수동 계정 전환과 같은 정책으로 전환을 막지 않는다.
fn cleanup_provider_sessions(
    inner: &SchedulerInner,
    source: ProviderId,
) -> Result<(), PrepareRunError> {
    let report = inner
        .chats
        .stop_provider_chats(source)
        .map_err(|error| PrepareRunError::Failed(error.to_string()))?;
    if !report.failed.is_empty() {
        let failed_ids = report
            .failed
            .iter()
            .map(|failure| failure.chat_id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(PrepareRunError::Waiting(format!(
            "세션 강제 정리가 실패해 계정을 전환하지 못했습니다 (실패: {failed_ids})"
        )));
    }
    let _ = terminate_external_provider_processes(source);
    Ok(())
}

fn handle_resume_failure(
    inner: &Arc<SchedulerInner>,
    claimed: &mut ClaimedRun,
    first_error: String,
    transition_id: Option<&str>,
    control: &Arc<ActiveRunControl>,
    app_data_dir: &Path,
) -> Result<RunOutcome, String> {
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
                &claimed.run.id,
                None,
                transition_id,
                control,
                app_data_dir,
            )
            .map_err(|error| error.message)
        }
        ResumeFailurePolicy::RetryThenNewChat => {
            claimed.run.retry_count = 1;
            match execute_once(
                &inner.chats,
                &claimed.schedule,
                &claimed.run.id,
                claimed.schedule.input.provider_session_id.as_deref(),
                transition_id,
                control,
                app_data_dir,
            ) {
                Ok(outcome) => Ok(outcome),
                Err(error) if error.resume_failed => {
                    claimed.run.session_replaced = true;
                    execute_once(
                        &inner.chats,
                        &claimed.schedule,
                        &claimed.run.id,
                        None,
                        transition_id,
                        control,
                        app_data_dir,
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

fn execute_once(
    chats: &ChatSupervisor,
    schedule: &ScheduledRequest,
    capture_id: &str,
    resume_session_id: Option<&str>,
    transition_id: Option<&str>,
    control: &Arc<ActiveRunControl>,
    app_data_dir: &Path,
) -> Result<RunOutcome, RunAttemptError> {
    let request = ChatStartRequest {
        source: schedule.input.source,
        account_id: Some(schedule.input.account_id.clone()),
        cwd: schedule.input.cwd.clone(),
        model: schedule.input.model.clone(),
        reasoning_effort: schedule.input.reasoning_effort,
        mode: schedule.input.mode,
        approval_mode: schedule.input.approval_mode,
        resume_session_id: resume_session_id.map(str::to_owned),
        capture_id: Some(capture_id.to_owned()),
        unattended: true,
        profile: ChatProfile::Standard,
        settings: Default::default(),
        account_transition_id: transition_id.map(str::to_owned),
        startup_cancel: Some(Arc::clone(&control.cancelled)),
    };
    let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
    let startup_chats = chats.clone();
    thread::spawn(move || {
        let _ = startup_sender.send(startup_chats.start(request));
    });
    let startup_started = SystemTime::now();
    let attachment = loop {
        if control.cancelled.load(Ordering::Acquire) {
            return Err(RunAttemptError {
                message: "반복 요청 실행 취소로 provider startup을 중단했습니다".to_owned(),
                resume_failed: false,
            });
        }
        if startup_deadline_exceeded(startup_started, MAX_PROVIDER_STARTUP_DURATION) {
            control.cancelled.store(true, Ordering::Release);
            return Err(RunAttemptError {
                message: "에이전트 provider startup이 5분을 초과했습니다. 작업 경로와 CLI 탐색 상태를 확인하세요".to_owned(),
                resume_failed: false,
            });
        }
        let _ = touch_run_heartbeat(app_data_dir, capture_id, control);
        match startup_receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(attachment)) => break attachment,
            Ok(Err(error)) => {
                let resume_failed = matches!(&error, CoreError::ResumeFailed(_));
                return Err(RunAttemptError {
                    message: error.to_string(),
                    resume_failed,
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(RunAttemptError {
                    message: "provider startup 작업이 예기치 않게 종료되었습니다".to_owned(),
                    resume_failed: false,
                });
            }
        }
    };
    let chat_id = attachment.info.chat_id.clone();
    if let Ok(mut active_chat_id) = control.chat_id.lock() {
        *active_chat_id = Some(chat_id.clone());
    }
    if control.cancelled.load(Ordering::Acquire) {
        let _ = chats.stop(&chat_id);
        return Err(RunAttemptError {
            message: "반복 요청 실행이 취소되었습니다".to_owned(),
            resume_failed: false,
        });
    }
    let mut provider_session_id = attachment.info.provider_session_id.clone();
    if let Err(error) = chats.send(&chat_id, &schedule.input.prompt) {
        let _ = chats.stop(&chat_id);
        return Err(RunAttemptError {
            message: error.to_string(),
            resume_failed: resume_session_id.is_some(),
        });
    }
    let started = SystemTime::now();
    let mut summary = String::new();
    let mut last_error = None;
    let mut provider_activity = false;
    loop {
        let _ = touch_run_heartbeat(app_data_dir, capture_id, control);
        if control.cancelled.load(Ordering::Acquire) {
            let _ = chats.stop(&chat_id);
            return Err(RunAttemptError {
                message: "반복 요청 실행이 취소되었습니다".to_owned(),
                resume_failed: false,
            });
        }
        let elapsed = started.elapsed().unwrap_or_default();
        if elapsed > MAX_RUN_DURATION {
            let _ = chats.stop(&chat_id);
            return Err(RunAttemptError {
                message: "반복 요청 실행 시간이 6시간을 초과했습니다".to_owned(),
                resume_failed: false,
            });
        }
        if !provider_activity && elapsed > MAX_PROVIDER_STARTUP_DURATION {
            let _ = chats.stop(&chat_id);
            return Err(RunAttemptError {
                message: "에이전트가 5분 안에 응답을 시작하지 않았습니다. 작업 경로 접근 권한을 확인하세요"
                    .to_owned(),
                resume_failed: false,
            });
        }
        match attachment.events.recv_timeout(Duration::from_secs(1)) {
            Ok(ChatEvent::State { session }) => {
                provider_session_id = session.provider_session_id;
                if matches!(session.state, ChatPhase::Stopped | ChatPhase::Failed) {
                    return Err(RunAttemptError {
                        message: "scheduler 소유 unattended runtime이 종료되어 반복 실행을 finalize했습니다".to_owned(),
                        resume_failed: resume_session_id.is_some() && !provider_activity,
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
                let _ = chats.stop(&chat_id);
                if status == "completed" {
                    return Ok(RunOutcome {
                        provider_session_id,
                        summary: clean_summary(summary),
                    });
                }
                return Err(RunAttemptError {
                    message: last_error.unwrap_or_else(|| format!("에이전트 실행 상태: {status}")),
                    resume_failed: resume_session_id.is_some() && !provider_activity,
                });
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = chats.stop(&chat_id);
                return Err(RunAttemptError {
                    message: "반복 요청 채팅 연결이 종료되었습니다".to_owned(),
                    resume_failed: resume_session_id.is_some() && !provider_activity,
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
            if !run_status_is_terminal(run.status) {
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
    let sources = persisted
        .schedules
        .iter()
        .map(|schedule| (schedule.id.as_str(), schedule.input.source))
        .collect::<HashMap<_, _>>();
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
        let owner_active = control.is_some();
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
        if !owner_active && run.account_switched {
            let recovery_error = match (
                inner.accounts.as_ref(),
                sources.get(run.schedule_id.as_str()).copied(),
                run.previous_active_account_id.as_deref(),
                run.actual_account_id.as_deref(),
            ) {
                (Some(accounts), Some(provider), Some(previous), Some(target)) => {
                    let transition_id = run.transition_id.clone().or_else(|| {
                        accounts.snapshot().ok().and_then(|snapshot| {
                            snapshot
                                .providers
                                .into_iter()
                                .find(|state| state.provider == provider)
                                .and_then(|state| state.transition)
                                .filter(|transition| {
                                    transition.previous_active_account_id == previous
                                        && transition.target_account_id == target
                                })
                                .map(|transition| transition.transition_id)
                        })
                    });
                    match transition_id {
                        Some(transition_id) => accounts
                            .recover_provider_transition(provider, &transition_id, previous, target)
                            .map_err(|error| error.to_string())
                            .and_then(|receipt| receipt.recovery_error.map_or(Ok(()), Err))
                            .err(),
                        None => Some(
                            "만료된 run과 일치하는 transition identity를 찾지 못했습니다"
                                .to_owned(),
                        ),
                    }
                }
                _ => Some("만료된 run의 계정 전환 identity가 불완전합니다".to_owned()),
            };
            if let Some(error) = recovery_error {
                with_store(&inner.app_data_dir, |store| {
                    if let Some(saved) = store.runs.iter_mut().find(|saved| saved.id == run.id) {
                        saved.recovery_error = Some(error.clone());
                    }
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}

fn run_status_is_terminal(status: ScheduleRunStatus) -> bool {
    matches!(
        status,
        ScheduleRunStatus::Completed
            | ScheduleRunStatus::Failed
            | ScheduleRunStatus::Skipped
            | ScheduleRunStatus::Cancelled
    )
}

fn normalize_cancel_reason(reason: Option<&str>) -> String {
    let reason = reason
        .unwrap_or("운영자가 반복 요청 실행을 취소했습니다")
        .trim();
    let reason = if reason.is_empty() {
        "운영자가 반복 요청 실행을 취소했습니다"
    } else {
        reason
    };
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

fn validate_input(mut input: ScheduledRequestInput) -> Result<ScheduledRequestInput, CoreError> {
    input.name = input.name.trim().chars().take(120).collect();
    if input.name.is_empty() {
        return Err(CoreError::InvalidInput(
            "반복 요청 이름을 입력하세요".to_owned(),
        ));
    }
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
    if input.account_id.is_empty() {
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
    validate_recurrence(&input.recurrence)?;
    if input.session_strategy == ScheduleSessionStrategy::NewChat {
        input.provider_session_id = None;
    }
    Ok(input)
}

fn validate_recurrence(recurrence: &ScheduleRecurrence) -> Result<(), CoreError> {
    if recurrence.interval == 0 || recurrence.interval > 168 {
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
    schedule_expression(recurrence)?;
    Ok(())
}

fn next_run_after(recurrence: &ScheduleRecurrence, after_ms: i64) -> Result<i64, CoreError> {
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
    };
    if five.split_whitespace().count() != 5 {
        return Err(CoreError::InvalidInput(
            "Cron은 분 시 일 월 요일의 5개 필드여야 합니다".to_owned(),
        ));
    }
    Ok(format!("0 {five}"))
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
    let path = app_data_dir.join(STORE_FILE_NAME);
    if !path.is_file() {
        return Ok(SchedulerStore::default());
    }
    serde_json::from_str(&fs::read_to_string(path)?).map_err(CoreError::Json)
}

fn save_store_unlocked(app_data_dir: &Path, store: &SchedulerStore) -> Result<(), CoreError> {
    let path = app_data_dir.join(STORE_FILE_NAME);
    let temporary = app_data_dir.join(format!(".{STORE_FILE_NAME}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec_pretty(store)?)?;
    if cfg!(windows) && path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
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
            auto_switch_when_idle: true,
            force_session_cleanup: false,
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
        }
    }

    #[test]
    fn stored_schedules_without_cleanup_flag_default_to_disabled() {
        let mut value = serde_json::to_value(input(Path::new("/tmp"))).unwrap();
        value.as_object_mut().unwrap().remove("forceSessionCleanup");
        let parsed: ScheduledRequestInput = serde_json::from_value(value).unwrap();
        assert!(!parsed.force_session_cleanup);
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
            previous_active_account_id: None,
            account_switched: false,
            transition_id: None,
            provider_session_id: None,
            previous_provider_session_id: schedule.input.provider_session_id.clone(),
            session_replaced: false,
            retry_count: 0,
            summary: None,
            error: None,
            last_heartbeat_at: None,
            cancellation_requested_at: None,
            recovery_error: None,
        }
    }

    fn two_accounts(data: &Path, home: &Path) -> (AccountSupervisor, String, String) {
        let codex_home = home.join(".codex");
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(
            codex_home.join("auth.json"),
            json!({"tokens": {"account_id": "account-a", "access_token": "secret-a"}}).to_string(),
        )
        .unwrap();
        let accounts = AccountSupervisor::open_for_test(data, home).unwrap();
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
            assert!(next_run_after(&recurrence(frequency), after).unwrap() > after);
        }
    }

    #[test]
    fn five_field_cron_is_validated() {
        let mut value = recurrence(ScheduleFrequency::Cron);
        value.cron = Some("*/15 * * * *".to_owned());
        assert!(next_run_after(&value, 1_735_689_600_000).is_ok());
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
                previous_active_account_id: None,
                account_switched: false,
                transition_id: None,
                provider_session_id: None,
                previous_provider_session_id: None,
                session_replaced: false,
                retry_count: 0,
                summary: None,
                error: None,
                last_heartbeat_at: None,
                cancellation_requested_at: None,
                recovery_error: None,
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

    #[test]
    fn selected_non_active_account_waits_when_auto_switch_is_disabled() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, _a, b) = two_accounts(data.path(), home.path());
        let chats = ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts).unwrap();
        let supervisor = SchedulerSupervisor::new(data.path().to_path_buf(), chats).unwrap();
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b;
        schedule_input.auto_switch_when_idle = false;
        let schedule = supervisor.create(schedule_input).unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        assert!(matches!(
            prepare_run_account(&supervisor.inner, &mut claimed),
            Err(PrepareRunError::Waiting(_))
        ));
        assert_eq!(claimed.run.status, ScheduleRunStatus::WaitingForAccount);
    }

    #[test]
    fn auto_switch_preserves_resume_session_and_restores_previous_account() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, a, b) = two_accounts(data.path(), home.path());
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = SchedulerSupervisor::new(data.path().to_path_buf(), chats).unwrap();
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b.clone();
        schedule_input.auto_switch_when_idle = true;
        schedule_input.provider_session_id = Some("same-provider-session".to_owned());
        let schedule = supervisor.create(schedule_input).unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        let transition = prepare_run_account(&supervisor.inner, &mut claimed)
            .unwrap()
            .unwrap();
        assert_eq!(
            claimed.schedule.input.provider_session_id.as_deref(),
            Some("same-provider-session")
        );
        assert_eq!(
            claimed.run.previous_active_account_id.as_deref(),
            Some(a.as_str())
        );
        assert_eq!(claimed.run.actual_account_id.as_deref(), Some(b.as_str()));
        transition.restore().unwrap();
        assert_eq!(
            accounts
                .active_account_id(ProviderId::Codex)
                .unwrap()
                .as_deref(),
            Some(a.as_str())
        );
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

    #[test]
    fn disabling_a_schedule_cancels_its_waiting_account_run() {
        let data = tempfile::tempdir().unwrap();
        let supervisor =
            SchedulerSupervisor::new(data.path().to_path_buf(), ChatSupervisor::new()).unwrap();
        let schedule = supervisor.create(input(data.path())).unwrap();
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
        let supervisor = SchedulerSupervisor::new(temp.path().to_path_buf(), ChatSupervisor::new())
            .expect("scheduler supervisor");
        let created = supervisor
            .create(input(temp.path()))
            .expect("create schedule");
        assert_eq!(
            created.input.resume_failure_policy,
            ResumeFailurePolicy::RetryThenNewChat
        );
        let mut changed = created.input;
        changed.resume_failure_policy = ResumeFailurePolicy::Pause;
        let updated = supervisor
            .update(&created.id, changed)
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
                previous_active_account_id: Some("codex-account-1".to_owned()),
                account_switched: false,
                transition_id: None,
                provider_session_id: None,
                previous_provider_session_id: Some("thread-123".to_owned()),
                session_replaced: false,
                retry_count: 0,
                summary: None,
                error: None,
                last_heartbeat_at: Some(now - 1_000),
                cancellation_requested_at: None,
                recovery_error: None,
            });
            Ok(())
        })
        .expect("seed scheduler store");

        let supervisor = SchedulerSupervisor::new(temp.path().to_path_buf(), ChatSupervisor::new())
            .expect("scheduler supervisor");
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
        let supervisor =
            SchedulerSupervisor::new(temp.path().to_path_buf(), ChatSupervisor::new()).unwrap();
        let schedule = supervisor.create(input(temp.path())).unwrap();
        let mut run = schedule_run(&schedule);
        run.status = ScheduleRunStatus::Running;
        run.started_at = Some(now_ms() - 120_000);
        run.last_heartbeat_at = None;
        run.account_switched = true;
        run.previous_active_account_id = Some("codex-previous".to_owned());
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
        let supervisor =
            SchedulerSupervisor::new(temp.path().to_path_buf(), ChatSupervisor::new()).unwrap();
        let schedule = supervisor.create(input(temp.path())).unwrap();
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
        let supervisor =
            SchedulerSupervisor::new(temp.path().to_path_buf(), ChatSupervisor::new()).unwrap();
        let schedule = supervisor.create(input(temp.path())).unwrap();
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
    fn transition_recovery_rejects_a_normal_active_owner() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, _a, b) = two_accounts(data.path(), home.path());
        let chats = ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts).unwrap();
        let supervisor = SchedulerSupervisor::new(data.path().to_path_buf(), chats).unwrap();
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b;
        let schedule = supervisor.create(schedule_input).unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        let transition = prepare_run_account(&supervisor.inner, &mut claimed)
            .unwrap()
            .unwrap();
        claimed.run.status = ScheduleRunStatus::Cancelled;
        claimed.run.finished_at = Some(now_ms());
        claimed.run.transition_id = Some(transition.id().to_owned());
        with_store(data.path(), |store| {
            store.runs.push(claimed.run.clone());
            Ok(())
        })
        .unwrap();
        supervisor.inner.executions.lock().unwrap().insert(
            claimed.run.id.clone(),
            Arc::new(ActiveRunControl::default()),
        );

        let error = supervisor
            .recover_provider_transition(ProviderTransitionRecoveryRequest {
                provider: ProviderId::Codex,
                run_id: claimed.run.id.clone(),
                transition_id: transition.id().to_owned(),
            })
            .unwrap_err();
        assert!(error.to_string().contains("정상 실행 소유자"));
        transition.restore().unwrap();
    }

    #[test]
    fn orphan_switched_run_is_cancelled_then_restores_previous_account() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, a, b) = two_accounts(data.path(), home.path());
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = SchedulerSupervisor::new(data.path().to_path_buf(), chats).unwrap();
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b.clone();
        let schedule = supervisor.create(schedule_input).unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        let transition = prepare_run_account(&supervisor.inner, &mut claimed)
            .unwrap()
            .unwrap();
        let transition_id = transition.id().to_owned();
        claimed.run.status = ScheduleRunStatus::Running;
        claimed.run.started_at = Some(now_ms() - 120_000);
        claimed.run.transition_id = Some(transition_id.clone());
        with_store(data.path(), |store| {
            store.runs.push(claimed.run.clone());
            Ok(())
        })
        .unwrap();

        let receipt = supervisor
            .cancel_and_recover_run(
                ProviderTransitionRecoveryRequest {
                    provider: ProviderId::Codex,
                    run_id: claimed.run.id.clone(),
                    transition_id,
                },
                Some("고아 run 복구 테스트"),
            )
            .unwrap();

        assert_eq!(
            receipt.cancellation.run.status,
            ScheduleRunStatus::Cancelled
        );
        assert!(!receipt.partial_failure);
        assert!(receipt.recovery.as_ref().unwrap().restored);
        assert!(receipt.recovery.as_ref().unwrap().lease_cleared);
        assert_eq!(
            accounts.active_account_id(ProviderId::Codex).unwrap(),
            Some(a)
        );
        assert_ne!(
            accounts.active_account_id(ProviderId::Codex).unwrap(),
            Some(b)
        );
        drop(transition);
    }

    #[test]
    fn expired_orphan_heartbeat_auto_finalizes_and_restores_transition() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (accounts, a, b) = two_accounts(data.path(), home.path());
        let chats =
            ChatSupervisor::with_accounts(data.path().to_path_buf(), accounts.clone()).unwrap();
        let supervisor = SchedulerSupervisor::new(data.path().to_path_buf(), chats).unwrap();
        let mut schedule_input = input(data.path());
        schedule_input.account_id = b;
        let schedule = supervisor.create(schedule_input).unwrap();
        let mut claimed = ClaimedRun {
            run: schedule_run(&schedule),
            schedule,
        };
        let transition = prepare_run_account(&supervisor.inner, &mut claimed)
            .unwrap()
            .unwrap();
        claimed.run.status = ScheduleRunStatus::Running;
        claimed.run.started_at = Some(now_ms() - 180_000);
        claimed.run.last_heartbeat_at = claimed.run.started_at;
        claimed.run.transition_id = Some(transition.id().to_owned());
        with_store(data.path(), |store| {
            store.runs.push(claimed.run.clone());
            Ok(())
        })
        .unwrap();

        reconcile_expired_runs(&supervisor.inner, now_ms()).unwrap();

        let saved = supervisor
            .snapshot()
            .unwrap()
            .runs
            .into_iter()
            .find(|run| run.id == claimed.run.id)
            .unwrap();
        assert_eq!(saved.status, ScheduleRunStatus::Failed);
        assert!(saved.finished_at.is_some());
        assert!(saved.recovery_error.is_none());
        assert_eq!(
            accounts.active_account_id(ProviderId::Codex).unwrap(),
            Some(a)
        );
        assert!(
            !accounts
                .snapshot()
                .unwrap()
                .providers
                .iter()
                .find(|provider| provider.provider == ProviderId::Codex)
                .unwrap()
                .transition_in_progress
        );
        drop(transition);
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
        let supervisor = SchedulerSupervisor::new(temp.path().to_path_buf(), ChatSupervisor::new())
            .expect("scheduler supervisor");
        let created = supervisor
            .create(input(temp.path()))
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
}
