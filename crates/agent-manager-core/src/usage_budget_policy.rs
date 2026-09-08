//! 사용량 예산 정책 — 페이싱에 쓸 계정 풀, 소비자(반복 요청) 선택과 우선순위, 기본
//! 목표·가드. 사용자 의도 데이터라 파생 저장소와 달리 손상되면 리셋하지 않고 오류를 낸다.
//!
//! 워크플로 인자(`targetPercent`·`guardPercent`·`emailPrefix`)는 이 정책의 캡 안에서만
//! 유효하다: 목표·가드는 정책과 인자 중 낮은 쪽, 계정은 풀 안에서 인자 필터로 더 좁힌다.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::fs;
use std::ops::RangeInclusive;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::app_data_file::write_private_json;
use crate::chat::ReasoningEffort;
use crate::domain::ProviderId;
use crate::quiet_hours::QuietSchedule;
use crate::scheduler::ScheduledRequest;
use crate::store_lock;
use crate::CoreError;

const STORE_FILE: &str = "aia-usage-budget-v1.json";
const STORE_LOCK_FILE: &str = "aia-usage-budget-v1.lock";
const STORE_VERSION: u32 = 1;
/// 정책에 등록되지 않은 소비자의 우선순위. 등록된 소비자와 같은 값이라 편향이 없다.
pub const DEFAULT_CONSUMER_PRIORITY: u8 = 50;
/// "자동" 주기의 기본 간격. 공급자 짧은 창의 통상 길이(5시간)와 같다.
pub const DEFAULT_AUTO_CADENCE_MINUTES: u32 = 300;

/// 창 라벨을 분으로 해석한다(예: `5시간` → 300). 공급자가 준 라벨 그대로라 형식이
/// 느슨하다 — 숫자+단위(분·시간·일·주)만 받아들이고 나머지는 None.
///
/// 라벨 → 창 길이 해석은 이 함수 하나뿐이다. 사용량 이력·페이싱도 여기를 거친다
/// ([`window_label_length_ms`]).
///
/// 라벨 앞에는 모델 이름이 붙을 수 있다(`Fable 7일`). 창 길이는 언제나 꼬리의
/// 숫자+단위이므로 뒤에서부터 읽어, 접두사가 있어도 같은 값을 얻는다.
pub(crate) fn window_label_minutes(label: Option<&str>) -> Option<u32> {
    let label = label?.trim();
    let unit_len: usize = label
        .chars()
        .rev()
        .take_while(|ch| !ch.is_ascii_digit())
        .map(char::len_utf8)
        .sum();
    let (head, unit) = label.split_at(label.len() - unit_len);
    // 숫자는 ASCII라 문자 수가 곧 바이트 수다.
    let digits_len = head.chars().rev().take_while(char::is_ascii_digit).count();
    let value: u32 = head[head.len() - digits_len..]
        .parse()
        .ok()
        .filter(|value| *value > 0)?;
    match unit.trim() {
        "분" => Some(value),
        "시간" => value.checked_mul(60),
        "일" => value.checked_mul(24 * 60),
        "주" => value.checked_mul(7 * 24 * 60),
        _ => None,
    }
}

/// [`window_label_minutes`]와 같은 해석을 밀리초로 돌려준다. 창 길이를 시각 계산에
/// 쓰는 쪽(사용량 이력의 주기 식별, 페이싱의 가드 창 환산)이 분→ms 환산을 각자 적지
/// 않게 한다.
pub(crate) fn window_label_length_ms(label: &str) -> Option<i64> {
    Some(i64::from(window_label_minutes(Some(label))?) * 60_000)
}
const MAX_CONSUMER_PRIORITY: u8 = 100;
/// 예산 정책이 저장할 수 있는 창 라벨 길이 상한. 사용량 조회도 서버가 준 모델 이름으로
/// 라벨을 만들 때 이 한도를 지킨다.
pub(crate) const MAX_LABEL_CHARS: usize = 80;

/// 계정·창 공통의 기본 목표와 가드. 비어 있으면 워크플로 인자를 그대로 쓴다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBudgetDefaults {
    /// 페이싱 기능 전체 스위치. 끄면 페이싱 대상 워크플로의 **예약** 회차가 뜨지 않는다.
    /// 계정 풀·회차·예산은 그대로 남아 다시 켜면 같은 설정으로 이어지고, 사용자가 회차
    /// 카드에서 직접 누른 실행은 전체 일시정지와 같은 규칙으로 꺼져 있어도 나간다.
    ///
    /// 값이 없으면 켜짐이다 — 이 스위치가 생기기 전에 저장된 정책이 조용히 멈추면 안 된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard_window_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard_percent: Option<f64>,
    /// 페이싱 스케줄(제한 시간대). 없거나 꺼져 있으면 종일 돈다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_hours: Option<QuietHours>,
    /// 소비자가 성향을 따로 정하지 않았을 때 물려받는 기본 소비 성향. 없으면 종전대로
    /// 자동·상한 없음이라 사다리의 기준칸(high)에서 시작한다 — 새 회차를 만들 때마다
    /// 상한을 손으로 거는 일이 되풀이되던 자리다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_profile: Option<SpendProfile>,
    /// 소진 모드. 켜면 계획 창의 목표를 시간에 직선으로 펴지 않고, 가드 창이 허락하는 만큼
    /// 몰아 써서 창을 빨리 비운다. 비워진 창은 한도 리셋 크레딧으로 되돌린 뒤 다시 채운다.
    ///
    /// 크레딧이 없는 계정에는 걸지 않는다 — 되돌릴 방법 없이 주간 한도만 일찍 태우면 남은
    /// 기간 내내 그 계정이 멈춰 균등 페이싱보다 나쁘다. 대상 판정은 크레딧 보유 여부가 하고
    /// 계정별 스위치는 두지 않는다(참여 자체는 종전대로 `pacing_enabled`가 정한다).
    #[serde(default)]
    pub drain: bool,
    /// 소진 모드가 건드리지 않고 남겨 둘 리셋 크레딧 장수. 계정마다 이 장수까지는 자동으로
    /// 쓰지 않아, 급할 때 사람이 직접 쓸 몫을 남긴다. 비어 있으면 0장(전부 자동 소비)이다.
    ///
    /// 남은 장수가 예비 장수 이하인 계정은 소진 대상에서도 빠진다 — 되돌릴 크레딧을 쓰지
    /// 않을 거라면 몰아 쓰기만 하고 창을 비운 채로 두게 되어 균등 페이싱보다 나쁘다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_reserve_credits: Option<u32>,
}

impl UsageBudgetDefaults {
    /// 소진 모드가 남겨 둘 크레딧 장수. 설정이 없으면 0장이다.
    pub fn drain_reserve(&self) -> u32 {
        self.drain_reserve_credits.unwrap_or(0)
    }

    /// 페이싱 기능이 켜져 있는지. 설정이 없으면 켜짐이다.
    pub fn pacing_on(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
}

/// 페이싱 스케줄: 페이싱을 **멈출** 시간대. 켜져 있으면 `weekdays`에 든 요일의 `start`~`end`
/// (HH:MM, `timezone`) 사이에는 페이싱 회차가 뜨지 않고, 그 밖의 시간과 체크 안 한 요일은 종일
/// 돈다. `end`가 `start`보다 이르거나 같으면 자정을 넘는 제한(22:00 → 다음 날 06:00)이고 제한은
/// **시작 요일**에 속한다(금 22:00~토 06:00은 금요일 제한). 꺼져 있으면 값은 저장만 한다.
/// 해석은 [`crate::quiet_hours::QuietSchedule`]이 맡는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietHours {
    #[serde(default)]
    pub enabled: bool,
    pub start: String,
    pub end: String,
    pub timezone: String,
    /// 제한을 적용할 요일. 0=일 … 6=토(`ScheduleRecurrence.weekday`·프런트 요일 배열과 같은 번호).
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub weekdays: BTreeSet<u8>,
}

/// 계정 하나의 페이싱 참여 여부와 목표 override.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBudgetConfig {
    #[serde(default)]
    pub pacing_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard_percent: Option<f64>,
    /// 소진 마감 안내를 이미 보낸 리셋 크레딧의 id. 크레딧은 만료가 있어서, 지금 소진을
    /// 시작해야 만료 전에 쓸 수 있는 시점이 오면 한 번 알린다. 같은 크레딧으로 두 번
    /// 알리지 않으려고 여기에 남긴다. 새 크레딧이 그 시점에 닿으면 id가 달라 다시 알린다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_notice_credit_id: Option<String>,
}

/// 워크플로 하나의 페이싱 참여 override. 저장본에 항목이 없는 워크플로는 계약이 사용량을
/// 쓰는지(페이싱 계산 또는 무인 런타임 기동 단계 보유)로 정해지고, 사용자가 화면에서 켜거나
/// 끄면 그 값이 계약 판정을 덮는다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBudgetConfig {
    #[serde(default)]
    pub pacing_enabled: bool,
    /// 이 워크플로가 쓸 수 있는 계정. 비어 있으면 제한 없음 — 전역 계정 풀을 그대로 쓴다.
    /// 값이 있으면 회차 계획이 풀 안에서 이 집합으로 한 번 더 좁힌다.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub accounts: BTreeSet<String>,
}

/// 레인(공급자) 하나의 추론수준 설정. `fixed`가 있으면 그 값으로 고정, 없으면 봉투가 계정
/// 여력으로 자동 판정하되 `max_auto`가 있으면 그 위로는 올라가지 않는다. 두 값 모두 그
/// 공급자의 사다리 안 이름만 저장된다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneReasoningEffort {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_auto: Option<ReasoningEffort>,
    /// 자동 판정이 내려갈 수 있는 바닥. 절감 목표가 등급을 낮출 때 여기서 멈춘다.
    /// 품질이 떨어지는 지점은 통계적으로 추론할 수 없어(회차당 결함 발견율이 10% 안팎이라
    /// 등급 간 차이를 유의하게 가르려면 수백 회차가 필요하다) 사람이 못박는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_auto: Option<ReasoningEffort>,
}

/// 소비 성향 프리셋. 천장·바닥을 사용자가 공급자마다 짜지 않도록 한 값으로 묶는다.
///
/// 그 사이에서 어느 등급으로 돌지는 계획이 실측 회당 소비로 정한다 — 남은 여유로 감당할 수
/// 있는 가장 깊은 등급이다. 그래서 "몇 % 줄일지" 같은 별도 목표가 필요 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpendProfile {
    /// 항상 최저 등급. 게이트가 품질을 지키는 일(검증을 통과해야 커밋되는 회차 등)에 맞다.
    Saver,
    /// 여유에 맞춰 medium~high 사이에서 정한다. 대부분의 회차에 맞는 기본 선택.
    Goal,
    /// 여유가 있으면 high~max까지. 탐색처럼 게이트가 대신 지켜 주지 못하는 일에 맞다.
    Quality,
}

impl SpendProfile {
    /// 이 성향이 뜻하는 (천장, 바닥). 공급자 사다리에 맞추는 것은 호출부가 한다.
    pub fn bounds(self) -> (Option<ReasoningEffort>, Option<ReasoningEffort>) {
        match self {
            Self::Saver => (Some(ReasoningEffort::Low), Some(ReasoningEffort::Low)),
            Self::Goal => (Some(ReasoningEffort::High), Some(ReasoningEffort::Medium)),
            Self::Quality => (Some(ReasoningEffort::Max), Some(ReasoningEffort::High)),
        }
    }
}

/// 소비자(반복 요청) 하나의 참여 여부·우선순위·라벨과 회당 소비 상한.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerBudgetConfig {
    #[serde(default)]
    pub enabled: bool,
    /// 배분 순서. 숫자가 낮을수록 먼저 받고 0이 가장 높다. 같은 값끼리는 라운드로빈.
    #[serde(default = "default_priority")]
    pub priority: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    /// 회당 토큰 상한(실측 토큰이 있는 공급자에만 적용). 없으면 상한 없음.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_per_run: Option<u64>,
    /// 회당 창 소비 상한(%p). 없으면 상한 없음.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cost_percent_per_run: Option<f64>,
    /// 상한을 넘으면 기동을 막을지. 기본은 표시만(소프트) — 막으면 그 일은 멈춘다.
    #[serde(default)]
    pub enforce_ceiling: bool,
    /// 회차 기동의 추론수준(레인=공급자별). 항목이 없는 공급자는 성향 프리셋을 따르고,
    /// 프리셋도 없으면 자동(계정 여력)이며 상한도 없다. 공급자마다 제공 단계와 회당 소비가
    /// 달라 한 값으로 묶지 않는다.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub reasoning_efforts: BTreeMap<ProviderId, LaneReasoningEffort>,
    /// 소비 성향. 레인별 설정이 없는 공급자의 천장·바닥을 이 값이 정한다. 없으면 기본값의
    /// 성향을 물려받는다 — 회차를 새로 만들 때마다 같은 조합을 손으로 짜지 않게 한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_profile: Option<SpendProfile>,
}

impl Default for ConsumerBudgetConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            priority: DEFAULT_CONSUMER_PRIORITY,
            label: None,
            workflow_id: None,
            max_tokens_per_run: None,
            max_cost_percent_per_run: None,
            enforce_ceiling: false,
            reasoning_efforts: BTreeMap::new(),
            spend_profile: None,
        }
    }
}

fn default_priority() -> u8 {
    DEFAULT_CONSUMER_PRIORITY
}

/// 절감 목표의 기본값. 기준선은 소비자별 처음 `baseline_runs`회 관측의 중앙값이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavingsDefaults {
    /// 기준선 대비 회당 소비를 얼마나 줄일지(%). 없으면 목표 없이 추이만 본다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_reduction_percent: Option<f64>,
    #[serde(default = "default_baseline_runs")]
    pub baseline_runs: usize,
}

pub const DEFAULT_BASELINE_RUNS: usize = 5;
const MAX_BASELINE_RUNS: usize = 32;

fn default_baseline_runs() -> usize {
    DEFAULT_BASELINE_RUNS
}

impl Default for SavingsDefaults {
    fn default() -> Self {
        Self {
            target_reduction_percent: None,
            baseline_runs: DEFAULT_BASELINE_RUNS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBudgetPolicy {
    #[serde(default = "store_version")]
    schema_version: u32,
    #[serde(default)]
    pub defaults: UsageBudgetDefaults,
    /// 계정 풀. `pacing_enabled`가 하나라도 true면 그 계정들만 페이싱 후보다.
    #[serde(default)]
    pub accounts: BTreeMap<String, AccountBudgetConfig>,
    /// 소비자 = 반복 요청 id. 비어 있지 않으면 등록·활성인 소비자만 기동을 받는다.
    #[serde(default)]
    pub consumers: BTreeMap<String, ConsumerBudgetConfig>,
    /// 워크플로별 페이싱 참여 override. 항목이 없는 워크플로는 계약 판정을 따른다.
    #[serde(default)]
    pub workflows: BTreeMap<String, WorkflowBudgetConfig>,
    /// 토큰 절감 목표 기본값.
    #[serde(default)]
    pub savings: SavingsDefaults,
}

fn store_version() -> u32 {
    STORE_VERSION
}

impl Default for UsageBudgetPolicy {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            defaults: UsageBudgetDefaults::default(),
            accounts: BTreeMap::new(),
            consumers: BTreeMap::new(),
            workflows: BTreeMap::new(),
            savings: SavingsDefaults::default(),
        }
    }
}

impl UsageBudgetPolicy {
    /// 페이싱 후보로 허용된 계정 집합. 켜진 계정이 하나도 없으면 풀이 없는 것(None)이고
    /// 워크플로 인자 필터만 적용된다.
    pub fn pool(&self) -> Option<BTreeSet<&str>> {
        let pool: BTreeSet<&str> = self
            .accounts
            .iter()
            .filter(|(_, config)| config.pacing_enabled)
            .map(|(id, _)| id.as_str())
            .collect();
        (!pool.is_empty()).then_some(pool)
    }

    /// 페이싱 기능 전체 스위치의 현재 값. 정책이 없으면(아직 저장한 적이 없으면) 켜짐이다.
    pub fn pacing_on(&self) -> bool {
        self.defaults.pacing_on()
    }

    /// 요청한 목표와 정책(기본, 계정 override) 중 가장 낮은 값. 정책은 캡이다.
    pub fn effective_target(&self, account_id: &str, requested: f64) -> f64 {
        [
            self.defaults.target_percent,
            self.accounts
                .get(account_id)
                .and_then(|config| config.target_percent),
        ]
        .into_iter()
        .flatten()
        .fold(requested, f64::min)
    }

    /// 요청한 가드 상한과 정책 중 가장 낮은 값. 아무 데도 없으면 None.
    pub fn effective_guard_percent(&self, account_id: &str, requested: Option<f64>) -> Option<f64> {
        [
            requested,
            self.defaults.guard_percent,
            self.accounts
                .get(account_id)
                .and_then(|config| config.guard_percent),
        ]
        .into_iter()
        .flatten()
        .reduce(f64::min)
    }

    /// 이 워크플로가 페이싱 대상인지. 사용자가 화면에서 켜거나 끈 값이 있으면 그것이고,
    /// 없으면 계약이 사용량을 쓰는지(`capable`)를 그대로 따른다 — 아무것도 고르지 않은
    /// 저장본에서 지금 돌고 있는 회차와 기동 게이트가 그대로 유지된다.
    pub fn workflow_pacing_enabled(&self, workflow_id: &str, capable: bool) -> bool {
        self.workflows
            .get(workflow_id)
            .map(|config| config.pacing_enabled)
            .unwrap_or(capable)
    }

    /// 이 워크플로가 쓸 수 있는 계정 집합. 비어 있으면 제한 없음(None).
    pub fn workflow_accounts(&self, workflow_id: &str) -> Option<&BTreeSet<String>> {
        self.workflows
            .get(workflow_id)
            .map(|config| &config.accounts)
            .filter(|accounts| !accounts.is_empty())
    }

    /// "자동" 주기의 간격(분). 함께 지키는 짧은 창(가드 창)과 같은 간격으로 돌면 창마다
    /// 한 회차가 돌아 가드에 막히지도, 창을 놀리지도 않는다. 라벨이 없거나 읽을 수 없으면
    /// 기본 5시간.
    pub fn auto_cadence_minutes(&self) -> u32 {
        window_label_minutes(self.defaults.guard_window_label.as_deref())
            .unwrap_or(DEFAULT_AUTO_CADENCE_MINUTES)
    }

    /// 켜져 있고 해석되는 페이싱 스케줄. 꺼져 있거나 없거나 저장값이 깨졌으면 None — 호출자는
    /// "제한 없음"으로 읽는다(저장 시점에 검증하므로 깨진 값은 정상 경로에서 나오지 않는다).
    pub(crate) fn quiet_schedule(&self) -> Option<QuietSchedule> {
        self.defaults
            .quiet_hours
            .as_ref()
            .and_then(|hours| QuietSchedule::parse(hours).ok().flatten())
    }

    /// 소비자 선택이 켜져 있는지(하나라도 등록됐는지).
    pub fn consumers_configured(&self) -> bool {
        !self.consumers.is_empty()
    }

    /// 이 소비자가 기동을 받을 수 있는지. 선택이 꺼져 있으면 모두 허용.
    pub fn consumer_allowed(&self, consumer_id: &str) -> bool {
        if !self.consumers_configured() {
            return true;
        }
        self.consumers
            .get(consumer_id)
            .is_some_and(|config| config.enabled)
    }

    /// 워크플로가 띄우는 무인 런타임을 허용할지. 소비자 선택이 꺼져 있으면 모두 허용.
    /// 켜져 있으면 그 반복 요청이 등록·활성이거나, 같은 워크플로를 가리키는 등록·활성
    /// 소비자가 하나라도 있으면 허용한다 — 수동 실행(트리거 없음)은 소비자 id가 워크플로
    /// id로 오므로 워크플로 기준 확인이 없으면 등록된 회차의 수동 실행까지 막게 된다.
    pub fn launch_allowed(&self, consumer_id: Option<&str>, workflow_id: Option<&str>) -> bool {
        if !self.consumers_configured() {
            return true;
        }
        if consumer_id.is_some_and(|id| self.consumers.get(id).is_some_and(|config| config.enabled))
        {
            return true;
        }
        workflow_id.is_some_and(|workflow| {
            self.consumers
                .values()
                .any(|config| config.enabled && config.workflow_id.as_deref() == Some(workflow))
        })
    }

    pub fn consumer_priority(&self, consumer_id: &str) -> u8 {
        self.consumers
            .get(consumer_id)
            .map(|config| config.priority)
            .unwrap_or(DEFAULT_CONSUMER_PRIORITY)
    }
}

fn with_store_lock<T>(
    app_data_dir: &Path,
    action: impl FnOnce() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let _lock = store_lock::acquire(app_data_dir, STORE_LOCK_FILE, "사용량 예산 정책")?;
    action()
}

fn load_unlocked(app_data_dir: &Path) -> Result<Option<UsageBudgetPolicy>, CoreError> {
    let path = app_data_dir.join(STORE_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    // 사용자가 고른 풀·우선순위다. 읽지 못하면 조용히 비우지 않고 실패시킨다 — 빈 정책은
    // "모든 계정·모든 소비자 허용"이라 사용자의 선택과 정반대로 동작한다.
    let policy: UsageBudgetPolicy = serde_json::from_slice(&fs::read(&path)?).map_err(|error| {
        CoreError::Runtime(format!(
            "사용량 예산 정책 저장본을 읽을 수 없습니다({}): {error}",
            path.display()
        ))
    })?;
    if policy.schema_version != STORE_VERSION {
        return Err(CoreError::Runtime(format!(
            "사용량 예산 정책 저장본 버전({})을 읽을 수 없습니다",
            policy.schema_version
        )));
    }
    Ok(Some(policy))
}

fn save_unlocked(app_data_dir: &Path, policy: &UsageBudgetPolicy) -> Result<(), CoreError> {
    write_private_json(&app_data_dir.join(STORE_FILE), policy)
}

/// 정책이 있으면 읽고, 없으면 None. 회차 계획은 정책이 없을 때 인자만으로 동작한다.
pub(crate) fn load_optional(app_data_dir: &Path) -> Result<Option<UsageBudgetPolicy>, CoreError> {
    with_store_lock(app_data_dir, || load_unlocked(app_data_dir))
}

/// 정책 파일을 처음 만들 때 채울 값. 이미 돌고 있는 페이싱 회차와 그 회차가 쓴 계정을
/// 그대로 등록해, 선택 기능이 켜지는 순간 회차가 멈추지 않게 한다.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PolicySeed {
    pub consumers: Vec<SeedConsumer>,
    pub accounts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SeedConsumer {
    pub schedule_id: String,
    pub label: String,
    pub workflow_id: String,
}

fn seeded(seed: PolicySeed) -> UsageBudgetPolicy {
    let mut policy = UsageBudgetPolicy::default();
    for consumer in seed.consumers {
        policy.consumers.insert(
            consumer.schedule_id,
            ConsumerBudgetConfig {
                enabled: true,
                label: Some(consumer.label),
                workflow_id: Some(consumer.workflow_id),
                ..ConsumerBudgetConfig::default()
            },
        );
    }
    for account_id in seed.accounts {
        policy.accounts.insert(
            account_id,
            AccountBudgetConfig {
                pacing_enabled: true,
                target_percent: None,
                guard_percent: None,
                drain_notice_credit_id: None,
            },
        );
    }
    policy
}

/// 정책을 읽고, 없으면 시드로 만들어 저장한 뒤 돌려준다.
pub(crate) fn load_or_seed(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
) -> Result<UsageBudgetPolicy, CoreError> {
    with_store_lock(app_data_dir, || match load_unlocked(app_data_dir)? {
        Some(policy) => Ok(policy),
        None => {
            let policy = seeded(seed()?);
            save_unlocked(app_data_dir, &policy)?;
            Ok(policy)
        }
    })
}

fn modify(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
    change: impl FnOnce(&mut UsageBudgetPolicy) -> Result<(), CoreError>,
) -> Result<UsageBudgetPolicy, CoreError> {
    with_store_lock(app_data_dir, || {
        let mut policy = match load_unlocked(app_data_dir)? {
            Some(policy) => policy,
            None => seeded(seed()?),
        };
        change(&mut policy)?;
        save_unlocked(app_data_dir, &policy)?;
        Ok(policy)
    })
}

/// 이미 저장된 정책만 손본다. 저장본이 없으면 만들지 않는다 — 빈 정책은 "모든 계정·모든
/// 소비자 허용"이라 아직 고르지 않은 사용자의 선택을 대신 굳혀 버린다. `change`가
/// `false`(바꾼 것 없음)를 돌려주면 저장도 건너뛰고 `None`을 답한다.
fn modify_existing(
    app_data_dir: &Path,
    change: impl FnOnce(&mut UsageBudgetPolicy) -> Result<bool, CoreError>,
) -> Result<Option<UsageBudgetPolicy>, CoreError> {
    with_store_lock(app_data_dir, || {
        let Some(mut policy) = load_unlocked(app_data_dir)? else {
            return Ok(None);
        };
        if !change(&mut policy)? {
            return Ok(None);
        }
        save_unlocked(app_data_dir, &policy)?;
        Ok(Some(policy))
    })
}

/// 식별자 인자가 비어 있지 않은지. 공백만 있는 값도 비어 있는 것으로 본다 — 저장하면
/// 어느 계정·요청도 가리키지 않는 항목이 정책에 남는다.
fn require_ids(what: &str, ids: &[&str]) -> Result<(), CoreError> {
    if ids.iter().any(|id| id.trim().is_empty()) {
        return Err(CoreError::InvalidInput(format!(
            "{what} id가 비어 있습니다"
        )));
    }
    Ok(())
}

/// 0~100(%) 밖이거나 NaN인지. 창 목표·가드와 회당 소비 상한이 같은 규칙을 쓴다.
fn percent_out_of_range(value: f64) -> bool {
    value.is_nan() || !(0.0..=100.0).contains(&value)
}

pub(crate) fn validate_percent(value: Option<f64>, what: &str) -> Result<(), CoreError> {
    if value.is_some_and(percent_out_of_range) {
        return Err(CoreError::InvalidInput(format!(
            "{what}은(는) 0~100 사이여야 합니다"
        )));
    }
    Ok(())
}

/// 정수 인자가 허용 범위 안인지. 한도를 메시지에 그대로 실어, 화면이 상수를 따로 알지
/// 못해도 사용자가 고칠 값을 알 수 있게 한다.
fn validate_range<T: PartialOrd + Display>(
    value: T,
    allowed: RangeInclusive<T>,
    what: &str,
) -> Result<(), CoreError> {
    if !allowed.contains(&value) {
        return Err(CoreError::InvalidInput(format!(
            "{what}는 {}~{} 사이여야 합니다",
            allowed.start(),
            allowed.end()
        )));
    }
    Ok(())
}

/// 창 라벨은 "없음"과 "빈 문자열"을 구분한다 — 생략은 기본 창을 쓰라는 뜻이고, 공백만 남은
/// 라벨은 어떤 창도 가리키지 못한다.
fn validate_window_label(label: Option<&str>) -> Result<(), CoreError> {
    if label.is_some_and(|label| label.trim().is_empty()) {
        return Err(CoreError::InvalidInput(
            "창 라벨은 비울 수 없습니다(없으면 생략)".to_owned(),
        ));
    }
    Ok(())
}

fn validate_label(label: &Option<String>) -> Result<(), CoreError> {
    if label
        .as_deref()
        .is_some_and(|label| label.chars().count() > MAX_LABEL_CHARS)
    {
        return Err(CoreError::InvalidInput(format!(
            "라벨은 {MAX_LABEL_CHARS}자를 넘을 수 없습니다"
        )));
    }
    Ok(())
}

/// 기본 목표·가드를 통째로 바꾼다.
pub(crate) fn set_defaults(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
    defaults: UsageBudgetDefaults,
) -> Result<UsageBudgetPolicy, CoreError> {
    validate_percent(defaults.target_percent, "목표 사용률")?;
    validate_percent(defaults.guard_percent, "짧은 창 상한")?;
    validate_window_label(defaults.window_label.as_deref())?;
    validate_window_label(defaults.guard_window_label.as_deref())?;
    // 스케줄은 꺼져 있어도 형식·시간대·요일을 검증한다 — 깨진 값을 저장하면 켤 때 조용히 무시된다.
    if let Some(hours) = defaults.quiet_hours.as_ref() {
        QuietSchedule::parse(hours)?;
    }
    modify(app_data_dir, seed, |policy| {
        policy.defaults = defaults;
        Ok(())
    })
}

/// 소진 마감 안내를 봤다고 기록한다. 같은 크레딧으로 다시 알리지 않으려는 것이므로 어떤
/// 크레딧이었는지를 함께 남긴다 — 새 크레딧이 같은 시점에 닿으면 id가 달라 다시 알린다.
pub(crate) fn acknowledge_drain_notice(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
    request: AcknowledgeDrainNoticeRequest,
) -> Result<UsageBudgetPolicy, CoreError> {
    require_ids("계정", &[&request.account_id])?;
    modify(app_data_dir, seed, |policy| {
        policy
            .accounts
            .entry(request.account_id)
            .or_default()
            .drain_notice_credit_id = request.credit_id;
        Ok(())
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeDrainNoticeRequest {
    pub account_id: String,
    /// 안내를 띄운 크레딧의 id. 비우면 기록을 지워 다시 알린다.
    #[serde(default)]
    pub credit_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetUsageBudgetAccountRequest {
    pub account_id: String,
    pub pacing_enabled: bool,
    #[serde(default)]
    pub target_percent: Option<f64>,
    #[serde(default)]
    pub guard_percent: Option<f64>,
}

pub(crate) fn set_account(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
    request: SetUsageBudgetAccountRequest,
) -> Result<UsageBudgetPolicy, CoreError> {
    require_ids("계정", &[&request.account_id])?;
    validate_percent(request.target_percent, "목표 사용률")?;
    validate_percent(request.guard_percent, "짧은 창 상한")?;
    modify(app_data_dir, seed, |policy| {
        // 소진 마감 안내 기록은 사용자가 고르는 값이 아니라 이미 알렸다는 사실이다.
        // 목표·가드를 손볼 때마다 지워지면 같은 크레딧으로 다시 알린다.
        let drain_notice_credit_id = policy
            .accounts
            .get(&request.account_id)
            .and_then(|previous| previous.drain_notice_credit_id.clone());
        policy.accounts.insert(
            request.account_id,
            AccountBudgetConfig {
                pacing_enabled: request.pacing_enabled,
                target_percent: request.target_percent,
                guard_percent: request.guard_percent,
                drain_notice_credit_id,
            },
        );
        Ok(())
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetUsageBudgetConsumerRequest {
    /// 소비자 = 반복 요청 id.
    pub schedule_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub workflow_id: Option<String>,
    /// 회당 토큰 상한. 생략하면 기존 값 유지, 0이면 상한 해제.
    #[serde(default)]
    pub max_tokens_per_run: Option<u64>,
    /// 회당 창 소비 상한(%p). 생략하면 기존 값 유지, 0이면 상한 해제.
    #[serde(default)]
    pub max_cost_percent_per_run: Option<f64>,
    /// 상한 초과 시 기동을 막을지. 생략하면 기존 값 유지.
    #[serde(default)]
    pub enforce_ceiling: Option<bool>,
    /// 레인(공급자)별 추론수준. 생략하면 기존 값 유지, 주면 통째로 교체한다(항목이 없는
    /// 공급자는 자동·상한 없음). 값은 그 공급자 사다리 안의 이름만 받는다.
    #[serde(default)]
    pub reasoning_efforts: Option<BTreeMap<ProviderId, LaneReasoningEffort>>,
    /// 소비 성향 프리셋. 칸이 없으면 기존 값을 유지하고, `null`을 실어 보내면 해제해 기본값을
    /// 물려받게 한다 — 화면의 '기본값 따름'과 '직접 설정'이 그 해제이고, 둘을 미지정과 같은
    /// `None`으로 읽으면 한 번 고른 성향에서 빠져나올 길이 없어진다.
    #[serde(
        default,
        deserialize_with = "crate::domain::deserialize_nullable_field"
    )]
    pub spend_profile: Option<Option<SpendProfile>>,
}

pub(crate) fn set_consumer(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
    request: SetUsageBudgetConsumerRequest,
) -> Result<UsageBudgetPolicy, CoreError> {
    require_ids("반복 요청", &[&request.schedule_id])?;
    if let Some(priority) = request.priority {
        validate_range(priority, 0..=MAX_CONSUMER_PRIORITY, "우선순위")?;
    }
    validate_label(&request.label)?;
    validate_percent(request.max_cost_percent_per_run, "회당 소비 상한")?;
    // 레인별 추론수준은 그 공급자 사다리 안의 값만 저장한다 — 화면과 계획이 같은 선택지를 본다.
    if let Some(lanes) = &request.reasoning_efforts {
        for (provider, lane) in lanes {
            let ladder = crate::usage_pacing::reasoning_effort_ladder(*provider);
            for (name, value) in [("고정값", &lane.fixed), ("자동 상한", &lane.max_auto)] {
                if let Some(effort) = value.as_ref().filter(|effort| !ladder.contains(effort)) {
                    return Err(CoreError::InvalidInput(format!(
                        "{} 레인의 추론수준 {name} {}은 지원하지 않습니다(가능: {})",
                        provider.as_str(),
                        effort.as_str(),
                        ladder
                            .iter()
                            .map(ReasoningEffort::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
            }
        }
    }
    modify(app_data_dir, seed, |policy| {
        let existing = policy
            .consumers
            .get(&request.schedule_id)
            .cloned()
            .unwrap_or_default();
        // 0은 "상한 해제", 생략은 "그대로".
        let max_tokens_per_run = match request.max_tokens_per_run {
            Some(0) => None,
            Some(value) => Some(value),
            None => existing.max_tokens_per_run,
        };
        let max_cost_percent_per_run = match request.max_cost_percent_per_run {
            Some(value) if value <= 0.0 => None,
            Some(value) => Some(value),
            None => existing.max_cost_percent_per_run,
        };
        policy.consumers.insert(
            request.schedule_id,
            ConsumerBudgetConfig {
                enabled: request.enabled,
                priority: request.priority.unwrap_or(existing.priority),
                label: request.label.or(existing.label),
                workflow_id: request.workflow_id.or(existing.workflow_id),
                max_tokens_per_run,
                max_cost_percent_per_run,
                enforce_ceiling: request.enforce_ceiling.unwrap_or(existing.enforce_ceiling),
                reasoning_efforts: request
                    .reasoning_efforts
                    .unwrap_or(existing.reasoning_efforts),
                spend_profile: request.spend_profile.unwrap_or(existing.spend_profile),
            },
        );
        Ok(())
    })
}

/// 반복 요청 자체를 수정한 뒤 소비자 연결 정보만 맞춘다. 사용자 설정인 참여 여부·우선순위·
/// 상한은 같은 정책 잠금 안에서 그대로 보존해, 동시에 들어온 설정 변경을 옛 스냅샷으로
/// 되돌리지 않는다. `register_if_missing`은 호출자가 새 워크플로의 페이싱 여부를 확인한 값이다.
pub(crate) fn sync_consumer_metadata(
    app_data_dir: &Path,
    schedule_id: &str,
    label: &str,
    workflow_id: &str,
    register_if_missing: bool,
) -> Result<(), CoreError> {
    require_ids("반복 요청 또는 워크플로", &[schedule_id, workflow_id])?;
    let label = Some(label.to_owned());
    validate_label(&label)?;
    modify_existing(app_data_dir, |policy| {
        if !policy.consumers_configured() {
            return Ok(false);
        }
        match policy.consumers.get_mut(schedule_id) {
            Some(config) => {
                config.label = label;
                config.workflow_id = Some(workflow_id.to_owned());
            }
            None if register_if_missing => {
                policy.consumers.insert(
                    schedule_id.to_owned(),
                    ConsumerBudgetConfig {
                        enabled: true,
                        label,
                        workflow_id: Some(workflow_id.to_owned()),
                        ..ConsumerBudgetConfig::default()
                    },
                );
            }
            None => return Ok(false),
        }
        Ok(true)
    })?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetUsageBudgetWorkflowRequest {
    pub workflow_id: String,
    pub pacing_enabled: bool,
    /// 이 워크플로가 쓸 계정. 생략(None)하면 기존 값 유지, 빈 배열이면 제한 해제,
    /// 목록이면 통째로 교체.
    #[serde(default)]
    pub accounts: Option<Vec<String>>,
}

/// 워크플로 하나의 페이싱 참여를 켜거나 끈다. 계약이 사용량을 쓰는지는 검증하지 않는다 —
/// 지금 쓰지 않는 계약도 나중에 무인 런타임을 띄우는 버전으로 다시 등록될 수 있고, 그때
/// 사용자가 남긴 의도가 그대로 적용되어야 한다.
pub(crate) fn set_workflow(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
    request: SetUsageBudgetWorkflowRequest,
) -> Result<UsageBudgetPolicy, CoreError> {
    require_ids("워크플로", &[&request.workflow_id])?;
    modify(app_data_dir, seed, |policy| {
        // 항목을 통째로 갈아끼우면 관리 탭의 페이싱 토글이 참여 계정을 지운다. 요청이
        // 명시한 항목만 바꾼다.
        let entry = policy.workflows.entry(request.workflow_id).or_default();
        entry.pacing_enabled = request.pacing_enabled;
        if let Some(accounts) = request.accounts {
            entry.accounts = accounts
                .into_iter()
                .map(|account| account.trim().to_owned())
                .filter(|account| !account.is_empty())
                .collect();
        }
        Ok(())
    })
}

/// 반복 요청이 사라진 소비자 설정을 걷어낸다. 반복 요청 id는 재사용되지 않으므로 남겨 둔
/// 설정은 되살아날 곳이 없고, 남아 있으면 페이싱 탭이 그 워크플로에 회차가 아직 있다고 보아
/// 새 회차를 만들지 못하게 막는다. 정책 파일이 없으면 만들지 않는다(지울 것도 없다).
/// 지운 것이 있으면 갱신된 정책을, 없으면 None을 돌려준다.
pub(crate) fn remove_consumers(
    app_data_dir: &Path,
    schedule_ids: &[String],
) -> Result<Option<UsageBudgetPolicy>, CoreError> {
    if schedule_ids.is_empty() {
        return Ok(None);
    }
    modify_existing(app_data_dir, |policy| {
        let mut removed = false;
        for schedule_id in schedule_ids {
            removed |= policy.consumers.remove(schedule_id).is_some();
        }
        Ok(removed)
    })
}

/// 절감 목표 기본값을 통째로 바꾼다.
pub(crate) fn set_savings(
    app_data_dir: &Path,
    seed: impl FnOnce() -> Result<PolicySeed, CoreError>,
    savings: SavingsDefaults,
) -> Result<UsageBudgetPolicy, CoreError> {
    validate_percent(savings.target_reduction_percent, "절감 목표")?;
    validate_range(
        savings.baseline_runs,
        1..=MAX_BASELINE_RUNS,
        "기준선 회차 수",
    )?;
    modify(app_data_dir, seed, |policy| {
        policy.savings = savings;
        Ok(())
    })
}

/// 소비자 후보 = 페이싱 워크플로(회차 봉투 계약이거나 사용량을 쓰는 계약)를 돌리는 반복 요청.
/// 일반 채팅 반복 요청은 후보가 아니다 — 페이싱을 쓰지 않는 일정은 조율 대상이 아니다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerCandidate {
    pub schedule_id: String,
    pub name: String,
    pub workflow_id: String,
    /// 반복 요청 자체가 켜져 있는지(정책의 enabled와 별개).
    pub schedule_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadence_minutes: Option<u32>,
}

/// `auto_minutes_for`는 워크플로 id로 자동 주기(분)를 답한다 — 자동 주기는 회당 소비와
/// 기동 상한이 달라 워크플로마다 다른 값이 나온다.
pub(crate) fn consumer_candidates(
    schedules: &[ScheduledRequest],
    pacing_workflow_ids: &BTreeSet<String>,
    now: i64,
    auto_minutes_for: impl Fn(&str) -> u32,
) -> Vec<ConsumerCandidate> {
    schedules
        .iter()
        .filter_map(|schedule| {
            let action = schedule.input.workflow.as_ref()?;
            if !pacing_workflow_ids.contains(&action.workflow_id) {
                return None;
            }
            // 고정·Cron 주기는 자동 주기 표본이 필요 없다. `auto_minutes_for`는 정책과
            // 페이싱 표본 저장소를 읽을 수 있으므로 Auto 후보에서만 호출한다.
            let auto_minutes = if schedule.input.recurrence.frequency
                == crate::scheduler::ScheduleFrequency::Auto
            {
                auto_minutes_for(&action.workflow_id)
            } else {
                DEFAULT_AUTO_CADENCE_MINUTES
            };
            let cadence_minutes = crate::scheduler::recurrence_average_minutes(
                &schedule.input.recurrence,
                now,
                auto_minutes,
            );
            Some(ConsumerCandidate {
                schedule_id: schedule.id.clone(),
                name: schedule.input.name.clone(),
                workflow_id: action.workflow_id.clone(),
                schedule_enabled: schedule.input.enabled,
                cadence_minutes,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_label_length_follows_the_unit_suffix() {
        const DAY_MS: i64 = 24 * 60 * 60 * 1000;
        assert_eq!(window_label_minutes(Some("30분")), Some(30));
        assert_eq!(window_label_minutes(Some("5시간")), Some(300));
        assert_eq!(window_label_minutes(Some("7일")), Some(7 * 24 * 60));
        assert_eq!(window_label_minutes(Some("2주")), Some(2 * 7 * 24 * 60));
        // 모델 이름 접두사가 붙어도 꼬리의 숫자+단위가 창 길이다.
        assert_eq!(window_label_length_ms("Fable 7일"), Some(7 * DAY_MS));
        assert_eq!(window_label_length_ms("5시간"), Some(5 * 60 * 60 * 1000));
        assert_eq!(window_label_length_ms("weekly"), None);
        assert_eq!(window_label_length_ms("0일"), None);
    }
    use crate::chat::{ChatApprovalMode, ChatMode};
    use crate::domain::ProviderId;
    use crate::scheduler::{
        ResumeFailurePolicy, ScheduleFrequency, ScheduleRecurrence, ScheduleSessionStrategy,
        ScheduleWorkflowAction, ScheduledRequestInput,
    };
    use serde_json::json;

    /// 이 스위치가 생기기 전에 저장된 정책에는 `enabled` 칸이 없다. 그 저장본을 꺼짐으로
    /// 읽으면 업데이트만으로 모든 회차가 조용히 멈춘다.
    #[test]
    fn policy_saved_before_the_switch_stays_on() {
        let policy: UsageBudgetPolicy =
            serde_json::from_value(json!({ "defaults": { "targetPercent": 92.0 } }))
                .expect("policy");
        assert!(policy.pacing_on());
        assert!(policy.defaults.enabled.is_none());
    }

    #[test]
    fn pacing_switch_round_trips_through_the_defaults() {
        let policy: UsageBudgetPolicy =
            serde_json::from_value(json!({ "defaults": { "enabled": false } })).expect("policy");
        assert!(!policy.pacing_on());
        let saved = serde_json::to_value(&policy.defaults).expect("defaults");
        assert_eq!(saved["enabled"], json!(false));
    }

    fn schedule(id: &str, workflow_id: Option<&str>, enabled: bool) -> ScheduledRequest {
        ScheduledRequest {
            id: id.to_owned(),
            input: ScheduledRequestInput {
                name: format!("{id} 이름"),
                prompt: String::new(),
                source: ProviderId::Claude,
                account_id: String::new(),
                use_active_account: false,
                cwd: String::new(),
                model: None,
                reasoning_effort: None,
                approval_mode: ChatApprovalMode::Never,
                mode: ChatMode::FullAccess,
                recurrence: ScheduleRecurrence {
                    frequency: ScheduleFrequency::Hourly,
                    interval: 5,
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
                workflow: workflow_id.map(|workflow_id| ScheduleWorkflowAction {
                    workflow_id: workflow_id.to_owned(),
                    approved_version: 1,
                    arguments: json!({}),
                    pacing: None,
                }),
                active_from: None,
                active_until: None,
            },
            created_at: 0,
            updated_at: 0,
            next_run_at: 0,
            last_run_at: None,
            manual_run_requested_at: None,
        }
    }

    fn no_seed() -> Result<PolicySeed, CoreError> {
        Ok(PolicySeed::default())
    }

    #[test]
    fn policy_caps_workflow_target_and_guard() {
        let mut policy = UsageBudgetPolicy::default();
        assert_eq!(policy.effective_target("a", 92.0), 92.0);
        assert_eq!(policy.effective_guard_percent("a", Some(85.0)), Some(85.0));
        assert_eq!(policy.effective_guard_percent("a", None), None);
        policy.defaults.target_percent = Some(80.0);
        policy.defaults.guard_percent = Some(90.0);
        policy.accounts.insert(
            "a".to_owned(),
            AccountBudgetConfig {
                pacing_enabled: true,
                target_percent: Some(70.0),
                guard_percent: None,
                drain_notice_credit_id: None,
            },
        );
        // 정책은 캡이다: 요청 92 → 기본 80 → 계정 70 중 가장 낮은 값.
        assert_eq!(policy.effective_target("a", 92.0), 70.0);
        assert_eq!(policy.effective_target("b", 92.0), 80.0);
        assert_eq!(policy.effective_target("a", 60.0), 60.0);
        assert_eq!(policy.effective_guard_percent("a", Some(85.0)), Some(85.0));
        assert_eq!(policy.effective_guard_percent("a", None), Some(90.0));
    }

    #[test]
    fn unknown_consumer_defaults_to_priority_50_and_selection_is_off_until_configured() {
        let mut policy = UsageBudgetPolicy::default();
        assert!(policy.consumer_allowed("anyone"));
        assert_eq!(
            policy.consumer_priority("anyone"),
            DEFAULT_CONSUMER_PRIORITY
        );
        policy.consumers.insert(
            "s-qa".to_owned(),
            ConsumerBudgetConfig {
                enabled: true,
                priority: 80,
                ..ConsumerBudgetConfig::default()
            },
        );
        policy.consumers.insert(
            "s-off".to_owned(),
            ConsumerBudgetConfig {
                enabled: false,
                priority: 10,
                ..ConsumerBudgetConfig::default()
            },
        );
        assert!(policy.consumer_allowed("s-qa"));
        assert!(!policy.consumer_allowed("s-off"));
        assert!(!policy.consumer_allowed("unregistered"));
        assert_eq!(policy.consumer_priority("s-qa"), 80);
        assert_eq!(
            policy.consumer_priority("unregistered"),
            DEFAULT_CONSUMER_PRIORITY
        );
        assert!(policy.pool().is_none());
    }

    #[test]
    fn budget_store_corruption_is_an_error_not_a_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join(STORE_FILE), b"{ not json").expect("write");
        assert!(matches!(
            load_optional(dir.path()),
            Err(CoreError::Runtime(_))
        ));
        assert!(matches!(
            load_or_seed(dir.path(), no_seed),
            Err(CoreError::Runtime(_))
        ));
        // 없는 파일은 오류가 아니라 "정책 없음"이다.
        let empty = tempfile::tempdir().expect("tempdir");
        assert_eq!(load_optional(empty.path()).expect("load"), None);
    }

    // 반복 요청을 지운 뒤 남은 소비자 설정은 그 워크플로에 회차가 아직 있는 것처럼 보여
    // 새 회차 생성을 막는다. 걷어내되 남은 소비자와 정책 파일 없는 경우는 건드리지 않는다.
    #[test]
    fn removing_consumers_drops_only_the_named_schedules() {
        let dir = tempfile::tempdir().expect("tempdir");
        let seed = || {
            Ok(PolicySeed {
                consumers: vec![
                    SeedConsumer {
                        schedule_id: "s-gone".to_owned(),
                        label: "지워진 회차".to_owned(),
                        workflow_id: "wf-refactor".to_owned(),
                    },
                    SeedConsumer {
                        schedule_id: "s-live".to_owned(),
                        label: "도는 회차".to_owned(),
                        workflow_id: "wf-qa".to_owned(),
                    },
                ],
                accounts: vec![],
            })
        };
        load_or_seed(dir.path(), seed).expect("seed");

        // 지울 것이 없으면 저장도 하지 않는다.
        assert_eq!(
            remove_consumers(dir.path(), &["s-unknown".to_owned()]).expect("remove"),
            None
        );
        let policy = remove_consumers(dir.path(), &["s-gone".to_owned()])
            .expect("remove")
            .expect("갱신된 정책");
        assert!(!policy.consumers.contains_key("s-gone"));
        assert!(policy.consumers.contains_key("s-live"));
        assert_eq!(
            load_optional(dir.path()).expect("load").expect("정책"),
            policy
        );

        // 정책 파일이 없으면 만들지 않는다.
        let empty = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            remove_consumers(empty.path(), &["s-gone".to_owned()]).expect("remove"),
            None
        );
        assert_eq!(load_optional(empty.path()).expect("load"), None);
    }

    #[test]
    fn first_policy_write_seeds_active_pacing_schedules_and_recent_accounts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let seed = || {
            Ok(PolicySeed {
                consumers: vec![SeedConsumer {
                    schedule_id: "s-qa".to_owned(),
                    label: "QA 회차".to_owned(),
                    workflow_id: "wf-qa".to_owned(),
                }],
                accounts: vec!["claude-a".to_owned(), "codex-b".to_owned()],
            })
        };
        let policy = set_consumer(
            dir.path(),
            seed,
            SetUsageBudgetConsumerRequest {
                schedule_id: "s-refactor".to_owned(),
                enabled: true,
                priority: Some(30),
                label: None,
                workflow_id: Some("wf-refactor".to_owned()),
                max_tokens_per_run: None,
                max_cost_percent_per_run: None,
                enforce_ceiling: None,
                reasoning_efforts: None,
                spend_profile: None,
            },
        )
        .expect("set consumer");
        // 시드된 소비자·계정에 요청한 소비자가 더해진다.
        assert_eq!(policy.consumers["s-qa"].priority, DEFAULT_CONSUMER_PRIORITY);
        assert_eq!(policy.consumers["s-qa"].label.as_deref(), Some("QA 회차"));
        assert_eq!(policy.consumers["s-refactor"].priority, 30);
        assert_eq!(
            policy.pool().expect("pool").into_iter().collect::<Vec<_>>(),
            vec!["claude-a", "codex-b"]
        );
        // 두 번째 쓰기는 시드를 다시 부르지 않고 저장본을 갱신한다.
        let policy = set_account(
            dir.path(),
            || panic!("seed must not run twice"),
            SetUsageBudgetAccountRequest {
                account_id: "codex-b".to_owned(),
                pacing_enabled: false,
                target_percent: Some(80.0),
                guard_percent: None,
            },
        )
        .expect("set account");
        assert_eq!(
            policy.pool().expect("pool").into_iter().collect::<Vec<_>>(),
            vec!["claude-a"]
        );
        // 우선순위를 생략하면 기존 값을 유지한다.
        let policy = set_consumer(
            dir.path(),
            || panic!("seed must not run"),
            SetUsageBudgetConsumerRequest {
                schedule_id: "s-refactor".to_owned(),
                enabled: false,
                priority: None,
                label: Some("리팩토링".to_owned()),
                workflow_id: None,
                max_tokens_per_run: Some(120_000),
                max_cost_percent_per_run: None,
                enforce_ceiling: Some(true),
                reasoning_efforts: None,
                spend_profile: None,
            },
        )
        .expect("set consumer");
        assert_eq!(policy.consumers["s-refactor"].priority, 30);
        assert!(!policy.consumers["s-refactor"].enabled);
        assert_eq!(
            policy.consumers["s-refactor"].max_tokens_per_run,
            Some(120_000)
        );
        assert!(policy.consumers["s-refactor"].enforce_ceiling);
        assert_eq!(
            policy.consumers["s-refactor"].workflow_id.as_deref(),
            Some("wf-refactor")
        );
        assert_eq!(load_optional(dir.path()).expect("load"), Some(policy));
    }

    #[test]
    fn set_operations_validate_their_inputs() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(matches!(
            set_defaults(
                dir.path(),
                no_seed,
                UsageBudgetDefaults {
                    target_percent: Some(120.0),
                    ..UsageBudgetDefaults::default()
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        // 페이싱 스케줄: 형식·시간대는 꺼져 있어도, 요일 없음은 켜져 있을 때 거절된다.
        let quiet = |enabled: bool, start: &str, timezone: &str, weekdays: &[u8]| QuietHours {
            enabled,
            start: start.to_owned(),
            end: "18:00".to_owned(),
            timezone: timezone.to_owned(),
            weekdays: weekdays.iter().copied().collect(),
        };
        for hours in [
            quiet(false, "9:00am", "Asia/Seoul", &[1]),
            quiet(false, "09:00", "Nowhere/Town", &[1]),
            quiet(true, "09:00", "Asia/Seoul", &[]),
            quiet(true, "18:00", "Asia/Seoul", &[1]),
            quiet(true, "09:00", "Asia/Seoul", &[9]),
        ] {
            assert!(
                matches!(
                    set_defaults(
                        dir.path(),
                        no_seed,
                        UsageBudgetDefaults {
                            quiet_hours: Some(hours.clone()),
                            ..UsageBudgetDefaults::default()
                        }
                    ),
                    Err(CoreError::InvalidInput(_))
                ),
                "{hours:?}"
            );
        }
        // 유효한 저장은 따로 둔다 — 아래 단언은 실패한 호출이 저장소를 만들지 않았음을 본다.
        let saved_dir = tempfile::tempdir().expect("tempdir");
        let saved = set_defaults(
            saved_dir.path(),
            no_seed,
            UsageBudgetDefaults {
                quiet_hours: Some(quiet(true, "09:00", "Asia/Seoul", &[1, 2, 3, 4, 5])),
                ..UsageBudgetDefaults::default()
            },
        )
        .expect("valid quiet hours");
        assert!(saved.quiet_schedule().is_some());
        // 꺼진 스케줄은 값을 보존하되 해석되지 않는다.
        let off = set_defaults(
            saved_dir.path(),
            no_seed,
            UsageBudgetDefaults {
                quiet_hours: Some(quiet(false, "09:00", "Asia/Seoul", &[1])),
                ..UsageBudgetDefaults::default()
            },
        )
        .expect("disabled quiet hours");
        assert!(off.quiet_schedule().is_none());
        assert_eq!(
            off.defaults
                .quiet_hours
                .as_ref()
                .map(|hours| hours.start.as_str()),
            Some("09:00")
        );
        assert!(matches!(
            set_consumer(
                dir.path(),
                no_seed,
                SetUsageBudgetConsumerRequest {
                    schedule_id: "s".to_owned(),
                    enabled: true,
                    priority: Some(101),
                    label: None,
                    workflow_id: None,
                    max_tokens_per_run: None,
                    max_cost_percent_per_run: None,
                    enforce_ceiling: None,
                    reasoning_efforts: None,
                    spend_profile: None,
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            set_account(
                dir.path(),
                no_seed,
                SetUsageBudgetAccountRequest {
                    account_id: " ".to_owned(),
                    pacing_enabled: true,
                    target_percent: None,
                    guard_percent: None,
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        // 실패한 쓰기는 파일을 만들지 않는다.
        assert_eq!(load_optional(dir.path()).expect("load"), None);
    }

    #[test]
    fn consumer_candidates_exclude_plain_chat_schedules() {
        let schedules = vec![
            schedule("s-qa", Some("wf-qa"), true),
            schedule("s-refactor", Some("wf-refactor"), false),
            schedule("s-folder", Some("wf-folder-assign"), true),
            schedule("s-daily-chat", None, true),
        ];
        let pacing: BTreeSet<String> = ["wf-qa", "wf-refactor"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let candidates = consumer_candidates(&schedules, &pacing, 0, |_| 300);
        let ids: Vec<(&str, bool, Option<u32>)> = candidates
            .iter()
            .map(|c| {
                (
                    c.schedule_id.as_str(),
                    c.schedule_enabled,
                    c.cadence_minutes,
                )
            })
            .collect();
        assert_eq!(
            ids,
            vec![("s-qa", true, Some(300)), ("s-refactor", false, Some(300))]
        );
        assert_eq!(candidates[0].name, "s-qa 이름");
    }

    #[test]
    fn consumer_candidates_include_cron_cadence() {
        let mut cron = schedule("s-cron", Some("wf-qa"), true);
        cron.input.recurrence.frequency = ScheduleFrequency::Cron;
        cron.input.recurrence.cron = Some("*/30 * * * *".to_owned());
        let pacing = ["wf-qa".to_owned()].into_iter().collect();
        let candidates = consumer_candidates(&[cron], &pacing, 0, |_| 300);
        assert_eq!(candidates[0].cadence_minutes, Some(30));
    }

    #[test]
    fn workflow_pacing_follows_the_contract_until_the_user_chooses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let policy = UsageBudgetPolicy::default();
        // 고른 값이 없으면 계약 판정(사용량을 쓰는지)이 그대로 답이다.
        assert!(policy.workflow_pacing_enabled("wf-qa", true));
        assert!(!policy.workflow_pacing_enabled("wf-report", false));

        let policy = set_workflow(
            dir.path(),
            no_seed,
            SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-qa".to_owned(),
                pacing_enabled: false,
                accounts: None,
            },
        )
        .expect("set workflow");
        // 사용자가 끈 워크플로는 계약이 사용량을 써도 페이싱 대상이 아니다.
        assert!(!policy.workflow_pacing_enabled("wf-qa", true));
        let policy = set_workflow(
            dir.path(),
            || panic!("seed must not run twice"),
            SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-report".to_owned(),
                pacing_enabled: true,
                accounts: None,
            },
        )
        .expect("set workflow");
        // 반대로 켠 워크플로는 계약이 아직 사용량을 쓰지 않아도 의도가 남는다.
        assert!(policy.workflow_pacing_enabled("wf-report", false));
        assert!(!policy.workflow_pacing_enabled("wf-qa", true));
        assert_eq!(load_optional(dir.path()).expect("load"), Some(policy));

        assert!(matches!(
            set_workflow(
                dir.path(),
                no_seed,
                SetUsageBudgetWorkflowRequest {
                    workflow_id: " ".to_owned(),
                    pacing_enabled: true,
                    accounts: None,
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn auto_cadence_follows_the_guard_window_label() {
        let mut policy = UsageBudgetPolicy::default();
        assert_eq!(policy.auto_cadence_minutes(), DEFAULT_AUTO_CADENCE_MINUTES);
        policy.defaults.guard_window_label = Some("5시간".to_owned());
        assert_eq!(policy.auto_cadence_minutes(), 300);
        policy.defaults.guard_window_label = Some("90분".to_owned());
        assert_eq!(policy.auto_cadence_minutes(), 90);
        policy.defaults.guard_window_label = Some("1일".to_owned());
        assert_eq!(policy.auto_cadence_minutes(), 24 * 60);
        // 모델 이름이 앞에 붙은 창 라벨도 꼬리의 창 길이로 읽는다("Fable 7일").
        policy.defaults.guard_window_label = Some("Fable 7일".to_owned());
        assert_eq!(policy.auto_cadence_minutes(), 7 * 24 * 60);
        // 해석할 수 없는 라벨은 기본 간격으로 되돌아간다.
        policy.defaults.guard_window_label = Some("weekly".to_owned());
        assert_eq!(policy.auto_cadence_minutes(), DEFAULT_AUTO_CADENCE_MINUTES);
        policy.defaults.guard_window_label = Some("0일".to_owned());
        assert_eq!(policy.auto_cadence_minutes(), DEFAULT_AUTO_CADENCE_MINUTES);
    }

    #[test]
    fn workflow_accounts_are_kept_replaced_and_cleared_explicitly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let policy = set_workflow(
            dir.path(),
            no_seed,
            SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-qa".to_owned(),
                pacing_enabled: true,
                accounts: Some(vec!["claude-a".to_owned(), " ".to_owned()]),
            },
        )
        .expect("set accounts");
        assert_eq!(
            policy.workflow_accounts("wf-qa").map(|set| set.len()),
            Some(1)
        );
        // 관리 탭의 페이싱 토글처럼 accounts를 생략한 갱신은 참여 계정을 지우지 않는다.
        let policy = set_workflow(
            dir.path(),
            no_seed,
            SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-qa".to_owned(),
                pacing_enabled: false,
                accounts: None,
            },
        )
        .expect("toggle keeps accounts");
        assert!(!policy.workflow_pacing_enabled("wf-qa", true));
        assert!(policy.workflow_accounts("wf-qa").is_some());
        // 빈 배열은 제한 해제다.
        let policy = set_workflow(
            dir.path(),
            no_seed,
            SetUsageBudgetWorkflowRequest {
                workflow_id: "wf-qa".to_owned(),
                pacing_enabled: false,
                accounts: Some(Vec::new()),
            },
        )
        .expect("clear accounts");
        assert_eq!(policy.workflow_accounts("wf-qa"), None);
    }

    #[test]
    fn savings_defaults_are_validated_and_ceilings_can_be_cleared_with_zero() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(matches!(
            set_savings(
                dir.path(),
                no_seed,
                SavingsDefaults {
                    target_reduction_percent: Some(20.0),
                    baseline_runs: 0,
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        let policy = set_savings(
            dir.path(),
            no_seed,
            SavingsDefaults {
                target_reduction_percent: Some(20.0),
                baseline_runs: 3,
            },
        )
        .expect("set savings");
        assert_eq!(policy.savings.target_reduction_percent, Some(20.0));
        assert_eq!(policy.savings.baseline_runs, 3);
        let base = |ceiling: Option<u64>| SetUsageBudgetConsumerRequest {
            schedule_id: "s-qa".to_owned(),
            enabled: true,
            priority: None,
            label: None,
            workflow_id: None,
            max_tokens_per_run: ceiling,
            max_cost_percent_per_run: None,
            enforce_ceiling: None,
            reasoning_efforts: None,
            spend_profile: None,
        };
        let policy = set_consumer(dir.path(), no_seed, base(Some(50_000))).expect("set");
        assert_eq!(policy.consumers["s-qa"].max_tokens_per_run, Some(50_000));
        // 레인별 추론수준: 주면 통째로 교체, 생략은 유지, 사다리 밖 값은 거절, 빈 맵은 전부 자동.
        let with_lanes = |lanes: Option<BTreeMap<ProviderId, LaneReasoningEffort>>| {
            SetUsageBudgetConsumerRequest {
                reasoning_efforts: lanes,
                spend_profile: None,
                ..base(None)
            }
        };
        let lanes = BTreeMap::from([
            (
                ProviderId::Claude,
                LaneReasoningEffort {
                    fixed: Some(ReasoningEffort::Xhigh),
                    max_auto: None,
                    min_auto: None,
                },
            ),
            (
                ProviderId::Codex,
                LaneReasoningEffort {
                    fixed: None,
                    max_auto: Some(ReasoningEffort::High),
                    min_auto: None,
                },
            ),
        ]);
        let policy =
            set_consumer(dir.path(), no_seed, with_lanes(Some(lanes.clone()))).expect("set");
        assert_eq!(policy.consumers["s-qa"].reasoning_efforts, lanes);
        let policy = set_consumer(dir.path(), no_seed, with_lanes(None)).expect("set");
        assert_eq!(policy.consumers["s-qa"].reasoning_efforts, lanes);
        let beyond_ladder = BTreeMap::from([(
            ProviderId::Codex,
            LaneReasoningEffort {
                fixed: Some(ReasoningEffort::Max),
                max_auto: None,
                min_auto: None,
            },
        )]);
        assert!(matches!(
            set_consumer(dir.path(), no_seed, with_lanes(Some(beyond_ladder))),
            Err(CoreError::InvalidInput(message)) if message.contains("codex") && message.contains("xhigh")
        ));
        let policy =
            set_consumer(dir.path(), no_seed, with_lanes(Some(BTreeMap::new()))).expect("set");
        assert!(policy.consumers["s-qa"].reasoning_efforts.is_empty());
        // 생략은 유지, 0은 해제.
        let policy = set_consumer(dir.path(), no_seed, base(None)).expect("set");
        assert_eq!(policy.consumers["s-qa"].max_tokens_per_run, Some(50_000));
        let policy = set_consumer(dir.path(), no_seed, base(Some(0))).expect("set");
        assert_eq!(policy.consumers["s-qa"].max_tokens_per_run, None);
    }

    /// 소비 성향은 칸이 없으면 유지, `null`이면 해제다. 화면에서 성향을 '기본값 따름'이나
    /// '직접 설정'으로 돌리는 길이 이 해제뿐이라, 미지정과 같게 읽으면 한 번 고른 성향에서
    /// 빠져나올 수 없다(참여 토글 같은 다른 저장이 성향을 지우지도 않아야 한다).
    #[test]
    fn a_consumer_spend_profile_is_kept_when_absent_and_cleared_when_null() {
        let dir = tempfile::tempdir().expect("tempdir");
        let request = |body: serde_json::Value| -> SetUsageBudgetConsumerRequest {
            serde_json::from_value(body).expect("request")
        };
        let policy = set_consumer(
            dir.path(),
            no_seed,
            request(json!({ "scheduleId": "s-qa", "enabled": true, "spendProfile": "quality" })),
        )
        .expect("set");
        assert_eq!(
            policy.consumers["s-qa"].spend_profile,
            Some(SpendProfile::Quality)
        );
        let policy = set_consumer(
            dir.path(),
            no_seed,
            request(json!({ "scheduleId": "s-qa", "enabled": true })),
        )
        .expect("set");
        assert_eq!(
            policy.consumers["s-qa"].spend_profile,
            Some(SpendProfile::Quality)
        );
        let policy = set_consumer(
            dir.path(),
            no_seed,
            request(json!({ "scheduleId": "s-qa", "enabled": true, "spendProfile": null })),
        )
        .expect("set");
        assert_eq!(policy.consumers["s-qa"].spend_profile, None);
    }

    /// 기본 성향은 기본값 한 벌을 통째로 교체하므로 비운 값도 그대로 남는다. 소비자 쪽과
    /// 규칙이 다른 자리라 두 경로를 같은 곳에서 붙잡아 둔다.
    #[test]
    fn the_default_spend_profile_saves_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let defaults = |body: serde_json::Value| -> UsageBudgetDefaults {
            serde_json::from_value(body).expect("defaults")
        };
        let policy = set_defaults(
            dir.path(),
            no_seed,
            defaults(json!({ "targetPercent": 90.0, "spendProfile": "saver" })),
        )
        .expect("set defaults");
        assert_eq!(policy.defaults.spend_profile, Some(SpendProfile::Saver));
        let policy = set_defaults(
            dir.path(),
            no_seed,
            defaults(json!({ "targetPercent": 90.0, "spendProfile": null })),
        )
        .expect("set defaults");
        assert_eq!(policy.defaults.spend_profile, None);
    }

    #[test]
    fn launch_gate_allows_registered_consumers_and_their_workflows_manual_runs() {
        let mut policy = UsageBudgetPolicy::default();
        // 선택이 꺼져 있으면 전부 허용.
        assert!(policy.launch_allowed(Some("anyone"), Some("wf-any")));
        policy.consumers.insert(
            "s-qa".to_owned(),
            ConsumerBudgetConfig {
                enabled: true,
                workflow_id: Some("wf-qa".to_owned()),
                ..ConsumerBudgetConfig::default()
            },
        );
        policy.consumers.insert(
            "s-off".to_owned(),
            ConsumerBudgetConfig {
                enabled: false,
                workflow_id: Some("wf-off".to_owned()),
                ..ConsumerBudgetConfig::default()
            },
        );
        // 등록·활성 반복 요청은 허용, 꺼진 것·미등록은 거부.
        assert!(policy.launch_allowed(Some("s-qa"), Some("wf-qa")));
        assert!(!policy.launch_allowed(Some("s-off"), Some("wf-off")));
        assert!(!policy.launch_allowed(Some("s-unknown"), Some("wf-unknown")));
        // 수동 실행: 소비자 id가 워크플로 id로 온다 — 그 워크플로를 켠 소비자가 있으면 허용.
        assert!(policy.launch_allowed(Some("wf-qa"), Some("wf-qa")));
        assert!(!policy.launch_allowed(Some("wf-off"), Some("wf-off")));
        assert!(!policy.launch_allowed(None, None));
    }
}
