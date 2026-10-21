//! 회차 목표와 회차 보고(M10 목표 카드).
//!
//! 사용자는 **목표**만 적는다 — "로컬 모델의 계획 프로토콜을 파인튜닝으로 굳힌다" 같은 한
//! 문단과 대상 경로·검증 방식·주기. 스크립트·시험·스킬·워크플로 계약은 AIA 가 회차 설계
//! 스킬을 따라 만들고, 등록은 승인 카드로 끝난다. 이 모듈은 그 목표와, 회차가 끝날 때 남기는
//! **구조화된 보고**(측정표·실패 종류·커밋·되돌린 것·사람이 정할 것)를 저장한다. 채팅
//! 마지막 턴의 글이 아니라 이 보고가 화면의 회차 이력과 "결정 대기" 목록이 된다.
//!
//! 스크립트를 여기서 돌리지는 않는다. 시스템 워크플로 엔진은 셸·파일 접근을 금하므로,
//! 회차는 지금처럼 워크플로가 띄운 에이전트 채팅이 돈다.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::CoreError;

const GOALS_STORE_VERSION: u32 = 1;
const GOALS_STORE: JsonStore = JsonStore {
    file: "round-goals-v1.json",
    lock_file: "round-goals-v1.lock",
    label: "회차 목표 저장소",
    version: GOALS_STORE_VERSION,
};

const REPORTS_STORE_VERSION: u32 = 1;
const REPORTS_STORE: JsonStore = JsonStore {
    file: "round-reports-v1.json",
    lock_file: "round-reports-v1.lock",
    label: "회차 보고 저장소",
    version: REPORTS_STORE_VERSION,
};

pub const MAX_ROUND_GOALS: usize = 32;
/// 보고는 회차마다 하나씩 쌓인다. 오래된 것부터 잘라 저장소가 끝없이 자라지 않게 한다.
pub const MAX_ROUND_REPORTS: usize = 400;
const MAX_TITLE_CHARS: usize = 120;
const MAX_TEXT_CHARS: usize = 4_000;
const MAX_LIST_ITEMS: usize = 40;
const MAX_ITEM_CHARS: usize = 400;

/// 목표가 어디까지 왔는지. 설계는 AIA 가, 나머지 전이는 사용자와 회차가 옮긴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RoundGoalStatus {
    /// 적어만 둔 목표. 설계 전.
    #[default]
    Draft,
    /// AIA 가 스킬·스크립트·시험·계약을 만드는 중.
    Designing,
    /// 설계가 등록됐다(스킬 게시·워크플로·반복 요청). 회차가 돈다.
    Active,
    /// 사용자가 멈춘 목표.
    Paused,
    /// 끝난 목표.
    Done,
}

/// 회차가 보고에 남긴 선택 요청을 누가 처리하는지.
///
/// 기존 저장소에는 이 칸이 없으므로 수동이 기본이다. 자동 모드는 다음 회차 에이전트에게
/// 판단·기록·후속 실행을 맡길 뿐, 새 권한이나 작업 범위를 부여하지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RoundDecisionMode {
    /// 다음 회차는 어떤 결정에도 답하지 않는다.
    #[default]
    Manual,
    /// 추천적용: `requires_human` 이 아니고 추천안이 있는 결정만 다음 회차가 추천안으로
    /// 답하고, 사람이 정해야 할 결정은 남긴다.
    Recommended,
    /// 완전자동: 다음 회차가 모든 미답 결정을 분석해 답한다.
    Automatic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundGoal {
    pub id: String,
    pub title: String,
    /// 무엇을 이루려는지 한 문단.
    pub goal: String,
    /// 회차가 일하는 경로(저장소·작업 폴더).
    pub target_path: String,
    /// 무엇을 재서 "됐다"고 볼지. 비어 있으면 설계가 정한다.
    #[serde(default)]
    pub verification: String,
    /// 주기. 반복 요청의 cron 이나 "auto". 비어 있으면 설계가 정한다.
    #[serde(default)]
    pub cadence: String,
    #[serde(default)]
    pub status: RoundGoalStatus,
    #[serde(default)]
    pub decision_mode: RoundDecisionMode,
    /// 설계가 만든 것들. AIA 가 등록한 뒤 여기 적는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    /// 설계 메모(무엇을 만들었고 무엇을 뺐는지).
    #[serde(default)]
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundGoalInput {
    pub title: String,
    pub goal: String,
    pub target_path: String,
    #[serde(default)]
    pub verification: String,
    #[serde(default)]
    pub cadence: String,
}

/// 부분 갱신. 없는 칸은 그대로 둔다. `Some(None)` 은 지운다.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundGoalPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub target_path: Option<String>,
    #[serde(default)]
    pub verification: Option<String>,
    #[serde(default)]
    pub cadence: Option<String>,
    #[serde(default)]
    pub status: Option<RoundGoalStatus>,
    #[serde(default)]
    pub decision_mode: Option<RoundDecisionMode>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub skill_key: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub workflow_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub schedule_id: Option<Option<String>>,
    #[serde(default)]
    pub notes: Option<String>,
}

fn deserialize_double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(deserializer)?))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalsStore {
    schema_version: u32,
    #[serde(default)]
    goals: Vec<RoundGoal>,
}

impl Default for GoalsStore {
    fn default() -> Self {
        Self {
            schema_version: GOALS_STORE_VERSION,
            goals: Vec::new(),
        }
    }
}

impl SchemaVersioned for GoalsStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

/// 한 레인(모델·환경)의 전후 수치. 수치는 글로 둔다 — "18/20", "실패 2종" 처럼 회차마다 모양이 다르다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundMeasure {
    pub label: String,
    #[serde(default)]
    pub before: String,
    #[serde(default)]
    pub after: String,
}

/// 실패 종류 하나의 전후 건수. 합격률이 아니라 이것이 판정이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundFailureKind {
    pub kind: String,
    #[serde(default)]
    pub before: u32,
    #[serde(default)]
    pub after: u32,
}

/// 사람이 정할 것. 회차는 측정까지 하고 결정은 여기 남긴다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundDecision {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<String>,
    /// 사용자가 고른 답. 비어 있으면 대기 중.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
    /// 되돌리기 어렵거나 밖으로 나가는 영향, 보안 트레이드오프, 제품·화면 정책처럼 사람이
    /// 꼭 정해야 하는 결정. 추천적용 모드에서도 자동으로 답하지 않는다. 옛 기록은 false.
    #[serde(default)]
    pub requires_human: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RoundOutcome {
    /// 고친 것이 재측정을 통과해 반영됐다.
    Pass,
    /// 측정만 하거나 일부만 반영했다.
    #[default]
    Partial,
    /// 되돌렸거나 막혔다.
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundReport {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub title: String,
    #[serde(default)]
    pub outcome: RoundOutcome,
    /// 요약. `\n` 으로 나눈 3~5줄을 기대한다 — 화면은 줄바꿈 없는 긴 글도 문장 끝에서 문단으로 나눠 보인다.
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub measures: Vec<RoundMeasure>,
    #[serde(default)]
    pub failure_kinds: Vec<RoundFailureKind>,
    #[serde(default)]
    pub fixes: Vec<String>,
    #[serde(default)]
    pub commits: Vec<String>,
    #[serde(default)]
    pub reverted: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<RoundDecision>,
    #[serde(default)]
    pub next: Vec<String>,
    pub recorded_at: i64,
}

/// 회차가 끝날 때 보내는 보고. id·시각은 저장소가 붙인다.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundReportInput {
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub schedule_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub title: String,
    #[serde(default)]
    pub outcome: RoundOutcome,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub measures: Vec<RoundMeasure>,
    #[serde(default)]
    pub failure_kinds: Vec<RoundFailureKind>,
    #[serde(default)]
    pub fixes: Vec<String>,
    #[serde(default)]
    pub commits: Vec<String>,
    #[serde(default)]
    pub reverted: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<RoundDecision>,
    #[serde(default)]
    pub next: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportsStore {
    schema_version: u32,
    #[serde(default)]
    reports: Vec<RoundReport>,
}

impl Default for ReportsStore {
    fn default() -> Self {
        Self {
            schema_version: REPORTS_STORE_VERSION,
            reports: Vec::new(),
        }
    }
}

impl SchemaVersioned for ReportsStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

/// 목록 조회 필터. 목표 하나의 이력만 보거나, 결정 대기만 본다.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundReportQuery {
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub pending_decisions: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

fn clean_text(value: &str, max: usize, what: &str) -> Result<String, CoreError> {
    // A report written on Windows carries CRLF (or a lone CR); refusing it as a control character
    // loses the whole report, so line endings are normalized before the check.
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let value = normalized.trim();
    if value
        .chars()
        .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(CoreError::InvalidInput(format!(
            "{what}에 제어문자가 있습니다"
        )));
    }
    if value.chars().count() > max {
        return Err(CoreError::InvalidInput(format!(
            "{what}은(는) {max}자 이하여야 합니다"
        )));
    }
    Ok(value.to_owned())
}

fn required_text(value: &str, max: usize, what: &str) -> Result<String, CoreError> {
    let value = clean_text(value, max, what)?;
    if value.is_empty() {
        return Err(CoreError::InvalidInput(format!("{what}을(를) 적으세요")));
    }
    Ok(value)
}

fn clean_list(items: &[String], what: &str) -> Result<Vec<String>, CoreError> {
    if items.len() > MAX_LIST_ITEMS {
        return Err(CoreError::InvalidInput(format!(
            "{what}은(는) {MAX_LIST_ITEMS}개 이하여야 합니다"
        )));
    }
    items
        .iter()
        .map(|item| clean_text(item, MAX_ITEM_CHARS, what))
        .filter(|item| !matches!(item, Ok(text) if text.is_empty()))
        .collect()
}

fn clean_optional_id(value: Option<&str>, what: &str) -> Result<Option<String>, CoreError> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(id) => Ok(Some(clean_text(id, 200, what)?)),
    }
}

// ---------------------------------------------------------------- 목표

pub fn list_round_goals(app_data_dir: &Path) -> Result<Vec<RoundGoal>, CoreError> {
    let store: GoalsStore = GOALS_STORE.read(app_data_dir)?;
    Ok(store.goals)
}

pub fn get_round_goal(app_data_dir: &Path, id: &str) -> Result<RoundGoal, CoreError> {
    list_round_goals(app_data_dir)?
        .into_iter()
        .find(|goal| goal.id == id)
        .ok_or_else(|| CoreError::NotFound(format!("회차 목표 {id} 이(가) 없습니다")))
}

pub fn create_round_goal(
    app_data_dir: &Path,
    input: RoundGoalInput,
) -> Result<RoundGoal, CoreError> {
    let now = now_ms();
    let goal = RoundGoal {
        id: new_id("goal"),
        title: required_text(&input.title, MAX_TITLE_CHARS, "목표 이름")?,
        goal: required_text(&input.goal, MAX_TEXT_CHARS, "목표")?,
        target_path: required_text(&input.target_path, 1_000, "대상 경로")?,
        verification: clean_text(&input.verification, MAX_TEXT_CHARS, "검증 방식")?,
        cadence: clean_text(&input.cadence, 200, "주기")?,
        status: RoundGoalStatus::Draft,
        decision_mode: RoundDecisionMode::Manual,
        skill_key: None,
        workflow_id: None,
        schedule_id: None,
        notes: String::new(),
        created_at: now,
        updated_at: now,
    };
    let saved = goal.clone();
    GOALS_STORE.update(app_data_dir, |store: &mut GoalsStore| {
        if store.goals.len() >= MAX_ROUND_GOALS {
            return Err(CoreError::InvalidInput(format!(
                "회차 목표는 {MAX_ROUND_GOALS}개까지 둘 수 있습니다"
            )));
        }
        store.goals.push(goal);
        Ok(true)
    })?;
    Ok(saved)
}

pub fn update_round_goal(
    app_data_dir: &Path,
    id: &str,
    patch: RoundGoalPatch,
) -> Result<RoundGoal, CoreError> {
    let title = patch
        .title
        .as_deref()
        .map(|value| required_text(value, MAX_TITLE_CHARS, "목표 이름"))
        .transpose()?;
    let goal_text = patch
        .goal
        .as_deref()
        .map(|value| required_text(value, MAX_TEXT_CHARS, "목표"))
        .transpose()?;
    let target_path = patch
        .target_path
        .as_deref()
        .map(|value| required_text(value, 1_000, "대상 경로"))
        .transpose()?;
    let verification = patch
        .verification
        .as_deref()
        .map(|value| clean_text(value, MAX_TEXT_CHARS, "검증 방식"))
        .transpose()?;
    let cadence = patch
        .cadence
        .as_deref()
        .map(|value| clean_text(value, 200, "주기"))
        .transpose()?;
    let notes = patch
        .notes
        .as_deref()
        .map(|value| clean_text(value, MAX_TEXT_CHARS, "설계 메모"))
        .transpose()?;
    let skill_key = patch
        .skill_key
        .map(|value| clean_optional_id(value.as_deref(), "스킬 키"))
        .transpose()?;
    let workflow_id = patch
        .workflow_id
        .map(|value| clean_optional_id(value.as_deref(), "워크플로 id"))
        .transpose()?;
    let schedule_id = patch
        .schedule_id
        .map(|value| clean_optional_id(value.as_deref(), "반복 요청 id"))
        .transpose()?;
    let id = id.trim().to_owned();
    let store = GOALS_STORE.update(app_data_dir, |store: &mut GoalsStore| {
        let goal = store
            .goals
            .iter_mut()
            .find(|goal| goal.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("회차 목표 {id} 이(가) 없습니다")))?;
        if let Some(value) = title.clone() {
            goal.title = value;
        }
        if let Some(value) = goal_text.clone() {
            goal.goal = value;
        }
        if let Some(value) = target_path.clone() {
            goal.target_path = value;
        }
        if let Some(value) = verification.clone() {
            goal.verification = value;
        }
        if let Some(value) = cadence.clone() {
            goal.cadence = value;
        }
        if let Some(value) = patch.status {
            goal.status = value;
        }
        if let Some(value) = patch.decision_mode {
            goal.decision_mode = value;
        }
        if let Some(value) = notes.clone() {
            goal.notes = value;
        }
        if let Some(value) = skill_key.clone() {
            goal.skill_key = value;
        }
        if let Some(value) = workflow_id.clone() {
            goal.workflow_id = value;
        }
        if let Some(value) = schedule_id.clone() {
            goal.schedule_id = value;
        }
        goal.updated_at = now_ms();
        Ok(true)
    })?;
    store
        .goals
        .into_iter()
        .find(|goal| goal.id == id)
        .ok_or_else(|| CoreError::NotFound(format!("회차 목표 {id} 이(가) 없습니다")))
}

pub fn delete_round_goal(app_data_dir: &Path, id: &str) -> Result<(), CoreError> {
    let id = id.trim().to_owned();
    GOALS_STORE.update(app_data_dir, |store: &mut GoalsStore| {
        let before = store.goals.len();
        store.goals.retain(|goal| goal.id != id);
        if store.goals.len() == before {
            return Err(CoreError::NotFound(format!(
                "회차 목표 {id} 이(가) 없습니다"
            )));
        }
        Ok(true)
    })?;
    Ok(())
}

// ---------------------------------------------------------------- 보고

pub fn record_round_report(
    app_data_dir: &Path,
    input: RoundReportInput,
) -> Result<RoundReport, CoreError> {
    let goal_id = clean_optional_id(input.goal_id.as_deref(), "목표 id")?;
    if let Some(goal_id) = &goal_id {
        // 없는 목표에 보고를 붙이면 화면 어디에도 안 보인다. 목표를 적었으면 실재해야 한다.
        get_round_goal(app_data_dir, goal_id)?;
    }
    let mut decisions = Vec::new();
    for decision in input.decisions.iter().take(MAX_LIST_ITEMS) {
        decisions.push(RoundDecision {
            question: required_text(&decision.question, MAX_ITEM_CHARS, "결정 질문")?,
            options: clean_list(&decision.options, "선택지")?,
            recommendation: decision
                .recommendation
                .as_deref()
                .map(|value| clean_text(value, MAX_ITEM_CHARS, "추천안"))
                .transpose()?
                .filter(|value| !value.is_empty()),
            resolved: None,
            requires_human: decision.requires_human,
        });
    }
    let mut measures = Vec::new();
    for measure in input.measures.iter().take(MAX_LIST_ITEMS) {
        measures.push(RoundMeasure {
            label: required_text(&measure.label, MAX_ITEM_CHARS, "측정 이름")?,
            before: clean_text(&measure.before, MAX_ITEM_CHARS, "측정 전")?,
            after: clean_text(&measure.after, MAX_ITEM_CHARS, "측정 후")?,
        });
    }
    let mut failure_kinds = Vec::new();
    for kind in input.failure_kinds.iter().take(MAX_LIST_ITEMS) {
        failure_kinds.push(RoundFailureKind {
            kind: required_text(&kind.kind, MAX_ITEM_CHARS, "실패 종류")?,
            before: kind.before,
            after: kind.after,
        });
    }
    let report = RoundReport {
        id: new_id("round"),
        goal_id,
        schedule_id: clean_optional_id(input.schedule_id.as_deref(), "반복 요청 id")?,
        run_id: clean_optional_id(input.run_id.as_deref(), "실행 id")?,
        session_id: clean_optional_id(input.session_id.as_deref(), "세션 id")?,
        source: clean_optional_id(input.source.as_deref(), "공급자")?,
        title: required_text(&input.title, MAX_TITLE_CHARS, "보고 제목")?,
        outcome: input.outcome,
        summary: clean_text(&input.summary, MAX_TEXT_CHARS, "요약")?,
        measures,
        failure_kinds,
        fixes: clean_list(&input.fixes, "고친 것")?,
        commits: clean_list(&input.commits, "커밋")?,
        reverted: clean_list(&input.reverted, "되돌린 것")?,
        decisions,
        next: clean_list(&input.next, "다음 회차")?,
        recorded_at: now_ms(),
    };
    let saved = report.clone();
    REPORTS_STORE.update(app_data_dir, |store: &mut ReportsStore| {
        store.reports.push(report);
        if store.reports.len() > MAX_ROUND_REPORTS {
            let excess = store.reports.len() - MAX_ROUND_REPORTS;
            store.reports.drain(..excess);
        }
        Ok(true)
    })?;
    Ok(saved)
}

pub fn list_round_reports(
    app_data_dir: &Path,
    query: RoundReportQuery,
) -> Result<Vec<RoundReport>, CoreError> {
    let store: ReportsStore = REPORTS_STORE.read(app_data_dir)?;
    let goal_id = query
        .goal_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let mut reports: Vec<RoundReport> = store
        .reports
        .into_iter()
        .rev()
        .filter(|report| goal_id.is_none_or(|id| report.goal_id.as_deref() == Some(id)))
        .filter(|report| {
            !query.pending_decisions
                || report
                    .decisions
                    .iter()
                    .any(|decision| decision.resolved.is_none())
        })
        .collect();
    if let Some(limit) = query.limit {
        reports.truncate(limit.clamp(1, MAX_ROUND_REPORTS));
    }
    Ok(reports)
}

pub fn get_round_report(app_data_dir: &Path, id: &str) -> Result<RoundReport, CoreError> {
    let store: ReportsStore = REPORTS_STORE.read(app_data_dir)?;
    store
        .reports
        .into_iter()
        .find(|report| report.id == id.trim())
        .ok_or_else(|| CoreError::NotFound(format!("회차 보고 {id} 이(가) 없습니다")))
}

/// 워크플로가 띄울 다음 회차에 붙일 자동 결정 안내의 최소 정보.
/// 질문 원문은 프롬프트에 복제하지 않고 에이전트가 읽기 도구로 최신 저장소를 조회한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundDecisionAutomationBrief {
    pub goal_id: String,
    pub goal_title: String,
    /// 자동 답의 범위. `Recommended` 면 `pending_count` 는 추천안으로 답할 결정만 센다.
    pub mode: RoundDecisionMode,
    pub pending_count: usize,
}

/// 반복 요청 id가 있으면 그것을 우선하고, 수동 실행이면 워크플로 id로 목표를 찾는다.
/// 수동 모드인 목표에는 안내를 만들지 않고, 추천적용 모드는 답할 결정이 없으면 만들지 않는다.
pub fn round_decision_automation_brief(
    app_data_dir: &Path,
    schedule_id: Option<&str>,
    workflow_id: &str,
) -> Result<Option<RoundDecisionAutomationBrief>, CoreError> {
    let goals = list_round_goals(app_data_dir)?;
    let goal = match schedule_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(schedule_id) => goals
            .into_iter()
            .find(|goal| goal.schedule_id.as_deref() == Some(schedule_id)),
        None => goals.into_iter().find(|goal| {
            goal.workflow_id.as_deref() == Some(workflow_id.trim())
                && goal.status == RoundGoalStatus::Active
        }),
    };
    let Some(goal) = goal.filter(|goal| {
        goal.status == RoundGoalStatus::Active && goal.decision_mode != RoundDecisionMode::Manual
    }) else {
        return Ok(None);
    };
    let mode = goal.decision_mode;
    let pending_count = list_round_reports(
        app_data_dir,
        RoundReportQuery {
            goal_id: Some(goal.id.clone()),
            pending_decisions: true,
            limit: None,
        },
    )?
    .iter()
    .map(|report| {
        report
            .decisions
            .iter()
            .filter(|decision| decision.resolved.is_none())
            .filter(|decision| match mode {
                RoundDecisionMode::Recommended => {
                    !decision.requires_human && decision.recommendation.is_some()
                }
                _ => true,
            })
            .count()
    })
    .sum();
    if mode == RoundDecisionMode::Recommended && pending_count == 0 {
        return Ok(None);
    }
    Ok(Some(RoundDecisionAutomationBrief {
        goal_id: goal.id,
        goal_title: goal.title,
        mode,
        pending_count,
    }))
}

/// 결정을 한 번 닫는다. 수동 모드에서는 사람이, 완전자동 모드에서는 회차 에이전트가 적는다.
/// 병렬 회차가 같은 질문을 함께 읽어도 먼저 쓴 답을 나중 답이 덮어쓰지 못한다.
pub fn resolve_round_decision(
    app_data_dir: &Path,
    report_id: &str,
    index: usize,
    answer: &str,
) -> Result<RoundReport, CoreError> {
    let answer = required_text(answer, MAX_ITEM_CHARS, "결정")?;
    let report_id = report_id.trim().to_owned();
    let store = REPORTS_STORE.update(app_data_dir, |store: &mut ReportsStore| {
        let report = store
            .reports
            .iter_mut()
            .find(|report| report.id == report_id)
            .ok_or_else(|| CoreError::NotFound(format!("회차 보고 {report_id} 이(가) 없습니다")))?;
        let decision = report.decisions.get_mut(index).ok_or_else(|| {
            CoreError::NotFound(format!("보고에 {}번째 결정이 없습니다", index + 1))
        })?;
        if let Some(resolved) = &decision.resolved {
            if resolved == &answer {
                return Ok(false);
            }
            return Err(CoreError::Conflict(
                "이 선택 요청은 다른 회차에서 이미 처리했습니다".to_owned(),
            ));
        }
        decision.resolved = Some(answer.clone());
        Ok(true)
    })?;
    store
        .reports
        .into_iter()
        .find(|report| report.id == report_id)
        .ok_or_else(|| CoreError::NotFound(format!("회차 보고 {report_id} 이(가) 없습니다")))
}

pub fn delete_round_report(app_data_dir: &Path, id: &str) -> Result<(), CoreError> {
    let id = id.trim().to_owned();
    REPORTS_STORE.update(app_data_dir, |store: &mut ReportsStore| {
        let before = store.reports.len();
        store.reports.retain(|report| report.id != id);
        if store.reports.len() == before {
            return Err(CoreError::NotFound(format!(
                "회차 보고 {id} 이(가) 없습니다"
            )));
        }
        Ok(true)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("agent-manager-rounds-")
            .tempdir()
            .expect("임시 폴더")
    }

    fn goal_input() -> RoundGoalInput {
        RoundGoalInput {
            title: "계획 프로토콜 파인튜닝".to_owned(),
            goal: "통과 궤적으로 LoRA 를 학습해 계획 규율을 굳힌다".to_owned(),
            target_path: "F:/repo".to_owned(),
            verification: "학습에 없는 과제로 n>=20".to_owned(),
            cadence: "0 3 * * *".to_owned(),
        }
    }

    // M10: 목표는 사용자가 적고 설계 산출물(스킬·워크플로·반복 요청)은 AIA 가 뒤에 붙인다.
    #[test]
    fn a_goal_is_created_as_a_draft_and_the_design_links_are_patched_later() {
        let dir = temp_dir();
        let goal = create_round_goal(dir.path(), goal_input()).unwrap();
        assert_eq!(goal.status, RoundGoalStatus::Draft);
        assert_eq!(goal.decision_mode, RoundDecisionMode::Manual);
        assert!(goal.skill_key.is_none());
        let linked = update_round_goal(
            dir.path(),
            &goal.id,
            RoundGoalPatch {
                status: Some(RoundGoalStatus::Active),
                skill_key: Some(Some("local-model-finetune-round".to_owned())),
                schedule_id: Some(Some("schedule-1".to_owned())),
                notes: Some("스크립트 넷·시험 하나".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(linked.status, RoundGoalStatus::Active);
        assert_eq!(
            linked.skill_key.as_deref(),
            Some("local-model-finetune-round")
        );
        assert_eq!(linked.schedule_id.as_deref(), Some("schedule-1"));
        let automatic = update_round_goal(
            dir.path(),
            &goal.id,
            RoundGoalPatch {
                decision_mode: Some(RoundDecisionMode::Automatic),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(automatic.decision_mode, RoundDecisionMode::Automatic);
        // 빈 문자열로 지운다. 다른 칸은 그대로다.
        let cleared = update_round_goal(
            dir.path(),
            &goal.id,
            RoundGoalPatch {
                schedule_id: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(cleared.schedule_id.is_none());
        assert_eq!(
            cleared.skill_key.as_deref(),
            Some("local-model-finetune-round")
        );
        assert_eq!(list_round_goals(dir.path()).unwrap().len(), 1);
        assert!(create_round_goal(
            dir.path(),
            RoundGoalInput {
                title: "  ".to_owned(),
                ..goal_input()
            }
        )
        .is_err());
        delete_round_goal(dir.path(), &goal.id).unwrap();
        assert!(delete_round_goal(dir.path(), &goal.id).is_err());
    }

    #[test]
    fn a_report_carries_failure_kinds_and_pending_decisions_until_a_person_answers() {
        let dir = temp_dir();
        let goal = create_round_goal(dir.path(), goal_input()).unwrap();
        let report = record_round_report(
            dir.path(),
            RoundReportInput {
                goal_id: Some(goal.id.clone()),
                title: "web-to-notion 재측정".to_owned(),
                outcome: RoundOutcome::Pass,
                summary: "가드 뒤 노션→write 종류가 사라졌다".to_owned(),
                measures: vec![RoundMeasure {
                    label: "GPU".to_owned(),
                    before: "18/20".to_owned(),
                    after: "18/20".to_owned(),
                }],
                failure_kinds: vec![RoundFailureKind {
                    kind: "노션 → write".to_owned(),
                    before: 2,
                    after: 0,
                }],
                commits: vec!["6766b276".to_owned()],
                decisions: vec![RoundDecision {
                    question: "기본 모델을 바꿀까".to_owned(),
                    options: vec!["바꾼다".to_owned(), "둔다".to_owned()],
                    recommendation: Some("둔다".to_owned()),
                    resolved: Some("무시된다".to_owned()),
                    requires_human: true,
                }],
                ..Default::default()
            },
        )
        .unwrap();
        // 보고가 들고 온 resolved 는 버린다 — 결정은 사람이 적는다.
        assert!(report.decisions[0].resolved.is_none());
        // requiresHuman 은 회차가 판단해 올린 값이라 그대로 남는다.
        assert!(report.decisions[0].requires_human);
        let pending = list_round_reports(
            dir.path(),
            RoundReportQuery {
                pending_decisions: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(pending.len(), 1);
        let answered = resolve_round_decision(dir.path(), &report.id, 0, "둔다").unwrap();
        assert_eq!(answered.decisions[0].resolved.as_deref(), Some("둔다"));
        assert!(resolve_round_decision(dir.path(), &report.id, 0, "둔다").is_ok());
        assert!(matches!(
            resolve_round_decision(dir.path(), &report.id, 0, "바꾼다"),
            Err(CoreError::Conflict(message)) if message.contains("이미 처리")
        ));
        assert!(list_round_reports(
            dir.path(),
            RoundReportQuery {
                pending_decisions: true,
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty());
        // 목표별 조회와 없는 목표 거절.
        assert_eq!(
            list_round_reports(
                dir.path(),
                RoundReportQuery {
                    goal_id: Some(goal.id.clone()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert!(record_round_report(
            dir.path(),
            RoundReportInput {
                goal_id: Some("goal-없음".to_owned()),
                title: "x".to_owned(),
                ..Default::default()
            }
        )
        .is_err());
        assert!(resolve_round_decision(dir.path(), &report.id, 5, "x").is_err());
        assert_eq!(
            get_round_report(dir.path(), &report.id).unwrap().commits,
            vec!["6766b276"]
        );
        delete_round_report(dir.path(), &report.id).unwrap();
        assert!(get_round_report(dir.path(), &report.id).is_err());
    }

    #[test]
    fn decision_mode_and_requires_human_round_trip_and_default_for_old_records() {
        // 옛 기록에는 두 칸이 없다 — 수동, 사람 결정 아님으로 읽혀야 한다.
        let old: RoundDecision = serde_json::from_str(r#"{"question":"q"}"#).unwrap();
        assert!(!old.requires_human);
        let decision: RoundDecision =
            serde_json::from_str(r#"{"question":"q","requiresHuman":true}"#).unwrap();
        assert!(decision.requires_human);
        assert_eq!(
            serde_json::to_value(&decision).unwrap()["requiresHuman"],
            serde_json::json!(true)
        );
        assert_eq!(
            serde_json::to_value(RoundDecisionMode::Recommended).unwrap(),
            serde_json::json!("recommended")
        );
        assert_eq!(
            serde_json::from_str::<RoundDecisionMode>(r#""recommended""#).unwrap(),
            RoundDecisionMode::Recommended
        );
        let dir = temp_dir();
        let goal = create_round_goal(dir.path(), goal_input()).unwrap();
        let updated = update_round_goal(
            dir.path(),
            &goal.id,
            RoundGoalPatch {
                decision_mode: Some(RoundDecisionMode::Recommended),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.decision_mode, RoundDecisionMode::Recommended);
        assert_eq!(
            get_round_goal(dir.path(), &goal.id).unwrap().decision_mode,
            RoundDecisionMode::Recommended
        );
    }

    #[test]
    fn automatic_decision_brief_matches_the_owned_schedule_and_counts_pending_questions() {
        let dir = temp_dir();
        let goal = create_round_goal(dir.path(), goal_input()).unwrap();
        update_round_goal(
            dir.path(),
            &goal.id,
            RoundGoalPatch {
                status: Some(RoundGoalStatus::Active),
                decision_mode: Some(RoundDecisionMode::Automatic),
                workflow_id: Some(Some("round-workflow".to_owned())),
                schedule_id: Some(Some("schedule-1".to_owned())),
                ..Default::default()
            },
        )
        .unwrap();
        record_round_report(
            dir.path(),
            RoundReportInput {
                goal_id: Some(goal.id.clone()),
                title: "판단 대기".to_owned(),
                decisions: vec![
                    RoundDecision {
                        question: "첫째".to_owned(),
                        options: vec!["A".to_owned()],
                        recommendation: Some("A".to_owned()),
                        resolved: None,
                        requires_human: false,
                    },
                    RoundDecision {
                        question: "둘째".to_owned(),
                        options: vec![],
                        recommendation: None,
                        resolved: None,
                        requires_human: false,
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let scheduled =
            round_decision_automation_brief(dir.path(), Some("schedule-1"), "unrelated-workflow")
                .unwrap()
                .expect("automatic brief");
        assert_eq!(scheduled.goal_id, goal.id);
        assert_eq!(scheduled.mode, RoundDecisionMode::Automatic);
        assert_eq!(scheduled.pending_count, 2);
        assert!(round_decision_automation_brief(
            dir.path(),
            Some("another-schedule"),
            "round-workflow"
        )
        .unwrap()
        .is_none());
        assert!(
            round_decision_automation_brief(dir.path(), None, "round-workflow")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_recommended_brief_counts_only_answerable_decisions_and_is_absent_without_them() {
        let dir = temp_dir();
        let goal = create_round_goal(dir.path(), goal_input()).unwrap();
        update_round_goal(
            dir.path(),
            &goal.id,
            RoundGoalPatch {
                status: Some(RoundGoalStatus::Active),
                decision_mode: Some(RoundDecisionMode::Recommended),
                schedule_id: Some(Some("schedule-r".to_owned())),
                ..Default::default()
            },
        )
        .unwrap();
        let decision = |recommendation: Option<&str>, requires_human: bool| RoundDecision {
            question: "질문".to_owned(),
            options: vec!["A".to_owned()],
            recommendation: recommendation.map(str::to_owned),
            resolved: None,
            requires_human,
        };
        record_round_report(
            dir.path(),
            RoundReportInput {
                goal_id: Some(goal.id.clone()),
                title: "사람 몫만".to_owned(),
                decisions: vec![decision(Some("A"), true), decision(None, false)],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            round_decision_automation_brief(dir.path(), Some("schedule-r"), "w")
                .unwrap()
                .is_none()
        );
        record_round_report(
            dir.path(),
            RoundReportInput {
                goal_id: Some(goal.id.clone()),
                title: "추천 가능".to_owned(),
                decisions: vec![decision(Some("A"), false)],
                ..Default::default()
            },
        )
        .unwrap();
        let brief = round_decision_automation_brief(dir.path(), Some("schedule-r"), "w")
            .unwrap()
            .expect("recommended brief");
        assert_eq!(brief.mode, RoundDecisionMode::Recommended);
        assert_eq!(brief.pending_count, 1);
        assert_eq!(serde_json::json!(brief)["mode"], "recommended");
    }

    #[test]
    fn reports_are_newest_first_and_capped() {
        let dir = temp_dir();
        for index in 0..3 {
            record_round_report(
                dir.path(),
                RoundReportInput {
                    title: format!("r{index}"),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let listed = list_round_reports(
            dir.path(),
            RoundReportQuery {
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            listed.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(),
            vec!["r2", "r1"]
        );
    }

    #[test]
    fn clean_text_accepts_and_normalizes_crlf_and_cr() {
        let dir = temp_dir();
        let report = record_round_report(
            dir.path(),
            RoundReportInput {
                title: "CRLF 테스트\r\n".to_string(),
                summary: "줄1\r\n줄2\r줄3\n".to_string(),
                fixes: vec!["수정1\r\n".to_string()],
                ..Default::default()
            },
        )
        .expect("crlf text should be accepted and normalized");

        assert_eq!(report.title, "CRLF 테스트");
        assert_eq!(report.summary, "줄1\n줄2\n줄3");
        assert_eq!(report.fixes, vec!["수정1".to_string()]);

        let err = record_round_report(
            dir.path(),
            RoundReportInput {
                title: "정상 제목".to_string(),
                summary: "제어문자\x00포함".to_string(),
                ..Default::default()
            },
        )
        .expect_err("null char must be rejected");
        assert!(matches!(err, CoreError::InvalidInput(_)));
    }
}
