//! 사용량 예산 조정자 — 여러 페이싱 소비자(반복 요청)가 같은 계정·창을 나눠 쓸 때의
//! 순수 조정 계층.
//!
//! `usage_pacing`이 저장소·잠금·요청 형태를 맡고, 이 모듈은 값만 받아 값만 돌려준다.
//! I/O가 없어 시험이 시각과 상태를 직접 정할 수 있다.
//!
//! 세 가지 문제를 여기서 푼다.
//! - **여유 이중 배정.** 소비자 A가 방금 예약한 소비는 아직 사용량 표본에 보이지 않는다.
//!   30분 뒤 소비자 B가 같은 계정을 보면 A의 몫까지 자기 여유로 계산한다. 예약(claim)을
//!   미정산 금액으로 보고 여유에서 차감한다.
//! - **배분.** 한 회차의 예산을 활성 소비자들이 나눈다. 예산을 %p로 쪼개면 각자의 몫이
//!   회당 소비에 못 미쳐 아무도 돌지 않는 교착이 생기므로, 기동 수(정수)를 나눈다.
//! - **측정 구간 겹침.** 계획 기록마다 "다음 표본"을 간격의 두 배 안에서 가장 최신으로
//!   잡으면 다음 회차의 소비까지 포함한다. 소비자를 가리지 않고 시각이 붙어 있는 계획
//!   기록을 한 회차 그룹으로 묶고, 그룹 사이를 측정 구간으로 삼는다.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use crate::accounts::AccountUsageWindow;

/// 같은 창의 리셋 시각으로 인정할 오차. 공급자가 돌려주는 리셋 시각은 반올림 때문에
/// 표본마다 1초씩 흔들린다(`01:59:59` ↔ `02:00:00`). 완전 일치를 요구하면 그 흔들림을
/// 창 리셋으로 오인한다 — 실측에서는 멀쩡한 관측을 절반쯤 버리고, 예약에서는 아직 표본에
/// 보이지 않는 소비를 없는 것으로 쳐 같은 회차를 두 번 계산한다.
pub(crate) const RESETS_AT_JITTER_MS: i64 = 60_000;

/// 앞 관측(사용률·리셋 시각)과 뒤 관측의 리셋 시각이 같은 창을 가리키는지. 리셋 시각이
/// 지터 안에서 같으면 같은 창이고, 둘 다 모르면 이어 붙인다. 소비가 없어 리셋 시각이 없던
/// 창이 시각을 얻는 것은 리셋이 아니라 **창이 열린 것**이므로 같은 창이다 — 첫 기동의
/// 소비가 그 뒤 표본에 실리고, 첫 기동 예약도 살아 있어야 한다. 그 밖에 한쪽만 모르면
/// 이어 붙일 근거가 없어 다른 창으로 본다.
pub(crate) fn same_window(before_used: f64, before: Option<i64>, after: Option<i64>) -> bool {
    match (before, after) {
        (Some(before), Some(after)) => (after - before).abs() <= RESETS_AT_JITTER_MS,
        (None, None) => true,
        (None, Some(_)) => before_used <= 0.0,
        (Some(_), None) => false,
    }
}

/// 한 소비자가 한 계정·창에 남긴 예약. 계획 기록의 항목 하나를 계정 관점으로 펼친 것.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Claim {
    pub consumer_id: String,
    pub at: i64,
    /// 발행한 소비자의 회차 간격. 이만큼 지나면 그 소비자의 다음 회차가 시작되므로
    /// 예약은 닫힌다.
    pub cadence_ms: i64,
    pub count: usize,
    /// 예약 시점에 예상한 소비(%p) = 기동 수 × 회당 소비.
    pub expected_cost_percent: f64,
    /// 예약 시점의 창 사용률. 이후 오른 만큼을 정산에 쓴다.
    pub used_percent_at_claim: f64,
    pub resets_at_at_claim: Option<i64>,
    /// 이 예약을 낸 실행이 이 계정에 띄운 채팅이 아직 돌고 있는지(살아 있는 채팅으로
    /// 확인). 돌고 있으면 그 소비는 표본에 다 보이지 않았으므로 발행자 간격이 지나도
    /// 예약을 닫지 않는다.
    pub active: bool,
}

/// 아직 정산되지 않은 예약만 남긴다. 실행이 돌고 있는 예약은 모두 열려 있고, 실행이 없는
/// 예약은 소비자마다 가장 새 것 하나만 열려 있다. 결과는 시각 오름차순이다.
///
/// 닫히는 조건: 발행자 간격만큼 지남(그 소비자의 다음 회차가 시작됨 — 다만 그 예약의
/// 실행이 아직 돌고 있으면 소비가 표본에 없으므로 열어 둔다) / 창이 리셋됨(리셋 시각이
/// 지터를 넘게 바뀌었거나 사용률이 기준선 아래로 내려감) / 실행이 없는 예약인데 같은
/// 소비자의 더 새 예약이 있음. 기동 수나 기대 소비가 0인 기록은 존재 표시일 뿐이라 예약이
/// 아니다.
///
/// 발행자 간격은 스케줄러가 다음 회차를 띄우는 시각과 정확히 같다. 그 시각에 실행이 아직
/// 돌고 있는데 TTL로 닫으면 같은 계정에 또 기동한다 — 공유 워크트리 때문에 회차당 1건인
/// 워크플로에서는 두 런타임이 한 트리를 만지게 된다.
///
/// "소비자마다 하나"는 회차 간격이 실행 시간보다 길던 시절의 규칙이다. 자동 주기가 10분까지
/// 좁혀지고 실행이 30~40분 걸리면 한 소비자의 예약 서너 개가 동시에 살아 있는데, 그중 가장
/// 새 것만 세면 진행 중인 나머지 실행의 소비가 여유에서 빠지지 않아 짧은 창을 넘긴다
/// (2026-09-04 실측: 10분 간격 회차가 같은 계정에 4건을 겹쳐 띄워 5시간 창 100%).
pub(crate) fn open_claims(claims: &[Claim], now: i64, window: &AccountUsageWindow) -> Vec<Claim> {
    let mut newest_idle: BTreeMap<&str, &Claim> = BTreeMap::new();
    let mut active: Vec<&Claim> = Vec::new();
    for claim in claims {
        if claim.count == 0 || claim.expected_cost_percent <= 0.0 {
            continue;
        }
        if !claim.active && now >= claim.at.saturating_add(claim.cadence_ms.max(0)) {
            continue;
        }
        if !same_window(
            claim.used_percent_at_claim,
            claim.resets_at_at_claim,
            window.resets_at,
        ) || window.used_percent < claim.used_percent_at_claim
        {
            continue;
        }
        if claim.active {
            active.push(claim);
            continue;
        }
        match newest_idle.get(claim.consumer_id.as_str()) {
            Some(existing) if existing.at >= claim.at => {}
            _ => {
                newest_idle.insert(claim.consumer_id.as_str(), claim);
            }
        }
    }
    let mut open: Vec<Claim> = active
        .into_iter()
        .chain(newest_idle.into_values())
        .cloned()
        .collect();
    open.sort_by(|left, right| {
        left.at
            .cmp(&right.at)
            .then_with(|| left.consumer_id.cmp(&right.consumer_id))
    });
    open
}

/// 미정산 %p. 가장 오래된 예약의 기준선 이후 오른 만큼을 오래된 예약부터 차례로
/// 정산(FIFO)하고, 정산되지 않은 기대 소비를 합한다.
///
/// 예약마다 자기 기준선으로 따로 정산하면 나중 예약의 기준선 이후 증가가 두 예약에
/// 겹쳐 잡혀 미정산이 과소평가된다. 오른 %p 하나는 예약 하나에만 쓴다.
pub(crate) fn outstanding_percent(open: &[Claim], used_percent: f64) -> f64 {
    let Some(oldest) = open.first() else {
        return 0.0;
    };
    let mut remaining = (used_percent - oldest.used_percent_at_claim).max(0.0);
    let mut outstanding = 0.0;
    for claim in open {
        let settled = claim.expected_cost_percent.min(remaining);
        outstanding += claim.expected_cost_percent - settled;
        remaining -= settled;
    }
    outstanding
}

/// 최근 `window_ms` 안에 기록을 남긴 소비자 집합. 기동 수가 0인 존재 기록도 센다 —
/// 쉬고 있어도 이 창을 쓰는 소비자다. 현재 소비자를 빼는 것은 호출부가 한다.
pub(crate) fn active_consumers(
    presence: &[(String, i64)],
    now: i64,
    window_ms: i64,
) -> BTreeSet<String> {
    presence
        .iter()
        .filter(|(_, at)| *at >= now.saturating_sub(window_ms))
        .map(|(consumer_id, _)| consumer_id.clone())
        .collect()
}

/// 이번 회차의 기동 수를 나눌 소비자 하나의 수요.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ConsumerDemand {
    pub consumer_id: String,
    /// 이 소비자가 한 회차에 원하는 최대 기동 수(현재 소비자의 간격으로 환산).
    pub demand_runs: usize,
    /// 마지막으로 실제 기동을 배정받은 시각. 없으면 같은 우선순위 안에서 가장 먼저 받는다.
    pub last_served_at: Option<i64>,
    /// 숫자가 낮을수록 먼저 받는다(0이 가장 높음). 같은 값끼리는 라운드로빈.
    pub priority: u8,
}

/// 기동 수를 우선순위 순으로(숫자가 낮은 쪽이 먼저, 0이 가장 높음), 같은 우선순위 안에서는
/// 라운드로빈으로 나눈다. 높은 우선순위 그룹이 자기 수요를 다 채운 뒤 남은 건수가 다음
/// 그룹으로 흐르고, 그룹 안에서는 가장 오래 못 받은 소비자부터 한 건씩 돌아가며 받는다.
/// 현재 소비자가 받는 건수를 돌려준다.
///
/// %p가 아니라 건수를 나누는 이유: 예산 3%p를 두 소비자에게 1.5씩 주면 회당 소비 2%p인
/// 둘 다 0건이 되어 아무도 돌지 않는다. 건수로 나누면 한 건이라도 누군가 받고, 다음
/// 회차에는 못 받은 쪽이 먼저 받는다. 우선순위가 높은 소비자의 수요가 예산을 다 차지하면
/// 낮은 소비자는 0건이다 — 그것이 우선순위의 뜻이고, 높은 쪽이 쉬면(활성 집합에서
/// 빠지면) 몫은 저절로 아래로 흐른다.
pub(crate) fn allocate_runs(
    current: &str,
    demands: &[ConsumerDemand],
    budget_runs: usize,
) -> usize {
    if budget_runs == 0 {
        return 0;
    }
    let mut order: Vec<&ConsumerDemand> = demands
        .iter()
        .filter(|demand| demand.demand_runs > 0)
        .collect();
    order.sort_by(|left, right| {
        left.priority.cmp(&right.priority).then_with(|| {
            match (left.last_served_at, right.last_served_at) {
                (None, None) => left.consumer_id.cmp(&right.consumer_id),
                (None, Some(_)) => Ordering::Less,
                (Some(_), None) => Ordering::Greater,
                (Some(a), Some(b)) => a
                    .cmp(&b)
                    .then_with(|| left.consumer_id.cmp(&right.consumer_id)),
            }
        })
    });
    let mut given: BTreeMap<&str, usize> = BTreeMap::new();
    let mut remaining = budget_runs;
    let mut index = 0;
    while index < order.len() && remaining > 0 {
        let priority = order[index].priority;
        let group: Vec<&ConsumerDemand> = order[index..]
            .iter()
            .take_while(|demand| demand.priority == priority)
            .copied()
            .collect();
        index += group.len();
        loop {
            let mut placed = false;
            for demand in &group {
                if remaining == 0 {
                    break;
                }
                let taken = given.entry(demand.consumer_id.as_str()).or_default();
                if *taken >= demand.demand_runs {
                    continue;
                }
                *taken += 1;
                remaining -= 1;
                placed = true;
            }
            if !placed || remaining == 0 {
                break;
            }
        }
    }
    given.get(current).copied().unwrap_or(0)
}

/// 측정 구간을 만들 계획 기록 하나. 소비자는 상관없다.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlanPoint {
    pub at: i64,
    pub cadence_ms: i64,
    /// (계정 id, 계획 기동 수)
    pub runs: Vec<(String, usize)>,
}

/// 회차 그룹 하나. `[start, end]` 사이에 오른 %p를 `runs`의 합으로 나눈 것이 그 구간의
/// 회당 소비다.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MeasurementGroup {
    pub start: i64,
    pub end: i64,
    pub runs: BTreeMap<String, usize>,
}

/// 계획 기록을 회차 그룹으로 묶는다. 그룹의 첫 기록에서 간격의 절반 안에 든 기록은
/// 같은 회차다(:00 QA와 :30 리팩토링은 한 그룹). 구간의 끝은 다음 그룹의 시작이고,
/// 다음 그룹이 없거나 너무 멀면 `가장 긴 간격 × span_factor`에서 닫는다 — 멈춰 있던
/// 기간의 소비를 회당 비용으로 오인하지 않는다.
pub(crate) fn measurement_groups(points: &[PlanPoint], span_factor: i64) -> Vec<MeasurementGroup> {
    let mut sorted: Vec<&PlanPoint> = points.iter().collect();
    sorted.sort_by_key(|point| point.at);
    struct Open {
        start: i64,
        min_cadence: i64,
        max_cadence: i64,
        runs: BTreeMap<String, usize>,
    }
    let mut groups: Vec<Open> = Vec::new();
    for point in sorted {
        let cadence = point.cadence_ms.max(1);
        let joins = groups.last().is_some_and(|group| {
            point.at.saturating_sub(group.start) < group.min_cadence.min(cadence) / 2
        });
        if !joins {
            groups.push(Open {
                start: point.at,
                min_cadence: cadence,
                max_cadence: cadence,
                runs: BTreeMap::new(),
            });
        }
        let group = groups.last_mut().expect("group just ensured");
        group.min_cadence = group.min_cadence.min(cadence);
        group.max_cadence = group.max_cadence.max(cadence);
        for (account_id, count) in &point.runs {
            *group.runs.entry(account_id.clone()).or_default() += *count;
        }
    }
    let starts: Vec<i64> = groups.iter().map(|group| group.start).collect();
    groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let cap = group
                .start
                .saturating_add(group.max_cadence.saturating_mul(span_factor.max(1)));
            let end = starts
                .get(index + 1)
                .map(|next| (*next).min(cap))
                .unwrap_or(cap);
            MeasurementGroup {
                start: group.start,
                end,
                runs: group.runs,
            }
        })
        .collect()
}

/// 실행 하나가 계정을 쓴 구간.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RunSpan {
    pub start: i64,
    pub end: i64,
}

/// 회차별 회당 소비를 채택하는 데 필요한 관측 가중치 합. 깨끗한 관측 2건 또는 겹친
/// 관측 4건이면 넘는다.
pub(crate) const MIN_CONSUMER_OBSERVATION_WEIGHT: f64 = 2.0;

/// 대상 실행이 같은 계정의 다른 실행과 겹칠 때 증가분에서 가져갈 비율과 관측 가중치.
/// 겹치지 않으면 전부(1.0) 가중 1.0, 겹치면 활성 시간 비율로 나누고 가중 0.5 — 계정
/// 단위 표본 하나로 두 실행을 갈라 본 값이라 덜 믿는다.
pub(crate) fn overlap_share(target: &RunSpan, others: &[RunSpan]) -> (f64, f64) {
    let overlapping: Vec<&RunSpan> = others
        .iter()
        .filter(|other| other.start < target.end && other.end > target.start)
        .collect();
    if overlapping.is_empty() {
        return (1.0, 1.0);
    }
    let target_ms = (target.end - target.start).max(1) as f64;
    let total_ms = target_ms
        + overlapping
            .iter()
            .map(|other| (other.end - other.start).max(1) as f64)
            .sum::<f64>();
    (target_ms / total_ms, 0.5)
}

/// (값, 가중치) 관측의 가중 평균. 가중치 합이 문턱에 못 미치면 None — 표본이 적을 때는
/// 전역 추정으로 물러난다.
pub(crate) fn weighted_mean(observations: &[(f64, f64)]) -> Option<(f64, f64)> {
    let weight: f64 = observations.iter().map(|(_, w)| *w).sum();
    if weight < MIN_CONSUMER_OBSERVATION_WEIGHT {
        return None;
    }
    let total: f64 = observations.iter().map(|(value, w)| value * w).sum();
    Some((total / weight, weight))
}

/// 중앙값. 기준선·현재 소비를 평균이 아니라 중앙값으로 잡아 한 번의 폭주가 목표를 흔들지
/// 않게 한다.
pub(crate) fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let mid = sorted.len() / 2;
    Some(if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    })
}

/// 기준선 대비 절감률(%). 기준선이 0 이하면 정의되지 않는다. 늘었으면 음수.
pub(crate) fn reduction_percent(baseline: f64, current: f64) -> Option<f64> {
    (baseline > 0.0).then(|| (baseline - current) / baseline * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn window(used: f64, resets_at: Option<i64>) -> AccountUsageWindow {
        AccountUsageWindow {
            label: "7일".to_owned(),
            used_percent: used,
            resets_at,
            ..Default::default()
        }
    }

    fn claim(consumer: &str, at: i64, expected: f64, baseline: f64) -> Claim {
        Claim {
            consumer_id: consumer.to_owned(),
            at,
            cadence_ms: 5 * HOUR,
            count: 1,
            expected_cost_percent: expected,
            used_percent_at_claim: baseline,
            resets_at_at_claim: Some(NOW + 50 * HOUR),
            active: false,
        }
    }

    #[test]
    fn a_claim_expires_after_its_issuers_cadence() {
        let claims = vec![claim("qa", NOW - 5 * HOUR, 4.0, 40.0)];
        assert!(open_claims(&claims, NOW, &window(41.0, Some(NOW + 50 * HOUR))).is_empty());
        assert_eq!(
            open_claims(&claims, NOW - HOUR, &window(41.0, Some(NOW + 50 * HOUR))).len(),
            1
        );
    }

    #[test]
    fn a_claim_is_void_after_the_window_reset() {
        let claims = vec![claim("qa", NOW - HOUR, 4.0, 40.0)];
        // 리셋 시각이 바뀜
        assert!(open_claims(&claims, NOW, &window(41.0, Some(NOW + 160 * HOUR))).is_empty());
        // 사용률이 기준선 아래로 내려감
        assert!(open_claims(&claims, NOW, &window(3.0, Some(NOW + 50 * HOUR))).is_empty());
    }

    #[test]
    fn a_claim_survives_reset_time_jitter() {
        // 공급자 리셋 시각은 표본마다 1초쯤 흔들린다. 그 흔들림을 리셋으로 보면 예약이
        // 사라져 같은 회차의 아직 보이지 않는 소비를 두 번 계산한다.
        let claims = vec![claim("qa", NOW - HOUR, 4.0, 40.0)];
        let jittered = window(41.0, Some(NOW + 50 * HOUR + 1_000));
        assert_eq!(open_claims(&claims, NOW, &jittered).len(), 1);
        // 오차를 넘게 움직이면 리셋이다.
        let moved = window(41.0, Some(NOW + 50 * HOUR + 2 * RESETS_AT_JITTER_MS));
        assert!(open_claims(&claims, NOW, &moved).is_empty());
        // 한쪽만 리셋 시각을 모르면 다른 창이다.
        assert!(open_claims(&claims, NOW, &window(41.0, None)).is_empty());
    }

    #[test]
    fn an_opening_claim_survives_the_window_getting_its_reset_time() {
        // 0%·리셋 시각 없음인 창을 첫 기동으로 열면 공급자가 곧 리셋 시각을 준다. 그것은
        // 리셋이 아니라 창이 열린 것이므로 첫 기동 예약은 살아 있어야 한다.
        let mut opening = claim("qa", NOW - HOUR, 2.5, 0.0);
        opening.resets_at_at_claim = None;
        let opened = window(0.2, Some(NOW + 168 * HOUR));
        assert_eq!(
            open_claims(std::slice::from_ref(&opening), NOW, &opened).len(),
            1
        );
        // 소비가 있던 창이 리셋 시각을 잃는 것은 여전히 다른 창이다.
        let started = claim("qa", NOW - HOUR, 2.5, 40.0);
        assert!(open_claims(&[started], NOW, &window(41.0, None)).is_empty());
    }

    #[test]
    fn an_active_claim_stays_open_past_its_issuers_cadence() {
        // 실행이 아직 돌고 있으면 다음 회차가 시작돼도 소비가 표본에 없다. TTL로 닫으면
        // 같은 계정에 또 기동한다.
        let mut running = claim("qa", NOW - 5 * HOUR, 4.0, 40.0);
        running.active = true;
        let open = open_claims(
            std::slice::from_ref(&running),
            NOW,
            &window(41.0, Some(NOW + 50 * HOUR)),
        );
        assert_eq!(open.len(), 1);
        // 리셋은 여전히 닫는다.
        assert!(open_claims(&[running], NOW, &window(3.0, Some(NOW + 50 * HOUR))).is_empty());
    }

    #[test]
    fn only_the_newest_claim_per_consumer_is_open() {
        let claims = vec![
            claim("qa", NOW - 2 * HOUR, 4.0, 40.0),
            claim("qa", NOW - HOUR, 2.0, 42.0),
            claim("refactor", NOW - 90 * 60_000, 1.0, 41.0),
        ];
        let open = open_claims(&claims, NOW, &window(43.0, Some(NOW + 50 * HOUR)));
        let ids: Vec<(&str, f64)> = open
            .iter()
            .map(|c| (c.consumer_id.as_str(), c.expected_cost_percent))
            .collect();
        assert_eq!(ids, vec![("refactor", 1.0), ("qa", 2.0)]);
    }

    #[test]
    fn every_active_claim_of_one_consumer_stays_open() {
        // 10분 간격 회차가 40분짜리 실행을 겹쳐 띄우면 한 소비자의 예약 서너 개가 동시에
        // 돈다. 가장 새 것만 열면 나머지 진행 중 실행의 소비가 여유에서 빠지지 않는다.
        let mut first = claim("qa", NOW - 30 * 60_000, 4.0, 40.0);
        first.active = true;
        let mut second = claim("qa", NOW - 20 * 60_000, 4.0, 41.0);
        second.active = true;
        let mut third = claim("qa", NOW - 10 * 60_000, 4.0, 42.0);
        third.active = true;
        // 실행이 끝난(비활성) 예약은 여전히 소비자마다 가장 새 것 하나만 남는다.
        let idle_old = claim("qa", NOW - 8 * 60_000, 2.0, 43.0);
        let idle_new = claim("qa", NOW - 5 * 60_000, 2.0, 43.0);
        let open = open_claims(
            &[first, second, third, idle_old, idle_new],
            NOW,
            &window(44.0, Some(NOW + 50 * HOUR)),
        );
        let ats: Vec<i64> = open.iter().map(|c| (NOW - c.at) / 60_000).collect();
        assert_eq!(ats, vec![30, 20, 10, 5]);
        // 오른 4%p는 가장 오래된 예약에 먼저 정산되고 나머지 10%p가 미정산으로 남는다.
        assert_eq!(outstanding_percent(&open, 44.0), 10.0);
    }

    #[test]
    fn presence_records_are_not_claims() {
        let mut presence = claim("qa", NOW - HOUR, 0.0, 40.0);
        presence.count = 0;
        assert!(open_claims(&[presence], NOW, &window(40.0, Some(NOW + 50 * HOUR))).is_empty());
    }

    #[test]
    fn an_outstanding_claim_is_netted_against_observed_growth_fifo() {
        // A(기준 40, 기대 4) → B(기준 41, 기대 4), 지금 43. 오른 3%p는 A에 먼저 정산된다:
        // A 미정산 1, B 미정산 4 → 5. 각자 기준선으로 따로 정산하면 1+2=3으로 과소평가.
        let open = vec![
            claim("a", NOW - 2 * HOUR, 4.0, 40.0),
            claim("b", NOW - HOUR, 4.0, 41.0),
        ];
        assert!((outstanding_percent(&open, 43.0) - 5.0).abs() < 1e-9);
        // 충분히 오르면 전부 정산된다.
        assert!((outstanding_percent(&open, 49.0)).abs() < 1e-9);
        assert!((outstanding_percent(&[], 49.0)).abs() < 1e-9);
    }

    #[test]
    fn active_consumers_are_those_with_a_recent_record() {
        let presence = vec![
            ("qa".to_owned(), NOW - HOUR),
            ("refactor".to_owned(), NOW - 9 * HOUR),
            ("old".to_owned(), NOW - 30 * HOUR),
        ];
        let active = active_consumers(&presence, NOW, 10 * HOUR);
        assert_eq!(
            active.into_iter().collect::<Vec<_>>(),
            vec!["qa".to_owned(), "refactor".to_owned()]
        );
    }

    fn demand(consumer: &str, runs: usize, last_served_at: Option<i64>) -> ConsumerDemand {
        ConsumerDemand {
            consumer_id: consumer.to_owned(),
            demand_runs: runs,
            last_served_at,
            priority: 50,
        }
    }

    fn prioritized(consumer: &str, runs: usize, priority: u8) -> ConsumerDemand {
        ConsumerDemand {
            priority,
            ..demand(consumer, runs, None)
        }
    }

    #[test]
    fn higher_priority_consumer_is_served_first_and_leftover_flows_down() {
        // 예산 3건: 우선순위 20(숫자가 낮아 더 높음)인 QA가 수요 2건을 먼저 채우고 남은
        // 1건이 리팩토링(50)으로.
        let demands = vec![prioritized("qa", 2, 20), prioritized("refactor", 4, 50)];
        assert_eq!(allocate_runs("qa", &demands, 3), 2);
        assert_eq!(allocate_runs("refactor", &demands, 3), 1);
        // 예산이 상위 수요보다 작으면 하위는 0건 — 우선순위의 뜻이다.
        assert_eq!(allocate_runs("refactor", &demands, 2), 0);
        assert_eq!(allocate_runs("qa", &demands, 2), 2);
    }

    #[test]
    fn equal_priority_consumers_water_fill() {
        // 같은 우선순위는 라운드로빈: 5건을 수요 6·1로 나누면 1과 4.
        let demands = vec![prioritized("qa", 6, 50), prioritized("refactor", 1, 50)];
        assert_eq!(allocate_runs("qa", &demands, 5), 4);
        assert_eq!(allocate_runs("refactor", &demands, 5), 1);
    }

    #[test]
    fn runs_are_shared_round_robin_between_active_consumers() {
        // 예산 3건, QA 수요 4, 리팩토링 수요 1 → 리팩토링 1, QA 2.
        let demands = vec![demand("qa", 4, None), demand("refactor", 1, None)];
        assert_eq!(allocate_runs("qa", &demands, 3), 2);
        assert_eq!(allocate_runs("refactor", &demands, 3), 1);
    }

    #[test]
    fn unused_demand_of_a_capped_consumer_is_redistributed() {
        // 예산 5건, 리팩토링은 1건만 원함 → 나머지 4건은 QA로.
        let demands = vec![demand("qa", 6, None), demand("refactor", 1, None)];
        assert_eq!(allocate_runs("qa", &demands, 5), 4);
        assert_eq!(allocate_runs("refactor", &demands, 5), 1);
    }

    #[test]
    fn a_single_run_goes_to_the_least_recently_served_consumer() {
        // 예산이 1건뿐이면 %p로 나눌 때처럼 둘 다 0이 되지 않고, 오래 못 받은 쪽이 받는다.
        let demands = vec![
            demand("qa", 4, Some(NOW - HOUR)),
            demand("refactor", 1, Some(NOW - 6 * HOUR)),
        ];
        assert_eq!(allocate_runs("refactor", &demands, 1), 1);
        assert_eq!(allocate_runs("qa", &demands, 1), 0);
        // 한 번도 못 받은 소비자가 가장 먼저다.
        let demands = vec![
            demand("qa", 4, Some(NOW - 30 * HOUR)),
            demand("new", 1, None),
        ];
        assert_eq!(allocate_runs("new", &demands, 1), 1);
    }

    #[test]
    fn zero_budget_or_zero_demand_yields_nothing() {
        let demands = vec![demand("qa", 4, None)];
        assert_eq!(allocate_runs("qa", &demands, 0), 0);
        assert_eq!(allocate_runs("qa", &[demand("qa", 0, None)], 3), 0);
        assert_eq!(allocate_runs("missing", &demands, 3), 0);
    }

    fn point(at: i64, cadence_hours: i64, runs: &[(&str, usize)]) -> PlanPoint {
        PlanPoint {
            at,
            cadence_ms: cadence_hours * HOUR,
            runs: runs
                .iter()
                .map(|(account, count)| ((*account).to_owned(), *count))
                .collect(),
        }
    }

    #[test]
    fn interleaved_claims_within_half_a_cadence_form_one_measurement_group() {
        // QA :00 4건 + 리팩토링 :30 1건 → 한 그룹 5건. 다음 회차 :00이 구간을 닫는다.
        let points = vec![
            point(NOW - 10 * HOUR, 5, &[("a", 2), ("b", 2)]),
            point(NOW - 10 * HOUR + 30 * 60_000, 5, &[("a", 1)]),
            point(NOW - 5 * HOUR, 5, &[("a", 2), ("b", 2)]),
        ];
        let groups = measurement_groups(&points, 2);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].start, NOW - 10 * HOUR);
        assert_eq!(groups[0].end, NOW - 5 * HOUR);
        assert_eq!(groups[0].runs.get("a"), Some(&3));
        assert_eq!(groups[0].runs.get("b"), Some(&2));
        // 마지막 그룹은 다음 그룹이 없어 간격×2에서 닫힌다.
        assert_eq!(groups[1].end, NOW - 5 * HOUR + 10 * HOUR);
    }

    #[test]
    fn a_gap_longer_than_the_span_cap_closes_the_group_early() {
        // 멈췄다 켜서 72시간 뒤에 다음 기록이 오면 구간은 간격×2(10시간)에서 닫힌다.
        let points = vec![
            point(NOW - 80 * HOUR, 5, &[("a", 4)]),
            point(NOW - 8 * HOUR, 5, &[("a", 4)]),
        ];
        let groups = measurement_groups(&points, 2);
        assert_eq!(groups[0].end, NOW - 80 * HOUR + 10 * HOUR);
    }

    #[test]
    fn presence_points_anchor_a_group_without_adding_runs() {
        let points = vec![
            point(NOW - 5 * HOUR, 5, &[]),
            point(NOW - 5 * HOUR + HOUR, 5, &[("a", 1)]),
        ];
        let groups = measurement_groups(&points, 2);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].runs.get("a"), Some(&1));
    }

    #[test]
    fn overlap_share_is_full_without_overlap_and_split_by_active_time_otherwise() {
        let target = RunSpan {
            start: 0,
            end: 60 * 60_000,
        };
        assert_eq!(
            overlap_share(
                &target,
                &[RunSpan {
                    start: 61 * 60_000,
                    end: 90 * 60_000
                }]
            ),
            (1.0, 1.0)
        );
        // 60분 실행과 60분 실행이 30분 겹침 → 활성 시간 60:60 → 절반, 가중 0.5.
        let (share, weight) = overlap_share(
            &target,
            &[RunSpan {
                start: 30 * 60_000,
                end: 90 * 60_000,
            }],
        );
        assert!((share - 0.5).abs() < 1e-9);
        assert_eq!(weight, 0.5);
    }

    #[test]
    fn weighted_mean_requires_enough_weight() {
        assert_eq!(weighted_mean(&[(4.0, 1.0)]), None);
        assert_eq!(weighted_mean(&[(3.0, 0.5), (4.0, 1.0)]), None);
        let (mean, weight) = weighted_mean(&[(3.0, 0.5), (4.0, 1.0), (4.0, 1.0)]).expect("mean");
        assert!((mean - 3.8).abs() < 1e-9);
        assert!((weight - 2.5).abs() < 1e-9);
    }

    #[test]
    fn median_and_reduction_helpers() {
        assert_eq!(median(&[]), None);
        assert_eq!(median(&[3.0]), Some(3.0));
        assert_eq!(median(&[5.0, 1.0, 3.0]), Some(3.0));
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), Some(2.5));
        assert!((reduction_percent(10.0, 8.0).unwrap() - 20.0).abs() < 1e-9);
        assert!((reduction_percent(10.0, 12.0).unwrap() + 20.0).abs() < 1e-9);
        assert_eq!(reduction_percent(0.0, 5.0), None);
    }
}
