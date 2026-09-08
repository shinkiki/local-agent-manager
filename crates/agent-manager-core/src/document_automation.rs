//! Registered-document folder change detection and automation metadata.
//!
//! This module deliberately owns only Agent Manager data. Registered folders stay
//! authoritative; the SQLite index can be rebuilt at any time. Provider actions are
//! delegated through [`DocumentActionExecutor`] so this layer never learns provider
//! credentials and never executes shell strings.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

use crate::app_data_file::{ensure_schema_version, write_private_json};
use crate::clock::now_ms;
use crate::file_kind::ensure_not_symlink;
use crate::store_lock::{self, StoreLock};
use crate::{list_doc_roots, ChatApprovalMode, ChatMode, CoreError, ProviderId, ReasoningEffort};

const INDEX_FILE_NAME: &str = "document-index.sqlite3";
const TRIGGER_STORE_FILE_NAME: &str = "document-triggers-v1.json";
const TRIGGER_LOCK_FILE_NAME: &str = "document-triggers-v1.lock";
const TRIGGER_STORE_SCHEMA_VERSION: u32 = 1;
const PENDING_STORE_FILE_NAME: &str = "document-trigger-pending-v1.json";
const PENDING_STORE_SCHEMA_VERSION: u32 = 1;
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const DEFAULT_DEBOUNCE_MS: i64 = 2_000;
const DEFAULT_COOLDOWN_MS: i64 = 30_000;
const MIN_DEBOUNCE_MS: i64 = 250;
const MAX_DEBOUNCE_MS: i64 = 60_000;
const MAX_COOLDOWN_MS: i64 = 24 * 60 * 60 * 1_000;
const CIRCUIT_WINDOW_MS: i64 = 10 * 60 * 1_000;
const CIRCUIT_MAX_RUNS: usize = 5;
const MAX_PATTERNS: usize = 32;
const MAX_PATTERN_LEN: usize = 512;
const MAX_EVENT_PATHS: usize = 200;
const MAX_STORED_RUNS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentChangeKind {
    Created,
    Modified,
    Deleted,
}

impl DocumentChangeKind {
    pub const ALL: [Self; 3] = [Self::Created, Self::Modified, Self::Deleted];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
        }
    }
}

impl std::fmt::Display for DocumentChangeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for DocumentChangeKind {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "created" => Ok(Self::Created),
            "modified" => Ok(Self::Modified),
            "deleted" => Ok(Self::Deleted),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 문서 변경 종류입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChange {
    pub kind: DocumentChangeKind,
    pub relative_path: String,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChangeBatch {
    pub event_id: String,
    pub root_id: String,
    pub root_path: String,
    pub detected_at: i64,
    pub changes: Vec<DocumentChange>,
    pub total_count: usize,
    pub omitted_count: usize,
    #[serde(default)]
    pub test: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSkillBinding {
    pub skill_id: String,
    pub content_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChatAction {
    pub source: ProviderId,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    pub mode: ChatMode,
    #[serde(default)]
    pub approval_mode: ChatApprovalMode,
    pub prompt: String,
    #[serde(default)]
    pub skill: Option<DocumentSkillBinding>,
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWorkflowAction {
    pub workflow_id: String,
    pub approved_version: u32,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocumentTriggerAction {
    RunSchedule { schedule_id: String },
    StartChat(DocumentChatAction),
    ExecuteWorkflow(DocumentWorkflowAction),
}

impl DocumentTriggerAction {
    fn kind_name(&self) -> &'static str {
        match self {
            Self::RunSchedule { .. } => "runSchedule",
            Self::StartChat(_) => "startChat",
            Self::ExecuteWorkflow(_) => "executeWorkflow",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentTriggerStatus {
    Active,
    Paused,
    Degraded,
    NeedsReview,
    Restricted,
}

impl DocumentTriggerStatus {
    pub const ALL: [Self; 5] = [
        Self::Active,
        Self::Paused,
        Self::Degraded,
        Self::NeedsReview,
        Self::Restricted,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Degraded => "degraded",
            Self::NeedsReview => "needsReview",
            Self::Restricted => "restricted",
        }
    }
}

impl std::fmt::Display for DocumentTriggerStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for DocumentTriggerStatus {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "degraded" => Ok(Self::Degraded),
            "needsReview" => Ok(Self::NeedsReview),
            "restricted" => Ok(Self::Restricted),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 문서 트리거 상태입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTriggerInput {
    pub name: String,
    pub root_id: String,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub change_kinds: Vec<DocumentChangeKind>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_debounce_ms")]
    pub debounce_ms: i64,
    #[serde(default = "default_cooldown_ms")]
    pub cooldown_ms: i64,
    pub action: DocumentTriggerAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTrigger {
    pub id: String,
    #[serde(flatten)]
    pub input: DocumentTriggerInput,
    pub status: DocumentTriggerStatus,
    #[serde(default)]
    pub status_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentTriggerRunStatus {
    Running,
    Completed,
    Failed,
    Skipped,
}

impl DocumentTriggerRunStatus {
    pub const ALL: [Self; 4] = [Self::Running, Self::Completed, Self::Failed, Self::Skipped];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    /// 실행이 종료된 상태인지 확인합니다.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Skipped)
    }
}

impl std::fmt::Display for DocumentTriggerRunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for DocumentTriggerRunStatus {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "skipped" => Ok(Self::Skipped),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 문서 트리거 실행 상태입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTriggerRun {
    pub id: String,
    pub trigger_id: String,
    pub event_id: String,
    pub action: String,
    pub status: DocumentTriggerRunStatus,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    #[serde(default)]
    pub result_id: Option<String>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub test: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOfflineChangeReport {
    pub id: String,
    pub created_at: i64,
    pub root_count: usize,
    pub changes: Vec<DocumentChangeBatch>,
    pub total_count: usize,
    pub omitted_count: usize,
    pub acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentActionOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hard_to_recover_effects: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAutomationOptions {
    #[serde(default)]
    pub scheduled_requests: Vec<DocumentActionOption>,
    #[serde(default)]
    pub skills: Vec<DocumentActionOption>,
    #[serde(default)]
    pub workflows: Vec<DocumentActionOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAutomationSnapshot {
    pub triggers: Vec<DocumentTrigger>,
    pub runs: Vec<DocumentTriggerRun>,
    pub offline_report: Option<DocumentOfflineChangeReport>,
    pub options: DocumentAutomationOptions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentActionContext {
    pub trigger_id: String,
    pub trigger_name: String,
    pub idempotency_key: String,
    pub batch: DocumentChangeBatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentActionReceipt {
    #[serde(default)]
    pub result_id: Option<String>,
    #[serde(default)]
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentActionErrorKind {
    Failed,
    Degraded,
    NeedsReview,
}

#[derive(Debug, Clone)]
pub struct DocumentActionError {
    pub kind: DocumentActionErrorKind,
    pub message: String,
}

impl DocumentActionError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            kind: DocumentActionErrorKind::Failed,
            message: message.into(),
        }
    }

    pub fn degraded(message: impl Into<String>) -> Self {
        Self {
            kind: DocumentActionErrorKind::Degraded,
            message: message.into(),
        }
    }

    pub fn needs_review(message: impl Into<String>) -> Self {
        Self {
            kind: DocumentActionErrorKind::NeedsReview,
            message: message.into(),
        }
    }
}

impl From<CoreError> for DocumentActionError {
    fn from(error: CoreError) -> Self {
        Self::failed(error.to_string())
    }
}

/// Provider-specific lookups and execution stay outside this module. Registration
/// calls `validate_action`, every snapshot can request current selectable options,
/// and live/test runs call `execute_action` with a stable idempotency key.
pub trait DocumentActionExecutor: Send + Sync + 'static {
    fn options(&self) -> Result<DocumentAutomationOptions, CoreError> {
        Ok(DocumentAutomationOptions::default())
    }

    fn validate_action(&self, _action: &DocumentTriggerAction) -> Result<(), CoreError> {
        Ok(())
    }

    fn execute_action(
        &self,
        action: &DocumentTriggerAction,
        context: &DocumentActionContext,
    ) -> Result<DocumentActionReceipt, DocumentActionError>;
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriggerStore {
    schema_version: u32,
    #[serde(default)]
    triggers: Vec<DocumentTrigger>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileState {
    size_bytes: u64,
    modified_ns: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRootBatch {
    root_path: String,
    last_change_at: i64,
    changes: BTreeMap<String, DocumentChange>,
}

#[derive(Default)]
struct RuntimeState {
    pending_roots: HashMap<String, PendingRootBatch>,
    pending_actions: HashMap<String, DocumentChangeBatch>,
    inflight_actions: HashMap<String, DocumentChangeBatch>,
    running: HashSet<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DurablePendingStore {
    schema_version: u32,
    #[serde(default)]
    pending_roots: HashMap<String, PendingRootBatch>,
    #[serde(default)]
    pending_actions: HashMap<String, DocumentChangeBatch>,
    #[serde(default)]
    inflight_actions: HashMap<String, DocumentChangeBatch>,
}

struct DocumentAutomationInner {
    app_data_dir: PathBuf,
    executor: Arc<dyn DocumentActionExecutor>,
    runtime: Mutex<RuntimeState>,
}

#[derive(Clone)]
pub struct DocumentAutomationSupervisor {
    inner: Arc<DocumentAutomationInner>,
}

impl DocumentAutomationSupervisor {
    pub fn new(
        app_data_dir: PathBuf,
        executor: Arc<dyn DocumentActionExecutor>,
    ) -> Result<Self, CoreError> {
        Self::new_with_background_runner(app_data_dir, executor, true)
    }

    fn new_with_background_runner(
        app_data_dir: PathBuf,
        executor: Arc<dyn DocumentActionExecutor>,
        start_background_runner: bool,
    ) -> Result<Self, CoreError> {
        fs::create_dir_all(&app_data_dir)?;
        initialize_database(&app_data_dir)?;
        let pending = load_pending_store(&app_data_dir)?;
        // 실행 중이던 오래된 배치를 바탕으로, 그 뒤 쌓인 최신 대기 배치를 incoming으로
        // 합쳐 최신 eventId를 보존한다. 반대 순서는 downstream 멱등 replay가 새 변경까지
        // 삼켜 버린다.
        let mut pending_actions = pending.inflight_actions;
        for (trigger_id, batch) in pending.pending_actions {
            merge_action_batch(&mut pending_actions, &trigger_id, batch);
        }
        let supervisor = Self {
            inner: Arc::new(DocumentAutomationInner {
                app_data_dir,
                executor,
                runtime: Mutex::new(RuntimeState {
                    pending_roots: pending.pending_roots,
                    pending_actions,
                    inflight_actions: HashMap::new(),
                    running: HashSet::new(),
                }),
            }),
        };
        {
            let runtime = lock_runtime(&supervisor.inner)?;
            save_pending_state(&supervisor.inner.app_data_dir, &runtime)?;
        }
        if start_background_runner {
            // 문서 루트 기준선 스캔은 iCloud·OneDrive 같은 파일 공급자 마운트에서 디렉터리
            // 하나를 여는 데도 수 분씩 멈출 수 있다(2026-08-30 재시작 실측: `opendir`에서
            // 무한 대기해 백엔드가 HTTP 응답을 시작하지 못했다). 서버 시작을 막지 않도록
            // 뒤에서 돌리고, 스캔이 끝난 뒤에야 변경 감시를 시작한다 — 기준선 전에 감시가
            // 돌면 오프라인 변경이 보고가 아니라 실행으로 나간다. 실패는 로그로만 남긴다.
            // 문서 자동화 하나가 백엔드 전체를 세울 이유는 없다.
            let baseline = supervisor.clone();
            thread::Builder::new()
                .name("document-baseline".to_owned())
                .spawn(move || {
                    if let Err(error) = baseline.initialize_baseline() {
                        eprintln!("[document-automation] 문서 루트 기준선 스캔 실패: {error}");
                    }
                    spawn_poll_loop(Arc::downgrade(&baseline.inner));
                })?;
        } else {
            supervisor.initialize_baseline()?;
        }
        Ok(supervisor)
    }

    #[cfg(test)]
    pub(crate) fn new_without_background_runner(
        app_data_dir: PathBuf,
        executor: Arc<dyn DocumentActionExecutor>,
    ) -> Result<Self, CoreError> {
        Self::new_with_background_runner(app_data_dir, executor, false)
    }

    pub fn snapshot(&self) -> Result<DocumentAutomationSnapshot, CoreError> {
        let mut triggers = self.load_triggers()?;
        triggers.sort_by_key(|trigger| (trigger.created_at, trigger.id.clone()));
        Ok(DocumentAutomationSnapshot {
            triggers,
            runs: load_runs(&self.inner.app_data_dir, 100)?,
            offline_report: load_latest_offline_report(&self.inner.app_data_dir, true)?,
            options: self.inner.executor.options()?,
        })
    }

    pub fn create_trigger(
        &self,
        input: DocumentTriggerInput,
    ) -> Result<DocumentTrigger, CoreError> {
        let input = self.validate_input(input)?;
        self.inner.executor.validate_action(&input.action)?;
        let now = now_ms();
        let trigger = DocumentTrigger {
            id: format!("doc-trigger-{}", Uuid::new_v4().simple()),
            status: if input.enabled {
                DocumentTriggerStatus::Active
            } else {
                DocumentTriggerStatus::Paused
            },
            status_reason: (!input.enabled).then(|| "사용자가 비활성화했습니다".to_owned()),
            input,
            created_at: now,
            updated_at: now,
        };
        self.with_trigger_store(|store| {
            store.triggers.push(trigger.clone());
            Ok(trigger)
        })
    }

    pub fn update_trigger(
        &self,
        id: &str,
        input: DocumentTriggerInput,
    ) -> Result<DocumentTrigger, CoreError> {
        let input = self.validate_input(input)?;
        self.inner.executor.validate_action(&input.action)?;
        self.with_trigger_store(|store| {
            let trigger = store
                .triggers
                .iter_mut()
                .find(|trigger| trigger.id == id)
                .ok_or_else(document_trigger_not_found)?;
            trigger.input = input;
            trigger.status = if trigger.input.enabled {
                DocumentTriggerStatus::Active
            } else {
                DocumentTriggerStatus::Paused
            };
            trigger.status_reason =
                (!trigger.input.enabled).then(|| "사용자가 비활성화했습니다".to_owned());
            trigger.updated_at = now_ms();
            Ok(trigger.clone())
        })
    }

    pub fn delete_trigger(&self, id: &str) -> Result<(), CoreError> {
        self.with_trigger_store(|store| {
            let before = store.triggers.len();
            store.triggers.retain(|trigger| trigger.id != id);
            if before == store.triggers.len() {
                return Err(document_trigger_not_found());
            }
            Ok(())
        })?;
        let mut runtime = lock_runtime(&self.inner)?;
        runtime.pending_actions.remove(id);
        runtime.inflight_actions.remove(id);
        save_pending_state(&self.inner.app_data_dir, &runtime)?;
        Ok(())
    }

    pub fn set_trigger_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<DocumentTrigger, CoreError> {
        if enabled {
            // 승인 지문이 어긋나 멈춘 트리거를 스위치만 다시 켜서 Active로 되돌릴 수
            // 없게 한다. 재승인 경로는 트리거를 다시 저장하는 것뿐이다.
            let current = self
                .load_triggers()?
                .into_iter()
                .find(|trigger| trigger.id == id)
                .ok_or_else(document_trigger_not_found)?;
            self.inner.executor.validate_action(&current.input.action)?;
        }
        let trigger = self.with_trigger_store(|store| {
            let trigger = store
                .triggers
                .iter_mut()
                .find(|trigger| trigger.id == id)
                .ok_or_else(document_trigger_not_found)?;
            trigger.input.enabled = enabled;
            trigger.status = if enabled {
                DocumentTriggerStatus::Active
            } else {
                DocumentTriggerStatus::Paused
            };
            trigger.status_reason = (!enabled).then(|| "사용자가 비활성화했습니다".to_owned());
            trigger.updated_at = now_ms();
            Ok(trigger.clone())
        })?;
        if !enabled {
            let mut runtime = lock_runtime(&self.inner)?;
            runtime.pending_actions.remove(id);
            save_pending_state(&self.inner.app_data_dir, &runtime)?;
        }
        Ok(trigger)
    }

    pub fn test_trigger(&self, id: &str) -> Result<DocumentTriggerRun, CoreError> {
        let trigger = self
            .load_triggers()?
            .into_iter()
            .find(|trigger| trigger.id == id)
            .ok_or_else(document_trigger_not_found)?;
        let root = self.eligible_root(&trigger.input.root_id)?;
        self.inner.executor.validate_action(&trigger.input.action)?;
        let batch = DocumentChangeBatch {
            event_id: format!("doc-event-test-{}", Uuid::new_v4().simple()),
            root_id: trigger.input.root_id.clone(),
            root_path: root,
            detected_at: now_ms(),
            changes: Vec::new(),
            total_count: 0,
            omitted_count: 0,
            test: true,
        };
        execute_trigger(&self.inner, &trigger, batch)
    }

    pub fn acknowledge_offline_report(
        &self,
        report_id: &str,
    ) -> Result<DocumentOfflineChangeReport, CoreError> {
        let connection = open_database(&self.inner.app_data_dir)?;
        let changed = connection.execute(
            "UPDATE offline_reports SET acknowledged = 1 WHERE id = ?1",
            params![report_id],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(
                "중단 중 문서 변경 보고를 찾을 수 없습니다".to_owned(),
            ));
        }
        load_offline_report(&connection, report_id)?.ok_or_else(|| {
            CoreError::NotFound("중단 중 문서 변경 보고를 찾을 수 없습니다".to_owned())
        })
    }

    fn validate_input(
        &self,
        mut input: DocumentTriggerInput,
    ) -> Result<DocumentTriggerInput, CoreError> {
        input.name = input.name.trim().chars().take(120).collect();
        if input.name.is_empty() {
            return Err(CoreError::InvalidInput(
                "문서 트리거 이름을 입력하세요".to_owned(),
            ));
        }
        self.eligible_root(&input.root_id)?;
        validate_patterns(&input.include, "include")?;
        validate_patterns(&input.exclude, "exclude")?;
        if !(MIN_DEBOUNCE_MS..=MAX_DEBOUNCE_MS).contains(&input.debounce_ms) {
            return Err(CoreError::InvalidInput(format!(
                "debounceMs는 {MIN_DEBOUNCE_MS}~{MAX_DEBOUNCE_MS} 사이여야 합니다"
            )));
        }
        if !(0..=MAX_COOLDOWN_MS).contains(&input.cooldown_ms) {
            return Err(CoreError::InvalidInput(format!(
                "cooldownMs는 0~{MAX_COOLDOWN_MS} 사이여야 합니다"
            )));
        }
        if input.change_kinds.is_empty() {
            input.change_kinds = DocumentChangeKind::ALL.to_vec();
        }
        input.change_kinds.sort();
        input.change_kinds.dedup();
        validate_action_shape(&input.action)?;
        Ok(input)
    }

    fn eligible_root(&self, root_id: &str) -> Result<String, CoreError> {
        let root = list_doc_roots(&self.inner.app_data_dir)?
            .into_iter()
            .find(|root| root.root.id == root_id)
            .ok_or_else(|| CoreError::NotFound("문서 폴더를 찾을 수 없습니다".to_owned()))?;
        if root.restricted {
            return Err(CoreError::Conflict(
                "제한된 문서 폴더에는 트리거를 등록할 수 없습니다".to_owned(),
            ));
        }
        if !root.exists {
            return Err(CoreError::Conflict(
                "문서 폴더 경로가 존재하지 않습니다".to_owned(),
            ));
        }
        Ok(root.root.path)
    }

    fn load_triggers(&self) -> Result<Vec<DocumentTrigger>, CoreError> {
        let _lock = self.lock_trigger_store()?;
        Ok(self.load_trigger_store_unlocked()?.triggers)
    }

    fn lock_trigger_store(&self) -> Result<StoreLock, CoreError> {
        store_lock::acquire(
            &self.inner.app_data_dir,
            TRIGGER_LOCK_FILE_NAME,
            "문서 트리거 저장소",
        )
    }

    /// 잠금을 쥔 채로만 부른다. 저장소가 없으면 빈 저장소로 시작하고, 모르는 스키마
    /// 버전은 손대지 않고 충돌로 돌려보낸다.
    fn load_trigger_store_unlocked(&self) -> Result<TriggerStore, CoreError> {
        let store_path = self.inner.app_data_dir.join(TRIGGER_STORE_FILE_NAME);
        let store = if store_path.is_file() {
            serde_json::from_slice::<TriggerStore>(&fs::read(&store_path)?)?
        } else {
            TriggerStore {
                schema_version: TRIGGER_STORE_SCHEMA_VERSION,
                triggers: Vec::new(),
            }
        };
        ensure_schema_version(
            store.schema_version,
            TRIGGER_STORE_SCHEMA_VERSION,
            "문서 트리거 저장소",
        )?;
        Ok(store)
    }

    fn with_trigger_store<T>(
        &self,
        action: impl FnOnce(&mut TriggerStore) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let _lock = self.lock_trigger_store()?;
        let mut store = self.load_trigger_store_unlocked()?;
        let result = action(&mut store);
        if result.is_ok() {
            write_private_json(
                &self.inner.app_data_dir.join(TRIGGER_STORE_FILE_NAME),
                &store,
            )?;
        }
        result
    }

    fn initialize_baseline(&self) -> Result<(), CoreError> {
        let roots = list_doc_roots(&self.inner.app_data_dir)?;
        let registered = roots
            .iter()
            .filter(|root| !root.restricted)
            .map(|root| root.root.id.clone())
            .collect::<HashSet<_>>();
        purge_unregistered_roots(&self.inner.app_data_dir, &registered)?;
        let mut offline_batches = Vec::new();
        for root in roots {
            if root.restricted || !root.exists {
                continue;
            }
            let snapshot = scan_root(Path::new(&root.root.path))?;
            let previous = load_root_snapshot(&self.inner.app_data_dir, &root.root.id)?;
            if root_has_baseline(&self.inner.app_data_dir, &root.root.id)? {
                let changes = compare_snapshots(&previous, &snapshot);
                if !changes.is_empty() {
                    offline_batches.push(change_batch(
                        &root.root.id,
                        &root.root.path,
                        changes,
                        now_ms(),
                        false,
                    ));
                }
            }
            replace_root_snapshot(
                &self.inner.app_data_dir,
                &root.root.id,
                &root.root.path,
                &snapshot,
            )?;
        }
        if !offline_batches.is_empty() {
            save_offline_report(&self.inner.app_data_dir, offline_batches)?;
        }
        self.refresh_trigger_root_statuses()?;
        Ok(())
    }

    fn refresh_trigger_root_statuses(&self) -> Result<(), CoreError> {
        let roots = list_doc_roots(&self.inner.app_data_dir)?
            .into_iter()
            .map(|root| (root.root.id.clone(), root))
            .collect::<HashMap<_, _>>();
        if !self.load_triggers()?.iter().any(|trigger| {
            desired_root_status(trigger, &roots).is_some_and(|(status, reason)| {
                trigger.status != status || trigger.status_reason != reason
            })
        }) {
            return Ok(());
        }
        self.with_trigger_store(|store| {
            let now = now_ms();
            for trigger in &mut store.triggers {
                let next = desired_root_status(trigger, &roots);
                if let Some((status, reason)) = next {
                    trigger.status = status;
                    trigger.status_reason = reason;
                    trigger.updated_at = now;
                }
            }
            Ok(())
        })
    }

    fn poll_once(&self, now: i64) -> Result<(), CoreError> {
        self.refresh_trigger_root_statuses()?;
        let roots = list_doc_roots(&self.inner.app_data_dir)?;
        for root in roots {
            if root.restricted || !root.exists {
                continue;
            }
            let current = scan_root(Path::new(&root.root.path))?;
            if !root_has_baseline(&self.inner.app_data_dir, &root.root.id)? {
                replace_root_snapshot(
                    &self.inner.app_data_dir,
                    &root.root.id,
                    &root.root.path,
                    &current,
                )?;
                continue;
            }
            let previous = load_root_snapshot(&self.inner.app_data_dir, &root.root.id)?;
            let changes = compare_snapshots(&previous, &current);
            if !changes.is_empty() {
                let mut runtime = lock_runtime(&self.inner)?;
                let pending = runtime
                    .pending_roots
                    .entry(root.root.id.clone())
                    .or_insert_with(|| PendingRootBatch {
                        root_path: root.root.path.clone(),
                        ..PendingRootBatch::default()
                    });
                pending.root_path = root.root.path.clone();
                pending.last_change_at = now;
                for change in changes {
                    merge_change(&mut pending.changes, change);
                }
                // baseline을 앞서 갱신하면 이 다음 저장 전 종료 시 이벤트가 사라진다.
                // 대기 배치를 먼저 원자 저장한 뒤 baseline을 전진시킨다.
                save_pending_state(&self.inner.app_data_dir, &runtime)?;
                drop(runtime);
                replace_root_snapshot(
                    &self.inner.app_data_dir,
                    &root.root.id,
                    &root.root.path,
                    &current,
                )?;
            }
        }
        self.dispatch_mature_batches(now)?;
        Ok(())
    }

    #[cfg(test)]
    fn poll_once_for_test(&self, now: i64) -> Result<(), CoreError> {
        self.poll_once(now)
    }

    fn dispatch_mature_batches(&self, now: i64) -> Result<(), CoreError> {
        let triggers = self.load_triggers()?;
        let mut debounce_by_root = HashMap::<String, i64>::new();
        for trigger in &triggers {
            debounce_by_root
                .entry(trigger.input.root_id.clone())
                .and_modify(|value| *value = (*value).max(trigger.input.debounce_ms))
                .or_insert(trigger.input.debounce_ms);
        }
        {
            let mut runtime = lock_runtime(&self.inner)?;
            let ids = runtime
                .pending_roots
                .iter()
                .filter(|(root_id, pending)| {
                    let debounce = debounce_by_root
                        .get(*root_id)
                        .copied()
                        .unwrap_or(DEFAULT_DEBOUNCE_MS);
                    now.saturating_sub(pending.last_change_at) >= debounce
                })
                .map(|(root_id, _)| root_id.clone())
                .collect::<Vec<_>>();
            for root_id in ids {
                let Some(pending) = runtime.pending_roots.remove(&root_id) else {
                    continue;
                };
                let all_changes = pending.changes.into_values().collect::<Vec<_>>();
                for trigger in triggers.iter().filter(|trigger| {
                    trigger.input.root_id == root_id
                        && trigger.input.enabled
                        && trigger.status == DocumentTriggerStatus::Active
                        && now.saturating_sub(pending.last_change_at) >= trigger.input.debounce_ms
                }) {
                    let filtered = all_changes
                        .iter()
                        .filter(|change| trigger_matches(trigger, change))
                        .cloned()
                        .collect::<Vec<_>>();
                    if filtered.is_empty() {
                        continue;
                    }
                    let batch = change_batch(&root_id, &pending.root_path, filtered, now, false);
                    merge_action_batch(&mut runtime.pending_actions, &trigger.id, batch);
                }
            }
            save_pending_state(&self.inner.app_data_dir, &runtime)?;
        }
        self.dispatch_pending_actions(now)
    }

    fn dispatch_pending_actions(&self, now: i64) -> Result<(), CoreError> {
        let triggers = self
            .load_triggers()?
            .into_iter()
            .map(|trigger| (trigger.id.clone(), trigger))
            .collect::<HashMap<_, _>>();
        let ready = {
            let runtime = lock_runtime(&self.inner)?;
            runtime
                .pending_actions
                .keys()
                .filter(|id| !runtime.running.contains(*id))
                .filter_map(|id| {
                    let trigger = triggers.get(id)?;
                    let last = latest_run_started_at(&self.inner.app_data_dir, id).ok()?;
                    (last.is_none_or(|started| {
                        now.saturating_sub(started) >= trigger.input.cooldown_ms
                    }))
                    .then(|| id.clone())
                })
                .collect::<Vec<_>>()
        };
        for id in ready {
            let Some(trigger) = triggers.get(&id).cloned() else {
                let mut runtime = lock_runtime(&self.inner)?;
                runtime.pending_actions.remove(&id);
                save_pending_state(&self.inner.app_data_dir, &runtime)?;
                continue;
            };
            if !trigger.input.enabled || trigger.status == DocumentTriggerStatus::Paused {
                let mut runtime = lock_runtime(&self.inner)?;
                runtime.pending_actions.remove(&id);
                save_pending_state(&self.inner.app_data_dir, &runtime)?;
                continue;
            }
            if trigger.status != DocumentTriggerStatus::Active {
                // 워크플로·스킬이 바뀐 경우 이벤트를 버리지 않고 재승인 뒤 이어서 실행한다.
                continue;
            }
            if recent_run_count(
                &self.inner.app_data_dir,
                &id,
                now.saturating_sub(CIRCUIT_WINDOW_MS),
            )? >= CIRCUIT_MAX_RUNS
            {
                {
                    let mut runtime = lock_runtime(&self.inner)?;
                    runtime.pending_actions.remove(&id);
                    save_pending_state(&self.inner.app_data_dir, &runtime)?;
                }
                self.pause_for_circuit_breaker(&id)?;
                continue;
            }
            let batch = {
                let mut runtime = lock_runtime(&self.inner)?;
                let Some(batch) = runtime.pending_actions.remove(&id) else {
                    continue;
                };
                runtime.running.insert(id.clone());
                runtime.inflight_actions.insert(id.clone(), batch.clone());
                save_pending_state(&self.inner.app_data_dir, &runtime)?;
                batch
            };
            launch_trigger(Arc::clone(&self.inner), trigger, batch);
        }
        Ok(())
    }

    fn pause_for_circuit_breaker(&self, trigger_id: &str) -> Result<(), CoreError> {
        self.with_trigger_store(|store| {
            let trigger = store
                .triggers
                .iter_mut()
                .find(|trigger| trigger.id == trigger_id)
                .ok_or_else(document_trigger_not_found)?;
            trigger.input.enabled = false;
            trigger.status = DocumentTriggerStatus::Paused;
            trigger.status_reason = Some(
                "10분 동안 5회 실행되어 재귀 변경 가능성 때문에 자동 일시정지했습니다".to_owned(),
            );
            trigger.updated_at = now_ms();
            Ok(())
        })
    }
}

fn default_true() -> bool {
    true
}

fn default_debounce_ms() -> i64 {
    DEFAULT_DEBOUNCE_MS
}

fn default_cooldown_ms() -> i64 {
    DEFAULT_COOLDOWN_MS
}

fn desired_root_status(
    trigger: &DocumentTrigger,
    roots: &HashMap<String, crate::DocRootStatus>,
) -> Option<(DocumentTriggerStatus, Option<String>)> {
    match roots.get(&trigger.input.root_id) {
        Some(root) if root.restricted => Some((
            DocumentTriggerStatus::Restricted,
            Some("보호 경로와 겹쳐 감시할 수 없습니다".to_owned()),
        )),
        Some(root) if !root.exists => Some((
            DocumentTriggerStatus::Degraded,
            Some("문서 폴더 경로가 존재하지 않습니다".to_owned()),
        )),
        None => Some((
            DocumentTriggerStatus::Degraded,
            Some("등록된 문서 폴더가 제거되었습니다".to_owned()),
        )),
        Some(_) if !trigger.input.enabled => Some((
            DocumentTriggerStatus::Paused,
            Some("사용자가 비활성화했습니다".to_owned()),
        )),
        Some(_)
            if matches!(
                trigger.status,
                DocumentTriggerStatus::Restricted | DocumentTriggerStatus::Degraded
            ) =>
        {
            Some((DocumentTriggerStatus::Active, None))
        }
        _ => None,
    }
}

fn validate_patterns(patterns: &[String], label: &str) -> Result<(), CoreError> {
    if patterns.len() > MAX_PATTERNS {
        return Err(CoreError::InvalidInput(format!(
            "{label} 패턴은 {MAX_PATTERNS}개 이하이어야 합니다"
        )));
    }
    for pattern in patterns {
        if pattern.is_empty()
            || pattern.len() > MAX_PATTERN_LEN
            || pattern.starts_with('/')
            || pattern.contains('\0')
            || pattern.split('/').any(|part| part == "..")
        {
            return Err(CoreError::InvalidInput(format!(
                "{label} 경로 패턴이 올바르지 않습니다: {pattern}"
            )));
        }
    }
    Ok(())
}

fn validate_action_shape(action: &DocumentTriggerAction) -> Result<(), CoreError> {
    match action {
        DocumentTriggerAction::RunSchedule { schedule_id } if schedule_id.trim().is_empty() => Err(
            CoreError::InvalidInput("scheduleId가 필요합니다".to_owned()),
        ),
        DocumentTriggerAction::StartChat(chat) if chat.prompt.trim().is_empty() => Err(
            CoreError::InvalidInput("채팅 트리거 프롬프트가 필요합니다".to_owned()),
        ),
        DocumentTriggerAction::StartChat(chat)
            if chat.skill.as_ref().is_some_and(|skill| {
                skill.skill_id.trim().is_empty() || skill.content_digest.trim().is_empty()
            }) =>
        {
            Err(CoreError::InvalidInput(
                "선택한 스킬의 id와 contentDigest가 필요합니다".to_owned(),
            ))
        }
        DocumentTriggerAction::ExecuteWorkflow(workflow)
            if workflow.workflow_id.trim().is_empty() || workflow.approved_version == 0 =>
        {
            Err(CoreError::InvalidInput(
                "workflowId와 승인한 version이 필요합니다".to_owned(),
            ))
        }
        _ => Ok(()),
    }
}

fn is_visible_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !entry.file_name().to_string_lossy().starts_with('.') && !entry.file_type().is_symlink()
}

fn scan_root(root: &Path) -> Result<BTreeMap<String, FileState>, CoreError> {
    ensure_not_symlink(
        &fs::symlink_metadata(root)?,
        "심볼릭 링크 문서 루트는 감시할 수 없습니다",
    )?;
    let canonical = fs::canonicalize(root)?;
    if !canonical.is_dir() {
        return Err(CoreError::InvalidInput(
            "문서 루트가 폴더가 아닙니다".to_owned(),
        ));
    }
    let mut snapshot = BTreeMap::new();
    for entry in WalkDir::new(&canonical)
        .follow_links(false)
        .into_iter()
        .filter_entry(is_visible_entry)
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                if error.io_error().is_some_and(|io| {
                    matches!(
                        io.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                    )
                }) {
                    continue;
                }
                return Err(CoreError::Runtime(format!(
                    "문서 폴더를 스캔하지 못했습니다: {error}"
                )));
            }
        };
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let relative_path = entry
            .path()
            .strip_prefix(&canonical)
            .map_err(|_| CoreError::InvalidInput("허용된 경로를 벗어났습니다".to_owned()))?
            .to_string_lossy()
            .replace('\\', "/");
        snapshot.insert(
            relative_path,
            FileState {
                size_bytes: metadata.len(),
                modified_ns: modified_ns(&metadata),
            },
        );
    }
    Ok(snapshot)
}

fn modified_ns(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_nanos()).ok())
        .unwrap_or_default()
}

fn compare_snapshots(
    previous: &BTreeMap<String, FileState>,
    current: &BTreeMap<String, FileState>,
) -> Vec<DocumentChange> {
    let paths = previous
        .keys()
        .chain(current.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    paths
        .into_iter()
        .filter_map(|relative_path| {
            match (previous.get(&relative_path), current.get(&relative_path)) {
                (None, Some(state)) => Some(DocumentChange {
                    kind: DocumentChangeKind::Created,
                    relative_path,
                    size_bytes: Some(state.size_bytes),
                }),
                (Some(_), None) => Some(DocumentChange {
                    kind: DocumentChangeKind::Deleted,
                    relative_path,
                    size_bytes: None,
                }),
                (Some(before), Some(after)) if before != after => Some(DocumentChange {
                    kind: DocumentChangeKind::Modified,
                    relative_path,
                    size_bytes: Some(after.size_bytes),
                }),
                _ => None,
            }
        })
        .collect()
}

fn merge_change(changes: &mut BTreeMap<String, DocumentChange>, next: DocumentChange) {
    let path = next.relative_path.clone();
    let merged = match (changes.get(&path).map(|change| change.kind), next.kind) {
        (Some(DocumentChangeKind::Created), DocumentChangeKind::Deleted) => None,
        (Some(DocumentChangeKind::Created), _) => Some(DocumentChange {
            kind: DocumentChangeKind::Created,
            ..next
        }),
        (Some(DocumentChangeKind::Deleted), DocumentChangeKind::Created) => Some(DocumentChange {
            kind: DocumentChangeKind::Modified,
            ..next
        }),
        (_, _) => Some(next),
    };
    if let Some(merged) = merged {
        changes.insert(path, merged);
    } else {
        changes.remove(&path);
    }
}

fn merge_action_batch(
    pending: &mut HashMap<String, DocumentChangeBatch>,
    trigger_id: &str,
    incoming: DocumentChangeBatch,
) {
    let Some(existing) = pending.get_mut(trigger_id) else {
        pending.insert(trigger_id.to_owned(), incoming);
        return;
    };
    let mut changes = existing
        .changes
        .drain(..)
        .map(|change| (change.relative_path.clone(), change))
        .collect::<BTreeMap<_, _>>();
    for change in incoming.changes {
        merge_change(&mut changes, change);
    }
    existing.detected_at = incoming.detected_at;
    existing.event_id = incoming.event_id;
    existing.total_count = changes.len();
    existing.changes = changes.into_values().take(MAX_EVENT_PATHS).collect();
    existing.omitted_count = existing.total_count.saturating_sub(existing.changes.len());
}

fn trigger_matches(trigger: &DocumentTrigger, change: &DocumentChange) -> bool {
    trigger.input.change_kinds.contains(&change.kind)
        && (trigger.input.include.is_empty()
            || trigger
                .input
                .include
                .iter()
                .any(|pattern| wildcard_match(pattern, &change.relative_path)))
        && !trigger
            .input
            .exclude
            .iter()
            .any(|pattern| wildcard_match(pattern, &change.relative_path))
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    fn matches(
        pattern: &[u8],
        value: &[u8],
        pattern_index: usize,
        value_index: usize,
        memo: &mut HashMap<(usize, usize), bool>,
    ) -> bool {
        if let Some(result) = memo.get(&(pattern_index, value_index)) {
            return *result;
        }
        let result = if pattern_index == pattern.len() {
            value_index == value.len()
        } else if pattern[pattern_index] == b'*' {
            let double = pattern.get(pattern_index + 1) == Some(&b'*');
            let next_pattern = pattern_index + if double { 2 } else { 1 };
            (double
                && pattern.get(next_pattern) == Some(&b'/')
                && matches(pattern, value, next_pattern + 1, value_index, memo))
                || matches(pattern, value, next_pattern, value_index, memo)
                || (value_index < value.len()
                    && (double || value[value_index] != b'/')
                    && matches(pattern, value, pattern_index, value_index + 1, memo))
        } else if value_index < value.len()
            && (pattern[pattern_index] == value[value_index]
                || (pattern[pattern_index] == b'?' && value[value_index] != b'/'))
        {
            matches(pattern, value, pattern_index + 1, value_index + 1, memo)
        } else {
            false
        };
        memo.insert((pattern_index, value_index), result);
        result
    }
    matches(
        pattern.as_bytes(),
        value.as_bytes(),
        0,
        0,
        &mut HashMap::new(),
    )
}

fn change_batch(
    root_id: &str,
    root_path: &str,
    changes: Vec<DocumentChange>,
    detected_at: i64,
    test: bool,
) -> DocumentChangeBatch {
    let total_count = changes.len();
    let changes = changes
        .into_iter()
        .take(MAX_EVENT_PATHS)
        .collect::<Vec<_>>();
    DocumentChangeBatch {
        event_id: format!("doc-event-{}", Uuid::new_v4().simple()),
        root_id: root_id.to_owned(),
        root_path: root_path.to_owned(),
        detected_at,
        omitted_count: total_count.saturating_sub(changes.len()),
        total_count,
        changes,
        test,
    }
}

fn spawn_poll_loop(inner: Weak<DocumentAutomationInner>) {
    thread::spawn(move || loop {
        let Some(inner) = inner.upgrade() else {
            break;
        };
        let supervisor = DocumentAutomationSupervisor { inner };
        if let Err(error) = supervisor.poll_once(now_ms()) {
            eprintln!("[document-automation] 문서 변경 감지 실패: {error}");
        }
        drop(supervisor);
        thread::sleep(POLL_INTERVAL);
    });
}

fn launch_trigger(
    inner: Arc<DocumentAutomationInner>,
    trigger: DocumentTrigger,
    batch: DocumentChangeBatch,
) {
    thread::spawn(move || {
        let _ = execute_trigger(&inner, &trigger, batch.clone());
        if let Ok(mut runtime) = inner.runtime.lock() {
            runtime.running.remove(&trigger.id);
            runtime.inflight_actions.remove(&trigger.id);
            let retain_for_review = load_trigger_status(&inner, &trigger.id).is_ok_and(|status| {
                matches!(
                    status,
                    DocumentTriggerStatus::NeedsReview
                        | DocumentTriggerStatus::Degraded
                        | DocumentTriggerStatus::Restricted
                )
            });
            if retain_for_review {
                merge_action_batch(&mut runtime.pending_actions, &trigger.id, batch);
            }
            if let Err(error) = save_pending_state(&inner.app_data_dir, &runtime) {
                eprintln!("[document-automation] 문서 트리거 대기열 저장 실패: {error}");
            }
        }
    });
}

fn execute_trigger(
    inner: &Arc<DocumentAutomationInner>,
    trigger: &DocumentTrigger,
    batch: DocumentChangeBatch,
) -> Result<DocumentTriggerRun, CoreError> {
    let started_at = now_ms();
    let idempotency_key = format!("document-trigger:{}:{}", trigger.id, batch.event_id);
    let mut run = DocumentTriggerRun {
        id: format!("doc-run-{}", Uuid::new_v4().simple()),
        trigger_id: trigger.id.clone(),
        event_id: batch.event_id.clone(),
        action: trigger.input.action.kind_name().to_owned(),
        status: DocumentTriggerRunStatus::Running,
        started_at,
        finished_at: None,
        result_id: None,
        result: None,
        error: None,
        test: batch.test,
    };
    save_run(&inner.app_data_dir, &run)?;
    let context = DocumentActionContext {
        trigger_id: trigger.id.clone(),
        trigger_name: trigger.input.name.clone(),
        idempotency_key,
        batch,
    };
    match inner
        .executor
        .execute_action(&trigger.input.action, &context)
    {
        Ok(receipt) => {
            run.status = DocumentTriggerRunStatus::Completed;
            run.result_id = receipt.result_id;
            run.result = receipt.result;
        }
        Err(error) => {
            run.status = DocumentTriggerRunStatus::Failed;
            run.error = Some(error.message.clone());
            if matches!(
                error.kind,
                DocumentActionErrorKind::NeedsReview | DocumentActionErrorKind::Degraded
            ) {
                update_trigger_failure_status(
                    inner,
                    &trigger.id,
                    if error.kind == DocumentActionErrorKind::NeedsReview {
                        DocumentTriggerStatus::NeedsReview
                    } else {
                        DocumentTriggerStatus::Degraded
                    },
                    error.message,
                )?;
            }
        }
    }
    run.finished_at = Some(now_ms());
    save_run(&inner.app_data_dir, &run)?;
    Ok(run)
}

fn update_trigger_failure_status(
    inner: &Arc<DocumentAutomationInner>,
    trigger_id: &str,
    status: DocumentTriggerStatus,
    reason: String,
) -> Result<(), CoreError> {
    let supervisor = DocumentAutomationSupervisor {
        inner: Arc::clone(inner),
    };
    supervisor.with_trigger_store(|store| {
        if let Some(trigger) = store
            .triggers
            .iter_mut()
            .find(|trigger| trigger.id == trigger_id)
        {
            trigger.status = status;
            trigger.status_reason = Some(reason);
            trigger.updated_at = now_ms();
        }
        Ok(())
    })
}

fn lock_runtime(
    inner: &Arc<DocumentAutomationInner>,
) -> Result<std::sync::MutexGuard<'_, RuntimeState>, CoreError> {
    inner
        .runtime
        .lock()
        .map_err(|_| CoreError::Runtime("문서 자동화 실행 상태 잠금이 손상되었습니다".to_owned()))
}

fn document_trigger_not_found() -> CoreError {
    CoreError::NotFound("문서 트리거를 찾을 수 없습니다".to_owned())
}

fn load_trigger_status(
    inner: &Arc<DocumentAutomationInner>,
    trigger_id: &str,
) -> Result<DocumentTriggerStatus, CoreError> {
    DocumentAutomationSupervisor {
        inner: Arc::clone(inner),
    }
    .load_triggers()?
    .into_iter()
    .find(|trigger| trigger.id == trigger_id)
    .map(|trigger| trigger.status)
    .ok_or_else(document_trigger_not_found)
}

fn load_pending_store(app_data_dir: &Path) -> Result<DurablePendingStore, CoreError> {
    let path = app_data_dir.join(PENDING_STORE_FILE_NAME);
    if !path.is_file() {
        return Ok(DurablePendingStore {
            schema_version: PENDING_STORE_SCHEMA_VERSION,
            ..DurablePendingStore::default()
        });
    }
    let store = serde_json::from_slice::<DurablePendingStore>(&fs::read(path)?)?;
    ensure_schema_version(
        store.schema_version,
        PENDING_STORE_SCHEMA_VERSION,
        "문서 트리거 대기열",
    )?;
    Ok(store)
}

fn save_pending_state(app_data_dir: &Path, runtime: &RuntimeState) -> Result<(), CoreError> {
    write_private_json(
        &app_data_dir.join(PENDING_STORE_FILE_NAME),
        &DurablePendingStore {
            schema_version: PENDING_STORE_SCHEMA_VERSION,
            pending_roots: runtime.pending_roots.clone(),
            pending_actions: runtime.pending_actions.clone(),
            inflight_actions: runtime.inflight_actions.clone(),
        },
    )
}

fn initialize_database(app_data_dir: &Path) -> Result<(), CoreError> {
    let connection = open_database(app_data_dir)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS root_baselines (
             root_id TEXT PRIMARY KEY,
             root_path TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS document_entries (
             root_id TEXT NOT NULL,
             relative_path TEXT NOT NULL,
             size_bytes INTEGER NOT NULL,
             modified_ns INTEGER NOT NULL,
             PRIMARY KEY (root_id, relative_path)
         );
         CREATE TABLE IF NOT EXISTS offline_reports (
             id TEXT PRIMARY KEY,
             created_at INTEGER NOT NULL,
             root_count INTEGER NOT NULL,
             changes_json TEXT NOT NULL,
             total_count INTEGER NOT NULL,
             omitted_count INTEGER NOT NULL,
             acknowledged INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS trigger_runs (
             id TEXT PRIMARY KEY,
             trigger_id TEXT NOT NULL,
             event_id TEXT NOT NULL,
             action TEXT NOT NULL,
             status TEXT NOT NULL,
             started_at INTEGER NOT NULL,
             finished_at INTEGER,
             result_id TEXT,
             result_json TEXT,
             error TEXT,
             is_test INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS trigger_runs_trigger_started
             ON trigger_runs(trigger_id, started_at DESC);",
    )?;
    Ok(())
}

fn open_database(app_data_dir: &Path) -> Result<Connection, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(INDEX_FILE_NAME);
    let connection = Connection::open(&path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path)?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&path, permissions)?;
    }
    Ok(connection)
}

fn root_has_baseline(app_data_dir: &Path, root_id: &str) -> Result<bool, CoreError> {
    let connection = open_database(app_data_dir)?;
    Ok(connection
        .query_row(
            "SELECT 1 FROM root_baselines WHERE root_id = ?1",
            params![root_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn load_root_snapshot(
    app_data_dir: &Path,
    root_id: &str,
) -> Result<BTreeMap<String, FileState>, CoreError> {
    let connection = open_database(app_data_dir)?;
    let mut statement = connection.prepare(
        "SELECT relative_path, size_bytes, modified_ns
         FROM document_entries WHERE root_id = ?1 ORDER BY relative_path",
    )?;
    let rows = statement.query_map(params![root_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            FileState {
                size_bytes: row.get(1)?,
                modified_ns: row.get(2)?,
            },
        ))
    })?;
    let mut snapshot = BTreeMap::new();
    for row in rows {
        let (path, state) = row?;
        snapshot.insert(path, state);
    }
    Ok(snapshot)
}

fn replace_root_snapshot(
    app_data_dir: &Path,
    root_id: &str,
    root_path: &str,
    snapshot: &BTreeMap<String, FileState>,
) -> Result<(), CoreError> {
    let mut connection = open_database(app_data_dir)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM document_entries WHERE root_id = ?1",
        params![root_id],
    )?;
    {
        let mut statement = transaction.prepare(
            "INSERT INTO document_entries(root_id, relative_path, size_bytes, modified_ns)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (path, state) in snapshot {
            statement.execute(params![root_id, path, state.size_bytes, state.modified_ns])?;
        }
    }
    transaction.execute(
        "INSERT INTO root_baselines(root_id, root_path, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(root_id) DO UPDATE SET root_path = excluded.root_path,
             updated_at = excluded.updated_at",
        params![root_id, root_path, now_ms()],
    )?;
    transaction.commit()?;
    Ok(())
}

fn purge_unregistered_roots(
    app_data_dir: &Path,
    registered: &HashSet<String>,
) -> Result<(), CoreError> {
    let mut connection = open_database(app_data_dir)?;
    let known = {
        let mut statement = connection.prepare("SELECT root_id FROM root_baselines")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut known = Vec::new();
        for row in rows {
            known.push(row?);
        }
        known
    };
    let transaction = connection.transaction()?;
    for root_id in known {
        if !registered.contains(&root_id) {
            transaction.execute(
                "DELETE FROM document_entries WHERE root_id = ?1",
                params![root_id],
            )?;
            transaction.execute(
                "DELETE FROM root_baselines WHERE root_id = ?1",
                params![root_id],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn save_offline_report(
    app_data_dir: &Path,
    batches: Vec<DocumentChangeBatch>,
) -> Result<DocumentOfflineChangeReport, CoreError> {
    let total_count = batches.iter().map(|batch| batch.total_count).sum::<usize>();
    let mut remaining = MAX_EVENT_PATHS;
    let mut stored_batches = Vec::new();
    for mut batch in batches {
        let take = remaining.min(batch.changes.len());
        batch.changes.truncate(take);
        batch.omitted_count = batch.total_count.saturating_sub(take);
        remaining = remaining.saturating_sub(take);
        stored_batches.push(batch);
    }
    let stored_count = stored_batches
        .iter()
        .map(|batch| batch.changes.len())
        .sum::<usize>();
    let report = DocumentOfflineChangeReport {
        id: format!("doc-offline-{}", Uuid::new_v4().simple()),
        created_at: now_ms(),
        root_count: stored_batches.len(),
        changes: stored_batches,
        total_count,
        omitted_count: total_count.saturating_sub(stored_count),
        acknowledged: false,
    };
    let connection = open_database(app_data_dir)?;
    connection.execute(
        "UPDATE offline_reports SET acknowledged = 1 WHERE acknowledged = 0",
        [],
    )?;
    connection.execute(
        "INSERT INTO offline_reports(
             id, created_at, root_count, changes_json, total_count, omitted_count, acknowledged
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![
            report.id,
            report.created_at,
            report.root_count,
            serde_json::to_string(&report.changes)?,
            report.total_count,
            report.omitted_count
        ],
    )?;
    Ok(report)
}

fn load_latest_offline_report(
    app_data_dir: &Path,
    unacknowledged_only: bool,
) -> Result<Option<DocumentOfflineChangeReport>, CoreError> {
    let connection = open_database(app_data_dir)?;
    let query = if unacknowledged_only {
        "SELECT id FROM offline_reports WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT 1"
    } else {
        "SELECT id FROM offline_reports ORDER BY created_at DESC LIMIT 1"
    };
    let id = connection
        .query_row(query, [], |row| row.get::<_, String>(0))
        .optional()?;
    id.map(|id| load_offline_report(&connection, &id))
        .transpose()
        .map(Option::flatten)
}

fn load_offline_report(
    connection: &Connection,
    id: &str,
) -> Result<Option<DocumentOfflineChangeReport>, CoreError> {
    connection
        .query_row(
            "SELECT id, created_at, root_count, changes_json, total_count,
                    omitted_count, acknowledged
             FROM offline_reports WHERE id = ?1",
            params![id],
            |row| {
                let changes_json: String = row.get(3)?;
                let changes = serde_json::from_str(&changes_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        changes_json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(DocumentOfflineChangeReport {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    root_count: row.get(2)?,
                    changes,
                    total_count: row.get(4)?,
                    omitted_count: row.get(5)?,
                    acknowledged: row.get::<_, i64>(6)? != 0,
                })
            },
        )
        .optional()
        .map_err(CoreError::from)
}

fn save_run(app_data_dir: &Path, run: &DocumentTriggerRun) -> Result<(), CoreError> {
    let connection = open_database(app_data_dir)?;
    connection.execute(
        "INSERT INTO trigger_runs(
             id, trigger_id, event_id, action, status, started_at, finished_at,
             result_id, result_json, error, is_test
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
             finished_at = excluded.finished_at, result_id = excluded.result_id,
             result_json = excluded.result_json, error = excluded.error",
        params![
            run.id,
            run.trigger_id,
            run.event_id,
            run.action,
            run_status_name(run.status),
            run.started_at,
            run.finished_at,
            run.result_id,
            run.result.as_ref().map(serde_json::to_string).transpose()?,
            run.error,
            i64::from(run.test)
        ],
    )?;
    connection.execute(
        "DELETE FROM trigger_runs WHERE id IN (
             SELECT id FROM trigger_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?1
         )",
        params![MAX_STORED_RUNS as i64],
    )?;
    Ok(())
}

fn load_runs(app_data_dir: &Path, limit: usize) -> Result<Vec<DocumentTriggerRun>, CoreError> {
    let connection = open_database(app_data_dir)?;
    let mut statement = connection.prepare(
        "SELECT id, trigger_id, event_id, action, status, started_at, finished_at,
                result_id, result_json, error, is_test
         FROM trigger_runs ORDER BY started_at DESC LIMIT ?1",
    )?;
    let rows = statement.query_map(params![limit], |row| {
        let status: String = row.get(4)?;
        let result_json: Option<String> = row.get(8)?;
        let result = result_json
            .map(|json| {
                serde_json::from_str(&json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?;
        Ok(DocumentTriggerRun {
            id: row.get(0)?,
            trigger_id: row.get(1)?,
            event_id: row.get(2)?,
            action: row.get(3)?,
            status: parse_run_status(&status),
            started_at: row.get(5)?,
            finished_at: row.get(6)?,
            result_id: row.get(7)?,
            result,
            error: row.get(9)?,
            test: row.get::<_, i64>(10)? != 0,
        })
    })?;
    let mut runs = Vec::new();
    for row in rows {
        runs.push(row?);
    }
    Ok(runs)
}

fn latest_run_started_at(app_data_dir: &Path, trigger_id: &str) -> Result<Option<i64>, CoreError> {
    let connection = open_database(app_data_dir)?;
    connection
        .query_row(
            "SELECT started_at FROM trigger_runs
             WHERE trigger_id = ?1 AND is_test = 0 ORDER BY started_at DESC LIMIT 1",
            params![trigger_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(CoreError::from)
}

fn recent_run_count(app_data_dir: &Path, trigger_id: &str, since: i64) -> Result<usize, CoreError> {
    let connection = open_database(app_data_dir)?;
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM trigger_runs
         WHERE trigger_id = ?1 AND is_test = 0 AND started_at >= ?2",
        params![trigger_id, since],
        |row| row.get(0),
    )?;
    Ok(count.max(0) as usize)
}

fn run_status_name(status: DocumentTriggerRunStatus) -> &'static str {
    status.as_str()
}

fn parse_run_status(status: &str) -> DocumentTriggerRunStatus {
    status.parse().unwrap_or(DocumentTriggerRunStatus::Running)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct RecordingExecutor {
        sender: Mutex<mpsc::Sender<DocumentActionContext>>,
    }

    impl DocumentActionExecutor for RecordingExecutor {
        fn execute_action(
            &self,
            _action: &DocumentTriggerAction,
            context: &DocumentActionContext,
        ) -> Result<DocumentActionReceipt, DocumentActionError> {
            self.sender
                .lock()
                .expect("sender lock")
                .send(context.clone())
                .expect("record execution");
            Ok(DocumentActionReceipt {
                result_id: Some("recorded".to_owned()),
                result: None,
            })
        }
    }

    fn executor() -> (
        Arc<dyn DocumentActionExecutor>,
        mpsc::Receiver<DocumentActionContext>,
    ) {
        let (sender, receiver) = mpsc::channel();
        (
            Arc::new(RecordingExecutor {
                sender: Mutex::new(sender),
            }),
            receiver,
        )
    }

    /// 승인 지문 검증을 대신하는 시험용 실행기. `approved`를 끄면 등록 액션이 승인
    /// 후 바뀐 상태를 나타낸다.
    struct ReviewGateExecutor {
        approved: Mutex<bool>,
    }

    impl DocumentActionExecutor for ReviewGateExecutor {
        fn validate_action(&self, _action: &DocumentTriggerAction) -> Result<(), CoreError> {
            if *self.approved.lock().expect("approved lock") {
                Ok(())
            } else {
                Err(CoreError::Conflict(
                    "선택한 스킬이 승인 후 변경되었습니다".to_owned(),
                ))
            }
        }

        fn execute_action(
            &self,
            _action: &DocumentTriggerAction,
            _context: &DocumentActionContext,
        ) -> Result<DocumentActionReceipt, DocumentActionError> {
            Ok(DocumentActionReceipt {
                result_id: None,
                result: None,
            })
        }
    }

    fn trigger_input(root_id: String) -> DocumentTriggerInput {
        DocumentTriggerInput {
            name: "문서 변경".to_owned(),
            root_id,
            include: vec!["**/*.md".to_owned()],
            exclude: vec!["draft/**".to_owned()],
            change_kinds: Vec::new(),
            enabled: true,
            debounce_ms: DEFAULT_DEBOUNCE_MS,
            cooldown_ms: 0,
            action: DocumentTriggerAction::RunSchedule {
                schedule_id: "schedule-1".to_owned(),
            },
        }
    }

    fn register_root(app_data: &Path, root: &Path) -> String {
        crate::add_doc_root(app_data, "docs", root.to_string_lossy().as_ref(), false)
            .expect("register root")
            .root
            .id
    }

    #[test]
    fn scan_includes_all_normal_files_and_excludes_hidden_and_symlinked_content() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("docs");
        fs::create_dir_all(root.join("nested")).expect("nested");
        fs::create_dir_all(root.join(".hidden")).expect("hidden");
        fs::write(root.join("README.md"), "one").expect("markdown");
        fs::write(root.join("nested/data.bin"), [0_u8, 1, 2]).expect("binary");
        fs::write(root.join(".hidden/secret.txt"), "secret").expect("hidden file");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("nested"), root.join("linked")).expect("symlink");

        let snapshot = scan_root(&root).expect("scan");
        assert!(snapshot.contains_key("README.md"));
        assert!(snapshot.contains_key("nested/data.bin"));
        assert!(!snapshot.contains_key(".hidden/secret.txt"));
        assert!(!snapshot.keys().any(|path| path.starts_with("linked/")));
    }

    #[test]
    fn enabling_a_trigger_requires_the_action_to_be_reapproved() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        let root = temp.path().join("docs");
        fs::create_dir_all(&root).expect("root");
        let root_id = register_root(&app_data, &root);
        let executor = Arc::new(ReviewGateExecutor {
            approved: Mutex::new(true),
        });
        let supervisor = DocumentAutomationSupervisor::new_without_background_runner(
            app_data,
            executor.clone() as Arc<dyn DocumentActionExecutor>,
        )
        .expect("supervisor");
        let trigger = supervisor
            .create_trigger(trigger_input(root_id))
            .expect("trigger");

        supervisor
            .set_trigger_enabled(&trigger.id, false)
            .expect("pause always works");
        *executor.approved.lock().expect("approved lock") = false;
        let error = supervisor
            .set_trigger_enabled(&trigger.id, true)
            .expect_err("승인 지문이 어긋난 트리거는 켜지지 않는다");
        assert!(matches!(error, CoreError::Conflict(_)));
        let stored = supervisor
            .snapshot()
            .expect("snapshot")
            .triggers
            .into_iter()
            .find(|stored| stored.id == trigger.id)
            .expect("stored trigger");
        assert!(!stored.input.enabled);
        assert_eq!(stored.status, DocumentTriggerStatus::Paused);

        *executor.approved.lock().expect("approved lock") = true;
        let reenabled = supervisor
            .set_trigger_enabled(&trigger.id, true)
            .expect("재승인 후에는 켜진다");
        assert!(reenabled.input.enabled);
        assert_eq!(reenabled.status, DocumentTriggerStatus::Active);
    }

    #[test]
    fn first_baseline_is_silent_and_restart_diff_only_creates_offline_report() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        let root = temp.path().join("docs");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("first.md"), "one").expect("first");
        register_root(&app_data, &root);
        let (first_executor, first_receiver) = executor();
        let first = DocumentAutomationSupervisor::new_without_background_runner(
            app_data.clone(),
            first_executor,
        )
        .expect("first supervisor");
        assert!(first.snapshot().expect("snapshot").offline_report.is_none());
        drop(first);

        fs::write(root.join("second.txt"), "two").expect("offline change");
        let (second_executor, second_receiver) = executor();
        let second =
            DocumentAutomationSupervisor::new_without_background_runner(app_data, second_executor)
                .expect("second supervisor");
        let report = second
            .snapshot()
            .expect("snapshot")
            .offline_report
            .expect("offline report");
        assert_eq!(report.total_count, 1);
        assert_eq!(report.changes[0].changes[0].relative_path, "second.txt");
        assert!(first_receiver.try_recv().is_err());
        assert!(second_receiver.try_recv().is_err());
    }

    #[test]
    fn live_changes_are_debounced_filtered_and_dispatched_once() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        let root = temp.path().join("docs");
        fs::create_dir_all(root.join("draft")).expect("draft");
        let root_id = register_root(&app_data, &root);
        let (executor, receiver) = executor();
        let supervisor =
            DocumentAutomationSupervisor::new_without_background_runner(app_data, executor)
                .expect("supervisor");
        supervisor
            .create_trigger(trigger_input(root_id))
            .expect("trigger");
        let start = now_ms();
        fs::write(root.join("note.md"), "changed").expect("included");
        fs::write(root.join("draft/skip.md"), "skip").expect("excluded");
        fs::write(root.join("other.txt"), "skip").expect("not included");
        supervisor.poll_once_for_test(start).expect("first poll");
        assert!(receiver.try_recv().is_err());
        supervisor
            .poll_once_for_test(start + DEFAULT_DEBOUNCE_MS + 1)
            .expect("debounced poll");
        let context = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("one action");
        assert_eq!(context.batch.total_count, 1);
        assert_eq!(context.batch.changes[0].relative_path, "note.md");
    }

    #[test]
    fn restart_restores_a_change_waiting_for_debounce() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        let root = temp.path().join("docs");
        fs::create_dir_all(&root).expect("root");
        let root_id = register_root(&app_data, &root);
        let (first_executor, first_receiver) = executor();
        let first = DocumentAutomationSupervisor::new_without_background_runner(
            app_data.clone(),
            first_executor,
        )
        .expect("first supervisor");
        first
            .create_trigger(trigger_input(root_id))
            .expect("trigger");
        let start = now_ms();
        fs::write(root.join("note.md"), "changed").expect("change");
        first.poll_once_for_test(start).expect("first poll");
        assert!(first_receiver.try_recv().is_err());
        drop(first);

        let (second_executor, second_receiver) = executor();
        let second =
            DocumentAutomationSupervisor::new_without_background_runner(app_data, second_executor)
                .expect("second supervisor");
        assert!(second
            .snapshot()
            .expect("snapshot")
            .offline_report
            .is_none());
        second
            .poll_once_for_test(start + DEFAULT_DEBOUNCE_MS + 1)
            .expect("restored poll");
        let context = second_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("restored action");
        assert_eq!(context.batch.changes[0].relative_path, "note.md");
    }

    #[test]
    fn restart_merges_inflight_before_newer_pending_batch() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data");
        let trigger_id = "trigger-1".to_owned();
        let batch = |event_id: &str, detected_at: i64, path: &str| DocumentChangeBatch {
            event_id: event_id.to_owned(),
            root_id: "root-1".to_owned(),
            root_path: "/docs".to_owned(),
            detected_at,
            changes: vec![DocumentChange {
                kind: DocumentChangeKind::Modified,
                relative_path: path.to_owned(),
                size_bytes: Some(1),
            }],
            total_count: 1,
            omitted_count: 0,
            test: false,
        };
        write_private_json(
            &app_data.join(PENDING_STORE_FILE_NAME),
            &DurablePendingStore {
                schema_version: PENDING_STORE_SCHEMA_VERSION,
                pending_roots: HashMap::new(),
                pending_actions: HashMap::from([(
                    trigger_id.clone(),
                    batch("new-event", 20, "new.md"),
                )]),
                inflight_actions: HashMap::from([(
                    trigger_id.clone(),
                    batch("old-event", 10, "old.md"),
                )]),
            },
        )
        .expect("pending store");

        let (executor, _receiver) = executor();
        let supervisor =
            DocumentAutomationSupervisor::new_without_background_runner(app_data, executor)
                .expect("supervisor");
        let runtime = lock_runtime(&supervisor.inner).expect("runtime");
        let restored = runtime
            .pending_actions
            .get(&trigger_id)
            .expect("restored batch");
        assert_eq!(restored.event_id, "new-event");
        assert_eq!(restored.detected_at, 20);
        assert_eq!(
            restored
                .changes
                .iter()
                .map(|change| change.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["new.md", "old.md"]
        );
    }

    #[test]
    fn wildcard_distinguishes_single_and_double_star() {
        assert!(wildcard_match("*.md", "README.md"));
        assert!(!wildcard_match("*.md", "nested/README.md"));
        assert!(wildcard_match("**/*.md", "nested/README.md"));
        assert!(wildcard_match("docs/?ote.md", "docs/note.md"));
        assert!(!wildcard_match("docs/?ote.md", "docs/deep/note.md"));
    }

    #[test]
    fn document_change_kind_display_and_from_str_round_trip() {
        assert_eq!(
            DocumentChangeKind::ALL,
            [
                DocumentChangeKind::Created,
                DocumentChangeKind::Modified,
                DocumentChangeKind::Deleted,
            ]
        );
        for kind in DocumentChangeKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<DocumentChangeKind>().unwrap(), kind);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: DocumentChangeKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert_eq!(
            "  modified  ".parse::<DocumentChangeKind>().unwrap(),
            DocumentChangeKind::Modified
        );
        assert!(matches!(
            "invalid".parse::<DocumentChangeKind>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
        // Ord 자연 정렬 순서 검증
        let mut kinds = vec![
            DocumentChangeKind::Deleted,
            DocumentChangeKind::Created,
            DocumentChangeKind::Modified,
        ];
        kinds.sort();
        assert_eq!(
            kinds,
            vec![
                DocumentChangeKind::Created,
                DocumentChangeKind::Modified,
                DocumentChangeKind::Deleted,
            ]
        );
    }

    #[test]
    fn document_trigger_status_display_and_from_str_round_trip() {
        assert_eq!(
            DocumentTriggerStatus::ALL,
            [
                DocumentTriggerStatus::Active,
                DocumentTriggerStatus::Paused,
                DocumentTriggerStatus::Degraded,
                DocumentTriggerStatus::NeedsReview,
                DocumentTriggerStatus::Restricted,
            ]
        );
        for status in DocumentTriggerStatus::ALL {
            assert_eq!(status.to_string(), status.as_str());
            assert_eq!(
                status.as_str().parse::<DocumentTriggerStatus>().unwrap(),
                status
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, format!("\"{}\"", status.as_str()));
            let deserialized: DocumentTriggerStatus = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, status);
        }
        assert_eq!(
            "  needsReview  ".parse::<DocumentTriggerStatus>().unwrap(),
            DocumentTriggerStatus::NeedsReview
        );
        assert!(matches!(
            "invalid".parse::<DocumentTriggerStatus>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn document_trigger_run_status_display_and_from_str_round_trip() {
        assert_eq!(
            DocumentTriggerRunStatus::ALL,
            [
                DocumentTriggerRunStatus::Running,
                DocumentTriggerRunStatus::Completed,
                DocumentTriggerRunStatus::Failed,
                DocumentTriggerRunStatus::Skipped,
            ]
        );
        for status in DocumentTriggerRunStatus::ALL {
            assert_eq!(status.to_string(), status.as_str());
            assert_eq!(
                status.as_str().parse::<DocumentTriggerRunStatus>().unwrap(),
                status
            );
            assert_eq!(run_status_name(status), status.as_str());
            assert_eq!(parse_run_status(status.as_str()), status);
            // 종료 상태 판정 검증
            if matches!(status, DocumentTriggerRunStatus::Running) {
                assert!(!status.is_terminal());
            } else {
                assert!(status.is_terminal());
            }
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, format!("\"{}\"", status.as_str()));
            let deserialized: DocumentTriggerRunStatus = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, status);
        }
        assert_eq!(
            "  completed  ".parse::<DocumentTriggerRunStatus>().unwrap(),
            DocumentTriggerRunStatus::Completed
        );
        assert!(matches!(
            "invalid".parse::<DocumentTriggerRunStatus>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
        // parse_run_status 폴백 검증
        assert_eq!(
            parse_run_status("unknown"),
            DocumentTriggerRunStatus::Running
        );
    }
}
