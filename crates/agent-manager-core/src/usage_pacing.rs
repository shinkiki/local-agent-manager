//! 사용량 창을 남은 기간에 걸쳐 목표치까지 채우는 회차 계획.
//!
//! 워크플로 계약은 산술과 임계 비교를 표현할 수 없고(`system_workflows.rs` 참고),
//! 반복 요청의 워크플로 회차는 인자가 저장 시점에 고정된다. 그래서 "이번 회차에 몇
//! 건을 돌릴지"는 계약이나 인자가 아니라 이 모듈이 정하고, 워크플로는 그 결과 배열을
//! `forEach`로 순회해 기동만 한다.
//!
//! 회당 소비량은 선언하지 않고 관측한다. 사용량 갱신마다 창별 표본을 남기고, 지난
//! 회차가 실제로 몇 건을 띄웠는지와 맞춰 회당 %p를 실측한다. 표본이 없을 때만 요청이
//! 준 대체값을 쓴다.
//!
//! 대체값은 근거가 없으므로 그 값으로 병렬을 세우지 않는다. 자기 계획 창의 회당 소비가
//! 아직 실측되지 않은 계정은 병렬 설정과 무관하게 이번 회차에 **첫 측정 1건**만 받고,
//! 그 실행이 도는 동안은 더 받지 않는다([`limit_account_runs`]). 실측이 잡히면 다음
//! 회차부터 여력만큼 병렬로 배정된다. 2026-09-24 QA 회차에서 실측 없는 Codex 계정 셋이
//! 대체값 0.5%p로 계정당 2건씩 받아 8분 만에 5시간 창을 100%로 채운 일이 계기다 —
//! 실제 회당 소비는 7~8%p였다.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::accounts::{AccountUsageStatus, AccountUsageView, ProviderAccountView};
use crate::app_data_file::write_private_json;
use crate::chat::{ChatSessionInfo, ReasoningEffort};
use crate::clock::now_ms;
use crate::domain::{ProviderId, TokenUsage};
use crate::quiet_hours::QuietSchedule;
use crate::scheduler::{ScheduledRequest, ScheduledRequestInput};
use crate::store_lock;
use crate::usage_budget::{self, Claim, ConsumerDemand, PlanPoint, RunSpan};
use crate::usage_budget_policy::{self, LaneReasoningEffort, UsageBudgetPolicy};
use crate::CoreError;

const STORE_FILE: &str = "aia-usage-pacing-v1.json";
const STORE_LOCK_FILE: &str = "aia-usage-pacing-v1.lock";
const STORE_VERSION: u32 = 1;

/// 계정·창당 보관하는 표본 수. 5시간 창이 리셋을 몇 번 돌 만큼만 남긴다. 다만 실행을
/// 괄호 치는 표본은 이 수를 넘겨도 남긴다([`trim_series`]) — 사용량 갱신은 값이 바뀌지
/// 않아도 표본을 남기므로, 그냥 오래된 것부터 버리면 같은 값의 사본이 정작 실측에 쓰는
/// 표본을 밀어낸다.
const MAX_SAMPLES_PER_SERIES: usize = 96;
/// 지켜 준 표본까지 합친 절대 상한. 실행 기록이 상한(`MAX_RUN_RECORDS`)까지 차 있으면
/// 실행마다 앞뒤 두 개씩 지키므로 그만큼을 더 잡는다.
const MAX_SAMPLES_PER_SERIES_HARD_CAP: usize = MAX_SAMPLES_PER_SERIES + 2 * MAX_RUN_RECORDS;
/// 보관하는 회차 계획 기록 수. 회당 비용 실측이 참조하는 구간만 남긴다.
const MAX_PLAN_RECORDS: usize = 64;
/// 실측 구간의 끝점을 회차 간격의 몇 배까지 인정할지. 반복 요청을 멈췄다 켜면 마지막
/// 계획 기록과 다음 표본 사이가 임의로 벌어지는데, 그 사이 소비는 그 회차의 기동과
/// 무관하다. 구간을 닫지 않으면 중지 기간의 소비가 통째로 회당 비용에 실린다.
const MAX_MEASUREMENT_SPAN_FACTOR: i64 = 2;
/// 소비자를 "활성"으로 볼 최근 기록의 범위(회차 간격의 배수). 이 안에 기록이 없는
/// 소비자는 쉬는 것으로 보고 그 몫을 남에게 넘긴다.
const ACTIVE_CONSUMER_SPAN_FACTOR: i64 = 2;
/// 반복 요청에 매이지 않은 호출(수동·AIA)의 소비자 id.
const ADHOC_CONSUMER_ID: &str = "adhoc";
/// 보관하는 실행 기록 수. 회차별 회당 소비 실측이 참조하는 최근 실행만 남긴다.
const MAX_RUN_RECORDS: usize = 256;
/// 실행이 끝난 뒤 "다음 표본"을 기다리는 여유. 턴 종료 훅이 사용량을 갱신하므로 보통
/// 1분 안에 들어오고, 이 안에 없으면 그 실행은 괄호 칠 수 없어 버린다. 다만 종료 훅의
/// 갱신이 재시도 유예(`retry_at`)에 걸리거나 화면 폴링이 멈춰 있으면 다음 표본이 한참
/// 뒤에 온다. 그 사이 소비는 대부분 이 실행의 것이므로 10분에서 끊지 않는다.
const RUN_AFTER_SAMPLE_GRACE_MS: i64 = 30 * 60_000;

/// 두 표본이 같은 창을 보고 있는지. 리셋 시각의 흔들림 허용과 창 열림(0%·시각 없음 →
/// 시각 있음) 판정은 예약과 같은 규칙이다([`usage_budget::same_window`]).
fn same_reset_window(before: &UsageSample, after: &UsageSample) -> bool {
    usage_budget::same_window(before.used_percent, before.resets_at, after.resets_at)
}
/// 정책도 기록된 계획도 창 이름을 말하지 않을 때 쓰는 기본 창.
const DEFAULT_WINDOW_LABEL: &str = "7일";
/// 회당 비용 실측에 쓰는 최근 구간 수의 기본값. 요청이 `costWindows`로 덮어쓸 수 있다.
const DEFAULT_COST_WINDOWS: usize = 5;
/// 실측 구간 수의 상한. 보관하는 계획 기록 수를 넘겨 봐야 볼 구간이 더 없다.
const MAX_COST_WINDOWS: usize = MAX_PLAN_RECORDS;
/// 회당 비용의 하한 기본값(%p). 0으로 나누는 것을 막고, 근거 없이 큰 회차를 만들지
/// 않도록 보수적으로 잡는다. 요청이 `minCostPercentPerRun`으로 덮어쓸 수 있다.
const DEFAULT_MIN_COST_PERCENT_PER_RUN: f64 = 0.5;
/// 회당 비용 하한으로 받아들이는 범위. 0 이하는 나눗셈을 무너뜨리고, 너무 크면 어떤
/// 계정도 회차 예산을 넘지 못해 영원히 쉬게 된다.
const MIN_COST_FLOOR: f64 = 0.01;
const MAX_COST_FLOOR: f64 = 50.0;
/// 소진 중인 계정이 계획 창·가드 창에 쓰는 목표(%). 목표에서 멈추면 창이 비지 않아
/// 공급자가 리셋 크레딧을 물리고(`nothingToReset`) 창은 반쯤 찬 채로 남는다 — 남겨 둔
/// 크레딧을 쓸 길이 없어져 소진 모드가 한 바퀴도 돌지 못한다. 되돌릴 크레딧이 있는
/// 동안만 이 값을 쓰고, 예비 장수까지 줄면 종전 목표·가드로 돌아온다.
const DRAIN_TARGET_PERCENT: f64 = 100.0;
/// 계획 기록이 없을 때 쓰는 회차 간격. 현황 조회·소진 판정은 계획 요청 밖이라 간격을
/// 인자로 받지 못한다.
const FALLBACK_CADENCE_MS: i64 = 5 * 60 * 60_000;

/// 소진 모드가 이 계정을 지금 몰아 쓰는지. 크레딧이 없거나 예비 장수만 남은 계정은 되돌릴
/// 수단이 없는 것과 같아 대상이 아니다 — 몰아 쓰기만 하고 창을 비운 채로 두면 남은 기간
/// 내내 그 계정이 멈춰 균등 페이싱보다 나쁘다.
pub(crate) fn draining_account(policy: &UsageBudgetPolicy, usage: &AccountUsageView) -> bool {
    policy.defaults.drain
        && usage
            .reset_credits
            .as_ref()
            .is_some_and(|credits| credits.available_count > policy.defaults.drain_reserve())
}

/// 사용량 창 표본 하나. `resets_at`이 지터를 넘게 움직이거나 `used_percent`가 줄면 창이
/// 리셋된 것이므로 그 경계를 넘는 구간은 비용 실측에서 버린다([`same_reset_window`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageSample {
    at: i64,
    used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRecordEntry {
    account_id: String,
    count: usize,
    /// 이 계정이 그때 채운 창. 회차 창과 다른 계정만 채워진다(Antigravity 모델군 창).
    ///
    /// 회차 창 하나로만 기록하면 같은 계정에 모델군이 다른 회차 둘이 예약을 남겼을 때 서로를
    /// 자기 창의 미정산으로 읽는다 — 두 창이 모두 "미시작"이면 예약 기준선(0%·리셋 없음)까지
    /// 같아 창 판정도 통과하고, 한쪽의 첫 기동이 다른 쪽을 막는다. 회당 소비 실측도 남의
    /// 모델군 기동 수를 분모에 넣어 값을 낮춘다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_label: Option<String>,
    /// 예약 시점에 예상한 소비(%p) = 기동 수 × 회당 소비. 다른 소비자가 이 계정의 여유를
    /// 계산할 때 미정산 금액으로 차감한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_cost_percent: Option<f64>,
    /// 예약 시점의 창 사용률·리셋 시각. 이후 오른 만큼을 정산에 쓰고, 리셋되면 무효.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    used_percent_at_claim: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resets_at_at_claim: Option<i64>,
    /// 함께 지키는 짧은 창(가드 창)마다 남긴 같은 예약. 키는 예약 시점에 계정이 보고한 창
    /// 라벨이다 — 공급자가 창 길이를 바꾸면(Codex는 라벨이 창 길이를 따른다) 새 라벨의
    /// 예약이 새로 시작되고 옛 라벨의 예약은 맞는 창이 없어 그냥 소멸한다. 없는 옛 기록은
    /// 계획 창 예약만 있는 것으로 읽는다.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    guards: BTreeMap<String, WindowClaim>,
}

/// 계획 창이 아닌 창 하나에 남긴 예약. `PlanRecordEntry`의 계획 창 필드와 같은 뜻이다.
/// 회당 소비를 아직 실측하지 못한 창은 기대 소비 없이 기준선만 남긴다 — 그 예약은 정산에
/// 들어가지 않고, 대신 계획이 "이 계정에 진행 중 실행이 있는가"로 막는다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowClaim {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_cost_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    used_percent_at_claim: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resets_at_at_claim: Option<i64>,
}

/// 한 회차가 실제로 계획한 기동. 다음 회차가 "그 사이 사용량이 얼마나 올랐는지"를
/// 이 기록으로 나눠 회당 비용을 실측한다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRecord {
    at: i64,
    window_label: String,
    entries: Vec<PlanRecordEntry>,
    /// 이 계획을 남긴 소비자(반복 요청 id, 없으면 워크플로 id나 `adhoc`). 없는 옛 기록은
    /// 측정에만 쓰이고 예약·배분에는 들어가지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consumer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workflow_id: Option<String>,
    /// 발행 소비자의 회차 간격. 예약의 수명이고 측정 그룹을 묶는 기준이다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cadence_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    /// 그 소비자의 회차 기동 상한. 다른 소비자가 배분할 때 이 소비자의 수요로 본다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_runs: Option<usize>,
    /// 이 계획을 낸 워크플로 실행. 같은 실행이 띄운 채팅의 출처와 같아, 그 채팅들이 모두
    /// 끝나고 표본이 뒤따르면 예약이 정확히 정산된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_id: Option<String>,
}

/// 출처가 있는 무인 런타임 하나의 생명주기. 시작·종료 시각으로 사용량 표본을 괄호 쳐
/// 회차별 회당 소비를 잰다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    chat_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_id: Option<String>,
    consumer_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workflow_id: Option<String>,
    account_id: String,
    provider: ProviderId,
    started_at: i64,
    /// 마지막 턴이 끝난 시각. 없으면 아직 돌고 있다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_session_id: Option<String>,
    /// 세션 카탈로그가 집계한 이 실행의 토큰. Claude만 채워진다(Codex 세션은 카탈로그에
    /// 토큰이 없다). 턴 종료 시점에 없으면 다음 조회가 채운다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tokens: Option<TokenUsage>,
    /// 이 실행이 돈 추론수준. 회당 소비는 등급에 따라 서너 배까지 갈리므로, 등급을 남기지
    /// 않으면 계획이 고른 등급과 그 등급의 실제 값이 영영 짝지어지지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<ReasoningEffort>,
    /// 이 실행이 돈 모델. Antigravity 계정은 모델군마다 쿼터가 따로라, 모델을 남기지 않으면
    /// 어느 창을 채우는 실행인지 가릴 수 없다([`account_claim_state`]). 옛 기록에는 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PacingStore {
    #[serde(default = "store_version")]
    schema_version: u32,
    /// `<계정 id>\u{1}<창 라벨>` 키의 표본 시계열.
    #[serde(default)]
    series: BTreeMap<String, Vec<UsageSample>>,
    #[serde(default)]
    plans: Vec<PlanRecord>,
    #[serde(default)]
    runs: Vec<RunRecord>,
    /// `<소비자 id>\u{1}<공급자>\u{1}<창 라벨>` 키의 확정된 절감 기준선.
    #[serde(default)]
    baselines: BTreeMap<String, SavingsBaseline>,
}

/// 확정된 절감 기준선. 처음 N회 관측이 다 모인 순간의 중앙값을 붙박아 둔다.
///
/// 붙박지 않으면 기준선이 앞으로 미끄러진다 — 관측은 창이 리셋된 실행을 버리므로(같은
/// 리셋 창 안에서만 증가분을 잴 수 있다) 오래된 관측이 사라지고, "처음 N회"가 매번 더
/// 나중 구간을 집는다. 실제로 2026-09-06 네 시간 사이에 한 회차의 기준선이 2.95M에서
/// 1.68M 토큰으로 내려갔고, 그동안 달성률은 움직이는 과녁을 쏘고 있었다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavingsBaseline {
    /// 확정 시각. 화면이 "언제 기준을 잡았는지"를 말할 수 있게 남긴다.
    fixed_at: i64,
    /// 확정에 쓴 관측 수.
    runs: usize,
    cost_percent: Option<f64>,
    tokens: Option<f64>,
}

/// 정책이 정한 기준선 회차 수. 정책이 없으면 내장 기본값.
fn baseline_runs_for(inputs: &PacingInputs<'_>) -> usize {
    inputs
        .policy
        .map_or(usage_budget_policy::DEFAULT_BASELINE_RUNS, |policy| {
            policy.savings.baseline_runs
        })
}

fn baseline_key(consumer_id: &str, provider: ProviderId, window_label: &str) -> String {
    format!("{consumer_id}\u{1}{}\u{1}{window_label}", provider.as_str())
}

fn store_version() -> u32 {
    STORE_VERSION
}

impl Default for PacingStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            series: BTreeMap::new(),
            plans: Vec::new(),
            runs: Vec::new(),
            baselines: BTreeMap::new(),
        }
    }
}

fn series_key(account_id: &str, window_label: &str) -> String {
    format!("{account_id}\u{1}{window_label}")
}

/// 이 항목이 채운 창. 라벨을 남기지 않은 옛 기록과 회차 창을 그대로 쓴 계정은 회차 창이다.
fn entry_window_label<'a>(entry: &'a PlanRecordEntry, plan_window_label: &'a str) -> &'a str {
    entry.window_label.as_deref().unwrap_or(plan_window_label)
}

fn with_store_lock<T>(
    app_data_dir: &Path,
    action: impl FnOnce() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let _lock = store_lock::acquire(app_data_dir, STORE_LOCK_FILE, "사용량 페이싱 저장소")?;
    action()
}

fn load_store(app_data_dir: &Path) -> Result<PacingStore, CoreError> {
    let path = app_data_dir.join(STORE_FILE);
    if !path.is_file() {
        return Ok(PacingStore::default());
    }
    // 표본은 파생 데이터다. 읽지 못하면 실패시키지 않고 새로 모은다. 사용량 갱신이
    // 저장소 하나 때문에 막히면 계정 상태 전체가 낡는다.
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("[usage-pacing] 표본 저장소를 읽지 못해 새로 시작합니다: {error}");
            return Ok(PacingStore::default());
        }
    };
    let store: PacingStore = match serde_json::from_slice(&bytes) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("[usage-pacing] 표본 저장소를 해석하지 못해 새로 시작합니다: {error}");
            return Ok(PacingStore::default());
        }
    };
    if store.schema_version != STORE_VERSION {
        return Ok(PacingStore::default());
    }
    Ok(store)
}

fn save_store(app_data_dir: &Path, store: &PacingStore) -> Result<(), CoreError> {
    write_private_json(&app_data_dir.join(STORE_FILE), store)
}

/// 저장소를 고치는 갈래는 모두 같은 모양이다 — 잠금을 쥐고 읽어 고친 뒤, 바뀐 것이
/// 있을 때만 다시 쓰고, 실패는 호출한 쪽을 실패시키지 않고 경고만 남긴다(표본과 실행
/// 기록은 파생 데이터다). `change`가 `false`를 돌려주면 파일을 다시 쓰지 않는다.
/// 실패 문구는 성공하는 대부분의 호출에서 만들지 않도록 클로저로 받는다.
fn update_store(
    app_data_dir: &Path,
    failure: impl FnOnce() -> String,
    change: impl FnOnce(&mut PacingStore) -> bool,
) {
    let result = with_store_lock(app_data_dir, || {
        let mut store = load_store(app_data_dir)?;
        if !change(&mut store) {
            return Ok(());
        }
        save_store(app_data_dir, &store)
    });
    if let Err(error) = result {
        eprintln!("[usage-pacing] {}: {error}", failure());
    }
}

/// 실행 하나를 괄호 치는 표본의 자리. 시작 이전의 마지막 표본과 종료 이후의 첫 표본
/// 두 개면 그 실행의 증가분을 잴 수 있다. 겹친 실행의 구간(`span_start`·`span_end`)은
/// 겹친 상대 실행의 자리와 같으므로 실행마다 이 한 쌍만 지키면 함께 덮인다.
fn bracketing_sample_indices(
    series: &[UsageSample],
    runs: &[(i64, Option<i64>)],
) -> BTreeSet<usize> {
    let mut keep = BTreeSet::new();
    for (started_at, ended_at) in runs {
        if let Some(index) = series.iter().rposition(|sample| sample.at <= *started_at) {
            keep.insert(index);
        }
        if let Some(ended_at) = ended_at {
            // 유예를 넘겨 들어온 표본은 이 실행을 괄호 치지 못하므로 지켜 봐야 헛되다.
            let deadline = ended_at.saturating_add(RUN_AFTER_SAMPLE_GRACE_MS);
            if let Some(index) = series
                .iter()
                .position(|sample| sample.at >= *ended_at && sample.at <= deadline)
            {
                keep.insert(index);
            }
        }
    }
    keep
}

/// 상한을 넘긴 표본을 오래된 것부터 버리되, 실행을 괄호 치는 표본은 남긴다.
///
/// 사용량 갱신은 값이 바뀌지 않아도 표본을 남기고 갱신 주기는 활성 계정에서 5분이라,
/// 그냥 오래된 것부터 버리면 96칸이 같은 값의 사본으로 차서 회당 소비를 실측할 근거가
/// 하루도 못 가 사라진다. 실측이 실제로 보는 표본은 실행 앞뒤 한 쌍뿐이므로 그것만
/// 지키면 칸을 늘리지 않고도 지난 회차를 계속 잴 수 있다.
fn trim_series(series: &mut Vec<UsageSample>, runs: &[(i64, Option<i64>)]) {
    if series.len() <= MAX_SAMPLES_PER_SERIES {
        return;
    }
    let keep = bracketing_sample_indices(series, runs);
    let mut remaining = series.len() - MAX_SAMPLES_PER_SERIES;
    let mut index = 0usize;
    series.retain(|_| {
        let current = index;
        index += 1;
        let drop = remaining > 0 && !keep.contains(&current);
        if drop {
            remaining -= 1;
        }
        !drop
    });
    // 지켜 준 표본이 절대 상한까지 쌓이면 그때는 오래된 것부터 버린다. 실행 기록 자체가
    // `MAX_RUN_RECORDS`로 잘리므로 이 상한에 닿는 일은 사실상 없지만, 저장 크기가 기록
    // 수와 무관하게 커지지 않도록 막아 둔다.
    if series.len() > MAX_SAMPLES_PER_SERIES_HARD_CAP {
        let excess = series.len() - MAX_SAMPLES_PER_SERIES_HARD_CAP;
        series.drain(..excess);
    }
}

/// 사용량 갱신이 계정 레코드에 반영된 직후 그 결과를 표본으로 남긴다. 실패는 호출한
/// 갱신을 실패시키지 않고 경고만 남긴다 — 표본은 파생 데이터다.
pub(crate) fn record_usage_sample(app_data_dir: &Path, account_id: &str, usage: &AccountUsageView) {
    if usage.status != AccountUsageStatus::Ok || usage.windows.is_empty() {
        return;
    }
    let at = usage.updated_at.unwrap_or_else(now_ms);
    let windows = usage.windows.clone();
    update_store(
        app_data_dir,
        || format!("계정 {account_id} 사용량 표본을 남기지 못했습니다"),
        |store| {
            // 이 계정의 실행 구간. 표본을 솎을 때 이 구간을 괄호 치는 표본은 지킨다.
            let run_spans: Vec<(i64, Option<i64>)> = store
                .runs
                .iter()
                .filter(|run| run.account_id == account_id)
                .map(|run| (run.started_at, run.ended_at))
                .collect();
            for window in &windows {
                let series = store
                    .series
                    .entry(series_key(account_id, &window.label))
                    .or_default();
                // 같은 갱신 시각이 두 번 들어오면 뒤엣것만 남긴다. 사용량 갱신은 조회
                // 결과를 그대로 저장하므로 같은 시각의 표본이 겹칠 수 있다.
                if series.last().is_some_and(|last| last.at >= at) {
                    series.pop();
                }
                series.push(UsageSample {
                    at,
                    used_percent: window.used_percent,
                    resets_at: window.resets_at,
                });
                trim_series(series, &run_spans);
            }
            true
        },
    );
}

/// 출처가 있는 무인 런타임의 시작.
pub(crate) struct RunStart {
    pub chat_id: String,
    pub execution_id: Option<String>,
    pub consumer_id: String,
    pub workflow_id: Option<String>,
    pub account_id: String,
    pub provider: ProviderId,
    pub started_at: i64,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub model: Option<String>,
}

/// 실행 시작을 기록한다. 같은 채팅이 두 번 오면 처음 것만 남긴다. 실패는 경고만 — 파생
/// 데이터다.
pub(crate) fn record_run_started(app_data_dir: &Path, start: RunStart) {
    update_store(
        app_data_dir,
        || "실행 시작을 기록하지 못했습니다".to_owned(),
        |store| {
            if store.runs.iter().any(|run| run.chat_id == start.chat_id) {
                return false;
            }
            store.runs.push(RunRecord {
                chat_id: start.chat_id,
                execution_id: start.execution_id,
                consumer_id: start.consumer_id,
                workflow_id: start.workflow_id,
                account_id: start.account_id,
                provider: start.provider,
                started_at: start.started_at,
                ended_at: None,
                provider_session_id: None,
                tokens: None,
                reasoning_effort: start.reasoning_effort,
                model: start.model,
            });
            if store.runs.len() > MAX_RUN_RECORDS {
                let excess = store.runs.len() - MAX_RUN_RECORDS;
                store.runs.drain(..excess);
            }
            true
        },
    );
}

/// 회차가 기동을 마친 뒤, 예약을 **실제로 뜬 건수**에 맞춘다.
///
/// 계획은 예약을 먼저 남기고 그 뒤에 기동한다. 기동이 거부되면 소비는 없는데 예약만 남아,
/// 다음 회차가 자기 창을 미정산이 걸린 것으로 읽고 쉰다 — 창이 미시작이면
/// `창 미시작 — 이미 첫 기동이 예약됨`이다. 회차 간격이 지나야 TTL이 닫으므로 그때까지
/// 같은 계정으로 다시 시도하지 못한다.
///
/// 기동 **루프가 끝난 뒤 한 번** 부른다. 건마다 닫으면 그 시점의 실행 수를 기준으로 삼게
/// 되는데, 뒤에 뜰 건들이 아직 기록되기 전이라 실제보다 적게 읽는다 — 3건 중 첫 건이 실패한
/// 회차에서 뒤 두 건이 정상으로 떠도 예약은 2로 남아, 한 건분 소비가 미정산에서 빠지고 다음
/// 회차가 그만큼 더 띄운다.
///
/// 줄이기만 한다. 기동 단계의 실패에는 런타임이 아예 못 뜬 경우와, 떴는데 그 뒤가 실패한
/// 경우가 함께 들어 있다([`crate::system_workflows`]의 `launch_paced_run`) — 뒤쪽은 소비가
/// 이미 일어났고 채팅이 떴으면 회차 실행 id를 단 실행 기록이 남으므로 그 몫의 예약은 지킨다.
/// 기대 소비는 남은 건수에 비례해 줄이고, 가드 창 예약도 같은 비율로 맞춘다.
pub(crate) fn settle_unlaunched_claims(app_data_dir: &Path, execution_id: &str) {
    update_store(
        app_data_dir,
        || format!("실행 {execution_id}의 예약을 정산하지 못했습니다"),
        |store| {
            let launched = |account_id: &str| {
                store
                    .runs
                    .iter()
                    .filter(|run| {
                        run.execution_id.as_deref() == Some(execution_id)
                            && run.account_id == account_id
                    })
                    .count()
            };
            let counts: BTreeMap<String, usize> = store
                .plans
                .iter()
                .filter(|plan| plan.execution_id.as_deref() == Some(execution_id))
                .flat_map(|plan| plan.entries.iter())
                .map(|entry| (entry.account_id.clone(), launched(&entry.account_id)))
                .collect();
            let mut changed = false;
            for plan in store
                .plans
                .iter_mut()
                .filter(|plan| plan.execution_id.as_deref() == Some(execution_id))
            {
                for entry in plan.entries.iter_mut() {
                    let launched = counts.get(&entry.account_id).copied().unwrap_or(0);
                    if entry.count <= launched {
                        continue;
                    }
                    let before = entry.count as f64;
                    entry.count = launched;
                    let ratio = entry.count as f64 / before;
                    if let Some(cost) = entry.expected_cost_percent.as_mut() {
                        *cost *= ratio;
                    }
                    for guard in entry.guards.values_mut() {
                        if let Some(cost) = guard.expected_cost_percent.as_mut() {
                            *cost *= ratio;
                        }
                    }
                    changed = true;
                }
                plan.entries.retain(|entry| entry.count > 0);
            }
            changed
        },
    );
}

/// 실행의 마지막 턴이 끝난 시각을 닫는다. 턴이 여러 번이면 마지막 것이 남는다. 토큰은
/// 있을 때만 덮어쓴다(카탈로그가 아직 못 봤으면 뒤에 채운다).
pub(crate) fn record_run_ended(
    app_data_dir: &Path,
    chat_id: &str,
    ended_at: i64,
    provider_session_id: Option<String>,
    tokens: Option<TokenUsage>,
) {
    update_store(
        app_data_dir,
        || format!("실행 종료를 기록하지 못했습니다({chat_id})"),
        |store| {
            let Some(run) = store.runs.iter_mut().find(|run| run.chat_id == chat_id) else {
                return false;
            };
            run.ended_at = Some(
                run.ended_at
                    .map_or(ended_at, |existing| existing.max(ended_at)),
            );
            if provider_session_id.is_some() {
                run.provider_session_id = provider_session_id;
            }
            if tokens.is_some_and(|tokens| tokens.total() > 0) {
                run.tokens = tokens;
            }
            true
        },
    );
}

/// 끝났는데 토큰이 비어 있는 실행의 토큰을 세션 카탈로그에서 뒤늦게 채운다. 턴 종료 시점엔
/// 카탈로그 스캔이 아직 그 세션을 못 봤을 수 있어 조회 때마다 한 번씩 시도한다. 아무것도
/// 채우지 못하면 파일을 다시 쓰지 않는다.
pub(crate) fn backfill_run_tokens(
    app_data_dir: &Path,
    lookup: impl Fn(ProviderId, &str) -> Option<TokenUsage>,
) {
    update_store(
        app_data_dir,
        || "실행 토큰을 채우지 못했습니다".to_owned(),
        |store| {
            let mut changed = false;
            for run in store.runs.iter_mut() {
                if run.ended_at.is_none() || run.tokens.is_some() {
                    continue;
                }
                let Some(session_id) = run.provider_session_id.as_deref() else {
                    continue;
                };
                if let Some(tokens) = lookup(run.provider, session_id).filter(|t| t.total() > 0) {
                    run.tokens = Some(tokens);
                    changed = true;
                }
            }
            changed
        },
    );
}

/// 다른 파생 저장소가 이어받을 수 있게 내보내는 표본 하나.
pub(crate) struct ExportedSample {
    pub account_id: String,
    pub window_label: String,
    pub at: i64,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
}

/// 보관 중인 표본 전부를 시각 순으로 내보낸다. `usage_history`가 처음 만들어질 때
/// 진행 중인 주기의 관측을 여기서 이어받는다. 잠금은 호출부가 자기 저장소 잠금만
/// 잡고 있으므로 여기서는 읽기만 한다 — 표본은 한 번에 통째로 다시 쓰이므로 반쯤
/// 쓰인 파일을 볼 일이 없다.
pub(crate) fn export_samples(app_data_dir: &Path) -> Vec<ExportedSample> {
    let Ok(store) = load_store(app_data_dir) else {
        return Vec::new();
    };
    let mut samples: Vec<ExportedSample> = store
        .series
        .iter()
        .flat_map(|(key, series)| {
            let (account_id, window_label) = key.split_once('\u{1}').unwrap_or((key, ""));
            series.iter().map(move |sample| ExportedSample {
                account_id: account_id.to_owned(),
                window_label: window_label.to_owned(),
                at: sample.at,
                used_percent: sample.used_percent,
                resets_at: sample.resets_at,
            })
        })
        .collect();
    samples.sort_by_key(|sample| sample.at);
    samples
}

/// 회차 계획 요청. 워크플로 단계의 정적 인자로 그대로 실린다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePacedRunsRequest {
    /// 주기를 역조회할 워크플로 id. 이 워크플로를 돌리는 활성 반복 요청의 반복 주기를
    /// 이번 회차 간격으로 쓴다. 자기 id를 넣으면 스케줄 주기를 바꿔도 따라간다.
    #[serde(default)]
    pub cadence_workflow_id: Option<String>,
    /// 역조회가 실패했을 때 쓸 주기(분).
    #[serde(default)]
    pub cadence_minutes: Option<u32>,
    /// 대상 계정을 이메일 접두사로 좁힌다. 비우면 전체 계정.
    #[serde(default)]
    pub email_prefix: Option<String>,
    /// 대상 공급자. 비우면 계정을 관리하는 공급자 전체.
    #[serde(default)]
    pub providers: Option<Vec<ProviderId>>,
    /// 이번 회차에 함께 돌릴 로컬 모델. 사용량 한도가 없어 계정 여력으로 건수를 정할 수
    /// 없으므로, 참여할 모델을 사용자가 직접 고른다. 비우면 로컬은 참여하지 않는다.
    ///
    /// 모델 하나당 한 건이다. 같은 모델을 두 번 적어도 한 건으로 접는다 — 서빙 서버가
    /// 같은 모델 요청을 직렬화하므로 두 건을 띄워도 대기만 길어진다. 서로 다른 모델은
    /// 간섭이 거의 없다(실측: GPU 9b 98%, CPU 20b 102%).
    #[serde(default, deserialize_with = "deserialize_local_models")]
    pub local_models: Vec<String>,
    /// 채울 창의 라벨. 공급자가 알려 준 라벨과 정확히 같아야 한다(예: `7일`).
    /// 비우면 워크플로 페이싱 탭의 사용량 예산 기본 창을 쓴다.
    #[serde(default)]
    pub window_label: String,
    /// 그 창을 이번 기간 안에 어디까지 채울지(%). 비우면 예산 기본 목표를 쓴다.
    #[serde(default)]
    pub target_percent: Option<f64>,
    /// 함께 지킬 짧은 창의 라벨(예: `5시간`).
    #[serde(default)]
    pub guard_window_label: Option<String>,
    /// 짧은 창이 이 값을 넘은 계정은 이번 회차에서 제외한다(%).
    #[serde(default)]
    pub guard_percent: Option<f64>,
    /// 한 회차의 동시 기동 상한(병렬 실행). 없으면 이 소비자의 반복 요청 병렬 실행 설정,
    /// 그것도 없으면 1(수동·AIA 실행과 같음). 상한은 두지 않는다 — 실제 건수는 계정 여력과
    /// 가드 창이 자른다.
    #[serde(default)]
    pub max_runs: Option<usize>,
    /// 표본으로 회당 비용을 실측하지 못했을 때 쓸 값(%p).
    #[serde(default)]
    pub fallback_cost_percent_per_run: Option<f64>,
    /// 회당 비용 실측에 쓸 최근 계획 구간 수. 크게 잡으면 오래된 회차까지 평균에
    /// 들어가 최근 변화를 늦게 따라가고, 작게 잡으면 한 회차의 편차에 휘둘린다.
    #[serde(default)]
    pub cost_windows: Option<usize>,
    /// 회당 비용의 하한(%p). 실측값이 이보다 작아도 이 값으로 계산해 과다 기동을 막는다.
    #[serde(default)]
    pub min_cost_percent_per_run: Option<f64>,
    /// 기동할 작업 경로.
    pub project_path: String,
    #[serde(default)]
    pub claude_model: Option<String>,
    #[serde(default)]
    pub codex_model: Option<String>,
    /// Antigravity는 계정 대신 모델군별 쿼터를 소비한다. 모델을 명시한 회차만 해당
    /// 가상 사용량 자원을 후보로 넣어 기존 Claude·Codex 회차에 자동 합류하지 않게 한다.
    #[serde(default)]
    pub antigravity_model: Option<String>,
    /// 정리 대상으로 볼 무인 런타임의 작업 경로. 비우면 `project_path`. 출처가 있는
    /// 런타임은 경로가 아니라 출처로 고르고, 이 값은 출처 없는 옛 런타임에만 쓴다.
    #[serde(default)]
    pub stale_run_cwd: Option<String>,
    /// 워크플로 단계에서 왔을 때의 실행 id. 본문으로는 받지 않고 디스패처가 출처에서 채운다.
    #[serde(default, skip_deserializing)]
    pub execution_id: Option<String>,
    /// 트리거한 반복 요청 id. 있으면 그것이 소비자다. 본문으로는 받지 않는다.
    #[serde(default, skip_deserializing)]
    pub trigger_consumer_id: Option<String>,
}

/// 계획 계산에 필요한 시스템 상태. 호출부가 조회해서 넣어 준다. 계산은 순수하게
/// 유지해 시험이 시각과 상태를 직접 정할 수 있게 한다.
struct PacingInputs<'a> {
    pub now: i64,
    pub accounts: &'a [ProviderAccountView],
    pub schedules: &'a [ScheduledRequest],
    pub chats: &'a [ChatSessionInfo],
    /// 사용량 예산 정책. 없으면 워크플로 인자만으로 동작한다.
    pub policy: Option<&'a UsageBudgetPolicy>,
    /// 실제 페이싱 대상 워크플로. 공개 진입점은 레지스트리에서 채우고, 산술 단위 시험은
    /// `None`으로 두어 전달한 워크플로 회차를 모두 대상으로 삼는다.
    pub pacing_workflow_ids: Option<&'a BTreeSet<String>>,
}

/// 가드 창 하나의 예약 기준선. `used_percent`·`resets_at`은 예약 시점의 창 상태, `cost`는 그
/// 창의 회당 소비(실측이 없으면 None).
#[derive(Debug, Clone, Copy)]
struct GuardBaseline {
    used_percent: f64,
    resets_at: Option<i64>,
    cost_percent_per_run: Option<f64>,
}

#[derive(Debug, Clone)]
struct PlannedRun {
    pub account_id: String,
    pub source: ProviderId,
    pub model: Option<String>,
    /// 레인 설정과 계정 여력으로 고른 추론수준. 계약이 `{"$run": "reasoningEffort"}`로 받는다.
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 추론수준의 출처(`fixed`·`auto`)와 자동 판정에 쓴 여력. 미리보기가 근거를 보여 준다.
    pub reasoning_effort_source: Option<&'static str>,
    pub headroom_runs_per_round: Option<f64>,
}

/// 계정 여력을 잴 수 없을 때(창 미시작·회당 소비 미실측)와 여력이 계획 직선에 맞을 때의
/// 추론수준. 봉투 이전의 계약들이 상수로 쓰던 값과 같아 기존 회차의 소비가 갑자기 바뀌지
/// 않는다.
pub(crate) const DEFAULT_PACED_REASONING_EFFORT: ReasoningEffort = ReasoningEffort::High;

/// 계정 여력(리셋까지 남은 회차마다 감당할 수 있는 건수)의 상한 구간과 기본 수준에서 움직일
/// 단계. 1건/회차가 계획 직선에 정확히 맞는 속도다: 그보다 넉넉하면 회차당 한 건이 다 못 쓰는
/// 예산을 더 깊은 추론으로 쓰고, 부족하면 한 건을 싸게 해 쉬는 회차를 줄인다.
const HEADROOM_EFFORT_STEPS: [(f64, i8); 5] =
    [(0.5, -2), (1.0, -1), (2.0, 0), (4.0, 1), (f64::INFINITY, 2)];

/// 공급자가 무인 실행에 쓸 수 있는 추론수준 사다리(낮은 것부터). `none`·`minimal`은 복잡한
/// 절차를 감당하지 못해 넣지 않는다. 카탈로그 원본은 `chat_settings::provider_reasoning_options`.
pub(crate) fn reasoning_effort_ladder(provider: ProviderId) -> &'static [ReasoningEffort] {
    match provider {
        ProviderId::Claude => &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ],
        ProviderId::Codex => &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
        ],
        // 서빙 서버가 추론 수준을 어떻게 받을지 모델마다 달라 사다리를 두지 않는다.
        ProviderId::Local => &[],
        ProviderId::Antigravity => &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ],
    }
}

/// 여력 배수로 고른 추론수준. `None`(판단 불가)은 기본 수준이고, 사다리가 짧은 공급자는 끝에서
/// 멈춘다.
fn reasoning_effort_for_headroom(
    provider: ProviderId,
    headroom_runs_per_round: Option<f64>,
) -> ReasoningEffort {
    let ladder = ReasoningLadder::of(provider);
    let anchor = ladder
        .position(&DEFAULT_PACED_REASONING_EFFORT)
        .unwrap_or(ladder.rungs().len() - 1) as i8;
    let step = headroom_runs_per_round
        .filter(|ratio| ratio.is_finite())
        .map_or(0, |ratio| {
            HEADROOM_EFFORT_STEPS
                .iter()
                .find(|(upper, _)| ratio < *upper)
                .map_or(0, |(_, step)| *step)
        });
    ladder.at_step(anchor, step)
}

/// 여력을 판단하지 않는 기동(봉투가 계획 없이 띄우는 수동 실행)의 추론수준.
pub(crate) fn default_paced_reasoning_effort(provider: ProviderId) -> ReasoningEffort {
    reasoning_effort_for_headroom(provider, None)
}

/// 공급자별 사다리. 화면이 회차 설정의 선택지를 백엔드와 같은 목록으로 그리도록 스냅샷에 싣는다.
pub(crate) fn reasoning_effort_ladders() -> Value {
    ProviderId::ALL
        .into_iter()
        .map(|provider| {
            (
                provider.as_str().to_owned(),
                json!(reasoning_effort_ladder(provider)),
            )
        })
        .collect::<serde_json::Map<String, Value>>()
        .into()
}

/// 등급 목록에서 한 등급이 몇 번째 칸인지. 공급자 사다리와 [`ReasoningLadder::clamp`]의 전체
/// 순서표가 같은 방식으로 칸을 찾는다.
fn position_in(order: &[ReasoningEffort], effort: &ReasoningEffort) -> Option<usize> {
    order.iter().position(|known| known == effort)
}

/// 공급자 하나의 추론수준 사다리.
///
/// 사다리를 읽는 규칙(칸 찾기·옮기기·견주기·경계 맞추기)이 `provider`를 인자로 끌고 다니는
/// 자유 함수 일곱 벌에 흩어져 있었다. 규칙마다 사다리를 스스로 다시 집어 오느라 한 판정이
/// 같은 표를 여러 번 읽었고(한쪽 경계를 씌우는 데만 세 번), 새 규칙을 더할 때마다 "공급자를
/// 받아 사다리를 집는" 첫 두 줄을 다시 적어야 했다. 사다리를 한 번 집어 값으로 들고 다니면
/// 규칙이 한 타입 안에 서고, 호출부는 공급자가 아니라 사다리를 받는다.
#[derive(Clone, Copy)]
struct ReasoningLadder(&'static [ReasoningEffort]);

impl ReasoningLadder {
    fn of(provider: ProviderId) -> Self {
        Self(reasoning_effort_ladder(provider))
    }

    /// 낮은 칸부터 늘어놓은 등급 목록.
    fn rungs(self) -> &'static [ReasoningEffort] {
        self.0
    }

    /// 사다리의 첫 칸. 레인이 바닥을 정하지 않았을 때의 바닥이다.
    fn bottom(self) -> ReasoningEffort {
        self.0[0].clone()
    }

    fn position(self, effort: &ReasoningEffort) -> Option<usize> {
        position_in(self.0, effort)
    }

    /// `anchor` 칸에서 `step`만큼 옮긴 등급. 사다리 밖으로 나가면 끝 칸에서 멈춘다.
    fn at_step(self, anchor: i8, step: i8) -> ReasoningEffort {
        let index = (anchor + step).clamp(0, self.0.len() as i8 - 1) as usize;
        self.0[index].clone()
    }

    /// 사다리 위의 등급을 `step`만큼 옮긴다. 사다리 밖 이름은 설 칸이 없어 그대로 둔다.
    fn stepped(self, effort: &ReasoningEffort, step: i8) -> ReasoningEffort {
        match self.position(effort) {
            Some(index) => self.at_step(index as i8, step),
            None => effort.clone(),
        }
    }

    /// 사다리 위에서 두 등급의 높낮이를 견준다. 사다리에 없는 이름(CLI 검증에 맡긴 값)이
    /// 하나라도 끼면 견주지 않고 `None`을 돌려 부르는 쪽이 원래 값을 그대로 두게 한다.
    fn compare(self, effort: &ReasoningEffort, other: &ReasoningEffort) -> Option<Ordering> {
        Some(self.position(effort)?.cmp(&self.position(other)?))
    }

    /// 자동 판정을 레인이 정한 한쪽 끝 안으로 들인다. 경계는 먼저 사다리에 맞추고, 판정이
    /// 경계를 `beyond` 방향으로 넘었을 때만 경계 값이 된다. 견줄 수 없는 이름이면 판정을
    /// 그대로 둔다.
    fn bound(
        self,
        effort: ReasoningEffort,
        bound: ReasoningEffort,
        beyond: Ordering,
    ) -> ReasoningEffort {
        let bound = self.clamp(bound);
        if self.compare(&effort, &bound) == Some(beyond) {
            bound
        } else {
            effort
        }
    }

    /// 자동 판정 결과에 레인 상한을 씌운다. 판정이 상한 아래면 그대로다 — 상한은 천장이지
    /// 기준이 아니다.
    fn cap(self, effort: ReasoningEffort, cap: ReasoningEffort) -> ReasoningEffort {
        self.bound(effort, cap, Ordering::Greater)
    }

    /// 자동 판정을 바닥 위로 끌어올린다. 바닥은 천장의 짝이다 — 절감 목표가 등급을 내릴 때
    /// 어디서 멈출지를 정한다.
    fn floor(self, effort: ReasoningEffort, floor: ReasoningEffort) -> ReasoningEffort {
        self.bound(effort, floor, Ordering::Less)
    }

    /// 회차 설정의 고정 추론수준을 공급자 사다리에 맞춘다. 사다리 위의 값(Codex의 max 등)은
    /// 끝 칸, 아래의 값(none·minimal)은 첫 칸이 되고, 내장에 없는 이름은 CLI 검증에 맡겨
    /// 그대로 둔다.
    fn clamp(self, effort: ReasoningEffort) -> ReasoningEffort {
        if self.0.contains(&effort) {
            return effort;
        }
        const ORDER: [ReasoningEffort; 8] = [
            ReasoningEffort::None,
            ReasoningEffort::Minimal,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
            ReasoningEffort::Ultra,
        ];
        let (Some(position), Some(top), Some(bottom)) =
            (position_in(&ORDER, &effort), self.0.last(), self.0.first())
        else {
            return effort;
        };
        let top_position = position_in(&ORDER, top).unwrap_or(ORDER.len());
        if position > top_position {
            top.clone()
        } else {
            bottom.clone()
        }
    }
}

#[derive(Debug, Clone)]
struct PacingPlan {
    pub cadence_minutes: u32,
    pub cadence_source: String,
    pub cost_percent_per_run: f64,
    pub cost_source: &'static str,
    pub cost_observations: usize,
    pub cost_windows: usize,
    pub min_cost_percent_per_run: f64,
    /// 모든 계정에 공통으로 적용되는 목표·가드. 계정 override까지 적용한 값은 accounts의
    /// 각 행에 싣는다.
    pub target_percent: f64,
    pub guard_label: Option<String>,
    pub guard_percent: Option<f64>,
    pub accounts: Vec<Value>,
    pub planned: Vec<PlannedRun>,
    pub stale_chat_ids: Vec<(String, ProviderId)>,
    pub reasoning: Vec<String>,
    /// 이번 호출의 소비자. 예약 기록에 남고 응답에도 실린다.
    pub consumer_id: String,
    /// 같은 창을 최근에 쓴 다른 소비자.
    pub active_consumers: Vec<String>,
    /// 계정별 예약 기준선(사용률, 리셋 시각). 기록에 실어 다음 정산의 근거가 된다.
    pub claim_baselines: BTreeMap<String, (f64, Option<i64>)>,
    /// 계정별·가드 창 라벨별 예약 기준선(사용률, 리셋 시각, 그 창의 회당 소비). 회당 소비가
    /// None인 창은 아직 실측이 없어 기대 소비 없이 기준선만 기록된다.
    pub guard_baselines: BTreeMap<String, BTreeMap<String, GuardBaseline>>,
    /// 가드 창 라벨별 전역 회당 소비(값, 관측 구간 수). 실측이 없는 라벨은 없다.
    pub guard_costs: BTreeMap<String, (f64, usize)>,
    pub max_runs: usize,
    /// 계정별로 실제 쓴 회당 소비(회차별 실측이 있으면 그것, 없으면 전역).
    pub account_costs: BTreeMap<String, f64>,
    /// 공급자별 회차별 회당 소비 (값, 관측 가중치 합). 문턱을 넘은 것만.
    pub consumer_costs: BTreeMap<ProviderId, (f64, f64)>,
    /// 회차 창과 다른 창을 채운 공급자의 라벨(Antigravity 모델군 창). 절감 기준선도 같은
    /// 창에서 얼어야 상한 판정이 자기 기준선을 찾는다.
    pub provider_window_labels: BTreeMap<ProviderId, String>,
    /// 같은 것을 계정 단위로. 예약 기록의 항목마다 실려 다음 회차가 남의 모델군 예약을
    /// 자기 창의 미정산으로 읽지 않게 한다.
    pub account_window_labels: AccountWindowLabels,
    /// 정책이 이 소비자를 선택하지 않아 기동을 막았는지. 막힌 회차는 기록도 남기지 않는다.
    pub blocked: bool,
    /// 회당 소비 상한을 넘어 억제됐는지(enforce). 존재 기록은 남긴다.
    pub over_ceiling: Option<String>,
}

/// 이 워크플로를 돌리는 활성 반복 요청의 주기를 분으로 환산한다. 여러 개가 걸려
/// 있으면 가장 짧은 주기를 쓴다 — 그만큼 자주 회차가 돌아온다.
fn cadence_from_schedules(
    schedules: &[ScheduledRequest],
    workflow_id: &str,
    auto_minutes: u32,
    now: i64,
) -> Option<u32> {
    schedules
        .iter()
        .filter(|schedule| {
            schedule.input.enabled
                && schedule
                    .input
                    .workflow
                    .as_ref()
                    .is_some_and(|action| action.workflow_id == workflow_id)
        })
        .filter_map(|schedule| recurrence_minutes(&schedule.input.recurrence, auto_minutes, now))
        .min()
}

/// 반복 주기를 분으로 환산한다. 임의 Cron은 다음 발생 시각들을 실제 시간대에서 펼친
/// 평균이고, Auto는 예산 정책이 정한 간격 그대로다.
fn recurrence_minutes(
    recurrence: &crate::scheduler::ScheduleRecurrence,
    auto_minutes: u32,
    now: i64,
) -> Option<u32> {
    crate::scheduler::recurrence_average_minutes(recurrence, now, auto_minutes)
}

/// 지난 회차 계획과 표본을 맞춰 회당 %p를 실측한다.
///
/// 소비자를 가리지 않고 계획 기록을 회차 그룹으로 묶고(`usage_budget::measurement_groups`),
/// 그룹 사이 구간마다 (그 구간에서 오른 %p) / (그 구간에 계획한 기동 수 합)을 구해
/// 평균한다. 다른 소비자의 계획이 같은 계정에 섞여 있어도 구간과 기동 수에 함께 들어가
/// 회당 소비가 한쪽으로 치우치지 않는다. 창이 리셋된 구간(`used_percent` 감소 또는
/// `resets_at`이 지터 밖으로 이동)은 증가분을 신뢰할 수 없어 버린다.
fn measure_cost_per_run(
    store: &PacingStore,
    window_label: &str,
    plan_labels: &AccountWindowLabels,
    account_ids: &[String],
    cost_windows: usize,
    cadence_ms: i64,
) -> (Option<f64>, usize) {
    measure_window_cost_per_run(
        store,
        window_label,
        None,
        plan_labels,
        account_ids,
        cost_windows,
        cadence_ms,
    )
}

/// 계정 하나의 회당 소비 %p. 계획 밖에서 읽는 쪽(소진 판정·소진 전망)은 계정별 계획 창
/// 예외표를 들고 있지 않고 관측 구간 수도 쓰지 않아, 빈 예외표·한 계정 배열·기본 표본
/// 구간 수 세 값을 호출마다 손으로 되풀이해 왔다. 그 기본값을 한 이름 뒤에 두어 세 자리가
/// 따로 흘러가지 않게 하고, 값이 없다는 뜻의 `None`만 호출자에게 남긴다.
fn account_cost_per_run(
    store: &PacingStore,
    account_id: &str,
    plan_window_label: &str,
    series_label: Option<&str>,
    cadence_ms: i64,
) -> Option<f64> {
    let account_ids = [account_id.to_owned()];
    measure_window_cost_per_run(
        store,
        plan_window_label,
        series_label,
        &AccountWindowLabels::new(),
        &account_ids,
        DEFAULT_COST_WINDOWS,
        cadence_ms,
    )
    .0
}

/// 계획 창(`plan_window_label`)의 회차 기록으로 구간을 나누고, 그 구간에서 읽을 창이 오른
/// 만큼을 기동 수로 나눈다. `series_label`이 없으면 계획 창 자신의 회당 소비고, 있으면 같은
/// 회차들이 그 가드 창을 얼마나 썼는지다 — 예약 기록은 계획 창 하나에만 남으므로 가드 창은
/// 자기 기록이 없고 계획 창의 기록을 빌려 잰다.
///
/// `plan_labels`는 계정별 계획 창의 예외표다(Antigravity 모델군 창). 구간을 만들 때 **그때
/// 그 계정이 채운 창**이 지금 재는 계획 창과 같은 항목만 넣는다 — 같은 회차 창 아래에서
/// 모델군이 다른 회차가 돌면 그 기동 수가 분모에만 들어가 회당 소비를 낮춘다.
fn measure_window_cost_per_run(
    store: &PacingStore,
    plan_window_label: &str,
    series_label: Option<&str>,
    plan_labels: &AccountWindowLabels,
    account_ids: &[String],
    cost_windows: usize,
    cadence_ms: i64,
) -> (Option<f64>, usize) {
    let plan_label_of = |account_id: &str| -> String {
        plan_labels
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| plan_window_label.to_owned())
    };
    let points: Vec<PlanPoint> = store
        .plans
        .iter()
        .filter(|plan| plan.window_label == plan_window_label)
        .map(|plan| PlanPoint {
            at: plan.at,
            cadence_ms: plan.cadence_ms.unwrap_or(cadence_ms),
            runs: plan
                .entries
                .iter()
                .filter(|entry| account_ids.contains(&entry.account_id))
                .filter(|entry| {
                    entry_window_label(entry, &plan.window_label)
                        == plan_label_of(&entry.account_id)
                })
                .map(|entry| (entry.account_id.clone(), entry.count))
                .collect(),
        })
        .collect();
    let groups = usage_budget::measurement_groups(&points, MAX_MEASUREMENT_SPAN_FACTOR);
    let mut total_percent = 0.0;
    let mut total_runs = 0usize;
    let mut observations = 0usize;
    for group in groups
        .iter()
        .rev()
        .filter(|group| group.runs.values().sum::<usize>() > 0)
        .take(cost_windows)
    {
        let mut grew = 0.0;
        // 관측할 수 있었던 계정의 기동만 분모에 넣는다. 창이 바뀐 계정의 기동을 분자에서만
        // 빼면 회당 소비가 과소평가되어 다음 회차가 과다 기동한다.
        let mut usable_runs = 0usize;
        let mut usable = false;
        for (account_id, count) in &group.runs {
            if *count == 0 {
                continue;
            }
            // 계획 창 실측은 그 계정이 채운 창의 표본을, 가드 창 실측은 가드 창의 표본을 본다.
            let account_label = series_label
                .map(str::to_owned)
                .unwrap_or_else(|| plan_label_of(account_id));
            let Some(series) = store.series.get(&series_key(account_id, &account_label)) else {
                continue;
            };
            let Some(before) = series.iter().rev().find(|sample| sample.at <= group.start) else {
                continue;
            };
            // 구간은 다음 회차 그룹의 시작이나 간격의 배수에서 닫힌다. 그 안에 표본이
            // 없으면 이 회차와 이어지는 관측이 없다는 뜻이라 버린다 — 멈춰 있던 기간을
            // 회당 비용으로 오인하지 않는다.
            let Some(after) = series
                .iter()
                .rev()
                .find(|sample| sample.at > group.start && sample.at <= group.end)
            else {
                continue;
            };
            if !same_reset_window(before, after) || after.used_percent < before.used_percent {
                continue;
            }
            grew += after.used_percent - before.used_percent;
            usable_runs += count;
            usable = true;
        }
        // 증가가 전혀 없는 구간은 계획만 남고 실제로는 돌지 않은 회차다(기동 단계가
        // 실패했거나 계획만 조회된 경우). 그대로 평균에 넣으면 회당 소비가 과소평가되어
        // 다음 회차가 과다 기동한다.
        if !usable || grew <= 0.0 {
            continue;
        }
        total_percent += grew;
        total_runs += usable_runs;
        observations += 1;
    }
    if observations == 0 || total_runs == 0 {
        return (None, 0);
    }
    (Some(total_percent / total_runs as f64), observations)
}

/// 자동 주기가 내려갈 수 있는 절대 하한(분).
///
/// 실행 시간과는 무관하다 — 회차가 실행보다 자주 떠도 계획이 살아 있는 실행을 빼고 자리를
/// 주므로(`compute_plan`의 `limit = max_runs - running_runs`) 겹치지 않고, 소요시간이
/// 흩어져 있는 한 자주 볼수록 빈 자리를 빨리 채워 처리량이 는다. 회차마다 도는 사용량
/// 갱신도 계정별 TTL(활성 5분·유휴 30분)이 이미 막아 공급자 API를 더 두드리지 않는다.
///
/// 실제 하한은 계획 기록 보관량이다. 회당 소비 실측(`measure_cost_per_run`)과 기동 배분의
/// "최근 기록이 있는 소비자" 판정이 `MAX_PLAN_RECORDS`건 안의 기록만 볼 수 있는데, 간격이
/// 촘촘할수록 그 64건이 덮는 시간이 짧아진다. 회차 하나면 10분 × 64 = 640분이라 활성 판정
/// 구간(기준 간격 × `ACTIVE_CONSUMER_SPAN_FACTOR` = 10시간)을 덮지만, 같은 창을 세 회차가
/// 나눠 쓰면 213분으로 줄어 느린 회차의 기록이 먼저 밀려난다. 그 경우에도 회차 수는 설정으로
/// 세므로(`sharing_round_ids`) 간격 계산은 흔들리지 않고, 기동 배분에서 그 회차의 몫이 잠시
/// 빠지는 데서 그친다 — 그 회차가 다음에 뜨면 기록이 다시 생긴다.
const MIN_AUTO_CADENCE_MINUTES: u32 = 10;
/// 회차 소요시간을 실측할 때 보는 최근 실행 수.
const RUN_DURATION_SAMPLES: usize = 5;

/// 이 워크플로가 최근에 돌린 실행 하나의 평균 길이(분). 처리량 점검의 서비스 시간이다.
///
/// 중앙값이 아니라 평균인 것은 처리량이 `동시 실행 수 ÷ 평균 서비스 시간`이기 때문이다
/// (리틀의 법칙). 하한으로는 쓰지 않는다 — 자동 주기는 실행 시간을 보지 않는다.
fn mean_run_minutes(store: &PacingStore, workflow_id: &str) -> Option<f64> {
    let durations: Vec<i64> = store
        .runs
        .iter()
        .filter(|run| run.workflow_id.as_deref() == Some(workflow_id))
        .filter_map(|run| run.ended_at.map(|ended| ended - run.started_at))
        .filter(|duration| *duration > 0)
        .rev()
        .take(RUN_DURATION_SAMPLES)
        .collect();
    if durations.is_empty() {
        return None;
    }
    let total: i64 = durations.iter().sum();
    Some(total as f64 / durations.len() as f64 / 60_000.0)
}

/// 자동 주기의 실제 간격(분).
///
/// 기준은 가드 창 길이다(창마다 한 회차). 그 박자로는 남은 기간 안에 목표를 못 채우는
/// 워크플로가 있어 간격을 줄인다. 줄이는 근거는 **계정별 균등 소비 속도의 합**이다 —
/// 계정 하나는 "남은 여유 ÷ 회당 소비"건을 리셋까지 남은 시간에 걸쳐 나눠 써야 하므로
/// 분당 `건수 ÷ 남은 시간`의 속도를 갖고, 풀 전체의 속도 합이 회차가 돌아와야 하는
/// 빈도다. 여유 합계를 회차 상한으로 나누던 옛 계산은 상한을 직전 회차 기록에서 읽어
/// 한 회차 늦게 반영되고, 리셋이 가장 늦은 계정의 남은 시간을 모든 여유에 적용해 창이
/// 짧은 계정을 과대평가했다.
///
/// 같은 창을 나눠 쓰는 소비자가 여럿이면 각 소비자는 그 빈도의 1/N만 가져가므로 간격에
/// 소비자 수를 곱한다 — 소비자마다 풀 전체를 혼자 채울 것처럼 각자 좁히면 합쳐서 N배로
/// 빨라진다.
///
/// 늘리지는 않는다(가드 창이 상한). 줄이는 것도 실측 실행 시간과 절대 하한에서 멈춘다 —
/// 앞 회차가 돌고 있는데 다음 회차가 겹쳐 뜨면 같은 작업 트리를 두 런타임이 만진다.
/// 하한에 걸려 모자란 속도는 회차당 기동 수가 흡수한다(`compute_plan`의 균등 시점 판정).
/// 표본(회당 소비)이 아직 없으면 기준을 그대로 쓴다.
///
/// `paused_consumers`는 반복 요청이 일시정지된 소비자 — 기록이 새로워도 다음 회차를 띄우지
/// 않으므로 창을 나눠 쓰는 수에 넣지 않는다(계획 단계의 몫 배분과 같은 규칙).
///
/// `quiet`(페이싱 스케줄)이 켜져 있으면 "리셋까지 남은 시간"은 제한 시간대를 뺀 **열린 시간**만
/// 센다 — 제한 중에는 회차가 뜨지 않으므로 남은 건수를 열린 시간에 펴야 목표에 닿는다.
/// 풀이 리셋까지 목표를 채우려면 필요한 기동 속도. 자동 주기와 처리량 점검이 같은 값을
/// 봐야 화면의 "달성 가능" 판정과 실제로 뜨는 간격이 어긋나지 않는다.
pub(crate) struct PoolDemand {
    /// 참여 계정의 균등 소비 속도 합(분당 기동 수). 회차마다 회당 소비가 달라 이 값도
    /// 워크플로마다 다르다 — 회차끼리 견주려면 아래 `percent_per_minute`를 쓴다.
    pub(crate) runs_per_minute: f64,
    /// 같은 뜻을 회당 소비와 무관한 단위로 잰 값(분당 사용률 %p). 리셋까지 목표를 채우려면
    /// 풀 전체가 이 속도로 소비해야 한다. 회차별 공급을 더해 견줄 수 있는 유일한 단위다.
    pub(crate) percent_per_minute: f64,
    /// 같은 창을 나눠 쓰는 활성 소비자 수. 한 소비자의 몫은 속도 ÷ 이 수다.
    pub(crate) consumers: usize,
}

fn measured_account_ids(store: &PacingStore, workflow_id: &str) -> Vec<String> {
    store
        .plans
        .iter()
        .rev()
        .filter(|plan| plan.workflow_id.as_deref() == Some(workflow_id))
        .take(DEFAULT_COST_WINDOWS)
        .flat_map(|plan| plan.entries.iter().map(|entry| entry.account_id.clone()))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

fn workflow_account_ids(
    store: &PacingStore,
    policy: Option<&UsageBudgetPolicy>,
    workflow_id: &str,
) -> Vec<String> {
    workflow_account_scope(policy, workflow_id)
        .map(|accounts| accounts.into_iter().collect())
        .unwrap_or_else(|| measured_account_ids(store, workflow_id))
}

/// 이 계산이 볼 사용량 창의 이름. 정책이 이름을 정해 두었으면 그것이 우선이고, 아니면
/// 기록된 계획이 쓰던 창을 따른다. 어느 쪽도 없으면 기본 창이다.
///
/// `workflow_id`를 주면 그 워크플로가 남긴 마지막 계획만 본다. 워크플로마다 다른 창을 쓸
/// 수 있어 전체 최신 계획을 따르면 남의 창으로 재게 된다.
fn resolved_window_label(
    store: &PacingStore,
    policy: &UsageBudgetPolicy,
    workflow_id: Option<&str>,
) -> String {
    policy
        .defaults
        .window_label
        .clone()
        .or_else(|| match workflow_id {
            Some(workflow_id) => store
                .plans
                .iter()
                .rev()
                .find(|plan| plan.workflow_id.as_deref() == Some(workflow_id))
                .map(|plan| plan.window_label.clone()),
            None => store.plans.last().map(|plan| plan.window_label.clone()),
        })
        .unwrap_or_else(|| DEFAULT_WINDOW_LABEL.to_owned())
}

/// 한 계정의 최신 표본이 말하는 남은 여유(%p)와 리셋까지 열린 시간(분). 표본이 없거나
/// 둘 중 하나라도 0 이하면 이 계정은 속도에 보탤 것이 없으므로 `None`이다.
///
/// 여기서는 계정 대표 창을 본다. 자동 주기 계산은 워크플로 단위라 이번 회차가 어느 모델을
/// 쓰는지 모르고(계획 단계에서야 정해진다), 모델을 모르는 채 모델군 창을 고르면 남의 모델군
/// 여유를 이 회차의 속도로 세게 된다. 그래서 한 모델군이 다 찬 Antigravity 계정은 다른
/// 모델군이 비어 있어도 속도에 0을 보태고, 주기는 기준값 쪽으로 남는다 — 목표를 넘기는
/// 방향이 아니라 천천히 도는 방향의 오차라 계획 단계의 건수 판정이 흡수한다.
fn account_headroom_window(
    store: &PacingStore,
    policy: &UsageBudgetPolicy,
    account_id: &str,
    window_label: &str,
    target: f64,
    now: i64,
    quiet: Option<&QuietSchedule>,
) -> Option<(f64, f64)> {
    let sample = store
        .series
        .get(&series_key(account_id, window_label))?
        .last()?;
    let headroom = (policy.effective_target(account_id, target) - sample.used_percent).max(0.0);
    let remaining_minutes = sample
        .resets_at
        .map(|resets_at| open_ms_between(quiet, now, resets_at) as f64 / 60_000.0)
        .unwrap_or(0.0);
    (headroom > 0.0 && remaining_minutes > 0.0).then_some((headroom, remaining_minutes))
}

/// 계정 집합 전체가 리셋까지 내야 할 사용률 속도. 회당 비용과 무관한 값이라 처리량 판정은
/// 특정 워크플로의 수요를 대표로 쓰지 않고 이 합계를 직접 계산한다.
fn percent_demand_for_accounts(
    store: &PacingStore,
    policy: Option<&UsageBudgetPolicy>,
    account_ids: &BTreeSet<String>,
    now: i64,
    quiet: Option<&QuietSchedule>,
) -> Option<f64> {
    let policy = policy?;
    let target = policy.defaults.target_percent?;
    let window_label = resolved_window_label(store, policy, None);
    let percent_per_minute: f64 = account_ids
        .iter()
        .filter_map(|account_id| {
            let (headroom, remaining_minutes) = account_headroom_window(
                store,
                policy,
                account_id,
                &window_label,
                target,
                now,
                quiet,
            )?;
            Some(headroom / remaining_minutes)
        })
        .sum();
    (percent_per_minute > 0.0).then_some(percent_per_minute)
}

/// 참여 계정의 균등 소비 속도 합과 그것을 나눠 쓰는 소비자 수. 목표·표본·여유 중 하나라도
/// 없어 속도를 잴 수 없으면 None — 이때 자동 주기는 기준 간격을 그대로 쓴다.
fn pool_demand(
    store: &PacingStore,
    policy: Option<&UsageBudgetPolicy>,
    workflow_id: &str,
    base_minutes: u32,
    now: i64,
    sharing_consumers: usize,
    quiet: Option<&QuietSchedule>,
) -> Option<PoolDemand> {
    let base = base_minutes.max(1);
    let policy = policy?;
    let target = policy.defaults.target_percent?;
    let window_label = resolved_window_label(store, policy, Some(workflow_id));
    // 회당 소비는 **실제로 돌았던** 계정으로 잰다. 여유는 **지금 참여하는** 계정으로
    // 본다 — 풀이나 워크플로 참여 계정을 바꾸면 옛 계정의 남은 여유를 채우려고 회차를
    // 재촉하는 일이 없어야 한다.
    let measured_ids = measured_account_ids(store, workflow_id);
    let account_ids = workflow_account_ids(store, Some(policy), workflow_id);
    let base_ms = i64::from(base) * 60_000;
    // 이 워크플로가 돌린 계정으로 먼저 재고, 그 표본이 사라졌으면 풀 전체로 잰다.
    //
    // 표본이 없다고 여기서 손을 떼면 그 회차는 자동 주기를 못 받아 기준 간격(가드 창)에
    // 묶인다. 오래 쉰 회차일수록 표본이 먼저 밀려나므로, 쉬었다는 이유로 느려지고 느려서
    // 표본을 못 만드는 고리에 갇힌다. 그러면서도 창을 나눠 쓰는 수에는 들어 다른 회차의
    // 몫까지 줄인다 — 공급은 안 하면서 분모만 차지한다.
    let measured_cost = |ids: &[String]| {
        measure_cost_per_run(
            store,
            &window_label,
            &BTreeMap::new(),
            ids,
            DEFAULT_COST_WINDOWS,
            base_ms,
        )
        .0
    };
    let cost = measured_cost(&measured_ids).or_else(|| measured_cost(&account_ids))?;
    // 계획이 회당 비용에 적용하는 하한을 여기서도 쓴다. 실측이 하한보다 작으면 계획은
    // 하한으로 계산하는데 여기만 원값을 쓰면 필요한 회차 수를 과대평가해 간격이 실제보다
    // 촘촘해진다.
    let cost = cost.max(DEFAULT_MIN_COST_PERCENT_PER_RUN);
    if cost <= 0.0 {
        return None;
    }
    // 회당 소비는 공급자마다 다르다(Claude는 창 %p가 크고 Codex는 작다). 풀 전체를 하나의
    // 평균으로 재면 비싼 공급자의 필요 건수를 낮게, 싼 쪽을 높게 봐 수요가 실제와 어긋난다
    // — 계획(`compute_plan`)도 같은 이유로 공급자별 실측을 쓰고 없을 때만 전역 평균으로
    // 떨어지므로, 간격을 정하는 이 계산도 같은 값을 봐야 한다.
    //
    // 공급자는 실행 기록에서 읽는다. 예산 정책에는 계정 id만 있고, 계정 등록부를 여기서
    // 읽으면 스케줄러 저장소 락 안에서 계정 락을 잡는 방향이 생겨 교착 위험이 된다.
    let provider_of: BTreeMap<&str, ProviderId> = store
        .runs
        .iter()
        .map(|run| (run.account_id.as_str(), run.provider))
        .collect();
    let mut provider_costs: BTreeMap<ProviderId, f64> = BTreeMap::new();
    for provider in ProviderId::ALL {
        let ids: Vec<String> = measured_ids
            .iter()
            .filter(|id| provider_of.get(id.as_str()) == Some(&provider))
            .cloned()
            .collect();
        if ids.is_empty() {
            continue;
        }
        if let (Some(measured), _) = measure_cost_per_run(
            store,
            &window_label,
            &BTreeMap::new(),
            &ids,
            DEFAULT_COST_WINDOWS,
            base_ms,
        ) {
            provider_costs.insert(provider, measured.max(DEFAULT_MIN_COST_PERCENT_PER_RUN));
        }
    }
    // 계정마다 최신 표본으로 남은 여유와 리셋까지 남은 시간을 보고, 그 계정이 남은
    // 기간에 균등하게 쓸 때의 분당 기동 수를 더한다. 계정마다 리셋 시각이 다르므로
    // 속도로 환산해야 창이 짧은 계정이 제 몫을 받는다.
    let mut runs_per_minute = 0.0;
    let mut percent_per_minute = 0.0;
    for account_id in &account_ids {
        let Some((account_headroom, remaining_minutes)) =
            account_headroom_window(store, policy, account_id, &window_label, target, now, quiet)
        else {
            continue;
        };
        // 이 계정의 공급자 실측이 있으면 그것으로, 아직 돈 적이 없으면 전역 평균으로 센다.
        let account_cost = provider_of
            .get(account_id.as_str())
            .and_then(|provider| provider_costs.get(provider))
            .copied()
            .unwrap_or(cost);
        runs_per_minute += account_headroom / account_cost / remaining_minutes;
        percent_per_minute += account_headroom / remaining_minutes;
    }
    if runs_per_minute <= 0.0 {
        return None;
    }
    // 같은 창을 나눠 쓰는 소비자 수는 **설정**에서 온다(`sharing_round_ids`). 계획 기록으로
    // 세던 옛 규칙은 아직 한 번도 안 뜬 회차를 못 봤다. 방금 켠 회차는 물론이고, 제한
    // 시간대가 길면 모든 회차의 기록이 판정 구간 밖으로 밀려나 저마다 "나 혼자"로 계산한
    // 뒤 제한이 풀리는 순간 몫이 겹쳤다.
    Some(PoolDemand {
        runs_per_minute,
        percent_per_minute,
        consumers: sharing_consumers.max(1),
    })
}

fn adaptive_cadence_minutes(
    store: &PacingStore,
    policy: Option<&UsageBudgetPolicy>,
    workflow_id: &str,
    base_minutes: u32,
    now: i64,
    sharing_consumers: usize,
    quiet: Option<&QuietSchedule>,
) -> u32 {
    let base = base_minutes.max(1);
    let Some(demand) = pool_demand(
        store,
        policy,
        workflow_id,
        base,
        now,
        sharing_consumers,
        quiet,
    ) else {
        return base;
    };
    let needed_minutes = (demand.consumers as f64 / demand.runs_per_minute).floor();
    if !needed_minutes.is_finite() || needed_minutes <= 0.0 {
        return MIN_AUTO_CADENCE_MINUTES.min(base);
    }
    let floor = MIN_AUTO_CADENCE_MINUTES.min(base);
    (needed_minutes as u32).clamp(floor, base)
}

type PendingRound<'a> = (&'a str, &'a ScheduledRequestInput);

/// 지금 예약 실행이 가능한 활성 창인지. 수동 실행은 이 판정과 무관하지만, 공유 몫과
/// 처리량은 예약 실행만 세므로 스케줄러의 `active_window_open`과 같은 경계를 쓴다.
fn active_window_open(input: &ScheduledRequestInput, now: i64) -> bool {
    !input.active_from.is_some_and(|from| now < from)
        && !input.active_until.is_some_and(|until| now > until)
}

/// 한 워크플로가 실제로 쓸 수 있는 계정 집합. 전역 풀이 있으면 워크플로 제한과 교집합을
/// 취하고, 둘 다 없을 때만 `None`(제한 없음)이다. 명시적으로 풀 전체를 고른 워크플로와
/// 제한을 두지 않은 워크플로가 같은 범위로 비교되도록 정규화한다.
pub(crate) fn workflow_account_scope(
    policy: Option<&UsageBudgetPolicy>,
    workflow_id: &str,
) -> Option<BTreeSet<String>> {
    let pool = policy.and_then(UsageBudgetPolicy::pool).map(|accounts| {
        accounts
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>()
    });
    let workflow = policy
        .and_then(|policy| policy.workflow_accounts(workflow_id))
        .cloned();
    match (pool, workflow) {
        (Some(pool), Some(workflow)) => Some(pool.intersection(&workflow).cloned().collect()),
        (Some(pool), None) => Some(pool),
        (None, Some(workflow)) => Some(workflow),
        (None, None) => None,
    }
}

fn round_input<'a>(
    schedules: &'a [ScheduledRequest],
    pending: Option<PendingRound<'a>>,
    id: &str,
) -> Option<&'a ScheduledRequestInput> {
    pending
        .filter(|(pending_id, _)| *pending_id == id)
        .map(|(_, input)| input)
        .or_else(|| {
            schedules
                .iter()
                .find(|schedule| schedule.id == id)
                .map(|schedule| &schedule.input)
        })
}

/// 같은 사용량 창을 나눠 쓰는 페이싱 회차 id.
///
/// 반복 요청이 켜져 있고, 페이싱 대상 워크플로를 돌며(`is_paced`), 예산 정책에서 참여가
/// 켜졌으며 지금 활성 창 안인 회차만 든다. `pending`은 저장 중이라 `schedules`에 아직
/// 반영되지 않은 회차의 새 입력이다 — 생성·수정·켜기·끄기 모두 저장될 값을 직접 본다.
fn sharing_round_ids(
    schedules: &[ScheduledRequest],
    policy: Option<&UsageBudgetPolicy>,
    is_paced: impl Fn(&str) -> bool,
    now: i64,
    pending: Option<PendingRound<'_>>,
) -> BTreeSet<String> {
    let participates = |id: &str, input: &ScheduledRequestInput| {
        input.enabled
            && active_window_open(input, now)
            && input
                .workflow
                .as_ref()
                .is_some_and(|action| is_paced(&action.workflow_id))
            && policy.is_none_or(|policy| policy.consumer_allowed(id))
    };
    let pending_id = pending.map(|(id, _)| id);
    let mut ids: BTreeSet<String> = schedules
        .iter()
        // 저장 중인 회차의 상태는 저장본이 아니라 `pending`이 말한다.
        .filter(|schedule| pending_id != Some(schedule.id.as_str()))
        .filter(|schedule| participates(&schedule.id, &schedule.input))
        .map(|schedule| schedule.id.clone())
        .collect();
    if let Some((id, input)) = pending {
        let is_new = schedules.iter().all(|schedule| schedule.id != id);
        let new_round_participates = is_new
            && input.enabled
            && active_window_open(input, now)
            && input
                .workflow
                .as_ref()
                .is_some_and(|action| is_paced(&action.workflow_id));
        // 새 회차는 스케줄 저장 뒤 소비자 정책에 등록된다. 이 계산 시점에는 아직 미등록이라
        // `consumer_allowed`가 거절하지만, 자기 자신을 분모에서 빼면 첫 간격만 과속한다.
        if participates(id, input) || new_round_participates {
            ids.insert(id.to_owned());
        }
    }
    ids
}

/// 계정 범위가 같은 회차만 한 소비 속도를 나눠 쓴다. 서로 다른 계정 집합을 전역 N으로
/// 나누면 A 전용·B 전용 회차가 각각 절반 속도로 돌아 두 계정 모두 목표를 놓친다. 부분적으로
/// 겹치는 집합도 같은 풀로 간주하지 않는다 — 예약·가드가 겹친 계정의 중복을 조정하고,
/// 자동 주기는 각 범위의 목표를 독립적으로 지키는 보수적인 쪽을 택한다.
fn sharing_round_ids_for_workflow(
    schedules: &[ScheduledRequest],
    policy: Option<&UsageBudgetPolicy>,
    is_paced: impl Fn(&str) -> bool,
    workflow_id: &str,
    now: i64,
    pending: Option<PendingRound<'_>>,
) -> BTreeSet<String> {
    let target_scope = workflow_account_scope(policy, workflow_id);
    sharing_round_ids(
        schedules,
        policy,
        |candidate| is_paced(candidate),
        now,
        pending,
    )
    .into_iter()
    .filter(|id| {
        round_input(schedules, pending, id)
            .and_then(|input| input.workflow.as_ref())
            .is_some_and(|action| {
                workflow_account_scope(policy, &action.workflow_id) == target_scope
            })
    })
    .collect()
}

/// 같은 계정 범위를 나눠 쓰는 페이싱 회차들이 리셋까지 목표를 채울 수 있는지.
///
/// 판정을 회차 하나가 아니라 **풀 단위**로 하는 이유는 단위 때문이다. 회당 소비는 워크플로마다
/// 달라서 "시간당 몇 건"은 회차끼리 견줄 수 없다 — 같은 풀 수요를 A는 2.7건, B는 1.6건으로
/// 읽는다. 회차별로 수요를 1/N씩 나눠 각자 재면 그 몫들이 전체로 다시 합쳐지지 않고, 설정이
/// 약한 회차 하나만 경고가 뜨면서 정작 풀이 모자란지는 아무 데도 안 나온다.
///
/// 그래서 공급자·워크플로와 무관한 단위인 **시간당 사용률(%p/h)**로 재고, 같은 계정 범위의
/// 회차별 공급만 더해 그 범위의 수요와 견준다. 서로 다른 계정 범위는 별도 판정이다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolThroughput {
    /// 리셋까지 목표를 채우려면 풀 전체가 시간당 소비해야 하는 사용률(%p/h).
    pub demand_percent_per_hour: f64,
    /// 켜져 있는 회차들이 낼 수 있는 합계(%p/h).
    pub supply_percent_per_hour: f64,
    pub reaches_target: bool,
    /// 회차별 기여. 어느 회차를 올려야 하는지 화면이 이름을 대고 말할 수 있게 한다.
    pub rounds: Vec<RoundThroughput>,
}

/// 회차 하나가 풀에 보태는 몫.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundThroughput {
    pub schedule_id: String,
    /// 이 회차의 동시 실행 상한(반복 요청의 페이싱 설정 maxRuns).
    pub max_runs: usize,
    /// 실제로 뜨는 회차 간격(분).
    pub cadence_minutes: u32,
    /// 최근 표본의 평균 회차 소요시간(분). 표본이 없으면 null.
    pub run_minutes: Option<f64>,
    /// 이 회차의 회당 소비(%p).
    pub cost_percent_per_run: f64,
    /// 이 회차가 지금 설정으로 내는 몫(%p/h).
    pub supply_percent_per_hour: f64,
    /// **이 회차만으로** 풀의 부족분을 메우려면 필요한 동시 실행 상한. 풀이 이미 충분하거나
    /// 이 회차의 회당 소비를 못 재면 null. 상한은 없다 — 계산된 값을 그대로 낸다.
    pub recommended_max_runs: Option<usize>,
}

/// 회차 하나의 설정. 화면이 이미 계산해 둔 간격을 그대로 받는다 — 같은 조회 안에서 두 번
/// 재면 표시와 판정이 갈릴 수 있다.
#[derive(Clone, Copy)]
pub struct RoundSettings<'a> {
    pub schedule_id: &'a str,
    pub workflow_id: &'a str,
    pub max_runs: usize,
    pub cadence_minutes: u32,
}

/// 슬롯 하나가 한 바퀴 도는 데 걸리는 시간(분) = 실행 + 다음 회차를 기다리는 시간.
///
/// 기동은 회차에서만 일어나므로 끝난 자리는 다음 회차까지 비어 있고, 소요시간이 흩어져
/// 있으면 그 대기는 0~간격 사이에 고르게 퍼져 평균 간격의 절반이 된다. 실행 시간을 덮는
/// 간격의 배수(`ceil(실행/간격) × 간격`)로 재면 소요시간이 거의 일정할 때만 맞는다 — 실측은
/// 13~38분으로 흩어져 슬롯이 서로 어긋나므로 그 식이 말하는 절벽은 일어나지 않는다.
fn slot_period_minutes(run_minutes: Option<f64>, cadence_minutes: u32) -> f64 {
    let cadence = f64::from(cadence_minutes.max(1));
    match run_minutes {
        Some(run) => run + cadence / 2.0,
        None => cadence,
    }
    .max(1.0)
}

/// 계정 범위가 같은 회차들의 공급을 더해 그 범위의 수요와 견준다. 수요를 잴 수 없으면
/// (표본·목표·여유 없음) None — 화면은 아무 말도 하지 않는다.
fn pool_throughput(
    store: &PacingStore,
    policy: Option<&UsageBudgetPolicy>,
    base_minutes: u32,
    now: i64,
    rounds: &[RoundSettings<'_>],
    quiet: Option<&QuietSchedule>,
) -> Option<PoolThroughput> {
    // 호출자는 같은 계정 범위의 회차만 건넨다. 정책 풀이 있어도 워크플로가 그중 일부만
    // 사용하면 그 교집합만 목표다 — 전역 풀을 쓰면 Antigravity 전용 회차 경고에 Claude·
    // Codex 회차와 수요가 섞인다. 제한이 없는 옛 설정(None)은 관측된 계정 합집합으로 잰다.
    let demand_accounts: BTreeSet<String> = rounds
        .first()
        .and_then(|round| workflow_account_scope(policy, round.workflow_id))
        .unwrap_or_else(|| {
            rounds
                .iter()
                .flat_map(|round| workflow_account_ids(store, policy, round.workflow_id))
                .collect()
        });
    let demand_percent_per_hour =
        percent_demand_for_accounts(store, policy, &demand_accounts, now, quiet)? * 60.0;
    let mut views: Vec<RoundThroughput> = Vec::new();
    for round in rounds {
        // 회당 소비는 그 회차의 수요 계산이 쓴 값과 같아야 한다. 수요를 못 재는 회차는
        // 공급도 셀 수 없어 0으로 두지 않고 건너뛴다 — 0으로 두면 "이 회차는 아무것도 못
        // 한다"고 단정하게 되는데, 표본이 없다는 것과 능력이 없다는 것은 다르다.
        let Some(round_demand) = pool_demand(
            store,
            policy,
            round.workflow_id,
            base_minutes,
            now,
            rounds.len(),
            quiet,
        ) else {
            continue;
        };
        let cost_percent_per_run = round_demand.percent_per_minute / round_demand.runs_per_minute;
        let run_minutes = mean_run_minutes(store, round.workflow_id);
        let period_minutes = slot_period_minutes(run_minutes, round.cadence_minutes);
        // 병렬 한 자리가 내는 몫. 권장값을 낼 때 이 값으로 부족분을 나눈다.
        let per_slot = cost_percent_per_run * 60.0 / period_minutes;
        views.push(RoundThroughput {
            schedule_id: round.schedule_id.to_owned(),
            max_runs: round.max_runs,
            cadence_minutes: round.cadence_minutes,
            run_minutes,
            cost_percent_per_run,
            supply_percent_per_hour: per_slot * round.max_runs as f64,
            recommended_max_runs: None,
        });
    }
    let supply_percent_per_hour: f64 = views.iter().map(|view| view.supply_percent_per_hour).sum();
    let reaches_target = supply_percent_per_hour >= demand_percent_per_hour;
    if !reaches_target {
        for view in &mut views {
            let per_slot = view.supply_percent_per_hour / view.max_runs.max(1) as f64;
            if per_slot <= 0.0 {
                continue;
            }
            let others = supply_percent_per_hour - view.supply_percent_per_hour;
            let needed = ((demand_percent_per_hour - others) / per_slot).ceil();
            view.recommended_max_runs =
                (needed.is_finite() && needed > view.max_runs as f64).then_some(needed as usize);
        }
    }
    Some(PoolThroughput {
        demand_percent_per_hour,
        supply_percent_per_hour,
        reaches_target,
        rounds: views,
    })
}

/// 처리량 판정을 실제 자동 주기의 공유 규칙과 똑같이 계정 범위별로 나눈다. 완전히 같은
/// 범위만 한 그룹이다. 부분적으로 겹치는 범위까지 합치면 각 워크플로가 채워야 하는 독립
/// 목표를 흐리므로 `sharing_round_ids_for_workflow`와 같이 별도 그룹으로 둔다.
fn pool_throughputs(
    store: &PacingStore,
    policy: Option<&UsageBudgetPolicy>,
    base_minutes: u32,
    now: i64,
    rounds: &[RoundSettings<'_>],
    quiet: Option<&QuietSchedule>,
) -> Vec<PoolThroughput> {
    let mut groups: BTreeMap<Option<BTreeSet<String>>, Vec<RoundSettings<'_>>> = BTreeMap::new();
    for round in rounds {
        groups
            .entry(workflow_account_scope(policy, round.workflow_id))
            .or_default()
            .push(*round);
    }
    groups
        .into_values()
        .filter_map(|group| pool_throughput(store, policy, base_minutes, now, &group, quiet))
        .collect()
}

/// `from`~`to` 사이에 페이싱이 돌 수 있는 시간(ms). 스케줄이 없으면 벽시계 차이 그대로.
fn open_ms_between(quiet: Option<&QuietSchedule>, from_ms: i64, to_ms: i64) -> i64 {
    match quiet {
        Some(quiet) => quiet.open_ms_between(from_ms, to_ms),
        None => (to_ms - from_ms).max(0),
    }
}

/// 반복 요청 하나의 자동 주기를 답한다. 스케줄러가 저장소를 한 번만 읽고 여러 요청에
/// 쓰도록 해석기로 묶었다. 예산 정책에서 나오는 페이싱 스케줄도 함께 실어, 스케줄러가
/// 회차 게이트와 자동 주기에 같은 스케줄을 쓴다.
pub(crate) struct AutoCadence {
    app_data_dir: std::path::PathBuf,
    /// 표본 저장소는 첫 자동 주기 질의에서만 읽는다. 반복 실행 틱마다 도는 자리라
    /// 자동 주기 회차가 실제로 뜰 때가 아니면 이 파일을 건드리지 않는다.
    store: std::cell::OnceCell<PacingStore>,
    policy: Option<UsageBudgetPolicy>,
    base_minutes: u32,
    /// 켜진 페이싱 스케줄(제한 시간대). 없으면 종일 작동.
    quiet: Option<QuietSchedule>,
    /// 페이싱 기능 전체 스위치. 꺼져 있으면 페이싱 회차의 예약 발화를 전부 막는다.
    pacing_on: bool,
    /// 페이싱 대상 워크플로 id. 스케줄이 켜져 있고 워크플로 회차를 판정할 때만 레지스트리를 읽는다.
    pacing_ids: std::cell::OnceCell<BTreeSet<String>>,
}

impl AutoCadence {
    /// 예산 정책과 페이싱 저장소를 읽어 해석기를 만든다. 두 저장소 모두 스케줄러 저장소
    /// 락 **밖에서** 읽어야 한다 — 정책 seed가 반대 순서로 스케줄러를 읽어 락 안에서
    /// 부르면 ABBA 교착이 된다.
    pub(crate) fn load(app_data_dir: &Path) -> Self {
        let policy = usage_budget_policy::load_optional(app_data_dir)
            .ok()
            .flatten();
        let base_minutes = policy
            .as_ref()
            .map(UsageBudgetPolicy::auto_cadence_minutes)
            .unwrap_or(usage_budget_policy::DEFAULT_AUTO_CADENCE_MINUTES);
        let quiet = policy.as_ref().and_then(UsageBudgetPolicy::quiet_schedule);
        let pacing_on = policy.as_ref().is_none_or(UsageBudgetPolicy::pacing_on);
        Self {
            app_data_dir: app_data_dir.to_path_buf(),
            store: std::cell::OnceCell::new(),
            policy,
            base_minutes,
            quiet,
            pacing_on,
            pacing_ids: std::cell::OnceCell::new(),
        }
    }

    /// 이 반복 요청에 적용되는 페이싱 스케줄. 스케줄이 켜져 있고 요청이 페이싱 대상 워크플로의
    /// 회차일 때만 Some — 일반 반복 요청과 페이싱 밖 워크플로는 제한을 받지 않는다. 대상 판정은
    /// 워크플로 레지스트리를 읽으므로 처음 필요할 때 한 번만 읽는다. 스케줄러 저장소 락 안에서
    /// 불려도 `ensure_single_active_paced_round`와 같은 순서라 교착이 없다.
    pub(crate) fn round_quiet(&self, input: &ScheduledRequestInput) -> Option<&QuietSchedule> {
        let quiet = self.quiet.as_ref()?;
        let workflow_id = input.workflow.as_ref()?.workflow_id.as_str();
        let pacing_ids = self.pacing_ids();
        pacing_ids.contains(workflow_id).then_some(quiet)
    }

    /// 페이싱 기능이 꺼져 있어 이 반복 요청의 예약 발화를 막아야 하는지. 스위치가 켜져
    /// 있으면 워크플로 레지스트리를 읽지 않고 곧바로 false다 — 반복 실행 틱마다 도는
    /// 자리라, 평소(켜짐) 경로에 파일 읽기를 더하지 않는다.
    ///
    /// 판정 대상은 `round_quiet`과 같은 "페이싱 대상 워크플로의 회차"다. 일반 반복 요청은
    /// 이 스위치와 무관하게 돈다 — 페이싱을 껐다고 사용자가 만든 다른 예약까지 멈추면
    /// 그 정지를 이 화면에서 설명할 방법이 없다.
    pub(crate) fn round_paused(&self, input: &ScheduledRequestInput) -> bool {
        if self.pacing_on {
            return false;
        }
        let Some(workflow_id) = input
            .workflow
            .as_ref()
            .map(|action| action.workflow_id.as_str())
        else {
            return false;
        };
        self.pacing_ids().contains(workflow_id)
    }

    /// 이 반복 요청이 완료조건을 채워 끝난 페이싱 회차인지. 완료된 회차는 정규 발화를 하지
    /// 않고 다음 실행 시각도 그대로 둔다 — "다시 시작"이 완료를 지우면 그 자리에서 이어진다.
    /// 판정은 정책의 소비자 항목(`completed_at`)이 하고, 페이싱 대상 워크플로의 회차에만 건다.
    pub(crate) fn round_completed(&self, schedule_id: &str, input: &ScheduledRequestInput) -> bool {
        let Some(policy) = self.policy.as_ref() else {
            return false;
        };
        let Some(config) = policy.consumers.get(schedule_id) else {
            return false;
        };
        if !config.completed() {
            return false;
        }
        input
            .workflow
            .as_ref()
            .is_some_and(|action| self.pacing_ids().contains(&action.workflow_id))
    }

    fn pacing_ids(&self) -> &BTreeSet<String> {
        self.pacing_ids.get_or_init(|| {
            crate::remote::pacing_workflow_ids(&self.app_data_dir, self.policy.as_ref())
                .unwrap_or_default()
        })
    }

    /// 같은 사용량 창을 나눠 쓰는 페이싱 회차 수.
    ///
    /// 반복 요청이 켜져 있고, 페이싱 대상 워크플로를 돌며, 예산 정책에서 참여가 켜진
    /// 회차만 센다. `pending`은 저장 중이라 `schedules`에 아직 반영되지 않은 회차의
    /// `(id, 켜짐)`이다 — 회차를 만들거나 켜고 끄는 중에는 저장본이 아직 옛 상태라,
    /// 그 회차를 여기서 직접 넣고 뺀다.
    ///
    /// 기록이 아니라 설정으로 세는 이유는 `pool_demand`의 주석에 있다.
    pub(crate) fn sharing_rounds(
        &self,
        schedules: &[ScheduledRequest],
        pending: Option<PendingRound<'_>>,
        now: i64,
    ) -> BTreeSet<String> {
        let pacing_ids = self.pacing_ids();
        sharing_round_ids(
            schedules,
            self.policy.as_ref(),
            |workflow_id| pacing_ids.contains(workflow_id),
            now,
            pending,
        )
    }

    /// 이 워크플로의 자동 주기(분). 같은 계정 범위를 쓰고 지금 실행 가능한 회차만 속도를
    /// 나눈다 — 서로 다른 계정 집합이나 닫힌 활성 창의 회차는 이 워크플로 몫을 줄이지 않는다.
    ///
    /// 표본 저장소를 처음 읽는 자리라 스케줄러 저장소 락 **안에서** 불릴 수 있다. 페이싱
    /// 저장소 락을 잡은 채 스케줄러 저장소를 읽는 경로는 없으므로(계획은 스케줄 목록을
    /// 락 밖에서 미리 받아 온다) 이 방향의 중첩은 교착이 되지 않는다. 반대 방향, 즉
    /// 정책 저장소는 seed가 스케줄러를 읽으므로 `load`에서 락 밖에 미리 읽어 둔다.
    pub(crate) fn minutes_for(
        &self,
        workflow_id: Option<&str>,
        schedules: &[ScheduledRequest],
        pending: Option<PendingRound<'_>>,
        now: i64,
    ) -> u32 {
        let Some(workflow_id) = workflow_id else {
            return self.base_minutes;
        };
        // Auto는 일반 채팅·일반 워크플로에서도 고를 수 있다. 페이싱 대상이 아닌 워크플로가
        // 예산 목표와 표본만 우연히 공유한다고 적응 주기를 물려받으면 안 된다.
        if !self.pacing_ids().contains(workflow_id) {
            return self.base_minutes;
        }
        // 목표가 없으면 채울 대상이 없어 적응이 일어나지 않는다. 저장소도 읽지 않는다.
        let has_target = self
            .policy
            .as_ref()
            .is_some_and(|policy| policy.defaults.target_percent.is_some());
        if !has_target {
            return self.base_minutes;
        }
        let store = self
            .store
            .get_or_init(|| load_store(&self.app_data_dir).unwrap_or_default());
        let pacing_ids = self.pacing_ids();
        let sharing = sharing_round_ids_for_workflow(
            schedules,
            self.policy.as_ref(),
            |candidate| pacing_ids.contains(candidate),
            workflow_id,
            now,
            pending,
        );
        // 스프린트 회차는 리셋을 기다리지 않고 감당 건수를 전부 내므로 간격도 하한까지 좁힌다.
        // 균등 소비 속도로 간격을 구하면 "남은 시간에 펴서" 느려지는데, 스프린트는 그 직선을
        // 지키지 않기로 한 회차다. 가드 창은 계획 쪽 상한이 그대로 지킨다.
        let sprint = self.policy.as_ref().is_some_and(|policy| {
            sharing
                .iter()
                .any(|id| policy.consumers.get(id).is_some_and(|config| config.sprint))
        });
        if sprint {
            return MIN_AUTO_CADENCE_MINUTES.min(self.base_minutes);
        }
        let sharing_consumers = sharing.len();
        adaptive_cadence_minutes(
            store,
            self.policy.as_ref(),
            workflow_id,
            self.base_minutes,
            now,
            sharing_consumers,
            self.quiet.as_ref(),
        )
    }

    /// 같은 계정 범위를 쓰는 회차 그룹별로 목표를 채울 수 있는지. `cadence_minutes`는 화면이
    /// 이미 계산해 둔 실제 간격을 그대로 받는다 — 같은 조회 안에서 두 번 재면 표시와 판정이
    /// 갈릴 수 있다.
    pub(crate) fn pool_throughputs_for(
        &self,
        rounds: &[RoundSettings<'_>],
        now: i64,
    ) -> Vec<PoolThroughput> {
        if rounds.is_empty() {
            return Vec::new();
        }
        let store = self
            .store
            .get_or_init(|| load_store(&self.app_data_dir).unwrap_or_default());
        pool_throughputs(
            store,
            self.policy.as_ref(),
            self.base_minutes,
            now,
            rounds,
            self.quiet.as_ref(),
        )
    }
}

fn window_of<'a>(
    usage: &'a AccountUsageView,
    label: &str,
) -> Option<&'a crate::accounts::AccountUsageWindow> {
    usage.windows.iter().find(|window| window.label == label)
}

/// 이 계정에서 계획 창과 **함께 지킬 창**(가드 창). 계정이 지금 보고하는 창 중 계획 창이
/// 아닌 계정 전체 창 전부에, 정책이 라벨로 지정한 창(모델별 창이라도)을 더한 것이다.
///
/// 라벨을 하나 박아 두지 않는 이유: Claude·Codex·Antigravity 모두 지금은 5시간 창을 주지만
/// Codex 라벨은 응답의 창 길이를 따르고(플랜에 따라 다름), 공급자가 창을 없애거나 길이를
/// 바꿀 수 있다. 계정이 보고하는 창을 그대로 따르면 라벨이 바뀌어도 가드가 조용히 빠지지
/// 않고, 창이 없어지면 가드가 비어 계획 창만 남는다. 모델별 창(`model_scoped`)은 그 모델을
/// 쓰지 않는 실행까지 막으므로 이름으로 지정했을 때만 든다.
///
/// 계획 창 자체가 모델군 창이면(Antigravity) 같은 모델군의 창만 함께 지킨다. 계정 대표 창은
/// 모델군 중 빡빡한 쪽이라 가드로 쓰면 다른 모델군의 소진이 이 모델군의 쿼터를 통째로
/// 막는다 — 한쪽이 100%인 계정에서 다른 쪽이 0%인 채 놀던 원인이다.
fn guard_windows<'a>(
    usage: &'a AccountUsageView,
    plan_window_label: &str,
    named_guard_label: Option<&str>,
) -> Vec<&'a crate::accounts::AccountUsageWindow> {
    let plan_group = window_group_prefix(plan_window_label);
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    usage
        .windows
        .iter()
        .filter(|window| window.label != plan_window_label)
        .filter(|window| match plan_group {
            Some(group) => window_group_prefix(&window.label) == Some(group),
            None => !window.model_scoped || named_guard_label == Some(window.label.as_str()),
        })
        .filter(|window| seen.insert(window.label.as_str()))
        .collect()
}

/// 모델군 창(`<모델군> · <창>`)의 모델군 이름. 계정 전체 창은 `None`이다.
fn window_group_prefix(label: &str) -> Option<&str> {
    label.split_once(" · ").map(|(group, _)| group)
}

/// 이 계정에서 이름 지정 가드가 실제로 가리키는 창.
///
/// 계획 창이 모델군 창이면 같은 모델군의 같은 이름 창(`Gemini Models · 5시간`)으로 옮긴다.
/// 그 창이 없으면 지정 가드는 이 모델군에 해당 사항이 없다(`None`) — 계정 대표 가드 창을
/// 그대로 두면 다른 모델군의 소진으로 이 회차를 막는다. 모델군 창이 아니면 준 이름 그대로다.
fn scoped_guard_label(
    usage: &AccountUsageView,
    plan_window_label: &str,
    named_guard_label: Option<&str>,
) -> Option<String> {
    let named = named_guard_label?;
    let Some(group) = window_group_prefix(plan_window_label) else {
        return Some(named.to_owned());
    };
    let scoped = format!("{group} · {named}");
    usage
        .windows
        .iter()
        .any(|window| window.label == scoped)
        .then_some(scoped)
}

/// 이번 회차에서 이 계정을 제외해야 하는 이유. 제외하지 않으면 None.
fn skip_reason(
    account: &ProviderAccountView,
    now: i64,
    guards: &[&crate::accounts::AccountUsageWindow],
    guard_percent: Option<f64>,
) -> Option<String> {
    if account.disabled {
        return Some("비활성 계정".to_owned());
    }
    if account.usage.rate_limited && account.usage.retry_at.is_some_and(|retry| retry > now) {
        return Some("공급자 재시도 대기".to_owned());
    }
    // 토큰 갱신 제한은 사용량 조회만 막고 실행에는 지장이 없다. 제외 사유로 쓰면
    // 조회가 막힌 계정을 영구히 쉬게 만든다.
    if account.auth_status != crate::accounts::AccountAuthStatus::Ready
        && !account.usage.token_refresh_limited
    {
        return Some("인증 상태 확인 필요".to_owned());
    }
    if let Some(limit) = guard_percent {
        if let Some(window) = guards.iter().find(|window| window.used_percent >= limit) {
            return Some(format!("{} 창 {:.0}% 초과", window.label, limit));
        }
    }
    None
}

/// 이번 호출의 소비자 id. 반복 요청 하나가 이 워크플로를 돌리면 그 반복 요청이
/// 소비자다 — 같은 워크플로를 쓰는 반복 요청이 둘이면 경로·비용이 다를 수 있어 갈라야
/// 한다. 둘 이상이거나 없으면 워크플로 id로 대신하고, 워크플로 지정이 없으면 수동 호출.
fn resolve_consumer_id(request: &UsagePacedRunsRequest, schedules: &[ScheduledRequest]) -> String {
    if let Some(trigger) = request
        .trigger_consumer_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return trigger.to_owned();
    }
    let Some(workflow_id) = request.cadence_workflow_id.as_deref() else {
        return ADHOC_CONSUMER_ID.to_owned();
    };
    let mut matching = schedules.iter().filter(|schedule| {
        schedule.input.enabled
            && schedule
                .input
                .workflow
                .as_ref()
                .is_some_and(|action| action.workflow_id == workflow_id)
    });
    match (matching.next(), matching.next()) {
        (Some(only), None) => only.id.clone(),
        _ => workflow_id.to_owned(),
    }
}

/// 이 계정·창의 예약을 계획 기록에서 펼친다. 소비자 표시가 없는 옛 기록과 기대 소비가
/// 없는 항목은 측정에만 쓰이고 예약은 아니다.
/// 예약을 낸 실행이 띄운 채팅이 모두 끝나고 그 뒤 표본이 있으면 예약은 정산됐다 — 그
/// 소비는 표본에 이미 보인다. 실행 기록이 없으면 판단하지 않고 TTL에 맡긴다.
fn claim_settled_by_runs(
    store: &PacingStore,
    execution_id: &str,
    account_id: &str,
    window_label: &str,
) -> bool {
    let runs: Vec<&RunRecord> = store
        .runs
        .iter()
        .filter(|run| {
            run.execution_id.as_deref() == Some(execution_id) && run.account_id == account_id
        })
        .collect();
    if runs.is_empty() {
        return false;
    }
    let Some(last_end) = runs
        .iter()
        .map(|run| run.ended_at)
        .collect::<Option<Vec<i64>>>()
        .and_then(|ends| ends.into_iter().max())
    else {
        return false;
    };
    store
        .series
        .get(&series_key(account_id, window_label))
        .is_some_and(|series| series.iter().any(|sample| sample.at > last_end))
}

/// 한 계정에 남은 예약을 창 하나의 관점으로 펼친다. `window_label`은 예약을 남긴 계획 창(회차
/// 창)이고, `plan_label`은 **이 계정이 채우는 창**, `claim_label`은 읽을 창이다. 뒤의 둘이
/// 같으면 계획 창 예약(항목의 본 필드), 다르면 그 라벨의 가드 창 예약(`guards`)을 읽는다.
/// 정산 판정도 읽는 창의 표본으로 한다 — 가드 창은 계획 창보다 자주 리셋되므로 같은 예약이
/// 계획 창에서는 열려 있고 가드 창에서는 소멸할 수 있다.
///
/// 계정이 채운 창이 다른 항목은 건너뛴다. 회차 창이 같아도 모델군이 다르면 남의 창 예약이고,
/// 두 창이 모두 미시작이면 기준선(0%·리셋 없음)까지 같아 창 판정으로는 갈리지 않는다.
fn claims_for_account(
    store: &PacingStore,
    window_label: &str,
    plan_label: &str,
    claim_label: &str,
    account_id: &str,
    live_chat_ids: &BTreeSet<&str>,
) -> Vec<Claim> {
    store
        .plans
        .iter()
        .filter(|plan| plan.window_label == window_label)
        .filter(|plan| {
            !plan.execution_id.as_deref().is_some_and(|execution_id| {
                claim_settled_by_runs(store, execution_id, account_id, claim_label)
            })
        })
        .filter_map(|plan| {
            let consumer_id = plan.consumer_id.clone()?;
            let cadence_ms = plan.cadence_ms?;
            let entry = plan
                .entries
                .iter()
                .find(|entry| entry.account_id == account_id)?;
            if entry_window_label(entry, &plan.window_label) != plan_label {
                return None;
            }
            let (expected_cost_percent, used_percent_at_claim, resets_at_at_claim) =
                if claim_label == plan_label {
                    (
                        entry.expected_cost_percent,
                        entry.used_percent_at_claim,
                        entry.resets_at_at_claim,
                    )
                } else {
                    let guard = entry.guards.get(claim_label)?;
                    (
                        guard.expected_cost_percent,
                        guard.used_percent_at_claim,
                        guard.resets_at_at_claim,
                    )
                };
            // 이 계획의 실행이 이 계정에 띄운 채팅이 아직 돌고 있으면 예약은 살아 있다 —
            // 발행자 간격이 지나 다음 회차가 시작돼도 그 소비는 표본에 다 보이지 않는다.
            // 실행 기록의 종료 시각은 턴 종료 훅이 남기므로 백엔드가 죽거나 런타임이 훅
            // 없이 사라지면 영원히 비어 있다. 살아 있는 채팅 목록으로 확인해야 고아
            // 기록이 예약을 영영 열어 두지 않는다.
            let active = plan.execution_id.as_deref().is_some_and(|execution_id| {
                store.runs.iter().any(|run| {
                    run.execution_id.as_deref() == Some(execution_id)
                        && run.account_id == account_id
                        && run.ended_at.is_none()
                        && live_chat_ids.contains(run.chat_id.as_str())
                })
            });
            Some(Claim {
                consumer_id,
                at: plan.at,
                cadence_ms,
                count: entry.count,
                expected_cost_percent: expected_cost_percent?,
                used_percent_at_claim: used_percent_at_claim?,
                resets_at_at_claim,
                active,
            })
        })
        .collect()
}

/// 출처가 있는 실행 하나에서 얻은 관측.
#[derive(Debug, Clone, PartialEq)]
struct RunObservation {
    /// 실행이 돌았던 계정. 화면이 계정(에이전트)별 회당 소비를 따로 보여 주는 데 쓴다.
    account_id: String,
    ended_at: i64,
    /// 이 실행에 귀속된 창 증가(%p). 겹친 실행과는 활성 시간 비율로 나눈 값.
    cost_percent: f64,
    /// 깨끗한 관측 1.0, 겹친 관측 0.5.
    weight: f64,
    tokens: Option<u64>,
    /// 이 실행이 돈 추론수준. 등급별 회당 소비를 가르는 축이다.
    reasoning_effort: Option<ReasoningEffort>,
}

/// 소비자·공급자의 실행 기록을 오래된 것부터 관측으로 바꾼다. 실행 시작·종료로 그 계정의
/// 표본을 괄호 쳐 증가분을 재고, 같은 계정에서 다른 실행과 겹친 구간은 활성 시간 비율로
/// 나누고 가중을 낮춘다. 괄호 칠 표본이 없거나 창이 리셋된 실행은 뺀다.
///
/// 겹침은 **이 창을 함께 채우는** 실행만 센다([`run_consumes_window`]). Antigravity 계정은
/// 모델군마다 쿼터가 따로라 Gemini 실행은 이 창을 1%p도 올리지 않는데, 그것까지 겹침으로
/// 세면 이 실행이 혼자 낸 증가가 절반으로 깎여 회당 소비가 실제의 절반으로 실측되고, 구간도
/// 남의 종료까지 늘어나 뒤 표본을 놓친 관측이 통째로 버려진다. 같은 이유로 이 창을 채우지
/// 않는 실행은 관측 대상도 아니다 — 그 사이의 증가는 다른 모델군이 낸 것이다.
fn consumer_observations(
    store: &PacingStore,
    consumer_id: &str,
    provider: ProviderId,
    window_label: &str,
) -> Vec<RunObservation> {
    let mut observations = Vec::new();
    for run in store
        .runs
        .iter()
        .filter(|run| run.consumer_id == consumer_id && run.provider == provider)
    {
        let Some(ended_at) = run.ended_at else {
            continue;
        };
        if !run_consumes_window(run, window_label) {
            continue;
        }
        let Some(series) = store.series.get(&series_key(&run.account_id, window_label)) else {
            continue;
        };
        let target = RunSpan {
            start: run.started_at,
            end: ended_at,
        };
        let others: Vec<RunSpan> = store
            .runs
            .iter()
            .filter(|other| {
                other.chat_id != run.chat_id
                    && other.account_id == run.account_id
                    && run_consumes_window(other, window_label)
            })
            .map(|other| RunSpan {
                start: other.started_at,
                end: other.ended_at.unwrap_or(ended_at),
            })
            .filter(|other| other.start < target.end && other.end > target.start)
            .collect();
        let span_start = others
            .iter()
            .map(|other| other.start)
            .fold(target.start, i64::min);
        let span_end = others
            .iter()
            .map(|other| other.end)
            .fold(target.end, i64::max);
        let Some(before) = series.iter().rev().find(|sample| sample.at <= span_start) else {
            continue;
        };
        let Some(after) = series.iter().find(|sample| {
            sample.at >= span_end && sample.at <= span_end.saturating_add(RUN_AFTER_SAMPLE_GRACE_MS)
        }) else {
            continue;
        };
        if !same_reset_window(before, after) || after.used_percent <= before.used_percent {
            continue;
        }
        let (share, weight) = usage_budget::overlap_share(&target, &others);
        observations.push(RunObservation {
            account_id: run.account_id.clone(),
            ended_at,
            cost_percent: (after.used_percent - before.used_percent) * share,
            weight,
            tokens: run.tokens.map(|tokens| tokens.total()),
            reasoning_effort: run.reasoning_effort.clone(),
        });
    }
    observations.sort_by_key(|observation| observation.ended_at);
    observations
}

/// 소비자·공급자의 **추론수준별** 회당 소비(%p)와 토큰 중앙값, 관측 수.
///
/// 계획이 등급을 고를 때 그 등급의 실제 값으로 여유를 재려면 이 표가 필요하다. 등급을 섞은
/// 평균 하나로 여유를 세면, low 기준으로 센 여유로 max를 골라 놓고 서너 배를 쓰게 된다.
fn consumer_cost_by_effort(
    store: &PacingStore,
    consumer_id: &str,
    provider: ProviderId,
    window_label: &str,
    cost_windows: usize,
) -> BTreeMap<ReasoningEffort, (Option<f64>, Option<f64>, usize)> {
    let observations = consumer_observations(store, consumer_id, provider, window_label);
    let mut by_effort: BTreeMap<ReasoningEffort, Vec<&RunObservation>> = BTreeMap::new();
    for observation in &observations {
        let Some(effort) = observation.reasoning_effort.clone() else {
            continue;
        };
        by_effort.entry(effort).or_default().push(observation);
    }
    by_effort
        .into_iter()
        .map(|(effort, runs)| {
            let recent: Vec<&RunObservation> = runs
                .iter()
                .rev()
                .take(cost_windows.max(1))
                .copied()
                .collect();
            let cost = usage_budget::weighted_mean(
                &recent
                    .iter()
                    .map(|o| (o.cost_percent, o.weight))
                    .collect::<Vec<_>>(),
            )
            .map(|(cost, _)| cost);
            let tokens = usage_budget::median(
                &recent
                    .iter()
                    .filter_map(|o| o.tokens)
                    .map(|t| t as f64)
                    .collect::<Vec<_>>(),
            );
            (effort, (cost, tokens, runs.len()))
        })
        .collect()
}

/// 소비자·공급자별 회당 소비: 최근 `cost_windows`개 관측의 가중 평균. 가중치 합이 문턱에
/// 못 미치면 None — 전역 추정으로 물러난다.
fn measure_consumer_cost(
    store: &PacingStore,
    consumer_id: &str,
    provider: ProviderId,
    window_label: &str,
    cost_windows: usize,
) -> Option<(f64, f64)> {
    let observations = consumer_observations(store, consumer_id, provider, window_label);
    let recent: Vec<(f64, f64)> = observations
        .iter()
        .rev()
        .take(cost_windows)
        .map(|observation| (observation.cost_percent, observation.weight))
        .collect();
    usage_budget::weighted_mean(&recent)
}

/// 절감 목표 보고. 기준선은 처음 `baseline_runs`회, 현재는 최근 `cost_windows`회의
/// 중앙값이다. 토큰이 있는 관측(Claude)이 기준선·현재 양쪽에 있으면 토큰으로, 아니면 창
/// %p로 달성률을 잰다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavingsReport {
    observations: usize,
    /// 기준선을 붙박은 시각. 없으면 아직 확정 전이라 값이 흔들릴 수 있다.
    baseline_fixed_at: Option<i64>,
    baseline_cost_percent: Option<f64>,
    current_cost_percent: Option<f64>,
    baseline_tokens: Option<f64>,
    current_tokens: Option<f64>,
    /// 달성률(%). 양수면 줄었고 음수면 늘었다. 기준선이 아직 없으면 None.
    achieved_reduction_percent: Option<f64>,
    /// 달성률의 근거 지표.
    metric: Option<&'static str>,
    /// 상한을 넘었는지와 어느 상한인지.
    over_ceiling: Option<String>,
}

/// 기준선이 다 모인 소비자·공급자의 기준선을 확정해 저장소에 붙박는다. 이미 확정된 것은
/// 건드리지 않는다 — 한 번 잡은 과녁은 움직이지 않아야 달성률이 추세로 읽힌다.
/// 새로 확정한 것이 있으면 `true`(호출부가 저장 여부를 정한다).
fn freeze_ready_baselines(
    store: &mut PacingStore,
    consumer_id: &str,
    window_label: &str,
    provider_labels: &BTreeMap<ProviderId, String>,
    baseline_runs: usize,
    now: i64,
) -> bool {
    let baseline_runs = baseline_runs.max(1);
    let mut fresh: Vec<(String, SavingsBaseline)> = Vec::new();
    for provider in ProviderId::ALL {
        // 회차 창과 다른 창을 채우는 공급자는 그 창에서 얼린다 — 상한 판정도 같은 창의
        // 기준선을 찾는다([`consumer_over_ceiling`]).
        let window_label = provider_labels
            .get(&provider)
            .map_or(window_label, String::as_str);
        let key = baseline_key(consumer_id, provider, window_label);
        if store.baselines.contains_key(&key) {
            continue;
        }
        let observations = consumer_observations(store, consumer_id, provider, window_label);
        if observations.len() < baseline_runs {
            continue;
        }
        let head = &observations[..baseline_runs];
        let cost_percent =
            usage_budget::median(&head.iter().map(|o| o.cost_percent).collect::<Vec<_>>());
        let tokens = usage_budget::median(
            &head
                .iter()
                .filter_map(|o| o.tokens)
                .map(|t| t as f64)
                .collect::<Vec<_>>(),
        );
        fresh.push((
            key,
            SavingsBaseline {
                fixed_at: now,
                runs: baseline_runs,
                cost_percent,
                tokens,
            },
        ));
    }
    let changed = !fresh.is_empty();
    store.baselines.extend(fresh);
    changed
}

#[allow(clippy::too_many_arguments)]
fn consumer_savings(
    store: &PacingStore,
    consumer_id: &str,
    provider: ProviderId,
    window_label: &str,
    baseline_runs: usize,
    cost_windows: usize,
    max_tokens_per_run: Option<u64>,
    max_cost_percent_per_run: Option<f64>,
) -> SavingsReport {
    let observations = consumer_observations(store, consumer_id, provider, window_label);
    let baseline_runs = baseline_runs.max(1);
    let baseline: Vec<&RunObservation> = observations.iter().take(baseline_runs).collect();
    let current: Vec<&RunObservation> = observations
        .iter()
        .rev()
        .take(cost_windows.max(1))
        .collect();
    let median_cost = |set: &[&RunObservation]| {
        usage_budget::median(&set.iter().map(|o| o.cost_percent).collect::<Vec<_>>())
    };
    let median_tokens = |set: &[&RunObservation]| {
        let tokens: Vec<f64> = set
            .iter()
            .filter_map(|o| o.tokens)
            .map(|t| t as f64)
            .collect();
        usage_budget::median(&tokens)
    };
    // 확정해 둔 기준선이 있으면 그것이 과녁이다. 없으면(아직 확정 전이거나 옛 저장소)
    // 처음 N회가 다 모였을 때만 그 자리에서 계산한다.
    let frozen = store
        .baselines
        .get(&baseline_key(consumer_id, provider, window_label));
    let baseline_ready = observations.len() >= baseline_runs;
    let baseline_cost = match frozen {
        Some(fixed) => fixed.cost_percent,
        None => baseline_ready.then(|| median_cost(&baseline)).flatten(),
    };
    let baseline_tokens = match frozen {
        Some(fixed) => fixed.tokens,
        None => baseline_ready.then(|| median_tokens(&baseline)).flatten(),
    };
    let current_cost = median_cost(&current);
    let current_tokens = median_tokens(&current);
    let (achieved, metric) = match (baseline_tokens, current_tokens) {
        (Some(base), Some(now)) => (usage_budget::reduction_percent(base, now), Some("tokens")),
        _ => match (baseline_cost, current_cost) {
            (Some(base), Some(now)) => (
                usage_budget::reduction_percent(base, now),
                Some("costPercent"),
            ),
            _ => (None, None),
        },
    };
    let mut over_ceiling = None;
    if let (Some(limit), Some(now)) = (max_tokens_per_run, current_tokens) {
        if now > limit as f64 {
            over_ceiling = Some(format!("회당 토큰 {now:.0} > 상한 {limit}"));
        }
    }
    if over_ceiling.is_none() {
        if let (Some(limit), Some(now)) = (max_cost_percent_per_run, current_cost) {
            if now > limit {
                over_ceiling = Some(format!("회당 소비 {now:.2}%p > 상한 {limit:.2}%p"));
            }
        }
    }
    SavingsReport {
        observations: observations.len(),
        baseline_fixed_at: frozen.map(|fixed| fixed.fixed_at),
        baseline_cost_percent: baseline_cost,
        current_cost_percent: current_cost,
        baseline_tokens,
        current_tokens,
        achieved_reduction_percent: achieved,
        metric,
        over_ceiling,
    }
}

/// 회차 계획을 계산한다. 저장소는 읽기만 한다 — 계획 기록은 호출부가 남긴다.
/// `compute_plan` 인자 중 계획 산술이 그대로 쓰는 상한들.
#[derive(Debug, Clone, Copy)]
struct PlanLimits {
    requested_target: f64,
    cost_windows: usize,
    min_cost_percent_per_run: f64,
}

/// 계획 인자를 검증하고 기본값을 채운다. 본문 앞머리에 늘어서 있던 검증을 한곳에 모아
/// 실패 메시지와 기본값을 나란히 읽게 했다.
fn validate_plan_request(request: &UsagePacedRunsRequest) -> Result<PlanLimits, CoreError> {
    if request.window_label.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "채울 창의 라벨이 없습니다. 워크플로 인자 windowLabel이나 워크플로 페이싱 탭의 기본 창을 지정하세요".to_owned(),
        ));
    }
    let Some(requested_target) = request.target_percent else {
        return Err(CoreError::InvalidInput(
            "목표 사용률이 없습니다. 워크플로 인자 targetPercent나 워크플로 페이싱 탭의 기본 목표를 지정하세요".to_owned(),
        ));
    };
    usage_budget_policy::validate_percent(Some(requested_target), "목표 사용률")?;
    let cost_windows = request.cost_windows.unwrap_or(DEFAULT_COST_WINDOWS);
    if cost_windows == 0 || cost_windows > MAX_COST_WINDOWS {
        return Err(CoreError::InvalidInput(format!(
            "실측 구간 수는 1~{MAX_COST_WINDOWS} 사이여야 합니다"
        )));
    }
    let min_cost_percent_per_run = request
        .min_cost_percent_per_run
        .unwrap_or(DEFAULT_MIN_COST_PERCENT_PER_RUN);
    if !(MIN_COST_FLOOR..=MAX_COST_FLOOR).contains(&min_cost_percent_per_run) {
        return Err(CoreError::InvalidInput(format!(
            "회당 비용 하한은 {MIN_COST_FLOOR}~{MAX_COST_FLOOR}%p 사이여야 합니다"
        )));
    }
    Ok(PlanLimits {
        requested_target,
        cost_windows,
        min_cost_percent_per_run,
    })
}

/// 이번 회차의 후보 계정을 고른다. 인자 필터 → 정책 계정 풀 → 워크플로 참여 계정 순으로
/// 좁히며, 좁힐 때마다 근거를 남긴다.
fn select_candidate_accounts<'a>(
    request: &UsagePacedRunsRequest,
    inputs: &PacingInputs<'a>,
    reasoning: &mut Vec<String>,
) -> Result<Vec<&'a ProviderAccountView>, CoreError> {
    let policy = inputs.policy;
    let prefix = request.email_prefix.as_deref().unwrap_or_default();
    // 빈 문자열은 "선언하지 않음"이다. 화면이 만든 계약은 모델 칸을 비워도 `Some("")`을
    // 싣기 때문에, 이것을 걸러 내지 않으면 분류기가 빈 이름을 가르려다 실패하고 계획
    // 전체가 죽는다 — Antigravity 계정이 풀에 있는 모든 회차가 그렇게 멈춘다(2026-09-25).
    let antigravity_resource_id = request
        .antigravity_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(crate::antigravity_usage::pacing_resource_id_for_model)
        .transpose()?;
    let candidates: Vec<&ProviderAccountView> = inputs
        .accounts
        .iter()
        .filter(|account| {
            request
                .providers
                .as_ref()
                .is_none_or(|providers| providers.contains(&account.provider))
        })
        // Antigravity 쿼터는 모델군 두 개다. 모델을 선언하지 않은 기존 회차는 이 공급자를
        // 전혀 보지 않고, 선언한 회차는 등록 계정을 그대로 후보로 넣되 **그 모델군 창**으로
        // 계획한다([`account_window_labels`]).
        //
        // 모델군을 계정처럼 낸 자원 행(`antigravity:*`)은 계정 레지스트리가 이 공급자를 담기
        // 전의 것이라 등록 계정이 없는 설치에만 남아 있다(`remote::antigravity_resource_rows`).
        // 그 행만 이번 모델군 하나로 좁힌다 — 계정 id를 자원 id와 견주던 옛 판정은 계정을
        // 등록하는 순간 Antigravity를 통째로 후보에서 떨어뜨렸다.
        .filter(|account| {
            account.provider != ProviderId::Antigravity
                || antigravity_resource_id.is_some_and(|resource_id| {
                    !crate::antigravity_usage::is_pacing_resource_id(&account.id)
                        || account.id == resource_id
                })
        })
        // 이메일 접두사는 계정을 가리는 인자다. 이메일이 없는 것은 모델군 자원 행뿐이라 그
        // 행만 지나간다 — 등록 계정까지 공급자 이름으로 면제하면 접두사로 계정 하나를 집은
        // 회차에 다른 Antigravity 계정이 따라 들어온다.
        .filter(|account| {
            prefix.is_empty()
                || crate::antigravity_usage::is_pacing_resource_id(&account.id)
                || account
                    .email
                    .as_deref()
                    .is_some_and(|email| email.starts_with(prefix))
        })
        .collect();
    // 정책 풀이 있으면 그 계정만 후보다. 인자 필터는 풀 안에서 더 좁힐 뿐이다.
    let candidates: Vec<&ProviderAccountView> = match policy.and_then(|policy| policy.pool()) {
        Some(pool) => {
            let filtered: Vec<&ProviderAccountView> = candidates
                .into_iter()
                .filter(|account| pool.contains(account.id.as_str()))
                .collect();
            reasoning.push(format!(
                "정책 계정 풀 {}개 중 조건에 맞는 {}개를 후보로 봅니다",
                pool.len(),
                filtered.len()
            ));
            filtered
        }
        None => {
            if policy.is_some() {
                reasoning.push("정책에 켜진 계정이 없어 인자 필터만 적용합니다".to_owned());
            }
            candidates
        }
    };
    // 워크플로별 참여 계정이 정해져 있으면 그 집합으로 한 번 더 좁힌다.
    let candidates: Vec<&ProviderAccountView> = match request
        .cadence_workflow_id
        .as_deref()
        .and_then(|workflow_id| policy.and_then(|policy| policy.workflow_accounts(workflow_id)))
    {
        Some(allowed) => {
            let filtered: Vec<&ProviderAccountView> = candidates
                .into_iter()
                .filter(|account| allowed.contains(account.id.as_str()))
                .collect();
            reasoning.push(format!(
                "워크플로 참여 계정 {}개로 좁혀 {}개가 남았습니다",
                allowed.len(),
                filtered.len()
            ));
            filtered
        }
        None => candidates,
    };
    // 로컬 모델만 고른 회차는 계정이 하나도 없어도 성립한다. 로컬은 계정도 창도 없이
    // 상한 밖에서 서므로, 여기서 막으면 그 회차가 시작조차 못 한다.
    if candidates.is_empty() && request.local_models.is_empty() {
        return Err(CoreError::NotFound(
            "조건에 맞는 계정이 없습니다".to_owned(),
        ));
    }
    Ok(candidates)
}

/// 회차 창과 다른 창을 채우는 계정의 계획 창 라벨(계정 id → 라벨).
///
/// Antigravity 계정 하나는 모델군 두 개의 쿼터를 따로 들고 있고 계정 대표 창은 그중 빡빡한
/// 쪽이라, 이번 회차 모델이 쓰는 모델군 창을 따로 봐야 한다. 다른 공급자는 회차 창 그대로라
/// 표에 담지 않는다 — 비어 있으면 종전과 완전히 같은 계산이다.
///
/// 계획 기록(`PlanRecord.window_label`)과 소비자 배분은 회차 창 하나를 계속 쓴다. 예약은
/// 계정 항목의 본 필드에 그 계정의 계획 창 기준선으로 남으므로 라벨이 갈려도 정산은 맞는다.
type AccountWindowLabels = BTreeMap<String, String>;

/// 계정별 계획 창을 정한다. 모델군을 계정처럼 낸 옛 자원 행은 모델군 창을 따로 보고하지
/// 않으므로 회차 창을 그대로 쓴다.
fn account_window_labels(
    request: &UsagePacedRunsRequest,
    candidates: &[&ProviderAccountView],
    reasoning: &mut Vec<String>,
) -> Result<AccountWindowLabels, CoreError> {
    let Some(model) = request.antigravity_model.as_deref() else {
        return Ok(AccountWindowLabels::new());
    };
    let mut labels = AccountWindowLabels::new();
    for account in candidates.iter().filter(|account| {
        account.provider == ProviderId::Antigravity
            && !crate::antigravity_usage::is_pacing_resource_id(&account.id)
    }) {
        let label = crate::antigravity_usage::model_window_label(
            &account.usage,
            model,
            &request.window_label,
        )?;
        if label != request.window_label {
            labels.insert(account.id.clone(), label);
        }
    }
    let distinct: BTreeSet<&str> = labels.values().map(String::as_str).collect();
    if !distinct.is_empty() {
        reasoning.push(format!(
            "Antigravity 계정은 모델 {model}이 쓰는 모델군 창({})으로 계획합니다",
            distinct.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(labels)
}

/// 공급자별 계획 창. 회당 소비 실측은 공급자 단위라 계정별 라벨을 하나로 모은다. 같은
/// 공급자의 계정이 서로 다른 라벨을 보고하면(공급자가 그룹 이름을 바꾸는 중) 먼저 나온
/// 계정의 라벨을 쓴다 — 실측이 그 라벨의 표본만 보게 되어 값이 섞이지 않는다.
fn provider_window_labels(
    candidates: &[&ProviderAccountView],
    window_labels: &AccountWindowLabels,
) -> BTreeMap<ProviderId, String> {
    let mut labels: BTreeMap<ProviderId, String> = BTreeMap::new();
    for account in candidates {
        if let Some(label) = window_labels.get(&account.id) {
            labels
                .entry(account.provider)
                .or_insert_with(|| label.clone());
        }
    }
    labels
}

/// 이 계정이 채울 창. 표에 없으면 회차 창이다.
fn account_window_label<'a>(
    window_labels: &'a AccountWindowLabels,
    account_id: &str,
    round_label: &'a str,
) -> &'a str {
    window_labels
        .get(account_id)
        .map_or(round_label, String::as_str)
}

/// `resolve_cadence`가 낸 회차 간격 결정. 남은 회차 수·목표 직선·몫 배분이 모두 이 값들을
/// 기준으로 돌아 한 벌로 묶어 넘긴다.
struct CadenceDecision {
    /// 정책이 정한 기준 자동 주기(분). 소비자 활성 판정 구간의 기준이기도 하다.
    base_auto_minutes: u32,
    /// 이번 회차가 실제로 쓸 간격(분).
    minutes: u32,
    /// 그 간격을 어디서 읽었는지(`workflow:<id>` 또는 `request`).
    source: String,
    /// 페이싱 스케줄(제한 시간대). 켜져 있으면 남은 시간·경과 시간을 모두 열린 시간으로 잰다.
    quiet: Option<QuietSchedule>,
    /// 일시정지된 반복 요청 — 같은 창을 나눠 쓰는 수에서 뺀다.
    paused: BTreeSet<String>,
    /// 설정상 같은 창을 나눠 쓰는 회차 집합.
    sharing_rounds: BTreeSet<String>,
}

/// 이번 회차의 간격과 그 간격을 재는 데 필요한 부수 집합을 정한다. 계획 본문 앞머리에
/// 늘어서 있던 주기 결정을 한곳에 모아 "무엇을 기준으로 몇 분인지"를 나란히 읽게 했다.
fn resolve_cadence(
    store: &PacingStore,
    request: &UsagePacedRunsRequest,
    inputs: &PacingInputs<'_>,
    reasoning: &mut Vec<String>,
) -> Result<CadenceDecision, CoreError> {
    let policy = inputs.policy;
    // 자동 주기는 워크플로마다 다르다(회당 소비·기동 상한이 다르므로). 계획의 남은 회차
    // 수 계산도 실제로 뜰 간격과 같은 값을 써야 한다.
    let base_auto_minutes = policy.map_or(
        usage_budget_policy::DEFAULT_AUTO_CADENCE_MINUTES,
        UsageBudgetPolicy::auto_cadence_minutes,
    );
    // 일시정지된 반복 요청. 자동 주기와 아래 몫 배분 모두 이 소비자를 "같은 창을 나눠
    // 쓰는 수"에서 뺀다 — 기록이 새로워도 다음 회차를 띄우지 않으므로 몫을 잡지 않는다.
    let paused: BTreeSet<String> = inputs
        .schedules
        .iter()
        .filter(|schedule| !schedule.input.enabled)
        .map(|schedule| schedule.id.clone())
        .collect();
    // 페이싱 스케줄(제한 시간대). 켜져 있으면 남은 시간·경과 시간을 모두 열린 시간으로 잰다.
    let quiet = policy.and_then(UsageBudgetPolicy::quiet_schedule);
    // 공개 진입점이 레지스트리에서 넘긴 페이싱 집합을 그대로 쓴다. 정책 소비자가 아직 하나도
    // 없는 초기 상태라도 일반 워크플로 반복 요청까지 분모에 들어가면 스케줄러의 실제 주기와
    // 계획이 서로 다른 간격을 보게 된다.
    let is_paced = |workflow_id: &str| {
        inputs
            .pacing_workflow_ids
            .is_none_or(|ids| ids.contains(workflow_id))
    };
    let cadence_workflow_id = request.cadence_workflow_id.as_deref();
    let sharing_rounds = cadence_workflow_id.map_or_else(BTreeSet::new, |workflow_id| {
        sharing_round_ids_for_workflow(
            inputs.schedules,
            policy,
            is_paced,
            workflow_id,
            inputs.now,
            None,
        )
    });
    let auto_minutes = request
        .cadence_workflow_id
        .as_deref()
        .map(|workflow_id| {
            adaptive_cadence_minutes(
                store,
                policy,
                workflow_id,
                base_auto_minutes,
                inputs.now,
                sharing_rounds.len(),
                quiet.as_ref(),
            )
        })
        .unwrap_or(base_auto_minutes);
    let (cadence_minutes, cadence_source) = match request
        .cadence_workflow_id
        .as_deref()
        .and_then(|workflow_id| {
            cadence_from_schedules(inputs.schedules, workflow_id, auto_minutes, inputs.now)
                .map(|minutes| (minutes, format!("workflow:{workflow_id}")))
        }) {
        Some(found) => found,
        None => match request.cadence_minutes {
            Some(minutes) if minutes > 0 => (minutes, "request".to_owned()),
            _ => {
                return Err(CoreError::InvalidInput(
                    "반복 주기를 찾을 수 없습니다. 이 워크플로를 돌리는 활성 반복 요청이 없으면 cadenceMinutes를 지정하세요".to_owned(),
                ))
            }
        },
    };
    reasoning.push(format!(
        "회차 간격 {cadence_minutes}분({cadence_source})을 기준으로 남은 회차 수를 계산했습니다"
    ));
    if cadence_minutes == auto_minutes && auto_minutes < base_auto_minutes {
        reasoning.push(format!(
            "자동 주기가 기준 {base_auto_minutes}분으로는 목표를 못 채워 {auto_minutes}분으로 좁혀졌습니다"
        ));
    }
    if let Some(quiet) = quiet.as_ref() {
        reasoning.push(format!(
            "페이싱 스케줄({}) 밖의 열린 시간만으로 남은 회차와 목표 직선을 계산했습니다",
            quiet.describe()
        ));
    }
    Ok(CadenceDecision {
        base_auto_minutes,
        minutes: cadence_minutes,
        source: cadence_source,
        quiet,
        paused,
        sharing_rounds,
    })
}

/// 회당 소비 실측에 드는 공통 기준. 전역·소비자별·가드 창 실측이 같은 계정 집합과 같은 표본
/// 구간 수·회차 간격을 봐야 값이 서로 견줄 수 있다.
struct CostBasis<'a> {
    /// 계획을 요청한 소비자.
    consumer_id: &'a str,
    /// 실측 대상 계정.
    account_ids: &'a [String],
    /// 표본으로 볼 지난 창 수.
    cost_windows: usize,
    /// 회차 간격(ms). 한 회차 안의 기록을 한 구간으로 묶는 데 쓴다.
    cadence_ms: i64,
    /// 회당 소비의 하한.
    min_cost_percent_per_run: f64,
}

/// 후보 계정에 등장하는 공급자마다 이 소비자의 `label` 창 회당 소비를 잰다. 표본이 없는
/// 공급자는 빠진다. 계획 창과 가드 창이 같은 순서·같은 후보 판정으로 재도록 한곳에 둔다.
/// `provider_labels`에 있는 공급자는 그 라벨로 잰다(Antigravity 모델군 창).
fn consumer_costs_by_provider(
    store: &PacingStore,
    basis: &CostBasis<'_>,
    candidates: &[&ProviderAccountView],
    label: &str,
    provider_labels: &BTreeMap<ProviderId, String>,
) -> Vec<(ProviderId, f64, f64)> {
    ProviderId::ALL
        .into_iter()
        .filter(|provider| {
            candidates
                .iter()
                .any(|account| account.provider == *provider)
        })
        .filter_map(|provider| {
            let label = provider_labels.get(&provider).map_or(label, String::as_str);
            let (cost, weight) = measure_consumer_cost(
                store,
                basis.consumer_id,
                provider,
                label,
                basis.cost_windows,
            )?;
            Some((provider, cost, weight))
        })
        .collect()
}

/// 계획 창의 공급자별 회당 소비를 이 소비자의 실행 기록으로 잰다.
fn measure_consumer_costs(
    store: &PacingStore,
    request: &UsagePacedRunsRequest,
    basis: &CostBasis<'_>,
    candidates: &[&ProviderAccountView],
    provider_labels: &BTreeMap<ProviderId, String>,
    reasoning: &mut Vec<String>,
) -> BTreeMap<ProviderId, (f64, f64)> {
    // 이 소비자의 실행 기록으로 잰 회당 소비. 작업마다 평균 소비가 다르므로 표본이 충분한
    // 공급자에서는 전역 평균 대신 이것을 쓴다.
    let mut consumer_costs: BTreeMap<ProviderId, (f64, f64)> = BTreeMap::new();
    for (provider, cost, weight) in consumer_costs_by_provider(
        store,
        basis,
        candidates,
        &request.window_label,
        provider_labels,
    ) {
        let cost = cost.max(basis.min_cost_percent_per_run);
        reasoning.push(format!(
            "{provider:?} 계정의 회당 소비는 이 소비자의 실행 {weight:.1}건 관측으로 {cost:.2}%p로 봤습니다"
        ));
        consumer_costs.insert(provider, (cost, weight));
    }
    consumer_costs
}

/// 가드 창 회당 소비 실측. `global`은 계획 창의 회차 기록으로 구간을 나눠 잰 전역 값,
/// `consumer`는 이 소비자의 실행 기록으로 잰 (창, 공급자)별 값이다.
struct GuardCosts {
    global: BTreeMap<String, (f64, usize)>,
    consumer: BTreeMap<(String, ProviderId), f64>,
}

/// 후보 계정이 보고하는 가드 창마다 회당 소비를 잰다.
fn measure_guard_costs(
    store: &PacingStore,
    request: &UsagePacedRunsRequest,
    policy: Option<&UsageBudgetPolicy>,
    basis: &CostBasis<'_>,
    candidates: &[&ProviderAccountView],
    window_labels: &AccountWindowLabels,
    reasoning: &mut Vec<String>,
) -> GuardCosts {
    // 가드 창 회당 소비. 계획 창과 별개의 예산이라 계획 창의 회당 소비로 환산할 수 없고
    // 따로 잰다. 가드 창은 자기 예약 기록이 없으므로 계획 창의 회차 기록으로 구간을 나눠 그
    // 창의 표본이 오른 만큼을 재고(전역), 이 소비자의 실행 기록으로도 잰다(공급자별).
    // 라벨은 계정이 지금 보고하는 창에서 모으므로 공급자가 창 길이를 바꾸면 새 라벨의
    // 실측이 새로 시작된다.
    let named_guard_label = request
        .guard_window_label
        .as_deref()
        .or_else(|| policy.and_then(|policy| policy.defaults.guard_window_label.as_deref()));
    let guard_labels: BTreeSet<String> = candidates
        .iter()
        .flat_map(|account| {
            guard_windows(
                &account.usage,
                account_window_label(window_labels, &account.id, &request.window_label),
                named_guard_label,
            )
        })
        .map(|window| window.label.clone())
        .collect();
    let mut guard_costs: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    let mut guard_consumer_costs: BTreeMap<(String, ProviderId), f64> = BTreeMap::new();
    for label in &guard_labels {
        // 가드 창은 라벨 자체가 이미 계정이 보고한 창이라(Antigravity 모델군 창도 그 라벨로
        // 표본이 쌓인다) 계정별 예외표가 필요 없다.
        let (measured, observations) = measure_window_cost_per_run(
            store,
            &request.window_label,
            Some(label),
            window_labels,
            basis.account_ids,
            basis.cost_windows,
            basis.cadence_ms,
        );
        if let Some(cost) = measured.filter(|cost| *cost > 0.0) {
            reasoning.push(format!(
                "{label} 창의 회당 소비를 {cost:.2}%p로 봤습니다(measured, 관측 {observations}구간)"
            ));
            guard_costs.insert(label.clone(), (cost, observations));
        }
        for (provider, cost, weight) in
            consumer_costs_by_provider(store, basis, candidates, label, &BTreeMap::new())
        {
            if cost <= 0.0 {
                continue;
            }
            reasoning.push(format!(
                "{provider:?} 계정의 {label} 창 회당 소비는 이 소비자의 실행 {weight:.1}건 관측으로 {cost:.2}%p로 봤습니다"
            ));
            guard_consumer_costs.insert((label.clone(), provider), cost);
        }
    }
    GuardCosts {
        global: guard_costs,
        consumer: guard_consumer_costs,
    }
}

/// 같은 창을 나눠 쓰는 소비자들의 최근 계획 기록. 기록은 `store`에서 빌려 온다.
struct ConsumerRecords<'a> {
    /// 이번 회차와 기동 수를 나눌 다른 활성 소비자.
    active_others: Vec<String>,
    /// 소비자별 최근 계획 기록.
    latest_record: BTreeMap<&'a str, &'a PlanRecord>,
    /// 소비자별로 마지막으로 실제 기동을 배정받은 시각.
    last_served: BTreeMap<&'a str, i64>,
}

/// 몫 배분에 드는 소비자 기록을 모은다. 활성 판정(설정 ∩ 최근 기록)과 소비자별 최근 기록
/// 집계가 같은 `store.plans` 순회를 두 결로 읽으므로 한 함수 안에 나란히 둔다.
fn collect_consumer_records<'s>(
    store: &'s PacingStore,
    request: &UsagePacedRunsRequest,
    inputs: &PacingInputs<'_>,
    cadence: &CadenceDecision,
    consumer_id: &str,
    reasoning: &mut Vec<String>,
) -> ConsumerRecords<'s> {
    // 같은 창을 쓰는 다른 소비자 = **설정으로 같은 창을 나눠 쓰는 회차** 중 **최근 기록이
    // 있는** 것. 두 조건을 다 본다.
    //
    // 설정만 보면 한 번도 안 뜬 회차가 든다. 그 회차의 수요는 반복 요청의 병렬 실행 설정에서
    // 읽으므로(`ConsumerShare::demands`) 기록이 없어도 과대 요구하지 않지만, 뜨지도 않을
    // 회차가 몫을 잡는다. 기록만 보면(옛 규칙) 지워진 회차가 기록이 남은 동안 몫을 잡고, 판정 구간이
    // 이 회차의 간격 × 2라 간격이 좁은 회차는 느린 회차를 못 봤다 — 자동 주기 하한이 10분이
    // 되면서 20분 안에 기록을 남기지 않은 소비자는 모두 없는 셈이 됐다.
    //
    // 그래서 기록 구간은 기준 간격(가드 창) × 2로 넓혀 느린 회차도 보이게 하고, 지워진·멈춘·
    // 참여를 끈 회차는 설정 집합이 걸러 낸다.
    let presence: Vec<(String, i64)> = store
        .plans
        .iter()
        .filter(|plan| plan.window_label == request.window_label)
        .filter_map(|plan| plan.consumer_id.clone().map(|consumer| (consumer, plan.at)))
        .collect();
    let recently_planned = usage_budget::active_consumers(
        &presence,
        inputs.now,
        (i64::from(cadence.base_auto_minutes) * 60_000).saturating_mul(ACTIVE_CONSUMER_SPAN_FACTOR),
    );
    let active_others: Vec<String> = cadence
        .sharing_rounds
        .iter()
        .filter(|consumer| consumer.as_str() != consumer_id && recently_planned.contains(*consumer))
        .filter(|consumer| !cadence.paused.contains(*consumer))
        .cloned()
        .collect();
    if !active_others.is_empty() {
        reasoning.push(format!(
            "같은 창을 나눠 쓰는 다른 소비자 {}개와 회차 기동 수를 나눕니다: {}",
            active_others.len(),
            active_others.join(", ")
        ));
    }
    // 소비자별 최근 기록: 수요(기동 상한·간격)와 마지막으로 기동을 배정받은 시각.
    let mut latest_record: BTreeMap<&str, &PlanRecord> = BTreeMap::new();
    let mut last_served: BTreeMap<&str, i64> = BTreeMap::new();
    for plan in store
        .plans
        .iter()
        .filter(|plan| plan.window_label == request.window_label)
    {
        let Some(consumer) = plan.consumer_id.as_deref() else {
            continue;
        };
        if latest_record
            .get(consumer)
            .is_none_or(|existing| existing.at <= plan.at)
        {
            latest_record.insert(consumer, plan);
        }
        if plan.entries.iter().any(|entry| entry.count > 0) {
            let served = last_served.entry(consumer).or_insert(plan.at);
            *served = (*served).max(plan.at);
        }
    }
    ConsumerRecords {
        active_others,
        latest_record,
        last_served,
    }
}

/// 계정 하나의 가드 창 투영 결과. 창마다의 응답 행과 예약 기준선, 가장 빡빡한 창이 정한
/// 상한, 추론수준 판정에 쓰는 창별 여력이다.
struct GuardProjection {
    views: Vec<Value>,
    cap: Option<usize>,
    tightest: Option<(usize, String)>,
    baselines: BTreeMap<String, GuardBaseline>,
    headroom_rounds: Vec<f64>,
}

/// `project_guard_windows`가 계정 하나를 재는 데 필요한 값. 계획 창 전체에서 한 번 정해지는
/// 값(소비 실측·간격·스케줄)과 계정별 값(가드 창·가드 캡·진행 중 실행)이 섞여 있다.
struct GuardProjectionInput<'a> {
    /// 회차 창. 예약을 남긴 계획 기록을 고르는 키다.
    plan_window_label: &'a str,
    /// 이 계정이 채우는 창. 회차 창과 다를 수 있다(Antigravity 모델군 창).
    account_window_label: &'a str,
    account_id: &'a str,
    provider: ProviderId,
    guards: &'a [&'a crate::accounts::AccountUsageWindow],
    guard_percent: Option<f64>,
    account_running: bool,
    live_chat_ids: &'a BTreeSet<&'a str>,
    now: i64,
    quiet: Option<&'a QuietSchedule>,
    cadence_ms: i64,
    guard_costs: &'a BTreeMap<String, (f64, usize)>,
    guard_consumer_costs: &'a BTreeMap<(String, ProviderId), f64>,
}

/// 가드 창 투영. 창마다 미정산 예약을 뺀 여유를 그 창의 회당 소비로 나눠 이 회차에 감당할
/// 건수를 내고, 가장 빡빡한 창이 이 계정의 상한이 된다. 현재 표본이 상한 아래인지만 보면
/// 진행 중 실행의 소비가 곧 들어올 때도 또 띄워 창을 넘긴다. 실측이 없는 창은 이 계정에
/// 진행 중 실행이 없을 때만 1건 — 첫 측정을 위한 최소 기동이다.
fn project_guard_windows(store: &PacingStore, input: &GuardProjectionInput<'_>) -> GuardProjection {
    let mut views: Vec<Value> = Vec::new();
    let mut cap: Option<usize> = None;
    let mut tightest: Option<(usize, String)> = None;
    let mut baselines: BTreeMap<String, GuardBaseline> = BTreeMap::new();
    // 실측된 가드 창마다 리셋까지 남은 회차당 감당 건수. 추론수준을 정하는 여력에 든다.
    let mut headroom_rounds: Vec<f64> = Vec::new();
    for guard in input.guards {
        let claims = claims_for_account(
            store,
            input.plan_window_label,
            input.account_window_label,
            &guard.label,
            input.account_id,
            input.live_chat_ids,
        );
        let open = usage_budget::open_claims(&claims, input.now, guard);
        let guard_outstanding = usage_budget::outstanding_percent(&open, guard.used_percent);
        let cost = input
            .guard_consumer_costs
            .get(&(guard.label.clone(), input.provider))
            .copied()
            .or_else(|| input.guard_costs.get(&guard.label).map(|(cost, _)| *cost));
        baselines.insert(
            guard.label.clone(),
            GuardBaseline {
                used_percent: guard.used_percent,
                resets_at: guard.resets_at,
                cost_percent_per_run: cost,
            },
        );
        let Some(guard_limit) = input.guard_percent else {
            continue;
        };
        let guard_headroom = guard_limit - guard.used_percent - guard_outstanding;
        let affordable = match cost {
            Some(cost) if cost > 0.0 => (guard_headroom / cost).floor().max(0.0) as usize,
            _ => usize::from(guard_headroom > 0.0 && !input.account_running),
        };
        if let Some(cost) = cost.filter(|cost| *cost > 0.0) {
            // 가드 창의 여력도 계획 창과 같은 단위(리셋까지 남은 회차당 감당 건수)로
            // 잰다. 리셋 시각을 모르는 창은 이번 회차 한 번으로 본다.
            let rounds = guard.resets_at.map_or(1, |resets_at| {
                (open_ms_between(input.quiet, input.now, resets_at) / input.cadence_ms).max(1)
            });
            headroom_rounds.push(guard_headroom.max(0.0) / cost / rounds as f64);
        }
        if tightest.as_ref().is_none_or(|(runs, _)| affordable < *runs) {
            tightest = Some((affordable, guard.label.clone()));
        }
        cap = Some(cap.map_or(affordable, |cap| cap.min(affordable)));
        views.push(json!({
            "label": guard.label,
            "usedPercent": guard.used_percent,
            "resetsAt": guard.resets_at,
            "guardPercent": guard_limit,
            "outstandingClaimPercent": guard_outstanding,
            "headroomPercent": guard_headroom.max(0.0),
            "costPercentPerRun": cost,
            "costSource": if cost.is_some() { "measured" } else { "unmeasured" },
            "affordableRuns": affordable,
        }));
    }
    GuardProjection {
        views,
        cap,
        tightest,
        baselines,
        headroom_rounds,
    }
}

/// 한 계정의 계획 창 지표. 창이 없으면 전부 0으로 본다(기동 판정에서 제외된다).
struct AccountWindowMetrics {
    used_percent: Option<f64>,
    resets_at: Option<i64>,
    /// 리셋까지 남은 시간 중 페이싱이 돌 수 있는 열린 시간.
    remaining_ms: i64,
    remaining_runs: usize,
    headroom: f64,
    /// 미정산 예약을 뺀 여유.
    net_headroom: f64,
}

fn account_window_metrics(
    window: Option<&crate::accounts::AccountUsageWindow>,
    quiet: Option<&QuietSchedule>,
    now: i64,
    cadence_ms: i64,
    target_percent: f64,
    outstanding: f64,
) -> AccountWindowMetrics {
    let Some(window) = window else {
        return AccountWindowMetrics {
            used_percent: None,
            resets_at: None,
            remaining_ms: 0,
            remaining_runs: 0,
            headroom: 0.0,
            net_headroom: 0.0,
        };
    };
    // 스케줄이 켜져 있으면 리셋까지 남은 시간 중 페이싱이 돌 수 있는 열린 시간만 센다.
    let remaining_ms = window
        .resets_at
        .map(|resets_at| open_ms_between(quiet, now, resets_at))
        .unwrap_or(0);
    let remaining_runs = if remaining_ms <= 0 {
        0
    } else {
        (remaining_ms / cadence_ms).max(1) as usize
    };
    let headroom = (target_percent - window.used_percent).max(0.0);
    AccountWindowMetrics {
        used_percent: Some(window.used_percent),
        resets_at: window.resets_at,
        remaining_ms,
        remaining_runs,
        headroom,
        net_headroom: (headroom - outstanding).max(0.0),
    }
}

/// 계정 하나에 고른 추론수준과 그 근거.
struct SelectedEffort {
    effort: ReasoningEffort,
    /// `fixed`(레인 설정) 또는 `auto`(여력 사다리).
    source: &'static str,
    /// 자동일 때 씌운 레인 상한. 고정값이면 없다.
    cap: Option<ReasoningEffort>,
}

/// 등급을 실측 비용으로 고른다. **회차 회전이 목적이다** — 같은 창으로 몇 건을 해내느냐가
/// 산출물이므로, 예산이 제약인 동안에는 가장 싼 등급으로 최대한 많이 돈다.
///
/// 깊은 등급으로 올라가는 경우는 하나뿐이다. 가장 싼 등급으로 리셋까지 돌 수 있는 건수를
/// 다 채워도 예산이 남을 때다. 그 여유는 리셋과 함께 사라지므로 쓰지 않으면 버리는 것이고,
/// 그때만 건당 몫을 늘려 깊게 돈다.
///
/// 종전 사다리는 등급을 섞은 평균 하나로 여유 배수를 세고 그 배수로 칸을 옮겼다. 그래서
/// low 기준으로 센 여유로 max를 골라 놓고 실제로는 서너 배를 썼고, 그 초과분이 뒤늦게
/// 평균을 올리면 이번엔 과하게 내려가 등급이 진동했다. 여기서는 각 등급의 실측 비용으로
/// 직접 따지므로 계획과 실행이 어긋나지 않는다.
fn effort_within_headroom(
    provider: ProviderId,
    costs: &BTreeMap<ReasoningEffort, f64>,
    net_headroom: f64,
    remaining_runs: usize,
    max_runs: usize,
    fallback: ReasoningEffort,
) -> (ReasoningEffort, &'static str) {
    let ladder = ReasoningLadder::of(provider).rungs();
    // 실측이 있는 가장 싼 등급. 회전을 최대로 하는 기본 선택이다.
    let Some((cheapest, floor_cost)) = ladder
        .iter()
        .find_map(|effort| costs.get(effort).map(|cost| (effort.clone(), *cost)))
        .filter(|(_, cost)| *cost > 0.0)
    else {
        return (fallback, "auto");
    };
    if remaining_runs == 0 || net_headroom <= 0.0 {
        return (cheapest, "measured");
    }
    // 리셋까지 돌 수 있는 최대 건수. 남은 회차 수 × 그 회차의 병렬 자리.
    let capacity = remaining_runs.saturating_mul(max_runs.max(1)) as f64;
    if net_headroom <= capacity * floor_cost {
        // 예산이 제약이다. 싸게 돌수록 건수가 늘어난다.
        return (cheapest, "measured");
    }
    // 최대로 돌려도 남는 예산이 있다. 리셋 때 사라질 몫이라 건당 몫을 늘려 깊게 돈다.
    let per_run = net_headroom / capacity;
    for effort in ladder.iter().rev() {
        if costs
            .get(effort)
            .is_some_and(|cost| *cost > 0.0 && *cost <= per_run)
        {
            return (effort.clone(), "surplus");
        }
    }
    (cheapest, "measured")
}

/// 레인(공급자) 설정에 고정값이 있으면 여력 판정 대신 그 값, 자동이면 여력 사다리에 레인
/// 상한을 씌운다.
#[allow(clippy::too_many_arguments)]
fn select_reasoning_effort(
    provider: ProviderId,
    lane: Option<&LaneReasoningEffort>,
    headroom_runs_per_round: Option<f64>,
    pressure: i8,
    effort_costs: Option<&BTreeMap<ReasoningEffort, f64>>,
    net_headroom: f64,
    remaining_runs: usize,
    max_runs: usize,
) -> SelectedEffort {
    let ladder = ReasoningLadder::of(provider);
    let cap = lane
        .filter(|lane| lane.fixed.is_none())
        .and_then(|lane| lane.max_auto.clone());
    let floor = lane
        .filter(|lane| lane.fixed.is_none())
        .and_then(|lane| lane.min_auto.clone());
    match lane.and_then(|lane| lane.fixed.clone()) {
        Some(effort) => SelectedEffort {
            effort: ladder.clamp(effort),
            source: "fixed",
            cap,
        },
        None => {
            // 실측이 있으면 회전을 최대로 하는 등급을, 없으면 옛 여유 배수 판정을 쓴다.
            let fallback = reasoning_effort_for_headroom(provider, headroom_runs_per_round);
            let (auto, basis) = match effort_costs {
                Some(costs) if !costs.is_empty() => effort_within_headroom(
                    provider,
                    costs,
                    net_headroom,
                    remaining_runs,
                    max_runs,
                    fallback,
                ),
                _ => (fallback, "auto"),
            };
            // 상한 초과가 한 칸 밀고, 천장이 위를, 바닥이 아래를 막는다. 순서가 중요하다 —
            // 압력을 먼저 주고 경계를 나중에 씌워야 사용자가 정한 범위를 넘지 않는다.
            let pressed = if pressure == 0 {
                auto
            } else {
                ladder.stepped(&auto, pressure)
            };
            let capped = match cap.clone() {
                Some(cap) => ladder.cap(pressed, cap),
                None => pressed,
            };
            SelectedEffort {
                effort: match floor {
                    Some(floor) => ladder.floor(capped, floor),
                    None => capped,
                },
                source: if pressure != 0 { "ceiling" } else { basis },
                cap,
            }
        }
    }
}

/// 계정별 허용 건수를 회차 상한 안에서 한 건씩 돌아가며 실제 기동 목록으로 편다.
///
/// 균등 간격을 가장 많이 넘긴 계정부터 채운다. 상한 때문에 일부만 들어갈 때 가장 뒤처진
/// 계정이 먼저 들어가야 창마다 고르게 소비된다. 여력 건수로 줄 세우면 리셋이 먼 계정이
/// 계속 이기고, 먼저 리셋되는 계정이 여유를 남긴다.
fn fill_planned_runs(
    allowances: &mut [(String, ProviderId, usize, f64)],
    limit: usize,
    request: &UsagePacedRunsRequest,
    account_efforts: &BTreeMap<String, ReasoningEffort>,
    account_effort_basis: &BTreeMap<String, (&'static str, Option<f64>)>,
) -> Vec<PlannedRun> {
    allowances.sort_by(|left, right| {
        right
            .3
            .partial_cmp(&left.3)
            .unwrap_or(Ordering::Equal)
            .then(right.2.cmp(&left.2))
            .then(left.0.cmp(&right.0))
    });
    let mut planned = Vec::new();
    let mut round = 0usize;
    while planned.len() < limit {
        let mut placed = false;
        for (account_id, provider, allowed, _) in allowances.iter() {
            if round >= *allowed {
                continue;
            }
            if planned.len() >= limit {
                break;
            }
            planned.push(PlannedRun {
                account_id: account_id.clone(),
                source: *provider,
                model: match provider {
                    ProviderId::Claude => request.claude_model.clone(),
                    ProviderId::Codex => request.codex_model.clone(),
                    ProviderId::Antigravity => request.antigravity_model.clone(),
                    // 로컬은 계정이 없어 이 배분표에 오르지 않는다. 별도로
                    // [`local_planned_runs`]가 상한 밖에서 덧붙인다.
                    ProviderId::Local => None,
                },
                reasoning_effort: account_efforts.get(account_id).cloned(),
                reasoning_effort_source: account_effort_basis
                    .get(account_id)
                    .map(|(source, _)| *source),
                headroom_runs_per_round: account_effort_basis
                    .get(account_id)
                    .and_then(|(_, ratio)| *ratio),
            });
            placed = true;
        }
        if !placed {
            break;
        }
        round += 1;
    }
    planned
}

/// 워크플로 입력은 값을 문자열 하나로 실어 나른다. 목록을 받는 칸이 이것뿐이라 배열을
/// 받는 길과 쉼표로 이어 붙인 문자열을 받는 길을 둘 다 연다 — 화면이 어느 쪽으로 보내든
/// 같은 목록으로 읽혀야 회차 설정이 저장본과 다르게 돌지 않는다.
fn deserialize_local_models<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Models {
        List(Vec<String>),
        Joined(String),
    }
    Ok(match Models::deserialize(deserializer)? {
        Models::List(models) => models,
        Models::Joined(text) => text
            .split(',')
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
    })
}

/// 로컬 공급자 몫. 계정도 창도 없어 여력으로 건수를 정할 수 없으므로 배분표를 타지 않고,
/// 사용자가 고른 모델마다 한 건씩 상한 **밖에서** 세운다.
///
/// 상한 밖에 두는 이유는 두 가지다. 로컬은 자를 근거가 없어 같은 풀에 넣으면 남는 칸을
/// 모두 먹어 한도 있는 계정의 실행을 밀어낸다. 그리고 로컬의 실제 한계는 쿼터가 아니라
/// 서빙 서버의 처리량이라, 회차 상한과 같은 자로 재는 것이 애초에 맞지 않는다.
fn local_planned_runs(models: &[String]) -> Vec<PlannedRun> {
    let mut seen: Vec<&str> = Vec::new();
    let mut planned = Vec::new();
    for model in models {
        let model = model.trim();
        // 같은 모델을 두 번 고른 것은 한 건으로 접는다. 서빙 서버가 직렬화해 두 건을
        // 띄워도 큐만 쌓인다.
        if model.is_empty() || seen.contains(&model) {
            continue;
        }
        seen.push(model);
        planned.push(PlannedRun {
            // 계정이 없다. 어느 모델의 몫인지 읽히도록 모델 이름을 그대로 쓴다.
            account_id: format!("local:{model}"),
            source: ProviderId::Local,
            model: Some(model.to_owned()),
            // 추론수준 사다리가 비어 있어 고를 값이 없다(3.1).
            reasoning_effort: None,
            reasoning_effort_source: None,
            // 여력이라는 개념이 없다. 미리보기가 빈칸으로 두어야 "0건"과 구분된다.
            headroom_runs_per_round: None,
        });
    }
    planned
}

/// 이번 회차의 병렬 실행 건수. 요청이 값을 주면 그대로 쓰고, 생략하면 반복 요청 설정의
/// 건수를, 그 설정도 없으면 스케줄러 기본값을 쓴다.
fn resolve_max_runs(
    request: &UsagePacedRunsRequest,
    configured_max_runs: &BTreeMap<&str, usize>,
    consumer_id: &str,
    reasoning: &mut Vec<String>,
) -> Result<usize, CoreError> {
    match request.max_runs {
        Some(0) => Err(CoreError::InvalidInput(
            "병렬 실행 건수는 1 이상이어야 합니다".to_owned(),
        )),
        Some(runs) => Ok(runs),
        None => {
            let runs = configured_max_runs
                .get(consumer_id)
                .copied()
                .unwrap_or(crate::scheduler::DEFAULT_MAX_RUNS as usize);
            reasoning.push(format!(
                "병렬 실행 건수가 없어 반복 요청 설정 {runs}건으로 계획했습니다"
            ));
            Ok(runs)
        }
    }
}

/// 회당 소비 상한(enforce)을 넘긴 공급자가 있으면 그 사유. 절감의 실제 수단은 스킬
/// 절차이므로 계획은 재고 막기만 한다.
fn consumer_over_ceiling(
    store: &PacingStore,
    policy: Option<&UsageBudgetPolicy>,
    consumer_id: &str,
    window_label: &str,
    provider_labels: &BTreeMap<ProviderId, String>,
    baseline_runs: usize,
    cost_windows: usize,
) -> Option<String> {
    policy
        .and_then(|policy| policy.consumers.get(consumer_id))
        .filter(|config| config.enforce_ceiling)
        .and_then(|config| {
            ProviderId::ALL.into_iter().find_map(|provider| {
                consumer_savings(
                    store,
                    consumer_id,
                    provider,
                    provider_labels
                        .get(&provider)
                        .map_or(window_label, String::as_str),
                    baseline_runs,
                    cost_windows,
                    config.max_tokens_per_run,
                    config.max_cost_percent_per_run,
                )
                .over_ceiling
                .map(|why| format!("{provider:?} {why}"))
            })
        })
}

/// 공급자(레인)별 추론수준 설정. 레인에 명시값이 없는 공급자는 소비 성향 프리셋이 천장·
/// 바닥을 대신 정하고, 프리셋도 없으면 자동·경계 없음이다.
fn resolve_lane_efforts(
    policy: Option<&UsageBudgetPolicy>,
    consumer_id: &str,
) -> BTreeMap<ProviderId, LaneReasoningEffort> {
    let consumer_config = policy.and_then(|policy| policy.consumers.get(consumer_id));
    let spend_profile = consumer_config
        .and_then(|config| config.spend_profile)
        .or_else(|| policy.and_then(|policy| policy.defaults.spend_profile));
    let mut lanes = consumer_config
        .map(|config| config.reasoning_efforts.clone())
        .unwrap_or_default();
    if let Some(profile) = spend_profile {
        let (cap, floor) = profile.bounds();
        for provider in ProviderId::ALL {
            lanes.entry(provider).or_insert(LaneReasoningEffort {
                fixed: None,
                max_auto: cap.clone(),
                min_auto: floor.clone(),
            });
        }
    }
    lanes
}

/// 등급별 실측 회당 소비. 계획이 고르는 등급의 값으로 여유를 재기 위한 표다.
fn measure_effort_costs(
    store: &PacingStore,
    consumer_id: &str,
    window_label: &str,
    provider_labels: &BTreeMap<ProviderId, String>,
    cost_windows: usize,
) -> BTreeMap<ProviderId, BTreeMap<ReasoningEffort, f64>> {
    ProviderId::ALL
        .into_iter()
        .map(|provider| {
            let window_label = provider_labels
                .get(&provider)
                .map_or(window_label, String::as_str);
            let measured =
                consumer_cost_by_effort(store, consumer_id, provider, window_label, cost_windows)
                    .into_iter()
                    .filter_map(|(effort, (cost, _, _))| cost.map(|cost| (effort, cost)))
                    .collect();
            (provider, measured)
        })
        .collect()
}

/// 고른 등급이 아직 레인 바닥 위인지. 레인에 바닥이 없으면 사다리의 첫 칸이 바닥이다.
fn effort_is_above_floor(
    provider: ProviderId,
    lane: Option<&LaneReasoningEffort>,
    effort: &ReasoningEffort,
) -> bool {
    let ladder = ReasoningLadder::of(provider);
    let floor = lane
        .and_then(|lane| lane.min_auto.clone())
        .map(|floor| ladder.clamp(floor))
        .unwrap_or_else(|| ladder.bottom());
    ladder.compare(effort, &floor) == Some(Ordering::Greater)
}

/// 균등 소비 직선 판정의 입력. 계정·정책은 이미 값으로 녹아 있고, 남은 것은 창의 여유·
/// 시간과 이번 회차의 간격이다.
struct DueRunsInput<'a> {
    window_label: &'a str,
    quiet: Option<&'a QuietSchedule>,
    now: i64,
    cadence_ms: i64,
    /// 미정산 예약을 뺀 계획 창의 여유.
    net_headroom: f64,
    account_cost: f64,
    remaining_ms: i64,
    resets_at: Option<i64>,
    target_percent: f64,
    used_percent: Option<f64>,
    outstanding: f64,
    /// 직선을 버리고 감당 건수를 전부 낼지(소진 모드 또는 스프린트).
    flat_out: bool,
}

/// 직선 판정 결과. `runs`가 이번 회차의 예산 건수이고, 나머지는 그 값이 왜 나왔는지를
/// 계정 행에 실어 보이기 위한 값이다. `due_runs`·`burst`는 균등 간격을 세울 수 없을 때
/// (감당 건수가 0) 비어 있다.
struct DueRuns {
    runs: usize,
    urgency: f64,
    even_period_minutes: f64,
    window_elapsed_minutes: f64,
    due_percent: f64,
    due_runs: Option<f64>,
    burst: Option<usize>,
}

/// 창 전체의 목표 사용률을 시간에 직선으로 펴고, 지금 시점의 목표에서 실제 사용률과 아직
/// 표본에 보이지 않는 예약을 뺀다. 이 차이를 현재 회당 소비로 바꾸면 이번 회차까지 밀린
/// 기동 수다.
///
/// 계획 기록의 건수를 완료 이력으로 세면 forEach 기동 실패도 성공으로 남고, 실측용 64건
/// 상한을 넘은 오래된 실행은 사라진다. 사용률을 기준으로 삼으면 두 오차가 없고, 사용자가
/// 직접 쓴 소비나 회당 비용 변화도 그대로 반영된다.
fn account_due_runs(input: &DueRunsInput<'_>) -> DueRuns {
    let affordable_runs = input.net_headroom / input.account_cost;
    // 남은 건수를 남은 시간에 균등하게 편 간격. 이 속도가 목표에 정확히 닿는다.
    let period_ms = if affordable_runs > 0.0 {
        (input.remaining_ms as f64 / affordable_runs).max(1.0)
    } else {
        0.0
    };
    // 창 길이는 라벨에서, 경과는 창 시작~지금 사이의 열린 시간으로 잰다. 스케줄이 켜져
    // 있으면 경과·남은 시간 모두 열린 시간이라 목표 직선이 제한 밖 시간 위에 펴지고,
    // 제한 동안은 경과가 멈춰 재개 직후에 몫이 뛰지(몰아치기) 않는다.
    let window_length_ms = usage_budget_policy::window_label_length_ms(input.window_label)
        .and_then(|label_ms| {
            let window_start = input.resets_at? - label_ms;
            let elapsed = open_ms_between(input.quiet, window_start, input.now);
            Some(elapsed + input.remaining_ms)
        });
    let elapsed_ms =
        window_length_ms.map_or(input.cadence_ms, |length| length - input.remaining_ms);
    let due_percent = if let Some(length_ms) = window_length_ms.filter(|length| *length > 0) {
        // 한 회차 앞을 본다: 다음 회차 전에 만기가 오는 건수는 지금 돈다. 지금까지의 몫만
        // 재면 계정은 늘 직선보다 0~1건 뒤에서 따라가고, 마지막 회차가 리셋 전 한 간격
        // 앞이라 그만큼 여유를 남긴다. 남은 건수 상한이 그대로라 목표를 넘지는 않는다.
        let progress = ((elapsed_ms + input.cadence_ms) as f64 / length_ms as f64).clamp(0.0, 1.0);
        (input.target_percent * progress - input.used_percent.unwrap_or(0.0) - input.outstanding)
            .max(0.0)
    } else {
        // 알 수 없는 공급자 라벨은 창 시작을 복원할 수 없다. 이 경우에만 남은 여유의 현재
        // 회차 몫을 쓴다. 기본 공급자 라벨은 모두 길이로 해석된다.
        input.net_headroom * input.cadence_ms as f64 / input.remaining_ms.max(1) as f64
    };
    let mut due = DueRuns {
        runs: 0,
        urgency: 0.0,
        even_period_minutes: period_ms / 60_000.0,
        window_elapsed_minutes: elapsed_ms as f64 / 60_000.0,
        due_percent,
        due_runs: None,
        burst: None,
    };
    if period_ms > 0.0 {
        let urgency = due_percent / input.account_cost;
        // 한 회차가 몰아 쓰지 않도록 이 회차 몫(간격 ÷ 건당 간격)으로 묶는다. 창 앞부분을
        // 쉰 계정은 이 상한 안에서 조금씩 만회한다. 올림이라 밀린 계정은 몫보다 조금 빠르게
        // 도는데, 다음 회차의 남은 건수가 그만큼 줄어 상한도 함께 내려가므로 창이 끝나기
        // 전에 목표에서 멈춘다.
        let burst = (input.cadence_ms as f64 / period_ms).ceil().max(1.0);
        due.urgency = urgency;
        due.due_runs = Some(urgency);
        // 남은 건수를 넘겨 목표를 넘지는 않는다. 한 건도 못 살 만큼 여유가 적으면 이번
        // 창에서는 쉰다(표본이 아예 없는 경우만 호출부의 첫 측정 예외로 돈다).
        //
        // 소진 모드와 스프린트는 이 회차 몫과 직선까지 밀린 건수(urgency)를 둘 다 걷어내고
        // 목표까지 감당할 수 있는 건수를 그대로 낸다. 창을 빨리 비우는 것이 목적이라 직선을
        // 지킬 이유가 없다. 가드 창 상한은 호출부에서 그대로 걸리므로 5시간 창은 지켜진다.
        due.runs = if input.flat_out {
            affordable_runs.floor().max(0.0) as usize
        } else {
            urgency
                .floor()
                .clamp(0.0, burst.min(affordable_runs.floor())) as usize
        };
        due.burst = Some(burst as usize);
    }
    due
}

/// 계정 한 곳이 이번 회차에 몇 건을 받을지 정하는 입력. 앞의 다섯은 직선 판정까지
/// 가기 전에 회차를 끊는 관문이고, `due`는 관문을 모두 지났을 때 쓰는 직선 판정 입력이다.
struct BudgetDecisionInput<'a> {
    /// 이 소비자가 페이싱 대상으로 선택되지 않았다.
    blocked: bool,
    /// 이 소비자의 회당 소비가 상한을 넘었다.
    over_ceiling: bool,
    /// 추론수준을 한 칸 더 낮출 여지가 남아 있다.
    effort_above_floor: bool,
    /// 계정 자체의 제외 사유(사용량 조회 실패·가드 초과 등).
    skip_reason: Option<&'a str>,
    /// 계획 창을 사용량 응답에서 찾았는지.
    window_present: bool,
    /// 리셋까지 남은 회차 수.
    remaining_runs: usize,
    /// 창이 아직 시작되지 않았는지(0%·리셋 시각 없음).
    unstarted: bool,
    due: DueRunsInput<'a>,
}

/// 계정 한 곳의 예산 판정 결과. `note`가 있으면 이번 회차는 쉬고, `due`는 직선 판정까지
/// 간 계정에만 있다 — 관문에서 끊긴 계정은 균등 간격을 세울 근거가 없다.
struct BudgetDecision {
    runs: usize,
    note: Option<String>,
    due: Option<DueRuns>,
}

/// 관문을 순서대로 통과시킨 뒤 직선 판정에 넘긴다. 이 순서가 사유의 우선순위다 — 소비자
/// 단위로 끊긴 회차는 계정 사정을 말하지 않고, 창을 못 찾은 계정은 여유를 말하지 않는다.
/// 가드 창 상한과 소비자 간 배분은 이 판정 뒤에 따로 씌운다.
fn account_budget_decision(input: &BudgetDecisionInput<'_>) -> BudgetDecision {
    let skip = |note: String| BudgetDecision {
        runs: 0,
        note: Some(note),
        due: None,
    };
    if input.blocked {
        return skip("페이싱 대상으로 선택되지 않은 반복 요청".to_owned());
    }
    if input.over_ceiling && !input.effort_above_floor {
        // 이미 바닥이면 더 낮출 데가 없다. 그때만 회차를 멈춘다.
        return skip("회당 소비 상한 초과 · 추론수준이 이미 바닥 — 스킬 절차를 점검".to_owned());
    }
    if let Some(reason) = input.skip_reason {
        return skip(reason.to_owned());
    }
    if !input.window_present {
        return skip(format!("{} 창을 찾을 수 없음", input.due.window_label));
    }
    if input.remaining_runs == 0 && !input.unstarted {
        return skip(
            if input
                .due
                .resets_at
                .is_some_and(|resets_at| resets_at > input.due.now)
            {
                // 리셋은 앞에 있는데 그 전까지 전부 제한 시간대다.
                "리셋 전에 열린 시간이 없음(페이싱 스케줄) — 리셋 뒤 재개".to_owned()
            } else {
                "창 리셋 시각을 알 수 없음".to_owned()
            },
        );
    }
    if input.due.net_headroom <= 0.0 {
        return skip(if input.due.outstanding > 0.0 {
            "목표 사용률 도달(미정산 예약 포함)".to_owned()
        } else {
            "목표 사용률 도달".to_owned()
        });
    }
    if input.unstarted {
        if input.due.outstanding > 0.0 {
            // 다른 소비자(또는 자기 직전 회차)가 이미 첫 기동을 예약했는데 공급자가
            // 아직 0%·리셋 시각 없음으로 답하는 사이다. 또 열면 첫 기동이 둘이 된다.
            return skip("창 미시작 — 이미 첫 기동이 예약됨".to_owned());
        }
        // 창을 여는 첫 기동. 창이 시작되지 않았으니 직선 판정은 세울 수 없고, 한 건이
        // 돌면 리셋 시각이 생겨 다음 회차부터 직선에 든다. 창 전체의 예산이 놀고 있는
        // 상태라 가장 먼저 채운다(배분 순서의 sentinel).
        return BudgetDecision {
            runs: 1,
            note: None,
            due: None,
        };
    }
    let due = account_due_runs(&input.due);
    BudgetDecision {
        runs: due.runs,
        note: None,
        due: Some(due),
    }
}

/// 가드 창 상한을 예산 건수에 씌운 결과. `note`가 있으면 이번 회차는 쉬고, `capped`는
/// 상한이 실제로 건수를 깎았는지다(판단 문장의 계정 수에 쓰인다).
struct GuardCapDecision {
    note: Option<String>,
    capped: bool,
}

/// 가드 창이 한 건도 감당할 수 없으면 제외 사유를 내고, 감당 건수가 있으면 예산 건수를
/// 그 안으로 자른다.
fn apply_guard_cap(
    budget_runs: &mut usize,
    guard_views: &[Value],
    tightest_guard: Option<&(usize, String)>,
    guard_cap: Option<usize>,
    account_running: bool,
) -> GuardCapDecision {
    if let Some((0, label)) = tightest_guard.map(|(runs, label)| (*runs, label)) {
        let view = guard_views
            .iter()
            .find(|view| view["label"] == label.as_str());
        let headroom = view
            .and_then(|view| view["headroomPercent"].as_f64())
            .unwrap_or(0.0);
        let guard_outstanding = view
            .and_then(|view| view["outstandingClaimPercent"].as_f64())
            .unwrap_or(0.0);
        let cost = view.and_then(|view| view["costPercentPerRun"].as_f64());
        let note = match cost {
            Some(cost) => format!(
                "{label} 창 여유 {headroom:.1}%p가 회당 소비 {cost:.1}%p보다 작아 이번 회차는 쉼(미정산 예약 {guard_outstanding:.1}%p 포함)"
            ),
            None if account_running => format!(
                "{label} 창의 회당 소비를 아직 실측하지 못했고 이 계정에 진행 중 실행이 있어 이번 회차는 쉼"
            ),
            None => format!(
                "{label} 창 여유가 없어 이번 회차는 쉼(미정산 예약 {guard_outstanding:.1}%p 포함)"
            ),
        };
        return GuardCapDecision {
            note: Some(note),
            capped: true,
        };
    }
    let capped = guard_cap.is_some_and(|cap| *budget_runs > cap);
    if let Some(cap) = guard_cap {
        *budget_runs = (*budget_runs).min(cap);
    }
    GuardCapDecision { note: None, capped }
}

/// 반복 요청이 설정한 회차당 병렬 실행 수. 계획 기록의 max_runs는 지난 회차의 값이라
/// 사용자가 고친 뒤 첫 회차까지 옛 값을 말하고, 한 번도 안 뜬 회차는 기록이 없다. 그래서
/// 다른 소비자의 수요도, 요청이 건수를 생략했을 때의 기본값도 이 설정에서 읽는다.
fn configured_max_runs(schedules: &[ScheduledRequest]) -> BTreeMap<&str, usize> {
    schedules
        .iter()
        .filter_map(|schedule| {
            schedule
                .input
                .workflow
                .as_ref()
                .map(|action| (schedule.id.as_str(), action.max_runs() as usize))
        })
        .collect()
}

/// 아직 돌고 있는 런타임의 채팅 id. 예약의 생존과 동시 기동 상한에 쓴다. 턴을 마친
/// Ready·중지·실패는 끝난 것이고, 턴이 아직 없는 Ready는 막 뜬 런타임이다.
fn live_runtime_chat_ids(chats: &[ChatSessionInfo]) -> BTreeSet<&str> {
    chats
        .iter()
        .filter(|chat| match chat.state {
            crate::chat::ChatPhase::Running | crate::chat::ChatPhase::WaitingApproval => true,
            crate::chat::ChatPhase::Ready => chat.last_turn_status.is_none(),
            crate::chat::ChatPhase::Stopped | crate::chat::ChatPhase::Failed => false,
        })
        .map(|chat| chat.chat_id.as_str())
        .collect()
}

/// 이번 회차에 새로 띄울 수 있는 건수. maxRuns는 **동시** 기동 상한이다. 지난 회차의 실행이
/// 아직 돌고 있으면 그만큼 이번 회차의 자리가 줄어든다 — 예약을 살려 두는 것만으로는 막지
/// 못한다. 직선 판정은 한 회차 앞을 보므로 진행 중인 실행의 소비를 예약으로 뺀 뒤에도 다음
/// 몫이 만기라 같은 계정에 또 기동하고, 회차당 1건인 공유 워크트리에 런타임이 둘 뜬다.
fn concurrent_launch_limit(
    store: &PacingStore,
    consumer_id: &str,
    max_runs: usize,
    live_chat_ids: &BTreeSet<&str>,
    reasoning: &mut Vec<String>,
) -> usize {
    let running_runs = store
        .runs
        .iter()
        .filter(|run| {
            run.consumer_id == consumer_id
                && run.ended_at.is_none()
                && live_chat_ids.contains(run.chat_id.as_str())
        })
        .count();
    let limit = max_runs.saturating_sub(running_runs);
    if running_runs > 0 {
        reasoning.push(format!(
            "지난 회차 실행 {running_runs}건이 아직 진행 중이라 이번 회차 상한을 {limit}건으로 줄였습니다"
        ));
    }
    limit
}

/// 응답 최상단에 싣는, 모든 계정에 공통인 목표·가드 캡.
struct EffectivePlanCaps {
    target_percent: f64,
    guard_label: Option<String>,
    guard_percent: Option<f64>,
}

/// 계정 override까지 적용한 실제 값은 account_views의 각 행에 싣고, 여기서는 공통값만 낸다.
/// 빈 계정 id로 정책 함수를 호출하면 override가 없는 이유가 드러나지 않아, 공통값을 직접
/// 조합한다.
fn effective_plan_caps(
    request: &UsagePacedRunsRequest,
    policy: Option<&UsageBudgetPolicy>,
    guard_label: Option<&str>,
    requested_target: f64,
) -> EffectivePlanCaps {
    EffectivePlanCaps {
        target_percent: policy
            .and_then(|policy| policy.defaults.target_percent)
            .map_or(requested_target, |target| requested_target.min(target)),
        guard_label: guard_label
            .or_else(|| policy.and_then(|policy| policy.defaults.guard_window_label.as_deref()))
            .map(str::to_owned),
        guard_percent: [
            request.guard_percent,
            policy.and_then(|policy| policy.defaults.guard_percent),
        ]
        .into_iter()
        .flatten()
        .reduce(f64::min),
    }
}

/// 이번 회차가 누구 몫인지와 그 소비자에게 걸린 제약. 계정마다 달라지지 않고 회차 전체에
/// 한 번만 정해지는 값이라 계정 순회에 들어가기 전에 한 자리에서 만든다.
struct ConsumerGate<'a> {
    consumer_id: String,
    /// 반복 요청별 병렬 실행 설정. 이 소비자의 상한이자, 다른 소비자의 수요를 읽는 곳이다.
    configured_max_runs: BTreeMap<&'a str, usize>,
    max_runs: usize,
    /// 소비자 선택이 켜져 있는데 이 소비자가 빠져 있으면 이번 회차는 기동하지 않는다.
    blocked: bool,
    /// 회당 소비가 상한을 넘긴 사유. 넘었으면 추론수준을 한 칸 낮춘다.
    over_ceiling: Option<String>,
    /// 스프린트 회차. 참여 계정이 계획 창 목표·직선을 무시하고 감당 건수를 전부 낸다.
    sprint: bool,
}

/// 소비자 식별과 그 소비자에게 걸린 두 제약(선택에서 빠짐·상한 초과)을 함께 정한다.
/// 셋 다 같은 소비자 id에서 갈라져 나오고 판단 문장도 나란히 서므로 한 결정으로 묶는다.
fn resolve_consumer_gate<'a>(
    store: &PacingStore,
    request: &UsagePacedRunsRequest,
    inputs: &PacingInputs<'a>,
    provider_labels: &BTreeMap<ProviderId, String>,
    cost_windows: usize,
    reasoning: &mut Vec<String>,
) -> Result<ConsumerGate<'a>, CoreError> {
    let policy = inputs.policy;
    let consumer_id = resolve_consumer_id(request, inputs.schedules);
    let configured_max_runs = configured_max_runs(inputs.schedules);
    let max_runs = resolve_max_runs(request, &configured_max_runs, &consumer_id, reasoning)?;
    // 소비자 선택이 켜져 있으면 등록·활성인 반복 요청만 기동을 받는다. 막힌 회차는 존재
    // 표시도 남기지 않아 다른 소비자의 배분에 끼지 않는다.
    let blocked = policy.is_some_and(|policy| {
        policy.consumers_configured() && !policy.consumer_allowed(&consumer_id)
    });
    if blocked {
        reasoning.push(format!(
            "소비자 {consumer_id}는 페이싱 대상으로 선택되지 않아 이번 회차는 기동하지 않습니다(워크플로 → 워크플로 페이싱 탭에서 켤 수 있음)"
        ));
    }
    let over_ceiling = consumer_over_ceiling(
        store,
        policy,
        &consumer_id,
        &request.window_label,
        provider_labels,
        baseline_runs_for(inputs),
        cost_windows,
    );
    if let Some(why) = &over_ceiling {
        reasoning.push(format!(
            "소비자 {consumer_id}의 회당 소비가 상한을 넘었습니다({why}) — 추론수준을 한 칸 낮추고, 이미 바닥이면 이번 회차는 쉽니다"
        ));
    }
    let sprint = policy
        .and_then(|policy| policy.consumers.get(&consumer_id))
        .is_some_and(|config| config.sprint);
    if sprint {
        reasoning.push(format!(
            "소비자 {consumer_id}는 스프린트 회차입니다 — 참여 계정은 계획 창({}) 목표와 균등 소비 직선을 무시하고 감당할 수 있는 건수를 전부 내며, 가드 창 상한은 그대로 지킵니다",
            request.window_label
        ));
    }
    Ok(ConsumerGate {
        consumer_id,
        configured_max_runs,
        max_runs,
        blocked,
        over_ceiling,
        sprint,
    })
}

/// 이번 회차의 전역 회당 소비. 공급자별 실측이 없는 계정이 이 값을 쓰고, 관측 구간 수는
/// 첫 측정 회차(부트스트랩) 판정에도 쓰인다.
struct GlobalCost {
    cost_percent_per_run: f64,
    cost_source: &'static str,
    observations: usize,
}

/// 계획 창의 실측으로 회당 소비를 정한다. 실측이 없거나 0이면 요청의 대체값으로 내려가고,
/// 어느 쪽이든 최소값 아래로는 내려가지 않는다 — 0에 가까운 값은 여력을 무한대로 읽힌다.
fn resolve_global_cost(
    store: &PacingStore,
    request: &UsagePacedRunsRequest,
    basis: &CostBasis<'_>,
    window_labels: &AccountWindowLabels,
    reasoning: &mut Vec<String>,
) -> GlobalCost {
    let min_cost_percent_per_run = basis.min_cost_percent_per_run;
    let (measured, observations) = measure_cost_per_run(
        store,
        &request.window_label,
        window_labels,
        basis.account_ids,
        basis.cost_windows,
        basis.cadence_ms,
    );
    let (cost, cost_source) = match measured {
        Some(cost) if cost > 0.0 => (cost, "measured"),
        _ => (
            request
                .fallback_cost_percent_per_run
                .unwrap_or(min_cost_percent_per_run),
            "fallback",
        ),
    };
    let cost_percent_per_run = cost.max(min_cost_percent_per_run);
    reasoning.push(format!(
        "회당 소비를 {cost_percent_per_run:.2}%p로 봤습니다({cost_source}, 관측 {observations}구간)"
    ));
    GlobalCost {
        cost_percent_per_run,
        cost_source,
        observations,
    }
}

/// 배분이 끝난 뒤의 판단 문장. 여력이 남았는데 덜 넣었으면 무엇이 깎았는지 밝힌다 —
/// 상한에 닿았으면 상한이고, 아니면 다른 소비자와 나눈 것이다.
fn push_allocation_reasoning(
    reasoning: &mut Vec<String>,
    capacity_runs: usize,
    planned_runs: usize,
    limit: usize,
    bootstrapping: bool,
) {
    if capacity_runs > planned_runs {
        if planned_runs >= limit {
            reasoning.push(format!(
                "계정 여력 합계 {capacity_runs}건 중 상한 {limit}건만 이번 회차에 넣었습니다"
            ));
        } else {
            reasoning.push(format!(
                "계정 여력 합계 {capacity_runs}건 중 {planned_runs}건만 이번 회차에 넣었습니다(다른 소비자와 나눔)"
            ));
        }
    }
    if bootstrapping && planned_runs > 0 {
        reasoning.push("실측 표본이 없어 이번 회차는 첫 측정을 위한 최소 기동입니다".to_owned());
    }
    if planned_runs == 0 {
        reasoning.push("이번 회차는 기동할 계정이 없습니다".to_owned());
    }
}

fn compute_plan(
    store: &PacingStore,
    request: &UsagePacedRunsRequest,
    inputs: &PacingInputs<'_>,
) -> Result<PacingPlan, CoreError> {
    let PlanLimits {
        requested_target,
        cost_windows,
        min_cost_percent_per_run,
    } = validate_plan_request(request)?;
    let mut reasoning = Vec::new();
    let policy = inputs.policy;
    let cadence = resolve_cadence(store, request, inputs, &mut reasoning)?;

    let candidates = select_candidate_accounts(request, inputs, &mut reasoning)?;

    let account_ids: Vec<String> = candidates
        .iter()
        .map(|account| account.id.clone())
        .collect();
    let cadence_ms = cadence.minutes as i64 * 60_000;
    // 계정마다 채울 창. Antigravity만 회차 창과 다르고, 나머지는 빈 표라 종전과 같다.
    let window_labels = account_window_labels(request, &candidates, &mut reasoning)?;
    let provider_labels = provider_window_labels(&candidates, &window_labels);
    let ConsumerGate {
        consumer_id,
        configured_max_runs,
        max_runs,
        blocked,
        over_ceiling,
        sprint,
    } = resolve_consumer_gate(
        store,
        request,
        inputs,
        &provider_labels,
        cost_windows,
        &mut reasoning,
    )?;
    let basis = CostBasis {
        consumer_id: &consumer_id,
        account_ids: &account_ids,
        cost_windows,
        cadence_ms,
        min_cost_percent_per_run,
    };
    let GlobalCost {
        cost_percent_per_run,
        cost_source,
        observations,
    } = resolve_global_cost(store, request, &basis, &window_labels, &mut reasoning);
    let consumer_costs = measure_consumer_costs(
        store,
        request,
        &basis,
        &candidates,
        &provider_labels,
        &mut reasoning,
    );
    let GuardCosts {
        global: guard_costs,
        consumer: guard_consumer_costs,
    } = measure_guard_costs(
        store,
        request,
        policy,
        &basis,
        &candidates,
        &window_labels,
        &mut reasoning,
    );

    let ConsumerRecords {
        active_others,
        latest_record,
        last_served,
    } = collect_consumer_records(
        store,
        request,
        inputs,
        &cadence,
        &consumer_id,
        &mut reasoning,
    );
    let bootstrapping = observations == 0;
    let live_chat_ids = live_runtime_chat_ids(inputs.chats);
    let limit = concurrent_launch_limit(
        store,
        &consumer_id,
        max_runs,
        &live_chat_ids,
        &mut reasoning,
    );
    let guard_label = request.guard_window_label.as_deref();
    let EffectivePlanCaps {
        target_percent: effective_target_percent,
        guard_label: effective_guard_label,
        guard_percent: effective_guard_percent,
    } = effective_plan_caps(request, policy, guard_label, requested_target);
    let mut totals = AccountPlanTotals::default();
    let cost_measured_globally = cost_source == "measured";
    let lane_efforts = resolve_lane_efforts(policy, &consumer_id);
    let effort_costs = measure_effort_costs(
        store,
        &consumer_id,
        &request.window_label,
        &provider_labels,
        cost_windows,
    );
    // 상한 초과는 등급을 한 칸 내리는 방향으로 민다. 예전에는 여기서 회차를 통째로 0건으로
    // 막았지만 그러면 일이 멈춘다 — 먼저 한 칸 낮춰 보고 이미 바닥일 때만 쉰다.
    let ceiling_pressure: i8 = if over_ceiling.is_some() { -1 } else { 0 };
    let share = ConsumerShare {
        consumer_id: &consumer_id,
        max_runs,
        cadence_ms,
        active_others: &active_others,
        configured_max_runs: &configured_max_runs,
        latest_record: &latest_record,
        last_served: &last_served,
        policy,
    };
    let account_input = AccountPlanInput {
        store,
        request,
        window_labels: &window_labels,
        inputs,
        policy,
        cadence: &cadence,
        cadence_ms,
        requested_target,
        guard_label,
        cost_percent_per_run,
        cost_measured_globally,
        max_runs,
        blocked,
        over_ceiling: over_ceiling.is_some(),
        sprint,
        bootstrapping,
        ceiling_pressure,
        consumer_costs: &consumer_costs,
        guard_costs: &guard_costs,
        guard_consumer_costs: &guard_consumer_costs,
        live_chat_ids: &live_chat_ids,
        lane_efforts: &lane_efforts,
        effort_costs: &effort_costs,
        share: &share,
    };
    for account in &candidates {
        totals.absorb(&account.id, plan_account(account, &account_input));
    }
    totals.push_reasoning(&mut reasoning);

    let mut planned = fill_planned_runs(
        &mut totals.allowances,
        limit,
        request,
        &totals.efforts,
        &totals.effort_basis,
    );
    // 로컬은 상한 밖이다. 한도 있는 계정의 배분을 끝낸 뒤 고른 모델 수만큼 덧붙인다.
    let local = local_planned_runs(&request.local_models);
    if !local.is_empty() {
        reasoning.push(format!(
            "로컬 모델 {}개를 사용량 한도 없이 모델당 1건씩 더했습니다",
            local.len()
        ));
    }
    planned.extend(local);
    push_allocation_reasoning(
        &mut reasoning,
        totals.capacity_runs,
        planned.len(),
        limit,
        bootstrapping,
    );

    let stale_chat_ids = select_stale_runs(request, inputs.chats, &consumer_id);
    if !stale_chat_ids.is_empty() {
        reasoning.push(format!(
            "지난 회차의 완료된 무인 런타임 {}건을 정리 대상으로 넣었습니다",
            stale_chat_ids.len()
        ));
    }

    Ok(PacingPlan {
        cadence_minutes: cadence.minutes,
        cadence_source: cadence.source,
        cost_percent_per_run,
        cost_source,
        cost_observations: observations,
        cost_windows,
        min_cost_percent_per_run,
        target_percent: effective_target_percent,
        guard_label: effective_guard_label,
        guard_percent: effective_guard_percent,
        accounts: totals.views,
        planned,
        stale_chat_ids,
        reasoning,
        consumer_id,
        active_consumers: active_others,
        claim_baselines: totals.claim_baselines,
        guard_baselines: totals.guard_baselines,
        guard_costs,
        max_runs,
        account_costs: totals.account_costs,
        consumer_costs,
        provider_window_labels: provider_labels,
        account_window_labels: window_labels,
        blocked,
        over_ceiling,
    })
}

/// 계정 하나의 계획을 낼 때 회차 전체에서 한 번만 정해지는 입력. 계정마다 달라지는 값은
/// [`plan_account`]가 스스로 구한다.
struct AccountPlanInput<'a> {
    store: &'a PacingStore,
    request: &'a UsagePacedRunsRequest,
    /// 회차 창과 다른 창을 채우는 계정의 라벨표(Antigravity 모델군 창).
    window_labels: &'a AccountWindowLabels,
    inputs: &'a PacingInputs<'a>,
    policy: Option<&'a UsageBudgetPolicy>,
    cadence: &'a CadenceDecision,
    cadence_ms: i64,
    requested_target: f64,
    guard_label: Option<&'a str>,
    /// 실측이 없는 공급자에 쓰는 전역 회당 소비.
    cost_percent_per_run: f64,
    /// 전역 회당 소비가 실측인지. 공급자별 실측이 없을 때 여력 판정의 근거가 된다.
    cost_measured_globally: bool,
    max_runs: usize,
    blocked: bool,
    over_ceiling: bool,
    /// 스프린트 회차 — 계정 목표를 100%로 두고 직선 없이 감당 건수를 낸다(가드는 유지).
    sprint: bool,
    bootstrapping: bool,
    ceiling_pressure: i8,
    consumer_costs: &'a BTreeMap<ProviderId, (f64, f64)>,
    guard_costs: &'a BTreeMap<String, (f64, usize)>,
    guard_consumer_costs: &'a BTreeMap<(String, ProviderId), f64>,
    live_chat_ids: &'a BTreeSet<&'a str>,
    lane_efforts: &'a BTreeMap<ProviderId, LaneReasoningEffort>,
    effort_costs: &'a BTreeMap<ProviderId, BTreeMap<ReasoningEffort, f64>>,
    share: &'a ConsumerShare<'a>,
}

/// 계정 하나의 계획. 회차 전체의 누적값(여력 합계·미정산 예약·가드 상한에 걸린 계정 수)은
/// 호출부가 이 결과를 더해 만든다 — 계정 사이에 순서 의존이 없다는 것을 형태로 드러낸다.
struct AccountPlan {
    view: Value,
    /// 기동을 받은 계정만. (계정 id, 공급자, 허용 건수, 밀린 정도)
    allowance: Option<(String, ProviderId, usize, f64)>,
    /// 계획 창이 있을 때만. (현재 사용률, 리셋 시각)
    claim_baseline: Option<(f64, Option<i64>)>,
    guard_baselines: BTreeMap<String, GuardBaseline>,
    account_cost: f64,
    outstanding: f64,
    guard_capped: bool,
    /// 실측이 없어 첫 측정 1건(또는 진행 중이라 0건)으로 제한됐는지.
    first_measurement: bool,
    /// 배분 전 이 계정이 감당할 수 있던 건수.
    capacity_runs: usize,
    effort: ReasoningEffort,
    effort_basis: (&'static str, Option<f64>),
    effort_note: Option<String>,
}

/// 계정별 계획을 받아 두는 회차 전체의 집계. [`compute_plan`]이 계정 수만큼 돌며 열한
/// 갈래의 지역 변수에 흩어 담고, 담을 때마다 계정 id를 다시 적던 자리다. 한 타입으로
/// 모아 두면 계정 하나가 회차에 남기는 것이 무엇인지 [`AccountPlan`] 바로 옆에서 보이고,
/// 누적에서 나오는 판단 문장도 값과 같은 자리에 선다.
#[derive(Default)]
struct AccountPlanTotals {
    views: Vec<Value>,
    /// 계정, 공급자, 이번 회차 허용 건수, 균등 간격 대비 쉰 배수(클수록 먼저).
    allowances: Vec<(String, ProviderId, usize, f64)>,
    claim_baselines: BTreeMap<String, (f64, Option<i64>)>,
    guard_baselines: BTreeMap<String, BTreeMap<String, GuardBaseline>>,
    account_costs: BTreeMap<String, f64>,
    outstanding: f64,
    guard_capped_accounts: usize,
    /// 실측이 없어 첫 측정 1건으로 제한된 계정 수.
    first_measurement_accounts: usize,
    /// 배분 전 계정 여력 합계. 상한이나 다른 소비자 배분으로 얼마가 깎였는지 알린다.
    capacity_runs: usize,
    /// 계정별로 고른 추론수준과 그 근거(출처·여력). 기동 건에 실리고 판단 문장에도 남는다.
    /// 레인(공급자) 설정에 고정값이 있으면 여력 판정 대신 그 값, 자동이면 여력 사다리에
    /// 레인 상한을 씌운다.
    efforts: BTreeMap<String, ReasoningEffort>,
    effort_basis: BTreeMap<String, (&'static str, Option<f64>)>,
    effort_notes: Vec<String>,
}

impl AccountPlanTotals {
    fn absorb(&mut self, account_id: &str, plan: AccountPlan) {
        self.account_costs
            .insert(account_id.to_owned(), plan.account_cost);
        self.outstanding += plan.outstanding;
        self.guard_baselines
            .insert(account_id.to_owned(), plan.guard_baselines);
        if let Some(baseline) = plan.claim_baseline {
            self.claim_baselines.insert(account_id.to_owned(), baseline);
        }
        if plan.guard_capped {
            self.guard_capped_accounts += 1;
        }
        if plan.first_measurement {
            self.first_measurement_accounts += 1;
        }
        self.capacity_runs += plan.capacity_runs;
        self.efforts.insert(account_id.to_owned(), plan.effort);
        self.effort_basis
            .insert(account_id.to_owned(), plan.effort_basis);
        self.views.push(plan.view);
        self.allowances.extend(plan.allowance);
        self.effort_notes.extend(plan.effort_note);
    }

    /// 계정을 다 돈 뒤 누적에서만 나오는 판단 문장. 값이 0이면 아무 줄도 남기지 않는다.
    fn push_reasoning(&self, reasoning: &mut Vec<String>) {
        if self.outstanding > 0.0 {
            let outstanding = self.outstanding;
            reasoning.push(format!(
                "미정산 예약 {outstanding:.2}%p를 여유와 현재 시점의 몫에서 차감했습니다"
            ));
        }
        if self.guard_capped_accounts > 0 {
            let guard_capped_accounts = self.guard_capped_accounts;
            reasoning.push(format!(
                "가드 창의 여유(미정산 예약 차감)를 회당 소비로 나눈 감당 건수가 계정 {guard_capped_accounts}개의 기동 수를 제한했습니다"
            ));
        }
        if self.first_measurement_accounts > 0 {
            let first_measurement_accounts = self.first_measurement_accounts;
            reasoning.push(format!(
                "회당 소비가 실측되지 않은 계정 {first_measurement_accounts}개는 병렬 설정과 무관하게 첫 측정 1건만 기동했습니다(진행 중이면 0건). 실측이 잡히면 다음 회차부터 여력만큼 병렬로 배정합니다"
            ));
        }
        if !self.effort_notes.is_empty() {
            reasoning.push(format!(
                "추론수준은 레인 설정(고정값·자동 상한)과 계정 여력(리셋까지 남은 회차당 감당 건수, 계획·가드 창 중 빡빡한 값)으로 정했습니다: {}",
                self.effort_notes.join(", ")
            ));
        }
    }
}

/// 이 계정에 실제로 걸리는 계획 창 목표·가드 상한과, 직선을 버리고 몰아 쓰는지(`flat_out`).
/// 몰아 쓰기는 소진 모드(계정 전체, 가드도 100%)와 스프린트(회차 하나, 가드 유지) 두 갈래다.
struct AccountLimits {
    flat_out: bool,
    target_percent: f64,
    guard_percent: Option<f64>,
}

/// 요청 인자와 예산 정책, 소진 모드·스프린트를 합쳐 이 계정의 목표·가드를 정한다.
///
/// 정책은 캡이다: 목표·가드는 인자와 정책 중 낮은 쪽. 다만 소진 중인 계정은 계획 창과
/// 가드 창을 모두 100%까지 쓴다 — 목표에서 멈추면 창이 비지 않아 크레딧을 쓸 수
/// 없다([`DRAIN_TARGET_PERCENT`]). 크레딧이 예비 장수까지 줄면 `draining`이 꺼져
/// 같은 계정이 그 회차부터 종전 목표·가드로 돌아온다.
///
/// 스프린트 회차는 계획 창 목표만 100%로 올린다. 리셋 크레딧을 쓰지 않으니 창을 비워도
/// 되돌릴 일이 없고, 가드 창은 종전 상한을 지켜 실행 도중 공급자 한도에 걸리지 않게 한다.
fn account_limits(
    account: &ProviderAccountView,
    policy: Option<&UsageBudgetPolicy>,
    requested_target: f64,
    requested_guard: Option<f64>,
    sprint: bool,
) -> AccountLimits {
    // 소진 모드는 되돌릴 수단이 있는 계정에만 건다([`draining_account`]).
    let draining = policy.is_some_and(|policy| draining_account(policy, &account.usage));
    if draining {
        return AccountLimits {
            flat_out: true,
            target_percent: DRAIN_TARGET_PERCENT,
            guard_percent: Some(DRAIN_TARGET_PERCENT),
        };
    }
    let guard_percent = policy.map_or(requested_guard, |policy| {
        policy.effective_guard_percent(&account.id, requested_guard)
    });
    if sprint {
        return AccountLimits {
            flat_out: true,
            target_percent: DRAIN_TARGET_PERCENT,
            guard_percent,
        };
    }
    AccountLimits {
        flat_out: false,
        target_percent: policy.map_or(requested_target, |policy| {
            policy.effective_target(&account.id, requested_target)
        }),
        guard_percent,
    }
}

/// 한 계정에서 이번 소비자가 받은 기동 수와, 0건이면 왜 쉬는지.
struct RunAllocation {
    allowed: usize,
    note: Option<String>,
}

/// 계정이 감당할 수 있는 건수를 같은 창을 쓰는 활성 소비자와 나눈다. 0건으로 끝나는
/// 세 갈래(첫 측정·균등 목표 미달·다른 소비자가 먼저 받음)는 서로 다른 사유라 문구도
/// 여기서 함께 정한다 — 호출부는 배분 규칙을 몰라도 된다.
fn allocate_account_runs(
    share: &ConsumerShare<'_>,
    open_claims: &[Claim],
    budget_runs: usize,
    bootstrapping: bool,
    unstarted: bool,
    even_period_minutes: Option<f64>,
) -> RunAllocation {
    let demands = share.demands(open_claims);
    let allowed = usage_budget::allocate_runs(share.consumer_id, &demands, budget_runs);
    if allowed > 0 {
        return RunAllocation {
            allowed,
            note: unstarted.then(|| "창 미시작 — 첫 기동으로 창을 엶".to_owned()),
        };
    }
    if bootstrapping {
        // 표본이 하나도 없으면 회당 소비가 근거 없는 대체값이다. 그 값으로 전 계정
        // 0건을 내면 기동이 없어 표본도 생기지 않고, 실측이 시작되지 못한 채 창
        // 후반까지 쉰다. 첫 측정이 될 한 건만 허용해 고리를 끊는다.
        return RunAllocation {
            allowed: 1,
            note: Some(format!(
                "실측 표본이 없어 첫 측정으로 1건만 기동(균등 간격 {:.0}분)",
                even_period_minutes.unwrap_or(0.0)
            )),
        };
    }
    let note = if budget_runs == 0 {
        format!(
            "현재 시점의 균등 목표까지 남은 소비가 회당 비용보다 작아 이번 회차는 쉼(균등 간격 {:.0}분)",
            even_period_minutes.unwrap_or(0.0),
        )
    } else {
        format!("회차 기동 {budget_runs}건을 다른 소비자가 먼저 받아 이번 회차는 쉼")
    };
    RunAllocation {
        allowed,
        note: Some(note),
    }
}

/// 기동을 받은 계정 한 줄의 등급 근거 문구. 왜 이 추론수준이 됐는지를 사람이 읽을 한
/// 줄로 만든다.
fn describe_effort_choice(
    account: &ProviderAccountView,
    effort: &ReasoningEffort,
    effort_source: &str,
    headroom_runs_per_round: Option<f64>,
    effort_cap: Option<&ReasoningEffort>,
) -> String {
    let basis = if effort_source == "fixed" {
        "레인 설정 고정".to_owned()
    } else {
        let basis = headroom_runs_per_round.map_or_else(
            || "여력 미측정 → 기본".to_owned(),
            |ratio| format!("{ratio:.2}건/회차"),
        );
        match effort_cap {
            Some(cap) => format!("{basis}, 상한 {}", cap.as_str()),
            None => basis,
        }
    };
    format!(
        "{} {}({basis})",
        account.email.as_deref().unwrap_or(&account.id),
        effort.as_str(),
    )
}

/// 계획 창에서 이 계정이 지금 어떤 상태인지. 셋 모두 "아직 표본에 보이지 않는 소비"라는
/// 한 사실의 세 면이라 한 자리에서 읽는다.
struct AccountClaimState {
    /// 아직 정산되지 않은 예약.
    open: Vec<Claim>,
    /// 그 예약들의 미정산 %p.
    outstanding: f64,
    /// 이 계정에서 실행이 아직 돌고 있는지.
    running: bool,
}

/// 이 실행이 그 계획 창의 쿼터를 채우는지.
///
/// Antigravity 계정 하나는 모델군 두 개의 쿼터를 따로 들고 있고 페이싱은 이번 회차 모델이
/// 쓰는 모델군 창으로 계획한다([`account_window_labels`]). 실행 점유를 계정 단위로 보면
/// Gemini 회차가 도는 동안 같은 계정의 Claude/GPT 창은 여유가 100%여도 실측 없는 가드에서
/// 한 건도 감당하지 못하는 것으로 읽혀([`project_guard_windows`]), 그 창은 첫 기동을 받지
/// 못하고 회당 소비도 영영 실측되지 않는다. 예약은 이미 창 단위로 갈리므로 점유도 같은
/// 단위로 본다.
///
/// 모델을 남기지 않은 옛 기록은 종전처럼 계정의 모든 창을 점유한 것으로 본다.
fn run_consumes_window(run: &RunRecord, plan_label: &str) -> bool {
    if run.provider != ProviderId::Antigravity {
        return true;
    }
    run.model
        .as_deref()
        .is_none_or(|model| crate::antigravity_usage::model_consumes_window(model, plan_label))
}

/// 아직 표본에 보이지 않는 모든 소비자의 미정산 예약을 모은다. 여유와 현재 시점의 몫에서
/// 미리 빼려는 것이고, 현재 소비자의 직전 계획도 실제 기동·표본 확인 전에는 예약일 뿐이다.
/// 다음 회차까지 실행 기록이 없으면 TTL이 닫아 다시 예산으로 돌아온다.
///
/// 진행 중 실행 여부를 함께 답한다 — 실행이 도는 계정은 실측 없는 가드 창에서 겹쳐
/// 띄우지 않는다([`project_guard_windows`] 참고).
fn account_claim_state(
    store: &PacingStore,
    window_label: &str,
    plan_label: &str,
    account_id: &str,
    window: Option<&crate::accounts::AccountUsageWindow>,
    live_chat_ids: &BTreeSet<&str>,
    now: i64,
) -> AccountClaimState {
    let (open, outstanding) = match window {
        Some(window) => {
            let claims = claims_for_account(
                store,
                window_label,
                plan_label,
                plan_label,
                account_id,
                live_chat_ids,
            );
            let open = usage_budget::open_claims(&claims, now, window);
            let outstanding = usage_budget::outstanding_percent(&open, window.used_percent);
            (open, outstanding)
        }
        None => (Vec::new(), 0.0),
    };
    let running = store.runs.iter().any(|run| {
        run.account_id == account_id
            && run.ended_at.is_none()
            && live_chat_ids.contains(run.chat_id.as_str())
            && run_consumes_window(run, plan_label)
    });
    AccountClaimState {
        open,
        outstanding,
        running,
    }
}

struct HeadroomRatioInput<'a> {
    window_present: bool,
    unstarted: bool,
    /// 회당 소비가 실측값인지. 대체값이면 여력을 계산할 근거가 없다.
    cost_measured: bool,
    remaining_runs: usize,
    net_headroom: f64,
    account_cost: f64,
    /// 실측된 가드 창들의 같은 비율.
    guard_headroom_rounds: &'a [f64],
}

/// 추론수준을 정할 계정 여력: 리셋까지 남은 회차마다 감당할 수 있는 건수. 계획 창의
/// 순여유 ÷ 회당 소비 ÷ 남은 회차 수와, 실측된 가드 창의 같은 값 중 가장 빡빡한 쪽이다.
/// 회당 소비가 대체값이거나 창이 시작되지 않았으면 근거가 없어 `None`이고, 그때는 등급
/// 선택이 기본 수준으로 간다.
fn headroom_runs_per_round(input: &HeadroomRatioInput<'_>) -> Option<f64> {
    (input.window_present
        && !input.unstarted
        && input.cost_measured
        && input.remaining_runs > 0
        && input.account_cost > 0.0)
        .then(|| {
            let plan_ratio = input.net_headroom / input.account_cost / input.remaining_runs as f64;
            input
                .guard_headroom_rounds
                .iter()
                .copied()
                .fold(plan_ratio, f64::min)
        })
}

struct RunLimitsInput<'a> {
    guard_views: &'a [Value],
    tightest_guard: Option<&'a (usize, String)>,
    guard_cap: Option<usize>,
    account_running: bool,
    /// 이 계정 자신의 계획 창 회당 소비가 실측됐는지. 공급자·전역 실측은 대신하지 못한다 —
    /// 같은 공급자라도 플랜(창 크기)이 다르면 %p가 다르다.
    account_measured: bool,
    share: &'a ConsumerShare<'a>,
    open_claims: &'a [Claim],
    bootstrapping: bool,
    unstarted: bool,
    even_period_minutes: Option<f64>,
}

/// 예산 건수에 씌우는 두 겹의 제한과 그 결과.
struct AccountRunLimits {
    guard_capped: bool,
    /// 실측이 없어 첫 측정 1건으로 잘렸는지(진행 중이라 0건으로 쉰 경우 포함).
    first_measurement: bool,
    /// 이번 소비자가 이 계정에서 받은 기동 수.
    allowed: usize,
    /// 배분 전 이 계정이 감당할 수 있던 건수.
    capacity_runs: usize,
    /// 0건이면 왜 쉬는지.
    note: Option<String>,
}

/// 예산 건수를 가드 창 상한으로 자른 뒤, 실측이 없는 계정은 첫 측정 1건으로 다시 자르고,
/// 남은 건수를 같은 창을 쓰는 활성 소비자와 나눈다.
///
/// 가드 상한이 한 건도 허락하지 않으면 그것은 제외 사유라 배분까지 가지 않는다 — 배분이
/// 들고 있는 첫 측정 예외가 그 사유를 덮으면 가드를 넘겨 기동한다.
///
/// 첫 측정 제한은 계정 자신의 실측 여부로 건다. 대체값이나 다른 계정의 실측으로 여력이
/// 커 보여도 이 계정이 한 건에 얼마를 쓰는지는 모르는 것이고, 그 상태로 병렬을 세우면
/// 첫 회차가 창을 통째로 비울 수 있다. 첫 측정 실행이 아직 도는 동안은 그 결과가 표본에
/// 들어오기 전이라 0건이다 — 여기서 1건을 더 주면 결국 병렬이다. 실측되면 이 제한은
/// 사라지고 여력이 그대로 건수가 된다.
fn limit_account_runs(budget_runs: &mut usize, input: &RunLimitsInput<'_>) -> AccountRunLimits {
    let guard = apply_guard_cap(
        budget_runs,
        input.guard_views,
        input.tightest_guard,
        input.guard_cap,
        input.account_running,
    );
    if guard.note.is_some() {
        return AccountRunLimits {
            guard_capped: guard.capped,
            first_measurement: false,
            allowed: 0,
            capacity_runs: 0,
            note: guard.note,
        };
    }
    // 예산 건수(`budget_runs`)는 여력 그대로 두고 배분에 넣는 건수만 자른다 — 화면의
    // budgetRuns는 "감당할 수 있던 건수"고 allowedRuns가 "받은 건수"다.
    let mut first_measurement = false;
    let mut runs_to_allocate = *budget_runs;
    if !input.account_measured {
        if input.account_running {
            return AccountRunLimits {
                guard_capped: guard.capped,
                first_measurement: true,
                allowed: 0,
                capacity_runs: *budget_runs,
                note: Some(
                    "이 계정의 회당 소비를 아직 실측하지 못했고 첫 측정 실행이 진행 중이라 이번 회차는 쉼(실측 뒤 병렬)"
                        .to_owned(),
                ),
            };
        }
        if runs_to_allocate > 1 {
            runs_to_allocate = 1;
            first_measurement = true;
        }
    }
    let allocation = allocate_account_runs(
        input.share,
        input.open_claims,
        runs_to_allocate,
        input.bootstrapping,
        input.unstarted,
        input.even_period_minutes,
    );
    let note = allocation.note.or_else(|| {
        (first_measurement && allocation.allowed > 0)
            .then(|| "회당 소비 실측 전 — 첫 측정으로 1건만 기동(실측 뒤 병렬)".to_owned())
    });
    AccountRunLimits {
        guard_capped: guard.capped,
        first_measurement,
        allowed: allocation.allowed,
        capacity_runs: *budget_runs,
        note,
    }
}

fn plan_account(account: &ProviderAccountView, input: &AccountPlanInput<'_>) -> AccountPlan {
    let AccountPlanInput {
        store,
        request,
        window_labels,
        inputs,
        policy,
        cadence,
        cadence_ms,
        requested_target,
        guard_label,
        cost_percent_per_run,
        cost_measured_globally,
        max_runs,
        blocked,
        over_ceiling,
        sprint,
        bootstrapping,
        ceiling_pressure,
        consumer_costs,
        guard_costs,
        guard_consumer_costs,
        live_chat_ids,
        lane_efforts,
        effort_costs,
        share,
    } = *input;
    let mut allowed = 0usize;
    let mut guard_capped = false;
    let mut first_measurement = false;
    let mut capacity_runs_of_account = 0usize;
    // 이 계정이 채우는 창. Antigravity만 회차 창과 다르다(모델군 창).
    let window_label = account_window_label(window_labels, &account.id, &request.window_label);
    let window = window_of(&account.usage, window_label);
    // 아직 소비가 없는 창은 공급자가 리셋 시각을 주지 않는다(Codex는 조회마다 밀리는
    // 값을 주므로 accounts가 None으로 맞춘다). 리셋 시각이 없다고 건너뛰면 풀에 있어도
    // 창이 완전히 리셋된 계정은 사람이 한 번 쓰기 전까지 회차가 다시 열어 주지 않는다.
    // 다만 사용량 조회가 막혀 묵은 0%라면 믿지 않는다 — 회차마다 첫 기동을 되풀이하며
    // 목표에도 가드에도 안 보이는 소비가 쌓인다. 회차 첫 단계가 사용량을 갱신하므로
    // 정상이면 한 간격보다 새 값이다.
    let unstarted = window
        .is_some_and(|window| window.resets_at.is_none() && window.used_percent <= 0.0)
        && account
            .usage
            .updated_at
            .is_some_and(|updated_at| inputs.now - updated_at <= cadence_ms);
    let AccountLimits {
        flat_out,
        target_percent,
        guard_percent,
    } = account_limits(
        account,
        policy,
        requested_target,
        request.guard_percent,
        sprint,
    );
    // 이름으로 지정한 가드 창도 이 계정이 채우는 창과 같은 모델군에서 고른다. 계정 대표
    // 가드 창은 다른 모델군의 소진을 싣고 있어 그대로 쓰면 이 모델군 쿼터가 막히고, 화면에는
    // 지정 라벨이 걸린 것처럼 보이면서 실제로는 아무 창도 지키지 않는 어긋남이 생긴다.
    let account_guard_label = scoped_guard_label(
        &account.usage,
        window_label,
        guard_label
            .or_else(|| policy.and_then(|policy| policy.defaults.guard_window_label.as_deref())),
    );
    let guards = guard_windows(&account.usage, window_label, account_guard_label.as_deref());
    let reason = skip_reason(account, inputs.now, &guards, guard_percent);
    let account_cost = consumer_costs
        .get(&account.provider)
        .map(|(cost, _)| *cost)
        .unwrap_or(cost_percent_per_run);
    let AccountClaimState {
        open: open_claims,
        outstanding,
        running: account_running,
    } = account_claim_state(
        store,
        &request.window_label,
        window_label,
        &account.id,
        window,
        live_chat_ids,
        inputs.now,
    );
    let GuardProjection {
        views: guard_views,
        cap: guard_cap,
        tightest: tightest_guard,
        baselines: account_guard_baselines,
        headroom_rounds: guard_headroom_rounds,
    } = project_guard_windows(
        store,
        &GuardProjectionInput {
            plan_window_label: &request.window_label,
            account_window_label: window_label,
            account_id: &account.id,
            provider: account.provider,
            guards: &guards,
            guard_percent,
            account_running,
            live_chat_ids,
            now: inputs.now,
            quiet: cadence.quiet.as_ref(),
            cadence_ms,
            guard_costs,
            guard_consumer_costs,
        },
    );
    let AccountWindowMetrics {
        used_percent,
        resets_at,
        remaining_ms,
        remaining_runs,
        headroom,
        net_headroom,
    } = account_window_metrics(
        window,
        cadence.quiet.as_ref(),
        inputs.now,
        cadence_ms,
        target_percent,
        outstanding,
    );
    let claim_baseline = window.map(|window| (window.used_percent, window.resets_at));
    let cost_measured = cost_measured_globally || consumer_costs.contains_key(&account.provider);
    // 이 계정 자신의 실측. 전역·공급자 실측(`cost_measured`)은 등급 판정의 근거로는 충분하지만
    // 병렬 기동의 근거로는 부족하다 — 같은 공급자라도 플랜이 다르면 창 크기가 달라 회당 %p가
    // 다르고, 그 차이가 첫 회차에서 창을 비운다([`limit_account_runs`]).
    let account_measured = measure_window_cost_per_run(
        store,
        &request.window_label,
        None,
        window_labels,
        std::slice::from_ref(&account.id),
        DEFAULT_COST_WINDOWS,
        cadence_ms,
    )
    .0
    .is_some_and(|cost| cost > 0.0);
    let headroom_runs_per_round = headroom_runs_per_round(&HeadroomRatioInput {
        window_present: window.is_some(),
        unstarted,
        cost_measured,
        remaining_runs,
        net_headroom,
        account_cost,
        guard_headroom_rounds: &guard_headroom_rounds,
    });
    let SelectedEffort {
        effort: reasoning_effort,
        source: effort_source,
        cap: effort_cap,
    } = select_reasoning_effort(
        account.provider,
        lane_efforts.get(&account.provider),
        headroom_runs_per_round,
        ceiling_pressure,
        effort_costs.get(&account.provider),
        net_headroom,
        remaining_runs,
        max_runs,
    );
    // 이 계정의 등급이 아직 바닥 위인지. 상한을 넘겨도 낮출 여지가 남아 있으면 회차를
    // 멈추지 않고 낮춘 등급으로 돈다.
    let effort_above_floor = effort_is_above_floor(
        account.provider,
        lane_efforts.get(&account.provider),
        &reasoning_effort,
    );
    let effort_basis = (
        effort_source,
        (effort_source == "auto")
            .then_some(headroom_runs_per_round)
            .flatten(),
    );
    let BudgetDecision {
        runs: mut budget_runs,
        mut note,
        due,
    } = account_budget_decision(&BudgetDecisionInput {
        blocked,
        over_ceiling,
        effort_above_floor,
        skip_reason: reason.as_deref(),
        window_present: window.is_some(),
        remaining_runs,
        unstarted,
        due: DueRunsInput {
            window_label,
            quiet: cadence.quiet.as_ref(),
            now: inputs.now,
            cadence_ms,
            net_headroom,
            account_cost,
            remaining_ms,
            resets_at,
            target_percent,
            used_percent,
            outstanding,
            flat_out,
        },
    });
    // 균등 소비 판정 값. 응답에 실어 왜 뽑혔는지·왜 쉬는지 보이게 한다.
    let even_period_minutes = due.as_ref().map(|due| due.even_period_minutes);
    let window_elapsed_minutes = due.as_ref().map(|due| due.window_elapsed_minutes);
    let due_percent_view = due.as_ref().map(|due| due.due_percent);
    let due_runs_view = due.as_ref().and_then(|due| due.due_runs);
    let burst_view = due.as_ref().and_then(|due| due.burst);
    let urgency = due.as_ref().map_or(0.0, |due| due.urgency);
    if note.is_none() {
        let limited = limit_account_runs(
            &mut budget_runs,
            &RunLimitsInput {
                guard_views: &guard_views,
                tightest_guard: tightest_guard.as_ref(),
                guard_cap,
                account_running,
                account_measured,
                share,
                open_claims: &open_claims,
                bootstrapping,
                unstarted,
                even_period_minutes,
            },
        );
        guard_capped = limited.guard_capped;
        first_measurement = limited.first_measurement;
        allowed = limited.allowed;
        capacity_runs_of_account = limited.capacity_runs;
        note = limited.note;
    }
    let view = json!({
        "accountId": account.id,
        "email": account.email,
        "provider": account.provider,
        // 이 계정이 실제로 채운 창. 회차 창과 다를 수 있다(Antigravity 모델군 창).
        "windowLabel": window_label,
        "usedPercent": used_percent,
        "resetsAt": resets_at,
        "remainingRuns": remaining_runs,
        "targetPercent": target_percent,
        "guardLabel": account_guard_label,
        "guardPercent": guard_percent,
        "headroomPercent": headroom,
        "outstandingClaimPercent": outstanding,
        "netHeadroomPercent": net_headroom,
        "budgetRuns": budget_runs,
        "costPercentPerRun": account_cost,
        // 이 계정 자신의 회당 소비가 실측됐는지와, 실측 전이라 첫 측정 1건으로 잘렸는지.
        "accountCostMeasured": account_measured,
        "firstMeasurement": first_measurement,
        "evenPeriodMinutes": even_period_minutes,
        "windowElapsedMinutes": window_elapsed_minutes,
        // 스케줄이 켜져 있을 때 리셋까지 남은 열린 시간(분). 꺼져 있으면 null.
        "openRemainingMinutes": cadence.quiet.as_ref().map(|_| remaining_ms as f64 / 60_000.0),
        "duePercent": due_percent_view,
        "dueRuns": due_runs_view,
        "burstRuns": burst_view,
        "guards": guard_views,
        "guardCapRuns": guard_cap,
        "headroomRunsPerRound": headroom_runs_per_round,
        "reasoningEffort": reasoning_effort.as_str(),
        "reasoningEffortSource": effort_source,
        "reasoningEffortCap": effort_cap.as_ref().map(ReasoningEffort::as_str),
        "allowedRuns": allowed,
        "skipReason": note,
    });
    let (allowance, effort_note) = if allowed > 0 {
        // 미시작 창은 창 전체 예산이 놀고 있으니 어떤 밀림보다 앞에 세운다.
        let rank = if unstarted { f64::MAX } else { urgency };
        let note = describe_effort_choice(
            account,
            &reasoning_effort,
            effort_source,
            headroom_runs_per_round,
            effort_cap.as_ref(),
        );
        (
            Some((account.id.clone(), account.provider, allowed, rank)),
            Some(note),
        )
    } else {
        (None, None)
    };
    AccountPlan {
        view,
        allowance,
        claim_baseline,
        guard_baselines: account_guard_baselines,
        account_cost,
        outstanding,
        guard_capped,
        first_measurement,
        capacity_runs: capacity_runs_of_account,
        effort: reasoning_effort,
        effort_basis,
        effort_note,
    }
}

/// 이번 회차의 기동 수를 나눌 소비자 집합. 계정마다 같은 소비자 목록을 쓰되, 이미 예약을
/// 남긴 소비자는 그 계정에서만 빠지므로 계정별 열린 예약을 받아 수요 목록을 만든다.
struct ConsumerShare<'a> {
    consumer_id: &'a str,
    /// 현재 소비자의 회차 기동 상한 = 수요.
    max_runs: usize,
    cadence_ms: i64,
    /// 같은 창을 쓰는 다른 활성 소비자(일시정지된 반복 요청은 이미 빠짐).
    active_others: &'a [String],
    /// 반복 요청별 병렬 실행 설정 — 다른 소비자의 수요는 여기서 먼저 읽는다.
    configured_max_runs: &'a BTreeMap<&'a str, usize>,
    /// 소비자별 최근 계획 기록 — 다른 소비자의 간격을 여기서 읽고, 설정이 없을 때 기동 상한의
    /// 대체값으로도 쓴다.
    latest_record: &'a BTreeMap<&'a str, &'a PlanRecord>,
    /// 소비자별로 마지막으로 실제 기동을 배정받은 시각.
    last_served: &'a BTreeMap<&'a str, i64>,
    policy: Option<&'a UsageBudgetPolicy>,
}

impl ConsumerShare<'_> {
    fn priority_of(&self, consumer: &str) -> u8 {
        self.policy
            .map_or(usage_budget_policy::DEFAULT_CONSUMER_PRIORITY, |policy| {
                policy.consumer_priority(consumer)
            })
    }

    /// 한 계정에서 기동 수를 나눌 수요 목록. 현재 소비자가 먼저 오고, 이미 예약을 남긴 다른
    /// 소비자는 자기 몫을 가져간 뒤이므로 다시 잡지 않는다. 간격이 다른 소비자의 수요는
    /// 현재 간격으로 환산한다.
    fn demands(&self, open_claims: &[Claim]) -> Vec<ConsumerDemand> {
        let mut demands = vec![ConsumerDemand {
            consumer_id: self.consumer_id.to_owned(),
            demand_runs: self.max_runs,
            last_served_at: self.last_served.get(self.consumer_id).copied(),
            priority: self.priority_of(self.consumer_id),
        }];
        for other in self.active_others {
            if open_claims.iter().any(|claim| claim.consumer_id == *other) {
                continue;
            }
            // 수요는 반복 요청의 병렬 실행 설정이 정본이다. 설정을 모르면 지난 계획 기록,
            // 그것도 없으면 1 — 모르는 소비자가 돌고 있는 회차의 예산을 독점하면 안 되고,
            // 배분이 라운드로빈이라 수요 1이어도 첫 자리는 보장된다.
            let record = self.latest_record.get(other.as_str());
            let other_max_runs = self
                .configured_max_runs
                .get(other.as_str())
                .copied()
                .or_else(|| record.and_then(|record| record.max_runs))
                .unwrap_or(crate::scheduler::DEFAULT_MAX_RUNS as usize);
            let other_cadence = record
                .and_then(|record| record.cadence_ms)
                .unwrap_or(self.cadence_ms);
            // 간격이 좁은 소비자는 이 회차 안에 여러 번 뜨므로 그만큼을 요구한다. 천장은 두지
            // 않는다 — 큰 수요는 라운드로빈에서 "남는 몫을 다 가져간다"는 뜻일 뿐이다.
            let scaled = (other_max_runs as f64 * self.cadence_ms as f64
                / other_cadence.max(1) as f64)
                .round()
                .max(1.0) as usize;
            demands.push(ConsumerDemand {
                consumer_id: other.clone(),
                demand_runs: scaled,
                last_served_at: self.last_served.get(other.as_str()).copied(),
                priority: self.priority_of(other),
            });
        }
        demands
    }
}

/// 지난 회차의 정리 대상: 이 워크플로가 띄운 것과 같은 작업 경로의 무인 런타임 중 턴이 끝난
/// 것만이다. 진행 중이거나 승인을 기다리는 런타임은 건드리지 않는다.
///
/// 출처가 있는 런타임은 이 소비자(또는 이 워크플로)가 띄운 것만 고른다 — 같은 경로를 쓰는
/// 다른 소비자의 런타임을 잘못 끄지 않는다. 출처가 없는 옛 런타임만 경로로 본다.
fn select_stale_runs(
    request: &UsagePacedRunsRequest,
    chats: &[ChatSessionInfo],
    consumer_id: &str,
) -> Vec<(String, ProviderId)> {
    let stale_cwd = request
        .stale_run_cwd
        .as_deref()
        .unwrap_or(&request.project_path);
    chats
        .iter()
        .filter(|chat| {
            chat.unattended
                // 아직 살아 있는데 턴만 끝난 것이 정리 대상이다. 이미 Stopped·Failed 인
                // 런타임을 다시 집으면 `stop_managed` 가 alreadyStopped 로 되돌려 보낼 뿐
                // 목록에서 빠지지는 않아, 같은 죽은 채팅을 회차마다 다시 멈추게 된다.
                // 실제로 회차당 +5씩 쌓여 269건이 됐고, 한 회차의 단계 277개 중 269개가
                // 그 헛된 stop_chat 이었다(2026-10-02 실측). 기동한 회차는 그 뒤에서
                // 밀려 작업을 시작하지 못한 채 레인만 잡고 끝났다.
                && chat.state == crate::chat::ChatPhase::Ready
                && chat.last_turn_status.is_some()
                && match &chat.origin {
                    // 반복 요청이 띄운 런타임은 그 반복 요청만 정리한다. 워크플로 일치로도
                    // 집으면 같은 워크플로를 도는 반복 요청이 둘일 때(같은 QA를 종류만
                    // 나눠 돌리는 구성) 서로의 끝난 런타임을 끄고, 아직 회수하지 않은
                    // 결과가 사라진다. 반복 요청 없이 돈 런타임(수동·adhoc)은 소비자가
                    // 워크플로 id라 주인이 없으므로 이 워크플로의 회차가 정리한다.
                    Some(origin) if origin.schedule_id.is_some() => {
                        origin.consumer_id.as_deref() == Some(consumer_id)
                            || origin.schedule_id.as_deref() == Some(consumer_id)
                    }
                    Some(origin) if origin.workflow_id.is_some() => {
                        origin.workflow_id == request.cadence_workflow_id
                    }
                    // 출처는 있는데 반복 요청·워크플로가 둘 다 없는 런타임은 AIA나 사용자가
                    // 직접 띄운 것이다. 같은 경로라도 이 회차의 것이 아니므로 건드리지
                    // 않는다 — 경로로 고르는 것은 출처 없는 옛 런타임만이다.
                    Some(_) => false,
                    None => chat.cwd == stale_cwd,
                }
        })
        .map(|chat| (chat.chat_id.clone(), chat.source))
        .collect()
}

/// 계획을 계산하고 그 회차를 예약으로 기록한 뒤 응답을 만든다. 기록은 다음 회차의
/// 회당 비용 실측 근거이자 다른 소비자가 차감할 미정산 예약이므로 계획과 같은 잠금
/// 안에서 남긴다.
fn plan_and_record(
    app_data_dir: &Path,
    request: &UsagePacedRunsRequest,
    inputs: &PacingInputs<'_>,
) -> Result<Value, CoreError> {
    let plan = with_store_lock(app_data_dir, || {
        let mut store = load_store(app_data_dir)?;
        let plan = compute_plan(&store, request, inputs)?;
        if plan.blocked {
            return Ok(plan);
        }
        // 기동이 없어도 기록한다 — 이 소비자가 이 창을 쓰고 있다는 표시라 다른 소비자의
        // 배분에 들어간다. 기대 소비가 없으니 예약으로는 세지 않는다.
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for run in &plan.planned {
            *counts.entry(run.account_id.clone()).or_default() += 1;
        }
        let entries = counts
            .into_iter()
            .map(|(account_id, count)| {
                let (used, resets) = plan
                    .claim_baselines
                    .get(&account_id)
                    .map(|(used, resets)| (Some(*used), *resets))
                    .unwrap_or((None, None));
                let cost = plan
                    .account_costs
                    .get(&account_id)
                    .copied()
                    .unwrap_or(plan.cost_percent_per_run);
                let guards = plan
                    .guard_baselines
                    .get(&account_id)
                    .map(|baselines| {
                        baselines
                            .iter()
                            .map(|(label, baseline)| {
                                (
                                    label.clone(),
                                    WindowClaim {
                                        expected_cost_percent: baseline
                                            .cost_percent_per_run
                                            .map(|cost| count as f64 * cost),
                                        used_percent_at_claim: Some(baseline.used_percent),
                                        resets_at_at_claim: baseline.resets_at,
                                    },
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                PlanRecordEntry {
                    window_label: plan.account_window_labels.get(&account_id).cloned(),
                    expected_cost_percent: Some(count as f64 * cost),
                    used_percent_at_claim: used,
                    resets_at_at_claim: resets,
                    guards,
                    account_id,
                    count,
                }
            })
            .collect();
        // 이번 회차로 기준선이 다 모였으면 여기서 붙박는다. 계획을 쓰는 자리라 이미
        // 저장소를 다시 쓰는 중이고, 정책의 기준선 회차 수와 창 라벨이 둘 다 여기 있다.
        freeze_ready_baselines(
            &mut store,
            &plan.consumer_id,
            &request.window_label,
            &plan.provider_window_labels,
            baseline_runs_for(inputs),
            inputs.now,
        );
        store.plans.push(PlanRecord {
            at: inputs.now,
            window_label: request.window_label.clone(),
            entries,
            consumer_id: Some(plan.consumer_id.clone()),
            workflow_id: request.cadence_workflow_id.clone(),
            cadence_ms: Some(plan.cadence_minutes as i64 * 60_000),
            cwd: Some(request.project_path.clone()),
            max_runs: Some(plan.max_runs),
            execution_id: request.execution_id.clone(),
        });
        if store.plans.len() > MAX_PLAN_RECORDS {
            let excess = store.plans.len() - MAX_PLAN_RECORDS;
            store.plans.drain(..excess);
        }
        save_store(app_data_dir, &store)?;
        Ok(plan)
    })?;
    render_plan(request, &plan)
}

/// 계획을 워크플로가 순회할 응답 형태로 만든다.
fn render_plan(request: &UsagePacedRunsRequest, plan: &PacingPlan) -> Result<Value, CoreError> {
    let planned: Vec<Value> = plan
        .planned
        .iter()
        .enumerate()
        .map(|(index, run)| {
            json!({
                "index": index + 1,
                "accountId": run.account_id,
                "source": run.source,
                "model": run.model,
                "cwd": request.project_path,
                "reasoningEffort": run.reasoning_effort,
                "reasoningEffortSource": run.reasoning_effort_source,
                "headroomRunsPerRound": run.headroom_runs_per_round,
            })
        })
        .collect();
    let stale_runs: Vec<Value> = plan
        .stale_chat_ids
        .iter()
        .map(|(chat_id, source)| json!({"chatId": chat_id, "source": source}))
        .collect();
    Ok(json!({
        "consumerId": plan.consumer_id,
        "activeConsumers": plan.active_consumers,
        "blocked": plan.blocked,
        "overCeiling": plan.over_ceiling,
        "cadence": {
            "minutes": plan.cadence_minutes,
            "source": plan.cadence_source,
        },
        "window": {
            "label": request.window_label,
            "targetPercent": plan.target_percent,
            "guardLabel": plan.guard_label,
            "guardPercent": plan.guard_percent,
        },
        "cost": {
            "percentPerRun": plan.cost_percent_per_run,
            "source": plan.cost_source,
            "observations": plan.cost_observations,
            "windows": plan.cost_windows,
            "minPercentPerRun": plan.min_cost_percent_per_run,
            // 가드 창 라벨별 전역 회당 소비. 계정 행의 guards[].costPercentPerRun은 소비자·
            // 공급자별 실측이 있으면 그것을 우선한다.
            "guards": plan
                .guard_costs
                .iter()
                .map(|(label, (cost, observations))| {
                    (
                        label.clone(),
                        json!({"percentPerRun": cost, "observations": observations}),
                    )
                })
                .collect::<serde_json::Map<String, Value>>(),
            "consumer": plan
                .consumer_costs
                .iter()
                .map(|(provider, (cost, weight))| {
                    (
                        provider.as_str().to_owned(),
                        json!({"percentPerRun": cost, "observationWeight": weight}),
                    )
                })
                .collect::<serde_json::Map<String, Value>>(),
        },
        "accounts": plan.accounts,
        "plannedRuns": planned,
        "plannedRunCount": planned.len(),
        "staleRuns": stale_runs,
        "reasoning": plan.reasoning,
    }))
}

/// 워크플로 인자에서 빠진 창·목표를 사용량 예산 기본값으로 채운다. 페이싱 값의
/// 소유권이 워크플로 페이싱 탭으로 옮겨 가면서 계약에는 회차 고유 값만 남고,
/// 어느 창을 어디까지 채울지는 예산 정책이 정한다.
fn fill_from_policy(
    request: &UsagePacedRunsRequest,
    policy: Option<&UsageBudgetPolicy>,
) -> UsagePacedRunsRequest {
    let mut resolved = request.clone();
    if resolved.window_label.trim().is_empty() {
        if let Some(label) = policy.and_then(|policy| policy.defaults.window_label.clone()) {
            resolved.window_label = label;
        }
    }
    if resolved.target_percent.is_none() {
        resolved.target_percent = policy.and_then(|policy| policy.defaults.target_percent);
    }
    resolved
}

/// 계획과 미리보기가 계산 전에 똑같이 밟는 준비 — 예산 정책을 읽고, 페이싱 워크플로 목록을
/// 모으고, 계약에서 빠진 창·목표를 정책 기본값으로 채운다. 두 진입점이 이 네 걸음을 각자
/// 적으면 한쪽만 손보는 순간 미리보기와 실제 계획이 다른 값을 보게 된다 — 미리보기는 사용자가
/// 기동 전에 확인하는 화면이라 그 어긋남이 그대로 오해가 된다.
///
/// [`PacingInputs`]는 정책과 워크플로 목록을 빌려 보므로 준비물을 여기서 소유하고,
/// 조회한 상태(계정·반복 요청·채팅)만 [`Self::inputs`]에서 받아 묶는다.
struct PreparedPlan {
    policy: Option<UsageBudgetPolicy>,
    pacing_workflow_ids: BTreeSet<String>,
    request: UsagePacedRunsRequest,
}

impl PreparedPlan {
    fn load(app_data_dir: &Path, request: &UsagePacedRunsRequest) -> Result<Self, CoreError> {
        let policy = usage_budget_policy::load_optional(app_data_dir)?;
        let pacing_workflow_ids =
            crate::remote::pacing_workflow_ids(app_data_dir, policy.as_ref())?;
        let request = fill_from_policy(request, policy.as_ref());
        Ok(Self {
            policy,
            pacing_workflow_ids,
            request,
        })
    }

    fn inputs<'a>(
        &'a self,
        accounts: &'a [ProviderAccountView],
        schedules: &'a [ScheduledRequest],
        chats: &'a [ChatSessionInfo],
    ) -> PacingInputs<'a> {
        PacingInputs {
            now: now_ms(),
            accounts,
            schedules,
            chats,
            policy: self.policy.as_ref(),
            pacing_workflow_ids: Some(&self.pacing_workflow_ids),
        }
    }
}

/// 회차 계획의 공개 진입점. 시스템 작업 디스패처가 조회한 상태를 그대로 받는다. 계획을
/// 예약으로 기록하므로 변경 작업이다 — 기록 없이 보려면 [`preview_usage_paced_runs`].
pub fn plan_usage_paced_runs(
    app_data_dir: &Path,
    request: &UsagePacedRunsRequest,
    accounts: &[ProviderAccountView],
    schedules: &[ScheduledRequest],
    chats: &[ChatSessionInfo],
) -> Result<Value, CoreError> {
    let prepared = PreparedPlan::load(app_data_dir, request)?;
    let inputs = prepared.inputs(accounts, schedules, chats);
    plan_and_record(app_data_dir, &prepared.request, &inputs)
}

/// 회차 계획 미리보기. 계산만 하고 예약을 기록하지 않는다 — 조회가 다른 소비자의 배분과
/// 회당 비용 실측에 흔적을 남기지 않게 한다.
pub fn preview_usage_paced_runs(
    app_data_dir: &Path,
    request: &UsagePacedRunsRequest,
    accounts: &[ProviderAccountView],
    schedules: &[ScheduledRequest],
    chats: &[ChatSessionInfo],
) -> Result<Value, CoreError> {
    let prepared = PreparedPlan::load(app_data_dir, request)?;
    let inputs = prepared.inputs(accounts, schedules, chats);
    let store = load_store(app_data_dir)?;
    let plan = compute_plan(&store, &prepared.request, &inputs)?;
    render_plan(&prepared.request, &plan)
}

/// 최근 예약(소비자 표시가 있는 계획)에 등장한 계정. 정책 파일을 처음 만들 때 계정 풀
/// 시드로 쓴다 — 이미 페이싱이 쓰던 계정을 그대로 켜 회차가 멈추지 않게 한다.
pub(crate) fn recently_claimed_account_ids(app_data_dir: &Path) -> BTreeSet<String> {
    let Ok(store) = load_store(app_data_dir) else {
        return BTreeSet::new();
    };
    store
        .plans
        .iter()
        .filter(|plan| plan.consumer_id.is_some())
        .flat_map(|plan| plan.entries.iter().map(|entry| entry.account_id.clone()))
        .collect()
}

/// 저장된 계획 중 가장 최근 회차 간격. 계획 요청 밖(현황 조회·소진 판정)에서 간격이
/// 필요할 때 쓰고, 기록이 없으면 [`FALLBACK_CADENCE_MS`]다.
fn latest_cadence_ms(store: &PacingStore) -> i64 {
    store
        .plans
        .iter()
        .rev()
        .find_map(|plan| plan.cadence_ms)
        .unwrap_or(FALLBACK_CADENCE_MS)
}

/// 소진 모드가 지금 리셋 크레딧을 쓸 계정. `candidates`는 (계정 id, 계획 창 사용률)이고,
/// 계획 창의 남은 여유가 실측 회당 소비보다 작은 계정만 남는다 — 그 지점이 페이싱이 더
/// 낼 수 없는, 즉 이 계정으로 창을 비울 수 있는 만큼 비운 상태다.
///
/// 사용률 100% 정확히를 기다리지 않는 이유: 기동은 회당 소비만큼 뛰므로 사용률은 보통
/// `100 - 회당 소비`와 100 사이에서 멈춘다. 100을 조건으로 걸면 크레딧을 영원히 쓰지
/// 못한다. 되돌릴 수 있는지의 최종 판정은 공급자가 하고, 아직이면 `nothingToReset`으로
/// 물리며 크레딧은 그대로 남는다.
pub(crate) fn drain_redeem_ready(
    app_data_dir: &Path,
    window_label: &str,
    candidates: &[(String, f64)],
) -> Vec<String> {
    // 표본을 읽지 못하면 회당 소비를 알 수 없다. 같은 저장소를 읽는 계획 계산이 곧 뒤에서
    // 같은 이유로 실패하므로, 여기서 후보를 지레 걸러 내지 않고 공급자 판정에 맡긴다.
    let Ok(store) = load_store(app_data_dir) else {
        return candidates.iter().map(|(id, _)| id.clone()).collect();
    };
    let cadence_ms = latest_cadence_ms(&store);
    candidates
        .iter()
        .filter(|(account_id, used_percent)| {
            let cost = account_cost_per_run(&store, account_id, window_label, None, cadence_ms)
                .unwrap_or(DEFAULT_MIN_COST_PERCENT_PER_RUN)
                .max(DEFAULT_MIN_COST_PERCENT_PER_RUN);
            *used_percent >= DRAIN_TARGET_PERCENT - cost
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// 설정 화면·AIA가 보는 예산 현황. 계정마다 정책 창의 사용률·유효 목표·미정산 예약·순여유와
/// 활성 소비자를, 소비자마다 공급자별 실측 회당 소비를 돌려준다. 상태를 바꾸지 않는다.
/// `paused_consumers`는 반복 요청이 일시정지된 소비자 — 계획 단계와 같은 이유로 활성
/// 집합에서 뺀다(기록이 새로워도 다음 회차를 띄우지 않으므로 몫을 잡지 않는다).
/// 소진 모드로 이 계정의 계획 창을 비우는 데 걸리는 날수. 근거(가드 창 라벨·순여유,
/// 두 창의 실측 회당 소비) 중 하나라도 없으면 `None`이고, 그때 전망은 값을 내지 않는다.
///
/// 계산 자체는 [`drain_outlook`]이 내놓는 여러 값 중 하나뿐인데, 중간 결과를 하나씩 되묻는
/// 탓에 함수 본문이 즉시호출 클로저 한 덩이로 뭉쳐 있었다. "언제까지 시작해야 하는가"를
/// 재는 쪽은 이 날수만 필요로 하므로 이름을 주어 따로 세운다.
fn drain_days_to_empty(
    store: &PacingStore,
    account_id: &str,
    window_label: &str,
    guard: Option<&Value>,
    net_headroom: f64,
    cadence_ms: i64,
) -> Option<f64> {
    let guard = guard?;
    let guard_label = guard.get("label")?.as_str()?;
    let guard_net = guard.get("netHeadroomPercent")?.as_f64()?;
    let guard_length_ms = usage_budget_policy::window_label_length_ms(guard_label)?;
    let positive_cost = |series_label: Option<&str>| {
        account_cost_per_run(store, account_id, window_label, series_label, cadence_ms)
            .filter(|cost| *cost > 0.0)
    };
    let plan_cost = positive_cost(None)?;
    let guard_cost = positive_cost(Some(guard_label))?;
    // 가드 창 하나에 감당할 수 있는 건수 × 회당 계획 창 소비 = 가드 창 하나가 갉는 계획 창.
    let plan_percent_per_guard_window = (guard_net / guard_cost) * plan_cost;
    if plan_percent_per_guard_window <= 0.0 {
        return None;
    }
    let guard_windows_needed = net_headroom / plan_percent_per_guard_window;
    Some(guard_windows_needed * guard_length_ms as f64 / 86_400_000.0)
}

/// 소진 모드 전망. 이 계정의 계획 창을 소진 모드로 비우는 데 걸리는 시간과, 가장 이른
/// 크레딧을 만료 전에 쓰려면 늦어도 언제 시작해야 하는지.
///
/// 소진 모드의 속도는 가드 창이 정한다 — 가드 창 하나마다 그 창의 여유를 회당 소비로 나눈
/// 만큼 돌 수 있고, 그 건수가 계획 창을 갉는다. 두 창의 회당 소비를 모두 실측했을 때만
/// 값을 낸다([`drain_days_to_empty`]). 근거 없는 추정으로 마감을 알리면 사용자가 그 값을
/// 믿고 크레딧을 놓친다.
#[allow(clippy::too_many_arguments)]
fn drain_outlook(
    store: &PacingStore,
    policy: &UsageBudgetPolicy,
    account: &ProviderAccountView,
    window_label: &str,
    guard: Option<&Value>,
    net_headroom: f64,
    cadence_ms: i64,
    now: i64,
) -> Value {
    let credits = account.usage.reset_credits.as_ref();
    // 소진 모드 스위치와 무관하게 "쓸 수 있는 크레딧이 남았는지"만 본다 — 아래 `actNow`는
    // 스위치가 꺼져 있을 때 켜라고 알리는 자리이므로, 여기서 스위치를 함께 보면 그 안내가
    // 영원히 나가지 않는다.
    let spendable =
        credits.is_some_and(|credits| credits.available_count > policy.defaults.drain_reserve());
    let days_to_empty = drain_days_to_empty(
        store,
        &account.id,
        window_label,
        guard,
        net_headroom,
        cadence_ms,
    );
    // 가장 이른 만료에서 소진에 걸리는 시간을 뺀 시각. 이 시각을 넘기면 지금 시작해도
    // 만료 전에 창을 비우지 못해 그 크레딧은 쓸 수 없다.
    let act_by_at = credits
        .and_then(|credits| credits.next_expires_at)
        .zip(days_to_empty)
        .map(|(expires_at, days)| expires_at - (days * 86_400_000.0) as i64);
    json!({
        "spendable": spendable,
        "availableCount": credits.map_or(0, |credits| credits.available_count),
        "reserveCount": policy.defaults.drain_reserve(),
        "nextExpiresAt": credits.and_then(|credits| credits.next_expires_at),
        "daysToEmpty": days_to_empty,
        "actByAt": act_by_at,
        // 지금 소진을 시작해야 만료 전에 쓸 수 있는 시점을 지났는지. 이미 이 크레딧으로 알린
        // 뒤라면 내리지 않는다 — 스냅샷을 30초마다 다시 읽으므로 그러지 않으면 계속 울린다.
        "actNow": act_by_at.is_some_and(|act_by| now >= act_by)
            && spendable
            && credits.and_then(|credits| credits.next_credit_id.as_deref())
                != policy
                    .accounts
                    .get(&account.id)
                    .and_then(|config| config.drain_notice_credit_id.as_deref()),
        // 알림을 기록할 때 쓸 키. 화면이 알린 뒤 이 값으로 확인 처리를 부른다.
        "creditId": credits.and_then(|credits| credits.next_credit_id.clone()),
    })
}

/// 한 축값의 최근 관측 요약. 소비는 가중 평균, 토큰은 중앙값이고 회수는 그 축값이 가진
/// 전체 관측 수다 — 평균에는 최근 몇 회만 쓰지만 몇 번 돌았는지는 다 센다.
struct RecentCost {
    percent_per_run: Option<f64>,
    tokens_per_run: Option<f64>,
    runs: usize,
}

fn recent_cost(runs: &[&RunObservation]) -> RecentCost {
    let recent: Vec<&RunObservation> = runs
        .iter()
        .rev()
        .take(DEFAULT_COST_WINDOWS)
        .copied()
        .collect();
    RecentCost {
        percent_per_run: usage_budget::weighted_mean(
            &recent
                .iter()
                .map(|observation| (observation.cost_percent, observation.weight))
                .collect::<Vec<_>>(),
        )
        .map(|(cost, _)| cost),
        tokens_per_run: usage_budget::median(
            &recent
                .iter()
                .filter_map(|observation| observation.tokens)
                .map(|tokens| tokens as f64)
                .collect::<Vec<_>>(),
        ),
        runs: runs.len(),
    }
}

/// 관측을 축(추론수준·계정) 하나로 갈라 축값별 행을 만든다. 두 축이 "축으로 묶고, 최근
/// 관측만 남기고, 소비는 가중 평균·토큰은 중앙값"을 각자 적고 있어, 한쪽만 고치면 같은
/// 화면의 두 표가 다른 규칙으로 계산된다. 축값 순서는 `BTreeMap`이 정한다.
fn cost_rows_by_axis<'a, K: Ord>(
    observations: &'a [RunObservation],
    axis: impl Fn(&'a RunObservation) -> Option<K>,
    row: impl Fn(K, RecentCost) -> Value,
) -> Vec<Value> {
    let mut grouped: BTreeMap<K, Vec<&'a RunObservation>> = BTreeMap::new();
    for observation in observations {
        let Some(key) = axis(observation) else {
            continue;
        };
        grouped.entry(key).or_default().push(observation);
    }
    grouped
        .into_iter()
        .map(|(key, runs)| row(key, recent_cost(&runs)))
        .collect()
}

/// 소비자(반복 요청) 하나의 회당 소비 집계. 공급자별·계정별·추론수준별 세 표와 절감
/// 보고를 함께 만든다.
fn consumer_cost_summary(
    store: &PacingStore,
    policy: &UsageBudgetPolicy,
    consumer_id: &str,
    window_label: &str,
) -> Result<Value, CoreError> {
    let mut per_provider = serde_json::Map::new();
    // 계정(에이전트)별 회당 소비·토큰. 한 회차가 여러 계정으로 돌았을 때 화면이 따로 보여 준다.
    // 공급자별 값과 같은 관측을 계정으로 갈라 낸다.
    let mut per_account: Vec<Value> = Vec::new();
    // 추론수준별 회당 소비. 계획은 등급을 고르면서 정작 그 등급이 얼마인지는 모른다 —
    // 회당 소비가 등급을 섞은 평균 하나뿐이라, low 기준으로 센 여유로 max를 골라 놓고
    // 서너 배를 쓴다. 등급을 축으로 갈라 두면 무엇을 더 써서 무엇을 얻었는지도 보인다.
    let mut per_effort: Vec<Value> = Vec::new();
    for provider in ProviderId::ALL {
        let observations = consumer_observations(store, consumer_id, provider, window_label);
        per_effort.extend(cost_rows_by_axis(
            &observations,
            |observation| {
                observation
                    .reasoning_effort
                    .as_ref()
                    .map(|effort| effort.as_str())
            },
            |effort, cost| {
                json!({
                    "provider": provider,
                    "reasoningEffort": effort,
                    "percentPerRun": cost.percent_per_run,
                    "tokensPerRun": cost.tokens_per_run,
                    "runs": cost.runs,
                })
            },
        ));
        per_account.extend(cost_rows_by_axis(
            &observations,
            |observation| Some(observation.account_id.as_str()),
            |account_id, cost| {
                json!({
                    "accountId": account_id,
                    "provider": provider,
                    "percentPerRun": cost.percent_per_run,
                    "tokensPerRun": cost.tokens_per_run,
                    "runs": cost.runs,
                })
            },
        ));
        if let Some((cost, weight)) = measure_consumer_cost(
            store,
            consumer_id,
            provider,
            window_label,
            DEFAULT_COST_WINDOWS,
        ) {
            per_provider.insert(
                provider.as_str().to_owned(),
                json!({"percentPerRun": cost, "observationWeight": weight}),
            );
        }
    }
    let config = policy.consumers.get(consumer_id);
    let mut savings = serde_json::Map::new();
    for provider in ProviderId::ALL {
        let report = consumer_savings(
            store,
            consumer_id,
            provider,
            window_label,
            policy.savings.baseline_runs,
            DEFAULT_COST_WINDOWS,
            config.and_then(|config| config.max_tokens_per_run),
            config.and_then(|config| config.max_cost_percent_per_run),
        );
        if report.observations > 0 {
            savings.insert(provider.as_str().to_owned(), serde_json::to_value(report)?);
        }
    }
    let runs = store
        .runs
        .iter()
        .filter(|run| run.consumer_id == consumer_id)
        .count();
    Ok(json!({
        "perProvider": per_provider,
        "perAccount": per_account,
        "perEffort": per_effort,
        "recordedRuns": runs,
        "savings": savings,
    }))
}

pub(crate) fn budget_overview(
    app_data_dir: &Path,
    policy: &UsageBudgetPolicy,
    accounts: &[ProviderAccountView],
    consumer_ids: &[String],
    sharing_consumers: &BTreeSet<String>,
) -> Result<Value, CoreError> {
    let store = load_store(app_data_dir)?;
    let now = now_ms();
    let window_label = resolved_window_label(&store, policy, None);
    let cadence_ms = latest_cadence_ms(&store);
    // 자동 주기·수요 계산과 **같은 집합**이다(`sharing_round_ids`). 기록으로 세던 옛 규칙은
    // 판정 구간이 여기(최근 주기 × 2)와 수요 계산(기준 간격 × 2)에서 달라, 화면이 1명이라
    // 말하는 동안 계산은 2명으로 나누는 일이 있었다.
    let active: Vec<String> = sharing_consumers.iter().cloned().collect();
    let pool = policy.pool();
    let account_rows: Vec<Value> = accounts
        .iter()
        .map(|account| {
            let in_pool = pool
                .as_ref()
                .is_none_or(|pool| pool.contains(account.id.as_str()));
            let window = window_of(&account.usage, &window_label);
            // 소진 중인 계정은 계획과 같은 규칙으로 계획 창·가드 창 모두 100%까지 본다.
            // 여기서 종전 목표를 그대로 보이면 화면의 남은 여유와 아래 소진 전망이 계획이
            // 실제로 쓰는 값과 어긋난다.
            let draining = draining_account(policy, &account.usage);
            // 가드 창(계획 창 밖의 계정 전체 창 + 정책이 이름으로 지정한 창)의 현황. 계획과 같은
            // 규칙으로 미정산 예약을 빼 순여유를 보인다.
            let guard_limit = if draining {
                Some(DRAIN_TARGET_PERCENT)
            } else {
                policy.effective_guard_percent(&account.id, None)
            };
            let guards: Vec<Value> = guard_windows(
                &account.usage,
                &window_label,
                policy.defaults.guard_window_label.as_deref(),
            )
            .into_iter()
            .map(|guard| {
                let claims = claims_for_account(
                    &store,
                    &window_label,
                    &window_label,
                    &guard.label,
                    &account.id,
                    &BTreeSet::new(),
                );
                let open = usage_budget::open_claims(&claims, now, guard);
                let outstanding = usage_budget::outstanding_percent(&open, guard.used_percent);
                json!({
                    "label": guard.label,
                    "usedPercent": guard.used_percent,
                    "resetsAt": guard.resets_at,
                    "guardPercent": guard_limit,
                    "outstandingClaimPercent": outstanding,
                    "netHeadroomPercent": guard_limit
                        .map(|limit| (limit - guard.used_percent - outstanding).max(0.0)),
                })
            })
            .collect();
            let (used, resets_at, outstanding, target, net) = match window {
                Some(window) => {
                    // 현황 조회는 채팅 목록이 없어 진행 중 판정을 하지 않는다(TTL만).
                    let claims = claims_for_account(
                        &store,
                        &window_label,
                        &window_label,
                        &window_label,
                        &account.id,
                        &BTreeSet::new(),
                    );
                    let open = usage_budget::open_claims(&claims, now, window);
                    let outstanding = usage_budget::outstanding_percent(&open, window.used_percent);
                    let target = if draining {
                        DRAIN_TARGET_PERCENT
                    } else {
                        policy.effective_target(
                            &account.id,
                            policy.defaults.target_percent.unwrap_or(100.0),
                        )
                    };
                    let net = (target - window.used_percent - outstanding).max(0.0);
                    (
                        Some(window.used_percent),
                        window.resets_at,
                        outstanding,
                        target,
                        net,
                    )
                }
                None => (None, None, 0.0, 0.0, 0.0),
            };
            let drain = drain_outlook(
                &store,
                policy,
                account,
                &window_label,
                guards.first(),
                net,
                cadence_ms,
                now,
            );
            json!({
                "accountId": account.id,
                "email": account.email,
                "provider": account.provider,
                "inPool": in_pool,
                "usedPercent": used,
                "resetsAt": resets_at,
                "targetPercent": target,
                "outstandingClaimPercent": outstanding,
                "netHeadroomPercent": net,
                "guards": guards,
                "drain": drain,
            })
        })
        .collect();
    let consumer_costs: serde_json::Map<String, Value> = consumer_ids
        .iter()
        .map(|consumer_id| {
            Ok((
                consumer_id.clone(),
                consumer_cost_summary(&store, policy, consumer_id, &window_label)?,
            ))
        })
        .collect::<Result<_, CoreError>>()?;
    Ok(json!({
        "windowLabel": window_label,
        "cadenceMinutes": cadence_ms / 60_000,
        "activeConsumers": active,
        "accounts": account_rows,
        "consumerCosts": consumer_costs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{AccountAuthStatus, AccountUsageWindow};

    #[test]
    fn local_runs_are_one_per_model() {
        let planned = local_planned_runs(&["qwen3.5-gpu".to_owned(), "gpt-oss-cpu-low".to_owned()]);
        assert_eq!(planned.len(), 2);
        assert!(planned.iter().all(|run| run.source == ProviderId::Local));
        let models: Vec<&str> = planned
            .iter()
            .filter_map(|run| run.model.as_deref())
            .collect();
        assert_eq!(models, vec!["qwen3.5-gpu", "gpt-oss-cpu-low"]);
    }

    #[test]
    fn local_runs_fold_a_repeated_model_into_one() {
        // 서빙 서버가 같은 모델 요청을 직렬화한다. 두 건을 세우면 큐만 쌓인다.
        let planned = local_planned_runs(&[
            "qwen3.5-gpu".to_owned(),
            "  qwen3.5-gpu  ".to_owned(),
            "gpt-oss-cpu-low".to_owned(),
        ]);
        assert_eq!(planned.len(), 2);
    }

    #[test]
    fn local_runs_are_empty_without_a_chosen_model() {
        // 고른 모델이 없으면 로컬은 이번 회차에 참여하지 않는다.
        assert!(local_planned_runs(&[]).is_empty());
        assert!(local_planned_runs(&["   ".to_owned()]).is_empty());
    }

    #[test]
    fn local_runs_carry_no_headroom_or_effort() {
        // 창이 없어 여력을 잴 수 없고 사다리가 비어 고를 추론수준도 없다. 빈칸이어야
        // 미리보기가 "0건"과 "잴 수 없음"을 구분한다.
        let planned = local_planned_runs(&["qwen3.5-gpu".to_owned()]);
        let run = &planned[0];
        assert!(run.headroom_runs_per_round.is_none());
        assert!(run.reasoning_effort.is_none());
        assert!(run.reasoning_effort_source.is_none());
        assert_eq!(run.account_id, "local:qwen3.5-gpu");
    }

    #[test]
    fn local_models_accept_a_comma_joined_string() {
        // 워크플로 입력은 문자열 한 칸으로 온다. 배열과 같은 목록으로 읽혀야 한다.
        let request: UsagePacedRunsRequest = serde_json::from_value(
            serde_json::json!({ "projectPath": "F:/tmp", "localModels": "qwen3.5-gpu, gpt-oss-cpu-low" }),
        )
        .expect("request");
        assert_eq!(request.local_models, vec!["qwen3.5-gpu", "gpt-oss-cpu-low"]);
    }

    #[test]
    fn local_models_accept_an_array() {
        let request: UsagePacedRunsRequest = serde_json::from_value(
            serde_json::json!({ "projectPath": "F:/tmp", "localModels": ["qwen3.5-gpu"] }),
        )
        .expect("request");
        assert_eq!(request.local_models, vec!["qwen3.5-gpu"]);
    }

    #[test]
    fn local_has_no_reasoning_ladder() {
        assert!(reasoning_effort_ladder(ProviderId::Local).is_empty());
    }
    use crate::chat::{ChatApprovalMode, ChatMode, ChatPhase, ChatProfile};
    use crate::scheduler::{
        ResumeFailurePolicy, ScheduleFrequency, ScheduleRecurrence, ScheduleSessionStrategy,
        ScheduleWorkflowAction, ScheduledRequestInput,
    };

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn usage(windows: Vec<(&str, f64, Option<i64>)>) -> AccountUsageView {
        AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: windows
                .into_iter()
                .map(|(label, used_percent, resets_at)| AccountUsageWindow {
                    label: label.to_owned(),
                    used_percent,
                    resets_at,
                    ..Default::default()
                })
                .collect(),
            updated_at: Some(NOW),
            error: None,
            retry_at: None,
            rate_limited: false,
            token_refresh_limited: false,
            token_refresh_throttle_streak: 0,
            reset_credits: None,
        }
    }

    fn account(
        id: &str,
        email: &str,
        provider: ProviderId,
        usage: AccountUsageView,
    ) -> ProviderAccountView {
        ProviderAccountView {
            id: id.to_owned(),
            provider,
            display_name: id.to_owned(),
            email: Some(email.to_owned()),
            organization: None,
            provider_account_id: format!("provider-{id}"),
            label: None,
            provider_display_name: id.to_owned(),
            is_active: false,
            disabled: false,
            auto_switch: false,
            auto_switch_priority: None,
            auth_status: AccountAuthStatus::Ready,
            usage,
            note: None,
            credential_isolated: true,
            credential_isolation_note: None,
            credential_expires_at: None,
            runtime_count: 0,
        }
    }

    fn workflow_schedule(
        id: &str,
        workflow_id: &str,
        hours: u32,
        enabled: bool,
    ) -> ScheduledRequest {
        paced_schedule(id, workflow_id, hours, enabled, None)
    }

    /// 병렬 실행 설정(`pacing.maxRuns`)을 가진 페이싱 회차. None이면 설정 없음(= 1건씩).
    fn paced_schedule(
        id: &str,
        workflow_id: &str,
        hours: u32,
        enabled: bool,
        max_runs: Option<u32>,
    ) -> ScheduledRequest {
        ScheduledRequest {
            id: id.to_owned(),
            input: ScheduledRequestInput {
                name: id.to_owned(),
                prompt: String::new(),
                source: ProviderId::Claude,
                account_id: String::new(),
                use_active_account: false,
                cwd: String::new(),
                model: None,
                local_connection_id: None,
                reasoning_effort: None,
                approval_mode: ChatApprovalMode::Never,
                mode: ChatMode::FullAccess,
                recurrence: ScheduleRecurrence {
                    frequency: ScheduleFrequency::Hourly,
                    interval: hours,
                    hour: 0,
                    minute: 0,
                    weekday: 1,
                    cron: None,
                    timezone: "Asia/Seoul".to_owned(),
                },
                session_strategy: ScheduleSessionStrategy::NewChat,
                provider_session_id: None,
                resume_failure_policy: ResumeFailurePolicy::RetryThenNewChat,
                enabled,
                session_reference: None,
                session_reference_replace_manual: false,
                workflow: Some(ScheduleWorkflowAction {
                    workflow_id: workflow_id.to_owned(),
                    approved_version: 1,
                    arguments: json!({}),
                    pacing: max_runs.map(|max_runs| crate::scheduler::SchedulePacing { max_runs }),
                }),
                active_from: None,
                active_until: None,
            },
            created_at: NOW,
            updated_at: NOW,
            next_run_at: NOW + HOUR,
            last_run_at: None,
            manual_run_requested_at: None,
            paused_reason: None,
        }
    }

    /// 페이싱 기능 스위치만 다르게 둔 해석기. 워크플로 레지스트리를 읽지 않도록 대상 id를
    /// 미리 채워, 스위치 판정 자체만 본다.
    fn cadence_with_switch(dir: &Path, pacing_on: bool, seed_ids: bool) -> AutoCadence {
        let auto = AutoCadence {
            app_data_dir: dir.to_path_buf(),
            store: std::cell::OnceCell::new(),
            policy: None,
            base_minutes: 300,
            quiet: None,
            pacing_on,
            pacing_ids: std::cell::OnceCell::new(),
        };
        if seed_ids {
            auto.pacing_ids
                .set(["wf-qa".to_owned()].into_iter().collect())
                .expect("seed pacing ids");
        }
        auto
    }

    #[test]
    fn pacing_switch_off_holds_only_paced_rounds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let auto = cadence_with_switch(dir.path(), false, true);
        // 페이싱 대상 워크플로의 회차만 멈춘다.
        assert!(auto.round_paused(&workflow_schedule("s-qa", "wf-qa", 5, true).input));
        // 페이싱 밖 워크플로와 워크플로가 아닌 일반 반복 요청은 이 스위치와 무관하다.
        assert!(!auto.round_paused(&workflow_schedule("s-etc", "wf-etc", 5, true).input));
        let mut plain = workflow_schedule("s-plain", "wf-qa", 5, true).input;
        plain.workflow = None;
        assert!(!auto.round_paused(&plain));
    }

    /// 켜져 있을 때는 판정에 워크플로 레지스트리를 읽지 않는다. 반복 실행 틱마다 도는
    /// 자리라 평소 경로에 파일 읽기가 늘면 그대로 비용이 된다.
    #[test]
    fn pacing_switch_on_answers_without_reading_the_registry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let auto = cadence_with_switch(dir.path(), true, false);
        assert!(!auto.round_paused(&workflow_schedule("s-qa", "wf-qa", 5, true).input));
        assert!(auto.pacing_ids.get().is_none());
    }

    /// 정리 대상은 **아직 살아 있는데 턴만 끝난** 런타임이다. 이미 Stopped·Failed 인 것을
    /// 다시 집으면 `stop_managed` 가 alreadyStopped 로 되돌릴 뿐 목록에서 빠지지 않아,
    /// 회차마다 같은 죽은 채팅을 다시 멈춘다. 실제로 +5씩 쌓여 269건이 됐고 한 회차의
    /// 단계 277개 중 269개가 그 헛된 stop_chat 이었다(2026-10-02 실측).
    #[test]
    fn stale_cleanup_skips_runtimes_that_are_already_dead() {
        let request = request("7일", 100.0);
        let chats = vec![
            finished_chat("run-idle", "/tmp/project", true, ChatPhase::Ready),
            finished_chat("run-dead", "/tmp/project", true, ChatPhase::Stopped),
            finished_chat("run-failed", "/tmp/project", true, ChatPhase::Failed),
            finished_chat("run-working", "/tmp/project", true, ChatPhase::Running),
        ];
        let picked = super::select_stale_runs(&request, &chats, "s-qa");
        let ids: Vec<&str> = picked.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            ["run-idle"],
            "턴만 끝난 것 하나만 집어야 한다 — 죽은 것은 다시 멈출 것이 없고, 도는 것은 건드리지 않는다"
        );
    }

    fn finished_chat(
        chat_id: &str,
        cwd: &str,
        unattended: bool,
        state: ChatPhase,
    ) -> ChatSessionInfo {
        ChatSessionInfo {
            chat_id: chat_id.to_owned(),
            started_at: NOW - HOUR,
            source: ProviderId::Claude,
            account_id: Some("claude-a".to_owned()),
            resuming: false,
            provider_session_id: Some(format!("session-{chat_id}")),
            cwd: cwd.to_owned(),
            model: None,
            local_connection_id: None,
            reasoning_effort: None,
            mode: ChatMode::FullAccess,
            approval_mode: ChatApprovalMode::Never,
            plan_auto_approval: false,
            state,
            turn_count: 1,
            last_turn_status: Some("completed".to_owned()),
            replay_truncated: false,
            unattended,
            origin: None,
            attached: false,
            interactive_approvals: false,
            profile: ChatProfile::Standard,
            system_tools: false,
            settings: BTreeMap::new(),
            aia_runtime: None,
            context_used_tokens: None,
            context_window_tokens: None,
        }
    }

    fn request(window_label: &str, target: f64) -> UsagePacedRunsRequest {
        UsagePacedRunsRequest {
            cadence_workflow_id: Some("wf-qa".to_owned()),
            cadence_minutes: None,
            email_prefix: Some("tester-".to_owned()),
            providers: None,
            local_models: Vec::new(),
            window_label: window_label.to_owned(),
            target_percent: Some(target),
            guard_window_label: Some("5시간".to_owned()),
            guard_percent: Some(85.0),
            max_runs: Some(6),
            fallback_cost_percent_per_run: Some(2.0),
            cost_windows: None,
            min_cost_percent_per_run: None,
            project_path: "/tmp/project".to_owned(),
            claude_model: Some("claude-opus-5".to_owned()),
            codex_model: None,
            antigravity_model: None,
            stale_run_cwd: None,
            execution_id: None,
            trigger_consumer_id: None,
        }
    }

    fn inputs<'a>(
        accounts: &'a [ProviderAccountView],
        schedules: &'a [ScheduledRequest],
        chats: &'a [ChatSessionInfo],
    ) -> PacingInputs<'a> {
        PacingInputs {
            now: NOW,
            accounts,
            schedules,
            chats,
            policy: None,
            pacing_workflow_ids: None,
        }
    }

    #[test]
    fn cadence_comes_from_the_enabled_schedule_that_runs_this_workflow() {
        let schedules = vec![
            workflow_schedule("s-off", "wf-qa", 1, false),
            workflow_schedule("s-on", "wf-qa", 5, true),
            workflow_schedule("s-other", "wf-other", 2, true),
        ];
        assert_eq!(
            cadence_from_schedules(&schedules, "wf-qa", 300, NOW),
            Some(300)
        );
        assert_eq!(
            cadence_from_schedules(&schedules, "wf-missing", 300, NOW),
            None
        );
    }

    #[test]
    fn weekday_cadence_averages_over_the_whole_week() {
        // 평일 회차를 24시간으로 보면 남은 회차 수를 7/5배로 과대평가한다.
        let recurrence = ScheduleRecurrence {
            frequency: ScheduleFrequency::Weekdays,
            interval: 1,
            hour: 8,
            minute: 0,
            weekday: 1,
            cron: None,
            timezone: "Asia/Seoul".to_owned(),
        };
        assert_eq!(recurrence_minutes(&recurrence, 300, NOW), Some(2016));
    }

    #[test]
    fn cron_cadence_is_measured_from_future_occurrences() {
        let recurrence = ScheduleRecurrence {
            frequency: ScheduleFrequency::Cron,
            interval: 1,
            hour: 0,
            minute: 0,
            weekday: 1,
            cron: Some("*/30 * * * *".to_owned()),
            timezone: "Asia/Seoul".to_owned(),
        };
        assert_eq!(recurrence_minutes(&recurrence, 300, NOW), Some(30));
    }

    #[test]
    fn plan_spreads_the_remaining_headroom_evenly_over_the_remaining_time() {
        // 7일 창이 60%, 목표 92% → 남은 여유 32%p, 회당 2%p → 남은 16건. 리셋까지
        // 50시간이니 건당 187분이고, 5시간 회차 몫은 1.6건(올림 2건)이다. 창이 118시간
        // 지났는데 이 창에서 아직 한 건도 안 돌아 밀린 몫이 11건이므로 회차 상한까지
        // 계정마다 채운다 — 계정당 예산 2건. 다만 두 계정 모두 계획 창 실측이 없으니 첫
        // 측정 1건씩만 기동한다(합 2건).
        let accounts = vec![
            account(
                "claude-a",
                "tester-a@example.com",
                ProviderId::Claude,
                usage(vec![
                    ("7일", 60.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
            account(
                "codex-b",
                "tester-b@example.com",
                ProviderId::Codex,
                usage(vec![
                    ("7일", 60.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
        ];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let store = store_with_guard_measurement();
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.cadence_minutes, 300);
        assert_eq!(plan.cost_source, "fallback");
        assert_eq!(account_view(&plan, "claude-a")["budgetRuns"], 2);
        assert_eq!(account_view(&plan, "codex-b")["budgetRuns"], 2);
        assert_eq!(plan.planned.len(), 2);
        assert_eq!(plan.planned[0].model.as_deref(), Some("claude-opus-5"));
        assert!(plan
            .planned
            .iter()
            .any(|run| run.source == ProviderId::Codex));
    }

    /// 계정이 보고하는 그대로의 Antigravity 사용량: 계정 대표 창(모델군 중 빡빡한 쪽)과
    /// 모델군 창 둘. `combined_usage`가 만드는 모양과 같다.
    fn antigravity_usage(gemini: f64, third_party: (f64, Option<i64>)) -> AccountUsageView {
        let gemini_reset = Some(NOW + 50 * HOUR);
        let tightest = if gemini >= third_party.0 {
            ("7일", gemini, gemini_reset)
        } else {
            ("7일", third_party.0, third_party.1)
        };
        let mut view = usage(vec![
            tightest,
            ("Gemini Models · 7일", gemini, gemini_reset),
            ("Claude and GPT models · 7일", third_party.0, third_party.1),
        ]);
        for window in &mut view.windows {
            window.model_scoped = window.label.contains(" · ");
        }
        view
    }

    fn antigravity_request(model: &str) -> UsagePacedRunsRequest {
        let mut request = request("7일", 92.0);
        request.providers = Some(vec![ProviderId::Antigravity]);
        request.antigravity_model = Some(model.to_owned());
        request
    }

    /// 한 모델군이 다 찬 계정에서도 다른 모델군의 쿼터는 그대로 돈다. 계정 대표 창을 계획
    /// 창으로 쓰던 동안 Claude/GPT 쿼터가 0%인 채 창이 통째로 놀던 자리다.
    #[test]
    fn antigravity_account_paces_the_model_group_window_of_this_round() {
        let accounts = vec![account(
            "antigravity-acd",
            "tester-shinnanae@example.com",
            ProviderId::Antigravity,
            // Gemini는 소진(대표 창도 100%), Claude/GPT는 아직 시작도 안 한 창.
            antigravity_usage(100.0, (0.0, None)),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let inputs = inputs(&accounts, &schedules, &[]);

        let plan = compute_plan(
            &PacingStore::default(),
            &antigravity_request("claude-sonnet-4.6"),
            &inputs,
        )
        .expect("Antigravity plan");
        assert_eq!(plan.planned.len(), 1);
        assert_eq!(plan.planned[0].account_id, "antigravity-acd");
        assert_eq!(plan.planned[0].model.as_deref(), Some("claude-sonnet-4.6"));
        assert_eq!(
            plan.accounts[0]["windowLabel"].as_str(),
            Some("Claude and GPT models · 7일")
        );

        // 같은 계정이라도 Gemini 회차에서는 그 모델군 창이 다 차 쉰다.
        let gemini = compute_plan(
            &PacingStore::default(),
            &antigravity_request("gemini-3.1-pro"),
            &inputs,
        )
        .expect("Antigravity plan");
        assert!(gemini.planned.is_empty());
        assert_eq!(
            gemini.accounts[0]["windowLabel"].as_str(),
            Some("Gemini Models · 7일")
        );
    }

    /// 모델군이 다른 회차가 같은 계정에 남긴 예약은 이 창의 미정산이 아니다. 두 창이 모두
    /// 미시작이면 예약 기준선(0%·리셋 없음)까지 같아 창 판정으로는 갈리지 않는다 — 항목이
    /// 채운 창을 기록해야 한쪽의 첫 기동이 다른 쪽의 첫 기동을 막지 않는다.
    #[test]
    fn a_claim_from_another_model_group_does_not_block_this_group() {
        let accounts = vec![account(
            "antigravity-acd",
            "tester-shinnanae@example.com",
            ProviderId::Antigravity,
            // 두 모델군 모두 아직 시작되지 않은 창.
            antigravity_usage(0.0, (0.0, None)),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        // 다른 소비자가 Gemini 창에 첫 기동을 예약해 둔 상태.
        let mut store = PacingStore::default();
        store.plans.push(PlanRecord {
            at: NOW - 60_000,
            window_label: "7일".to_owned(),
            entries: vec![PlanRecordEntry {
                window_label: Some("Gemini Models · 7일".to_owned()),
                account_id: "antigravity-acd".to_owned(),
                count: 1,
                expected_cost_percent: Some(2.0),
                used_percent_at_claim: Some(0.0),
                resets_at_at_claim: None,
                guards: BTreeMap::new(),
            }],
            consumer_id: Some("s-other".to_owned()),
            workflow_id: Some("wf-other".to_owned()),
            cadence_ms: Some(5 * HOUR),
            cwd: None,
            max_runs: Some(1),
            execution_id: None,
        });

        let plan = compute_plan(
            &store,
            &antigravity_request("claude-sonnet-4.6"),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("Antigravity plan");
        assert_eq!(plan.planned.len(), 1);
        assert_eq!(
            plan.accounts[0]["outstandingClaimPercent"].as_f64(),
            Some(0.0)
        );

        // 같은 모델군의 예약이면 그대로 막는다 — 첫 기동이 둘이 되면 안 된다.
        let mut same_group = store.clone();
        same_group.plans[0].entries[0].window_label =
            Some("Claude and GPT models · 7일".to_owned());
        let blocked = compute_plan(
            &same_group,
            &antigravity_request("claude-sonnet-4.6"),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("Antigravity plan");
        assert!(blocked.planned.is_empty());
        assert_eq!(
            blocked.accounts[0]["skipReason"].as_str(),
            Some("창 미시작 — 이미 첫 기동이 예약됨")
        );
    }

    /// 계정 하나가 모델군 두 개의 쿼터를 따로 들고 있으므로, 진행 중 실행의 점유도 그 실행이
    /// 채우는 창에만 걸린다. 점유를 계정 단위로 보던 동안 Gemini 회차가 5분 간격으로 계정을
    /// 채워, 같은 계정의 Claude/GPT 창은 여유가 100%인 채 첫 기동을 한 번도 받지 못했다.
    #[test]
    fn a_run_of_another_model_group_does_not_occupy_this_group() {
        let mut view = usage(vec![
            ("7일", 60.0, Some(NOW + 50 * HOUR)),
            ("5시간", 50.0, Some(NOW + HOUR)),
            ("Gemini Models · 7일", 60.0, Some(NOW + 50 * HOUR)),
            ("Gemini Models · 5시간", 50.0, Some(NOW + HOUR)),
            ("Claude and GPT models · 7일", 0.0, None),
            ("Claude and GPT models · 5시간", 0.0, None),
        ]);
        for window in &mut view.windows {
            window.model_scoped = window.label.contains(" · ");
        }
        let accounts = vec![account(
            "antigravity-acd",
            "tester-freshin@example.com",
            ProviderId::Antigravity,
            view,
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let request = antigravity_request("claude-opus-4-6-thinking");

        let mut other_group = PacingStore::default();
        other_group.runs.push(antigravity_run_record(
            "run-gemini",
            "s-other",
            "antigravity-acd",
            "gemini-3.8-flash-high",
            NOW - 60_000,
            None,
        ));
        let gemini_running = finished_chat("run-gemini", "/tmp/project", true, ChatPhase::Running);
        let plan = compute_plan(
            &other_group,
            &request,
            &inputs(&accounts, &schedules, std::slice::from_ref(&gemini_running)),
        )
        .expect("Antigravity plan");
        assert_eq!(plan.planned.len(), 1, "{:?}", plan.accounts);
        assert_eq!(
            plan.accounts[0]["windowLabel"].as_str(),
            Some("Claude and GPT models · 7일")
        );

        // 같은 모델군의 실행이면 종전대로 막는다 — 회당 소비를 모르는 창에 겹쳐 띄우지 않는다.
        let mut same_group = PacingStore::default();
        same_group.runs.push(antigravity_run_record(
            "run-claude",
            "s-other",
            "antigravity-acd",
            "claude-opus-4-6-thinking",
            NOW - 60_000,
            None,
        ));
        let claude_running = finished_chat("run-claude", "/tmp/project", true, ChatPhase::Running);
        let blocked = compute_plan(
            &same_group,
            &request,
            &inputs(&accounts, &schedules, std::slice::from_ref(&claude_running)),
        )
        .expect("Antigravity plan");
        assert!(blocked.planned.is_empty(), "{:?}", blocked.planned);

        // 모델을 남기지 않은 옛 기록은 종전처럼 계정의 모든 창을 점유한 것으로 본다.
        let mut legacy = PacingStore::default();
        legacy.runs.push(RunRecord {
            provider: ProviderId::Antigravity,
            ..run_record(
                "run-legacy",
                "s-other",
                None,
                "antigravity-acd",
                NOW - 60_000,
                None,
            )
        });
        let legacy_running = finished_chat("run-legacy", "/tmp/project", true, ChatPhase::Running);
        let legacy_plan = compute_plan(
            &legacy,
            &request,
            &inputs(&accounts, &schedules, std::slice::from_ref(&legacy_running)),
        )
        .expect("Antigravity plan");
        assert!(legacy_plan.planned.is_empty(), "{:?}", legacy_plan.planned);
    }

    /// 이메일 접두사는 Antigravity 등록 계정에도 걸린다. 이메일이 없는 모델군 자원 행만
    /// 면제된다.
    #[test]
    fn the_email_prefix_narrows_antigravity_accounts_too() {
        let accounts = vec![account(
            "antigravity-acd",
            "other@example.com",
            ProviderId::Antigravity,
            antigravity_usage(10.0, (10.0, Some(NOW + 50 * HOUR))),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        assert!(compute_plan(
            &PacingStore::default(),
            &antigravity_request("claude-sonnet-4.6"),
            &inputs(&accounts, &schedules, &[]),
        )
        .is_err());
    }

    /// 모델을 선언하지 않은 회차는 이 공급자를 아예 보지 않는다.
    #[test]
    fn antigravity_stays_out_of_rounds_that_declare_no_model() {
        let accounts = vec![account(
            "antigravity-acd",
            "tester-shinnanae@example.com",
            ProviderId::Antigravity,
            antigravity_usage(10.0, (10.0, Some(NOW + 50 * HOUR))),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut request = request("7일", 92.0);
        request.providers = Some(vec![ProviderId::Antigravity]);

        assert!(compute_plan(
            &PacingStore::default(),
            &request,
            &inputs(&accounts, &schedules, &[]),
        )
        .is_err());
    }

    /// 화면이 만든 계약은 모델 칸을 비워도 `Some("")`을 싣는다. 그것을 "선언함"으로 읽으면
    /// 분류기가 빈 이름을 가르려다 실패하고 **계획 전체가 죽는다** — Antigravity 계정이
    /// 풀에 있는 모든 회차가 그렇게 멈췄다(2026-09-25, 회차가 스무 번 넘게 같은 자리에서
    /// 떨어졌다). 빈 값은 선언하지 않은 것과 같아야 하고, 그때 이 공급자만 빠진다.
    #[test]
    fn a_blank_antigravity_model_reads_as_no_model_instead_of_killing_the_plan() {
        let accounts = vec![
            account(
                "claude-acd",
                "tester-shinnanae@example.com",
                ProviderId::Claude,
                usage(vec![("7일", 10.0, Some(NOW + 50 * HOUR))]),
            ),
            account(
                "antigravity-acd",
                "tester-shinnanae@example.com",
                ProviderId::Antigravity,
                antigravity_usage(10.0, (10.0, Some(NOW + 50 * HOUR))),
            ),
        ];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let inputs = inputs(&accounts, &schedules, &[]);

        let mut request = request("7일", 92.0);
        request.antigravity_model = Some(String::new());
        let plan = compute_plan(&PacingStore::default(), &request, &inputs)
            .expect("빈 모델은 계획을 죽이지 않는다");

        // Antigravity 만 빠지고 나머지는 그대로 돈다.
        assert!(!plan.planned.is_empty());
        assert!(plan
            .planned
            .iter()
            .all(|run| run.account_id != "antigravity-acd"));

        // 공백만 있는 값도 같다.
        let mut spaces = request.clone();
        spaces.antigravity_model = Some("   ".to_owned());
        compute_plan(&PacingStore::default(), &spaces, &inputs)
            .expect("공백뿐인 모델도 선언하지 않은 것이다");
    }

    /// 계정을 아직 등록하지 않은 설치에만 남는 모델군 자원 행은 이번 모델군 하나로 좁힌다.
    #[test]
    fn antigravity_model_uses_only_its_virtual_usage_resource() {
        let accounts = vec![
            account(
                crate::antigravity_usage::ANTIGRAVITY_GEMINI_RESOURCE_ID,
                "tester-antigravity",
                ProviderId::Antigravity,
                usage(vec![
                    ("7일", 20.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
            account(
                crate::antigravity_usage::ANTIGRAVITY_THIRD_PARTY_RESOURCE_ID,
                "tester-antigravity",
                ProviderId::Antigravity,
                usage(vec![
                    ("7일", 10.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 5.0, Some(NOW + HOUR)),
                ]),
            ),
        ];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut request = request("7일", 92.0);
        request.providers = Some(vec![ProviderId::Antigravity]);
        request.antigravity_model = Some("gemini-3.1-pro".to_owned());
        request.email_prefix = Some("tester@company.test".to_owned());

        let plan = compute_plan(
            &PacingStore::default(),
            &request,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("Antigravity plan");

        assert!(!plan.planned.is_empty());
        assert!(plan.planned.iter().all(|run| {
            run.account_id == crate::antigravity_usage::ANTIGRAVITY_GEMINI_RESOURCE_ID
                && run.source == ProviderId::Antigravity
                && run.model.as_deref() == Some("gemini-3.1-pro")
        }));
    }

    /// 회당 2.5%p가 실측된 상태의 저장소. 부트스트랩 예외가 꺼진 조건을 만든다.
    /// 계정 하나에 `count`건을 돌린 회차 하나와 그 사이 `count × cost`%p가 오른 표본.
    /// 회당 소비는 `cost`%p로 실측되고, 그 회차는 창 안의 기동 이력이 된다.
    fn store_with_cost(account_id: &str, cost: f64, count: usize, at: i64) -> PacingStore {
        let mut store = PacingStore::default();
        store.plans.push(PlanRecord {
            execution_id: None,
            consumer_id: Some("s-on".to_owned()),
            workflow_id: Some("wf-qa".to_owned()),
            cadence_ms: Some(5 * HOUR),
            cwd: None,
            max_runs: Some(6),
            at,
            window_label: "7일".to_owned(),
            entries: vec![plan_entry(account_id, count)],
        });
        store.series.insert(
            series_key(account_id, "7일"),
            vec![
                UsageSample {
                    at: at - HOUR,
                    used_percent: 5.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                UsageSample {
                    at: at + HOUR,
                    used_percent: 5.0 + cost * count as f64,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
        // 같은 회차가 5시간 창을 회당 0.5%p 썼다는 표본. 가드 창 회당 소비가 실측되지 않으면
        // 계정당 1건으로 묶여 계획 창 산술을 보는 시험이 흐려진다.
        with_guard_series(&mut store, account_id, at, 5.0, 5.0 + 0.5 * count as f64);
        store
    }

    /// `account_id`의 5시간 창 표본을 `at` 앞뒤로 남겨 가드 창 회당 소비를 실측할 수 있게 한다.
    fn with_guard_series(
        store: &mut PacingStore,
        account_id: &str,
        at: i64,
        before: f64,
        after: f64,
    ) {
        store.series.insert(
            series_key(account_id, "5시간"),
            vec![
                UsageSample {
                    at: at - HOUR,
                    used_percent: before,
                    resets_at: Some(NOW + HOUR),
                },
                UsageSample {
                    at: at + HOUR,
                    used_percent: after,
                    resets_at: Some(NOW + HOUR),
                },
            ],
        );
    }

    /// 계획 창은 실측이 없고(대체값) 가드 창만 회당 1%p로 실측되는 저장소. 첫 회차의 계획
    /// 창 산술을 보는 시험이 가드 미측정 규칙(계정당 1건)에 묶이지 않게 한다.
    fn store_with_guard_measurement() -> PacingStore {
        let mut store = PacingStore::default();
        store.plans.push(measured_plan(
            NOW - 5 * HOUR,
            ["claude-a", "claude-b", "codex-b"]
                .into_iter()
                .map(|account_id| plan_entry(account_id, 2))
                .collect(),
        ));
        for account_id in ["claude-a", "claude-b", "codex-b"] {
            with_guard_series(&mut store, account_id, NOW - 5 * HOUR, 10.0, 12.0);
        }
        store
    }

    /// 가드 창에 더해 계획 창(7일)의 회당 소비도 실측된 저장소. 실측값은 대체값과 같은
    /// 2.0%p라 예산 산술은 `store_with_guard_measurement`와 같고, 첫 측정 1건 제한만
    /// 풀린다([`limit_account_runs`]). 여러 건 배정을 전제로 예약·상한·정산을 보는 시험이
    /// 쓴다.
    fn store_with_plan_measurement() -> PacingStore {
        let mut store = store_with_guard_measurement();
        for account_id in ["claude-a", "claude-b", "codex-b"] {
            // 2건에 4%p → 회당 2.0%p.
            store.series.insert(
                series_key(account_id, "7일"),
                vec![
                    UsageSample {
                        at: NOW - 6 * HOUR,
                        used_percent: 36.0,
                        resets_at: Some(NOW + 50 * HOUR),
                    },
                    UsageSample {
                        at: NOW - HOUR,
                        used_percent: 40.0,
                        resets_at: Some(NOW + 50 * HOUR),
                    },
                ],
            );
        }
        store
    }

    /// 예약 값이 없는 계획 기록 항목. 회당 소비 실측만 보는 시험은 예약 세 칸과 가드
    /// 칸, 항목 창 라벨을 늘 비워 두는데 그 여섯 줄이 열세 자리에 그대로 적혀 있었다 —
    /// 칸이 하나 늘 때마다 같은 곳을 열세 번 고쳐야 했다.
    fn plan_entry(account_id: &str, count: usize) -> PlanRecordEntry {
        PlanRecordEntry {
            account_id: account_id.to_owned(),
            count,
            window_label: None,
            expected_cost_percent: None,
            used_percent_at_claim: None,
            resets_at_at_claim: None,
            guards: BTreeMap::new(),
        }
    }

    /// 소비자를 알 수 없는 7일 창 계획 기록. 측정에만 쓰이고 예약·배분에는 들어가지 않는
    /// 모양이라 소비자·워크플로·간격·상한·실행 칸이 모두 비어 있다. 회당 소비 실측을 보는
    /// 시험 여덟 자리가 그 다섯 칸을 각자 적고 있었다.
    fn measured_plan(at: i64, entries: Vec<PlanRecordEntry>) -> PlanRecord {
        PlanRecord {
            at,
            window_label: "7일".to_owned(),
            entries,
            consumer_id: None,
            workflow_id: None,
            cadence_ms: None,
            cwd: None,
            max_runs: None,
            execution_id: None,
        }
    }

    /// 실행 여부를 확인할 수 없는 계획 기록. 균등 판정은 이 건수를 완료 실행으로 세지
    /// 않아야 한다.
    fn history_record(at: i64, entries: &[(&str, usize)]) -> PlanRecord {
        PlanRecord {
            execution_id: None,
            consumer_id: Some("s-on".to_owned()),
            workflow_id: Some("wf-qa".to_owned()),
            cadence_ms: Some(5 * HOUR),
            cwd: None,
            max_runs: Some(6),
            at,
            window_label: "7일".to_owned(),
            entries: entries
                .iter()
                .map(|(account_id, count)| plan_entry(account_id, *count))
                .collect(),
        }
    }

    fn store_with_measurement() -> PacingStore {
        let mut store = PacingStore::default();
        store.plans.push(measured_plan(
            NOW - 5 * HOUR,
            vec![plan_entry("claude-a", 2)],
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![
                UsageSample {
                    at: NOW - 6 * HOUR,
                    used_percent: 40.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                UsageSample {
                    at: NOW - HOUR,
                    used_percent: 45.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
        // 같은 회차가 5시간 창을 회당 1%p 썼다는 표본(가드 창 회당 소비 실측).
        with_guard_series(&mut store, "claude-a", NOW - 5 * HOUR, 10.0, 12.0);
        store
    }

    /// 회당 소비 2.5%p를 실측할 수 있는 저장소. `max_runs`가 계획에 기록돼 있어 적응형
    /// 자동 주기가 회차 용량을 알 수 있다.
    fn store_for_adaptive(max_runs: usize, used_percent: f64) -> PacingStore {
        let mut store = PacingStore::default();
        store.plans.push(PlanRecord {
            execution_id: None,
            consumer_id: Some("s-refactor".to_owned()),
            workflow_id: Some("wf-refactor".to_owned()),
            cadence_ms: Some(5 * HOUR),
            cwd: None,
            max_runs: Some(max_runs),
            at: NOW - 5 * HOUR,
            window_label: "7일".to_owned(),
            entries: vec![plan_entry("claude-a", 2)],
        });
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![
                UsageSample {
                    at: NOW - 6 * HOUR,
                    used_percent: 40.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                // 2건에 5%p → 회당 2.5%p.
                UsageSample {
                    at: NOW - HOUR,
                    used_percent: 45.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                UsageSample {
                    at: NOW,
                    used_percent,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
        store
    }

    fn adaptive_policy() -> UsageBudgetPolicy {
        let mut policy = UsageBudgetPolicy::default();
        policy.defaults.window_label = Some("7일".to_owned());
        policy.defaults.target_percent = Some(92.0);
        policy.defaults.guard_window_label = Some("5시간".to_owned());
        policy
    }

    fn quiet_hours(start: &str, end: &str) -> crate::usage_budget_policy::QuietHours {
        crate::usage_budget_policy::QuietHours {
            enabled: true,
            start: start.to_owned(),
            end: end.to_owned(),
            timezone: "Asia/Seoul".to_owned(),
            weekdays: (0..7).collect(),
        }
    }

    /// `NOW`는 서울 2027-01-15(금) 17:00, 7일 창 리셋(NOW+50h)은 일요일 19:00이다. 매일 00:00~12:00
    /// 제한이면 리셋까지 열린 시간은 금 17~24(7h) + 토 12~24(12h) + 일 12~19(7h) = 26시간.
    #[test]
    fn adaptive_cadence_counts_only_open_minutes_until_reset() {
        let store = store_for_adaptive(1, 45.0);
        let policy = adaptive_policy();
        let quiet = QuietSchedule::parse(&quiet_hours("00:00", "12:00"))
            .unwrap()
            .unwrap();
        let open =
            adaptive_cadence_minutes(&store, Some(&policy), "wf-refactor", 300, NOW, 1, None);
        let restricted = adaptive_cadence_minutes(
            &store,
            Some(&policy),
            "wf-refactor",
            300,
            NOW,
            1,
            Some(&quiet),
        );
        assert_eq!(open, 159);
        // 남은 18.8건을 50시간이 아니라 열린 26시간(1560분)에 펴면 82분마다 한 건.
        assert_eq!(restricted, 82);
    }

    fn even_line_accounts(used: f64) -> Vec<ProviderAccountView> {
        [
            ("claude-a", "tester-a@example.com", ProviderId::Claude),
            ("codex-b", "tester-b@example.com", ProviderId::Codex),
        ]
        .into_iter()
        .map(|(id, email, provider)| {
            account(
                id,
                email,
                provider,
                usage(vec![
                    ("7일", used, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + 100 * HOUR)),
                ]),
            )
        })
        .collect()
    }

    fn quiet_pool_policy(start: &str, end: &str) -> UsageBudgetPolicy {
        let mut policy = pool_policy(&["claude-a", "codex-b"]);
        policy.defaults.quiet_hours = Some(quiet_hours(start, end));
        policy
    }

    #[test]
    fn quiet_hours_spread_the_target_over_open_minutes_only() {
        // 균등 직선 시나리오(창 118시간 경과, 60%, 목표 92%, 회당 2%p)에서 매일 00~12시를 막으면
        // 창 시작(일 19:00)부터 지금까지 열린 시간은 58시간, 리셋까지는 26시간이다. 직선은 84시간
        // 위에 펴지고 다음 회차까지의 몫은 (58+5)/84 × 92 − 60 = 9%p → 4.5건으로, 벽시계 기준
        // (118+5)/168 × 92 − 60 = 7.4%p → 3.7건보다 크다.
        let accounts = even_line_accounts(60.0);
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let store = PacingStore::default();
        let open_policy = pool_policy(&["claude-a", "codex-b"]);
        let open = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &open_policy),
        )
        .expect("plan");
        let quiet_policy = quiet_pool_policy("00:00", "12:00");
        let quiet = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &quiet_policy),
        )
        .expect("plan");
        let open_view = account_view(&open, "claude-a");
        let quiet_view = account_view(&quiet, "claude-a");
        assert!(open_view["openRemainingMinutes"].is_null());
        assert_eq!(quiet_view["openRemainingMinutes"], json!(26.0 * 60.0));
        assert_eq!(open_view["remainingRuns"], json!(10));
        assert_eq!(quiet_view["remainingRuns"], json!(5));
        let open_due = open_view["dueRuns"].as_f64().expect("due");
        let quiet_due = quiet_view["dueRuns"].as_f64().expect("due");
        assert!((open_due - 3.68).abs() < 0.05, "{open_due}");
        assert!((quiet_due - 4.5).abs() < 0.05, "{quiet_due}");
        assert!(quiet
            .reasoning
            .iter()
            .any(|line| line.contains("페이싱 스케줄(매일 00:00~12:00 제한(Asia/Seoul))")));
    }

    #[test]
    fn resuming_after_quiet_hours_does_not_burst() {
        // 토 00:00(제한 시작)과 토 12:00(재개) 사이에는 열린 시간이 없다. 사용률이 그대로면 두
        // 시점의 몫이 같아야 한다 — 제한 동안 경과가 멈추므로 재개 직후에 밀린 건수가 생기지 않는다.
        let accounts = even_line_accounts(60.0);
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let store = PacingStore::default();
        let policy = quiet_pool_policy("00:00", "12:00");
        let at = |now: i64| PacingInputs {
            now,
            accounts: &accounts,
            schedules: &schedules,
            chats: &[],
            policy: Some(&policy),
            pacing_workflow_ids: None,
        };
        let block_start =
            compute_plan(&store, &request("7일", 92.0), &at(NOW + 7 * HOUR)).expect("plan");
        let resume =
            compute_plan(&store, &request("7일", 92.0), &at(NOW + 19 * HOUR)).expect("plan");
        let before = account_view(&block_start, "claude-a");
        let after = account_view(&resume, "claude-a");
        assert_eq!(before["dueRuns"], after["dueRuns"]);
        assert_eq!(before["budgetRuns"], after["budgetRuns"]);
        assert_eq!(before["openRemainingMinutes"], json!(19.0 * 60.0));
        assert_eq!(after["openRemainingMinutes"], json!(19.0 * 60.0));
        assert!(after["budgetRuns"].as_u64().expect("budget") >= 1);
    }

    /// 소진 모드 시험용 계정. 균등 직선 시나리오에 리셋 크레딧만 얹는다.
    fn drain_accounts(used: f64, credits: u32) -> Vec<ProviderAccountView> {
        even_line_accounts(used)
            .into_iter()
            .map(|mut account| {
                account.usage.reset_credits = Some(crate::accounts::AccountResetCredits {
                    available_count: credits,
                    next_expires_at: None,
                    next_credit_id: None,
                    title: None,
                });
                account
            })
            .collect()
    }

    fn drain_policy(drain: bool, reserve: Option<u32>) -> UsageBudgetPolicy {
        let mut policy = pool_policy(&["claude-a", "codex-b"]);
        policy.defaults.drain = drain;
        policy.defaults.drain_reserve_credits = reserve;
        policy
    }

    #[test]
    /// 소진 모드는 회차 몫(burst)과 직선까지 밀린 건수를 걷어내고, 목표까지 감당할 수 있는
    /// 건수를 그대로 낸다. 창을 빨리 비우는 것이 목적이라 직선을 지킬 이유가 없다.
    fn drain_mode_spends_beyond_the_even_line_share() {
        let accounts = drain_accounts(60.0, 3);
        // 병렬 실행을 켠 회차. 기본 헬퍼는 1건씩이라 소진 모드든 아니든 상한에 먼저 걸린다.
        let schedules = vec![paced_schedule("s-on", "wf-qa", 5, true, Some(10))];
        // 가드 창 회당 소비가 미실측이면 가드가 1건으로 자르는 게 맞아 소진 모드 차이가
        // 드러나지 않는다. 실측을 심어 가드가 병목이 아닌 상태에서 계산을 본다.
        let store = store_with_guard_measurement();
        let at = |policy: &UsageBudgetPolicy| {
            compute_plan(
                &store,
                &request("7일", 92.0),
                &PacingInputs {
                    now: NOW,
                    accounts: &accounts,
                    schedules: &schedules,
                    chats: &[],
                    policy: Some(policy),
                    pacing_workflow_ids: None,
                },
            )
            .expect("plan")
        };

        let even = at(&drain_policy(false, None));
        let drained = at(&drain_policy(true, None));

        let even_runs = account_view(&even, "claude-a")["budgetRuns"]
            .as_u64()
            .expect("budget");
        let drain_runs = account_view(&drained, "claude-a")["budgetRuns"]
            .as_u64()
            .expect("budget");
        assert!(
            drain_runs > even_runs,
            "소진 모드가 균등 몫({even_runs})보다 많이 내야 한다: {drain_runs}"
        );
    }

    #[test]
    /// 크레딧이 없으면 소진하지 않는다. 되돌릴 수단 없이 주간 한도만 일찍 태우면 남은 기간
    /// 내내 그 계정이 멈춰 균등 페이싱보다 나쁘다.
    fn drain_mode_skips_accounts_without_reset_credits() {
        let schedules = vec![paced_schedule("s-on", "wf-qa", 5, true, Some(10))];
        // 가드 창 회당 소비가 미실측이면 가드가 1건으로 자르는 게 맞아 소진 모드 차이가
        // 드러나지 않는다. 실측을 심어 가드가 병목이 아닌 상태에서 계산을 본다.
        let store = store_with_guard_measurement();
        let policy = drain_policy(true, None);
        let plan = |accounts: &[ProviderAccountView]| {
            compute_plan(
                &store,
                &request("7일", 92.0),
                &PacingInputs {
                    now: NOW,
                    accounts,
                    schedules: &schedules,
                    chats: &[],
                    policy: Some(&policy),
                    pacing_workflow_ids: None,
                },
            )
            .expect("plan")
        };

        let with_credit = plan(&drain_accounts(60.0, 1));
        let without = plan(&drain_accounts(60.0, 0));

        assert!(
            account_view(&with_credit, "claude-a")["budgetRuns"].as_u64()
                > account_view(&without, "claude-a")["budgetRuns"].as_u64(),
            "크레딧 없는 계정은 균등 몫 그대로여야 한다"
        );
    }

    #[test]
    /// 예비 장수까지는 자동으로 쓰지 않는다. 남은 장수가 거기에 닿으면 되돌릴 수단이 없는
    /// 것과 같으므로 소진 대상에서도 빠진다.
    fn drain_mode_keeps_the_reserved_credits() {
        let accounts = drain_accounts(60.0, 2);
        let schedules = vec![paced_schedule("s-on", "wf-qa", 5, true, Some(10))];
        // 가드 창 회당 소비가 미실측이면 가드가 1건으로 자르는 게 맞아 소진 모드 차이가
        // 드러나지 않는다. 실측을 심어 가드가 병목이 아닌 상태에서 계산을 본다.
        let store = store_with_guard_measurement();
        let plan = |policy: &UsageBudgetPolicy| {
            compute_plan(
                &store,
                &request("7일", 92.0),
                &PacingInputs {
                    now: NOW,
                    accounts: &accounts,
                    schedules: &schedules,
                    chats: &[],
                    policy: Some(policy),
                    pacing_workflow_ids: None,
                },
            )
            .expect("plan")
        };

        // 2장 보유: 예비 1장이면 아직 쓸 몫이 남아 소진하고, 예비 2장이면 손대지 않는다.
        let spends = plan(&drain_policy(true, Some(1)));
        let holds = plan(&drain_policy(true, Some(2)));
        let even = plan(&drain_policy(false, None));

        assert!(
            account_view(&spends, "claude-a")["budgetRuns"].as_u64()
                > account_view(&even, "claude-a")["budgetRuns"].as_u64()
        );
        assert_eq!(
            account_view(&holds, "claude-a")["budgetRuns"],
            account_view(&even, "claude-a")["budgetRuns"],
            "예비 장수에 닿으면 균등 페이싱 그대로여야 한다"
        );
    }

    /// 목표·가드를 낮게 박은 소진 정책. 소진 중인 계정은 이 두 값을 따르지 않아야 한다.
    /// 스프린트 소비자 하나가 등록된 정책. 소진 모드처럼 정책 목표 70%·가드 50%를 캡으로 둔다.
    fn sprint_policy(sprint: bool) -> UsageBudgetPolicy {
        let mut policy = capped_drain_policy(false, None);
        let mut config = consumer_config(true, 50);
        config.sprint = sprint;
        policy.consumers.insert("s-on".to_owned(), config);
        policy
    }

    #[test]
    /// 스프린트 회차의 계정은 계획 창 목표를 100%로 보고 직선 몫 대신 감당 건수를 전부 내되,
    /// 가드 창 상한은 종전 정책값을 지킨다. 리셋 크레딧이 없어도 걸린다(소진 모드와 다른 점).
    fn sprint_consumer_spends_beyond_the_even_line_but_keeps_the_guard() {
        let accounts = drain_accounts(60.0, 0);
        let schedules = vec![paced_schedule("s-on", "wf-qa", 5, true, Some(10))];
        let store = store_with_guard_measurement();
        let plan = |policy: &UsageBudgetPolicy| {
            compute_plan(
                &store,
                &request("7일", 92.0),
                &PacingInputs {
                    now: NOW,
                    accounts: &accounts,
                    schedules: &schedules,
                    chats: &[],
                    policy: Some(policy),
                    pacing_workflow_ids: None,
                },
            )
            .expect("plan")
        };
        let even = plan(&sprint_policy(false));
        let sprint = plan(&sprint_policy(true));
        let even_view = account_view(&even, "claude-a");
        let sprint_view = account_view(&sprint, "claude-a");
        assert_eq!(even_view["targetPercent"], json!(70.0));
        assert_eq!(sprint_view["targetPercent"], json!(100.0));
        // 가드는 소진 모드와 달리 정책값 그대로.
        assert_eq!(even_view["guardPercent"], json!(50.0));
        assert_eq!(sprint_view["guardPercent"], json!(50.0));
        assert!(
            sprint_view["netHeadroomPercent"].as_f64() > even_view["netHeadroomPercent"].as_f64(),
            "스프린트 계정의 순여유가 목표에 묶여선 안 된다: {sprint_view:?}"
        );
        assert!(
            sprint_view["budgetRuns"].as_u64() > even_view["budgetRuns"].as_u64(),
            "스프린트 계정이 목표 70%·직선 몫에서 멈춰선 안 된다: {sprint_view:?}"
        );
        assert!(
            sprint
                .reasoning
                .iter()
                .any(|line| line.contains("스프린트 회차")),
            "계획 근거에 스프린트가 드러나야 한다: {:?}",
            sprint.reasoning
        );
    }

    #[test]
    /// 스프린트 회차의 자동 주기는 균등 소비 속도를 재지 않고 하한으로 곧장 내려간다.
    fn sprint_round_uses_the_auto_cadence_floor() {
        let dir = tempfile::tempdir().expect("tempdir");
        let auto = |sprint: bool| {
            let mut policy = sprint_policy(sprint);
            policy.defaults.target_percent = Some(92.0);
            let auto = AutoCadence {
                app_data_dir: dir.path().to_path_buf(),
                store: std::cell::OnceCell::new(),
                policy: Some(policy),
                base_minutes: 300,
                quiet: None,
                pacing_on: true,
                pacing_ids: std::cell::OnceCell::new(),
            };
            auto.pacing_ids
                .set(["wf-qa".to_owned()].into_iter().collect())
                .expect("seed pacing ids");
            auto
        };
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        // 표본이 없으면 균등 페이싱은 기준 간격에 머문다.
        assert_eq!(
            auto(false).minutes_for(Some("wf-qa"), &schedules, None, NOW),
            300
        );
        assert_eq!(
            auto(true).minutes_for(Some("wf-qa"), &schedules, None, NOW),
            MIN_AUTO_CADENCE_MINUTES
        );
        // 페이싱 밖 워크플로는 스프린트와 무관하다.
        assert_eq!(
            auto(true).minutes_for(Some("wf-etc"), &schedules, None, NOW),
            300
        );
    }

    #[test]
    /// 완료조건을 채운 회차는 스케줄러 게이트에서 완료로 읽힌다 — 페이싱 대상 워크플로의 회차만.
    fn completed_round_is_reported_only_for_paced_workflows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut policy = sprint_policy(false);
        let config = policy.consumers.get_mut("s-on").expect("consumer");
        config.completion_condition = Some("끝".to_owned());
        // 새 소비자는 스위치가 꺼진 채로 만들어지므로, 조건을 건 회차를 흉내 내려면 함께 켠다.
        config.completion_condition_enabled = true;
        config.completed_at = Some(NOW);
        let auto = AutoCadence {
            app_data_dir: dir.path().to_path_buf(),
            store: std::cell::OnceCell::new(),
            policy: Some(policy),
            base_minutes: 300,
            quiet: None,
            pacing_on: true,
            pacing_ids: std::cell::OnceCell::new(),
        };
        auto.pacing_ids
            .set(["wf-qa".to_owned()].into_iter().collect())
            .expect("seed pacing ids");
        assert!(auto.round_completed("s-on", &workflow_schedule("s-on", "wf-qa", 5, true).input));
        assert!(!auto.round_completed("s-on", &workflow_schedule("s-on", "wf-etc", 5, true).input));
        assert!(!auto.round_completed(
            "s-other",
            &workflow_schedule("s-other", "wf-qa", 5, true).input
        ));
    }

    fn capped_drain_policy(drain: bool, reserve: Option<u32>) -> UsageBudgetPolicy {
        let mut policy = drain_policy(drain, reserve);
        policy.defaults.target_percent = Some(70.0);
        policy.defaults.guard_percent = Some(50.0);
        policy
    }

    #[test]
    /// 소진 중인 계정은 계획 창·가드 창 목표를 100%로 본다. 목표에서 멈추면 창이 비지 않아
    /// 공급자가 크레딧을 물리므로, 남겨 둔 크레딧을 쓸 길이 없어진다.
    fn drain_mode_ignores_the_policy_target_and_guard() {
        let accounts = drain_accounts(60.0, 3);
        let schedules = vec![paced_schedule("s-on", "wf-qa", 5, true, Some(10))];
        let store = store_with_guard_measurement();
        let plan = |policy: &UsageBudgetPolicy| {
            compute_plan(
                &store,
                &request("7일", 92.0),
                &PacingInputs {
                    now: NOW,
                    accounts: &accounts,
                    schedules: &schedules,
                    chats: &[],
                    policy: Some(policy),
                    pacing_workflow_ids: None,
                },
            )
            .expect("plan")
        };

        let even = plan(&capped_drain_policy(false, None));
        let drained = plan(&capped_drain_policy(true, None));

        let even_view = account_view(&even, "claude-a");
        let drain_view = account_view(&drained, "claude-a");
        // 소진이 아니면 정책이 캡이다: 목표 70%·가드 50%.
        assert_eq!(even_view["targetPercent"], json!(70.0));
        assert_eq!(even_view["guardPercent"], json!(50.0));
        // 소진 중이면 두 창 모두 100%.
        assert_eq!(drain_view["targetPercent"], json!(100.0));
        assert_eq!(drain_view["guardPercent"], json!(100.0));
        // 사용률 60%에서 목표 70%면 순여유가 10%p뿐이다. 100%로 보면 40%p라 더 낸다.
        assert!(
            drain_view["netHeadroomPercent"].as_f64() > even_view["netHeadroomPercent"].as_f64(),
            "소진 중인 계정의 순여유가 목표에 묶여선 안 된다: {drain_view:?}"
        );
        assert!(
            drain_view["budgetRuns"].as_u64() > even_view["budgetRuns"].as_u64(),
            "소진 중인 계정이 목표 70%에서 멈춰선 안 된다: {drain_view:?}"
        );
    }

    #[test]
    /// 예비 장수까지 줄면 같은 계정이 그 회차부터 종전 목표·가드로 돌아온다. 되돌릴 크레딧이
    /// 없는데 100%까지 태우면 남은 기간 내내 그 계정이 멈춘다.
    fn drain_target_returns_to_the_policy_when_credits_run_out() {
        let schedules = vec![paced_schedule("s-on", "wf-qa", 5, true, Some(10))];
        let store = store_with_guard_measurement();
        let policy = capped_drain_policy(true, Some(1));
        let plan = |accounts: &[ProviderAccountView]| {
            compute_plan(
                &store,
                &request("7일", 92.0),
                &PacingInputs {
                    now: NOW,
                    accounts,
                    schedules: &schedules,
                    chats: &[],
                    policy: Some(&policy),
                    pacing_workflow_ids: None,
                },
            )
            .expect("plan")
        };

        // 예비 1장 정책에서 2장 보유는 아직 소진 중이고, 1장까지 줄면 대상에서 빠진다.
        let draining = plan(&drain_accounts(60.0, 2));
        let spent = plan(&drain_accounts(60.0, 1));

        assert_eq!(
            account_view(&draining, "claude-a")["targetPercent"],
            json!(100.0)
        );
        assert_eq!(
            account_view(&spent, "claude-a")["targetPercent"],
            json!(70.0),
            "예비 장수에 닿으면 목표가 정책으로 돌아와야 한다"
        );
        assert_eq!(
            account_view(&spent, "claude-a")["guardPercent"],
            json!(50.0)
        );
    }

    /// 계획 창(7일)의 회당 소비를 실측할 수 있는 표본. `store_with_guard_measurement`의
    /// 계획 기록(계정당 2건)과 짝을 맞춰 회당 4%p가 된다.
    fn with_plan_series(store: &mut PacingStore, account_id: &str, before: f64, after: f64) {
        store.series.insert(
            series_key(account_id, "7일"),
            vec![
                UsageSample {
                    at: NOW - 6 * HOUR,
                    used_percent: before,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                UsageSample {
                    at: NOW - 4 * HOUR,
                    used_percent: after,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
    }

    #[test]
    /// 크레딧을 쓸 시점은 "사용률 100% 정확히"가 아니라 "남은 여유가 회당 소비보다 작을 때"다.
    /// 기동은 회당 소비만큼 뛰므로 100%를 조건으로 걸면 크레딧을 영원히 쓰지 못한다.
    fn drain_redeem_waits_until_one_more_run_no_longer_fits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = store_with_guard_measurement();
        // 2건 사이에 8%p 올랐으니 회당 4%p. 되돌릴 시점은 96% 이상이다.
        with_plan_series(&mut store, "claude-a", 60.0, 68.0);
        with_plan_series(&mut store, "codex-b", 60.0, 68.0);
        save_store(dir.path(), &store).expect("seed store");

        let ready = drain_redeem_ready(
            dir.path(),
            "7일",
            &[("claude-a".to_owned(), 97.0), ("codex-b".to_owned(), 90.0)],
        );

        assert_eq!(ready, vec!["claude-a".to_owned()]);
    }

    #[test]
    /// 회당 소비를 실측하지 못한 계정은 하한(0.5%p)을 쓴다. 근거 없이 넉넉한 여유를 인정해
    /// 창이 반쯤 찬 계정에 크레딧을 쓰려 들면 매 회차 헛시도가 된다.
    fn drain_redeem_falls_back_to_the_cost_floor_without_samples() {
        let dir = tempfile::tempdir().expect("tempdir");
        save_store(dir.path(), &PacingStore::default()).expect("seed store");

        let ready = drain_redeem_ready(
            dir.path(),
            "7일",
            &[("claude-a".to_owned(), 99.6), ("codex-b".to_owned(), 99.0)],
        );

        assert_eq!(ready, vec!["claude-a".to_owned()]);
    }

    #[test]
    fn adaptive_cadence_follows_the_pool_even_consumption_rate() {
        // 남은 여유 47%p(92-45), 회당 2.5%p → 남은 18.8건을 리셋까지 50시간에 펴면
        // 분당 0.0063건이다. 그 역수인 159분마다 한 건이 돌아야 목표에 닿는다.
        //
        // 기록된 회차 기동 상한은 간격에 들어가지 않는다. 상한으로 나누던 옛 계산은
        // 상한이 크면 "한 회차에 다 쓸 수 있다"고 보고 기준 간격을 유지했지만, 정작
        // 회차 예산은 회당 소비 한 건 몫뿐이라 목표를 놓쳤다. 상한은 한 회차가 몰아
        // 쓰지 않게 막는 값이고, 간격을 정하는 것은 계정별 소비 속도다.
        for max_runs in [1, 12] {
            let store = store_for_adaptive(max_runs, 45.0);
            let minutes = adaptive_cadence_minutes(
                &store,
                Some(&adaptive_policy()),
                "wf-refactor",
                300,
                NOW,
                1,
                None,
            );
            assert_eq!(minutes, 159, "기동 상한 {max_runs}건");
        }
    }

    #[test]
    fn adaptive_cadence_gives_each_active_consumer_its_share_of_the_rate() {
        // 같은 창을 두 소비자가 나눠 쓰면 각자는 속도의 절반만 가져가므로 간격이 두 배다.
        // 소비자마다 풀 전체를 혼자 채울 것처럼 각자 좁히면 합쳐서 소비자 수만큼 빨라진다.
        let store = store_for_adaptive(1, 45.0);
        let minutes = |consumers| {
            adaptive_cadence_minutes(
                &store,
                Some(&adaptive_policy()),
                "wf-refactor",
                600,
                NOW,
                consumers,
                None,
            )
        };
        assert_eq!(minutes(1), 159);
        // 소비자 2 ÷ 분당 0.0063건 = 319분(한 소비자였을 때의 두 배).
        assert_eq!(minutes(2), 319);
    }

    /// 정책에 소비자로 등록하고 참여를 켠 페이싱 정책. `sharing_round_ids`가 보는 두 조건
    /// (반복 요청 켜짐 + 정책 참여 켜짐) 중 뒤쪽을 만든다.
    fn sharing_policy(consumers: &[(&str, &str, bool)]) -> UsageBudgetPolicy {
        let mut policy = adaptive_policy();
        for (id, workflow_id, enabled) in consumers {
            policy.consumers.insert(
                (*id).to_owned(),
                crate::usage_budget_policy::ConsumerBudgetConfig {
                    enabled: *enabled,
                    workflow_id: Some((*workflow_id).to_owned()),
                    ..Default::default()
                },
            );
        }
        policy
    }

    #[test]
    fn sharing_rounds_count_a_round_that_has_never_launched() {
        // 회귀 방지: 소비자 수를 계획 기록으로 세던 옛 규칙은 방금 켠 회차를 못 봤다.
        // 제한 시간대라 아직 못 뜬 회차도 마찬가지여서, 제한이 풀리는 순간 저마다
        // "나 혼자"로 계산한 몫이 겹쳤다. 기록이 하나도 없어도 설정으로 센다.
        let schedules = vec![
            workflow_schedule("s-a", "wf-a", 5, true),
            workflow_schedule("s-b", "wf-b", 5, true),
        ];
        let policy = sharing_policy(&[("s-a", "wf-a", true), ("s-b", "wf-b", true)]);
        let ids = sharing_round_ids(&schedules, Some(&policy), |_| true, NOW, None);
        assert_eq!(
            ids,
            ["s-a".to_owned(), "s-b".to_owned()].into_iter().collect()
        );
    }

    #[test]
    fn sharing_rounds_skip_paused_unpaced_and_opted_out_rounds() {
        let schedules = vec![
            workflow_schedule("s-on", "wf-a", 5, true),
            // 반복 요청이 멈춰 있다 — 다음 회차를 띄우지 않으므로 몫을 잡지 않는다.
            workflow_schedule("s-paused", "wf-b", 5, false),
            // 페이싱 대상이 아닌 워크플로.
            workflow_schedule("s-unpaced", "wf-plain", 5, true),
            // 예산 정책에서 참여를 껐다.
            workflow_schedule("s-out", "wf-d", 5, true),
        ];
        let policy = sharing_policy(&[
            ("s-on", "wf-a", true),
            ("s-paused", "wf-b", true),
            ("s-unpaced", "wf-plain", true),
            ("s-out", "wf-d", false),
        ]);
        let ids = sharing_round_ids(
            &schedules,
            Some(&policy),
            |workflow_id| workflow_id != "wf-plain",
            NOW,
            None,
        );
        assert_eq!(ids, ["s-on".to_owned()].into_iter().collect());
    }

    #[test]
    fn sharing_rounds_take_the_pending_state_over_the_stored_one() {
        // 회차를 켜고 끄는 중에는 저장본이 아직 옛 상태다. 그 회차의 몫은 저장될 상태로 센다.
        let schedules = vec![
            workflow_schedule("s-on", "wf-a", 5, true),
            workflow_schedule("s-off", "wf-b", 5, false),
        ];
        let policy = sharing_policy(&[("s-on", "wf-a", true), ("s-off", "wf-b", true)]);
        let mut off_enabled = schedules[1].input.clone();
        off_enabled.enabled = true;
        let mut on_disabled = schedules[0].input.clone();
        on_disabled.enabled = false;
        let mut new_enabled = workflow_schedule("s-new", "wf-new", 5, true).input;
        new_enabled.enabled = true;
        // 저장본에서 꺼져 있던 회차를 켜는 중.
        assert_eq!(
            sharing_round_ids(
                &schedules,
                Some(&policy),
                |_| true,
                NOW,
                Some(("s-off", &off_enabled)),
            ),
            ["s-on".to_owned(), "s-off".to_owned()]
                .into_iter()
                .collect()
        );
        // 켜져 있던 회차를 끄는 중.
        assert_eq!(
            sharing_round_ids(
                &schedules,
                Some(&policy),
                |_| true,
                NOW,
                Some(("s-on", &on_disabled)),
            ),
            BTreeSet::<String>::new()
        );
        // 아직 저장되지 않은 새 회차는 목록에 없어도 자기 몫을 잡는다.
        assert_eq!(
            sharing_round_ids(
                &schedules,
                Some(&policy),
                |_| true,
                NOW,
                Some(("s-new", &new_enabled)),
            ),
            ["s-on".to_owned(), "s-new".to_owned()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn sharing_rounds_exclude_closed_active_windows() {
        let mut future = workflow_schedule("s-future", "wf-b", 5, true);
        future.input.active_from = Some(NOW + HOUR);
        let mut expired = workflow_schedule("s-expired", "wf-c", 5, true);
        expired.input.active_until = Some(NOW - 1);
        let schedules = vec![
            workflow_schedule("s-open", "wf-a", 5, true),
            future,
            expired,
        ];
        let policy = sharing_policy(&[
            ("s-open", "wf-a", true),
            ("s-future", "wf-b", true),
            ("s-expired", "wf-c", true),
        ]);
        assert_eq!(
            sharing_round_ids(&schedules, Some(&policy), |_| true, NOW, None),
            ["s-open".to_owned()].into_iter().collect()
        );
    }

    #[test]
    fn automatic_cadence_is_shared_only_by_equal_account_scopes() {
        let schedules = vec![
            workflow_schedule("s-a", "wf-a", 5, true),
            workflow_schedule("s-b", "wf-b", 5, true),
            workflow_schedule("s-a-peer", "wf-a-peer", 5, true),
        ];
        let mut policy = sharing_policy(&[
            ("s-a", "wf-a", true),
            ("s-b", "wf-b", true),
            ("s-a-peer", "wf-a-peer", true),
        ]);
        for (workflow, account) in [
            ("wf-a", "claude-a"),
            ("wf-b", "claude-b"),
            ("wf-a-peer", "claude-a"),
        ] {
            policy.workflows.insert(
                workflow.to_owned(),
                crate::usage_budget_policy::WorkflowBudgetConfig {
                    pacing_enabled: true,
                    accounts: [account.to_owned()].into_iter().collect(),
                },
            );
        }
        let ids =
            sharing_round_ids_for_workflow(&schedules, Some(&policy), |_| true, "wf-a", NOW, None);
        assert_eq!(
            ids,
            ["s-a".to_owned(), "s-a-peer".to_owned()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn adaptive_cadence_never_grows_past_the_guard_window() {
        // 산술로 159분이 나와도 기준(가드 창)보다 넓히지는 않는다.
        let store = store_for_adaptive(1, 45.0);
        let minutes = adaptive_cadence_minutes(
            &store,
            Some(&adaptive_policy()),
            "wf-refactor",
            100,
            NOW,
            1,
            None,
        );
        assert_eq!(minutes, 100);
    }

    #[test]
    fn adaptive_cadence_ignores_the_measured_run_duration() {
        // 실행 하나가 3시간 걸려도 간격은 산술이 내는 159분 그대로다. 회차가 실행보다 자주
        // 떠도 계획이 살아 있는 실행을 빼고 자리를 주므로 겹치지 않고, 소요시간이 흩어져
        // 있으면 자주 볼수록 빈 자리를 빨리 채워 처리량이 는다.
        let mut store = store_for_adaptive(1, 45.0);
        store.runs.push(RunRecord {
            chat_id: "chat-1".to_owned(),
            execution_id: None,
            consumer_id: "s-refactor".to_owned(),
            workflow_id: Some("wf-refactor".to_owned()),
            account_id: "claude-a".to_owned(),
            provider: ProviderId::Claude,
            started_at: NOW - 4 * HOUR,
            ended_at: Some(NOW - HOUR),
            provider_session_id: None,
            tokens: None,
            reasoning_effort: None,
            model: None,
        });
        let minutes = adaptive_cadence_minutes(
            &store,
            Some(&adaptive_policy()),
            "wf-refactor",
            300,
            NOW,
            1,
            None,
        );
        // 실행 시간을 하한으로 쓰던 옛 계산은 216분(3시간 × 1.2)을 내 슬롯을 놀렸다.
        assert_eq!(minutes, 159);
    }

    #[test]
    fn adaptive_cadence_falls_back_to_the_base_without_measurements() {
        // 계획 기록이 없으면(첫 회차 전) 실측이 없어 기준 간격을 그대로 쓴다.
        let store = PacingStore::default();
        let minutes = adaptive_cadence_minutes(
            &store,
            Some(&adaptive_policy()),
            "wf-refactor",
            300,
            NOW,
            1,
            None,
        );
        assert_eq!(minutes, 300);
        // 목표가 없으면 채울 대상이 없으므로 역시 기준 간격.
        let mut policy = adaptive_policy();
        policy.defaults.target_percent = None;
        let minutes = adaptive_cadence_minutes(
            &store_for_adaptive(1, 45.0),
            Some(&policy),
            "wf-refactor",
            300,
            NOW,
            1,
            None,
        );
        assert_eq!(minutes, 300);
    }

    /// `store_for_adaptive`의 표본은 남은 여유 47%p(92-45)·회당 2.5%p·리셋까지 50시간이라
    /// 3000분에 18.8건, 즉 분당 0.00627건을 요구한다. 이 아래 시험들은 모두 이 수요를 쓴다.
    fn adaptive_demand(policy: &UsageBudgetPolicy, store: &PacingStore) -> Option<PoolDemand> {
        pool_demand(store, Some(policy), "wf-refactor", 300, NOW, 1, None)
    }

    /// 풀 수요는 회당 소비와 무관하게 47%p ÷ 3000분 = 분당 0.01567%p, 즉 시간당 0.94%p다.
    fn adaptive_pool(store: &PacingStore, rounds: &[(&str, &str, usize, u32)]) -> PoolThroughput {
        let policy = adaptive_policy();
        let settings: Vec<RoundSettings<'_>> = rounds
            .iter()
            .map(
                |(schedule_id, workflow_id, max_runs, cadence_minutes)| RoundSettings {
                    schedule_id,
                    workflow_id,
                    max_runs: *max_runs,
                    cadence_minutes: *cadence_minutes,
                },
            )
            .collect();
        let mut groups = pool_throughputs(store, Some(&policy), 300, NOW, &settings, None);
        assert_eq!(groups.len(), 1, "같은 계정 범위는 한 처리량 그룹");
        groups.remove(0)
    }

    /// 회차 하나짜리 풀. 대부분의 시험은 한 회차의 설정만 본다.
    fn adaptive_check(
        store: &PacingStore,
        max_runs: usize,
        cadence_minutes: u32,
    ) -> PoolThroughput {
        adaptive_pool(
            store,
            &[("s-refactor", "wf-refactor", max_runs, cadence_minutes)],
        )
    }

    fn only_round(check: &PoolThroughput) -> &RoundThroughput {
        assert_eq!(check.rounds.len(), 1, "회차 하나짜리 풀");
        &check.rounds[0]
    }

    /// 회당 소비가 크게 다른 두 공급자로 도는 회차. claude-a는 2건에 4%p(회당 2.0),
    /// codex-b는 2건에 1%p(회당 0.5)를 썼다 — 풀 전체를 하나로 재면 4건에 5%p, 회당 1.25다.
    fn store_for_two_providers() -> PacingStore {
        let mut store = PacingStore::default();
        store.plans.push(PlanRecord {
            execution_id: None,
            consumer_id: Some("s-refactor".to_owned()),
            workflow_id: Some("wf-refactor".to_owned()),
            cadence_ms: Some(5 * HOUR),
            cwd: None,
            max_runs: Some(2),
            at: NOW - 5 * HOUR,
            window_label: "7일".to_owned(),
            entries: vec![plan_entry("claude-a", 2), plan_entry("codex-b", 2)],
        });
        for (account_id, provider, grown) in [
            ("claude-a", ProviderId::Claude, 44.0),
            ("codex-b", ProviderId::Codex, 41.0),
        ] {
            store.series.insert(
                series_key(account_id, "7일"),
                vec![
                    UsageSample {
                        at: NOW - 6 * HOUR,
                        used_percent: 40.0,
                        resets_at: Some(NOW + 50 * HOUR),
                    },
                    UsageSample {
                        at: NOW,
                        used_percent: grown,
                        resets_at: Some(NOW + 50 * HOUR),
                    },
                ],
            );
            // 공급자는 실행 기록에서만 읽힌다. 기록이 없으면 전역 평균으로 떨어진다.
            store.runs.push(RunRecord {
                chat_id: format!("chat-{account_id}"),
                execution_id: None,
                consumer_id: "s-refactor".to_owned(),
                workflow_id: Some("wf-refactor".to_owned()),
                account_id: account_id.to_owned(),
                provider,
                started_at: NOW - 5 * HOUR,
                ended_at: Some(NOW - 5 * HOUR + 30 * 60_000),
                provider_session_id: None,
                tokens: None,
                reasoning_effort: None,
                model: None,
            });
        }
        store
    }

    #[test]
    fn demand_uses_the_cost_of_each_account_provider_not_one_pool_average() {
        // 남은 여유는 claude-a 48%p(92-44), codex-b 51%p(92-41)이고 리셋까지 3000분이다.
        // 공급자별 실측이면 48/2.0/3000 + 51/0.5/3000 = 분당 0.0420건.
        // 풀 평균 1.25로 뭉개면 48/1.25/3000 + 51/1.25/3000 = 분당 0.0264건뿐이라,
        // 싼 Codex가 정작 얼마나 더 돌아야 하는지를 놓친다.
        let policy = adaptive_policy();
        let demand = adaptive_demand(&policy, &store_for_two_providers()).expect("demand");
        assert!(
            (demand.runs_per_minute - 0.042).abs() < 0.0005,
            "분당 {}건",
            demand.runs_per_minute
        );
    }

    #[test]
    fn demand_falls_back_to_the_pool_average_without_a_run_record() {
        // 실행 기록이 없으면 계정의 공급자를 알 수 없다. 그때는 지금까지처럼 전역 평균으로
        // 센다 — 값이 없다고 그 계정을 수요에서 빼면 간격이 느슨해져 목표를 놓친다.
        let mut store = store_for_two_providers();
        store.runs.clear();
        let policy = adaptive_policy();
        let demand = adaptive_demand(&policy, &store).expect("demand");
        assert!(
            (demand.runs_per_minute - 0.0264).abs() < 0.0005,
            "분당 {}건",
            demand.runs_per_minute
        );
    }

    #[test]
    fn throughput_accepts_a_round_that_keeps_the_even_pace() {
        // 균등 간격(159분)에 맞춰 도는 회차는 병렬 1건으로도 목표에 닿는다.
        let check = adaptive_check(&store_for_adaptive(1, 45.0), 1, 159);
        assert!(check.reaches_target);
        assert_eq!(only_round(&check).recommended_max_runs, None);
        // 시간당 0.94%p가 필요하고 회당 2.5%p를 159분마다 한 건 쓰면 그만큼 낸다.
        assert!((check.demand_percent_per_hour - 0.94).abs() < 0.01);
        assert!((only_round(&check).cost_percent_per_run - 2.5).abs() < 0.001);
        assert!(check.supply_percent_per_hour >= check.demand_percent_per_hour);
    }

    #[test]
    fn throughput_recommends_the_smallest_parallel_limit_that_covers_demand() {
        // 간격이 기준 300분까지 벌어지면 병렬 1건(300분마다 2.5%p = 시간당 0.5%p)으로는
        // 시간당 0.94%p를 못 채운다. 한 자리가 0.5%p씩 내므로 올림해 2건이 최소 권장값이다.
        let check = adaptive_check(&store_for_adaptive(1, 45.0), 1, 300);
        assert!(!check.reaches_target);
        assert!((check.supply_percent_per_hour - 0.5).abs() < 0.001);
        assert_eq!(only_round(&check).recommended_max_runs, Some(2));
    }

    #[test]
    fn throughput_counts_the_run_time_plus_half_a_cadence() {
        // 실행 하나가 3시간이면 간격을 30분으로 좁혀도 그만큼 자주 자리가 나지는 않는다.
        // 슬롯 주기는 실행 180분 + 다음 회차를 기다리는 평균 15분 = 195분이다.
        let mut store = store_for_adaptive(1, 45.0);
        store.runs.push(RunRecord {
            chat_id: "chat-1".to_owned(),
            execution_id: None,
            consumer_id: "s-refactor".to_owned(),
            workflow_id: Some("wf-refactor".to_owned()),
            account_id: "claude-a".to_owned(),
            provider: ProviderId::Claude,
            started_at: NOW - 4 * HOUR,
            ended_at: Some(NOW - HOUR),
            provider_session_id: None,
            tokens: None,
            reasoning_effort: None,
            model: None,
        });
        let check = adaptive_check(&store, 1, 30);
        assert_eq!(only_round(&check).run_minutes, Some(180.0));
        // 30분이 아니라 195분으로 나눈다 — 30분이었다면 5%p/h으로 넉넉히 남았을 것이다.
        assert!((check.supply_percent_per_hour - 2.5 * 60.0 / 195.0).abs() < 0.001);
        assert!(!check.reaches_target);
        assert_eq!(only_round(&check).recommended_max_runs, Some(2));
    }

    #[test]
    fn throughput_grows_monotonically_as_the_cadence_tightens() {
        // 간격을 좁히면 처리량은 단조로 는다 — 실행 시간 근처에서 절반으로 떨어지는 절벽은
        // 없다. 소요시간이 흩어져 슬롯이 서로 어긋나기 때문이고, 자동 주기가 실행 시간을
        // 하한으로 삼지 않는 근거다.
        let mut store = store_for_adaptive(1, 45.0);
        store.runs.push(RunRecord {
            chat_id: "chat-1".to_owned(),
            execution_id: None,
            consumer_id: "s-refactor".to_owned(),
            workflow_id: Some("wf-refactor".to_owned()),
            account_id: "claude-a".to_owned(),
            provider: ProviderId::Claude,
            started_at: NOW - 100 * 60_000,
            ended_at: Some(NOW),
            provider_session_id: None,
            tokens: None,
            reasoning_effort: None,
            model: None,
        });
        // 실행 100분: 간격 100분이면 슬롯 주기 150분, 99분이면 149.5분, 10분이면 105분.
        let supplies: Vec<f64> = [100, 99, 50, 10]
            .into_iter()
            .map(|cadence| adaptive_check(&store, 1, cadence).supply_percent_per_hour)
            .collect();
        assert!((supplies[0] - 2.5 * 60.0 / 150.0).abs() < 0.001);
        assert!(
            supplies.windows(2).all(|pair| pair[1] > pair[0]),
            "간격을 좁힐수록 늘어야 한다: {supplies:?}"
        );
    }

    #[test]
    fn throughput_recommends_runs_beyond_the_old_twelve_cap() {
        // 리셋이 2시간 앞이면 47%p를 120분에 밀어 넣어야 해 300분 간격으로는 47건이 필요하다.
        // 병렬 실행에 상한이 없으므로 계산된 값을 그대로 권한다 — 옛 상한 12건에서 잘라
        // null로 숨기지 않는다.
        let mut store = store_for_adaptive(1, 45.0);
        for sample in store
            .series
            .get_mut(&series_key("claude-a", "7일"))
            .expect("series")
        {
            sample.resets_at = Some(NOW + 2 * HOUR);
        }
        let check = adaptive_check(&store, 1, 300);
        assert!(!check.reaches_target);
        assert_eq!(only_round(&check).recommended_max_runs, Some(47));
    }

    #[test]
    fn throughput_adds_up_rounds_whose_runs_cost_different_amounts() {
        // 회귀 방지: 판정을 회차별로 하고 수요를 1/N씩 나누면, 회당 소비가 다른 회차들의
        // 몫이 전체로 다시 합쳐지지 않는다. 설정이 약한 회차 하나에만 경고가 뜨고 정작
        // 풀이 모자란지는 어디에도 안 나온다. 그래서 %p/h로 재고 더한다.
        //
        // 두 회차 모두 회당 2.5%p를 300분마다 한 건 → 각 0.5%p/h, 합 1.0%p/h.
        // 풀 수요 0.94%p/h를 합으로는 넘고, 회차 하나만 보면 못 넘는다.
        let store = store_for_adaptive(1, 45.0);
        let both = adaptive_pool(
            &store,
            &[
                ("s-a", "wf-refactor", 1, 300),
                ("s-b", "wf-refactor", 1, 300),
            ],
        );
        assert_eq!(both.rounds.len(), 2);
        assert!((both.supply_percent_per_hour - 1.0).abs() < 0.001);
        assert!(both.reaches_target, "합치면 0.94%p/h를 넘는다");
        // 같은 설정의 회차 하나만으로는 모자란다 — 합산이 실제로 판정을 바꾼다.
        assert!(!adaptive_check(&store, 1, 300).reaches_target);
    }

    #[test]
    fn throughput_separates_disjoint_workflow_account_scopes() {
        // A 전용·B 전용 회차는 서로의 목표나 권장 병렬 수에 영향을 주면 안 된다. 하나로
        // 합치면 Antigravity 회차 경고에 Claude·Codex 회차까지 대안으로 표시된다.
        let store = store_for_two_providers();
        let mut policy = adaptive_policy();
        for (workflow, account) in [("wf-a", "claude-a"), ("wf-b", "codex-b")] {
            policy.workflows.insert(
                workflow.to_owned(),
                crate::usage_budget_policy::WorkflowBudgetConfig {
                    pacing_enabled: true,
                    accounts: [account.to_owned()].into_iter().collect(),
                },
            );
        }
        let settings = [
            RoundSettings {
                schedule_id: "s-a",
                workflow_id: "wf-a",
                max_runs: 2,
                cadence_minutes: 300,
            },
            RoundSettings {
                schedule_id: "s-b",
                workflow_id: "wf-b",
                max_runs: 2,
                cadence_minutes: 300,
            },
        ];
        let checks = pool_throughputs(&store, Some(&policy), 300, NOW, &settings, None);
        assert_eq!(checks.len(), 2, "서로 다른 계정 범위는 별도 판정");
        let a = checks
            .iter()
            .find(|check| check.rounds[0].schedule_id == "s-a")
            .expect("A 전용 처리량");
        let b = checks
            .iter()
            .find(|check| check.rounds[0].schedule_id == "s-b")
            .expect("B 전용 처리량");
        assert_eq!(a.rounds.len(), 1);
        assert_eq!(b.rounds.len(), 1);
        assert!((a.demand_percent_per_hour - 0.96).abs() < 0.01);
        assert!((b.demand_percent_per_hour - 1.02).abs() < 0.01);
    }

    #[test]
    fn throughput_recommends_covering_the_pool_gap_from_each_round() {
        // 부족분은 풀 단위로 하나다. 회차마다 "이 회차만으로 메우려면 몇 건"을 답해 사용자가
        // 어느 회차를 올릴지 고를 수 있게 한다. 두 회차가 각각 0.5%p/h를 내고 수요가
        // 2.0%p/h이면, 한쪽만으로 메우려면 (2.0-0.5)/0.5 = 3건이 필요하다.
        let store = store_for_adaptive(1, 45.0);
        // 목표를 올려 남은 여유를 100%p로 키운다 → 수요 100 ÷ 3000분 × 60 = 2.0%p/h.
        // 표본은 손대지 않는다 — 사용률 증가가 사라지면 회당 소비를 못 재 판정 자체가 없어진다.
        let mut policy = adaptive_policy();
        policy.defaults.target_percent = Some(145.0);
        let settings = [
            RoundSettings {
                schedule_id: "s-a",
                workflow_id: "wf-refactor",
                max_runs: 1,
                cadence_minutes: 300,
            },
            RoundSettings {
                schedule_id: "s-b",
                workflow_id: "wf-refactor",
                max_runs: 1,
                cadence_minutes: 300,
            },
        ];
        let check =
            pool_throughput(&store, Some(&policy), 300, NOW, &settings, None).expect("throughput");
        assert!((check.demand_percent_per_hour - 2.0).abs() < 0.01);
        assert!(!check.reaches_target);
        for round in &check.rounds {
            assert_eq!(
                round.recommended_max_runs,
                Some(3),
                "회차 {}",
                round.schedule_id
            );
        }
    }

    #[test]
    fn demand_falls_back_to_the_pool_cost_when_the_workflow_has_no_samples() {
        // 회귀 방지: 오래 쉰 회차는 자기 계획 기록이 먼저 밀려나 회당 소비를 못 잰다. 거기서
        // 손을 떼면 자동 주기를 못 받아 기준 간격(300분)에 묶이고, 느려서 표본을 못 만드는
        // 고리에 갇힌 채 창을 나눠 쓰는 수만 차지한다. 풀 전체 표본으로 떨어져야 한다.
        let store = store_for_adaptive(1, 45.0);
        let mut policy = pool_policy(&["claude-a"]);
        policy.defaults = adaptive_policy().defaults;
        // 이 워크플로의 계획 기록은 하나도 없다.
        let demand = pool_demand(&store, Some(&policy), "wf-never-ran", 300, NOW, 1, None)
            .expect("풀 표본으로 떨어져야 한다");
        // 풀 표본의 회당 2.5%p를 그대로 쓴다.
        assert!((demand.percent_per_minute / demand.runs_per_minute - 2.5).abs() < 0.001);
        let minutes =
            adaptive_cadence_minutes(&store, Some(&policy), "wf-never-ran", 300, NOW, 1, None);
        assert!(minutes < 300, "기준 간격에 묶이지 않아야 한다: {minutes}분");
    }

    #[test]
    fn throughput_is_unknown_without_a_target() {
        // 목표가 없으면 채울 대상이 없어 수요를 잴 수 없다. 화면은 아무 말도 하지 않는다.
        let mut policy = adaptive_policy();
        policy.defaults.target_percent = None;
        assert!(adaptive_demand(&policy, &store_for_adaptive(1, 45.0)).is_none());
    }

    #[test]
    fn plan_rests_an_account_whose_round_budget_is_below_one_run() {
        // 7일 창 91%, 목표 92% → 남은 여력 1%p를 남은 회차에 쪼개면 회당 비용에 못 미친다.
        // 실측 표본이 있으므로 부트스트랩 예외는 적용되지 않는다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 91.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(plan.planned.is_empty());
        assert!(plan.accounts[0]["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("이번 회차는 쉼")));
    }

    #[test]
    fn first_round_runs_once_per_account_so_measurement_can_start() {
        // 표본이 없으면 회당 소비가 대체값이라 예산이 늘 부족해 0건이 나오고, 0건이면
        // 표본도 생기지 않아 실측이 영영 시작되지 않는다. 첫 회차만 한 건씩 허용한다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 91.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.planned.len(), 1);
        assert_eq!(plan.cost_observations, 0);
        assert!(plan.accounts[0]["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("첫 측정")));
    }

    #[test]
    fn the_bootstrap_exception_never_overrides_the_guard_window() {
        // 첫 측정이라도 짧은 창이 상한을 넘은 계정은 돌리지 않는다. 예외는 예산 부족만
        // 덮고 제외 사유는 덮지 않는다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 10.0, Some(NOW + 50 * HOUR)),
                ("5시간", 90.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(plan.planned.is_empty());
    }

    #[test]
    fn plan_excludes_an_account_over_the_guard_window() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 10.0, Some(NOW + 50 * HOUR)),
                ("5시간", 90.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(plan.planned.is_empty());
        assert!(plan.accounts[0]["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("5시간")));
    }

    /// 2026-09-04 재현: 5시간 창 60%, 상한 90, 회당 12%p 실측. 10분 간격 지난 세 회차의 실행이
    /// 아직 돌고 있어 예약 36%p 중 오른 10%p만 정산되고 26%p가 미정산이다. 스냅샷(60 < 90)만
    /// 보면 2건을 더 띄우지만, 여유 4%p가 회당 12%p에 못 미치므로 이번 회차는 쉬어야 한다.
    #[test]
    fn running_runs_guard_claims_block_the_next_launch() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 60.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.guard_percent = Some(90.0);
        let mut store = store_with_measurement();
        // 지난 회차 2건이 5시간 창을 24%p 올렸다 → 회당 12%p.
        with_guard_series(&mut store, "claude-a", NOW - 5 * HOUR, 10.0, 34.0);
        let mut chats = Vec::new();
        for (index, (minutes_ago, baseline)) in
            [(30, 50.0), (20, 55.0), (10, 58.0)].into_iter().enumerate()
        {
            let execution = format!("exec-{index}");
            let chat = format!("run-{index}");
            let mut claim = claim_record(
                "s-on",
                NOW - minutes_ago * 60_000,
                "claude-a",
                1,
                2.5,
                40.0,
                6,
            );
            claim.execution_id = Some(execution.clone());
            claim.cadence_ms = Some(10 * 60_000);
            claim.entries[0].guards.insert(
                "5시간".to_owned(),
                WindowClaim {
                    expected_cost_percent: Some(12.0),
                    used_percent_at_claim: Some(baseline),
                    resets_at_at_claim: Some(NOW + HOUR),
                },
            );
            store.plans.push(claim);
            store.runs.push(run_record(
                &chat,
                "s-on",
                Some(&execution),
                "claude-a",
                NOW - minutes_ago * 60_000 + 30_000,
                None,
            ));
            chats.push(finished_chat(
                &chat,
                "/tmp/project",
                true,
                ChatPhase::Running,
            ));
        }
        let plan =
            compute_plan(&store, &req, &inputs(&accounts, &schedules, &chats)).expect("plan");
        let view = account_view(&plan, "claude-a");
        let guard = &view["guards"][0];
        assert_eq!(guard["label"], "5시간");
        assert_eq!(guard["costPercentPerRun"], 12.0);
        // 활성 예약 셋이 모두 열려 있다: 오른 10%p는 가장 오래된 예약에 정산, 나머지 26%p 미정산.
        assert_eq!(guard["outstandingClaimPercent"], 26.0);
        assert_eq!(guard["affordableRuns"], 0);
        assert_eq!(view["guardCapRuns"], 0);
        assert!(plan.planned.is_empty(), "{:?}", plan.planned);
        assert!(view["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("5시간") && reason.contains("미정산")));
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("가드 창의 여유")));

        // 실행이 모두 끝나고 5시간 창 표본이 뒤따르면 예약은 정산되고 여유가 돌아온다.
        for run in &mut store.runs {
            if run.ended_at.is_none() {
                run.ended_at = Some(NOW - 60_000);
            }
        }
        store
            .series
            .get_mut(&series_key("claude-a", "5시간"))
            .expect("series")
            .push(UsageSample {
                at: NOW - 30_000,
                used_percent: 60.0,
                resets_at: Some(NOW + HOUR),
            });
        let plan =
            compute_plan(&store, &req, &inputs(&accounts, &schedules, &chats)).expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["guards"][0]["outstandingClaimPercent"], 0.0);
        assert!(!plan.planned.is_empty());
    }

    /// 가드 창의 회당 소비를 아직 실측하지 못했으면 첫 측정을 위한 1건만 띄우고, 그 계정에
    /// 진행 중 실행이 있으면 소비를 모르는 채 겹쳐 띄우지 않는다.
    #[test]
    fn unmeasured_guard_cost_allows_one_run_unless_a_run_is_still_running() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 0.0, Some(NOW + 6 * HOUR)),
                ("5시간", 20.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = PacingStore::default();
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["guards"][0]["costSource"], "unmeasured");
        assert_eq!(view["guards"][0]["affordableRuns"], 1);
        assert_eq!(view["guardCapRuns"], 1);
        assert_eq!(plan.planned.len(), 1);

        // 다른 소비자의 실행이라도 같은 계정에서 돌고 있으면 막는다.
        store.runs.push(run_record(
            "run-1",
            "s-other",
            None,
            "claude-a",
            NOW - 10 * 60_000,
            None,
        ));
        let running = finished_chat("run-1", "/tmp/project", true, ChatPhase::Running);
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, std::slice::from_ref(&running)),
        )
        .expect("plan");
        assert!(plan.planned.is_empty(), "{:?}", plan.planned);
        assert!(account_view(&plan, "claude-a")["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("실측하지 못했고")));
        // 실행이 끝나면(살아 있는 채팅이 아니면) 다시 1건.
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.planned.len(), 1);
    }

    /// 계획 창의 회당 소비가 실측되지 않은 계정은 병렬 설정과 무관하게 첫 측정 1건만 받고,
    /// 그 실행이 도는 동안은 0건, 실측이 잡히면 여력만큼 받는다. 2026-09-24 QA 회차에서
    /// 실측 없는 Codex 계정 셋이 대체값 0.5%p로 2건씩 받아 8분 만에 5시간 창을 비운 일의
    /// 재현이다 — 가드 창은 실측돼 있었고 계획 창만 대체값이었다.
    #[test]
    fn an_unmeasured_account_gets_one_first_measurement_run_even_in_parallel() {
        let accounts = vec![account(
            "codex-b",
            "tester-b@example.com",
            ProviderId::Codex,
            usage(vec![
                ("7일", 19.0, Some(NOW + 50 * HOUR)),
                ("5시간", 0.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.max_runs = Some(10);

        // 가드 창만 실측된 저장소: 계획 창 회당 소비는 대체값 2.0%p라 예산은 여러 건이지만
        // 기동은 1건이다.
        let plan = compute_plan(
            &store_with_guard_measurement(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "codex-b");
        assert_eq!(view["accountCostMeasured"], false);
        assert!(
            view["budgetRuns"].as_u64().is_some_and(|runs| runs > 1),
            "{view}"
        );
        assert_eq!(view["firstMeasurement"], true);
        assert_eq!(view["allowedRuns"], 1);
        assert_eq!(plan.planned.len(), 1);
        assert!(view["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("첫 측정으로 1건만 기동")));
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("첫 측정 1건만 기동")));

        // 첫 측정 실행이 아직 돌고 있으면 0건 — 한 건을 더 주면 결국 병렬이다.
        let mut store = store_with_guard_measurement();
        store.runs.push(run_record(
            "run-1",
            "s-on",
            None,
            "codex-b",
            NOW - 10 * 60_000,
            None,
        ));
        let running = finished_chat("run-1", "/tmp/project", true, ChatPhase::Running);
        let plan = compute_plan(
            &store,
            &req,
            &inputs(&accounts, &schedules, std::slice::from_ref(&running)),
        )
        .expect("plan");
        assert!(plan.planned.is_empty(), "{:?}", plan.planned);
        let view = account_view(&plan, "codex-b");
        assert_eq!(view["firstMeasurement"], true);
        assert!(view["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("첫 측정 실행이 진행 중")));

        // 실측이 잡히면 제한이 풀려 여력만큼 병렬로 받는다.
        let plan = compute_plan(
            &store_with_plan_measurement(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "codex-b");
        assert_eq!(view["accountCostMeasured"], true);
        assert_eq!(view["firstMeasurement"], false);
        assert!(
            view["allowedRuns"].as_u64().is_some_and(|runs| runs > 1),
            "{view}"
        );
        assert!(!plan
            .reasoning
            .iter()
            .any(|line| line.contains("첫 측정 1건만 기동")));
    }

    /// 실측은 계정 단위다. 같은 공급자의 다른 계정이 실측돼 전역·공급자 회당 소비가 있어도,
    /// 이 계정 자신의 실측이 없으면 첫 측정 1건이다 — 플랜이 다르면 창 크기가 달라 %p가
    /// 다르다.
    #[test]
    fn another_accounts_measurement_does_not_lift_the_first_measurement_cap() {
        let accounts = vec![
            account(
                "claude-a",
                "tester-a@example.com",
                ProviderId::Claude,
                usage(vec![
                    ("7일", 40.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
            account(
                "claude-c",
                "tester-c@example.com",
                ProviderId::Claude,
                usage(vec![
                    ("7일", 40.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
        ];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.max_runs = Some(10);
        // claude-a만 계획·가드 창이 실측돼 있다. claude-c는 가드 창 실측만 빌려 받는다.
        let mut store = store_with_plan_measurement();
        with_guard_series(&mut store, "claude-c", NOW - 5 * HOUR, 10.0, 12.0);
        let plan = compute_plan(&store, &req, &inputs(&accounts, &schedules, &[])).expect("plan");
        assert_eq!(plan.cost_source, "measured");
        let measured = account_view(&plan, "claude-a");
        let unmeasured = account_view(&plan, "claude-c");
        assert_eq!(measured["accountCostMeasured"], true);
        assert!(
            measured["allowedRuns"]
                .as_u64()
                .is_some_and(|runs| runs > 1),
            "{measured}"
        );
        assert_eq!(unmeasured["accountCostMeasured"], false);
        assert_eq!(unmeasured["allowedRuns"], 1);
        assert_eq!(unmeasured["firstMeasurement"], true);
    }

    /// Codex 라벨은 응답의 창 길이를 따른다. 지난 예약은 "5시간" 창에 남았는데 계정이 이제
    /// "3시간" 창을 보고하면 옛 예약은 맞는 창이 없어 소멸하고, 새 라벨은 미측정이라 첫 측정
    /// 1건으로 시작한다. 계획 창(7일) 예약은 라벨이 그대로라 여전히 열려 있다.
    #[test]
    fn a_guard_claim_for_a_vanished_label_is_ignored() {
        let accounts = vec![account(
            "codex-b",
            "tester-b@example.com",
            ProviderId::Codex,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("3시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = PacingStore::default();
        let mut claim = claim_record("s-on", NOW - 30 * 60_000, "codex-b", 2, 5.0, 40.0, 6);
        claim.entries[0].guards.insert(
            "5시간".to_owned(),
            WindowClaim {
                expected_cost_percent: Some(24.0),
                used_percent_at_claim: Some(50.0),
                resets_at_at_claim: Some(NOW + HOUR),
            },
        );
        store.plans.push(claim);
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "codex-b");
        assert_eq!(view["outstandingClaimPercent"], 5.0);
        let guards = view["guards"].as_array().expect("guards");
        assert_eq!(guards.len(), 1);
        assert_eq!(guards[0]["label"], "3시간");
        assert_eq!(guards[0]["outstandingClaimPercent"], 0.0);
        assert_eq!(guards[0]["affordableRuns"], 1);
        assert_eq!(plan.planned.len(), 1);
    }

    /// 정책이 라벨을 지정하지 않아도 계정이 보고하는 계정 전체 창은 모두 가드다 — 공급자가
    /// 창을 바꾸거나 더해도 가드가 조용히 빠지지 않는다.
    #[test]
    fn every_governing_window_outside_the_plan_window_is_a_guard() {
        let accounts = vec![account(
            "codex-b",
            "tester-b@example.com",
            ProviderId::Codex,
            usage(vec![
                ("7일", 10.0, Some(NOW + 50 * HOUR)),
                ("1일", 90.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.guard_window_label = None;
        let plan = compute_plan(
            &PacingStore::default(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(plan.planned.is_empty());
        assert!(account_view(&plan, "codex-b")["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("1일 창 85% 초과")));
    }

    /// 모델별 창은 그 모델을 쓰지 않는 실행까지 막으므로 이름으로 지정했을 때만 가드에 든다.
    #[test]
    fn model_scoped_windows_guard_only_when_named() {
        let mut view = usage(vec![
            ("7일", 10.0, Some(NOW + 50 * HOUR)),
            ("5시간", 10.0, Some(NOW + HOUR)),
            ("Fable 7일", 95.0, Some(NOW + 50 * HOUR)),
        ]);
        view.windows[2].model_scoped = true;
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            view,
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(!plan.planned.is_empty());
        assert_eq!(
            account_view(&plan, "claude-a")["guards"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        let mut req = request("7일", 92.0);
        req.guard_window_label = Some("Fable 7일".to_owned());
        let plan = compute_plan(
            &store_with_measurement(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(plan.planned.is_empty());
        assert!(account_view(&plan, "claude-a")["skipReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("Fable 7일")));
    }

    /// 예약 기록은 가드 창마다 기준선과 기대 소비를 남기고, 그 필드가 없는 옛 기록도 그대로
    /// 읽힌다(계획 창 예약만 있는 것으로).
    #[test]
    fn plan_records_guard_baselines_and_legacy_entries_load_without_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        save_store(dir.path(), &store_with_guard_measurement()).expect("seed");
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        plan_and_record(
            dir.path(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("record");
        let store = load_store(dir.path()).expect("store");
        let entry = &store.plans.last().expect("record").entries[0];
        assert!(entry.count > 0);
        let guard = entry.guards.get("5시간").expect("guard claim");
        assert_eq!(guard.used_percent_at_claim, Some(10.0));
        assert_eq!(guard.resets_at_at_claim, Some(NOW + HOUR));
        assert_eq!(guard.expected_cost_percent, Some(entry.count as f64 * 1.0));

        let legacy: PlanRecordEntry = serde_json::from_value(json!({
            "accountId": "claude-a",
            "count": 2,
            "expectedCostPercent": 5.0,
            "usedPercentAtClaim": 40.0,
            "resetsAtAtClaim": NOW,
        }))
        .expect("legacy entry");
        assert!(legacy.guards.is_empty());
    }

    #[test]
    fn plan_keeps_an_account_whose_usage_lookup_is_throttled() {
        // 토큰 갱신 제한은 조회만 막고 실행에는 지장이 없다. 제외 사유로 쓰면 그 계정이
        // 영구히 쉬게 된다.
        let mut throttled = usage(vec![
            ("7일", 20.0, Some(NOW + 50 * HOUR)),
            ("5시간", 5.0, None),
        ]);
        throttled.token_refresh_limited = true;
        let mut view = account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            throttled,
        );
        view.auth_status = AccountAuthStatus::Error;
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs(&[view], &schedules, &[]),
        )
        .expect("plan");
        assert!(!plan.planned.is_empty());
    }

    #[test]
    fn an_expensive_account_runs_from_the_start_of_the_window() {
        // 창이 118시간 지났으므로 목표 92%의 현재 시점 몫은 약 64.6%다. 실제 사용률
        // 40%는 24.6%p 밀렸고 회당 10%p여도 두 건 이상 뒤처져 있어 이번 회차에 든다.
        //
        // 옛 판정은 "회차 예산(여유 ÷ 남은 회차)이 회당 소비 이상"을 요구했다. 그 조건은
        // "남은 회차 ≤ 남은 건수"와 같아서 창 끝의 몇 회차 전까지 이 계정을 통째로
        // 쉬게 했다.
        let store = store_with_cost("claude-a", 10.0, 1, NOW - 30 * HOUR);
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["costPercentPerRun"], 10.0);
        assert!(view["evenPeriodMinutes"]
            .as_f64()
            .is_some_and(|minutes| (minutes - 576.923_076_923_076_9).abs() < 1e-9));
        assert_eq!(view["allowedRuns"], 1);
        // 옛 게이트는 남은 회차(10) ≤ 남은 건수(5.2)가 아니어서 여전히 닫혔다.
        assert_eq!(view["remainingRuns"], 10);
    }

    #[test]
    fn direct_usage_on_the_even_line_rests_regardless_of_plan_history() {
        // 7일 창이 절반 지났고 실제 사용률도 목표 100%의 절반인 50%면 정확히 제 속도다.
        // 페이싱 밖에서 직접 쓴 소비여도 이번 회차는 쉬어야 한다. 오래된 계획 건수로 목표
        // 전체를 다시 추정하면 2.5건 뒤처진 것으로 오인한다.
        let mut store = store_with_cost("claude-a", 10.0, 1, NOW - 100 * HOUR);
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 50.0, Some(NOW + 84 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let req = request("7일", 100.0);
        let plan = compute_plan(&store, &req, &inputs(&accounts, &schedules, &[])).expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["allowedRuns"], 0);
        assert!(
            view["skipReason"]
                .as_str()
                .is_some_and(|reason| reason.contains("현재 시점의 균등 목표")),
            "{:?}",
            view["skipReason"]
        );
        assert!(plan.planned.is_empty());

        // 저장 상한을 채운 계획 기록이 있어도 결과가 달라지지 않는다. 이 기록은 실제
        // 기동을 증명하지 못하고, 64건 밖의 오래된 기록은 저장 시 제거되기 때문이다.
        store.plans.extend(
            (0..MAX_PLAN_RECORDS).map(|_| history_record(NOW - 80 * HOUR, &[("claude-a", 1)])),
        );
        // 실행되지 않은 계획 그룹 뒤에 사용량이 그대로인 표본을 둔다. 이 그룹은 비용
        // 관측에서는 빠지고, 그보다 오래된 정상 관측은 부트스트랩 예외를 계속 끈다.
        store
            .series
            .get_mut(&series_key("claude-a", "7일"))
            .expect("series")
            .push(UsageSample {
                at: NOW - 79 * HOUR,
                used_percent: 15.0,
                resets_at: Some(NOW + 50 * HOUR),
            });
        let saturated = compute_plan(&store, &req, &inputs(&accounts, &schedules, &[]))
            .expect("plan with saturated history");
        assert!(saturated.planned.is_empty());
        assert_eq!(account_view(&saturated, "claude-a")["allowedRuns"], 0);
    }

    #[test]
    fn an_expired_plan_without_a_started_run_returns_to_the_budget() {
        // 계획 4건이 기록됐지만 forEach 기동이 실패했고 한 회차가 지나 예약도 만료됐다.
        // 실제 사용률은 0%라 현재 시점의 목표보다 크게 뒤처졌고 회당 10%p 실행 한 건이
        // 지금 필요하다. 계획 건수를 완료 실행으로 세면 이 계정은 계속 쉬게 된다.
        let mut store = store_with_cost("claude-a", 10.0, 1, NOW - 100 * HOUR);
        store.plans.push(claim_record(
            "s-on",
            NOW - 6 * HOUR,
            "claude-a",
            4,
            40.0,
            0.0,
            6,
        ));
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 0.0, Some(NOW + 50 * HOUR)),
                ("5시간", 0.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store,
            &request("7일", 100.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.planned.len(), 1);
        assert_eq!(account_view(&plan, "claude-a")["allowedRuns"], 1);
    }

    #[test]
    fn an_unstarted_window_gets_its_opening_run() {
        // 소비가 없는 창은 공급자가 리셋 시각을 주지 않는다. 리셋 시각이 없다고 건너뛰면
        // 창이 완전히 리셋된 계정은 사람이 한 번 쓰기 전까지 회차가 영원히 열어 주지
        // 않는다. 첫 기동 한 건으로 창을 열고, 창 전체 예산이 놀고 있으니 밀린 계정보다
        // 먼저 넣는다.
        let accounts = vec![
            account(
                "claude-a",
                "tester-a@example.com",
                ProviderId::Claude,
                usage(vec![
                    ("7일", 40.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
            account(
                "claude-b",
                "tester-b@example.com",
                ProviderId::Claude,
                usage(vec![("7일", 0.0, None), ("5시간", 0.0, None)]),
            ),
        ];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.max_runs = Some(1);
        let plan = compute_plan(
            &store_with_measurement(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let opened = account_view(&plan, "claude-b");
        assert_eq!(opened["allowedRuns"], 1);
        assert!(
            opened["skipReason"]
                .as_str()
                .is_some_and(|reason| reason.contains("창 미시작")),
            "{:?}",
            opened["skipReason"]
        );
        // claude-a도 밀려 있지만(현재 시점 목표 약 67% vs 실제 40%) 상한 1건은 미시작
        // 창이 먼저 받는다.
        assert!(account_view(&plan, "claude-a")["allowedRuns"]
            .as_u64()
            .is_some_and(|runs| runs >= 1));
        assert_eq!(plan.planned.len(), 1);
        assert_eq!(plan.planned[0].account_id, "claude-b");
    }

    #[test]
    fn an_unstarted_window_is_opened_only_once() {
        // 다른 소비자가 30분 전에 첫 기동을 예약했는데 공급자는 아직 0%·리셋 시각 없음으로
        // 답한다. 예약이 정산되기 전에 또 열면 첫 기동이 둘이 된다.
        let accounts = vec![account(
            "claude-b",
            "tester-b@example.com",
            ProviderId::Claude,
            usage(vec![("7일", 0.0, None), ("5시간", 0.0, None)]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = store_with_measurement();
        let mut claim = claim_record("s-qa", NOW - 30 * 60_000, "claude-b", 1, 2.5, 0.0, 4);
        claim.entries[0].resets_at_at_claim = None;
        store.plans.push(claim);
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "claude-b");
        assert_eq!(view["outstandingClaimPercent"], 2.5);
        assert_eq!(view["allowedRuns"], 0);
        assert!(
            view["skipReason"]
                .as_str()
                .is_some_and(|reason| reason.contains("이미 첫 기동")),
            "{:?}",
            view["skipReason"]
        );
        assert!(plan.planned.is_empty());
    }

    #[test]
    fn a_stale_zero_reading_does_not_open_a_window() {
        // 사용량 조회가 막혀 묵은 0%·리셋 시각 없음이면 창이 미시작인지 알 수 없다. 믿고
        // 열면 회차마다 첫 기동을 되풀이하며 목표에도 가드에도 안 보이는 소비가 쌓인다.
        let mut accounts = vec![account(
            "claude-b",
            "tester-b@example.com",
            ProviderId::Claude,
            usage(vec![("7일", 0.0, None), ("5시간", 0.0, None)]),
        )];
        accounts[0].usage.updated_at = Some(NOW - 6 * HOUR);
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "claude-b");
        assert_eq!(view["allowedRuns"], 0);
        assert_eq!(view["skipReason"], "창 리셋 시각을 알 수 없음");
        assert!(plan.planned.is_empty());
    }

    #[test]
    fn an_opening_run_counts_in_the_cost_measurement_and_a_reset_run_leaves_the_denominator() {
        // 한 회차 그룹에 claude-a 1건(40→42.5)과 claude-b의 첫 기동(0%·시각 없음 → 2.5%·
        // 시각 있음)이 있다. 창 열림은 리셋이 아니므로 둘 다 관측돼 회당 2.5%p다.
        let account_ids = vec!["claude-a".to_owned(), "claude-b".to_owned()];
        let mut store = PacingStore::default();
        store.plans.push(history_record(
            NOW - 6 * HOUR,
            &[("claude-a", 1), ("claude-b", 1)],
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![
                UsageSample {
                    at: NOW - 7 * HOUR,
                    used_percent: 40.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                UsageSample {
                    at: NOW - 5 * HOUR,
                    used_percent: 42.5,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
        store.series.insert(
            series_key("claude-b", "7일"),
            vec![
                UsageSample {
                    at: NOW - 7 * HOUR,
                    used_percent: 0.0,
                    resets_at: None,
                },
                UsageSample {
                    at: NOW - 5 * HOUR,
                    used_percent: 2.5,
                    resets_at: Some(NOW + 161 * HOUR),
                },
            ],
        );
        let (cost, observations) =
            measure_cost_per_run(&store, "7일", &BTreeMap::new(), &account_ids, 5, 5 * HOUR);
        assert!((cost.expect("cost") - 2.5).abs() < 1e-9);
        assert_eq!(observations, 1);
        // claude-b가 소비 중이던 창이 그 사이 진짜로 리셋됐으면 그 기동은 관측할 수 없다.
        // 분자에서 빼면 분모에서도 빼야 한다 — 그대로 두면 2.5 ÷ 2 = 1.25%p로 과소평가된다.
        store
            .series
            .get_mut(&series_key("claude-b", "7일"))
            .expect("series")[0] = UsageSample {
            at: NOW - 7 * HOUR,
            used_percent: 80.0,
            resets_at: Some(NOW - 5 * HOUR - 30 * 60_000),
        };
        let (cost, observations) =
            measure_cost_per_run(&store, "7일", &BTreeMap::new(), &account_ids, 5, 5 * HOUR);
        assert!((cost.expect("cost") - 2.5).abs() < 1e-9);
        assert_eq!(observations, 1);
    }

    #[test]
    fn the_last_round_before_reset_takes_the_remaining_line_share() {
        // 리셋 5시간 전 회차. 지금까지의 몫만 재면 목표선은 92 × 163/168 ≈ 89.3%라 실제
        // 87%와의 차이 2.3%p가 회당 2.5%p에 못 미쳐 쉬고, 리셋까지 회차가 더 없으니 5%p를
        // 남긴다. 한 회차를 앞서 보면 목표선이 92%에 닿아 남은 2건을 지금 돈다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 87.0, Some(NOW + 5 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "claude-a");
        assert!(
            view["dueRuns"]
                .as_f64()
                .is_some_and(|due| (due - 2.0).abs() < 1e-9),
            "{:?}",
            view["dueRuns"]
        );
        assert_eq!(view["allowedRuns"], 2);
        assert_eq!(plan.planned.len(), 2);
    }

    #[test]
    fn the_round_goes_to_the_account_furthest_behind_its_share() {
        // 리셋 시각과 목표가 같은데 claude-a는 55%, claude-b는 40% 사용했다. 상한이
        // 1건이면 현재 시점의 목표 사용률에서 더 밀린 claude-b가 들어간다.
        let mut accounts = two_accounts();
        accounts[0].usage.windows[0].used_percent = 55.0;
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.max_runs = Some(1);
        let plan = compute_plan(
            &PacingStore::default(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.planned.len(), 1);
        assert_eq!(plan.planned[0].account_id, "claude-b");
    }

    #[test]
    fn plan_caps_the_round_at_the_requested_maximum() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 0.0, Some(NOW + 6 * HOUR)),
                ("5시간", 0.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.max_runs = Some(3);
        let plan = compute_plan(
            &store_with_plan_measurement(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.planned.len(), 3);
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("상한 3건만")));
    }

    #[test]
    fn cost_per_run_is_measured_from_the_previous_round_and_its_samples() {
        // 지난 회차가 2건을 띄우고 그 사이 7일 창이 5%p 올랐으면 회당 2.5%p다.
        let mut store = PacingStore::default();
        store.plans.push(measured_plan(
            NOW - 5 * HOUR,
            vec![plan_entry("claude-a", 2)],
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![
                UsageSample {
                    at: NOW - 6 * HOUR,
                    used_percent: 40.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                UsageSample {
                    at: NOW - HOUR,
                    used_percent: 45.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
        let (cost, observations) = measure_cost_per_run(
            &store,
            "7일",
            &BTreeMap::new(),
            &["claude-a".to_owned()],
            DEFAULT_COST_WINDOWS,
            5 * HOUR,
        );
        assert_eq!(observations, 1);
        assert!(cost.is_some_and(|cost| (cost - 2.5).abs() < 1e-9));
    }

    #[test]
    fn cost_measurement_drops_a_round_that_did_not_actually_run() {
        // 계획은 기록됐는데 사용량이 그대로면 그 회차는 실제로 돌지 않은 것이다.
        // 평균에 넣으면 회당 소비가 0에 가까워져 다음 회차가 과다 기동한다.
        let mut store = PacingStore::default();
        store.plans.push(measured_plan(
            NOW - 5 * HOUR,
            vec![plan_entry("claude-a", 4)],
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![
                UsageSample {
                    at: NOW - 6 * HOUR,
                    used_percent: 40.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                UsageSample {
                    at: NOW - HOUR,
                    used_percent: 40.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
        let (cost, observations) = measure_cost_per_run(
            &store,
            "7일",
            &BTreeMap::new(),
            &["claude-a".to_owned()],
            DEFAULT_COST_WINDOWS,
            5 * HOUR,
        );
        assert_eq!((cost, observations), (None, 0));
    }

    #[test]
    fn cost_measurement_drops_a_span_that_outlived_the_cadence() {
        // 반복 요청을 멈췄다 켜면 마지막 계획과 다음 표본 사이가 임의로 벌어진다. 그
        // 사이 소비는 그 회차의 기동과 무관하므로 구간을 닫아 버려야 한다. 버리지 않으면
        // 중지 기간의 소비가 회당 비용으로 잡혀 재개 후 모든 계정이 쉬게 된다.
        let mut store = PacingStore::default();
        store.plans.push(measured_plan(
            NOW - 72 * HOUR,
            vec![plan_entry("claude-a", 4)],
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![
                UsageSample {
                    at: NOW - 73 * HOUR,
                    used_percent: 10.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
                // 중지 기간이 끝나고 재개한 시점의 표본. 회차 간격(5시간)의 두 배를
                // 한참 넘겨 이 회차와 이어지는 관측으로 볼 수 없다.
                UsageSample {
                    at: NOW - HOUR,
                    used_percent: 50.0,
                    resets_at: Some(NOW + 50 * HOUR),
                },
            ],
        );
        let (cost, observations) = measure_cost_per_run(
            &store,
            "7일",
            &BTreeMap::new(),
            &["claude-a".to_owned()],
            DEFAULT_COST_WINDOWS,
            5 * HOUR,
        );
        assert_eq!((cost, observations), (None, 0));
    }

    #[test]
    fn a_resumed_schedule_falls_back_to_bootstrapping() {
        // 위 구간이 버려지면 유효 관측이 0이 되고, 부트스트랩이 다시 켜져 재측정이
        // 시작된다. 별도의 초기화 조작 없이 활성 시점부터 다시 계산된다.
        let mut store = PacingStore::default();
        store.plans.push(measured_plan(
            NOW - 72 * HOUR,
            vec![plan_entry("claude-a", 4)],
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![UsageSample {
                at: NOW - HOUR,
                used_percent: 50.0,
                resets_at: Some(NOW + 50 * HOUR),
            }],
        );
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 91.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.cost_observations, 0);
        assert_eq!(plan.planned.len(), 1);
    }

    #[test]
    fn cost_measurement_drops_a_window_that_reset_in_between() {
        let mut store = PacingStore::default();
        store.plans.push(measured_plan(
            NOW - 5 * HOUR,
            vec![plan_entry("claude-a", 2)],
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            vec![
                UsageSample {
                    at: NOW - 6 * HOUR,
                    used_percent: 80.0,
                    resets_at: Some(NOW - 2 * HOUR),
                },
                UsageSample {
                    at: NOW - HOUR,
                    used_percent: 3.0,
                    resets_at: Some(NOW + 160 * HOUR),
                },
            ],
        );
        let (cost, observations) = measure_cost_per_run(
            &store,
            "7일",
            &BTreeMap::new(),
            &["claude-a".to_owned()],
            DEFAULT_COST_WINDOWS,
            5 * HOUR,
        );
        assert_eq!((cost, observations), (None, 0));
    }

    #[test]
    fn stale_runs_cover_only_finished_unattended_runtimes_in_the_same_path() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 10.0, Some(NOW + 50 * HOUR)),
                ("5시간", 5.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let chats = vec![
            finished_chat("done", "/tmp/project", true, ChatPhase::Ready),
            finished_chat("running", "/tmp/project", true, ChatPhase::Running),
            finished_chat("attended", "/tmp/project", false, ChatPhase::Ready),
            finished_chat("elsewhere", "/tmp/other", true, ChatPhase::Ready),
        ];
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &chats),
        )
        .expect("plan");
        assert_eq!(
            plan.stale_chat_ids
                .iter()
                .map(|(chat_id, _)| chat_id.as_str())
                .collect::<Vec<_>>(),
            vec!["done"]
        );
    }

    #[test]
    fn cost_floor_and_window_count_come_from_the_request() {
        // 두 값을 계약 입력으로 노출한 이유는 실측 민감도를 앱 재배포 없이 바꾸기
        // 위해서다. 기본값에 묶여 있으면 조정마다 릴리스가 필요하다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 0.0, Some(NOW + 50 * HOUR)),
                ("5시간", 0.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.fallback_cost_percent_per_run = None;
        req.min_cost_percent_per_run = Some(20.0);
        let plan = compute_plan(
            &PacingStore::default(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.min_cost_percent_per_run, 20.0);
        assert_eq!(plan.cost_percent_per_run, 20.0);
        assert_eq!(plan.cost_windows, DEFAULT_COST_WINDOWS);
    }

    #[test]
    fn plan_rejects_out_of_range_cost_settings() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 10.0, Some(NOW + 50 * HOUR)),
                ("5시간", 5.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut zero_windows = request("7일", 92.0);
        zero_windows.cost_windows = Some(0);
        assert!(compute_plan(
            &PacingStore::default(),
            &zero_windows,
            &inputs(&accounts, &schedules, &[])
        )
        .is_err());
        let mut zero_floor = request("7일", 92.0);
        zero_floor.min_cost_percent_per_run = Some(0.0);
        assert!(compute_plan(
            &PacingStore::default(),
            &zero_floor,
            &inputs(&accounts, &schedules, &[])
        )
        .is_err());
    }

    #[test]
    fn plan_requires_a_cadence_it_can_resolve() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 10.0, Some(NOW + 50 * HOUR)),
                ("5시간", 5.0, None),
            ]),
        )];
        let mut req = request("7일", 92.0);
        req.cadence_workflow_id = Some("wf-missing".to_owned());
        req.cadence_minutes = None;
        let error = compute_plan(&PacingStore::default(), &req, &inputs(&accounts, &[], &[]));
        assert!(error.is_err());
    }

    #[test]
    fn samples_that_bracket_a_recorded_run_survive_the_cap() {
        // 5분 폴링이 상한을 다 채워도 실행 앞뒤 표본은 남아야 한다. 이게 밀려나면 지난
        // 회차의 회당 소비를 다시 잴 근거가 사라진다.
        let dir = tempfile::tempdir().expect("tempdir");
        let run_started = NOW + 60_000;
        let run_ended = run_started + 30 * 60_000;
        let mut store = PacingStore::default();
        store.runs.push(run_record(
            "run-0",
            "s-qa",
            None,
            "claude-a",
            run_started,
            Some(run_ended),
        ));
        save_store(dir.path(), &store).expect("seed store");
        for index in 0..(MAX_SAMPLES_PER_SERIES * 2) {
            let mut view = usage(vec![("7일", index as f64, Some(NOW + 50 * HOUR))]);
            view.updated_at = Some(NOW + index as i64 * 5 * 60_000);
            record_usage_sample(dir.path(), "claude-a", &view);
        }
        let store = load_store(dir.path()).expect("load");
        let series = store
            .series
            .get(&series_key("claude-a", "7일"))
            .expect("series");
        // 칸은 늘지 않는다. 지킨 두 개 대신 최근 표본이 그만큼 덜 남을 뿐이다.
        assert_eq!(series.len(), MAX_SAMPLES_PER_SERIES);
        // 지킨 표본은 나머지보다 한참 오래됐다 — 그냥 오래된 것부터 버렸으면 사라졌을
        // 자리다.
        assert!(series[2].at - series[1].at > HOUR);
        let before = series
            .iter()
            .rev()
            .find(|sample| sample.at <= run_started)
            .expect("실행 시작 이전 표본");
        let after = series
            .iter()
            .find(|sample| sample.at >= run_ended)
            .expect("실행 종료 이후 표본");
        assert!(after.at - run_ended <= RUN_AFTER_SAMPLE_GRACE_MS);
        assert!(before.used_percent < after.used_percent);
        // 표본은 시간순을 유지한다.
        assert!(series.windows(2).all(|pair| pair[0].at < pair[1].at));
    }

    #[test]
    fn samples_are_recorded_per_window_and_capped() {
        let dir = tempfile::tempdir().expect("tempdir");
        for index in 0..(MAX_SAMPLES_PER_SERIES + 5) {
            let mut view = usage(vec![("7일", index as f64, Some(NOW + 50 * HOUR))]);
            view.updated_at = Some(NOW + index as i64 * 60_000);
            record_usage_sample(dir.path(), "claude-a", &view);
        }
        let store = load_store(dir.path()).expect("load");
        let series = store
            .series
            .get(&series_key("claude-a", "7일"))
            .expect("series");
        assert_eq!(series.len(), MAX_SAMPLES_PER_SERIES);
        assert!(series
            .last()
            .is_some_and(|sample| sample.used_percent == (MAX_SAMPLES_PER_SERIES + 4) as f64));
    }

    /// 다른 소비자가 남긴 예약 기록. `count`가 0이면 존재 표시만이다.
    fn claim_record(
        consumer: &str,
        at: i64,
        account_id: &str,
        count: usize,
        expected: f64,
        baseline: f64,
        max_runs: usize,
    ) -> PlanRecord {
        PlanRecord {
            execution_id: None,
            at,
            window_label: "7일".to_owned(),
            entries: if count == 0 {
                Vec::new()
            } else {
                vec![PlanRecordEntry {
                    window_label: None,
                    guards: BTreeMap::new(),
                    account_id: account_id.to_owned(),
                    count,
                    expected_cost_percent: Some(expected),
                    used_percent_at_claim: Some(baseline),
                    resets_at_at_claim: Some(NOW + 50 * HOUR),
                }]
            },
            consumer_id: Some(consumer.to_owned()),
            workflow_id: Some("wf-other".to_owned()),
            cadence_ms: Some(5 * HOUR),
            cwd: Some("/tmp/other".to_owned()),
            max_runs: Some(max_runs),
        }
    }

    fn account_view<'a>(plan: &'a PacingPlan, account_id: &str) -> &'a Value {
        plan.accounts
            .iter()
            .find(|view| view["accountId"] == account_id)
            .expect("account view")
    }

    #[test]
    fn the_consumer_is_the_single_enabled_schedule_running_the_workflow() {
        let req = request("7일", 92.0);
        let one = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            workflow_schedule("s-off", "wf-qa", 5, false),
        ];
        assert_eq!(resolve_consumer_id(&req, &one), "s-on");
        // 같은 워크플로를 두 반복 요청이 돌리면 어느 쪽인지 알 수 없어 워크플로 id로.
        let two = vec![
            workflow_schedule("s-a", "wf-qa", 5, true),
            workflow_schedule("s-b", "wf-qa", 5, true),
        ];
        assert_eq!(resolve_consumer_id(&req, &two), "wf-qa");
        let mut adhoc = request("7일", 92.0);
        adhoc.cadence_workflow_id = None;
        assert_eq!(resolve_consumer_id(&adhoc, &one), ADHOC_CONSUMER_ID);
    }

    #[test]
    fn a_second_consumer_deducts_the_first_consumers_outstanding_claim() {
        // 7일 창 40%, 목표 92, 회당 2.5%p(실측) → 남은 20.8건, 건당 144분, 5시간 회차
        // 몫 3건. 30분 전 QA가 2건(기대 5%p)을 예약했는데 표본은 아직 40%다. 그 5%p를
        // 빼면 남은 18.8건·건당 160분이라 회차 몫이 2건으로 줄어든다. QA는 예약을 남긴
        // 뒤이므로 배분에서 다시 몫을 잡지 않는다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        // 다른 소비자 s-qa도 켜진 회차다. 기록만 있고 반복 요청이 없는 소비자(지워진 회차)는
        // 몫을 나누지 않는다 — 여기서는 예약 차감과 활성 표시를 함께 본다.
        let schedules = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            workflow_schedule("s-qa", "wf-other", 5, true),
        ];
        let control = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("control plan");
        assert_eq!(control.planned.len(), 3);

        let mut store = store_with_measurement();
        store.plans.push(claim_record(
            "s-qa",
            NOW - 30 * 60_000,
            "claude-a",
            2,
            5.0,
            40.0,
            4,
        ));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.consumer_id, "s-on");
        assert_eq!(plan.active_consumers, vec!["s-qa".to_owned()]);
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["outstandingClaimPercent"], 5.0);
        assert_eq!(view["netHeadroomPercent"], 47.0);
        assert_eq!(view["budgetRuns"], 2);
        // 예약을 남긴 소비자는 수요를 다시 잡지 않으므로 남은 2건은 전부 이쪽 몫이다.
        assert_eq!(view["allowedRuns"], view["budgetRuns"]);
        assert_eq!(plan.planned.len(), 2);
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("미정산 예약 5.00%p")));
    }

    #[test]
    fn a_consumer_without_a_schedule_takes_no_share_even_with_a_recent_record() {
        // 회귀 방지: 지워진 회차의 계획 기록은 저장소에 남는다. 기록만으로 활성을 판정하면
        // 그 회차가 기록이 밀려날 때까지 몫을 잡아 실제로 도는 회차가 그만큼 쉰다. 기록이
        // 30분 전이라도 반복 요청이 없으면 창을 나눠 쓰는 회차가 아니다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = store_with_measurement();
        store.plans.push(claim_record(
            "s-deleted",
            NOW - 30 * 60_000,
            "claude-a",
            0,
            0.0,
            0.0,
            4,
        ));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(
            plan.active_consumers.is_empty(),
            "{:?}",
            plan.active_consumers
        );
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["allowedRuns"], view["budgetRuns"]);
    }

    #[test]
    fn an_active_consumer_without_an_open_claim_shares_the_round_runs() {
        // 9시간 전에 0건 계획(존재 표시)만 남긴 소비자도 활성이다. 회차 몫 3건을 둘이
        // 나눠 이쪽은 2건. 예약이 없으니 여유 차감은 없다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        // 다른 소비자 s-qa도 켜진 회차다. 기록만 있고 반복 요청이 없는 소비자(지워진 회차)는
        // 몫을 나누지 않으므로 활성이 되려면 회차가 있어야 한다. 수요는 그 회차의 병렬 실행
        // 설정(4건)에서 읽는다.
        let schedules = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            paced_schedule("s-qa", "wf-other", 5, true, Some(4)),
        ];
        let mut store = store_with_measurement();
        store.plans.push(claim_record(
            "s-qa",
            NOW - 9 * HOUR,
            "claude-a",
            0,
            0.0,
            0.0,
            4,
        ));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["outstandingClaimPercent"], 0.0);
        assert_eq!(view["budgetRuns"], 3);
        assert_eq!(view["allowedRuns"], 2);
        assert_eq!(plan.planned.len(), 2);
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("다른 소비자 1개와 회차 기동 수를 나눕니다: s-qa")));
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("3건 중 2건만") && line.contains("다른 소비자와 나눔")));
    }

    #[test]
    fn legacy_plan_records_without_consumer_are_measurement_only() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.cost_source, "measured");
        assert!((plan.cost_percent_per_run - 2.5).abs() < 1e-9);
        assert!(plan.active_consumers.is_empty());
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            0.0
        );
    }

    #[test]
    fn reasoning_effort_ladder_steps_from_high_by_headroom_runs_per_round() {
        let claude = |ratio: Option<f64>| reasoning_effort_for_headroom(ProviderId::Claude, ratio);
        assert_eq!(claude(None), ReasoningEffort::High);
        assert_eq!(claude(Some(0.2)), ReasoningEffort::Low);
        assert_eq!(claude(Some(0.7)), ReasoningEffort::Medium);
        assert_eq!(claude(Some(1.0)), ReasoningEffort::High);
        assert_eq!(claude(Some(1.9)), ReasoningEffort::High);
        assert_eq!(claude(Some(2.0)), ReasoningEffort::Xhigh);
        assert_eq!(claude(Some(4.0)), ReasoningEffort::Max);
        assert_eq!(claude(Some(f64::NAN)), ReasoningEffort::High);
        // 사다리가 짧은 공급자는 끝에서 멈춘다.
        assert_eq!(
            reasoning_effort_for_headroom(ProviderId::Codex, Some(9.0)),
            ReasoningEffort::Xhigh
        );
        assert_eq!(
            reasoning_effort_for_headroom(ProviderId::Antigravity, Some(9.0)),
            ReasoningEffort::High
        );
        assert_eq!(
            reasoning_effort_for_headroom(ProviderId::Antigravity, Some(0.1)),
            ReasoningEffort::Low
        );
        assert_eq!(
            default_paced_reasoning_effort(ProviderId::Codex),
            ReasoningEffort::High
        );
    }

    #[test]
    fn planned_runs_carry_a_reasoning_effort_chosen_from_account_headroom() {
        // 7일 창 회당 2.5%p 실측, 리셋까지 50시간 = 10회차. 가드 5시간 창은 회당 1%p에 여유
        // 75%p, 리셋까지 1회차라 계획 창이 더 빡빡하다.
        let plan_for = |used: f64| {
            let accounts = vec![account(
                "claude-a",
                "tester-a@example.com",
                ProviderId::Claude,
                usage(vec![
                    ("7일", used, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            )];
            let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
            compute_plan(
                &store_with_measurement(),
                &request("7일", 92.0),
                &inputs(&accounts, &schedules, &[]),
            )
            .expect("plan")
        };
        // 여유 52%p ÷ 2.5 = 20.8건 ÷ 10회차 = 2.08 → 한 단계 위.
        let plan = plan_for(40.0);
        let view = account_view(&plan, "claude-a");
        assert!((view["headroomRunsPerRound"].as_f64().expect("ratio") - 2.08).abs() < 0.01);
        assert_eq!(view["reasoningEffort"], "xhigh");
        assert!(!plan.planned.is_empty());
        assert!(plan
            .planned
            .iter()
            .all(|run| run.reasoning_effort == Some(ReasoningEffort::Xhigh)));
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("추론수준") && line.contains("xhigh(2.08건/회차)")));
        // 여유 17%p → 6.8건 ÷ 10회차 = 0.68 → 한 단계 아래.
        assert_eq!(
            account_view(&plan_for(75.0), "claude-a")["reasoningEffort"],
            "medium"
        );
        // 여유 7%p → 2.8건 ÷ 10회차 = 0.28 → 두 단계 아래.
        assert_eq!(
            account_view(&plan_for(85.0), "claude-a")["reasoningEffort"],
            "low"
        );
    }

    #[test]
    fn a_fixed_lane_reasoning_effort_replaces_the_headroom_ladder() {
        // 여력 판정이면 xhigh가 될 상황(2.08건/회차)이라도 레인 설정의 고정값이 이긴다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut policy = UsageBudgetPolicy::default();
        policy.consumers.insert(
            "s-on".to_owned(),
            crate::usage_budget_policy::ConsumerBudgetConfig {
                enabled: true,
                workflow_id: Some("wf-qa".to_owned()),
                reasoning_efforts: BTreeMap::from([(
                    ProviderId::Claude,
                    LaneReasoningEffort {
                        fixed: Some(ReasoningEffort::Low),
                        max_auto: None,
                        min_auto: None,
                    },
                )]),
                ..Default::default()
            },
        );
        let mut inputs = inputs(&accounts, &schedules, &[]);
        inputs.policy = Some(&policy);
        let plan =
            compute_plan(&store_with_measurement(), &request("7일", 92.0), &inputs).expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["reasoningEffort"], "low");
        assert_eq!(view["reasoningEffortSource"], "fixed");
        assert!(!plan.planned.is_empty());
        assert!(plan.planned.iter().all(|run| {
            run.reasoning_effort == Some(ReasoningEffort::Low)
                && run.reasoning_effort_source == Some("fixed")
                && run.headroom_runs_per_round.is_none()
        }));
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("low(레인 설정 고정)")));
    }

    #[test]
    fn an_auto_lane_cap_holds_the_headroom_ladder_down() {
        // 여력 2.08건/회차 → xhigh지만 Claude 레인 상한 high가 천장이다. 다른 레인의 설정은 무관.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut policy = UsageBudgetPolicy::default();
        policy.consumers.insert(
            "s-on".to_owned(),
            crate::usage_budget_policy::ConsumerBudgetConfig {
                enabled: true,
                workflow_id: Some("wf-qa".to_owned()),
                reasoning_efforts: BTreeMap::from([
                    (
                        ProviderId::Claude,
                        LaneReasoningEffort {
                            fixed: None,
                            max_auto: Some(ReasoningEffort::High),
                            min_auto: None,
                        },
                    ),
                    (
                        ProviderId::Codex,
                        LaneReasoningEffort {
                            fixed: Some(ReasoningEffort::Low),
                            max_auto: None,
                            min_auto: None,
                        },
                    ),
                ]),
                ..Default::default()
            },
        );
        let mut inputs = inputs(&accounts, &schedules, &[]);
        inputs.policy = Some(&policy);
        let plan =
            compute_plan(&store_with_measurement(), &request("7일", 92.0), &inputs).expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["reasoningEffort"], "high");
        assert_eq!(view["reasoningEffortSource"], "auto");
        assert_eq!(view["reasoningEffortCap"], "high");
        assert!(plan.planned.iter().all(|run| {
            run.reasoning_effort == Some(ReasoningEffort::High)
                && run.reasoning_effort_source == Some("auto")
                && run.headroom_runs_per_round.is_some()
        }));
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("high(2.08건/회차, 상한 high)")));
        // 상한이 판정보다 위면 아무것도 바꾸지 않는다.
        assert_eq!(
            ReasoningLadder::of(ProviderId::Claude)
                .cap(ReasoningEffort::Medium, ReasoningEffort::Xhigh),
            ReasoningEffort::Medium
        );
        // 사다리 밖 상한(Codex의 max)은 끝 칸(xhigh)으로 읽힌다.
        assert_eq!(
            ReasoningLadder::of(ProviderId::Codex)
                .cap(ReasoningEffort::Xhigh, ReasoningEffort::Max),
            ReasoningEffort::Xhigh
        );
    }

    #[test]
    fn fixed_efforts_are_clamped_to_the_provider_ladder() {
        assert_eq!(
            ReasoningLadder::of(ProviderId::Codex).clamp(ReasoningEffort::Max),
            ReasoningEffort::Xhigh
        );
        assert_eq!(
            ReasoningLadder::of(ProviderId::Antigravity).clamp(ReasoningEffort::Xhigh),
            ReasoningEffort::High
        );
        assert_eq!(
            ReasoningLadder::of(ProviderId::Claude).clamp(ReasoningEffort::Minimal),
            ReasoningEffort::Low
        );
        assert_eq!(
            ReasoningLadder::of(ProviderId::Claude).clamp(ReasoningEffort::Max),
            ReasoningEffort::Max
        );
        assert_eq!(
            ReasoningLadder::of(ProviderId::Codex)
                .clamp(ReasoningEffort::Other("turbo".to_owned())),
            ReasoningEffort::Other("turbo".to_owned())
        );
    }

    #[test]
    fn unmeasured_cost_keeps_the_default_reasoning_effort() {
        // 계획 창 회당 소비가 대체값이면 여력 배수는 근거가 없어 기본 수준을 쓴다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 60.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store_with_guard_measurement(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.cost_source, "fallback");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["headroomRunsPerRound"], Value::Null);
        assert_eq!(view["reasoningEffort"], "high");
        assert!(!plan.planned.is_empty());
        assert!(plan
            .planned
            .iter()
            .all(|run| run.reasoning_effort == Some(ReasoningEffort::High)));
    }

    #[test]
    fn cost_measurement_closes_an_epoch_at_the_next_group() {
        // 10시간 전 2건, 5시간 전 2건. 첫 구간의 "다음 표본"은 5시간 전 회차가 시작되기
        // 전의 것(45)이어야 한다. 예전처럼 간격×2 안 최신(55)을 잡으면 두 번째 회차의
        // 소비까지 첫 회차 2건에 실려 회당 7.5%p로 부풀었다.
        let mut store = PacingStore::default();
        for at in [NOW - 10 * HOUR, NOW - 5 * HOUR] {
            store
                .plans
                .push(measured_plan(at, vec![plan_entry("claude-a", 2)]));
        }
        store.series.insert(
            series_key("claude-a", "7일"),
            [
                (NOW - 11 * HOUR, 40.0),
                (NOW - 6 * HOUR, 45.0),
                (NOW - HOUR, 55.0),
            ]
            .into_iter()
            .map(|(at, used_percent)| UsageSample {
                at,
                used_percent,
                resets_at: Some(NOW + 50 * HOUR),
            })
            .collect(),
        );
        let (cost, observations) = measure_cost_per_run(
            &store,
            "7일",
            &BTreeMap::new(),
            &["claude-a".to_owned()],
            DEFAULT_COST_WINDOWS,
            5 * HOUR,
        );
        // (5 + 10) / (2 + 2)
        assert_eq!(observations, 2);
        assert!(cost.is_some_and(|cost| (cost - 3.75).abs() < 1e-9));
    }

    #[test]
    fn plan_records_a_claim_and_preview_records_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let req = request("7일", 92.0);
        // 가드·계획 창 회당 소비가 실측된 저장소에서 시작한다(어느 쪽이든 미측정이면 계정당
        // 1건으로 묶인다).
        save_store(dir.path(), &store_with_plan_measurement()).expect("seed");
        plan_and_record(dir.path(), &req, &inputs(&accounts, &schedules, &[])).expect("record");
        let store = load_store(dir.path()).expect("store");
        assert_eq!(store.plans.len(), 2);
        let record = store.plans.last().expect("record");
        assert_eq!(record.consumer_id.as_deref(), Some("s-on"));
        assert_eq!(record.workflow_id.as_deref(), Some("wf-qa"));
        assert_eq!(record.cadence_ms, Some(5 * HOUR));
        assert_eq!(record.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(record.max_runs, Some(6));
        // 여유 52%p, 실측 회당 소비 2.0%p → 남은 26건. 리셋까지 50시간이라 건당 115분,
        // 5시간 회차 몫은 3건이다. 기대 소비는 3 × 2.0, 기준선은 예약 시점의 창 값.
        assert_eq!(record.entries.len(), 1);
        let entry = &record.entries[0];
        assert_eq!(entry.count, 3);
        assert_eq!(entry.expected_cost_percent, Some(6.0));
        assert_eq!(entry.used_percent_at_claim, Some(40.0));
        assert_eq!(entry.resets_at_at_claim, Some(NOW + 50 * HOUR));

        let before = fs::read(dir.path().join(STORE_FILE)).expect("read");
        preview_usage_paced_runs(dir.path(), &req, &accounts, &schedules, &[]).expect("preview");
        assert_eq!(fs::read(dir.path().join(STORE_FILE)).expect("read"), before);
    }

    /// 기동하지 못한 건의 예약은 닫는다. 그대로 두면 소비가 없는 예약이 다음 회차까지
    /// 살아남아 같은 계정을 한 번 더 쉬게 만든다. 여러 건을 배정받은 계정은 실패한 수만큼만
    /// 줄여야 한다 — 통째로 지우면 실제로 도는 건의 소비가 미정산에서 빠진다.
    #[test]
    fn a_launch_that_never_started_releases_its_claim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.execution_id = Some("wfround-abc".to_owned());
        save_store(dir.path(), &store_with_plan_measurement()).expect("seed");
        plan_and_record(dir.path(), &req, &inputs(&accounts, &schedules, &[])).expect("record");
        let entry = |store: &PacingStore| store.plans.last().expect("record").entries[0].clone();
        let claimed = entry(&load_store(dir.path()).expect("store"));
        assert_eq!(claimed.count, 3);
        assert_eq!(claimed.expected_cost_percent, Some(6.0));
        let guard_cost = claimed
            .guards
            .values()
            .next()
            .and_then(|guard| guard.expected_cost_percent)
            .expect("가드 예약");

        // 세 건 중 두 건만 떴다. 나머지 한 건의 예약만 닫힌다.
        for chat in ["chat-1", "chat-2"] {
            update_store(
                dir.path(),
                || "seed".to_owned(),
                |store| {
                    store.runs.push(RunRecord {
                        execution_id: Some("wfround-abc".to_owned()),
                        ..run_record(chat, "s-on", None, "claude-a", NOW - 60_000, None)
                    });
                    true
                },
            );
        }
        settle_unlaunched_claims(dir.path(), "wfround-abc");
        let after = entry(&load_store(dir.path()).expect("store"));
        assert_eq!(after.count, 2);
        assert_eq!(after.expected_cost_percent, Some(4.0));
        let after_guard = after
            .guards
            .values()
            .next()
            .and_then(|guard| guard.expected_cost_percent)
            .expect("가드 예약");
        assert!(
            (after_guard - guard_cost * 2.0 / 3.0).abs() < 1e-9,
            "가드 예약도 같은 비율로 줄어야 한다: {after_guard}"
        );

        // 한 번 더 불러도 같은 값이다 — 정산은 실제 실행 수에 맞추는 것이지 깎는 것이 아니다.
        settle_unlaunched_claims(dir.path(), "wfround-abc");
        assert_eq!(entry(&load_store(dir.path()).expect("store")).count, 2);

        // 다른 실행의 예약은 건드리지 않는다.
        settle_unlaunched_claims(dir.path(), "wfround-other");
        assert_eq!(entry(&load_store(dir.path()).expect("store")).count, 2);
    }

    /// 한 건도 뜨지 못한 회차는 항목 자체가 사라진다.
    #[test]
    fn a_round_that_launched_nothing_drops_its_claim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.execution_id = Some("wfround-abc".to_owned());
        save_store(dir.path(), &store_with_guard_measurement()).expect("seed");
        plan_and_record(dir.path(), &req, &inputs(&accounts, &schedules, &[])).expect("record");
        settle_unlaunched_claims(dir.path(), "wfround-abc");
        let store = load_store(dir.path()).expect("store");
        assert!(store.plans.last().expect("record").entries.is_empty());
    }

    /// 기동 단계의 실패에는 런타임이 아예 못 뜬 경우와 떴는데 그 뒤가 실패한 경우가 함께
    /// 들어 있다. 뒤쪽은 소비가 이미 일어났으므로 그 몫의 예약까지 닫으면 사라진 소비만큼
    /// 다음 회차가 더 띄운다.
    #[test]
    fn a_claim_backed_by_a_started_run_is_not_released() {
        let dir = tempfile::tempdir().expect("tempdir");
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.execution_id = Some("wfround-abc".to_owned());
        let mut seed = store_with_plan_measurement();
        // 세 건 중 한 건은 실제로 떴다.
        seed.runs.push(RunRecord {
            execution_id: Some("wfround-abc".to_owned()),
            ..run_record("chat-live", "s-on", None, "claude-a", NOW - 60_000, None)
        });
        save_store(dir.path(), &seed).expect("seed");
        plan_and_record(dir.path(), &req, &inputs(&accounts, &schedules, &[])).expect("record");
        let count = |dir: &std::path::Path| {
            load_store(dir)
                .expect("store")
                .plans
                .last()
                .expect("record")
                .entries[0]
                .count
        };
        assert_eq!(count(dir.path()), 3);

        // 남은 두 건이 못 뜨면 그 둘만 닫힌다. 뜬 한 건의 예약은 표본이 따라올 때까지 남는다.
        settle_unlaunched_claims(dir.path(), "wfround-abc");
        assert_eq!(count(dir.path()), 1);
    }

    #[test]
    fn empty_plan_records_presence_only() {
        // 목표에 이미 닿아 0건인 회차도 기록은 남긴다. 다른 소비자는 이 기록으로 이 창을
        // 쓰는 소비자가 있음을 알지만, 기대 소비가 없어 여유에서 빼지는 않는다.
        let dir = tempfile::tempdir().expect("tempdir");
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 92.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            workflow_schedule("s-other", "wf-other", 5, true),
        ];
        plan_and_record(
            dir.path(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("record");
        let store = load_store(dir.path()).expect("store");
        assert_eq!(store.plans.len(), 1);
        assert!(store.plans[0].entries.is_empty());
        assert_eq!(store.plans[0].consumer_id.as_deref(), Some("s-on"));

        let mut other = request("7일", 92.0);
        other.cadence_workflow_id = Some("wf-other".to_owned());
        let plan = compute_plan(&store, &other, &inputs(&accounts, &schedules, &[])).expect("plan");
        assert_eq!(plan.consumer_id, "s-other");
        assert_eq!(plan.active_consumers, vec!["s-on".to_owned()]);
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            0.0
        );
    }

    fn origin_for(consumer: &str, workflow: &str, execution: &str) -> crate::domain::ChatOrigin {
        crate::domain::ChatOrigin {
            kind: crate::domain::ChatOriginKind::Workflow,
            workflow_id: Some(workflow.to_owned()),
            execution_id: Some(execution.to_owned()),
            schedule_id: Some(consumer.to_owned()),
            run_id: None,
            consumer_id: Some(consumer.to_owned()),
        }
    }

    fn run_record(
        chat_id: &str,
        consumer: &str,
        execution: Option<&str>,
        account_id: &str,
        started_at: i64,
        ended_at: Option<i64>,
    ) -> RunRecord {
        RunRecord {
            chat_id: chat_id.to_owned(),
            execution_id: execution.map(str::to_owned),
            consumer_id: consumer.to_owned(),
            workflow_id: Some("wf-qa".to_owned()),
            account_id: account_id.to_owned(),
            provider: ProviderId::Claude,
            started_at,
            ended_at,
            provider_session_id: None,
            tokens: None,
            reasoning_effort: None,
            model: None,
        }
    }

    /// 모델군을 가려야 하는 Antigravity 실행 기록.
    fn antigravity_run_record(
        chat_id: &str,
        consumer: &str,
        account_id: &str,
        model: &str,
        started_at: i64,
        ended_at: Option<i64>,
    ) -> RunRecord {
        RunRecord {
            provider: ProviderId::Antigravity,
            model: Some(model.to_owned()),
            ..run_record(chat_id, consumer, None, account_id, started_at, ended_at)
        }
    }

    fn samples(points: &[(i64, f64)]) -> Vec<UsageSample> {
        points
            .iter()
            .map(|(at, used_percent)| UsageSample {
                at: *at,
                used_percent: *used_percent,
                resets_at: Some(NOW + 50 * HOUR),
            })
            .collect()
    }

    #[test]
    fn trigger_consumer_overrides_the_schedule_bridge() {
        let mut req = request("7일", 92.0);
        req.trigger_consumer_id = Some("schedule-exact".to_owned());
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        assert_eq!(resolve_consumer_id(&req, &schedules), "schedule-exact");
    }

    #[test]
    fn stale_runs_match_the_consumer_origin_not_the_cwd() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        // 이 소비자의 런타임은 경로가 달라도 정리 대상, 다른 소비자의 런타임은 같은 경로여도
        // 건드리지 않고, 출처 없는 옛 런타임만 경로로 고른다.
        let mut mine = finished_chat("mine", "/somewhere/else", true, ChatPhase::Ready);
        mine.origin = Some(origin_for("s-on", "wf-qa", "exec-1"));
        let mut theirs = finished_chat("theirs", "/tmp/project", true, ChatPhase::Ready);
        theirs.origin = Some(origin_for("s-other", "wf-other", "exec-2"));
        let legacy = finished_chat("legacy", "/tmp/project", true, ChatPhase::Ready);
        let mut same_workflow_manual = finished_chat("manual", "/tmp/x", true, ChatPhase::Ready);
        same_workflow_manual.origin = Some(crate::domain::ChatOrigin {
            schedule_id: None,
            consumer_id: Some("wf-qa".to_owned()),
            ..origin_for("s-on", "wf-qa", "exec-3")
        });
        // 같은 워크플로를 도는 **다른 반복 요청**의 런타임은 건드리지 않는다. 워크플로
        // 일치로도 집으면 QA를 종류별로 둘 돌리는 구성에서 서로의 끝난 런타임을 끄고,
        // 아직 회수하지 않은 결과가 사라진다.
        let mut sibling_schedule = finished_chat("sibling", "/tmp/project", true, ChatPhase::Ready);
        sibling_schedule.origin = Some(origin_for("s-sibling", "wf-qa", "exec-4"));
        // AIA나 사용자가 직접 띄운 무인 런타임은 출처는 있지만 반복 요청·워크플로가 없다.
        // 같은 경로라도 이 회차의 것이 아니므로 결과를 회수하기 전에 끄지 않는다.
        let mut aia_direct = finished_chat("aia-direct", "/tmp/project", true, ChatPhase::Ready);
        aia_direct.origin = Some(crate::domain::ChatOrigin::direct(
            crate::domain::ChatOriginKind::Aia,
        ));
        let chats = vec![
            mine,
            theirs,
            legacy,
            same_workflow_manual,
            sibling_schedule,
            aia_direct,
        ];
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &chats),
        )
        .expect("plan");
        let mut stale: Vec<&str> = plan
            .stale_chat_ids
            .iter()
            .map(|(chat_id, _)| chat_id.as_str())
            .collect();
        stale.sort();
        assert_eq!(stale, vec!["legacy", "manual", "mine"]);
    }

    #[test]
    fn a_claim_stays_open_while_its_run_is_still_running() {
        // 예약 TTL(발행자 간격)은 스케줄러가 다음 회차를 띄우는 시각과 정확히 같다. 그
        // 시각에 실행이 아직 돌고 있으면 소비가 표본에 없는데, TTL로 닫으면 자기 다음
        // 회차가 같은 계정에 또 기동한다 — 회차당 1건인 공유 워크트리에 런타임이 둘 뜬다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = store_with_measurement();
        // 자기 소비자가 정확히 한 간격 전에 낸 예약. 실행은 시작만 있고 끝이 없으며 그
        // 채팅은 아직 돌고 있다.
        let mut claim = claim_record("s-on", NOW - 5 * HOUR, "claude-a", 2, 5.0, 40.0, 4);
        claim.execution_id = Some("exec-on".to_owned());
        store.plans.push(claim);
        let run_index = store.runs.len();
        store.runs.push(run_record(
            "on-1",
            "s-on",
            Some("exec-on"),
            "claude-a",
            NOW - 5 * HOUR + 60_000,
            None,
        ));
        let running = finished_chat("on-1", "/tmp/project", true, ChatPhase::Running);
        let mut req = request("7일", 92.0);
        req.max_runs = Some(1);
        let plan = compute_plan(
            &store,
            &req,
            &inputs(&accounts, &schedules, std::slice::from_ref(&running)),
        )
        .expect("plan");
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            5.0
        );
        // 예약을 살려 두는 것만으로는 부족하다 — 직선은 한 회차 앞을 보므로 이 계정은
        // 여전히 만기다. 동시 기동 상한 1건을 진행 중 실행이 차지해 이번 회차는 비운다.
        assert!(plan.planned.is_empty(), "{:?}", plan.planned);
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("아직 진행 중")));
        // 런타임이 종료 훅 없이 사라졌으면(백엔드 재기동 등) 기록의 종료 시각은 영영 비어
        // 있다. 살아 있는 채팅이 아니면 예약은 TTL대로 닫히고 상한도 돌아온다.
        let plan = compute_plan(&store, &req, &inputs(&accounts, &schedules, &[])).expect("plan");
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            0.0
        );
        assert_eq!(plan.planned.len(), 1);
        // 실행이 끝나면 TTL이 그대로 닫는다(끝난 뒤의 소비는 회차 첫 단계의 사용량 갱신이
        // 표본으로 가져온다).
        store.runs[run_index].ended_at = Some(NOW - 60_000);
        let plan = compute_plan(
            &store,
            &req,
            &inputs(&accounts, &schedules, std::slice::from_ref(&running)),
        )
        .expect("plan");
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            0.0
        );
    }

    #[test]
    fn a_claim_survives_the_providers_reset_time_jitter() {
        // 공급자 리셋 시각은 표본마다 1초쯤 흔들린다. 예약의 리셋 시각과 완전 일치를
        // 요구하면 그 흔들림에 예약이 사라져 아직 보이지 않는 소비를 두 번 계산한다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR + 1_000)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = store_with_measurement();
        store.plans.push(claim_record(
            "s-qa",
            NOW - 30 * 60_000,
            "claude-a",
            2,
            5.0,
            40.0,
            4,
        ));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            5.0
        );
    }

    #[test]
    fn a_claim_settles_when_all_its_runs_ended_and_a_sample_followed() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = store_with_measurement();
        let mut claim = claim_record("s-qa", NOW - 30 * 60_000, "claude-a", 2, 5.0, 40.0, 4);
        claim.execution_id = Some("exec-qa".to_owned());
        store.plans.push(claim);
        store.runs.push(run_record(
            "qa-1",
            "s-qa",
            Some("exec-qa"),
            "claude-a",
            NOW - 29 * 60_000,
            Some(NOW - 10 * 60_000),
        ));
        // 실행은 끝났지만 그 뒤 표본이 없다 → 아직 미정산.
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            5.0
        );
        // 종료 뒤 표본이 들어오면 그 소비는 표본에 보이므로 예약은 정산된다.
        store
            .series
            .get_mut(&series_key("claude-a", "7일"))
            .expect("series")
            .push(UsageSample {
                at: NOW - 5 * 60_000,
                used_percent: 45.0,
                resets_at: Some(NOW + 50 * HOUR),
            });
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(
            account_view(&plan, "claude-a")["outstandingClaimPercent"],
            0.0
        );
    }

    #[test]
    fn consumer_cost_uses_clean_brackets_at_full_weight() {
        // s-qa의 실행 두 번, 각각 3%p. 겹치는 실행이 없어 가중 1씩 → 합 2로 채택.
        let mut store = PacingStore::default();
        store.runs.push(run_record(
            "r1",
            "s-qa",
            None,
            "claude-a",
            NOW - 10 * HOUR,
            Some(NOW - 9 * HOUR),
        ));
        store.runs.push(run_record(
            "r2",
            "s-qa",
            None,
            "claude-a",
            NOW - 5 * HOUR,
            Some(NOW - 4 * HOUR),
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            samples(&[
                (NOW - 10 * HOUR - 5 * 60_000, 40.0),
                (NOW - 9 * HOUR + 2 * 60_000, 43.0),
                (NOW - 5 * HOUR - 5 * 60_000, 43.0),
                (NOW - 4 * HOUR + 3 * 60_000, 46.0),
            ]),
        );
        let (cost, weight) = measure_consumer_cost(
            &store,
            "s-qa",
            ProviderId::Claude,
            "7일",
            DEFAULT_COST_WINDOWS,
        )
        .expect("consumer cost");
        assert!((cost - 3.0).abs() < 1e-9);
        assert!((weight - 2.0).abs() < 1e-9);
        // 다른 소비자·다른 공급자는 이 관측을 쓰지 않는다.
        assert!(measure_consumer_cost(&store, "s-other", ProviderId::Claude, "7일", 5).is_none());
        assert!(measure_consumer_cost(&store, "s-qa", ProviderId::Codex, "7일", 5).is_none());
    }

    #[test]
    fn overlapping_runs_split_growth_by_active_time_at_half_weight() {
        // s-qa [0,60분]과 s-other [30,90분]이 같은 계정에서 겹침. 합집합 구간 증가 6%p를
        // 활성 시간 60:60으로 나눠 s-qa는 3%p, 가중 0.5. 깨끗한 관측 4%p 둘이 더해지면
        // 가중 합 2.5, 가중 평균 3.8.
        let base = NOW - 20 * HOUR;
        let mut store = PacingStore::default();
        store.runs.push(run_record(
            "q",
            "s-qa",
            None,
            "claude-a",
            base,
            Some(base + HOUR),
        ));
        store.runs.push(run_record(
            "o",
            "s-other",
            None,
            "claude-a",
            base + 30 * 60_000,
            Some(base + 90 * 60_000),
        ));
        store.runs.push(run_record(
            "c1",
            "s-qa",
            None,
            "claude-a",
            NOW - 10 * HOUR,
            Some(NOW - 9 * HOUR),
        ));
        store.runs.push(run_record(
            "c2",
            "s-qa",
            None,
            "claude-a",
            NOW - 5 * HOUR,
            Some(NOW - 4 * HOUR),
        ));
        store.series.insert(
            series_key("claude-a", "7일"),
            samples(&[
                (base - 60_000, 30.0),
                (base + 90 * 60_000 + 60_000, 36.0),
                (NOW - 10 * HOUR - 60_000, 40.0),
                (NOW - 9 * HOUR + 60_000, 44.0),
                (NOW - 5 * HOUR - 60_000, 44.0),
                (NOW - 4 * HOUR + 60_000, 48.0),
            ]),
        );
        let (cost, weight) = measure_consumer_cost(
            &store,
            "s-qa",
            ProviderId::Claude,
            "7일",
            DEFAULT_COST_WINDOWS,
        )
        .expect("consumer cost");
        assert!((weight - 2.5).abs() < 1e-9);
        assert!((cost - 3.8).abs() < 1e-9, "cost {cost}");
    }

    /// 다른 모델군의 실행은 이 창을 1%p도 올리지 않으므로 겹침으로 세지 않는다. 함께 세면
    /// 혼자 낸 증가가 절반으로 깎여 회당 소비를 실제의 절반으로 실측하고, 구간이 남의 종료까지
    /// 늘어나 뒤 표본을 놓치면 관측이 통째로 버려져 창이 영영 미실측으로 남는다.
    #[test]
    fn a_run_of_another_model_group_is_not_an_overlap_of_this_window() {
        let base = NOW - 20 * HOUR;
        let label = "Claude and GPT models · 7일";
        let mut store = PacingStore::default();
        for (index, (start, end)) in [
            (base, base + HOUR),
            (NOW - 10 * HOUR, NOW - 9 * HOUR),
            (NOW - 5 * HOUR, NOW - 4 * HOUR),
        ]
        .into_iter()
        .enumerate()
        {
            store.runs.push(antigravity_run_record(
                &format!("c{index}"),
                "s-qa",
                "antigravity-acd",
                "claude-opus-4-6-thinking",
                start,
                Some(end),
            ));
        }
        // Gemini 회차가 첫 실행에 겹쳐 돌고, 그보다 한참 뒤에 끝난다.
        store.runs.push(antigravity_run_record(
            "g",
            "s-other",
            "antigravity-acd",
            "gemini-3.8-flash-high",
            base + 30 * 60_000,
            Some(base + 3 * HOUR),
        ));
        store.series.insert(
            series_key("antigravity-acd", label),
            samples(&[
                (base - 60_000, 30.0),
                (base + HOUR + 60_000, 34.0),
                (NOW - 10 * HOUR - 60_000, 34.0),
                (NOW - 9 * HOUR + 60_000, 38.0),
                (NOW - 5 * HOUR - 60_000, 38.0),
                (NOW - 4 * HOUR + 60_000, 42.0),
            ]),
        );
        let (cost, weight) = measure_consumer_cost(
            &store,
            "s-qa",
            ProviderId::Antigravity,
            label,
            DEFAULT_COST_WINDOWS,
        )
        .expect("consumer cost");
        // 겹침으로 셌다면 첫 관측은 뒤 표본을 놓쳐 버려지고(가중 2), 살아남았더라도 2%p로
        // 깎였을 것이다.
        assert!((weight - 3.0).abs() < 1e-9, "weight {weight}");
        assert!((cost - 4.0).abs() < 1e-9, "cost {cost}");
    }

    #[test]
    fn consumer_cost_falls_back_to_global_below_two_weighted_observations() {
        // 실행 기록이 하나뿐이면(가중 1) 회차별 추정은 채택되지 않고 전역 실측(2.5)이 쓰인다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut store = store_with_measurement();
        store.runs.push(run_record(
            "r1",
            "s-on",
            None,
            "claude-a",
            NOW - 3 * HOUR,
            Some(NOW - 2 * HOUR),
        ));
        // 표본 시계열은 시각 순이어야 한다(갱신이 순서대로 붙인다).
        let series = store
            .series
            .get_mut(&series_key("claude-a", "7일"))
            .expect("series");
        series.extend(samples(&[
            (NOW - 3 * HOUR - 60_000, 42.0),
            (NOW - 2 * HOUR + 60_000, 46.0),
        ]));
        series.sort_by_key(|sample| sample.at);
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert!(plan.consumer_costs.is_empty());
        assert_eq!(account_view(&plan, "claude-a")["costPercentPerRun"], 2.5);
        // 두 번째 깨끗한 관측이 들어오면 이 소비자의 값(4.0)으로 바뀐다.
        store.runs.push(run_record(
            "r2",
            "s-on",
            None,
            "claude-a",
            NOW - 50 * 60_000,
            Some(NOW - 20 * 60_000),
        ));
        let series = store
            .series
            .get_mut(&series_key("claude-a", "7일"))
            .expect("series");
        series.extend(samples(&[
            (NOW - 51 * 60_000, 46.0),
            (NOW - 19 * 60_000, 50.0),
        ]));
        series.sort_by_key(|sample| sample.at);
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(
            plan.consumer_costs
                .get(&ProviderId::Claude)
                .map(|(c, _)| *c),
            Some(4.0)
        );
        assert_eq!(account_view(&plan, "claude-a")["costPercentPerRun"], 4.0);
    }

    #[test]
    fn run_records_are_written_once_and_closed_by_the_last_turn() {
        let dir = tempfile::tempdir().expect("tempdir");
        let start = || RunStart {
            chat_id: "chat-1".to_owned(),
            execution_id: Some("exec-1".to_owned()),
            consumer_id: "s-on".to_owned(),
            workflow_id: Some("wf-qa".to_owned()),
            account_id: "claude-a".to_owned(),
            provider: ProviderId::Claude,
            started_at: NOW,
            reasoning_effort: None,
            model: None,
        };
        record_run_started(dir.path(), start());
        record_run_started(dir.path(), start());
        record_run_ended(
            dir.path(),
            "chat-1",
            NOW + HOUR,
            Some("session-1".to_owned()),
            None,
        );
        record_run_ended(dir.path(), "chat-1", NOW + 30 * 60_000, None, None);
        let store = load_store(dir.path()).expect("store");
        assert_eq!(store.runs.len(), 1);
        assert_eq!(store.runs[0].ended_at, Some(NOW + HOUR));
        assert_eq!(
            store.runs[0].provider_session_id.as_deref(),
            Some("session-1")
        );
    }

    fn inputs_with_policy<'a>(
        accounts: &'a [ProviderAccountView],
        schedules: &'a [ScheduledRequest],
        policy: &'a UsageBudgetPolicy,
    ) -> PacingInputs<'a> {
        PacingInputs {
            now: NOW,
            accounts,
            schedules,
            chats: &[],
            policy: Some(policy),
            pacing_workflow_ids: None,
        }
    }

    fn two_accounts() -> Vec<ProviderAccountView> {
        vec![
            account(
                "claude-a",
                "tester-a@example.com",
                ProviderId::Claude,
                usage(vec![
                    ("7일", 40.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
            account(
                "claude-b",
                "tester-b@example.com",
                ProviderId::Claude,
                usage(vec![
                    ("7일", 40.0, Some(NOW + 50 * HOUR)),
                    ("5시간", 10.0, Some(NOW + HOUR)),
                ]),
            ),
        ]
    }

    fn pool_policy(enabled: &[&str]) -> UsageBudgetPolicy {
        let mut policy = UsageBudgetPolicy::default();
        for id in enabled {
            policy.accounts.insert(
                (*id).to_owned(),
                crate::usage_budget_policy::AccountBudgetConfig {
                    pacing_enabled: true,
                    target_percent: None,
                    guard_percent: None,
                    drain_notice_credit_id: None,
                },
            );
        }
        policy
    }

    fn consumer_config(
        enabled: bool,
        priority: u8,
    ) -> crate::usage_budget_policy::ConsumerBudgetConfig {
        crate::usage_budget_policy::ConsumerBudgetConfig {
            enabled,
            priority,
            ..Default::default()
        }
    }

    #[test]
    fn only_pool_accounts_are_candidates_when_a_pool_exists() {
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let policy = pool_policy(&["claude-b"]);
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        let ids: Vec<&str> = plan
            .accounts
            .iter()
            .map(|view| view["accountId"].as_str().expect("id"))
            .collect();
        assert_eq!(ids, vec!["claude-b"]);
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("정책 계정 풀 1개")));
    }

    #[test]
    fn argument_filters_narrow_within_the_pool() {
        // 풀에는 둘 다 있지만 인자 emailPrefix가 tester-a만 고른다.
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let policy = pool_policy(&["claude-a", "claude-b"]);
        let mut req = request("7일", 92.0);
        req.email_prefix = Some("tester-a".to_owned());
        let plan = compute_plan(
            &PacingStore::default(),
            &req,
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert_eq!(plan.accounts.len(), 1);
        assert_eq!(plan.accounts[0]["accountId"], "claude-a");
        // 풀 밖 계정만 남는 필터는 후보가 없어 오류다.
        let mut req = request("7일", 92.0);
        req.email_prefix = Some("tester-a".to_owned());
        let policy = pool_policy(&["claude-b"]);
        assert!(matches!(
            compute_plan(
                &PacingStore::default(),
                &req,
                &inputs_with_policy(&accounts, &schedules, &policy)
            ),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn empty_policy_falls_back_to_legacy_filters() {
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let policy = UsageBudgetPolicy::default();
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert_eq!(plan.accounts.len(), 2);
        assert!(!plan.blocked);
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("정책에 켜진 계정이 없어")));
    }

    #[test]
    fn disabled_consumer_plans_zero_runs_with_reason_and_records_nothing() {
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut policy = UsageBudgetPolicy::default();
        policy
            .consumers
            .insert("s-other".to_owned(), consumer_config(true, 50));
        // s-on은 등록되지 않았다 → 선택이 켜진 상태에서 미등록은 막힌다.
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(plan.blocked);
        assert!(plan.planned.is_empty());
        assert_eq!(
            plan.accounts[0]["skipReason"],
            "페이싱 대상으로 선택되지 않은 반복 요청"
        );
        // 기록도 남기지 않는다.
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = inputs_with_policy(&accounts, &schedules, &policy);
        plan_and_record(dir.path(), &request("7일", 92.0), &inputs).expect("record");
        assert!(load_store(dir.path()).expect("store").plans.is_empty());
        // 등록해 켜면 기동한다.
        policy
            .consumers
            .insert("s-on".to_owned(), consumer_config(true, 50));
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(!plan.blocked);
        assert!(!plan.planned.is_empty());
    }

    #[test]
    fn workflow_accounts_narrow_candidates_within_the_pool() {
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut policy = pool_policy(&["claude-a", "claude-b"]);
        policy.workflows.insert(
            "wf-qa".to_owned(),
            crate::usage_budget_policy::WorkflowBudgetConfig {
                pacing_enabled: true,
                accounts: ["claude-b".to_owned()].into_iter().collect(),
            },
        );
        let plan = compute_plan(
            &PacingStore::default(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(!plan.planned.is_empty());
        assert!(plan.planned.iter().all(|run| run.account_id == "claude-b"));
    }

    #[test]
    fn policy_caps_the_requested_target_and_guard() {
        // 요청 92/85, 정책 기본 목표 60. 창이 118/168 지났고 한 회차(5시간)를 앞서 보면
        // 현재 시점의 목표는 60 × 123/168 ≈ 43.9%다. 실제 40%와 차이 3.9%p가 회당 소비
        // 2.5%p를 넘어 1건 돈다(지금까지의 몫 42.1%만 재면 2.1%p라 쉬었을 것).
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 50.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut policy = UsageBudgetPolicy::default();
        policy.defaults.target_percent = Some(60.0);
        let plan = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["targetPercent"], 60.0);
        assert_eq!(view["headroomPercent"], 20.0);
        assert_eq!(view["allowedRuns"], 1);
        // 공통 유효값은 최상단, 계정 override까지 적용한 값은 계정 행에 실린다.
        assert_eq!(plan.target_percent, 60.0);
        assert_eq!(plan.guard_label.as_deref(), Some("5시간"));
        assert_eq!(plan.guard_percent, Some(85.0));
        assert_eq!(view["guardLabel"], "5시간");
        assert_eq!(view["guardPercent"], 85.0);
        let rendered = render_plan(&request("7일", 92.0), &plan).expect("render plan");
        assert_eq!(rendered["window"]["targetPercent"], 60.0);
        assert_eq!(rendered["window"]["guardPercent"], 85.0);
        assert_eq!(rendered["accounts"][0]["guardPercent"], 85.0);
        policy.accounts.insert(
            "claude-a".to_owned(),
            crate::usage_budget_policy::AccountBudgetConfig {
                pacing_enabled: true,
                target_percent: None,
                guard_percent: Some(45.0),
                drain_notice_credit_id: None,
            },
        );
        let account_override = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("account override plan");
        assert_eq!(account_override.guard_percent, Some(85.0));
        let view = account_view(&account_override, "claude-a");
        assert_eq!(view["guardPercent"], 45.0);
        assert_eq!(view["skipReason"], "5시간 창 45% 초과");

        // 가드도 캡이다: 요청 85, 정책 40 → 5시간 창 50%는 초과.
        policy.defaults.guard_percent = Some(40.0);
        let plan = compute_plan(
            &store_with_measurement(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert_eq!(
            account_view(&plan, "claude-a")["skipReason"],
            "5시간 창 40% 초과"
        );
    }

    #[test]
    fn a_request_without_window_or_target_fills_from_policy_defaults() {
        let mut policy = UsageBudgetPolicy::default();
        policy.defaults.window_label = Some("7일".to_owned());
        policy.defaults.target_percent = Some(60.0);
        let mut bare = request("", 0.0);
        bare.target_percent = None;
        let resolved = fill_from_policy(&bare, Some(&policy));
        assert_eq!(resolved.window_label, "7일");
        assert_eq!(resolved.target_percent, Some(60.0));
        // 인자를 명시한 요청은 그대로 두고, 정책과의 조정은 캡 계산이 맡는다.
        let resolved = fill_from_policy(&request("5시간", 92.0), Some(&policy));
        assert_eq!(resolved.window_label, "5시간");
        assert_eq!(resolved.target_percent, Some(92.0));
    }

    #[test]
    fn an_unresolved_window_or_target_names_the_pacing_tab_in_the_error() {
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let error = compute_plan(
            &PacingStore::default(),
            &request("", 92.0),
            &inputs(&accounts, &schedules, &[]),
        )
        .expect_err("창 없이 계획이 나오면 안 된다");
        assert!(error.to_string().contains("워크플로 페이싱 탭"));
        let mut bare = request("7일", 0.0);
        bare.target_percent = None;
        let error = compute_plan(
            &PacingStore::default(),
            &bare,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect_err("목표 없이 계획이 나오면 안 된다");
        assert!(error.to_string().contains("워크플로 페이싱 탭"));
    }

    #[test]
    fn a_paused_consumer_does_not_take_a_share_even_with_a_recent_record() {
        // 우선순위가 높은 다른 소비자가 30분 전에 기록을 남겼지만 그 반복 요청은 일시정지다.
        // 다음 회차를 띄우지 않을 소비자에게 몫을 주면 이쪽은 간격 두 번 동안 통째로 쉰다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            workflow_schedule("s-qa", "wf-other", 5, false),
        ];
        let mut policy = UsageBudgetPolicy::default();
        policy
            .consumers
            .insert("s-on".to_owned(), consumer_config(true, 50));
        policy
            .consumers
            .insert("s-qa".to_owned(), consumer_config(true, 10));
        let mut store = store_with_measurement();
        store.plans.push(claim_record(
            "s-qa",
            NOW - 30 * 60_000,
            "claude-a",
            0,
            0.0,
            0.0,
            4,
        ));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(
            plan.active_consumers.is_empty(),
            "{:?}",
            plan.active_consumers
        );
        let view = account_view(&plan, "claude-a");
        assert_eq!(view["allowedRuns"], view["budgetRuns"]);
        assert!(view["allowedRuns"].as_u64().is_some_and(|runs| runs >= 1));
        // 같은 소비자의 반복 요청이 켜져 있으면 예전처럼 몫을 나눈다. 수요 4는 그 회차의
        // 병렬 실행 설정에서 읽는다.
        let schedules = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            paced_schedule("s-qa", "wf-other", 5, true, Some(4)),
        ];
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert_eq!(plan.active_consumers, vec!["s-qa".to_owned()]);
        assert_eq!(account_view(&plan, "claude-a")["allowedRuns"], 0);
    }

    #[test]
    fn priority_orders_the_round_runs_and_an_idle_consumer_releases_its_share() {
        // 회차 몫 3건(여유 52%p·회당 2.5%p → 남은 20.8건, 건당 144분). 우선순위 10(숫자가
        // 낮아 더 높음)인 다른 소비자가 활성이면(존재 기록) 그 수요 4가 먼저 채워져
        // 이쪽(50)은 0건.
        // 그 소비자가 2×간격 넘게 쉬면 몫이 돌아온다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        // 다른 소비자 s-qa도 켜진 회차다. 기록만 있고 반복 요청이 없는 소비자(지워진 회차)는
        // 몫을 나누지 않으므로 우선순위 배분에도 들지 않는다. 수요 4는 그 회차의 병렬 실행
        // 설정에서 읽는다.
        let schedules = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            paced_schedule("s-qa", "wf-other", 5, true, Some(4)),
        ];
        let mut policy = UsageBudgetPolicy::default();
        policy
            .consumers
            .insert("s-on".to_owned(), consumer_config(true, 50));
        policy
            .consumers
            .insert("s-qa".to_owned(), consumer_config(true, 10));
        let mut store = store_with_measurement();
        store.plans.push(claim_record(
            "s-qa",
            NOW - 9 * HOUR,
            "claude-a",
            0,
            0.0,
            0.0,
            4,
        ));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert_eq!(account_view(&plan, "claude-a")["budgetRuns"], 3);
        assert_eq!(account_view(&plan, "claude-a")["allowedRuns"], 0);
        assert!(
            plan.reasoning
                .iter()
                .any(|line| line.contains("다른 소비자가 먼저 받아"))
                || plan.accounts[0]["skipReason"]
                    .as_str()
                    .is_some_and(|s| s.contains("다른 소비자가 먼저 받아"))
        );
        // 우선순위가 뒤집히면 이쪽이 먼저 받는다.
        policy
            .consumers
            .insert("s-qa".to_owned(), consumer_config(true, 80));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert_eq!(account_view(&plan, "claude-a")["allowedRuns"], 3);
        // 상위 소비자가 11시간 동안 기록이 없으면 활성이 아니라 몫이 아래로 흐른다.
        policy
            .consumers
            .insert("s-qa".to_owned(), consumer_config(true, 10));
        let mut idle = store_with_measurement();
        idle.plans.push(claim_record(
            "s-qa",
            NOW - 11 * HOUR,
            "claude-a",
            0,
            0.0,
            0.0,
            4,
        ));
        let plan = compute_plan(
            &idle,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(plan.active_consumers.is_empty());
        assert_eq!(account_view(&plan, "claude-a")["allowedRuns"], 3);
    }

    #[test]
    fn a_sharers_configured_parallel_setting_wins_over_its_last_plan_record() {
        // 위 시험과 같은 풀. 우선순위가 높은 s-qa의 지난 기록은 4건이지만 반복 요청 설정은
        // 병렬 실행 없음(1건)이다 — 수요는 설정이 정본이라 1건만 먼저 받고, 이쪽이 3건 중
        // 2건을 받는다. 옛 규칙(기록 4, 기록이 없으면 12)이면 이쪽은 0건이었다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![
            workflow_schedule("s-on", "wf-qa", 5, true),
            workflow_schedule("s-qa", "wf-other", 5, true),
        ];
        let mut policy = UsageBudgetPolicy::default();
        policy
            .consumers
            .insert("s-on".to_owned(), consumer_config(true, 50));
        policy
            .consumers
            .insert("s-qa".to_owned(), consumer_config(true, 10));
        let mut store = store_with_measurement();
        store.plans.push(claim_record(
            "s-qa",
            NOW - 9 * HOUR,
            "claude-a",
            0,
            0.0,
            0.0,
            4,
        ));
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert_eq!(account_view(&plan, "claude-a")["budgetRuns"], 3);
        assert_eq!(account_view(&plan, "claude-a")["allowedRuns"], 2);
        assert_eq!(plan.planned.len(), 2);
    }

    #[test]
    fn a_request_without_max_runs_plans_with_the_triggers_parallel_setting() {
        // 봉투는 항상 건수를 싣지만 preview는 생략할 수 있다. 그때는 이 소비자(wf-qa를
        // 도는 유일한 활성 회차 s-on)의 병렬 실행 설정으로 계획하고, 설정이 없으면 1건,
        // 0은 거절한다. 옛 규칙은 12건으로 계획해 실제 회차보다 과대 보고했다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 0.0, Some(NOW + 6 * HOUR)),
                ("5시간", 0.0, None),
            ]),
        )];
        let mut req = request("7일", 92.0);
        req.max_runs = None;
        let configured = vec![paced_schedule("s-on", "wf-qa", 5, true, Some(2))];
        let plan = compute_plan(
            &store_with_plan_measurement(),
            &req,
            &inputs(&accounts, &configured, &[]),
        )
        .expect("plan");
        assert_eq!(plan.max_runs, 2);
        assert_eq!(plan.planned.len(), 2);
        assert!(plan
            .reasoning
            .iter()
            .any(|line| line.contains("반복 요청 설정 2건으로 계획")));
        let unconfigured = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let plan = compute_plan(
            &store_with_plan_measurement(),
            &req,
            &inputs(&accounts, &unconfigured, &[]),
        )
        .expect("plan");
        assert_eq!(plan.max_runs, 1);
        assert_eq!(plan.planned.len(), 1);
        req.max_runs = Some(0);
        assert!(matches!(
            compute_plan(
                &store_with_plan_measurement(),
                &req,
                &inputs(&accounts, &configured, &[]),
            ),
            Err(CoreError::InvalidInput(message)) if message.contains("병렬 실행")
        ));
    }

    #[test]
    fn a_large_max_runs_is_not_clamped_and_the_budget_bounds_the_round() {
        // 옛 상한 12를 넘는 요청도 그대로 받는다. 회차 크기는 상한이 아니라 계정 여력이
        // 정하므로 계획 건수는 계정의 allowedRuns와 같고, "상한 N건만" 사유는 붙지 않는다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 0.0, Some(NOW + 6 * HOUR)),
                ("5시간", 0.0, None),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut req = request("7일", 92.0);
        req.max_runs = Some(50);
        let plan = compute_plan(
            &store_with_plan_measurement(),
            &req,
            &inputs(&accounts, &schedules, &[]),
        )
        .expect("plan");
        assert_eq!(plan.max_runs, 50);
        let allowed = account_view(&plan, "claude-a")["allowedRuns"]
            .as_u64()
            .expect("allowedRuns") as usize;
        assert!(
            allowed >= 3,
            "여력이 3건은 되어야 시험이 뜻을 가진다: {allowed}"
        );
        assert_eq!(plan.planned.len(), allowed);
        assert!(!plan
            .reasoning
            .iter()
            .any(|line| line.contains("상한 50건만")));
    }

    #[test]
    fn budget_overview_reports_pool_targets_claims_and_consumer_costs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let mut policy = pool_policy(&["claude-a"]);
        policy.defaults.target_percent = Some(90.0);
        // 가드·계획 창 회당 소비가 실측된 저장소에서 회차 하나를 기록해 예약과 존재를 남긴다.
        save_store(dir.path(), &store_with_plan_measurement()).expect("seed");
        plan_and_record(
            dir.path(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("record");
        let overview = budget_overview(
            dir.path(),
            &policy,
            &accounts,
            &["s-on".to_owned()],
            &["s-on".to_owned()].into_iter().collect(),
        )
        .expect("overview");
        assert_eq!(overview["windowLabel"], "7일");
        assert_eq!(overview["cadenceMinutes"], 300);
        let rows = overview["accounts"].as_array().expect("accounts");
        assert_eq!(rows.len(), 2);
        let a = rows
            .iter()
            .find(|row| row["accountId"] == "claude-a")
            .expect("a");
        let b = rows
            .iter()
            .find(|row| row["accountId"] == "claude-b")
            .expect("b");
        assert_eq!(a["inPool"], true);
        assert_eq!(b["inPool"], false);
        assert_eq!(a["targetPercent"], 90.0);
        // 방금 남긴 예약(회차 몫 3건 × 2.0)은 표본에 아직 안 보여 미정산이다.
        assert_eq!(a["outstandingClaimPercent"], 6.0);
        // 가드 창(5시간)도 같은 예약을 자기 회당 소비(1.0)로 든다. 정책에 가드 상한이 없으면
        // 순여유는 없다(null).
        assert_eq!(a["guards"][0]["label"], "5시간");
        assert_eq!(a["guards"][0]["outstandingClaimPercent"], 3.0);
        assert!(a["guards"][0]["netHeadroomPercent"].is_null());
        assert_eq!(overview["activeConsumers"], json!(["s-on"]));
        assert_eq!(overview["consumerCosts"]["s-on"]["recordedRuns"], 0);
    }

    /// 창을 나눠 쓰지 않는 회차(일시정지 등)는 최근 기록이 남아 있어도 화면의 활성 소비자가
    /// 아니다 — 자동 주기·수요 계산이 몫을 나눌 때 세는 집합과 같아야 "활성"과 "비활성"이
    /// 한 행에 같이 붙지 않는다.
    #[test]
    fn budget_overview_excludes_non_sharing_consumers_from_active_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let accounts = two_accounts();
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let policy = pool_policy(&["claude-a"]);
        plan_and_record(
            dir.path(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("record");
        let overview = budget_overview(
            dir.path(),
            &policy,
            &accounts,
            &["s-on".to_owned()],
            &BTreeSet::new(),
        )
        .expect("overview");
        assert_eq!(overview["activeConsumers"], json!([]));
        // 활성에서 빠져도 소비자 자체는 현황에 남는다(회당 소비·설정은 계속 보여야 한다).
        assert!(overview["consumerCosts"]["s-on"].is_object());
    }

    fn tokens(total: u64) -> TokenUsage {
        TokenUsage {
            input: total / 2,
            output: total - total / 2,
            cache_read: 0,
            cache_write: 0,
        }
    }

    /// 깨끗한 실행 n개를 시각 순으로 만들고 각 실행의 증가(%p)와 토큰을 심는다.
    fn store_with_consumer_runs(consumer: &str, runs: &[(f64, Option<u64>)]) -> PacingStore {
        let mut store = PacingStore::default();
        let mut series = Vec::new();
        let mut used = 10.0;
        for (index, (growth, tokens_total)) in runs.iter().enumerate() {
            let start = NOW - (runs.len() as i64 - index as i64) * 3 * HOUR;
            let end = start + HOUR;
            let mut record = run_record(
                &format!("run-{index}"),
                consumer,
                None,
                "claude-a",
                start,
                Some(end),
            );
            record.tokens = tokens_total.map(tokens);
            record.provider_session_id = Some(format!("session-{index}"));
            store.runs.push(record);
            series.push((start - 60_000, used));
            used += growth;
            series.push((end + 60_000, used));
        }
        store
            .series
            .insert(series_key("claude-a", "7일"), samples(&series));
        store
    }

    #[test]
    fn baseline_is_the_median_of_the_first_n_runs_and_current_of_the_last_windows() {
        // 처음 3회 3,5,4 → 기준선 4. 마지막 2회 2,2 → 현재 2. 토큰 기준선 1000·현재 500.
        let store = store_with_consumer_runs(
            "s-qa",
            &[
                (3.0, Some(900)),
                (5.0, Some(1_200)),
                (4.0, Some(1_000)),
                (2.0, Some(500)),
                (2.0, Some(500)),
            ],
        );
        let report = consumer_savings(&store, "s-qa", ProviderId::Claude, "7일", 3, 2, None, None);
        assert_eq!(report.observations, 5);
        assert_eq!(report.baseline_cost_percent, Some(4.0));
        assert_eq!(report.current_cost_percent, Some(2.0));
        assert_eq!(report.baseline_tokens, Some(1_000.0));
        assert_eq!(report.current_tokens, Some(500.0));
        assert_eq!(report.metric, Some("tokens"));
        assert!((report.achieved_reduction_percent.unwrap() - 50.0).abs() < 1e-9);
        assert!(report.over_ceiling.is_none());
    }

    #[test]
    fn the_effort_stays_cheap_while_the_budget_is_what_limits_the_rounds() {
        // 산출물은 같은 창으로 몇 건을 해냈느냐다. 예산이 제약인 동안에는 싼 등급이 곧
        // 더 많은 건수이므로 깊게 갈 이유가 없다.
        let costs = BTreeMap::from([
            (ReasoningEffort::Low, 1.0),
            (ReasoningEffort::Medium, 2.0),
            (ReasoningEffort::High, 3.0),
            (ReasoningEffort::Max, 5.0),
        ]);
        let pick = |headroom: f64, remaining: usize, max_runs: usize| {
            effort_within_headroom(
                ProviderId::Claude,
                &costs,
                headroom,
                remaining,
                max_runs,
                ReasoningEffort::High,
            )
        };
        // 남은 20회차 × 1병렬 = 20건. 싸게 다 채우면 20%p인데 여유는 10%p뿐이다 → 회전 우선.
        assert_eq!(pick(10.0, 20, 1).0, ReasoningEffort::Low);
        // 여유가 넉넉해도 최대 회전으로 다 쓸 수 있으면 여전히 싸게 돈다.
        assert_eq!(pick(20.0, 20, 1).0, ReasoningEffort::Low);
    }

    #[test]
    fn only_a_surplus_that_would_expire_buys_a_deeper_effort() {
        let costs = BTreeMap::from([
            (ReasoningEffort::Low, 1.0),
            (ReasoningEffort::Medium, 2.0),
            (ReasoningEffort::High, 3.0),
            (ReasoningEffort::Max, 5.0),
        ]);
        let pick = |headroom: f64, remaining: usize, max_runs: usize| {
            effort_within_headroom(
                ProviderId::Claude,
                &costs,
                headroom,
                remaining,
                max_runs,
                ReasoningEffort::High,
            )
        };
        // 2회차 × 1병렬 = 2건뿐인데 여유가 10%p다. 싸게 돌면 8%p가 리셋 때 사라진다 →
        // 건당 5%p까지 쓸 수 있으므로 max.
        let (effort, basis) = pick(10.0, 2, 1);
        assert_eq!(effort, ReasoningEffort::Max);
        assert_eq!(basis, "surplus");
        // 건당 몫이 3.3%p면 high까지만 오른다.
        assert_eq!(pick(10.0, 3, 1).0, ReasoningEffort::High);
        // 병렬이 늘면 회전으로 다 쓸 수 있어 다시 싸게 돈다.
        assert_eq!(pick(10.0, 2, 5).0, ReasoningEffort::Low);
    }

    #[test]
    fn without_measured_costs_the_old_headroom_ladder_still_decides() {
        // 표본이 없다는 것과 감당 못 한다는 것은 다르다. 실측이 없으면 옛 판정으로 물러난다.
        let empty = BTreeMap::new();
        let (effort, basis) = effort_within_headroom(
            ProviderId::Claude,
            &empty,
            100.0,
            1,
            1,
            ReasoningEffort::Medium,
        );
        assert_eq!(effort, ReasoningEffort::Medium);
        assert_eq!(basis, "auto");
    }

    #[test]
    fn the_floor_stops_the_controller_from_going_below_what_a_person_set() {
        let lane = crate::usage_budget_policy::LaneReasoningEffort {
            fixed: None,
            max_auto: Some(ReasoningEffort::High),
            min_auto: Some(ReasoningEffort::Medium),
        };
        // 여력이 바닥이라 자동은 low를 고르지만, 사람이 정한 바닥이 medium에서 멈춘다.
        let selected = select_reasoning_effort(
            ProviderId::Claude,
            Some(&lane),
            Some(0.1),
            0,
            None,
            0.0,
            0,
            1,
        );
        assert_eq!(selected.effort, ReasoningEffort::Medium);
        // 절감 압력이 더 밀어도 바닥 아래로는 못 간다.
        let pressed = select_reasoning_effort(
            ProviderId::Claude,
            Some(&lane),
            Some(0.1),
            -1,
            None,
            0.0,
            0,
            1,
        );
        assert_eq!(pressed.effort, ReasoningEffort::Medium);
        // 천장도 그대로 지킨다.
        let raised = select_reasoning_effort(
            ProviderId::Claude,
            Some(&lane),
            Some(9.0),
            1,
            None,
            0.0,
            0,
            1,
        );
        assert_eq!(raised.effort, ReasoningEffort::High);
    }

    #[test]
    fn a_spend_profile_stands_in_for_lanes_that_were_never_set_by_hand() {
        use crate::usage_budget_policy::SpendProfile;
        assert_eq!(
            SpendProfile::Saver.bounds(),
            (Some(ReasoningEffort::Low), Some(ReasoningEffort::Low))
        );
        assert_eq!(
            SpendProfile::Goal.bounds(),
            (Some(ReasoningEffort::High), Some(ReasoningEffort::Medium))
        );
        assert_eq!(
            SpendProfile::Quality.bounds(),
            (Some(ReasoningEffort::Max), Some(ReasoningEffort::High))
        );
    }

    #[test]
    fn observations_carry_the_reasoning_effort_that_ran_them() {
        // 등급이 관측까지 실려야 계획이 고른 등급과 그 등급의 실제 값이 짝지어진다.
        let mut store = store_with_consumer_runs("s-qa", &[(4.0, Some(1_000)), (9.0, Some(4_000))]);
        store.runs[0].reasoning_effort = Some(ReasoningEffort::Low);
        store.runs[1].reasoning_effort = Some(ReasoningEffort::Max);
        let observations = consumer_observations(&store, "s-qa", ProviderId::Claude, "7일");
        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].reasoning_effort, Some(ReasoningEffort::Low));
        assert_eq!(observations[1].reasoning_effort, Some(ReasoningEffort::Max));
        // 등급을 남기지 않은 옛 기록은 그대로 비어 있고 집계에서 빠진다.
        store.runs[1].reasoning_effort = None;
        let observations = consumer_observations(&store, "s-qa", ProviderId::Claude, "7일");
        assert_eq!(observations[1].reasoning_effort, None);
    }

    #[test]
    fn a_frozen_baseline_stops_the_target_from_sliding_when_old_observations_drop() {
        // 처음 3회 3,5,4 → 기준선 4. 그 기준선을 붙박은 뒤 앞의 두 관측이 창 리셋으로
        // 사라져도 기준선은 4로 남아야 한다. 붙박지 않으면 남은 관측의 "처음 3회"를
        // 다시 집어 과녁이 앞으로 미끄러진다.
        let mut store = store_with_consumer_runs(
            "s-qa",
            &[
                (3.0, Some(900)),
                (5.0, Some(1_200)),
                (4.0, Some(1_000)),
                (2.0, Some(500)),
                (2.0, Some(500)),
            ],
        );
        assert!(freeze_ready_baselines(
            &mut store,
            "s-qa",
            "7일",
            &BTreeMap::new(),
            3,
            1_000
        ));
        let key = baseline_key("s-qa", ProviderId::Claude, "7일");
        assert_eq!(store.baselines[&key].cost_percent, Some(4.0));
        assert_eq!(store.baselines[&key].tokens, Some(1_000.0));
        assert_eq!(store.baselines[&key].runs, 3);

        // 앞선 관측 둘이 사라진 상태를 흉내 낸다.
        store.runs.drain(..2);
        let report = consumer_savings(&store, "s-qa", ProviderId::Claude, "7일", 3, 2, None, None);
        assert_eq!(report.baseline_tokens, Some(1_000.0));
        assert_eq!(report.baseline_fixed_at, Some(1_000));
        assert!((report.achieved_reduction_percent.unwrap() - 50.0).abs() < 1e-9);
    }

    #[test]
    fn a_baseline_is_frozen_once_and_never_recomputed() {
        let mut store = store_with_consumer_runs("s-qa", &[(4.0, None), (4.0, None)]);
        assert!(freeze_ready_baselines(
            &mut store,
            "s-qa",
            "7일",
            &BTreeMap::new(),
            2,
            500
        ));
        // 두 번째 호출은 아무것도 새로 확정하지 않는다.
        assert!(!freeze_ready_baselines(
            &mut store,
            "s-qa",
            "7일",
            &BTreeMap::new(),
            2,
            9_999
        ));
        let key = baseline_key("s-qa", ProviderId::Claude, "7일");
        assert_eq!(store.baselines[&key].fixed_at, 500);
    }

    #[test]
    fn a_baseline_is_not_frozen_before_the_first_n_runs_are_in() {
        let mut store = store_with_consumer_runs("s-qa", &[(4.0, None)]);
        assert!(!freeze_ready_baselines(
            &mut store,
            "s-qa",
            "7일",
            &BTreeMap::new(),
            3,
            100
        ));
        assert!(store.baselines.is_empty());
    }

    #[test]
    fn achieved_reduction_falls_back_to_cost_percent_without_tokens() {
        // Codex처럼 토큰이 없으면 창 %p로 잰다. 기준선 4 → 현재 5는 -25%(늘었다).
        let store = store_with_consumer_runs("s-qa", &[(4.0, None), (4.0, None), (5.0, None)]);
        let report = consumer_savings(&store, "s-qa", ProviderId::Claude, "7일", 2, 1, None, None);
        assert_eq!(report.metric, Some("costPercent"));
        assert!((report.achieved_reduction_percent.unwrap() + 25.0).abs() < 1e-9);
        // 기준선 회차가 다 모이기 전엔 달성률을 내지 않는다.
        let early = store_with_consumer_runs("s-qa", &[(4.0, None)]);
        let report = consumer_savings(&early, "s-qa", ProviderId::Claude, "7일", 3, 1, None, None);
        assert_eq!(report.observations, 1);
        assert_eq!(report.achieved_reduction_percent, None);
        assert_eq!(report.current_cost_percent, Some(4.0));
    }

    #[test]
    fn reset_time_jitter_keeps_the_observation_but_a_real_reset_drops_it() {
        // 공급자가 돌려주는 리셋 시각은 표본마다 1초씩 흔들린다. 그 흔들림을 창 리셋으로
        // 보면 멀쩡한 관측이 절반쯤 사라져 회당 소비가 영영 실측되지 않는다.
        let mut store = store_with_consumer_runs("s-jit", &[(2.0, None), (2.0, None)]);
        let key = series_key("claude-a", "7일");
        for (index, sample) in store
            .series
            .get_mut(&key)
            .expect("series")
            .iter_mut()
            .enumerate()
        {
            sample.resets_at = Some(NOW + 50 * HOUR - (index as i64 % 2) * 1_000);
        }
        let (cost, weight) =
            measure_consumer_cost(&store, "s-jit", ProviderId::Claude, "7일", 5).expect("cost");
        assert!((cost - 2.0).abs() < 1e-9);
        assert!((weight - 2.0).abs() < 1e-9);
        // 창이 실제로 옮겨 갔으면(시간 단위) 증가분을 그 실행의 것으로 볼 수 없다.
        for (index, sample) in store
            .series
            .get_mut(&key)
            .expect("series")
            .iter_mut()
            .enumerate()
        {
            sample.resets_at = Some(NOW + 50 * HOUR + index as i64 * HOUR);
        }
        assert_eq!(
            measure_consumer_cost(&store, "s-jit", ProviderId::Claude, "7일", 5),
            None
        );
    }

    #[test]
    fn a_sample_late_by_more_than_ten_minutes_still_brackets_the_run() {
        // 종료 훅의 갱신이 재시도 유예에 걸리거나 화면 폴링이 멈추면 다음 표본이 10분보다
        // 늦게 온다. 그 사이 소비는 대부분 이 실행의 것이라 버리지 않는다.
        let mut store = store_with_consumer_runs("s-late", &[(2.0, None), (2.0, None)]);
        let key = series_key("claude-a", "7일");
        for sample in store.series.get_mut(&key).expect("series").iter_mut() {
            // 종료 뒤 표본(홀수 번째)만 20분 뒤로 민다.
            sample.at += 19 * 60_000;
        }
        let series = store.series.get_mut(&key).expect("series");
        for index in (0..series.len()).step_by(2) {
            series[index].at -= 19 * 60_000;
        }
        let (cost, weight) =
            measure_consumer_cost(&store, "s-late", ProviderId::Claude, "7일", 5).expect("cost");
        assert!((cost - 2.0).abs() < 1e-9);
        assert!((weight - 2.0).abs() < 1e-9);
    }

    #[test]
    fn enforced_consumer_above_its_per_run_ceiling_lowers_the_effort_first() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let store = store_with_consumer_runs("s-on", &[(3.0, Some(2_000)), (3.0, Some(2_100))]);
        let mut policy = UsageBudgetPolicy::default();
        policy.consumers.insert(
            "s-on".to_owned(),
            crate::usage_budget_policy::ConsumerBudgetConfig {
                enabled: true,
                max_tokens_per_run: Some(1_500),
                enforce_ceiling: true,
                ..Default::default()
            },
        );
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(plan
            .over_ceiling
            .as_deref()
            .is_some_and(|why| why.contains("회당 토큰")));
        // 상한을 넘으면 먼저 등급을 한 칸 낮춰서 돈다. 회차를 통째로 멈추면 일이 멈추고,
        // 그 소비자는 상한을 못 넘기는 대신 아무것도 못 하게 된다.
        assert!(!plan.planned.is_empty());
        // 자동 판정은 이 여력에서 high다. 상한 초과가 딱 한 칸 밀어 medium이 된다.
        assert_eq!(
            plan.planned[0].reasoning_effort,
            Some(ReasoningEffort::Medium),
            "상한 초과는 사다리를 한 칸만 내려야 한다"
        );
        // 낮춘 등급으로 도는 회차이므로 예약도 함께 남는다.
        let dir = tempfile::tempdir().expect("tempdir");
        save_store(dir.path(), &store).expect("seed store");
        plan_and_record(
            dir.path(),
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("record");
        let recorded = load_store(dir.path()).expect("store");
        assert_eq!(recorded.plans.len(), 1);
        assert!(!recorded.plans[0].entries.is_empty());
    }

    #[test]
    fn a_consumer_already_at_its_floor_still_rests_when_over_the_ceiling() {
        // 더 낮출 데가 없으면 그때는 멈춘다 — 조절기가 끝까지 내려간 뒤의 차단기다.
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let store = store_with_consumer_runs("s-on", &[(3.0, Some(2_000)), (3.0, Some(2_100))]);
        let mut policy = UsageBudgetPolicy::default();
        let mut lanes = BTreeMap::new();
        lanes.insert(
            ProviderId::Claude,
            crate::usage_budget_policy::LaneReasoningEffort {
                fixed: None,
                max_auto: Some(ReasoningEffort::Low),
                min_auto: Some(ReasoningEffort::Low),
            },
        );
        policy.consumers.insert(
            "s-on".to_owned(),
            crate::usage_budget_policy::ConsumerBudgetConfig {
                enabled: true,
                max_tokens_per_run: Some(1_500),
                enforce_ceiling: true,
                reasoning_efforts: lanes,
                ..Default::default()
            },
        );
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(plan.planned.is_empty());
        assert_eq!(
            account_view(&plan, "claude-a")["skipReason"],
            "회당 소비 상한 초과 · 추론수준이 이미 바닥 — 스킬 절차를 점검"
        );
    }

    #[test]
    fn unenforced_consumer_above_ceiling_is_only_flagged() {
        let accounts = vec![account(
            "claude-a",
            "tester-a@example.com",
            ProviderId::Claude,
            usage(vec![
                ("7일", 40.0, Some(NOW + 50 * HOUR)),
                ("5시간", 10.0, Some(NOW + HOUR)),
            ]),
        )];
        let schedules = vec![workflow_schedule("s-on", "wf-qa", 5, true)];
        let store = store_with_consumer_runs("s-on", &[(3.0, Some(2_000)), (3.0, Some(2_100))]);
        let mut policy = UsageBudgetPolicy::default();
        policy.consumers.insert(
            "s-on".to_owned(),
            crate::usage_budget_policy::ConsumerBudgetConfig {
                enabled: true,
                max_tokens_per_run: Some(1_500),
                enforce_ceiling: false,
                ..Default::default()
            },
        );
        let plan = compute_plan(
            &store,
            &request("7일", 92.0),
            &inputs_with_policy(&accounts, &schedules, &policy),
        )
        .expect("plan");
        assert!(plan.over_ceiling.is_none());
        assert!(!plan.planned.is_empty());
        let report = consumer_savings(
            &store,
            "s-on",
            ProviderId::Claude,
            "7일",
            5,
            5,
            Some(1_500),
            None,
        );
        assert!(report.over_ceiling.is_some());
    }

    #[test]
    fn run_tokens_are_backfilled_from_the_lookup() {
        let dir = tempfile::tempdir().expect("tempdir");
        record_run_started(
            dir.path(),
            RunStart {
                chat_id: "chat-1".to_owned(),
                execution_id: None,
                consumer_id: "s-on".to_owned(),
                workflow_id: None,
                account_id: "claude-a".to_owned(),
                provider: ProviderId::Claude,
                started_at: NOW,
                reasoning_effort: None,
                model: None,
            },
        );
        record_run_ended(
            dir.path(),
            "chat-1",
            NOW + HOUR,
            Some("session-1".to_owned()),
            None,
        );
        // 카탈로그가 아직 모르면 그대로, 알게 되면 채운다.
        backfill_run_tokens(dir.path(), |_, _| None);
        assert_eq!(load_store(dir.path()).expect("store").runs[0].tokens, None);
        backfill_run_tokens(dir.path(), |provider, session_id| {
            (provider == ProviderId::Claude && session_id == "session-1").then(|| tokens(4_000))
        });
        assert_eq!(
            load_store(dir.path()).expect("store").runs[0]
                .tokens
                .map(|t| t.total()),
            Some(4_000)
        );
    }
}
