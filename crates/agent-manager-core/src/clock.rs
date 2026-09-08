//! 앱 전체가 쓰는 "지금"의 단일 정의.
//!
//! 저장본·수신함·사용량 기록의 타임스탬프는 모두 에포크 밀리초 `i64`인데,
//! `accounts`·`scheduler`·`chat`을 비롯한 십수 개 모듈이 같은 세 줄을 각자 적어 두었고
//! 그 사이에 미묘한 차이가 끼어 있었다. 넘침·에포크 이전을 만나면 어떤 사본은 0을,
//! 어떤 사본은 `as` 절단값을 돌려주고, 두 사본은 `chrono`로 우회한다. 값이 갈릴 일이
//! 실제로는 없는 차이지만 "지금이 무엇인가"를 모듈마다 다시 정하고 있다는 뜻이라
//! 여기 하나로 모았다.

use std::time::{SystemTime, UNIX_EPOCH};

/// 지금을 에포크 밀리초로 읽는다.
///
/// 시스템 시계가 에포크 이전이면 `0`, `i64`를 넘기면 `i64::MAX`로 붙잡는다. 절단해서
/// 시간이 거꾸로 가는 값을 내놓지 않으므로, 이 값을 정렬·비교에 쓰는 호출부가 시계
/// 이상을 만나도 순서가 뒤집히지 않는다.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
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
    fn now_ms_does_not_go_backwards() {
        let first = now_ms();
        let second = now_ms();
        assert!(second >= first, "{second} < {first}");
    }
}
