//! 카탈로그 갱신 상태 기록.
//!
//! 스냅샷 읽기(`manager_snapshot`)는 `RwLock` 읽기여서 갱신이 완전히 멈춰도 절대
//! 실패하지 않는다. 그래서 예전에는 응답하지 않는 스킬 루트 하나 때문에 세션 목록이
//! 프로세스 수명 내내 기동 시점 상태로 굳어도 화면에 아무 표시가 없었고, 사용자는
//! "특정 공급자 세션만 안 보인다"로 관측했다. 이 모듈은 마지막으로 성공한 갱신 시각,
//! 진행 중 여부, 포기한 스캔 루트를 남겨 화면이 "지금 보고 있는 목록은 언제 기준인지"를
//! 말할 수 있게 한다.
//!
//! 상태 전이는 전부 [`HealthState`]의 순수 메서드이고, 전역 정적은 그 위의 얇은 래퍼다.
//! 테스트는 전역 상태 경쟁 없이 `HealthState`를 직접 검증한다.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::clock::now_ms;

/// 마지막 성공 갱신이 이 시간을 넘기면 화면에 "오래된 목록"으로 알린다.
pub const STALE_AFTER_MS: i64 = 5 * 60 * 1000;

/// 감시자가 붙는 스캔 종류. 하나가 멈춰도 나머지는 계속 갱신된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanKind {
    Skills,
    Agents,
    Artifacts,
}

impl ScanKind {
    #[cfg(test)]
    pub const ALL: [Self; 3] = [Self::Skills, Self::Agents, Self::Artifacts];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Agents => "agents",
            Self::Artifacts => "artifacts",
        }
    }

    /// 화면에 그대로 쓰는 이름.
    pub fn label(self) -> &'static str {
        match self {
            Self::Skills => "스킬",
            Self::Agents => "에이전트",
            Self::Artifacts => "아티팩트",
        }
    }

    /// 스캔 스레드 이름에 쓰는 식별자.
    pub fn thread_name(self) -> &'static str {
        match self {
            Self::Skills => "skill",
            Self::Agents => "agent",
            Self::Artifacts => "artifact",
        }
    }
}

impl std::fmt::Display for ScanKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ScanKind {
    type Err = crate::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "skills" => Ok(Self::Skills),
            "agents" => Ok(Self::Agents),
            "artifacts" => Ok(Self::Artifacts),
            _ => Err(crate::CoreError::InvalidInput(format!(
                "알 수 없는 스캔 종류입니다: {s}. skills|agents|artifacts 중 하나를 쓰세요"
            ))),
        }
    }
}

/// 제한 시간 안에 끝나지 않아 포기한 스캔 한 건.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradedScan {
    pub kind: ScanKind,
    pub label: String,
    /// 다시 시도할 시각(epoch ms). 쿨다운이 끝나기 전에는 스캔을 띄우지 않는다.
    pub retry_at: Option<i64>,
    pub message: String,
}

/// 화면으로 내보내는 갱신 상태.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHealth {
    pub session_revision: u64,
    pub resource_revision: u64,
    /// 마지막으로 성공한 세션 조정 시각(epoch ms).
    pub last_reconciled_at: Option<i64>,
    pub last_reconcile_error: Option<String>,
    pub reconcile_in_flight: bool,
    pub last_resource_scan_at: Option<i64>,
    pub degraded_scans: Vec<DegradedScan>,
    /// 마지막 성공 갱신이 [`STALE_AFTER_MS`]를 넘었다.
    pub stale: bool,
    pub checked_at: i64,
}

/// 갱신 상태 원본. 전역 정적과 테스트가 함께 쓰는 순수 상태 기계다.
#[derive(Debug)]
pub(crate) struct HealthState {
    /// 프로세스가 시작한 시각. 한 번도 조정하지 못한 경우의 "언제부터 멈췄는지" 기준.
    started_at: i64,
    session_revision: u64,
    resource_revision: u64,
    last_reconciled_at: Option<i64>,
    last_reconcile_error: Option<String>,
    in_flight: u32,
    last_resource_scan_at: Option<i64>,
    degraded: BTreeMap<ScanKind, DegradedScan>,
}

impl HealthState {
    pub(crate) fn new(started_at: i64) -> Self {
        Self {
            started_at,
            session_revision: 0,
            resource_revision: 0,
            last_reconciled_at: None,
            last_reconcile_error: None,
            in_flight: 0,
            last_resource_scan_at: None,
            degraded: BTreeMap::new(),
        }
    }

    pub(crate) fn begin_reconcile(&mut self) {
        self.in_flight = self.in_flight.saturating_add(1);
    }

    /// 조정 1건이 끝났다. 성공하면 기준 시각과 개정 번호를 갱신하고 이전 오류를 지운다.
    pub(crate) fn finish_reconcile(&mut self, now: i64, outcome: Result<u64, String>) {
        self.in_flight = self.in_flight.saturating_sub(1);
        match outcome {
            Ok(revision) => {
                self.session_revision = revision;
                self.last_reconciled_at = Some(now);
                self.last_reconcile_error = None;
            }
            Err(message) => self.last_reconcile_error = Some(message),
        }
    }

    pub(crate) fn note_resource_scan(&mut self, now: i64, revision: u64) {
        self.resource_revision = revision;
        self.last_resource_scan_at = Some(now);
    }

    pub(crate) fn note_scan_timeout(
        &mut self,
        kind: ScanKind,
        retry_at: Option<i64>,
        message: String,
    ) {
        self.degraded.insert(
            kind,
            DegradedScan {
                kind,
                label: kind.label().to_owned(),
                retry_at,
                message,
            },
        );
    }

    pub(crate) fn note_scan_ok(&mut self, kind: ScanKind) {
        self.degraded.remove(&kind);
    }

    pub(crate) fn view(&self, now: i64) -> CatalogHealth {
        let baseline = self.last_reconciled_at.unwrap_or(self.started_at);
        CatalogHealth {
            session_revision: self.session_revision,
            resource_revision: self.resource_revision,
            last_reconciled_at: self.last_reconciled_at,
            last_reconcile_error: self.last_reconcile_error.clone(),
            reconcile_in_flight: self.in_flight > 0,
            last_resource_scan_at: self.last_resource_scan_at,
            degraded_scans: self.degraded.values().cloned().collect(),
            stale: now.saturating_sub(baseline) > STALE_AFTER_MS,
            checked_at: now,
        }
    }
}

fn state() -> &'static Mutex<HealthState> {
    static STATE: OnceLock<Mutex<HealthState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HealthState::new(now_ms())))
}

/// 잠금이 깨져도 기록은 포기하고 본 작업을 계속한다. 상태 기록이 기능을 막으면 안 된다.
fn with_state(update: impl FnOnce(&mut HealthState)) {
    if let Ok(mut state) = state().lock() {
        update(&mut state);
    }
}

pub(crate) fn begin_reconcile() {
    with_state(HealthState::begin_reconcile);
}

pub(crate) fn finish_reconcile(outcome: Result<u64, String>) {
    let now = now_ms();
    with_state(|state| state.finish_reconcile(now, outcome));
}

pub(crate) fn note_resource_scan(revision: u64) {
    let now = now_ms();
    with_state(|state| state.note_resource_scan(now, revision));
}

pub(crate) fn note_scan_timeout(kind: ScanKind, retry_after_ms: u128, message: String) {
    let retry_at = now_ms().saturating_add(i64::try_from(retry_after_ms).unwrap_or(i64::MAX));
    with_state(|state| state.note_scan_timeout(kind, Some(retry_at), message));
}

pub(crate) fn note_scan_ok(kind: ScanKind) {
    with_state(|state| state.note_scan_ok(kind));
}

/// 화면이 읽는 현재 상태. 잠금이 깨진 경우에도 빈 값 대신 "확인 시각"은 채워 보낸다.
pub fn health() -> CatalogHealth {
    let now = now_ms();
    match state().lock() {
        Ok(state) => state.view(now),
        Err(_) => CatalogHealth {
            checked_at: now,
            ..CatalogHealth::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: i64 = 1_000_000;

    #[test]
    fn a_fresh_state_is_stale_once_the_process_runs_without_a_successful_reconcile() {
        let state = HealthState::new(START);
        assert!(!state.view(START + 1_000).stale);
        assert!(state.view(START + STALE_AFTER_MS + 1).stale);
    }

    #[test]
    fn a_successful_reconcile_moves_the_staleness_baseline_and_clears_the_error() {
        let mut state = HealthState::new(START);
        state.begin_reconcile();
        state.finish_reconcile(START + 10, Err("잠금 시간 초과".to_owned()));
        assert_eq!(
            state.view(START + 10).last_reconcile_error.as_deref(),
            Some("잠금 시간 초과")
        );
        assert!(!state.view(START + 10).reconcile_in_flight);

        state.begin_reconcile();
        state.finish_reconcile(START + STALE_AFTER_MS, Ok(42));
        let view = state.view(START + STALE_AFTER_MS + 1);
        assert_eq!(view.session_revision, 42);
        assert_eq!(view.last_reconciled_at, Some(START + STALE_AFTER_MS));
        assert_eq!(view.last_reconcile_error, None);
        assert!(!view.stale);
    }

    #[test]
    fn an_in_flight_reconcile_is_reported_until_it_finishes() {
        let mut state = HealthState::new(START);
        state.begin_reconcile();
        state.begin_reconcile();
        assert!(state.view(START).reconcile_in_flight);
        state.finish_reconcile(START, Ok(1));
        assert!(state.view(START).reconcile_in_flight);
        state.finish_reconcile(START, Ok(2));
        assert!(!state.view(START).reconcile_in_flight);
    }

    #[test]
    fn a_timed_out_scan_is_listed_until_it_succeeds_again() {
        let mut state = HealthState::new(START);
        state.note_scan_timeout(
            ScanKind::Skills,
            Some(START + 60_000),
            "응답 없음".to_owned(),
        );
        state.note_scan_timeout(ScanKind::Agents, None, "응답 없음".to_owned());
        let view = state.view(START);
        assert_eq!(view.degraded_scans.len(), 2);
        assert_eq!(view.degraded_scans[0].kind, ScanKind::Skills);
        assert_eq!(view.degraded_scans[0].label, "스킬");
        assert_eq!(view.degraded_scans[0].retry_at, Some(START + 60_000));

        state.note_scan_ok(ScanKind::Skills);
        let view = state.view(START);
        assert_eq!(view.degraded_scans.len(), 1);
        assert_eq!(view.degraded_scans[0].kind, ScanKind::Agents);
    }

    #[test]
    fn the_resource_scan_timestamp_is_independent_of_session_reconciliation() {
        let mut state = HealthState::new(START);
        state.note_resource_scan(START + 5, 7);
        let view = state.view(START + 5);
        assert_eq!(view.resource_revision, 7);
        assert_eq!(view.last_resource_scan_at, Some(START + 5));
        assert_eq!(view.last_reconciled_at, None);
    }

    #[test]
    fn scan_kind_contract_and_string_representation() {
        use std::str::FromStr;

        assert_eq!(ScanKind::ALL.len(), 3);
        assert_eq!(
            ScanKind::ALL,
            [ScanKind::Skills, ScanKind::Agents, ScanKind::Artifacts]
        );

        for kind in ScanKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(ScanKind::from_str(kind.as_str()).unwrap(), kind);
            let json = serde_json::to_string(&kind).expect("serialize");
            let deserialized: ScanKind = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(deserialized, kind);
        }

        assert_eq!(ScanKind::Skills.as_str(), "skills");
        assert_eq!(ScanKind::Skills.label(), "스킬");
        assert_eq!(ScanKind::Skills.thread_name(), "skill");

        assert_eq!(ScanKind::Agents.as_str(), "agents");
        assert_eq!(ScanKind::Agents.label(), "에이전트");
        assert_eq!(ScanKind::Agents.thread_name(), "agent");

        assert_eq!(ScanKind::Artifacts.as_str(), "artifacts");
        assert_eq!(ScanKind::Artifacts.label(), "아티팩트");
        assert_eq!(ScanKind::Artifacts.thread_name(), "artifact");

        assert!(ScanKind::from_str("unknown").is_err());
    }
}
