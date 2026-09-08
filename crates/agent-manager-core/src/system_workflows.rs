//! AIA 실시간 시스템 워크플로 저장소와 제한된 선언형 실행기.
//!
//! 워크플로는 system_catalog에 등록된 기본 작업 호출과 검증된 제어 구조
//! (순차 실행, 허용 필드 선택, 등호 조건, 횟수 고정 반복, 실패 즉시 중단,
//! 사후조건 검증, 멱등 키 전달)만 표현할 수 있다. 임의 코드 평가, 셸 명령,
//! 임의 파일·URL 접근, 등록되지 않은 작업 호출, 자기 권한 확장은 구조적으로
//! 표현이 불가능하며 검증 단계에서 거부된다.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::session_management::{
    claim_idempotency, complete_idempotency, fingerprint, hash_text, validate_idempotency_key,
};
use crate::{CoreError, SystemAuditPhase};

const STORE_VERSION: u32 = 1;
const STORE: JsonStore = JsonStore {
    file: "aia-system-workflows-v1.json",
    lock_file: "aia-system-workflows-v1.lock",
    label: "워크플로 저장소",
    version: STORE_VERSION,
};

const MAX_WORKFLOWS: usize = 64;
const MAX_VERSIONS_PER_WORKFLOW: usize = 10;
const MAX_STEPS: usize = 20;
const MAX_INPUT_FIELDS: usize = 16;
const MAX_ENUM_VALUES: usize = 32;
const MAX_FOR_EACH_ITERATIONS: u32 = 100;
const MAX_TOTAL_OPERATION_CALLS: usize = 200;
const MAX_CONTRACT_BYTES: usize = 32 * 1024;
/// 승인 요약을 확인한 계약을 등록으로 이어갈 수 있는 시간.
const PROPOSAL_TTL_MS: i64 = 30 * 60 * 1000;
/// 동시에 기억하는 승인 요약 수. 오래된 것부터 밀어낸다.
const MAX_PENDING_PROPOSALS: usize = 64;
const MAX_INPUT_STRING_LEN: usize = 4096;
const MAX_PATH_SEGMENTS: usize = 8;
const MAX_NAME_LEN: usize = 120;
const MAX_DESCRIPTION_LEN: usize = 2000;
/// 회차 봉투가 내부 실행에 넘기는 값의 이름. `$run` 토큰은 이 중 하나만 고를 수 있다.
const RUN_FIELDS: &[&str] = &[
    "accountId",
    "source",
    "model",
    "cwd",
    "index",
    "reasoningEffort",
];
/// 봉투가 직접 하는 작업. 페이싱 계약은 단계로 부르지 않고, 다른 계약도 더는 단계로 받지
/// 않는다 — 계산·예약은 회차 봉투의 몫이다.
pub(crate) const ENVELOPE_OPERATIONS: &[&str] =
    &["plan_usage_paced_runs", "preview_usage_paced_runs"];
/// 봉투가 계약 입력에서 읽는 값. 무인 런타임을 띄울 경로는 필수, 레인 모델은 선택이다.
const PACED_PROJECT_PATH_INPUT: &str = "projectPath";
const PACED_MODEL_INPUTS: &[&str] = &["claudeModel", "codexModel", "antigravityModel"];
/// 계약 입력이 아니라 반복 요청의 페이싱 설정(병렬 실행)이 소유하는 이름.
const PACED_RESERVED_INPUTS: &[&str] = &["maxRuns"];

/// 워크플로 단계로 호출할 수 없는 작업. 워크플로가 스스로 권한을 확장하거나
/// 승인 절차를 우회·중첩하는 동작을 구조적으로 차단한다.
const FORBIDDEN_STEP_OPERATIONS: &[&str] = &[
    "propose_system_workflow_schema",
    "register_system_workflow",
    "execute_system_workflow",
    "delete_system_workflow",
    "create_document_trigger",
    "update_document_trigger",
    "delete_document_trigger",
    "set_document_trigger_enabled",
    "run_document_trigger_test",
    "acknowledge_document_offline_report",
    // 플러그인 도구 계약은 상류 서버가 런타임에 정한다. 승인된 정적 워크플로 계약에
    // 동적 외부 작업을 숨길 수 없도록 AIA 대화에서만 직접 호출한다.
    "read_external_plugin_tool",
    "execute_external_plugin_tool",
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
    /// 화면에 쓸 표시 이름. 없으면 화면이 입력 키를 그대로 제목으로 쓴다. 계약 키는
    /// 식별자라 사람이 읽기 위한 이름과 목적이 다르므로 따로 둔다. 예전 저장본에는
    /// 필드가 없어 그대로 `None`이 되고 지금 동작이 바뀌지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    /// 계약이 선언한 기본값. 화면은 이 값을 폼에 미리 채워 넣어 값이 매번 같은
    /// 워크플로를 바로 실행할 수 있게 하고, 실행은 생략된 입력을 이 값으로 채운다.
    /// 선언된 형과 enum 값을 그대로 지켜야 하며, 예전 저장본에는 필드가 없어 `None`이
    /// 되고 지금 동작이 바뀌지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_value: Option<Value>,
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
    /// 페이싱 회차 계약. 스케줄러가 사용량 갱신·기동 수 계산·지난 회차 정리·N건 기동·재갱신의
    /// 봉투를 두르고, 계약은 그 안에서 도는 **한 건**의 작업만 기술한다. 봉투가 정한 계정·
    /// 공급자·모델·경로는 `$run` 토큰으로 받는다.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) paced: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowExecuteRequest {
    pub workflow_id: String,
    #[serde(default = "empty_object")]
    pub arguments: Value,
    pub idempotency_key: String,
    /// 자동화가 승인 시점의 워크플로 버전을 고정할 때 사용한다. 일반 AIA 실행은
    /// 생략해 기존처럼 최신 버전을 실행한다.
    #[serde(default)]
    pub expected_version: Option<u32>,
    /// 이 실행을 트리거한 반복 요청. 요청 본문으로는 받지 않고 스케줄러만 채운다.
    #[serde(default, skip_deserializing)]
    pub trigger: Option<WorkflowTrigger>,
    /// 사용자가 반복 요청의 `지금 실행`을 눌러 시작했는지. 요청 본문으로는 받지 않고
    /// 스케줄러 실행 통로만 채운다. 페이싱 계획이 0건일 때 한 건을 직접 실행하는 근거다.
    #[serde(default, skip_deserializing)]
    pub manual_run: bool,
    /// 회차 봉투가 내부 실행에 넘기는 이번 건의 값(accountId·source·model·cwd·index·reasoningEffort).
    /// `$run` 토큰이 읽는다. 요청 본문으로는 받지 않는다.
    #[serde(default, skip_deserializing)]
    pub paced_run: Option<Value>,
    /// 내부 실행이 속한 회차 실행 id. 채팅 출처의 실행 id로 실려 계획 기록과 실행 기록을
    /// 잇는다. 요청 본문으로는 받지 않는다.
    #[serde(default, skip_deserializing)]
    pub round_execution_id: Option<String>,
}

impl Default for WorkflowExecuteRequest {
    fn default() -> Self {
        Self {
            workflow_id: String::new(),
            arguments: empty_object(),
            idempotency_key: String::new(),
            expected_version: None,
            trigger: None,
            manual_run: false,
            paced_run: None,
            round_execution_id: None,
        }
    }
}

/// 회차 봉투의 실행 옵션. 반복 요청의 페이싱 설정에서 온다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacedRoundOptions {
    /// 한 회차에 동시에 띄울 최대 건수(병렬 실행). 1이면 한 건씩. 상한은 없다 — 실제 동시
    /// 건수는 계획이 계정 여력·가드 창으로 자른다.
    pub max_runs: u32,
}

/// 워크플로 최신 버전의 페이싱 분류 근거. 계약 형태에서 읽는 세 가지 사실이며, 이것이
/// 페이싱 대상·방식(회차 봉투 / 계약 안 계산 / 기동 게이트만) 판정의 유일한 입력이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct WorkflowPacingFacts {
    /// 페이싱 회차 계약(`paced: true`). 봉투가 갱신·계산·정리·기동을 두른다.
    pub paced: bool,
    /// 계약 안에서 계산 단계를 직접 부른다(구형, 이관 대상).
    pub plans_in_contract: bool,
    /// 무인 런타임을 띄운다(start_chat). 계산이 없어도 기동 게이트는 걸린다.
    pub launches: bool,
}

impl WorkflowPacingFacts {
    fn of(version: &StoredWorkflowVersion) -> Self {
        let uses = |operation: &str| {
            version
                .required_operations
                .iter()
                .any(|required| required == operation)
        };
        Self {
            paced: version.contract.paced,
            plans_in_contract: ENVELOPE_OPERATIONS.iter().any(|operation| uses(operation)),
            launches: uses("start_chat"),
        }
    }

    /// 사용량을 쓰는 계약인지 — 사용자가 고른 값이 없을 때의 페이싱 참여 기본값.
    pub fn consumes_usage(self) -> bool {
        self.paced || self.plans_in_contract || self.launches
    }

    /// 기동 수 계산까지 하는지(봉투 또는 계약 안). 아니면 기동 게이트만 걸린다.
    pub fn computes(self) -> bool {
        self.paced || self.plans_in_contract
    }
}

/// 이관 결과: 옮긴 워크플로와, 자동으로 옮길 수 없어 건너뛴 워크플로(id, 사유).
pub(crate) type PacedMigrationOutcome = (Vec<MigratedPacedWorkflow>, Vec<(String, String)>);

/// 레거시 5단계 계약을 회차 봉투 계약으로 이관한 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MigratedPacedWorkflow {
    pub workflow_id: String,
    /// 회차 봉투 계약 버전.
    pub version: u32,
    /// 옮겨진 옛 계약 버전. 이 버전에 묶인 반복 요청만 새 버전으로 올린다 — 더 옛 버전에
    /// 묶여 재승인을 기다리던 반복 요청은 건드리지 않는다.
    pub legacy_version: u32,
    /// 옛 계약의 `maxRuns`(입력 기본값 또는 계산 단계의 리터럴). 인자에 값이 없던 반복
    /// 요청의 병렬 실행 설정이 된다.
    pub legacy_max_runs_default: Option<u32>,
}

/// 병렬 실행 건수로 읽을 수 있는 JSON 값. 정수, 소수부 없는 실수, 숫자 문자열을 받는다 —
/// AIA가 만든 인자는 `4.0`이나 `"4"`로 올 수 있다. 1 미만이거나 정수가 아니면 None.
pub(crate) fn max_runs_from_value(value: &Value) -> Option<u32> {
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (number.fract() == 0.0 && number >= 1.0 && number <= f64::from(u32::MAX))
        .then_some(number as u32)
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

impl SchemaVersioned for WorkflowStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
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

/// 워크플로 단계 하나를 실행하는 호출부. 세 번째 인자는 이 호출이 어느 워크플로·실행·단계에서
/// 왔는지로, 호출부가 `start_chat`에 위조할 수 없는 출처를 실어 주는 근거다.
pub(crate) type WorkflowInvoker<'a> =
    dyn Fn(&str, Value, &WorkflowCallSite<'_>) -> Result<Value, CoreError> + 'a;

/// 워크플로를 돌린 반복 요청. 스케줄러가 회차를 실행할 때만 있다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTrigger {
    pub schedule_id: String,
    pub run_id: String,
}

/// 단계 호출 시점의 위치. 인자 JSON이 아니라 이 값으로 전달되므로 계약 작성자가 넣거나
/// 바꿀 수 없다.
#[derive(Debug, Clone, Copy)]
pub struct WorkflowCallSite<'a> {
    pub workflow_id: &'a str,
    pub execution_id: &'a str,
    pub trigger: Option<&'a WorkflowTrigger>,
    /// 회차 봉투의 내부 실행이면 그 회차의 실행 id. 채팅 출처는 이 값을 실행 id로 실어
    /// 회차의 계획 기록(예약)과 실행 기록을 잇는다.
    pub round_execution_id: Option<&'a str>,
}

/// 승인 요약을 확인한 계약의 지문과 확인 시각. 승인 화면을 건너뛴 등록을 막는 것이
/// 목적이라 영속 상태로 두지 않는다. 백엔드가 다시 시작하면 승인부터 다시 받는다.
static PENDING_PROPOSALS: OnceLock<Mutex<Vec<(String, i64)>>> = OnceLock::new();

fn pending_proposals() -> &'static Mutex<Vec<(String, i64)>> {
    PENDING_PROPOSALS.get_or_init(|| Mutex::new(Vec::new()))
}

/// 등록 버전은 저장소가 정하므로 계약 지문에서 제외한다. 같은 단계 구성을 승인한
/// 뒤에는 버전 표기만 달라도 다시 승인받게 만들 이유가 없다.
fn proposal_digest(contract: &SystemWorkflowContract) -> Result<String, CoreError> {
    let mut canonical = contract.clone();
    canonical.version = None;
    fingerprint(&serde_json::to_value(&canonical)?)
}

/// 승인 요약을 반환한 계약을 기억한다.
fn remember_proposal(digest: String) {
    let now = now_ms();
    let Ok(mut pending) = pending_proposals().lock() else {
        return;
    };
    pending.retain(|(known, seen_at)| *known != digest && now - *seen_at < PROPOSAL_TTL_MS);
    pending.push((digest, now));
    if pending.len() > MAX_PENDING_PROPOSALS {
        let remove = pending.len() - MAX_PENDING_PROPOSALS;
        pending.drain(..remove);
    }
}

/// 아직 유효한 승인 요약이 있는지 확인한다. 확인 기록은 지우지 않는다. 같은 계약을
/// 다시 등록해도 내용이 같아 새 버전만 쌓이고, 소비 방식으로 만들면 등록이 실패했을 때
/// 승인부터 다시 받아야 해서 실패 처리만 번거로워진다.
fn proposal_confirmed(digest: &str) -> bool {
    let now = now_ms();
    let Ok(mut pending) = pending_proposals().lock() else {
        return false;
    };
    pending.retain(|(_, seen_at)| now - *seen_at < PROPOSAL_TTL_MS);
    pending.iter().any(|(known, _)| known == digest)
}

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
        remember_proposal(proposal_digest(&contract)?);
        Ok(json!({
            "valid": true,
            "contract": contract,
            "computedRisk": validated.computed_risk,
            "requiredOperations": validated.required_operations,
            "approvalSummary": approval_summary(&contract, &validated),
        }))
    }

    /// 사용자가 승인한 계약을 새 버전으로 등록한다. 기존 버전은 덮어쓰지 않는다.
    /// 승인 화면을 건너뛴 등록을 막기 위해 같은 단계 구성으로 propose를 통과한
    /// 계약만 받는다.
    pub(crate) fn register(&self, contract: SystemWorkflowContract) -> Result<Value, CoreError> {
        let validated = validate_contract(&contract)?;
        if !proposal_confirmed(&proposal_digest(&contract)?) {
            return Err(CoreError::Conflict(
                "등록하려면 propose_system_workflow_schema로 같은 단계 구성의 승인 요약을 먼저 확인해야 합니다".to_owned(),
            ));
        }
        self.store_version(contract, &validated)
    }

    /// 검증을 마친 계약을 새 버전으로 저장한다. 승인 확인은 `register`가, 시스템 이관은
    /// `migrate_legacy_paced_contracts`가 각자 책임진다.
    fn store_version(
        &self,
        contract: SystemWorkflowContract,
        validated: &ValidatedContract,
    ) -> Result<Value, CoreError> {
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

    /// 워크플로마다 최신 버전의 페이싱 분류 근거. 예산 정책이 "페이싱 워크플로를 돌리는 반복
    /// 요청"을 소비자 후보로 고르고 화면이 페이싱 방식을 표시할 때 쓴다. 저장소를 한 번만
    /// 읽어 여러 판정이 같은 근거를 나눠 쓴다.
    pub(crate) fn workflow_pacing_facts(
        &self,
    ) -> Result<BTreeMap<String, WorkflowPacingFacts>, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            Ok(store
                .workflows
                .values()
                .filter_map(|workflow| {
                    workflow
                        .versions
                        .last()
                        .map(|latest| (workflow.id.clone(), WorkflowPacingFacts::of(latest)))
                })
                .collect())
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
            "expectedVersion": request.expected_version,
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
        let entry = if request.paced_run.is_some() {
            EntryShape::InEnvelope
        } else {
            EntryShape::Direct
        };
        let (version, inputs) = self.preflight(request, entry)?;
        let started_at = now_ms();
        let execution_id = format!("wfexec-{}", Uuid::new_v4().simple());
        let short_execution = execution_id.chars().take(19).collect::<String>();

        let mut results: BTreeMap<String, Value> = BTreeMap::new();
        let mut step_reports: Vec<Value> = Vec::new();
        let mut total_calls = 0usize;
        let mut failed_step: Option<(String, String, bool)> = None;

        for step in &version.contract.steps {
            let runner = StepRun {
                app_data_dir: &self.app_data_dir,
                invoker,
                workflow_id: &request.workflow_id,
                trigger: request.trigger.as_ref(),
                step,
                inputs: &inputs,
                execution_id: &short_execution,
                round_execution_id: request.round_execution_id.as_deref(),
                run: request.paced_run.as_ref(),
                mutating: crate::system_mcp::system_operation_kind(&step.operation)
                    .unwrap_or(false),
            };
            let mut tally = StepTally::default();
            let outcome = runner.run(&results, &mut total_calls, &mut tally);
            let (status, error) = match &outcome {
                Ok(Some(_)) => ("succeeded", None),
                Ok(None) => ("skipped", None),
                Err((error, _)) => ("failed", Some(error.as_str())),
            };
            step_reports.push(executed_step_report(step, status, &tally, error));
            match outcome {
                Ok(value) => {
                    results.insert(step.id.clone(), value.unwrap_or(Value::Null));
                }
                Err((error, retryable)) => {
                    failed_step = Some((step.id.clone(), error, retryable));
                    break;
                }
            }
        }
        let finished_at = now_ms();
        let succeeded = failed_step.is_none();
        let (failed_step_id, failure, retryable) = failure_fields(failed_step.as_ref());
        let receipt = json!({
            "workflowId": request.workflow_id,
            "version": version.version,
            "executionId": execution_id,
            "startedAt": started_at,
            "finishedAt": finished_at,
            "succeeded": succeeded,
            "failedStepId": failed_step_id,
            "failure": failure,
            "retryable": retryable,
            "steps": step_reports,
        });
        self.record_last_execution(
            &request.workflow_id,
            execution_summary(&receipt, version.version),
        );
        Ok(receipt)
    }

    /// 페이싱 회차 계약(`paced`)을 봉투로 돌린다: 사용량 갱신 → 기동 수 계산(이 회차의 예약
    /// 기록) → 지난 회차 정리 → 계획된 건마다 계약을 한 번씩 내부 실행 → 재갱신. 부수 작업은
    /// 모두 같은 invoker로 system operation을 부르므로 감사·권한·출처가 단계 실행과 같다.
    /// 한 건의 기동이 실패해도 나머지 건은 계속 띄운다 — forEach 단계였을 때는 첫 실패에서
    /// 회차 전체가 멈췄다.
    pub(crate) fn execute_paced_round(
        &self,
        request: WorkflowExecuteRequest,
        options: PacedRoundOptions,
        invoker: &WorkflowInvoker<'_>,
    ) -> Result<Value, CoreError> {
        validate_idempotency_key(&request.idempotency_key)?;
        let request_hash = fingerprint(&json!({
            "workflowId": request.workflow_id,
            "arguments": request.arguments,
            "expectedVersion": request.expected_version,
            "pacedRound": {"maxRuns": options.max_runs},
            "manualRun": request.manual_run,
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
        let result = self.execute_paced_round_claimed(&request, options, invoker);
        complete_idempotency(
            &self.app_data_dir,
            &key_hash,
            result.as_ref().ok().cloned(),
            result.is_ok(),
        )?;
        result
    }

    fn execute_paced_round_claimed(
        &self,
        request: &WorkflowExecuteRequest,
        options: PacedRoundOptions,
        invoker: &WorkflowInvoker<'_>,
    ) -> Result<Value, CoreError> {
        let (version, inputs, project_path) = self.paced_round_preflight(request, options)?;
        let started_at = now_ms();
        let round_id = format!("wfround-{}", Uuid::new_v4().simple());
        let short_round = round_id.chars().take(20).collect::<String>();
        let site = WorkflowCallSite {
            workflow_id: &request.workflow_id,
            execution_id: &short_round,
            trigger: request.trigger.as_ref(),
            round_execution_id: None,
        };
        let mut round = PacedRoundProgress::default();

        // 1. 갱신 → 2. 계산. 계산이 실패하면 기동할 목록 자체가 없다.
        let mut plan = self.plan_paced_round(
            invoker,
            &site,
            request,
            &inputs,
            &project_path,
            options,
            &mut round,
        );
        if let Some(plan) = &mut plan {
            // 3. 정리. 정리 실패는 기동을 막지 않는다.
            self.stop_stale_paced_runs(invoker, &site, plan, &mut round);
            // 4. 기동. 계획된 건마다 계약을 한 번씩 내부 실행한다.
            let planned = planned_paced_runs(plan, request, &inputs, &project_path, &mut round);
            for (index, run) in planned.iter().enumerate() {
                self.launch_paced_run(request, &short_round, run, index, invoker, &mut round);
            }
            // 5. 재갱신. 기동 직후의 표본이 실행별 회당 소비 실측의 앞 괄호가 된다.
            if round.launched > 0 {
                let _ = envelope_call(
                    &self.app_data_dir,
                    invoker,
                    &site,
                    "refresh-after",
                    "refresh_provider_account_usages",
                    json!({}),
                    &mut round.steps,
                );
            }
        }
        let receipt = paced_round_receipt(
            request,
            version.version,
            &round_id,
            started_at,
            now_ms(),
            options,
            plan.as_ref(),
            round,
        );
        self.record_last_execution(
            &request.workflow_id,
            execution_summary(&receipt, version.version),
        );
        Ok(receipt)
    }

    /// 봉투를 두르기 전에 계약과 입력을 확인한다. 여기서 걸리는 회차는 갱신도 예약도 남기지
    /// 않으므로, 회차를 시작하기 전에 볼 수 있는 조건은 모두 여기 모은다.
    /// 실행 진입에서 매번 같은 순서로 보는 것: 최신 판 → 기대 판 대조 → 봉투와 계약 모양이
    /// 맞는지 → 카탈로그 호환 → 입력 검증. 검사 순서가 곧 오류 우선순위라 진입 경로마다
    /// 따로 적으면 같은 입력에 다른 오류가 나온다.
    fn preflight(
        &self,
        request: &WorkflowExecuteRequest,
        entry: EntryShape,
    ) -> Result<(StoredWorkflowVersion, BTreeMap<String, Value>), CoreError> {
        let version = self.latest_version(&request.workflow_id)?;
        ensure_expected_version(&version, request.expected_version)?;
        if let Some(message) = entry.rejection(version.contract.paced) {
            return Err(CoreError::InvalidInput(message.to_owned()));
        }
        ensure_catalog_compatible(&version)?;
        let inputs = validate_inputs(&version.contract, &request.arguments)?;
        Ok((version, inputs))
    }

    fn paced_round_preflight(
        &self,
        request: &WorkflowExecuteRequest,
        options: PacedRoundOptions,
    ) -> Result<(StoredWorkflowVersion, BTreeMap<String, Value>, String), CoreError> {
        let (version, inputs) = self.preflight(request, EntryShape::PacedRound)?;
        if options.max_runs == 0 {
            return Err(CoreError::InvalidInput(
                "병렬 실행 건수는 1 이상이어야 합니다".to_owned(),
            ));
        }
        // 빈 경로로 계산까지 가면 예약만 남고 기동은 전부 실패해 다른 소비자의 여유를 갉아먹는다.
        let project_path = inputs
            .get(PACED_PROJECT_PATH_INPUT)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                CoreError::InvalidInput(
                    "무인 런타임을 띄울 경로(projectPath)가 비어 있어 회차를 돌리지 않습니다"
                        .to_owned(),
                )
            })?
            .to_owned();
        Ok((version, inputs, project_path))
    }

    /// 1. 갱신 → 2. 계산. 갱신은 실패해도 마지막 표본으로 계산을 이어가므로 삼키고, 계산은
    ///    디스패처가 출처(회차 실행 id·반복 요청)로 소비자와 예약을 기록한다.
    #[allow(clippy::too_many_arguments)]
    fn plan_paced_round(
        &self,
        invoker: &WorkflowInvoker<'_>,
        site: &WorkflowCallSite<'_>,
        request: &WorkflowExecuteRequest,
        inputs: &BTreeMap<String, Value>,
        project_path: &str,
        options: PacedRoundOptions,
        round: &mut PacedRoundProgress,
    ) -> Option<Value> {
        let _ = envelope_call(
            &self.app_data_dir,
            invoker,
            site,
            "refresh",
            "refresh_provider_account_usages",
            json!({}),
            &mut round.steps,
        );
        self.redeem_drained_windows(invoker, site, round);
        let mut plan_request = json!({
            "cadenceWorkflowId": request.workflow_id,
            "projectPath": project_path,
            "maxRuns": options.max_runs,
        });
        for name in PACED_MODEL_INPUTS {
            if let Some(model) = inputs.get(*name) {
                plan_request[*name] = model.clone();
            }
        }
        match envelope_call(
            &self.app_data_dir,
            invoker,
            site,
            "plan",
            "plan_usage_paced_runs",
            json!({"request": plan_request}),
            &mut round.steps,
        ) {
            Ok(plan) => Some(plan),
            Err((error, retryable)) => {
                first_failure(&mut round.failure, "plan", error, retryable);
                None
            }
        }
    }

    /// 2.5. 소진 모드에서 더 비울 수 없는 계정의 한도를 리셋 크레딧으로 되돌린다.
    ///
    /// 소진 모드가 꺼져 있으면 아무것도 하지 않는다. 켜져 있으면 갱신 직후의 사용량으로
    /// 계획 창을 비울 수 있는 만큼 비운 계정을 찾아 크레딧을 한 장 쓴다. 판정 기준은
    /// 정책 목표가 아니라 "남은 여유가 회당 소비보다 작은지"다
    /// ([`crate::usage_pacing::drain_redeem_ready`]) — 소진 중인 계정은 목표를 100%로 보고
    /// 돌기 때문에 목표를 기준으로 삼으면 되돌릴 시점을 놓친다. 어느 창을 되돌릴 수 있는지의
    /// 최종 판정은 공급자가 하므로(`nothingToReset`이면 크레딧이 그대로 남는다) 여기서는
    /// 시도까지만 한다 — 판정을 흉내 내다 틀리면 쓸 수 있는 크레딧을 놀리게 된다.
    ///
    /// 성공하면 사용량이 0으로 돌아가므로 곧바로 다시 갱신해, 이어지는 계산이 비워진 창을
    /// 보고 이번 회차부터 다시 채우게 한다. 실패는 회차를 멈추지 않는다 — 크레딧은 있으면
    /// 좋은 것이지 회차의 전제가 아니다.
    fn redeem_drained_windows(
        &self,
        invoker: &WorkflowInvoker<'_>,
        site: &WorkflowCallSite<'_>,
        round: &mut PacedRoundProgress,
    ) {
        let Ok(Some(policy)) = crate::usage_budget_policy::load_optional(&self.app_data_dir) else {
            return;
        };
        if !policy.defaults.drain {
            return;
        }
        let Ok(snapshot) = envelope_call(
            &self.app_data_dir,
            invoker,
            site,
            "drain-read",
            "get_provider_accounts",
            json!({}),
            &mut round.steps,
        ) else {
            return;
        };
        let window_label = policy.defaults.window_label.as_deref().unwrap_or("7일");
        let candidates = snapshot
            .get("accounts")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|account| {
                let id = account.get("id")?.as_str()?;
                if !policy
                    .accounts
                    .get(id)
                    .is_some_and(|config| config.pacing_enabled)
                {
                    return None;
                }
                let usage = account.get("usage")?;
                // 예비 장수까지는 자동으로 쓰지 않는다. 남은 장수가 거기에 닿았으면 되돌릴
                // 수단이 없는 것과 같아 소진 모드 자체가 걸리지 않는 계정이다.
                if usage
                    .get("resetCredits")?
                    .get("availableCount")?
                    .as_u64()
                    .unwrap_or(0)
                    <= u64::from(policy.defaults.drain_reserve())
                {
                    return None;
                }
                let used = usage
                    .get("windows")?
                    .as_array()?
                    .iter()
                    .find(|window| {
                        window.get("label").and_then(Value::as_str) == Some(window_label)
                    })
                    .and_then(|window| window.get("usedPercent")?.as_f64())?;
                Some((id.to_owned(), used))
            })
            .collect::<Vec<_>>();
        let drained =
            crate::usage_pacing::drain_redeem_ready(&self.app_data_dir, window_label, &candidates);
        if drained.is_empty() {
            return;
        }
        let mut reset = false;
        for (index, account_id) in drained.iter().enumerate() {
            if let Ok(result) = envelope_call(
                &self.app_data_dir,
                invoker,
                site,
                &format!("drain-{}", index + 1),
                "consume_account_reset_credit",
                json!({"accountId": account_id}),
                &mut round.steps,
            ) {
                reset |= result.get("outcome").and_then(Value::as_str) == Some("reset");
            }
        }
        if reset {
            let _ = envelope_call(
                &self.app_data_dir,
                invoker,
                site,
                "drain-refresh",
                "refresh_provider_account_usages",
                json!({}),
                &mut round.steps,
            );
        }
    }

    /// 3. 정리. 지난 회차가 남긴 채팅을 멈춘다. 멈추지 못한 건은 단계 행으로만 남기고 이번
    ///    회차의 기동은 그대로 진행한다.
    fn stop_stale_paced_runs(
        &self,
        invoker: &WorkflowInvoker<'_>,
        site: &WorkflowCallSite<'_>,
        plan: &Value,
        round: &mut PacedRoundProgress,
    ) {
        let stale = plan["staleRuns"].as_array().cloned().unwrap_or_default();
        round.stale = stale.len();
        for (index, stale_run) in stale.iter().enumerate() {
            let _ = envelope_call(
                &self.app_data_dir,
                invoker,
                site,
                &format!("stop-{}", index + 1),
                "stop_chat",
                json!({"chatId": stale_run["chatId"]}),
                &mut round.steps,
            );
        }
    }

    /// 4. 기동. 계획된 한 건을 계약의 내부 실행으로 띄운다. 내부 실행은 고유한 실행 id(단계
    ///    멱등 키가 겹치지 않게)를 갖고, 채팅 출처에는 회차 실행 id가 실린다. 한 건이
    ///    실패해도 첫 실패로만 남기고 나머지 건은 계속 띄운다.
    fn launch_paced_run(
        &self,
        request: &WorkflowExecuteRequest,
        round_execution_id: &str,
        run: &Value,
        index: usize,
        invoker: &WorkflowInvoker<'_>,
        round: &mut PacedRoundProgress,
    ) {
        let step_id = format!("run-{}", index + 1);
        let inner = WorkflowExecuteRequest {
            workflow_id: request.workflow_id.clone(),
            arguments: request.arguments.clone(),
            idempotency_key: format!("{}-run-{}", request.idempotency_key, index + 1),
            expected_version: request.expected_version,
            trigger: request.trigger.clone(),
            manual_run: false,
            paced_run: Some(run.clone()),
            round_execution_id: Some(round_execution_id.to_owned()),
        };
        let changed_targets: Vec<String> = run["accountId"]
            .as_str()
            .map(|account| vec![account.to_owned()])
            .unwrap_or_default();
        let mut report = match self.execute(inner, invoker) {
            Ok(receipt) => {
                let succeeded = receipt["succeeded"].as_bool().unwrap_or(false);
                if succeeded {
                    round.launched += 1;
                } else {
                    first_failure(
                        &mut round.failure,
                        &step_id,
                        receipt["failure"]
                            .as_str()
                            .unwrap_or("내부 실행이 실패했습니다")
                            .to_owned(),
                        receipt["retryable"].as_bool().unwrap_or(false),
                    );
                }
                let mut report = step_report(
                    &step_id,
                    "execute_paced_run",
                    if succeeded { "succeeded" } else { "failed" },
                    receipt["failure"].as_str().map(str::to_owned),
                    changed_targets,
                );
                report["executionId"] = receipt["executionId"].clone();
                report
            }
            Err(error) => {
                let (message, retryable) = classify_failure(&error);
                first_failure(&mut round.failure, &step_id, message.clone(), retryable);
                step_report(
                    &step_id,
                    "execute_paced_run",
                    "failed",
                    Some(message),
                    changed_targets,
                )
            }
        };
        report["accountId"] = run["accountId"].clone();
        round.steps.push(report);
    }

    /// 최신 버전 계약이 페이싱 회차 계약(`paced`)인지.
    pub(crate) fn is_paced(&self, workflow_id: &str) -> Result<bool, CoreError> {
        Ok(self.latest_version(workflow_id)?.contract.paced)
    }

    /// 5단계 페이싱 계약(갱신·계산·정리·기동·재갱신)을 회차 봉투 계약으로 현행화한다. 최신
    /// 버전이 계산 단계를 부르는 워크플로마다 기동 단계(plannedRuns 반복)만 남기고 `$item`을
    /// `$run`으로 바꾼 `paced` 버전을 새로 쌓는다. 입력 maxRuns는 반복 요청의 병렬 실행
    /// 설정으로 옮겨 가므로 뺀다. 변환할 수 없는 계약은 건너뛰고 사유와 함께 돌려준다.
    /// 두 번 돌려도 이미 이관된 워크플로는 더 쌓지 않는다.
    pub(crate) fn migrate_legacy_paced_contracts(
        &self,
    ) -> Result<PacedMigrationOutcome, CoreError> {
        let legacy: Vec<(u32, SystemWorkflowContract)> = self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            Ok(store
                .workflows
                .values()
                .filter_map(|workflow| workflow.versions.last())
                .filter(|latest| {
                    !latest.contract.paced && uses_envelope_operation(&latest.contract)
                })
                .map(|latest| (latest.version, latest.contract.clone()))
                .collect())
        })?;
        let mut migrated = Vec::new();
        let mut skipped = Vec::new();
        for (legacy_version, contract) in legacy {
            let id = contract.id.clone();
            let outcome = paced_contract_from_legacy(&contract).and_then(|(paced, default)| {
                let validated = validate_contract(&paced)?;
                let receipt = self.store_version(paced, &validated)?;
                Ok(MigratedPacedWorkflow {
                    workflow_id: id.clone(),
                    version: receipt["version"].as_u64().unwrap_or_default() as u32,
                    legacy_version,
                    legacy_max_runs_default: default,
                })
            });
            match outcome {
                Ok(result) => migrated.push(result),
                Err(error) => skipped.push((id, error.to_string())),
            }
        }
        Ok((migrated, skipped))
    }

    /// 회차 봉투 계약으로 이관됐지만 반복 요청이 아직 옛 버전에 묶여 있을 수 있는 워크플로.
    /// 최신 버전이 paced이고 그보다 낮은 버전 중 계산 단계를 부르던 것마다 하나씩 낸다. 계약
    /// 저장소와 반복 요청 저장소를 한 번에 바꿀 수 없으므로 기동마다 다시 확인해, 앞선 기동에서
    /// 계약만 옮기고 반복 요청 갱신이 실패했어도 다음 기동이 마무리한다.
    pub(crate) fn pending_paced_binding_migrations(
        &self,
    ) -> Result<Vec<MigratedPacedWorkflow>, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            let mut pending = Vec::new();
            for workflow in store.workflows.values() {
                let Some(latest) = workflow
                    .versions
                    .last()
                    .filter(|latest| latest.contract.paced)
                else {
                    continue;
                };
                for legacy in workflow.versions.iter().filter(|version| {
                    version.version < latest.version && uses_envelope_operation(&version.contract)
                }) {
                    pending.push(MigratedPacedWorkflow {
                        workflow_id: workflow.id.clone(),
                        version: latest.version,
                        legacy_version: legacy.version,
                        legacy_max_runs_default: legacy_max_runs_default(&legacy.contract),
                    });
                }
            }
            Ok(pending)
        })
    }

    fn latest_version(&self, workflow_id: &str) -> Result<StoredWorkflowVersion, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            let workflow = store.workflows.get(workflow_id).ok_or_else(|| {
                CoreError::NotFound(format!(
                    "등록된 워크플로 {workflow_id}을(를) 찾을 수 없습니다"
                ))
            })?;
            workflow
                .versions
                .last()
                .cloned()
                .ok_or_else(|| CoreError::Runtime("워크플로 버전 정보가 손상되었습니다".to_owned()))
        })
    }

    /// 최근 실행 요약은 인자·결과 원문 없이 상태만 저장한다. 저장 실패는 실행 결과를 바꾸지
    /// 않는다.
    fn record_last_execution(&self, workflow_id: &str, summary: WorkflowExecutionSummary) {
        let _ = self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            if let Some(workflow) = store.workflows.get_mut(workflow_id) {
                workflow.last_execution = Some(summary);
                self.save_store_unlocked(&store)?;
            }
            Ok(())
        });
    }

    fn with_store_lock<T>(
        &self,
        action: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        STORE.with_lock(&self.app_data_dir, action)
    }

    fn load_store_unlocked(&self) -> Result<WorkflowStore, CoreError> {
        STORE.load_unlocked(&self.app_data_dir)
    }

    fn save_store_unlocked(&self, store: &WorkflowStore) -> Result<(), CoreError> {
        STORE.save_unlocked(&self.app_data_dir, store)
    }
}

fn ensure_expected_version(
    version: &StoredWorkflowVersion,
    expected: Option<u32>,
) -> Result<(), CoreError> {
    if expected.is_some_and(|expected| expected != version.version) {
        return Err(CoreError::Conflict(format!(
            "워크플로 버전이 승인 후 변경되었습니다. 현재 버전 {}, 승인 버전 {}",
            version.version,
            expected.unwrap_or_default()
        )));
    }
    Ok(())
}

/// 기본 작업 계약이 바뀐 워크플로는 재검증 전에는 실행하지 않는다.
fn ensure_catalog_compatible(version: &StoredWorkflowVersion) -> Result<(), CoreError> {
    if let Err(error) = validate_contract(&version.contract) {
        return Err(CoreError::Conflict(format!(
            "워크플로가 현재 system_catalog와 호환되지 않아 실행할 수 없습니다. 재등록이 필요합니다: {error}"
        )));
    }
    Ok(())
}

/// 페이싱 계산이 0건을 낸 수동 회차에 쓸 한 건. 계산 응답의 계정 목록은 이미 이
/// 워크플로에 설정된 공급자·계정 범위로 좁혀져 있으므로 첫 항목만 택한다. `skipReason`은
/// 의도적으로 보지 않는다 — 지금 실행은 목표·가드·예약 판정을 우회하고, 실제 실행 가능
/// 여부는 일반 `start_chat`과 공급자 CLI가 판단한다.
fn manual_paced_run(
    plan: &Value,
    inputs: &BTreeMap<String, Value>,
    project_path: &str,
) -> Option<Value> {
    let account = plan["accounts"].as_array()?.first()?;
    let account_id = account["accountId"].as_str()?.trim();
    let source = account["provider"].as_str()?.trim();
    if account_id.is_empty() || source.is_empty() {
        return None;
    }
    let model = match source {
        "claude" => inputs.get("claudeModel"),
        "codex" => inputs.get("codexModel"),
        "antigravity" => inputs.get("antigravityModel"),
        _ => None,
    }
    .cloned()
    .unwrap_or(Value::Null);
    // 수동 실행은 여력 판정을 거치지 않으므로 추론수준도 판단 불가일 때의 기본 수준이다.
    let reasoning_effort = crate::domain::ProviderId::ALL
        .into_iter()
        .find(|provider| provider.as_str() == source)
        .map(crate::usage_pacing::default_paced_reasoning_effort);
    Some(json!({
        "index": 1,
        "accountId": account_id,
        "source": source,
        "model": model,
        "cwd": project_path,
        "reasoningEffort": reasoning_effort,
    }))
}
/// 회차가 도는 동안 봉투가 쌓는 값. 단계 행과 첫 실패, 그리고 영수증의 `round` 블록이
/// 읽는 집계다. 계산이 실패해 기동까지 가지 못한 회차는 기본값 그대로 영수증에 실린다.
#[derive(Default)]
struct PacedRoundProgress {
    steps: Vec<Value>,
    failure: Option<(String, String, bool)>,
    launched: usize,
    planned: usize,
    stale: usize,
    manual_override: bool,
}

/// 기동에 넘길 목록. 계획이 0건인데 사용자가 `지금 실행`을 눌렀으면 페이싱에 등록되지 않은
/// 워크플로의 수동 실행처럼 한 건을 실행한다. 계정 범위만 회차 설정에서 가져오고, 사용량·
/// 목표·가드·미정산 예약·회당 상한 같은 계획 판정은 다시 적용하지 않는다. 실제 공급자
/// 리밋이나 인증 실패는 start_chat/CLI의 일반 실행 결과로 드러난다.
fn planned_paced_runs(
    plan: &mut Value,
    request: &WorkflowExecuteRequest,
    inputs: &BTreeMap<String, Value>,
    project_path: &str,
    round: &mut PacedRoundProgress,
) -> Vec<Value> {
    let mut planned = plan["plannedRuns"].as_array().cloned().unwrap_or_default();
    if planned.is_empty() && request.manual_run {
        if let Some(run) = manual_paced_run(plan, inputs, project_path) {
            planned.push(run);
            round.manual_override = true;
            let reason = Value::String(
                "사용자가 지금 실행을 요청해 페이싱 계획 0건을 일반 수동 실행 1건으로 처리했습니다"
                    .to_owned(),
            );
            if let Some(reasoning) = plan["reasoning"].as_array_mut() {
                reasoning.push(reason);
            } else {
                plan["reasoning"] = Value::Array(vec![reason]);
            }
        }
    }
    round.planned = planned.len();
    planned
}

/// 회차 영수증. `round` 블록은 봉투가 센 집계고, `steps`는 봉투 단계 행과 내부 실행 행이다.
#[allow(clippy::too_many_arguments)]
fn paced_round_receipt(
    request: &WorkflowExecuteRequest,
    version: u32,
    round_id: &str,
    started_at: i64,
    finished_at: i64,
    options: PacedRoundOptions,
    plan: Option<&Value>,
    round: PacedRoundProgress,
) -> Value {
    let succeeded = round.failure.is_none();
    let (failed_step_id, failure, retryable) = failure_fields(round.failure.as_ref());
    json!({
        "workflowId": request.workflow_id,
        "version": version,
        "executionId": round_id,
        "paced": true,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "succeeded": succeeded,
        "failedStepId": failed_step_id,
        "failure": failure,
        "retryable": retryable,
        "round": {
            "maxRuns": options.max_runs,
            "plannedRuns": round.planned,
            "launchedRuns": round.launched,
            "staleRuns": round.stale,
            "manualOverride": round.manual_override,
            "consumerId": plan.and_then(|plan| plan.get("consumerId")).cloned(),
            "reasoning": plan.and_then(|plan| plan.get("reasoning")).cloned(),
        },
        "steps": round.steps,
    })
}

/// 영수증의 실패 세 칸(단계 id·사유·재시도 가능). 단계 실행과 회차 봉투 모두 첫 실패만
/// 기록하므로 같은 자리에서 편다.
fn failure_fields(
    failure: Option<&(String, String, bool)>,
) -> (Option<String>, Option<String>, bool) {
    (
        failure.map(|(step, _, _)| step.clone()),
        failure.map(|(_, error, _)| error.clone()),
        failure.is_some_and(|(_, _, retryable)| *retryable),
    )
}

/// 최근 실행 요약은 인자·결과 원문 없이 상태만 저장한다. 단계 실행과 회차 봉투가 같은
/// 영수증 모양을 내므로 요약도 영수증 한 곳에서 읽는다.
fn execution_summary(receipt: &Value, version: u32) -> WorkflowExecutionSummary {
    WorkflowExecutionSummary {
        execution_id: receipt["executionId"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        version,
        started_at: receipt["startedAt"].as_i64().unwrap_or_default(),
        finished_at: receipt["finishedAt"].as_i64().unwrap_or_default(),
        succeeded: receipt["succeeded"].as_bool().unwrap_or(false),
        failed_step_id: receipt["failedStepId"].as_str().map(str::to_owned),
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
    }
}

fn first_failure(
    slot: &mut Option<(String, String, bool)>,
    step: &str,
    error: String,
    retryable: bool,
) {
    if slot.is_none() {
        *slot = Some((step.to_owned(), error, retryable));
    }
}

/// 실행 진입이 놓인 자리. 페이싱 회차 계약(`paced`)과 회차 봉투는 짝이어야 하지만,
/// 어느 쪽이 없을 때 거절하는지는 진입 경로마다 반대다.
#[derive(Clone, Copy)]
enum EntryShape {
    /// 봉투 없는 직접 실행. `paced` 계약은 여기로 들어올 수 없다.
    Direct,
    /// 봉투를 두르러 들어온 회차. `paced` 계약이 아니면 두를 것이 없다.
    PacedRound,
    /// 봉투가 이미 정한 회차 안에서 도는 계약. 진입에서 다시 따지지 않는다.
    InEnvelope,
}

impl EntryShape {
    fn rejection(self, paced: bool) -> Option<&'static str> {
        match (self, paced) {
            (Self::Direct, true) => Some(
                "페이싱 회차 계약은 회차 봉투 안에서만 실행됩니다 — 반복 요청(회차)으로 돌리거나 execute_system_workflow가 봉투를 두릅니다",
            ),
            (Self::PacedRound, false) => {
                Some("이 워크플로는 페이싱 회차 계약(paced)이 아니라 봉투 없이 실행합니다")
            }
            _ => None,
        }
    }
}

/// 단계 하나가 남긴 셈. forEach 여부와 무관하게 단계 행이 같은 칸을 채운다.
#[derive(Default)]
struct StepTally {
    /// 실제로 작업을 부른 횟수. 조건에 걸려 건너뛴 회는 세지 않는다.
    iterations: usize,
    /// forEach 반복 중 조건에 걸려 건너뛴 항목 수.
    skipped_items: usize,
    changed_targets: Vec<String>,
}

/// 단계 하나를 도는 동안 바뀌지 않는 것들. forEach 반복에서 매번 달라지는 값은
/// `item`·`iteration`뿐이라 나머지는 여기 한 번만 묶는다.
struct StepRun<'a> {
    app_data_dir: &'a Path,
    invoker: &'a WorkflowInvoker<'a>,
    workflow_id: &'a str,
    trigger: Option<&'a WorkflowTrigger>,
    step: &'a WorkflowStep,
    inputs: &'a BTreeMap<String, Value>,
    execution_id: &'a str,
    round_execution_id: Option<&'a str>,
    run: Option<&'a Value>,
    mutating: bool,
}

impl StepRun<'_> {
    /// 단계 하나를 끝까지 돈다. forEach가 없으면 한 번, 있으면 대상 항목마다 한 번씩
    /// [`Self::attempt`]를 부르고 셈을 `tally`에 모은다. forEach 단계는 항목이 모두
    /// 건너뛰어져도 목록(빈 배열)을 남기므로 뒤 단계가 참조를 잃지 않는다.
    fn run(
        &self,
        results: &BTreeMap<String, Value>,
        total_calls: &mut usize,
        tally: &mut StepTally,
    ) -> Result<Option<Value>, (String, bool)> {
        let Some(for_each) = &self.step.for_each else {
            let value = self.attempt(results, None, 0, total_calls, &mut tally.changed_targets)?;
            tally.iterations = usize::from(value.is_some());
            return Ok(value);
        };
        let items = self.for_each_items(results, for_each)?;
        let mut collected = Vec::new();
        for (index, item) in items.iter().enumerate() {
            match self.attempt(
                results,
                Some(item),
                index,
                total_calls,
                &mut tally.changed_targets,
            )? {
                Some(value) => {
                    tally.iterations += 1;
                    collected.push(value);
                }
                None => tally.skipped_items += 1,
            }
        }
        Ok(Some(Value::Array(collected)))
    }

    /// forEach 대상 목록을 앞 단계 결과에서 뽑는다. 상한을 넘긴 목록은 한 번도 돌리지 않고
    /// 거절한다 — 절반만 돌고 멈추면 남은 항목이 다음 회차에 다시 들어온다.
    fn for_each_items(
        &self,
        results: &BTreeMap<String, Value>,
        for_each: &WorkflowForEach,
    ) -> Result<Vec<Value>, (String, bool)> {
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
        Ok(items)
    }

    /// 조건 → 작업 호출 → 기대값 확인을 한 벌로 돈다. 조건에 걸려 건너뛰면 `Ok(None)`,
    /// `whenFalse: fail`이면 오류다. 오류는 단계 행과 영수증이 같이 쓰는
    /// (메시지, 재시도 가능) 쌍으로 돌려준다.
    fn attempt(
        &self,
        results: &BTreeMap<String, Value>,
        item: Option<&Value>,
        iteration: usize,
        total_calls: &mut usize,
        changed_targets: &mut Vec<String>,
    ) -> Result<Option<Value>, (String, bool)> {
        let ctx = TemplateContext {
            inputs: self.inputs,
            results,
            item,
            run: self.run,
            execution_id: self.execution_id,
            round_execution_id: self.round_execution_id,
            step_id: &self.step.id,
            iteration,
        };
        match evaluate_condition(self.step.condition.as_ref(), &ctx) {
            Ok(true) => {}
            Ok(false) => {
                if self
                    .step
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
            self.app_data_dir,
            self.invoker,
            self.workflow_id,
            self.trigger,
            self.step,
            &ctx,
            self.mutating,
            total_calls,
            changed_targets,
        )
        .map_err(|error| classify_failure(&error))?;
        check_expectation(self.step.expect.as_ref(), &value)
            .map_err(|error| (error.to_string(), false))?;
        Ok(Some(value))
    }
}

/// 단계 실행 한 건의 보고 행. 성공·건너뜀·실패가 같은 칸을 채운다.
fn executed_step_report(
    step: &WorkflowStep,
    status: &str,
    tally: &StepTally,
    error: Option<&str>,
) -> Value {
    json!({
        "stepId": step.id,
        "operation": step.operation,
        "status": status,
        "iterations": tally.iterations,
        "skippedItems": tally.skipped_items,
        "changedTargets": tally.changed_targets,
        "error": error,
    })
}
fn step_report(
    step_id: &str,
    operation: &str,
    status: &str,
    error: Option<String>,
    changed_targets: Vec<String>,
) -> Value {
    json!({
        "stepId": step_id,
        "operation": operation,
        "status": status,
        "iterations": if status == "succeeded" { 1 } else { 0 },
        "skippedItems": 0,
        "changedTargets": changed_targets,
        "error": error,
    })
}

/// 봉투 단계 하나를 invoker로 부르고 단계 행을 남긴다. 변경 작업은 단계 실행과 같은 감사
/// 기록(시도·완료)을 남긴다.
fn envelope_call(
    app_data_dir: &Path,
    invoker: &WorkflowInvoker<'_>,
    site: &WorkflowCallSite<'_>,
    step_id: &str,
    operation: &str,
    arguments: Value,
    steps: &mut Vec<Value>,
) -> Result<Value, (String, bool)> {
    // 기동 수 계산은 카탈로그에 없는 봉투 전용 작업이지만 예약을 기록하므로 변경 작업으로
    // 감사에 남긴다.
    let mutating = crate::system_mcp::system_operation_kind(operation)
        .unwrap_or(operation == "plan_usage_paced_runs");
    let mut changed_targets = Vec::new();
    if mutating {
        collect_changed_targets(&arguments, &mut changed_targets);
        if let Err(error) = crate::append_system_audit(
            app_data_dir,
            operation,
            &arguments,
            SystemAuditPhase::Attempted,
            None,
        ) {
            let failure = classify_failure(&error);
            steps.push(step_report(
                step_id,
                operation,
                "failed",
                Some(failure.0.clone()),
                changed_targets,
            ));
            return Err(failure);
        }
    }
    let result = invoker(operation, arguments.clone(), site);
    if mutating {
        let _ = crate::append_system_audit(
            app_data_dir,
            operation,
            &arguments,
            SystemAuditPhase::Completed,
            Some(result.is_ok()),
        );
    }
    match result {
        Ok(value) => {
            steps.push(step_report(
                step_id,
                operation,
                "succeeded",
                None,
                changed_targets,
            ));
            Ok(value)
        }
        Err(error) => {
            let failure = classify_failure(&error);
            steps.push(step_report(
                step_id,
                operation,
                "failed",
                Some(failure.0.clone()),
                changed_targets,
            ));
            Err(failure)
        }
    }
}

fn uses_envelope_operation(contract: &SystemWorkflowContract) -> bool {
    contract
        .steps
        .iter()
        .any(|step| ENVELOPE_OPERATIONS.contains(&step.operation.as_str()))
}

/// 템플릿 어딘가에 `{"$run": field}`가 있는지.
fn template_references_run(value: &Value, field: &str) -> bool {
    match value {
        Value::Object(map) => {
            if map.len() == 1 && map.get("$run").and_then(Value::as_str) == Some(field) {
                return true;
            }
            map.values()
                .any(|value| template_references_run(value, field))
        }
        Value::Array(items) => items
            .iter()
            .any(|item| template_references_run(item, field)),
        _ => false,
    }
}

/// 템플릿 어딘가에 `{"$step": step, ...}`가 있는지.
fn template_references_step(value: &Value, step: &str) -> bool {
    match value {
        Value::Object(map) => {
            if map.get("$step").and_then(Value::as_str) == Some(step) {
                return true;
            }
            map.values()
                .any(|value| template_references_step(value, step))
        }
        Value::Array(items) => items
            .iter()
            .any(|item| template_references_step(item, step)),
        _ => false,
    }
}

/// `{"$item": path}`를 `{"$run": path}`로 바꾼다. 계산 단계의 plannedRuns 항목과 봉투가 넘기는
/// 값은 같은 이름(accountId·source·model·cwd·index·reasoningEffort)이다.
fn rewrite_item_to_run(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(path) = map.get("$item") {
                    return json!({"$run": path});
                }
            }
            Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), rewrite_item_to_run(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(rewrite_item_to_run).collect()),
        other => other.clone(),
    }
}

/// 레거시 5단계 계약에서 회차 봉투 계약을 만든다. 갱신·계산·정리 단계는 봉투의 몫이라
/// 빼고, 계산 결과 plannedRuns를 반복하던 기동 단계는 반복을 풀어 `$run`을 받게 한다.
/// 그 밖에 계산 결과를 참조하는 단계가 있으면 자동으로 옮길 수 없다.
/// 옛 계약의 `maxRuns` 입력 기본값.
fn legacy_max_runs_default(contract: &SystemWorkflowContract) -> Option<u32> {
    contract
        .input_schema
        .get("maxRuns")
        .and_then(|field| field.default_value.as_ref())
        .and_then(max_runs_from_value)
}

fn paced_contract_from_legacy(
    contract: &SystemWorkflowContract,
) -> Result<(SystemWorkflowContract, Option<u32>), CoreError> {
    let plan = contract
        .steps
        .iter()
        .find(|step| ENVELOPE_OPERATIONS.contains(&step.operation.as_str()))
        .ok_or_else(|| CoreError::InvalidInput("계산 단계가 없는 계약입니다".to_owned()))?;
    let plan_step = plan.id.clone();
    // 계산 요청 인자는 봉투가 대신 채우는 것(경로·모델은 같은 이름의 입력, maxRuns는 병렬
    // 설정)만 옮길 수 있다. 공급자·계정 필터나 창·목표처럼 봉투가 채우지 않는 값이 있으면
    // 조용히 넓어지거나 바뀌므로 자동 이관을 거절한다.
    let mut legacy_default = legacy_max_runs_default(contract);
    let request = plan
        .arguments
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CoreError::InvalidInput("계산 단계의 request 인자가 객체가 아닙니다".to_owned())
        })?;
    for (key, value) in request {
        let bound_input = value.get("$input").and_then(Value::as_str);
        match key.as_str() {
            "cadenceWorkflowId" => {}
            "projectPath" | "claudeModel" | "codexModel" | "antigravityModel" => {
                if bound_input != Some(key.as_str()) {
                    return Err(CoreError::InvalidInput(format!(
                        "계산 단계의 {key} 인자가 같은 이름의 입력을 참조하지 않아 자동으로 옮길 수 없습니다"
                    )));
                }
            }
            "maxRuns" => {
                if let Some(literal) = max_runs_from_value(value) {
                    legacy_default = Some(literal);
                } else if bound_input != Some("maxRuns") {
                    return Err(CoreError::InvalidInput(
                        "계산 단계의 maxRuns 인자를 병렬 실행 설정으로 옮길 수 없습니다".to_owned(),
                    ));
                }
            }
            other => {
                return Err(CoreError::InvalidInput(format!(
                    "계산 단계의 {other} 인자는 봉투가 채우지 않아 자동으로 옮길 수 없습니다"
                )))
            }
        }
    }
    let mut steps = Vec::new();
    let mut run_steps: BTreeSet<String> = BTreeSet::new();
    for step in &contract.steps {
        if step.id == plan_step || step.operation == "refresh_provider_account_usages" {
            continue;
        }
        let references_plan = |value: &Value| template_references_step(value, &plan_step);
        let condition_references_plan = step.condition.as_ref().is_some_and(|condition| {
            references_plan(&condition.left) || references_plan(&condition.equals)
        });
        if let Some(for_each) = &step.for_each {
            if for_each.step == plan_step {
                match for_each.path.as_str() {
                    "staleRuns" => continue,
                    "plannedRuns" => {
                        if references_plan(&step.arguments) || condition_references_plan {
                            return Err(CoreError::InvalidInput(format!(
                                "기동 단계 {}이(가) 계산 단계 결과를 참조해 자동으로 옮길 수 없습니다",
                                step.id
                            )));
                        }
                        let mut run_step = step.clone();
                        run_step.for_each = None;
                        run_step.arguments = rewrite_item_to_run(&step.arguments);
                        if let Some(condition) = run_step.condition.as_mut() {
                            condition.left = rewrite_item_to_run(&condition.left);
                            condition.equals = rewrite_item_to_run(&condition.equals);
                        }
                        run_steps.insert(step.id.clone());
                        steps.push(run_step);
                        continue;
                    }
                    other => {
                        return Err(CoreError::InvalidInput(format!(
                        "단계 {}이(가) 계산 결과 {other}을(를) 반복해 자동으로 옮길 수 없습니다",
                        step.id
                    )))
                    }
                }
            }
            // 기동 단계는 봉투 안에서 건마다 한 번 도는 단일 결과가 되므로, 그 결과를 목록으로
            // 반복하던 단계는 그대로 옮기면 실행마다 실패한다.
            if run_steps.contains(&for_each.step) {
                return Err(CoreError::InvalidInput(format!(
                    "단계 {}이(가) 기동 단계 결과를 반복해 자동으로 옮길 수 없습니다",
                    step.id
                )));
            }
        }
        let references_run = |value: &Value| {
            run_steps
                .iter()
                .any(|run| template_references_step(value, run))
        };
        let condition_references_run = step.condition.as_ref().is_some_and(|condition| {
            references_run(&condition.left) || references_run(&condition.equals)
        });
        if references_plan(&step.arguments)
            || condition_references_plan
            || references_run(&step.arguments)
            || condition_references_run
        {
            return Err(CoreError::InvalidInput(format!(
                "단계 {}이(가) 계산·기동 단계 결과를 참조해 자동으로 옮길 수 없습니다",
                step.id
            )));
        }
        steps.push(step.clone());
    }
    let mut input_schema = contract.input_schema.clone();
    for name in PACED_RESERVED_INPUTS {
        input_schema.remove(*name);
    }
    Ok((
        SystemWorkflowContract {
            id: contract.id.clone(),
            display_name: contract.display_name.clone(),
            description: contract.description.clone(),
            input_schema,
            steps,
            risk: contract.risk,
            version: None,
            paced: true,
        },
        legacy_default,
    ))
}

fn workflow_summary(workflow: &StoredWorkflow) -> Value {
    let latest = workflow.versions.last();
    let validated = latest.and_then(|version| validate_contract(&version.contract).ok());
    let compatible = validated.is_some();
    let contract_digest = latest.and_then(|version| {
        serde_json::to_value(&version.contract)
            .ok()
            .and_then(|contract| fingerprint(&contract).ok())
    });
    json!({
        "id": workflow.id,
        "displayName": latest.map(|v| v.contract.display_name.clone()),
        "description": latest.map(|v| v.contract.description.clone()),
        "version": latest.map(|v| v.version),
        "risk": latest.map(|v| v.contract.risk),
        "computedRisk": latest.map(|v| v.computed_risk),
        "requiredOperations": latest.map(|v| v.required_operations.clone()),
        "paced": latest.is_some_and(|v| v.contract.paced),
        "inputSchema": latest.and_then(|v| serde_json::to_value(&v.contract.input_schema).ok()),
        "compatible": compatible,
        "contractDigest": contract_digest,
        "hardToRecoverEffects": validated.map(|value| value.hard_to_recover_effects),
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
            "페이싱 회차 계약(paced: true) — 스케줄러가 갱신·계산·정리·N건 기동·재갱신 봉투를 두르고 계약은 한 건만 기술, 봉투가 정한 값은 $run(accountId·source·model·cwd·index·reasoningEffort)으로 받음",
            "enum·문자열·숫자·boolean 입력 검증",
            "입력 기본값 선언(defaultValue) — 화면이 미리 채우고 생략된 입력에 대신 쓰임",
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
            "동적 외부 플러그인 도구 호출",
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
        "paced": contract.paced,
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
///
/// 봉투 → 입력 스키마 → 단계 → 페이싱 규약 → 위험도 순서로 나뉘어 있고, 각 조각의 이름이 곧
/// 거절 사유의 분류다. 화면은 가장 먼저 걸린 사유 하나만 보여 주므로 순서는 바꾸지 않는다.
fn validate_contract(contract: &SystemWorkflowContract) -> Result<ValidatedContract, CoreError> {
    validate_contract_envelope(contract)?;
    validate_input_schema(&contract.input_schema)?;
    let scan = scan_steps(contract)?;
    if contract.paced {
        validate_paced_contract(contract)?;
    }
    let computed_risk = if scan.mutating_operations.is_empty() {
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
        required_operations: scan.required_operations.into_iter().collect(),
        mutating_operations: scan.mutating_operations.into_iter().collect(),
        hard_to_recover_effects: scan.hard_to_recover_effects.into_iter().collect(),
    })
}

/// 단계와 입력을 들여다보기 전에 걸러야 하는 것 — W4의 계약 크기·단계 수 한도와 식별자·설명.
fn validate_contract_envelope(contract: &SystemWorkflowContract) -> Result<(), CoreError> {
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
    Ok(())
}

fn validate_input_schema(
    input_schema: &BTreeMap<String, WorkflowInputField>,
) -> Result<(), CoreError> {
    if input_schema.len() > MAX_INPUT_FIELDS {
        return Err(CoreError::InvalidInput(format!(
            "입력 필드는 {MAX_INPUT_FIELDS}개 이하이어야 합니다"
        )));
    }
    for (name, field) in input_schema {
        validate_input_field(name, field)?;
    }
    Ok(())
}

fn validate_input_field(name: &str, field: &WorkflowInputField) -> Result<(), CoreError> {
    validate_identifier_loose(name, "입력 필드 이름")?;
    if let Some(label) = field.label.as_deref() {
        if label.trim().is_empty() {
            return Err(CoreError::InvalidInput(format!(
                "입력 {name}의 label이 비었습니다"
            )));
        }
        validate_text(label, 80, "입력 라벨")?;
    }
    if let Some(description) = field.description.as_deref() {
        validate_text(description, 200, "입력 설명")?;
    }
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
    // 기본값은 실행 인자와 같은 검증을 통과해야 한다. 등록 때 걸러 두지 않으면 화면이
    // 폼에 채운 값 그대로 실행을 눌렀을 때 실행 단계에서야 거절된다.
    if let Some(default) = field.default_value.as_ref() {
        if !input_value_matches(field, default) {
            return Err(CoreError::InvalidInput(format!(
                "입력 {name}의 defaultValue가 선언된 형식과 다릅니다"
            )));
        }
    }
    Ok(())
}

/// 단계 검증이 훑어 모은 것. 위험도 계산과 승인 화면이 같은 값을 본다.
#[derive(Default)]
struct StepScan {
    required_operations: BTreeSet<String>,
    mutating_operations: BTreeSet<String>,
    hard_to_recover_effects: BTreeSet<String>,
}

/// 단계를 선언 순서대로 검증하면서 승인 화면이 보여 줄 작업 목록을 모은다. 앞선 단계만
/// 참조할 수 있으므로 `prior_steps`는 지금 단계를 넣기 **전** 상태로 넘어간다.
fn scan_steps(contract: &SystemWorkflowContract) -> Result<StepScan, CoreError> {
    let mut seen_steps: BTreeSet<&str> = BTreeSet::new();
    let mut prior_steps: BTreeSet<&str> = BTreeSet::new();
    let mut scan = StepScan::default();
    for step in &contract.steps {
        validate_identifier_loose(&step.id, "단계 id")?;
        if !seen_steps.insert(step.id.as_str()) {
            return Err(CoreError::InvalidInput(format!(
                "단계 id {}이(가) 중복되었습니다",
                step.id
            )));
        }
        let mutating = validate_step_operation(&step.operation)?;
        scan.required_operations.insert(step.operation.clone());
        if mutating {
            scan.mutating_operations.insert(step.operation.clone());
        }
        if let Some(effect) = hard_to_recover_effect(&step.operation) {
            scan.hard_to_recover_effects.insert(effect.to_owned());
        }
        let in_for_each = validate_step_for_each(step, &prior_steps)?;
        validate_step_templates(step, contract, &prior_steps, in_for_each)?;
        prior_steps.insert(step.id.as_str());
    }
    Ok(scan)
}

/// 단계가 부를 수 있는 작업인지 본다(W1·W2). 반환값은 그 작업이 변경 작업인지 여부다.
fn validate_step_operation(operation: &str) -> Result<bool, CoreError> {
    if FORBIDDEN_STEP_OPERATIONS.contains(&operation) {
        return Err(CoreError::InvalidInput(format!(
            "워크플로 단계에서 {operation} 작업은 호출할 수 없습니다"
        )));
    }
    // 계산·예약은 회차 봉투의 몫이다. 계약이 단계로 부르면 봉투와 이중으로 예약이 남고,
    // 봉투 없는 계약이 부르면 5단계 복제가 되살아난다. 카탈로그에도 없어 AIA도 못 부른다.
    if ENVELOPE_OPERATIONS.contains(&operation) {
        return Err(CoreError::InvalidInput(format!(
            "{operation}은(는) 워크플로 단계로 부르지 않습니다. 계약에 paced: true를 선언하면 회차 봉투가 사용량 갱신·기동 수 계산·지난 회차 정리·기동을 대신합니다"
        )));
    }
    crate::system_mcp::system_operation_kind(operation).ok_or_else(|| {
        CoreError::InvalidInput(format!("system_catalog에 없는 작업입니다: {operation}"))
    })
}

/// W3 — 되돌리기 어려운 작업이 승인 화면에 실어야 할 문구.
fn hard_to_recover_effect(operation: &str) -> Option<&'static str> {
    HARD_TO_RECOVER_OPERATIONS
        .iter()
        .find(|(candidate, _)| *candidate == operation)
        .map(|(_, effect)| *effect)
}

/// forEach 선언을 검증하고, 이 단계가 반복 안에서 도는지 알려 준다.
fn validate_step_for_each(
    step: &WorkflowStep,
    prior_steps: &BTreeSet<&str>,
) -> Result<bool, CoreError> {
    let Some(for_each) = &step.for_each else {
        return Ok(false);
    };
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
    Ok(true)
}

/// 단계가 값을 끌어오는 자리 — 인자·조건·사후조건 — 를 같은 규칙으로 검증한다.
fn validate_step_templates(
    step: &WorkflowStep,
    contract: &SystemWorkflowContract,
    prior_steps: &BTreeSet<&str>,
    in_for_each: bool,
) -> Result<(), CoreError> {
    let check = |value: &Value| {
        validate_template(
            value,
            &contract.input_schema,
            prior_steps,
            in_for_each,
            contract.paced,
            0,
        )
    };
    check(&step.arguments)?;
    if let Some(condition) = &step.condition {
        check(&condition.left)?;
        check(&condition.equals)?;
    }
    if let Some(expect) = &step.expect {
        validate_path(&expect.path)?;
        validate_literal(&expect.equals)?;
    }
    Ok(())
}

/// 페이싱 회차 계약만 지켜야 하는 규약. 봉투가 정하는 값과 계약이 선언하는 값의 경계를 본다.
fn validate_paced_contract(contract: &SystemWorkflowContract) -> Result<(), CoreError> {
    // 봉투가 계산 요청의 경로로 그대로 쓰므로 실행 시점에 반드시 값이 있어야 한다.
    // 선택 입력이면 회차마다 계산이 인자 오류로 실패한다.
    let path_field = contract.input_schema.get(PACED_PROJECT_PATH_INPUT);
    let default_is_blank = path_field
        .and_then(|field| field.default_value.as_ref())
        .is_some_and(|value| value.as_str().is_none_or(|text| text.trim().is_empty()));
    match path_field {
        Some(field)
            if field.kind == WorkflowInputKind::String
                && (field.required || field.default_value.is_some())
                && !default_is_blank => {}
        _ => {
            return Err(CoreError::InvalidInput(format!(
                "페이싱 회차 계약은 무인 런타임을 띄울 경로로 문자열 입력 {PACED_PROJECT_PATH_INPUT}을(를) 필수(또는 비어 있지 않은 기본값)로 선언해야 합니다"
            )))
        }
    }
    for name in PACED_MODEL_INPUTS {
        if let Some(field) = contract.input_schema.get(*name) {
            if field.kind != WorkflowInputKind::String {
                return Err(CoreError::InvalidInput(format!(
                    "페이싱 회차 계약의 입력 {name}은(는) 문자열이어야 합니다"
                )));
            }
        }
    }
    for name in PACED_RESERVED_INPUTS {
        if contract.input_schema.contains_key(*name) {
            return Err(CoreError::InvalidInput(format!(
                "{name}은(는) 계약 입력이 아니라 회차(반복 요청)의 병렬 실행 설정입니다"
            )));
        }
    }
    if !contract
        .steps
        .iter()
        .any(|step| template_references_run(&step.arguments, "accountId"))
    {
        return Err(CoreError::InvalidInput(
            "페이싱 회차 계약은 어느 단계에서든 {\"$run\": \"accountId\"}로 봉투가 정한 계정을 받아야 합니다".to_owned(),
        ));
    }
    Ok(())
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
    if crate::identifier::is_slug(value, 64) {
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
        if !crate::identifier::is_slug(segment, 64) {
            return Err(CoreError::InvalidInput(format!(
                "허용되지 않는 path 구간입니다: {segment}"
            )));
        }
    }
    Ok(())
}

/// 템플릿은 리터럴 값과 `$input`/`$step`/`$item`/`$idempotencyKey` 토큰, 페이싱 회차 계약에서는
/// `$run` 토큰만 허용한다.
fn validate_template(
    template: &Value,
    inputs: &BTreeMap<String, WorkflowInputField>,
    prior_steps: &BTreeSet<&str>,
    in_for_each: bool,
    paced: bool,
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
            if let Some(field) = map.get("$run") {
                if map.len() != 1 {
                    return Err(CoreError::InvalidInput(
                        "$run 토큰에는 다른 키를 함께 쓸 수 없습니다".to_owned(),
                    ));
                }
                if !paced {
                    return Err(CoreError::InvalidInput(
                        "$run은 페이싱 회차 계약(paced: true)에서만 사용할 수 있습니다".to_owned(),
                    ));
                }
                let field = field.as_str().ok_or_else(|| {
                    CoreError::InvalidInput("$run 값은 문자열이어야 합니다".to_owned())
                })?;
                if !RUN_FIELDS.contains(&field) {
                    return Err(CoreError::InvalidInput(format!(
                        "$run이 지원하지 않는 값입니다: {field}(가능: {})",
                        RUN_FIELDS.join(", ")
                    )));
                }
                return Ok(());
            }
            for (key, value) in map {
                if key.starts_with('$') {
                    return Err(CoreError::InvalidInput(format!(
                        "지원하지 않는 템플릿 토큰입니다: {key}"
                    )));
                }
                validate_template(value, inputs, prior_steps, in_for_each, paced, depth + 1)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                validate_template(item, inputs, prior_steps, in_for_each, paced, depth + 1)?;
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
    let provided = provided
        .as_object()
        .ok_or_else(|| CoreError::InvalidInput("워크플로 입력은 객체여야 합니다".to_owned()))?;
    for key in provided.keys() {
        if !contract.input_schema.contains_key(key) {
            return Err(CoreError::InvalidInput(format!(
                "선언되지 않은 입력입니다: {key}"
            )));
        }
    }
    let mut inputs = BTreeMap::new();
    for (name, field) in &contract.input_schema {
        // 넘어오지 않은 입력은 계약이 선언한 기본값으로 채운다. 값이 매번 같은 워크플로를
        // 인자 없이도 부를 수 있게 하되, 기본값이 없으면 필수 여부는 그대로 지킨다.
        let value = match provided.get(name).or(field.default_value.as_ref()) {
            Some(value) => value,
            None => {
                if field.required {
                    return Err(CoreError::InvalidInput(format!(
                        "필수 입력 {name}이(가) 없습니다"
                    )));
                }
                continue;
            }
        };
        if !input_value_matches(field, value) {
            return Err(CoreError::InvalidInput(format!(
                "입력 {name}이(가) 선언된 형식과 다릅니다"
            )));
        }
        inputs.insert(name.clone(), value.clone());
    }
    Ok(inputs)
}

/// 입력 하나가 계약이 선언한 형과 맞는지. 등록 때의 기본값 검증과 실행 때의 인자 검증이
/// 같은 판정을 써야 화면이 채워 준 값이 실행에서 거절되지 않는다.
fn input_value_matches(field: &WorkflowInputField, value: &Value) -> bool {
    match field.kind {
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
    }
}

struct TemplateContext<'a> {
    inputs: &'a BTreeMap<String, Value>,
    results: &'a BTreeMap<String, Value>,
    item: Option<&'a Value>,
    /// 회차 봉투가 이번 건에 정한 값. 봉투 안의 내부 실행에만 있다.
    run: Option<&'a Value>,
    execution_id: &'a str,
    round_execution_id: Option<&'a str>,
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
            if let Some(field) = map.get("$run").and_then(Value::as_str) {
                let run = ctx.run.ok_or_else(|| {
                    CoreError::Runtime(
                        "$run은 페이싱 회차 봉투 안의 실행에서만 사용할 수 있습니다".to_owned(),
                    )
                })?;
                return select_path(run, field).cloned();
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
    workflow_id: &str,
    trigger: Option<&WorkflowTrigger>,
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
    let site = WorkflowCallSite {
        workflow_id,
        execution_id: ctx.execution_id,
        trigger,
        round_execution_id: ctx.round_execution_id,
    };
    let result = invoker(&step.operation, arguments.clone(), &site);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> (tempfile::TempDir, SystemWorkflowRegistry) {
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = SystemWorkflowRegistry::new(dir.path().to_path_buf());
        (dir, registry)
    }

    /// 등록은 승인 요약 확인을 전제하므로 대부분의 테스트는 두 단계를 함께 거친다.
    fn register_approved(
        registry: &SystemWorkflowRegistry,
        contract: SystemWorkflowContract,
    ) -> Result<Value, CoreError> {
        registry.propose(contract.clone())?;
        registry.register(contract)
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
        assert!(!STORE.path(dir.path()).exists());
    }

    #[test]
    fn input_labels_survive_into_the_approval_summary_and_reject_empty_text() {
        // 계약 키는 식별자라 화면 제목으로 쓰면 읽기 어렵다. 표시 이름을 계약이 들고
        // 가야 등록한 워크플로마다 폼이 스스로 설명된다.
        let (_directory, registry) = registry();
        let mut labelled = stop_provider_contract();
        labelled.input_schema.insert(
            "provider".to_owned(),
            serde_json::from_value(json!({
                "type": "string",
                "required": true,
                "label": "공급자",
                "description": "종료할 공급자"
            }))
            .expect("field"),
        );
        let summary = registry.propose(labelled).expect("propose");
        let label = summary
            .pointer("/approvalSummary/inputSchema/provider/label")
            .and_then(Value::as_str);
        assert_eq!(label, Some("공급자"));

        let mut blank = stop_provider_contract();
        blank.input_schema.insert(
            "provider".to_owned(),
            serde_json::from_value(json!({
                "type": "string",
                "required": true,
                "label": "   "
            }))
            .expect("field"),
        );
        assert!(registry.propose(blank).is_err());
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
    fn hard_to_recover_effect_answers_from_the_w3_table_only() {
        for (operation, effect) in HARD_TO_RECOVER_OPERATIONS {
            assert_eq!(hard_to_recover_effect(operation), Some(*effect));
        }
        assert_eq!(hard_to_recover_effect("list_chats"), None);
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
        let first = register_approved(&registry, stop_provider_contract()).expect("register v1");
        assert_eq!(first["version"], 1);
        let second = register_approved(&registry, stop_provider_contract()).expect("register v2");
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

    /// 라이브 페이싱 회차와 같은 모양의 계약. 회차 봉투(`paced`)가 갱신·계산·정리·기동 수를
    /// 맡고, 계약은 봉투가 정한 계정·공급자·모델·경로(`$run`)로 무인 런타임 한 건을 띄운다.
    fn usage_paced_round_contract() -> SystemWorkflowContract {
        serde_json::from_value(json!({
            "id": "usage-paced-round",
            "displayName": "사용량 페이싱 회차",
            "description": "회차 봉투가 정한 계정으로 무인 런타임 한 건을 띄운다",
            "paced": true,
            "inputSchema": {
                "projectPath": {"type": "string"},
                "message": {"type": "string"},
                "claudeModel": {"type": "string", "required": false},
                "antigravityModel": {"type": "string", "required": false}
            },
            "steps": [
                {"id": "s01", "operation": "start_chat",
                 "arguments": {"request": {"chat": {"accountId": {"$run": "accountId"}, "source": {"$run": "source"},
                     "model": {"$run": "model"}, "cwd": {"$run": "cwd"},
                     "reasoningEffort": {"$run": "reasoningEffort"}, "unattended": true},
                     "message": {"$input": "message"}, "idempotencyKey": {"$idempotencyKey": true}}}}
            ],
            "risk": "mutating"
        }))
        .expect("contract json")
    }

    /// 봉투 이전의 5단계 계약. 새로 등록할 수는 없고 저장본에서 이관만 한다.
    fn legacy_five_step_contract() -> SystemWorkflowContract {
        serde_json::from_value(json!({
            "id": "usage-paced-round",
            "displayName": "사용량 페이싱 회차",
            "description": "사용량 창을 목표치까지 채우도록 회차 기동 수를 계산해 무인 런타임을 띄운다",
            "inputSchema": {
                "projectPath": {"type": "string"},
                "message": {"type": "string"},
                "maxRuns": {"type": "number", "defaultValue": 2},
                "claudeModel": {"type": "string", "required": false}
            },
            "steps": [
                {"id": "s01", "operation": "refresh_provider_account_usages", "arguments": {}},
                {"id": "s02", "operation": "plan_usage_paced_runs", "arguments": {"request": {
                    "cadenceWorkflowId": "usage-paced-round", "maxRuns": {"$input": "maxRuns"},
                    "projectPath": {"$input": "projectPath"}}}},
                {"id": "s03", "operation": "stop_chat",
                 "forEach": {"step": "s02", "path": "staleRuns", "maxIterations": 12},
                 "arguments": {"chatId": {"$item": "chatId"}}},
                {"id": "s04", "operation": "start_chat",
                 "forEach": {"step": "s02", "path": "plannedRuns", "maxIterations": 12},
                 "arguments": {"request": {"chat": {"accountId": {"$item": "accountId"}, "source": {"$item": "source"},
                     "model": {"$item": "model"}, "cwd": {"$item": "cwd"}, "unattended": true},
                     "message": {"$input": "message"}, "idempotencyKey": {"$idempotencyKey": true}}}},
                {"id": "s05", "operation": "refresh_provider_account_usages", "arguments": {}}
            ],
            "risk": "mutating"
        }))
        .expect("contract json")
    }

    /// 계획 응답 흉내. 회차 봉투는 plannedRuns·staleRuns만 읽는다.
    fn fake_plan(runs: &[(&str, &str)]) -> Value {
        json!({
            "consumerId": "schedule-1",
            "plannedRuns": runs.iter().enumerate().map(|(index, (account, source))| json!({
                "index": index + 1, "accountId": account, "source": source,
                "model": "claude-opus-5", "cwd": "/tmp/project",
                "reasoningEffort": if index == 0 { "xhigh" } else { "medium" }
            })).collect::<Vec<_>>(),
            "staleRuns": [{"chatId": "old-1", "source": "claude"}],
            "reasoning": ["테스트"],
        })
    }

    #[test]
    fn a_paced_contract_is_registered_with_run_tokens_and_without_envelope_steps() {
        let (_dir, registry) = registry();
        let proposed = registry
            .propose(usage_paced_round_contract())
            .expect("propose");
        assert_eq!(proposed["requiredOperations"], json!(["start_chat"]));
        assert_eq!(proposed["computedRisk"], "mutating");
        assert_eq!(proposed["approvalSummary"]["paced"], true);
        register_approved(&registry, usage_paced_round_contract()).expect("register");
        let detail = registry.get("usage-paced-round").expect("get");
        assert_eq!(detail["paced"], true);
        assert_eq!(detail["compatible"], true);
        assert!(registry.is_paced("usage-paced-round").expect("is_paced"));
        let facts = registry.workflow_pacing_facts().expect("facts");
        assert_eq!(
            facts["usage-paced-round"],
            WorkflowPacingFacts {
                paced: true,
                plans_in_contract: false,
                launches: true,
            }
        );
        assert!(facts["usage-paced-round"].consumes_usage());
        assert!(facts["usage-paced-round"].computes());
    }

    #[test]
    fn paced_contract_validation_guards_inputs_tokens_and_envelope_steps() {
        let (_dir, registry) = registry();
        // 계산 단계는 봉투의 몫이다 — 어떤 계약도 단계로 부르지 않는다.
        assert!(matches!(
            registry.propose(legacy_five_step_contract()),
            Err(CoreError::InvalidInput(message)) if message.contains("paced: true")
        ));
        // maxRuns는 반복 요청의 병렬 실행 설정이다.
        let mut with_max_runs = usage_paced_round_contract();
        with_max_runs.input_schema.insert(
            "maxRuns".to_owned(),
            serde_json::from_value(json!({"type": "number"})).expect("field"),
        );
        assert!(matches!(
            registry.propose(with_max_runs),
            Err(CoreError::InvalidInput(message)) if message.contains("maxRuns")
        ));
        // 경로 입력은 필수다 — 없어도, 선택 입력이어도 거절한다(봉투가 실행 시점에 값을 쓴다).
        let mut without_path = usage_paced_round_contract();
        without_path.input_schema.remove("projectPath");
        assert!(matches!(
            registry.propose(without_path),
            Err(CoreError::InvalidInput(message)) if message.contains("projectPath")
        ));
        let mut optional_path = usage_paced_round_contract();
        optional_path.input_schema.insert(
            "projectPath".to_owned(),
            serde_json::from_value(json!({"type": "string", "required": false})).expect("field"),
        );
        assert!(matches!(
            registry.propose(optional_path),
            Err(CoreError::InvalidInput(message)) if message.contains("projectPath")
        ));
        let mut defaulted_path = usage_paced_round_contract();
        defaulted_path.input_schema.insert(
            "projectPath".to_owned(),
            serde_json::from_value(
                json!({"type": "string", "required": false, "defaultValue": "/tmp/project"}),
            )
            .expect("field"),
        );
        assert!(registry.propose(defaulted_path).is_ok());
        // 봉투가 정한 계정을 받지 않는 계약은 페이싱이 의미 없다.
        let mut literal_account = usage_paced_round_contract();
        literal_account.steps[0].arguments["request"]["chat"]["accountId"] = json!("claude-a");
        assert!(matches!(
            registry.propose(literal_account),
            Err(CoreError::InvalidInput(message)) if message.contains("accountId")
        ));
        // $run은 알려진 값만, 그리고 paced 계약에서만.
        let mut unknown_field = usage_paced_round_contract();
        unknown_field.steps[0].arguments["request"]["chat"]["model"] = json!({"$run": "secret"});
        assert!(registry.propose(unknown_field).is_err());
        let mut outside = stop_provider_contract();
        outside.steps[0].arguments = json!({"provider": {"$run": "accountId"}});
        assert!(matches!(
            registry.propose(outside),
            Err(CoreError::InvalidInput(message)) if message.contains("paced")
        ));
    }

    #[test]
    fn a_paced_round_accepts_any_positive_parallel_count_and_rejects_zero() {
        // 병렬 실행에 상한이 없다 — 옛 상한 12를 넘는 13건도 계산 요청에 그대로 실린다.
        // 0은 봉투 입구에서 거절한다.
        let (_dir, registry) = registry();
        register_approved(&registry, usage_paced_round_contract()).expect("register");
        let seen = std::cell::RefCell::new(Vec::new());
        let invoker = |operation: &str, arguments: Value, _site: &WorkflowCallSite<'_>| {
            seen.borrow_mut().push((operation.to_owned(), arguments));
            Ok(if operation == "plan_usage_paced_runs" {
                fake_plan(&[("claude-a", "claude")])
            } else {
                json!({"ok": true})
            })
        };
        let request = |key: &str| WorkflowExecuteRequest {
            workflow_id: "usage-paced-round".to_owned(),
            arguments: json!({"projectPath": "/tmp/project", "message": "go", "claudeModel": "claude-opus-5"}),
            idempotency_key: key.to_owned(),
            ..Default::default()
        };
        registry
            .execute_paced_round(
                request("round-13"),
                PacedRoundOptions { max_runs: 13 },
                &invoker,
            )
            .expect("round");
        let plan_call = seen
            .borrow()
            .iter()
            .find(|call| call.0 == "plan_usage_paced_runs")
            .cloned()
            .expect("plan call");
        assert_eq!(plan_call.1["request"]["maxRuns"], 13);
        let before = seen.borrow().len();
        assert!(matches!(
            registry.execute_paced_round(request("round-0"), PacedRoundOptions { max_runs: 0 }, &invoker),
            Err(CoreError::InvalidInput(message)) if message.contains("병렬 실행")
        ));
        assert_eq!(
            seen.borrow().len(),
            before,
            "거절된 회차는 봉투 작업을 부르지 않는다"
        );
    }

    #[test]
    fn a_paced_round_refreshes_plans_cleans_up_and_launches_each_planned_run() {
        let (_dir, registry) = registry();
        register_approved(&registry, usage_paced_round_contract()).expect("register");
        let seen = std::cell::RefCell::new(Vec::new());
        let invoker = |operation: &str, arguments: Value, site: &WorkflowCallSite<'_>| {
            seen.borrow_mut().push((
                operation.to_owned(),
                arguments,
                site.execution_id.to_owned(),
                site.round_execution_id.map(str::to_owned),
                site.trigger.map(|trigger| trigger.schedule_id.clone()),
            ));
            Ok(if operation == "plan_usage_paced_runs" {
                fake_plan(&[("claude-a", "claude"), ("codex-b", "codex")])
            } else {
                json!({"ok": true})
            })
        };
        let receipt = registry
            .execute_paced_round(
                WorkflowExecuteRequest {
                    workflow_id: "usage-paced-round".to_owned(),
                    arguments: json!({"projectPath": "/tmp/project", "message": "go", "claudeModel": "claude-opus-5", "antigravityModel": "gemini-3.1-pro"}),
                    idempotency_key: "schedule-workflow-run-1".to_owned(),
                    trigger: Some(WorkflowTrigger {
                        schedule_id: "schedule-1".to_owned(),
                        run_id: "run-1".to_owned(),
                    }),
                    ..Default::default()
                },
                PacedRoundOptions { max_runs: 3 },
                &invoker,
            )
            .expect("round");
        let seen = seen.borrow();
        let operations: Vec<&str> = seen.iter().map(|call| call.0.as_str()).collect();
        assert_eq!(
            operations,
            vec![
                "refresh_provider_account_usages",
                "plan_usage_paced_runs",
                "stop_chat",
                "start_chat",
                "start_chat",
                "refresh_provider_account_usages",
            ]
        );
        // 계산 요청은 반복 요청의 병렬 실행 건수와 계약 입력의 경로·모델을 싣고, 출처는
        // 회차 실행 id와 반복 요청이다.
        let plan_call = &seen[1];
        assert_eq!(plan_call.1["request"]["maxRuns"], 3);
        assert_eq!(
            plan_call.1["request"]["cadenceWorkflowId"],
            "usage-paced-round"
        );
        assert_eq!(plan_call.1["request"]["projectPath"], "/tmp/project");
        assert_eq!(plan_call.1["request"]["claudeModel"], "claude-opus-5");
        assert_eq!(plan_call.1["request"]["antigravityModel"], "gemini-3.1-pro");
        assert!(plan_call.1["request"].get("codexModel").is_none());
        assert!(plan_call.2.starts_with("wfround-"));
        assert_eq!(plan_call.3, None);
        assert_eq!(plan_call.4.as_deref(), Some("schedule-1"));
        assert_eq!(seen[2].1, json!({"chatId": "old-1"}));
        // 기동은 건마다 내부 실행이다: 계정·공급자·모델·경로는 봉투가 정한 값, 실행 id는
        // 건마다 다르되 회차 실행 id를 함께 싣는다.
        let first = &seen[3];
        let second = &seen[4];
        assert_eq!(first.1["request"]["chat"]["accountId"], "claude-a");
        assert_eq!(first.1["request"]["chat"]["source"], "claude");
        assert_eq!(first.1["request"]["chat"]["cwd"], "/tmp/project");
        assert_eq!(first.1["request"]["chat"]["reasoningEffort"], "xhigh");
        assert_eq!(first.1["request"]["message"], "go");
        assert_eq!(second.1["request"]["chat"]["accountId"], "codex-b");
        assert_eq!(second.1["request"]["chat"]["reasoningEffort"], "medium");
        assert!(first.2.starts_with("wfexec-") && second.2.starts_with("wfexec-"));
        assert_ne!(first.2, second.2);
        assert_eq!(first.3.as_deref(), Some(plan_call.2.as_str()));
        assert_eq!(second.3.as_deref(), Some(plan_call.2.as_str()));
        assert_ne!(
            first.1["request"]["idempotencyKey"],
            second.1["request"]["idempotencyKey"]
        );
        assert_eq!(receipt["succeeded"], true);
        assert_eq!(receipt["paced"], true);
        assert!(receipt["executionId"]
            .as_str()
            .is_some_and(|id| id.starts_with("wfround-")));
        assert_eq!(receipt["round"]["plannedRuns"], 2);
        assert_eq!(receipt["round"]["launchedRuns"], 2);
        assert_eq!(receipt["round"]["staleRuns"], 1);
        assert_eq!(receipt["steps"].as_array().expect("steps").len(), 6);
        let detail = registry.get("usage-paced-round").expect("get");
        assert_eq!(detail["lastExecution"]["succeeded"], true);
    }

    #[test]
    fn run_now_launches_one_paced_run_when_the_plan_is_zero_without_reusing_its_guards() {
        let (_dir, registry) = registry();
        register_approved(&registry, usage_paced_round_contract()).expect("register");
        let seen = std::cell::RefCell::new(Vec::new());
        let invoker = |operation: &str, arguments: Value, _site: &WorkflowCallSite<'_>| {
            seen.borrow_mut()
                .push((operation.to_owned(), arguments.clone()));
            Ok(if operation == "plan_usage_paced_runs" {
                json!({
                    "consumerId": "schedule-1",
                    "accounts": [{
                        "accountId": "antigravity:gemini-3-pro",
                        "provider": "antigravity",
                        // 수동 실행은 이 계획 판정을 다시 가드로 사용하지 않는다.
                        "skipReason": "5시간 창 90% 초과"
                    }],
                    "plannedRuns": [],
                    "staleRuns": [],
                    "reasoning": ["이번 회차는 기동할 계정이 없습니다"]
                })
            } else {
                json!({"ok": true})
            })
        };
        let request = |key: &str, manual_run: bool| WorkflowExecuteRequest {
            workflow_id: "usage-paced-round".to_owned(),
            arguments: json!({
                "projectPath": "/tmp/project",
                "message": "go",
                "antigravityModel": "gemini-3.1-pro-high"
            }),
            idempotency_key: key.to_owned(),
            trigger: Some(WorkflowTrigger {
                schedule_id: "schedule-1".to_owned(),
                run_id: format!("run-{key}"),
            }),
            manual_run,
            ..Default::default()
        };

        let manual = registry
            .execute_paced_round(
                request("manual-zero", true),
                PacedRoundOptions { max_runs: 4 },
                &invoker,
            )
            .expect("manual round");
        let calls = seen.borrow();
        let start = calls
            .iter()
            .find(|(operation, _)| operation == "start_chat")
            .expect("manual start");
        assert_eq!(
            start.1["request"]["chat"]["accountId"],
            "antigravity:gemini-3-pro"
        );
        assert_eq!(start.1["request"]["chat"]["source"], "antigravity");
        assert_eq!(start.1["request"]["chat"]["model"], "gemini-3.1-pro-high");
        assert_eq!(start.1["request"]["chat"]["cwd"], "/tmp/project");
        assert_eq!(manual["round"]["plannedRuns"], 1);
        assert_eq!(manual["round"]["launchedRuns"], 1);
        assert_eq!(manual["round"]["manualOverride"], true);
        assert!(manual["round"]["reasoning"]
            .as_array()
            .expect("reasoning")
            .iter()
            .any(|reason| reason
                .as_str()
                .is_some_and(|reason| reason.contains("일반 수동 실행 1건"))));
        drop(calls);

        seen.borrow_mut().clear();
        let automatic = registry
            .execute_paced_round(
                request("automatic-zero", false),
                PacedRoundOptions { max_runs: 4 },
                &invoker,
            )
            .expect("automatic round");
        assert!(!seen
            .borrow()
            .iter()
            .any(|(operation, _)| operation == "start_chat"));
        assert_eq!(automatic["round"]["plannedRuns"], 0);
        assert_eq!(automatic["round"]["launchedRuns"], 0);
        assert_eq!(automatic["round"]["manualOverride"], false);
    }

    #[test]
    fn workflow_request_body_cannot_forge_the_run_now_override() {
        let request: WorkflowExecuteRequest = serde_json::from_value(json!({
            "workflowId": "usage-paced-round",
            "arguments": {},
            "idempotencyKey": "external-request",
            "manualRun": true,
            "trigger": {"scheduleId": "fake", "runId": "fake"},
            "pacedRun": {"accountId": "fake"},
            "roundExecutionId": "fake"
        }))
        .expect("request");
        assert!(!request.manual_run);
        assert!(request.trigger.is_none());
        assert!(request.paced_run.is_none());
        assert!(request.round_execution_id.is_none());
    }

    #[test]
    fn a_paced_round_continues_after_one_launch_fails() {
        let (_dir, registry) = registry();
        register_approved(&registry, usage_paced_round_contract()).expect("register");
        let seen = std::cell::RefCell::new(Vec::new());
        let invoker = |operation: &str, arguments: Value, _site: &WorkflowCallSite<'_>| {
            seen.borrow_mut().push(operation.to_owned());
            if operation == "plan_usage_paced_runs" {
                return Ok(fake_plan(&[("claude-a", "claude"), ("codex-b", "codex")]));
            }
            if operation == "start_chat" && arguments["request"]["chat"]["accountId"] == "claude-a"
            {
                return Err(CoreError::Runtime("계정 준비 실패".to_owned()));
            }
            Ok(json!({"ok": true}))
        };
        let receipt = registry
            .execute_paced_round(
                WorkflowExecuteRequest {
                    workflow_id: "usage-paced-round".to_owned(),
                    arguments: json!({"projectPath": "/tmp/project", "message": "go"}),
                    idempotency_key: "round-partial".to_owned(),
                    ..Default::default()
                },
                PacedRoundOptions { max_runs: 2 },
                &invoker,
            )
            .expect("round");
        // 첫 건이 실패해도 둘째 건은 뜨고 재갱신도 한다. forEach였을 때는 여기서 멈췄다.
        assert_eq!(
            seen.borrow()
                .iter()
                .filter(|op| *op == "start_chat")
                .count(),
            2
        );
        assert_eq!(
            seen.borrow().last().map(String::as_str),
            Some("refresh_provider_account_usages")
        );
        assert_eq!(receipt["succeeded"], false);
        assert_eq!(receipt["failedStepId"], "run-1");
        assert_eq!(receipt["retryable"], true);
        assert_eq!(receipt["round"]["launchedRuns"], 1);
        let steps = receipt["steps"].as_array().expect("steps");
        assert_eq!(steps[3]["stepId"], "run-1");
        assert_eq!(steps[3]["status"], "failed");
        assert_eq!(steps[4]["stepId"], "run-2");
        assert_eq!(steps[4]["status"], "succeeded");
    }

    #[test]
    fn a_paced_contract_only_runs_inside_the_envelope_and_vice_versa() {
        let (_dir, registry) = registry();
        register_approved(&registry, usage_paced_round_contract()).expect("register paced");
        register_approved(&registry, stop_provider_contract()).expect("register plain");
        let invoker =
            |_operation: &str, _arguments: Value, _site: &WorkflowCallSite<'_>| Ok(json!([]));
        assert!(matches!(
            registry.execute(
                WorkflowExecuteRequest {
                    workflow_id: "usage-paced-round".to_owned(),
                    arguments: json!({"projectPath": "/tmp/project", "message": "go"}),
                    idempotency_key: "bare".to_owned(),
                    ..Default::default()
                },
                &invoker,
            ),
            Err(CoreError::InvalidInput(message)) if message.contains("봉투")
        ));
        assert!(matches!(
            registry.execute_paced_round(
                WorkflowExecuteRequest {
                    workflow_id: "stop-provider-chats".to_owned(),
                    arguments: json!({"provider": "claude"}),
                    idempotency_key: "plain-as-round".to_owned(),
                    ..Default::default()
                },
                PacedRoundOptions { max_runs: 1 },
                &invoker,
            ),
            Err(CoreError::InvalidInput(message)) if message.contains("paced")
        ));
    }

    #[test]
    fn a_live_shaped_five_step_contract_migrates_with_its_full_start_chat_arguments() {
        // 실제 저장본의 계약 모양: 라벨·기본값이 있는 입력, condition·expect가 null인 단계,
        // start_chat 인자에 실행설정까지 전부. 이관은 이 인자를 그대로 두고 $item만 바꾼다.
        let (_dir, registry) = registry();
        let live: SystemWorkflowContract = serde_json::from_value(json!({
            "id": "aia-kbfps-qa-round",
            "displayName": "KB펀드파트너스 QA 회차",
            "description": "사용량 예산 안에서 이번 회차의 QA 기동 수를 계산해 무인 런타임을 띄운다",
            "inputSchema": {
                "claudeModel": {"type": "string", "values": null, "required": true, "description": "claude 계정으로 띄울 런타임의 모델", "label": "claude 레인 모델", "defaultValue": "claude-opus-5"},
                "codexModel": {"type": "string", "values": null, "required": true, "description": "codex 계정으로 띄울 런타임의 모델", "label": "codex 레인 모델", "defaultValue": "gpt-5.6-sol"},
                "maxRuns": {"type": "number", "values": null, "required": true, "description": "한 회차에 동시에 띄울 수 있는 최대 건수", "label": "회차 기동 상한", "defaultValue": 4},
                "message": {"type": "string", "values": null, "required": true, "description": "각 회차의 런타임에 보낼 첫 메시지", "label": "무인 런타임 지시문", "defaultValue": "kbfps-dynamic-form-qa 스킬을 따라 이번 회차 QA를 1건 수행해줘."},
                "projectPath": {"type": "string", "values": null, "required": true, "description": "무인 런타임을 띄울 절대경로", "label": "QA 대상 프로젝트", "defaultValue": "/tmp/kbfps-hrm"}
            },
            "steps": [
                {"id": "s01", "operation": "refresh_provider_account_usages", "arguments": {}, "forEach": null, "condition": null, "expect": null},
                {"id": "s02", "operation": "plan_usage_paced_runs", "arguments": {"request": {"cadenceWorkflowId": "aia-kbfps-qa-round", "claudeModel": {"$input": "claudeModel"}, "codexModel": {"$input": "codexModel"}, "maxRuns": {"$input": "maxRuns"}, "projectPath": {"$input": "projectPath"}}}, "forEach": null, "condition": null, "expect": null},
                {"id": "s03", "operation": "stop_chat", "arguments": {"chatId": {"$item": "chatId"}}, "forEach": {"step": "s02", "path": "staleRuns", "maxIterations": 12}, "condition": null, "expect": null},
                {"id": "s04", "operation": "start_chat", "arguments": {"request": {"chat": {"accountId": {"$item": "accountId"}, "approvalMode": "never", "cwd": {"$item": "cwd"}, "handoffOrigin": null, "mode": "fullAccess", "model": {"$item": "model"}, "pinAccount": true, "profile": "standard", "reasoningEffort": "high", "resumeSessionId": null, "settings": {}, "source": {"$item": "source"}, "unattended": true}, "idempotencyKey": {"$idempotencyKey": true}, "message": {"$input": "message"}}}, "forEach": {"step": "s02", "path": "plannedRuns", "maxIterations": 12}, "condition": null, "expect": null},
                {"id": "s05", "operation": "refresh_provider_account_usages", "arguments": {}, "forEach": null, "condition": null, "expect": null}
            ],
            "risk": "mutating",
            "version": 4
        }))
        .expect("live contract");
        registry
            .with_store_lock(|| {
                let mut store = registry.load_store_unlocked()?;
                store.workflows.insert(
                    live.id.clone(),
                    StoredWorkflow {
                        id: live.id.clone(),
                        versions: vec![StoredWorkflowVersion {
                            version: 4,
                            registered_at: 1,
                            computed_risk: WorkflowRisk::Mutating,
                            required_operations: vec![
                                "plan_usage_paced_runs".to_owned(),
                                "refresh_provider_account_usages".to_owned(),
                                "start_chat".to_owned(),
                                "stop_chat".to_owned(),
                            ],
                            contract: live.clone(),
                        }],
                        last_execution: None,
                    },
                );
                registry.save_store_unlocked(&store)
            })
            .expect("seed");
        let (migrated, skipped) = registry.migrate_legacy_paced_contracts().expect("migrate");
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(migrated[0].version, 5);
        assert_eq!(migrated[0].legacy_max_runs_default, Some(4));
        let detail = registry.get("aia-kbfps-qa-round").expect("get");
        assert_eq!(detail["compatible"], true);
        let chat = &detail["contract"]["steps"][0]["arguments"]["request"]["chat"];
        assert_eq!(chat["accountId"], json!({"$run": "accountId"}));
        assert_eq!(chat["source"], json!({"$run": "source"}));
        assert_eq!(chat["model"], json!({"$run": "model"}));
        assert_eq!(chat["cwd"], json!({"$run": "cwd"}));
        assert_eq!(chat["reasoningEffort"], "high");
        assert_eq!(chat["pinAccount"], true);
        assert_eq!(
            detail["inputSchema"]["claudeModel"]["defaultValue"],
            "claude-opus-5"
        );
        assert!(detail["inputSchema"].get("maxRuns").is_none());
        // 이관된 계약은 봉투로 실행된다: 계약 입력만 넘겨도(맥스런 없이) 기본값이 채워진다.
        let invoker = |operation: &str, _arguments: Value, _site: &WorkflowCallSite<'_>| {
            Ok(if operation == "plan_usage_paced_runs" {
                fake_plan(&[("claude-a", "claude")])
            } else {
                json!({"ok": true})
            })
        };
        let receipt = registry
            .execute_paced_round(
                WorkflowExecuteRequest {
                    workflow_id: "aia-kbfps-qa-round".to_owned(),
                    arguments: json!({}),
                    idempotency_key: "migrated-round".to_owned(),
                    expected_version: Some(5),
                    ..Default::default()
                },
                PacedRoundOptions { max_runs: 4 },
                &invoker,
            )
            .expect("round");
        assert_eq!(receipt["succeeded"], true);
        assert_eq!(receipt["round"]["launchedRuns"], 1);
    }

    fn seed_legacy(
        registry: &SystemWorkflowRegistry,
        contract: SystemWorkflowContract,
        version: u32,
    ) {
        registry
            .with_store_lock(|| {
                let mut store = registry.load_store_unlocked()?;
                let mut stored = contract.clone();
                stored.version = Some(version);
                store.workflows.insert(
                    contract.id.clone(),
                    StoredWorkflow {
                        id: contract.id.clone(),
                        versions: vec![StoredWorkflowVersion {
                            version,
                            registered_at: 1,
                            computed_risk: WorkflowRisk::Mutating,
                            required_operations: vec![
                                "plan_usage_paced_runs".to_owned(),
                                "start_chat".to_owned(),
                            ],
                            contract: stored,
                        }],
                        last_execution: None,
                    },
                );
                registry.save_store_unlocked(&store)
            })
            .expect("seed");
    }

    #[test]
    fn legacy_plan_requests_the_envelope_cannot_reproduce_are_not_migrated_automatically() {
        // 공급자 필터처럼 봉투가 채우지 않는 계산 인자는 조용히 넓어지므로 건너뛴다.
        {
            let (_dir, registry) = registry();
            let mut filtered = legacy_five_step_contract();
            filtered.steps[1].arguments["request"]["providers"] = json!(["claude"]);
            seed_legacy(&registry, filtered, 3);
            let (migrated, skipped) = registry.migrate_legacy_paced_contracts().expect("migrate");
            assert!(migrated.is_empty());
            assert_eq!(skipped.len(), 1);
            assert!(skipped[0].1.contains("providers"), "{}", skipped[0].1);
        }
        // 모델 인자가 다른 이름의 입력을 참조하면 봉투가 그 입력을 모른다.
        {
            let (_dir, registry) = registry();
            let mut renamed = legacy_five_step_contract();
            renamed.input_schema.insert(
                "model".to_owned(),
                serde_json::from_value(json!({"type": "string", "required": false}))
                    .expect("field"),
            );
            renamed.steps[1].arguments["request"]["claudeModel"] = json!({"$input": "model"});
            seed_legacy(&registry, renamed, 3);
            let (migrated, skipped) = registry.migrate_legacy_paced_contracts().expect("migrate");
            assert!(migrated.is_empty());
            assert!(skipped[0].1.contains("claudeModel"), "{}", skipped[0].1);
        }
        // 계산 단계에 리터럴 maxRuns가 있으면 그것이 병렬 실행 기본값이다(입력 기본값 2보다 우선).
        {
            let (_dir, registry) = registry();
            let mut literal = legacy_five_step_contract();
            literal.steps[1].arguments["request"]["maxRuns"] = json!(6);
            seed_legacy(&registry, literal, 3);
            let (migrated, skipped) = registry.migrate_legacy_paced_contracts().expect("migrate");
            assert!(skipped.is_empty(), "{skipped:?}");
            assert_eq!(migrated[0].legacy_max_runs_default, Some(6));
        }
    }

    #[test]
    fn a_step_reading_the_launch_step_result_blocks_automatic_migration() {
        // 기동 단계는 봉투 안에서 건마다 단일 결과가 되므로, 그 목록을 읽던 뒷단계는 실행마다
        // 실패한다. 자동으로 옮기지 않고 사유를 남긴다.
        let (_dir, registry) = registry();
        let mut chained = legacy_five_step_contract();
        chained.steps.push(
            serde_json::from_value(json!({
                "id": "s06", "operation": "get_live_chats",
                "arguments": {"chatId": {"$step": "s04", "path": "0.chatId"}}
            }))
            .expect("step"),
        );
        seed_legacy(&registry, chained, 3);
        let (migrated, skipped) = registry.migrate_legacy_paced_contracts().expect("migrate");
        assert!(migrated.is_empty());
        assert!(skipped[0].1.contains("s06"), "{}", skipped[0].1);
    }

    #[test]
    fn a_blank_project_path_never_reaches_the_plan() {
        // 비어 있는 경로로 계산까지 가면 예약만 남고 기동은 전부 실패해 다른 소비자의 여유를
        // 갉아먹는다. 등록 때는 빈 기본값을, 실행 때는 빈 인자를 막는다.
        let (_dir, registry) = registry();
        let mut blank_default = usage_paced_round_contract();
        blank_default.input_schema.insert(
            "projectPath".to_owned(),
            serde_json::from_value(
                json!({"type": "string", "required": false, "defaultValue": " "}),
            )
            .expect("field"),
        );
        assert!(matches!(
            registry.propose(blank_default),
            Err(CoreError::InvalidInput(message)) if message.contains("projectPath")
        ));
        register_approved(&registry, usage_paced_round_contract()).expect("register");
        let calls = std::cell::RefCell::new(Vec::new());
        let invoker = |operation: &str, _arguments: Value, _site: &WorkflowCallSite<'_>| {
            calls.borrow_mut().push(operation.to_owned());
            Ok(json!({}))
        };
        let result = registry.execute_paced_round(
            WorkflowExecuteRequest {
                workflow_id: "usage-paced-round".to_owned(),
                arguments: json!({"projectPath": "  ", "message": "go"}),
                idempotency_key: "blank-path".to_owned(),
                ..Default::default()
            },
            PacedRoundOptions { max_runs: 1 },
            &invoker,
        );
        assert!(
            matches!(result, Err(CoreError::InvalidInput(message)) if message.contains("projectPath"))
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn max_runs_accepts_integral_floats_and_numeric_strings() {
        assert_eq!(max_runs_from_value(&json!(4)), Some(4));
        assert_eq!(max_runs_from_value(&json!(4.0)), Some(4));
        assert_eq!(max_runs_from_value(&json!("4")), Some(4));
        assert_eq!(max_runs_from_value(&json!(4.5)), None);
        assert_eq!(max_runs_from_value(&json!(0)), None);
        // 상한은 없다 — 옛 상한 12를 넘는 값도 그대로 읽는다.
        assert_eq!(max_runs_from_value(&json!(13)), Some(13));
        assert_eq!(max_runs_from_value(&json!("50")), Some(50));
        assert_eq!(max_runs_from_value(&json!(true)), None);
    }

    #[test]
    fn legacy_five_step_contracts_migrate_to_paced_versions() {
        let (_dir, registry) = registry();
        // 저장본에 옛 5단계 계약 v3을 직접 심는다(등록은 더 받지 않으므로).
        let legacy = legacy_five_step_contract();
        registry
            .with_store_lock(|| {
                let mut store = registry.load_store_unlocked()?;
                let mut contract = legacy.clone();
                contract.version = Some(3);
                store.workflows.insert(
                    legacy.id.clone(),
                    StoredWorkflow {
                        id: legacy.id.clone(),
                        versions: vec![StoredWorkflowVersion {
                            version: 3,
                            registered_at: 1,
                            computed_risk: WorkflowRisk::Mutating,
                            required_operations: vec![
                                "plan_usage_paced_runs".to_owned(),
                                "start_chat".to_owned(),
                            ],
                            contract,
                        }],
                        last_execution: None,
                    },
                );
                registry.save_store_unlocked(&store)
            })
            .expect("seed");
        // 이관 전에는 카탈로그 비호환(계산 단계 금지)이라 실행할 수 없다.
        assert_eq!(
            registry.get("usage-paced-round").expect("get")["compatible"],
            false
        );

        let (migrated, skipped) = registry.migrate_legacy_paced_contracts().expect("migrate");
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(
            migrated,
            vec![MigratedPacedWorkflow {
                workflow_id: "usage-paced-round".to_owned(),
                version: 4,
                legacy_version: 3,
                legacy_max_runs_default: Some(2),
            }]
        );
        // 반복 요청 갱신은 기동마다 다시 확인할 수 있어야 한다 — 옛 버전 3에 묶인 회차가
        // 남아 있으면 이 목록으로 마무리한다.
        assert_eq!(
            registry
                .pending_paced_binding_migrations()
                .expect("pending"),
            migrated
        );
        let detail = registry.get("usage-paced-round").expect("get");
        assert_eq!(detail["version"], 4);
        assert_eq!(detail["paced"], true);
        assert_eq!(detail["compatible"], true);
        assert_eq!(detail["requiredOperations"], json!(["start_chat"]));
        assert!(detail["inputSchema"].get("maxRuns").is_none());
        assert!(detail["inputSchema"].get("projectPath").is_some());
        let steps = detail["contract"]["steps"].as_array().expect("steps");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["operation"], "start_chat");
        assert_eq!(steps[0]["forEach"], Value::Null);
        assert_eq!(
            steps[0]["arguments"]["request"]["chat"]["accountId"],
            json!({"$run": "accountId"})
        );
        assert_eq!(
            steps[0]["arguments"]["request"]["message"],
            json!({"$input": "message"})
        );
        // 두 번 돌려도 이미 이관된 워크플로는 더 쌓지 않는다.
        let (again, _) = registry
            .migrate_legacy_paced_contracts()
            .expect("migrate again");
        assert!(again.is_empty());
        assert_eq!(
            registry.get("usage-paced-round").expect("get")["version"],
            4
        );
    }

    #[test]
    fn register_rejects_mismatched_requested_version() {
        let (_dir, registry) = registry();
        register_approved(&registry, stop_provider_contract()).expect("register v1");
        // 버전 표기는 계약 지문에서 빠지므로 v1 승인이 그대로 유효하고,
        // 등록은 버전 검사에서만 막힌다.
        let mut wrong = stop_provider_contract();
        wrong.version = Some(9);
        assert!(matches!(
            registry.register(wrong),
            Err(CoreError::Conflict(_))
        ));
    }

    /// 승인 기록은 저장소가 아니라 프로세스에 남으므로, 다른 테스트가 같은 계약을
    /// 이미 승인해 두면 이 검증이 무의미해진다. 여기서만 쓰는 계약으로 확인한다.
    #[test]
    fn register_requires_a_confirmed_proposal() {
        let (_dir, registry) = registry();
        let mut contract = stop_provider_contract();
        contract.id = "confirmation-required-probe".to_owned();

        let error = registry
            .register(contract.clone())
            .expect_err("승인 요약을 확인하지 않은 등록은 거부되어야 합니다");
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(registry.get(&contract.id).is_err());

        registry.propose(contract.clone()).expect("propose");
        assert_eq!(
            registry
                .register(contract)
                .expect("승인 요약을 확인한 뒤에는 등록되어야 합니다")["version"],
            1
        );
    }

    #[test]
    fn confirming_one_contract_does_not_approve_another() {
        let (_dir, registry) = registry();
        let mut approved = stop_provider_contract();
        approved.id = "single-contract-approval-probe".to_owned();
        registry.propose(approved.clone()).expect("propose");

        let mut other = approved;
        other.steps[0].operation = "stop_provider_terminals".to_owned();
        assert!(matches!(
            registry.register(other),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn document_automation_meta_steps_are_forbidden() {
        let (_dir, registry) = registry();
        let mut contract = stop_provider_contract();
        contract.steps[0].operation = "create_document_trigger".to_owned();
        assert!(matches!(
            registry.propose(contract),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn dynamic_external_plugin_steps_are_forbidden() {
        let (_dir, registry) = registry();
        for operation in ["read_external_plugin_tool", "execute_external_plugin_tool"] {
            let mut contract = stop_provider_contract();
            contract.steps[0].operation = operation.to_owned();
            assert!(matches!(
                registry.propose(contract),
                Err(CoreError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn execute_refuses_a_workflow_changed_after_trigger_approval() {
        let (_dir, registry) = registry();
        register_approved(&registry, stop_provider_contract()).expect("register v1");
        register_approved(&registry, stop_provider_contract()).expect("register v2");
        let result = registry.execute(
            WorkflowExecuteRequest {
                trigger: None,
                manual_run: false,
                paced_run: None,
                round_execution_id: None,
                workflow_id: "stop-provider-chats".to_owned(),
                arguments: json!({"provider": "claude"}),
                idempotency_key: "workflow-pinned-version".to_owned(),
                expected_version: Some(1),
            },
            &|_, _, _| panic!("changed workflow must not execute"),
        );
        assert!(matches!(result, Err(CoreError::Conflict(_))));
    }

    #[test]
    fn execute_runs_steps_with_condition_filtering_and_idempotent_replay() {
        let (_dir, registry) = registry();
        register_approved(&registry, stop_provider_contract()).expect("register");
        let calls = std::sync::Mutex::new(Vec::<(String, Value)>::new());
        let invoker = |operation: &str,
                       arguments: Value,
                       _site: &WorkflowCallSite<'_>|
         -> Result<Value, CoreError> {
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
            trigger: None,
            manual_run: false,
            paced_run: None,
            round_execution_id: None,
            workflow_id: "stop-provider-chats".to_owned(),
            arguments: json!({"provider": "claude"}),
            idempotency_key: "workflow-key-1".to_owned(),
            expected_version: None,
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
        register_approved(&registry, stop_provider_contract()).expect("register");
        let invoker = |operation: &str,
                       _arguments: Value,
                       _site: &WorkflowCallSite<'_>|
         -> Result<Value, CoreError> {
            match operation {
                "get_live_chats" => Ok(json!([{"chatId": "chat-1", "source": "claude"}])),
                "stop_chat" => Err(CoreError::Runtime("종료 실패".to_owned())),
                other => Err(CoreError::InvalidInput(format!("unexpected op {other}"))),
            }
        };
        let result = registry
            .execute(
                WorkflowExecuteRequest {
                    trigger: None,
                    manual_run: false,
                    paced_run: None,
                    round_execution_id: None,
                    workflow_id: "stop-provider-chats".to_owned(),
                    arguments: json!({"provider": "claude"}),
                    idempotency_key: "workflow-key-2".to_owned(),
                    expected_version: None,
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
        register_approved(&registry, stop_provider_chats_contract_for_inputs()).expect("register");
        let invoker = |_op: &str,
                       _arguments: Value,
                       _site: &WorkflowCallSite<'_>|
         -> Result<Value, CoreError> { Ok(json!([])) };
        let bad = registry.execute(
            WorkflowExecuteRequest {
                trigger: None,
                manual_run: false,
                paced_run: None,
                round_execution_id: None,
                workflow_id: "input-check".to_owned(),
                arguments: json!({"provider": "gemini"}),
                idempotency_key: "workflow-key-3".to_owned(),
                expected_version: None,
            },
            &invoker,
        );
        assert!(matches!(bad, Err(CoreError::InvalidInput(_))));
    }

    #[test]
    fn validate_inputs_rejects_non_object_arguments() {
        let contract = stop_provider_contract();
        for arguments in [json!(null), json!("claude"), json!(["claude"])] {
            let error = validate_inputs(&contract, &arguments).expect_err("non-object arguments");
            assert!(
                matches!(error, CoreError::InvalidInput(message) if message == "워크플로 입력은 객체여야 합니다")
            );
        }
    }

    #[test]
    fn declared_defaults_fill_omitted_inputs_and_must_match_the_declared_form() {
        // 값이 매번 같은 워크플로는 화면이 폼을 미리 채워 바로 실행할 수 있어야 하고,
        // 인자를 생략한 실행도 계약이 선언한 같은 값으로 돌아야 한다.
        let (_dir, registry) = registry();
        let mut contract = stop_provider_chats_contract_for_inputs();
        contract.steps[0].arguments = json!({"profile": {"$input": "provider"}});
        contract.input_schema.insert(
            "provider".to_owned(),
            serde_json::from_value(json!({
                "type": "enum",
                "values": ["codex", "claude"],
                "defaultValue": "claude"
            }))
            .expect("field"),
        );
        let summary = registry.propose(contract.clone()).expect("propose");
        assert_eq!(
            summary
                .pointer("/approvalSummary/inputSchema/provider/defaultValue")
                .and_then(Value::as_str),
            Some("claude"),
            "승인 요약이 기본값을 그대로 보여야 사용자가 무엇이 채워지는지 알 수 있다"
        );
        register_approved(&registry, contract).expect("register");

        let seen = std::cell::RefCell::new(Vec::new());
        let invoker = |_op: &str,
                       arguments: Value,
                       _site: &WorkflowCallSite<'_>|
         -> Result<Value, CoreError> {
            seen.borrow_mut().push(arguments);
            Ok(json!([]))
        };
        let result = registry
            .execute(
                WorkflowExecuteRequest {
                    trigger: None,
                    manual_run: false,
                    paced_run: None,
                    round_execution_id: None,
                    workflow_id: "input-check".to_owned(),
                    arguments: json!({}),
                    idempotency_key: "workflow-default-1".to_owned(),
                    expected_version: None,
                },
                &invoker,
            )
            .expect("execute");
        assert_eq!(result["succeeded"], true);
        assert_eq!(seen.borrow()[0]["profile"], json!("claude"));

        // 선언한 형·enum 값과 다른 기본값은 등록에서 걸러야 한다. 통과시키면 화면이 채운
        // 값 그대로 실행을 눌렀을 때 실행 단계에서야 거절된다.
        let mut wrong = stop_provider_chats_contract_for_inputs();
        wrong.input_schema.insert(
            "provider".to_owned(),
            serde_json::from_value(json!({
                "type": "enum",
                "values": ["codex", "claude"],
                "defaultValue": "gemini"
            }))
            .expect("field"),
        );
        assert!(matches!(
            registry.propose(wrong),
            Err(CoreError::InvalidInput(_))
        ));
        let mut mistyped = stop_provider_chats_contract_for_inputs();
        mistyped.input_schema.insert(
            "provider".to_owned(),
            serde_json::from_value(json!({"type": "number", "defaultValue": "여덟"}))
                .expect("field"),
        );
        assert!(matches!(
            registry.propose(mistyped),
            Err(CoreError::InvalidInput(_))
        ));
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
        register_approved(&registry, contract).expect("register");
        let invoker = |_op: &str,
                       _arguments: Value,
                       _site: &WorkflowCallSite<'_>|
         -> Result<Value, CoreError> { Ok(json!({"runtimeCount": 2})) };
        let result = registry
            .execute(
                WorkflowExecuteRequest {
                    trigger: None,
                    manual_run: false,
                    paced_run: None,
                    round_execution_id: None,
                    workflow_id: "verify-check".to_owned(),
                    arguments: json!({}),
                    idempotency_key: "workflow-key-4".to_owned(),
                    expected_version: None,
                },
                &invoker,
            )
            .expect("execute");
        assert_eq!(result["succeeded"], false);
        assert_eq!(result["failedStepId"], "verify");
        assert_eq!(result["retryable"], false);
    }

    #[test]
    fn steps_receive_the_call_site_with_workflow_execution_and_trigger() {
        // 출처는 인자 JSON이 아니라 호출부 인자로 간다. 계약이 무엇을 적어도 실행기가 아는
        // 워크플로·실행·트리거만 실린다.
        let (_dir, registry) = registry();
        register_approved(&registry, stop_provider_contract()).expect("register");
        let seen = std::cell::RefCell::new(Vec::new());
        let invoker = |operation: &str, _arguments: Value, site: &WorkflowCallSite<'_>| {
            seen.borrow_mut().push((
                operation.to_owned(),
                site.workflow_id.to_owned(),
                site.execution_id.to_owned(),
                site.trigger.map(|trigger| trigger.schedule_id.clone()),
            ));
            Ok(json!([]))
        };
        registry
            .execute(
                WorkflowExecuteRequest {
                    workflow_id: "stop-provider-chats".to_owned(),
                    arguments: json!({"provider": "claude"}),
                    idempotency_key: "call-site".to_owned(),
                    expected_version: None,
                    trigger: Some(WorkflowTrigger {
                        schedule_id: "schedule-1".to_owned(),
                        run_id: "run-1".to_owned(),
                    }),
                    manual_run: false,
                    paced_run: None,
                    round_execution_id: None,
                },
                &invoker,
            )
            .expect("execute");
        let seen = seen.borrow();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, "get_live_chats");
        assert_eq!(seen[0].1, "stop-provider-chats");
        assert!(seen[0].2.starts_with("wfexec-"));
        assert_eq!(seen[0].3.as_deref(), Some("schedule-1"));
        assert_eq!(seen[1].0, "get_live_chats");
        // 같은 실행의 모든 단계가 같은 실행 id를 받는다.
        assert_eq!(seen[0].2, seen[1].2);
    }
}
