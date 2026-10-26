//! 앱 전체가 쓰는 "지금"의 단일 정의.
//!
//! 저장본·수신함·사용량 기록의 타임스탬프는 모두 에포크 밀리초 `i64`인데,
//! `accounts`·`scheduler`·`chat`을 비롯한 십수 개 모듈이 같은 세 줄을 각자 적어 두었고
//! 그 사이에 미묘한 차이가 끼어 있었다. 넘침·에포크 이전을 만나면 어떤 사본은 0을,
//! 어떤 사본은 `as` 절단값을 돌려주고, 두 사본은 `chrono`로 우회한다. 값이 갈릴 일이
//! 실제로는 없는 차이지만 "지금이 무엇인가"를 모듈마다 다시 정하고 있다는 뜻이라
//! 여기 하나로 모았다.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 지금을 에포크 밀리초로 읽는다.
///
/// 시스템 시계가 에포크 이전이면 `0`, `i64`를 넘기면 `i64::MAX`로 붙잡는다.
/// 넘침에 의한 역행은 막지만 시스템 시계 보정에 따른 역행은 그대로 반영한다.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(epoch_duration_ms)
        .unwrap_or(0)
}

fn epoch_duration_ms(elapsed: Duration) -> i64 {
    elapsed.as_millis().min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2020-01-01T00:00:00Z. 단위를 초·나노초로 잘못 잡으면 이 경계를 넘지 못한다.
    const YEAR_2020_MS: i64 = 1_577_836_800_000;

    #[test]
    fn now_ms_reads_a_plausible_epoch_millisecond() {
        let now = now_ms();
        assert!(now > YEAR_2020_MS, "epoch millisecond expected, got {now}");
    }

    #[test]
    fn epoch_duration_ms_uses_epoch_milliseconds() {
        // V2: 변환 규칙은 실제 벽시계 대신 고정된 시각으로 검사한다.
        let elapsed = Duration::new(1_577_836_800, 123_456_789);
        assert_eq!(epoch_duration_ms(elapsed), YEAR_2020_MS + 123);
    }

    #[test]
    fn epoch_duration_ms_truncates_submillisecond_precision() {
        for (elapsed, expected) in [
            (Duration::ZERO, 0),
            (Duration::from_nanos(999_999), 0),
            (Duration::from_nanos(1_000_000), 1),
            (Duration::from_nanos(1_999_999), 1),
        ] {
            assert_eq!(epoch_duration_ms(elapsed), expected, "{elapsed:?}");
        }
    }

    #[test]
    fn epoch_duration_ms_saturates_at_i64_max() {
        let max_ms = i64::MAX as u64;
        for (elapsed, expected) in [
            (Duration::from_millis(max_ms - 1), i64::MAX - 1),
            (Duration::from_millis(max_ms), i64::MAX),
            (Duration::from_millis(max_ms + 1), i64::MAX),
            (Duration::MAX, i64::MAX),
        ] {
            assert_eq!(epoch_duration_ms(elapsed), expected, "{elapsed:?}");
        }
    }
}
