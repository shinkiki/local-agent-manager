//! AIA 실시간 시스템 워크플로 저장소와 제한된 선언형 실행기.
//!
//! 워크플로는 system_catalog에 등록된 기본 작업 호출과 검증된 제어 구조
//! (순차 실행, 허용 필드 선택, 등호 조건, 횟수 고정 반복, 실패 즉시 중단,
//! 사후조건 검증, 멱등 키 전달)만 표현할 수 있다. 임의 코드 평가, 셸 명령,
//! 임의 파일·URL 접근, 등록되지 않은 작업 호출, 자기 권한 확장은 구조적으로
//! 표현이 불가능하며 검증 단계에서 거부된다.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs4::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::session_management::{
    claim_idempotency, complete_idempotency, fingerprint, hash_text, validate_idempotency_key,
};
use crate::{CoreError, SystemAuditPhase};

const STORE_FILE: &str = "aia-system-workflows-v1.json";
const STORE_LOCK_FILE: &str = "aia-system-workflows-v1.lock";
const STORE_VERSION: u32 = 1;

const MAX_WORKFLOWS: usize = 64;
const MAX_VERSIONS_PER_WORKFLOW: usize = 10;
const MAX_STEPS: usize = 20;
const MAX_INPUT_FIELDS: usize = 16;
const MAX_ENUM_VALUES: usize = 32;
const MAX_FOR_EACH_ITERATIONS: u32 = 100;
const MAX_TOTAL_OPERATION_CALLS: usize = 200;
const MAX_CONTRACT_BYTES: usize = 32 * 1024;
const MAX_INPUT_STRING_LEN: usize = 4096;
const MAX_PATH_SEGMENTS: usize = 8;
const MAX_NAME_LEN: usize = 120;
const MAX_DESCRIPTION_LEN: usize = 2000;

/// 워크플로 단계로 호출할 수 없는 작업. 워크플로가 스스로 권한을 확장하거나
/// 승인 절차를 우회·중첩하는 동작을 구조적으로 차단한다.
const FORBIDDEN_STEP_OPERATIONS: &[&str] = &[
    "propose_system_workflow_schema",
    "register_system_workflow",
    "execute_system_workflow",
    "delete_system_workflow",
];

/// 복구하기 어려운 영향을 승인 화면에 표시해야 하는 작업.
const HARD_TO_RECOVER_OPERATIONS: &[(&str, &str)] = &[
    (
        "stop_chat",
        "채팅 종료: 진행 중 응답·승인·대기 메시지가 사라질 수 있습니다",
    ),
    (
        "stop_provider_chats",
        "공급자 채팅 전체 종료: 진행 중 응답·승인·대기 메시지가 사라질 수 있습니다",
    ),
    (
        "stop_provider_terminals",
        "공급자 관리 터미널 전체 종료: 진행 중인 대화형 작업이 사라질 수 있습니다",
    ),
    (
        "terminate_external_provider_processes",
        "외부 독립 실행 공급자 CLI 프로세스 종료: 해당 프로세스의 진행 중 작업이 사라질 수 있습니다",
    ),
    (
        "set_active_provider_account",
        "관리·외부 런타임 전체 종료 후 활성 인증 계정 변경",
    ),
    (
        "switch_active_provider_account",
        "관리 세션·외부 CLI 프로세스 전체 종료 후 활성 계정 변경",
    ),
    ("delete_provider_account", "관리 계정 등록 삭제"),
    ("delete_scheduled_request", "반복 요청 삭제"),
    ("delete_session_folder", "세션 폴더 삭제"),
    ("delete_doc_root", "문서 루트 제거"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkflowRisk {
    ReadOnly,
    Mutating,
    Destructive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkflowInputKind {
    Enum,
    String,
    Number,
    Boolean,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowInputField {
    #[serde(rename = "type")]
    kind: WorkflowInputKind,
    #[serde(default)]
    values: Option<Vec<String>>,
    #[serde(default = "default_true")]
    required: bool,
    #[serde(default)]
    description: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowForEach {
    step: String,
    #[serde(default)]
    path: String,
    max_iterations: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum ConditionOutcome {
    #[default]
    Skip,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowCondition {
    left: Value,
    equals: Value,
    #[serde(default)]
    when_false: ConditionOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowExpectation {
    #[serde(default)]
    path: String,
    equals: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowStep {
    id: String,
    operation: String,
    #[serde(default = "empty_object")]
    arguments: Value,
    #[serde(default)]
    for_each: Option<WorkflowForEach>,
    #[serde(default)]
    condition: Option<WorkflowCondition>,
    #[serde(default)]
    expect: Option<WorkflowExpectation>,
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SystemWorkflowContract {
    pub id: String,
    display_name: String,
    description: String,
    #[serde(default)]
    input_schema: BTreeMap<String, WorkflowInputField>,
    steps: Vec<WorkflowStep>,
    risk: WorkflowRisk,
    #[serde(default)]
    version: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowExecuteRequest {
    pub workflow_id: String,
    #[serde(default = "empty_object")]
    pub arguments: Value,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkflowVersion {
    version: u32,
    registered_at: i64,
    computed_risk: WorkflowRisk,
    required_operations: Vec<String>,
    contract: SystemWorkflowContract,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowExecutionSummary {
    execution_id: String,
    version: u32,
    started_at: i64,
    finished_at: i64,
    succeeded: bool,
    failed_step_id: Option<String>,
    step_statuses: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkflow {
    id: String,
    versions: Vec<StoredWorkflowVersion>,
    #[serde(default)]
    last_execution: Option<WorkflowExecutionSummary>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowStore {
    schema_version: u32,
    workflows: BTreeMap<String, StoredWorkflow>,
}

impl Default for WorkflowStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            workflows: BTreeMap::new(),
        }
    }
}

/// 검증을 통과한 계약의 파생 정보.
struct ValidatedContract {
    computed_risk: WorkflowRisk,
    required_operations: Vec<String>,
    mutating_operations: Vec<String>,
    hard_to_recover_effects: Vec<String>,
}

pub(crate) type WorkflowInvoker<'a> = dyn Fn(&str, Value) -> Result<Value, CoreError> + 'a;

#[derive(Clone)]
pub(crate) struct SystemWorkflowRegistry {
    app_data_dir: PathBuf,
}

impl SystemWorkflowRegistry {
    pub(crate) fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir }
    }

    /// 계약 초안을 검증하고 승인 화면 요약을 반환한다. 상태를 변경하지 않는다.
    pub(crate) fn propose(&self, contract: SystemWorkflowContract) -> Result<Value, CoreError> {
        let validated = validate_contract(&contract)?;
        Ok(json!({
            "valid": true,
            "contract": contract,
            "computedRisk": validated.computed_risk,
            "requiredOperations": validated.required_operations,
            "approvalSummary": approval_summary(&contract, &validated),
        }))
    }

    /// 사용자가 승인한 계약을 새 버전으로 등록한다. 기존 버전은 덮어쓰지 않는다.
    pub(crate) fn register(&self, contract: SystemWorkflowContract) -> Result<Value, CoreError> {
        let validated = validate_contract(&contract)?;
        self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            let next_version = match store.workflows.get(&contract.id) {
                Some(existing) => {
                    existing
                        .versions
                        .last()
                        .map(|version| version.version)
                        .unwrap_or(0)
                        + 1
                }
                None => {
                    if store.workflows.len() >= MAX_WORKFLOWS {
                        return Err(CoreError::Conflict(format!(
                            "등록 가능한 워크플로 수({MAX_WORKFLOWS})를 초과했습니다"
                        )));
                    }
                    1
                }
            };
            if let Some(requested) = contract.version {
                if requested != next_version {
                    return Err(CoreError::Conflict(format!(
                        "요청한 버전 {requested}이(가) 다음 버전 {next_version}과 다릅니다"
                    )));
                }
            }
            let mut canonical = contract.clone();
            canonical.version = Some(next_version);
            let entry = store
                .workflows
                .entry(contract.id.clone())
                .or_insert_with(|| StoredWorkflow {
                    id: contract.id.clone(),
                    versions: Vec::new(),
                    last_execution: None,
                });
            entry.versions.push(StoredWorkflowVersion {
                version: next_version,
                registered_at: now_ms(),
                computed_risk: validated.computed_risk,
                required_operations: validated.required_operations.clone(),
                contract: canonical,
            });
            if entry.versions.len() > MAX_VERSIONS_PER_WORKFLOW {
                let remove = entry.versions.len() - MAX_VERSIONS_PER_WORKFLOW;
                entry.versions.drain(..remove);
            }
            self.save_store_unlocked(&store)?;
            Ok(json!({
                "workflowId": contract.id,
                "version": next_version,
                "computedRisk": validated.computed_risk,
                "requiredOperations": validated.required_operations,
                "registered": true,
            }))
        })
    }

    /// 워크플로와 실행 권한을 제거한다. 감사 이력은 별도 파일이라 유지된다.
    /// 워크플로 단계는 다른 워크플로를 호출할 수 없으므로 의존성 검사는 불필요하다.
    pub(crate) fn delete(&self, workflow_id: &str) -> Result<Value, CoreError> {
        self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            if store.workflows.remove(workflow_id).is_none() {
                return Err(CoreError::NotFound(format!(
                    "등록된 워크플로 {workflow_id}을(를) 찾을 수 없습니다"
                )));
            }
            self.save_store_unlocked(&store)?;
            Ok(json!({"workflowId": workflow_id, "deleted": true}))
        })
    }

    pub(crate) fn list(&self) -> Result<Value, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            let workflows = store
                .workflows
                .values()
                .map(workflow_summary)
                .collect::<Vec<_>>();
            Ok(json!({
                "workflows": workflows,
                "limits": workflow_limits(),
            }))
        })
    }

    pub(crate) fn get(&self, workflow_id: &str) -> Result<Value, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            let workflow = store.workflows.get(workflow_id).ok_or_else(|| {
                CoreError::NotFound(format!(
                    "등록된 워크플로 {workflow_id}을(를) 찾을 수 없습니다"
                ))
            })?;
            let mut detail = workflow_summary(workflow);
            if let Some(latest) = workflow.versions.last() {
                detail["contract"] = serde_json::to_value(&latest.contract)?;
            }
            detail["versions"] = Value::Array(
                workflow
                    .versions
                    .iter()
                    .map(|version| {
                        json!({
                            "version": version.version,
                            "registeredAt": version.registered_at,
                            "computedRisk": version.computed_risk,
                            "requiredOperations": version.required_operations,
                        })
                    })
                    .collect(),
            );
            Ok(detail)
        })
    }

    /// system_catalog에 병합하는 요약. AIA가 등록 직후 즉시 조회할 수 있다.
    pub(crate) fn catalog_summary(&self) -> Result<Value, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            Ok(Value::Array(
                store.workflows.values().map(workflow_summary).collect(),
            ))
        })
    }

    /// 등록된 워크플로를 실행한다. 실행 당시의 최신 버전을 끝까지 사용한다.
    /// 검증 오류는 Err로, 단계 실패는 succeeded=false 결과로 반환한다.
    pub(crate) fn execute(
        &self,
        request: WorkflowExecuteRequest,
        invoker: &WorkflowInvoker<'_>,
    ) -> Result<Value, CoreError> {
        validate_idempotency_key(&request.idempotency_key)?;
        let request_hash = fingerprint(&json!({
            "workflowId": request.workflow_id,
            "arguments": request.arguments,
        }))?;
        let key_hash = hash_text(&request.idempotency_key);
        if let Some(receipt) = claim_idempotency(
            &self.app_data_dir,
            "execute_system_workflow",
            &key_hash,
            &request_hash,
        )? {
            return Ok(receipt);
        }
        let result = self.execute_claimed(&request, invoker);
        complete_idempotency(
            &self.app_data_dir,
            &key_hash,
            result.as_ref().ok().cloned(),
            result.is_ok(),
        )?;
        result
    }

    fn execute_claimed(
        &self,
        request: &WorkflowExecuteRequest,
        invoker: &WorkflowInvoker<'_>,
    ) -> Result<Value, CoreError> {
        let version =
            self.with_store_lock(|| {
                let store = self.load_store_unlocked()?;
                let workflow = store.workflows.get(&request.workflow_id).ok_or_else(|| {
                    CoreError::NotFound(format!(
                        "등록된 워크플로 {}을(를) 찾을 수 없습니다",
                        request.workflow_id
                    ))
                })?;
                workflow.versions.last().cloned().ok_or_else(|| {
                    CoreError::Runtime("워크플로 버전 정보가 손상되었습니다".to_owned())
                })
            })?;
        // 기본 작업 계약이 바뀐 워크플로는 재검증 전에는 실행하지 않는다.
        if let Err(error) = validate_contract(&version.contract) {
            return Err(CoreError::Conflict(format!(
                "워크플로가 현재 system_catalog와 호환되지 않아 실행할 수 없습니다. 재등록이 필요합니다: {error}"
            )));
        }
        let inputs = validate_inputs(&version.contract, &request.arguments)?;
        let started_at = now_ms();
        let execution_id = format!("wfexec-{}", Uuid::new_v4().simple());
        let short_execution = execution_id.chars().take(19).collect::<String>();

        let mut results: BTreeMap<String, Value> = BTreeMap::new();
        let mut step_reports: Vec<Value> = Vec::new();
        let mut total_calls = 0usize;
        let mut failed_step: Option<(String, String, bool)> = None;

        'steps: for step in &version.contract.steps {
            let mut iterations = 0usize;
            let mut skipped_items = 0usize;
            let mut changed_targets: Vec<String> = Vec::new();
            let mutating =
                crate::system_mcp::system_operation_kind(&step.operation).unwrap_or(false);
            let outcome: Result<Option<Value>, (String, bool)> = (|| {
                if let Some(for_each) = &step.for_each {
                    let source = results.get(&for_each.step).ok_or_else(|| {
                        (
                            format!("forEach가 참조한 단계 {}의 결과가 없습니다", for_each.step),
                            false,
                        )
                    })?;
                    let items = select_path(source, &for_each.path)
                        .map_err(|error| (error.to_string(), false))?
                        .as_array()
                        .cloned()
                        .ok_or_else(|| ("forEach 대상이 목록이 아닙니다".to_owned(), false))?;
                    if items.len() > for_each.max_iterations as usize {
                        return Err((
                            format!(
                                "반복 대상 {}개가 maxIterations {}을(를) 초과합니다",
                                items.len(),
                                for_each.max_iterations
                            ),
                            false,
                        ));
                    }
                    let mut collected = Vec::new();
                    for (index, item) in items.iter().enumerate() {
                        let ctx = TemplateContext {
                            inputs: &inputs,
                            results: &results,
                            item: Some(item),
                            execution_id: &short_execution,
                            step_id: &step.id,
                            iteration: index,
                        };
                        match evaluate_condition(step.condition.as_ref(), &ctx) {
                            Ok(true) => {}
                            Ok(false) => {
                                if step
                                    .condition
                                    .as_ref()
                                    .is_some_and(|c| c.when_false == ConditionOutcome::Fail)
                                {
                                    return Err((
                                        "조건 검증에 실패해 중단합니다".to_owned(),
                                        false,
                                    ));
                                }
                                skipped_items += 1;
                                continue;
                            }
                            Err(error) => return Err((error.to_string(), false)),
                        }
                        let value = run_operation(
                            &self.app_data_dir,
                            invoker,
                            step,
                            &ctx,
                            mutating,
                            &mut total_calls,
                            &mut changed_targets,
                        )
                        .map_err(|error| classify_failure(&error))?;
                        check_expectation(step.expect.as_ref(), &value)
                            .map_err(|error| (error.to_string(), false))?;
                        iterations += 1;
                        collected.push(value);
                    }
                    Ok(Some(Value::Array(collected)))
                } else {
                    let ctx = TemplateContext {
                        inputs: &inputs,
                        results: &results,
                        item: None,
                        execution_id: &short_execution,
                        step_id: &step.id,
                        iteration: 0,
                    };
                    match evaluate_condition(step.condition.as_ref(), &ctx) {
                        Ok(true) => {}
                        Ok(false) => {
                            if step
                                .condition
                                .as_ref()
                                .is_some_and(|c| c.when_false == ConditionOutcome::Fail)
                            {
                                return Err(("조건 검증에 실패해 중단합니다".to_owned(), false));
                            }
                            return Ok(None);
                        }
                        Err(error) => return Err((error.to_string(), false)),
                    }
                    let value = run_operation(
                        &self.app_data_dir,
                        invoker,
                        step,
                        &ctx,
                        mutating,
                        &mut total_calls,
                        &mut changed_targets,
                    )
                    .map_err(|error| classify_failure(&error))?;
                    check_expectation(step.expect.as_ref(), &value)
                        .map_err(|error| (error.to_string(), false))?;
                    iterations = 1;
                    Ok(Some(value))
                }
            })();
            match outcome {
                Ok(Some(value)) => {
                    step_reports.push(json!({
                        "stepId": step.id,
                        "operation": step.operation,
                        "status": "succeeded",
                        "iterations": iterations,
                        "skippedItems": skipped_items,
                        "changedTargets": changed_targets,
                        "error": Value::Null,
                    }));
                    results.insert(step.id.clone(), value);
                }
                Ok(None) => {
                    step_reports.push(json!({
                        "stepId": step.id,
                        "operation": step.operation,
                        "status": "skipped",
                        "iterations": 0,
                        "skippedItems": skipped_items,
                        "changedTargets": [],
                        "error": Value::Null,
                    }));
                    results.insert(step.id.clone(), Value::Null);
                }
                Err((error, retryable)) => {
                    step_reports.push(json!({
                        "stepId": step.id,
                        "operation": step.operation,
                        "status": "failed",
                        "iterations": iterations,
                        "skippedItems": skipped_items,
                        "changedTargets": changed_targets,
                        "error": error,
                    }));
                    failed_step = Some((step.id.clone(), error, retryable));
                    break 'steps;
                }
            }
        }
        let finished_at = now_ms();
        let succeeded = failed_step.is_none();
        let receipt = json!({
            "workflowId": request.workflow_id,
            "version": version.version,
            "executionId": execution_id,
            "startedAt": started_at,
            "finishedAt": finished_at,
            "succeeded": succeeded,
            "failedStepId": failed_step.as_ref().map(|(id, _, _)| id.clone()),
            "failure": failed_step.as_ref().map(|(_, error, _)| error.clone()),
            "retryable": failed_step.as_ref().map(|(_, _, retryable)| *retryable).unwrap_or(false),
            "steps": step_reports,
        });
        // 최근 실행 요약은 인자·결과 원문 없이 상태만 저장한다.
        let summary = WorkflowExecutionSummary {
            execution_id: receipt["executionId"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            version: version.version,
            started_at,
            finished_at,
            succeeded,
            failed_step_id: failed_step.as_ref().map(|(id, _, _)| id.clone()),
            step_statuses: receipt["steps"]
                .as_array()
                .map(|steps| {
                    steps
                        .iter()
                        .map(|step| {
                            json!({
                                "stepId": step["stepId"],
                                "status": step["status"],
                                "iterations": step["iterations"],
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        };
        let _ = self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            if let Some(workflow) = store.workflows.get_mut(&request.workflow_id) {
                workflow.last_execution = Some(summary.clone());
                self.save_store_unlocked(&store)?;
            }
            Ok(())
        });
        Ok(receipt)
    }

    fn with_store_lock<T>(
        &self,
        action: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        fs::create_dir_all(&self.app_data_dir)?;
        let lock = open_private_file(&self.app_data_dir.join(STORE_LOCK_FILE), false)?;
        lock.lock().map_err(|error| {
            CoreError::Runtime(format!("워크플로 저장소 잠금을 얻지 못했습니다: {error}"))
        })?;
        let result = action();
        let _ = FileExt::unlock(&lock);
        result
    }

    fn load_store_unlocked(&self) -> Result<WorkflowStore, CoreError> {
        let path = self.app_data_dir.join(STORE_FILE);
        if !path.is_file() {
            return Ok(WorkflowStore::default());
        }
        let store: WorkflowStore = serde_json::from_slice(&fs::read(path)?)?;
        if store.schema_version != STORE_VERSION {
            return Err(CoreError::Conflict(format!(
                "지원하지 않는 워크플로 저장소 버전입니다: {}",
                store.schema_version
            )));
        }
        Ok(store)
    }

    fn save_store_unlocked(&self, store: &WorkflowStore) -> Result<(), CoreError> {
        let path = self.app_data_dir.join(STORE_FILE);
        let temporary = self
            .app_data_dir
            .join(format!(".{STORE_FILE}.{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut file = open_private_file(&temporary, true)?;
            file.write_all(&serde_json::to_vec_pretty(store)?)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            if cfg!(windows) && path.exists() {
                fs::remove_file(&path)?;
            }
            fs::rename(&temporary, &path)?;
            File::open(&self.app_data_dir)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

fn workflow_summary(workflow: &StoredWorkflow) -> Value {
    let latest = workflow.versions.last();
    let compatible = latest
        .map(|version| validate_contract(&version.contract).is_ok())
        .unwrap_or(false);
    json!({
        "id": workflow.id,
        "displayName": latest.map(|v| v.contract.display_name.clone()),
        "description": latest.map(|v| v.contract.description.clone()),
        "version": latest.map(|v| v.version),
        "risk": latest.map(|v| v.contract.risk),
        "computedRisk": latest.map(|v| v.computed_risk),
        "requiredOperations": latest.map(|v| v.required_operations.clone()),
        "inputSchema": latest.and_then(|v| serde_json::to_value(&v.contract.input_schema).ok()),
        "compatible": compatible,
        "lastExecution": workflow.last_execution,
    })
}

fn workflow_limits() -> Value {
    json!({
        "maxWorkflows": MAX_WORKFLOWS,
        "maxSteps": MAX_STEPS,
        "maxForEachIterations": MAX_FOR_EACH_ITERATIONS,
        "maxTotalOperationCalls": MAX_TOTAL_OPERATION_CALLS,
        "allowedControl": [
            "순차 실행",
            "system_catalog 기본 작업 호출",
            "이전 단계 결과의 허용 필드 선택($step/$item/$input)",
            "enum·문자열·숫자·boolean 입력 검증",
            "등호 비교 조건(condition)",
            "최대 횟수 고정 목록 반복(forEach)",
            "실패 즉시 중단",
            "사후조건 검증(expect)",
            "멱등 키 전달($idempotencyKey)"
        ],
        "forbidden": [
            "임의 코드 평가·셸 명령·동적 로딩",
            "임의 파일·URL 접근",
            "system_catalog에 없는 작업 호출",
            "워크플로 관리 작업 자체 호출(자기 권한 확장)",
            "무제한 반복"
        ]
    })
}

fn approval_summary(contract: &SystemWorkflowContract, validated: &ValidatedContract) -> Value {
    json!({
        "name": contract.display_name,
        "purpose": contract.description,
        "operations": validated.required_operations,
        "mutatingOperations": validated.mutating_operations,
        "hardToRecoverEffects": validated.hard_to_recover_effects,
        "inputSchema": contract.input_schema,
        "executionLimits": {
            "maxSteps": contract.steps.len(),
            "maxForEachIterations": contract
                .steps
                .iter()
                .filter_map(|step| step.for_each.as_ref().map(|f| f.max_iterations))
                .max()
                .unwrap_or(0),
            "maxTotalOperationCalls": MAX_TOTAL_OPERATION_CALLS,
        },
        "grantsAfterRegistration": "등록 후에도 변경 작업이 포함된 실행은 매번 system_execute 승인을 거칩니다",
    })
}

/// 계약 전체 검증. 등록·제안·실행 전 재검증에 공통으로 사용한다.
fn validate_contract(contract: &SystemWorkflowContract) -> Result<ValidatedContract, CoreError> {
    let serialized = serde_json::to_vec(contract)?;
    if serialized.len() > MAX_CONTRACT_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "워크플로 계약이 허용 크기({MAX_CONTRACT_BYTES}바이트)를 초과했습니다"
        )));
    }
    validate_identifier(&contract.id, "워크플로 id")?;
    validate_text(&contract.display_name, MAX_NAME_LEN, "displayName")?;
    validate_text(&contract.description, MAX_DESCRIPTION_LEN, "description")?;
    if contract.steps.is_empty() || contract.steps.len() > MAX_STEPS {
        return Err(CoreError::InvalidInput(format!(
            "steps는 1개 이상 {MAX_STEPS}개 이하이어야 합니다"
        )));
    }
    if contract.input_schema.len() > MAX_INPUT_FIELDS {
        return Err(CoreError::InvalidInput(format!(
            "입력 필드는 {MAX_INPUT_FIELDS}개 이하이어야 합니다"
        )));
    }
    for (name, field) in &contract.input_schema {
        validate_identifier_loose(name, "입력 필드 이름")?;
        match field.kind {
            WorkflowInputKind::Enum => {
                let values = field.values.as_ref().ok_or_else(|| {
                    CoreError::InvalidInput(format!("enum 입력 {name}에 values가 필요합니다"))
                })?;
                if values.is_empty() || values.len() > MAX_ENUM_VALUES {
                    return Err(CoreError::InvalidInput(format!(
                        "enum 입력 {name}의 values는 1개 이상 {MAX_ENUM_VALUES}개 이하이어야 합니다"
                    )));
                }
                for value in values {
                    validate_text(value, 256, "enum 값")?;
                }
            }
            _ => {
                if field.values.is_some() {
                    return Err(CoreError::InvalidInput(format!(
                        "enum이 아닌 입력 {name}에는 values를 지정할 수 없습니다"
                    )));
                }
            }
        }
    }

    let mut seen_steps: BTreeSet<&str> = BTreeSet::new();
    let mut prior_steps: BTreeSet<&str> = BTreeSet::new();
    let mut required_operations: BTreeSet<String> = BTreeSet::new();
    let mut mutating_operations: BTreeSet<String> = BTreeSet::new();
    let mut hard_to_recover: BTreeSet<String> = BTreeSet::new();
    for step in &contract.steps {
        validate_identifier_loose(&step.id, "단계 id")?;
        if !seen_steps.insert(step.id.as_str()) {
            return Err(CoreError::InvalidInput(format!(
                "단계 id {}이(가) 중복되었습니다",
                step.id
            )));
        }
        if FORBIDDEN_STEP_OPERATIONS.contains(&step.operation.as_str()) {
            return Err(CoreError::InvalidInput(format!(
                "워크플로 단계에서 {} 작업은 호출할 수 없습니다",
                step.operation
            )));
        }
        let mutating =
            crate::system_mcp::system_operation_kind(&step.operation).ok_or_else(|| {
                CoreError::InvalidInput(format!(
                    "system_catalog에 없는 작업입니다: {}",
                    step.operation
                ))
            })?;
        required_operations.insert(step.operation.clone());
        if mutating {
            mutating_operations.insert(step.operation.clone());
        }
        if let Some((_, effect)) = HARD_TO_RECOVER_OPERATIONS
            .iter()
            .find(|(operation, _)| *operation == step.operation)
        {
            hard_to_recover.insert((*effect).to_owned());
        }
        let in_for_each = if let Some(for_each) = &step.for_each {
            if !prior_steps.contains(for_each.step.as_str()) {
                return Err(CoreError::InvalidInput(format!(
                    "forEach가 이전 단계가 아닌 {}을(를) 참조합니다",
                    for_each.step
                )));
            }
            if for_each.max_iterations == 0 || for_each.max_iterations > MAX_FOR_EACH_ITERATIONS {
                return Err(CoreError::InvalidInput(format!(
                    "maxIterations는 1 이상 {MAX_FOR_EACH_ITERATIONS} 이하이어야 합니다"
                )));
            }
            validate_path(&for_each.path)?;
            true
        } else {
            false
        };
        validate_template(
            &step.arguments,
            &contract.input_schema,
            &prior_steps,
            in_for_each,
            0,
        )?;
        if let Some(condition) = &step.condition {
            validate_template(
                &condition.left,
                &contract.input_schema,
                &prior_steps,
                in_for_each,
                0,
            )?;
            validate_template(
                &condition.equals,
                &contract.input_schema,
                &prior_steps,
                in_for_each,
                0,
            )?;
        }
        if let Some(expect) = &step.expect {
            validate_path(&expect.path)?;
            validate_literal(&expect.equals)?;
        }
        prior_steps.insert(step.id.as_str());
    }
    let computed_risk = if mutating_operations.is_empty() {
        WorkflowRisk::ReadOnly
    } else {
        WorkflowRisk::Mutating
    };
    if contract.risk < computed_risk {
        return Err(CoreError::InvalidInput(
            "변경 작업이 포함된 워크플로의 risk는 mutating 이상이어야 합니다".to_owned(),
        ));
    }
    Ok(ValidatedContract {
        computed_risk,
        required_operations: required_operations.into_iter().collect(),
        mutating_operations: mutating_operations.into_iter().collect(),
        hard_to_recover_effects: hard_to_recover.into_iter().collect(),
    })
}

fn validate_identifier(value: &str, label: &str) -> Result<(), CoreError> {
    let valid = (2..=64).contains(&value.len())
        && value.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!(
            "{label}은(는) 소문자·숫자·하이픈으로 된 2~64자 식별자여야 합니다"
        )))
    }
}

fn validate_identifier_loose(value: &str, label: &str) -> Result<(), CoreError> {
    let valid = (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!(
            "{label}은(는) 영숫자·하이픈·밑줄로 된 1~64자여야 합니다"
        )))
    }
}

fn validate_text(value: &str, max_len: usize, label: &str) -> Result<(), CoreError> {
    if value.trim().is_empty() || value.chars().count() > max_len {
        return Err(CoreError::InvalidInput(format!(
            "{label}은(는) 비어 있지 않은 {max_len}자 이하 텍스트여야 합니다"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(format!(
            "{label}에 제어 문자를 사용할 수 없습니다"
        )));
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), CoreError> {
    if path.is_empty() {
        return Ok(());
    }
    let segments: Vec<&str> = path.split('.').collect();
    if segments.len() > MAX_PATH_SEGMENTS {
        return Err(CoreError::InvalidInput(
            "path 선택 깊이가 허용 범위를 초과했습니다".to_owned(),
        ));
    }
    for segment in segments {
        let valid = (1..=64).contains(&segment.len())
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !valid {
            return Err(CoreError::InvalidInput(format!(
                "허용되지 않는 path 구간입니다: {segment}"
            )));
        }
    }
    Ok(())
}

/// 템플릿은 리터럴 값과 `$input`/`$step`/`$item`/`$idempotencyKey` 토큰만 허용한다.
fn validate_template(
    template: &Value,
    inputs: &BTreeMap<String, WorkflowInputField>,
    prior_steps: &BTreeSet<&str>,
    in_for_each: bool,
    depth: usize,
) -> Result<(), CoreError> {
    if depth > MAX_PATH_SEGMENTS {
        return Err(CoreError::InvalidInput(
            "인자 구조가 허용 깊이를 초과했습니다".to_owned(),
        ));
    }
    match template {
        Value::Object(map) => {
            if let Some(name) = map.get("$input") {
                let name = name.as_str().ok_or_else(|| {
                    CoreError::InvalidInput("$input 값은 문자열이어야 합니다".to_owned())
                })?;
                if map.len() != 1 {
                    return Err(CoreError::InvalidInput(
                        "$input 토큰에는 다른 키를 함께 쓸 수 없습니다".to_owned(),
                    ));
                }
                if !inputs.contains_key(name) {
                    return Err(CoreError::InvalidInput(format!(
                        "선언되지 않은 입력을 참조합니다: {name}"
                    )));
                }
                return Ok(());
            }
            if let Some(step) = map.get("$step") {
                let step = step.as_str().ok_or_else(|| {
                    CoreError::InvalidInput("$step 값은 문자열이어야 합니다".to_owned())
                })?;
                for key in map.keys() {
                    if key != "$step" && key != "path" {
                        return Err(CoreError::InvalidInput(
                            "$step 토큰에는 path 외 다른 키를 쓸 수 없습니다".to_owned(),
                        ));
                    }
                }
                if !prior_steps.contains(step) {
                    return Err(CoreError::InvalidInput(format!(
                        "$step이 이전 단계가 아닌 {step}을(를) 참조합니다"
                    )));
                }
                if let Some(path) = map.get("path") {
                    let path = path.as_str().ok_or_else(|| {
                        CoreError::InvalidInput("path는 문자열이어야 합니다".to_owned())
                    })?;
                    validate_path(path)?;
                }
                return Ok(());
            }
            if let Some(path) = map.get("$item") {
                if map.len() != 1 {
                    return Err(CoreError::InvalidInput(
                        "$item 토큰에는 다른 키를 함께 쓸 수 없습니다".to_owned(),
                    ));
                }
                if !in_for_each {
                    return Err(CoreError::InvalidInput(
                        "$item은 forEach 단계에서만 사용할 수 있습니다".to_owned(),
                    ));
                }
                let path = path.as_str().ok_or_else(|| {
                    CoreError::InvalidInput("$item 값은 path 문자열이어야 합니다".to_owned())
                })?;
                validate_path(path)?;
                return Ok(());
            }
            if map.contains_key("$idempotencyKey") {
                if map.len() != 1 {
                    return Err(CoreError::InvalidInput(
                        "$idempotencyKey 토큰에는 다른 키를 함께 쓸 수 없습니다".to_owned(),
                    ));
                }
                return Ok(());
            }
            for (key, value) in map {
                if key.starts_with('$') {
                    return Err(CoreError::InvalidInput(format!(
                        "지원하지 않는 템플릿 토큰입니다: {key}"
                    )));
                }
                validate_template(value, inputs, prior_steps, in_for_each, depth + 1)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                validate_template(item, inputs, prior_steps, in_for_each, depth + 1)?;
            }
            Ok(())
        }
        Value::String(text) => validate_text(text, MAX_INPUT_STRING_LEN, "인자 문자열"),
        _ => Ok(()),
    }
}

fn validate_literal(value: &Value) -> Result<(), CoreError> {
    match value {
        Value::Object(_) | Value::Array(_) => Err(CoreError::InvalidInput(
            "equals 값은 문자열·숫자·boolean·null 리터럴이어야 합니다".to_owned(),
        )),
        Value::String(text) => validate_text(text, MAX_INPUT_STRING_LEN, "equals 값"),
        _ => Ok(()),
    }
}

fn validate_inputs(
    contract: &SystemWorkflowContract,
    provided: &Value,
) -> Result<BTreeMap<String, Value>, CoreError> {
    let provided = provided.as_object().cloned().unwrap_or_default();
    for key in provided.keys() {
        if !contract.input_schema.contains_key(key) {
            return Err(CoreError::InvalidInput(format!(
                "선언되지 않은 입력입니다: {key}"
            )));
        }
    }
    let mut inputs = BTreeMap::new();
    for (name, field) in &contract.input_schema {
        let Some(value) = provided.get(name) else {
            if field.required {
                return Err(CoreError::InvalidInput(format!(
                    "필수 입력 {name}이(가) 없습니다"
                )));
            }
            continue;
        };
        let valid = match field.kind {
            WorkflowInputKind::Enum => value.as_str().is_some_and(|text| {
                field
                    .values
                    .as_ref()
                    .is_some_and(|values| values.iter().any(|allowed| allowed == text))
            }),
            WorkflowInputKind::String => value
                .as_str()
                .is_some_and(|text| text.chars().count() <= MAX_INPUT_STRING_LEN),
            WorkflowInputKind::Number => value.is_number(),
            WorkflowInputKind::Boolean => value.is_boolean(),
        };
        if !valid {
            return Err(CoreError::InvalidInput(format!(
                "입력 {name}이(가) 선언된 형식과 다릅니다"
            )));
        }
        inputs.insert(name.clone(), value.clone());
    }
    Ok(inputs)
}

struct TemplateContext<'a> {
    inputs: &'a BTreeMap<String, Value>,
    results: &'a BTreeMap<String, Value>,
    item: Option<&'a Value>,
    execution_id: &'a str,
    step_id: &'a str,
    iteration: usize,
}

fn resolve_template(template: &Value, ctx: &TemplateContext<'_>) -> Result<Value, CoreError> {
    match template {
        Value::Object(map) => {
            if let Some(name) = map.get("$input").and_then(Value::as_str) {
                return ctx.inputs.get(name).cloned().ok_or_else(|| {
                    CoreError::InvalidInput(format!("입력 {name}이(가) 제공되지 않았습니다"))
                });
            }
            if let Some(step) = map.get("$step").and_then(Value::as_str) {
                let result = ctx
                    .results
                    .get(step)
                    .ok_or_else(|| CoreError::Runtime(format!("단계 {step}의 결과가 없습니다")))?;
                let path = map.get("path").and_then(Value::as_str).unwrap_or("");
                return select_path(result, path).cloned();
            }
            if let Some(path) = map.get("$item").and_then(Value::as_str) {
                let item = ctx.item.ok_or_else(|| {
                    CoreError::Runtime("$item은 forEach 실행 중에만 사용할 수 있습니다".to_owned())
                })?;
                return select_path(item, path).cloned();
            }
            if map.contains_key("$idempotencyKey") {
                return Ok(Value::String(format!(
                    "wf-{}-{}-{}",
                    ctx.execution_id, ctx.step_id, ctx.iteration
                )));
            }
            let mut resolved = Map::new();
            for (key, value) in map {
                resolved.insert(key.clone(), resolve_template(value, ctx)?);
            }
            Ok(Value::Object(resolved))
        }
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| resolve_template(item, ctx))
                .collect::<Result<Vec<_>, _>>()?,
        )),
        other => Ok(other.clone()),
    }
}

fn select_path<'v>(value: &'v Value, path: &str) -> Result<&'v Value, CoreError> {
    if path.is_empty() {
        return Ok(value);
    }
    let mut current = value;
    for segment in path.split('.') {
        current = if let Ok(index) = segment.parse::<usize>() {
            current.get(index)
        } else {
            current.get(segment)
        }
        .ok_or_else(|| {
            CoreError::InvalidInput(format!("결과에서 path {path}을(를) 찾을 수 없습니다"))
        })?;
    }
    Ok(current)
}

fn evaluate_condition(
    condition: Option<&WorkflowCondition>,
    ctx: &TemplateContext<'_>,
) -> Result<bool, CoreError> {
    let Some(condition) = condition else {
        return Ok(true);
    };
    let left = resolve_template(&condition.left, ctx)?;
    let right = resolve_template(&condition.equals, ctx)?;
    Ok(left == right)
}

fn check_expectation(expect: Option<&WorkflowExpectation>, value: &Value) -> Result<(), CoreError> {
    let Some(expect) = expect else {
        return Ok(());
    };
    let actual = select_path(value, &expect.path)?;
    if *actual == expect.equals {
        Ok(())
    } else {
        Err(CoreError::Conflict(format!(
            "사후조건 검증 실패: path {} 값이 기대값과 다릅니다",
            expect.path
        )))
    }
}

#[allow(clippy::too_many_arguments)]
fn run_operation(
    app_data_dir: &Path,
    invoker: &WorkflowInvoker<'_>,
    step: &WorkflowStep,
    ctx: &TemplateContext<'_>,
    mutating: bool,
    total_calls: &mut usize,
    changed_targets: &mut Vec<String>,
) -> Result<Value, CoreError> {
    *total_calls += 1;
    if *total_calls > MAX_TOTAL_OPERATION_CALLS {
        return Err(CoreError::Conflict(format!(
            "총 작업 호출 한도({MAX_TOTAL_OPERATION_CALLS})를 초과했습니다"
        )));
    }
    let arguments = resolve_template(&step.arguments, ctx)?;
    if mutating {
        collect_changed_targets(&arguments, changed_targets);
        crate::append_system_audit(
            app_data_dir,
            &step.operation,
            &arguments,
            SystemAuditPhase::Attempted,
            None,
        )?;
    }
    let result = invoker(&step.operation, arguments.clone());
    if mutating {
        let _ = crate::append_system_audit(
            app_data_dir,
            &step.operation,
            &arguments,
            SystemAuditPhase::Completed,
            Some(result.is_ok()),
        );
    }
    result
}

/// 변경 작업 인자에서 대상 식별자만 추출한다. 메시지 원문 등은 수집하지 않는다.
fn collect_changed_targets(arguments: &Value, targets: &mut Vec<String>) {
    const TARGET_KEYS: &[&str] = &["id", "chatId", "accountId", "workflowId", "provider"];
    fn walk(value: &Value, targets: &mut Vec<String>, depth: usize) {
        if depth > 3 || targets.len() >= 10 {
            return;
        }
        if let Value::Object(map) = value {
            for (key, entry) in map {
                if TARGET_KEYS.contains(&key.as_str()) {
                    if let Some(text) = entry.as_str() {
                        if !targets.iter().any(|existing| existing == text) {
                            targets.push(text.to_owned());
                        }
                    }
                } else if matches!(entry, Value::Object(_)) {
                    walk(entry, targets, depth + 1);
                }
            }
        }
    }
    walk(arguments, targets, 0);
}

fn classify_failure(error: &CoreError) -> (String, bool) {
    let retryable = matches!(error, CoreError::Runtime(_) | CoreError::Io(_));
    (error.to_string(), retryable)
}

fn open_private_file(path: &Path, create_new: bool) -> Result<File, CoreError> {
    let mut options = OpenOptions::new();
    options.write(true).read(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    Ok(options.open(path)?)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> (tempfile::TempDir, SystemWorkflowRegistry) {
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = SystemWorkflowRegistry::new(dir.path().to_path_buf());
        (dir, registry)
    }

    fn stop_provider_contract() -> SystemWorkflowContract {
        serde_json::from_value(json!({
            "id": "stop-provider-chats",
            "displayName": "공급자 채팅 전체 종료",
            "description": "선택한 공급자의 관리 채팅을 모두 종료하고 남은 런타임을 검증",
            "inputSchema": {
                "provider": {"type": "enum", "values": ["codex", "claude"]}
            },
            "steps": [
                {"id": "list", "operation": "get_live_chats", "arguments": {"profile": "standard"}},
                {
                    "id": "stop",
                    "operation": "stop_chat",
                    "forEach": {"step": "list", "path": "", "maxIterations": 20},
                    "condition": {"left": {"$item": "source"}, "equals": {"$input": "provider"}},
                    "arguments": {"chatId": {"$item": "chatId"}}
                },
                {"id": "verify", "operation": "get_live_chats", "arguments": {"profile": "standard"}}
            ],
            "risk": "destructive"
        }))
        .expect("contract json")
    }

    #[test]
    fn propose_validates_and_reports_operations_without_state_change() {
        let (dir, registry) = registry();
        let result = registry.propose(stop_provider_contract()).expect("propose");
        assert_eq!(result["valid"], true);
        assert_eq!(result["computedRisk"], "mutating");
        let operations = result["requiredOperations"].as_array().expect("operations");
        assert!(operations.iter().any(|op| op == "stop_chat"));
        assert!(!dir.path().join(STORE_FILE).exists());
    }

    #[test]
    fn propose_rejects_unknown_operations_and_self_management() {
        let (_dir, registry) = registry();
        let mut unknown = stop_provider_contract();
        unknown.steps[0].operation = "run_shell_command".to_owned();
        assert!(matches!(
            registry.propose(unknown),
            Err(CoreError::InvalidInput(_))
        ));

        let mut nested = stop_provider_contract();
        nested.steps[0].operation = "execute_system_workflow".to_owned();
        assert!(matches!(
            registry.propose(nested),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn propose_rejects_undeclared_inputs_forward_steps_and_unbounded_loops() {
        let (_dir, registry) = registry();
        let mut bad_input = stop_provider_contract();
        bad_input.steps[0].arguments = json!({"profile": {"$input": "unknown"}});
        assert!(registry.propose(bad_input).is_err());

        let mut forward = stop_provider_contract();
        forward.steps[1].for_each = Some(WorkflowForEach {
            step: "verify".to_owned(),
            path: String::new(),
            max_iterations: 10,
        });
        assert!(registry.propose(forward).is_err());

        let mut unbounded = stop_provider_contract();
        unbounded.steps[1].for_each = Some(WorkflowForEach {
            step: "list".to_owned(),
            path: String::new(),
            max_iterations: MAX_FOR_EACH_ITERATIONS + 1,
        });
        assert!(registry.propose(unbounded).is_err());
    }

    #[test]
    fn register_creates_versions_and_delete_removes_the_workflow() {
        let (_dir, registry) = registry();
        let first = registry
            .register(stop_provider_contract())
            .expect("register v1");
        assert_eq!(first["version"], 1);
        let second = registry
            .register(stop_provider_contract())
            .expect("register v2");
        assert_eq!(second["version"], 2);

        let listed = registry.list().expect("list");
        assert_eq!(listed["workflows"].as_array().expect("workflows").len(), 1);
        let detail = registry.get("stop-provider-chats").expect("get");
        assert_eq!(detail["version"], 2);
        assert_eq!(detail["versions"].as_array().expect("versions").len(), 2);
        assert_eq!(detail["compatible"], true);

        registry.delete("stop-provider-chats").expect("delete");
        assert!(registry.get("stop-provider-chats").is_err());
    }

    #[test]
    fn register_rejects_mismatched_requested_version() {
        let (_dir, registry) = registry();
        registry
            .register(stop_provider_contract())
            .expect("register v1");
        let mut wrong = stop_provider_contract();
        wrong.version = Some(9);
        assert!(matches!(
            registry.register(wrong),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn execute_runs_steps_with_condition_filtering_and_idempotent_replay() {
        let (_dir, registry) = registry();
        registry
            .register(stop_provider_contract())
            .expect("register");
        let calls = std::sync::Mutex::new(Vec::<(String, Value)>::new());
        let invoker = |operation: &str, arguments: Value| -> Result<Value, CoreError> {
            calls
                .lock()
                .expect("calls")
                .push((operation.to_owned(), arguments.clone()));
            match operation {
                "get_live_chats" => Ok(json!([
                    {"chatId": "chat-claude", "source": "claude"},
                    {"chatId": "chat-codex", "source": "codex"}
                ])),
                "stop_chat" => Ok(json!({"chatId": arguments["chatId"], "state": "stopped"})),
                other => Err(CoreError::InvalidInput(format!("unexpected op {other}"))),
            }
        };
        let request = WorkflowExecuteRequest {
            workflow_id: "stop-provider-chats".to_owned(),
            arguments: json!({"provider": "claude"}),
            idempotency_key: "workflow-key-1".to_owned(),
        };
        let result = registry
            .execute(request.clone(), &invoker)
            .expect("execute");
        assert_eq!(result["succeeded"], true);
        let steps = result["steps"].as_array().expect("steps");
        assert_eq!(steps[1]["iterations"], 1);
        assert_eq!(steps[1]["skippedItems"], 1);
        assert!(steps[1]["changedTargets"]
            .as_array()
            .expect("targets")
            .iter()
            .any(|target| target == "chat-claude"));
        let call_count = calls.lock().expect("calls").len();

        // 같은 멱등 키 재호출은 작업을 반복하지 않고 저장된 결과를 반환한다.
        let replay = registry.execute(request, &invoker).expect("replay");
        assert_eq!(replay["executionId"], result["executionId"]);
        assert_eq!(calls.lock().expect("calls").len(), call_count);

        // 최근 실행 요약이 저장된다.
        let detail = registry.get("stop-provider-chats").expect("get");
        assert_eq!(detail["lastExecution"]["succeeded"], true);
    }

    #[test]
    fn execute_stops_at_the_first_failed_step_and_reports_it() {
        let (_dir, registry) = registry();
        registry
            .register(stop_provider_contract())
            .expect("register");
        let invoker = |operation: &str, _arguments: Value| -> Result<Value, CoreError> {
            match operation {
                "get_live_chats" => Ok(json!([{"chatId": "chat-1", "source": "claude"}])),
                "stop_chat" => Err(CoreError::Runtime("종료 실패".to_owned())),
                other => Err(CoreError::InvalidInput(format!("unexpected op {other}"))),
            }
        };
        let result = registry
            .execute(
                WorkflowExecuteRequest {
                    workflow_id: "stop-provider-chats".to_owned(),
                    arguments: json!({"provider": "claude"}),
                    idempotency_key: "workflow-key-2".to_owned(),
                },
                &invoker,
            )
            .expect("execute");
        assert_eq!(result["succeeded"], false);
        assert_eq!(result["failedStepId"], "stop");
        assert_eq!(result["retryable"], true);
        let steps = result["steps"].as_array().expect("steps");
        assert_eq!(steps.len(), 2, "실패 이후 단계는 실행하지 않는다");
    }

    #[test]
    fn execute_validates_inputs_against_the_declared_schema() {
        let (_dir, registry) = registry();
        registry
            .register(stop_provider_chats_contract_for_inputs())
            .expect("register");
        let invoker = |_op: &str, _arguments: Value| -> Result<Value, CoreError> { Ok(json!([])) };
        let bad = registry.execute(
            WorkflowExecuteRequest {
                workflow_id: "input-check".to_owned(),
                arguments: json!({"provider": "gemini"}),
                idempotency_key: "workflow-key-3".to_owned(),
            },
            &invoker,
        );
        assert!(matches!(bad, Err(CoreError::InvalidInput(_))));
    }

    fn stop_provider_chats_contract_for_inputs() -> SystemWorkflowContract {
        serde_json::from_value(json!({
            "id": "input-check",
            "displayName": "입력 검증",
            "description": "입력 검증 전용",
            "inputSchema": {
                "provider": {"type": "enum", "values": ["codex", "claude"]}
            },
            "steps": [
                {"id": "list", "operation": "get_live_chats", "arguments": {"profile": "standard"}}
            ],
            "risk": "readOnly"
        }))
        .expect("contract json")
    }

    #[test]
    fn expectation_failure_fails_the_step() {
        let (_dir, registry) = registry();
        let contract: SystemWorkflowContract = serde_json::from_value(json!({
            "id": "verify-check",
            "displayName": "사후조건 검증",
            "description": "runtimeCount 사후조건",
            "steps": [
                {
                    "id": "verify",
                    "operation": "get_provider_accounts",
                    "expect": {"path": "runtimeCount", "equals": 0}
                }
            ],
            "risk": "readOnly"
        }))
        .expect("contract");
        registry.register(contract).expect("register");
        let invoker = |_op: &str, _arguments: Value| -> Result<Value, CoreError> {
            Ok(json!({"runtimeCount": 2}))
        };
        let result = registry
            .execute(
                WorkflowExecuteRequest {
                    workflow_id: "verify-check".to_owned(),
                    arguments: json!({}),
                    idempotency_key: "workflow-key-4".to_owned(),
                },
                &invoker,
            )
            .expect("execute");
        assert_eq!(result["succeeded"], false);
        assert_eq!(result["failedStepId"], "verify");
        assert_eq!(result["retryable"], false);
    }
}
