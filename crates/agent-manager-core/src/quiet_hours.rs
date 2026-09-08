//! 페이싱 스케줄(제한 시간대) 계산. 예산 정책의 [`QuietHours`]를 파싱해 어떤 순간이 제한 중인지,
//! 제한이 언제 풀리는지, 두 순간 사이에 페이싱이 돌 수 있는 **열린 시간**이 얼마인지를 답한다.
//! 요일·자정 넘김·DST는 이 모듈 밖으로 새지 않는다 — 스케줄러와 계획 단계는 `blocked_at`·
//! `resume_at`·`open_ms_between` 세 답만 쓴다.
//!
//! 제한 구간은 체크한 요일마다 하나씩, 그 날짜의 `start`에서 시작해 `end`에서 끝난다. `end`가
//! `start`보다 이르거나 같으면 다음 날로 이어지고(자정 넘김), 구간은 **시작 요일**에 속한다 —
//! 금요일만 체크하고 22:00→06:00이면 금 22:00~토 06:00만 제한이고 토 22:00~일 06:00은 열려 있다.

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;

use crate::usage_budget_policy::QuietHours;
use crate::CoreError;

/// 열린 시간 계산이 훑을 최대 일수. 창 라벨은 최대 `주` 단위라 실제로는 수십 일이면 충분하고,
/// 그보다 긴 구간의 나머지는 열린 것으로 본다.
const MAX_SCAN_DAYS: usize = 400;
/// 다음 제한 시작을 찾을 때 보는 일수. 요일이 하나만 켜져 있어도 8일 안에는 반드시 있다.
const NEXT_BLOCK_SCAN_DAYS: i64 = 8;
/// 월~일 표시 순서에 맞춘 요일 정본 표: `(저장 번호 0=일…6=토, 한글 이름)`.
const DISPLAY_WEEKDAYS: [(usize, &str); 7] = [
    (1, "월"),
    (2, "화"),
    (3, "수"),
    (4, "목"),
    (5, "금"),
    (6, "토"),
    (0, "일"),
];

/// 파싱이 끝난 제한 스케줄. 분 단위 시각 + 시간대 + 요일 마스크(0=일 … 6=토).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QuietSchedule {
    start_minute: u16,
    end_minute: u16,
    zone: Tz,
    weekdays: [bool; 7],
}

impl QuietSchedule {
    /// 정책 값을 검증하고 파싱한다. 형식·시간대·요일 번호는 스위치와 무관하게 검증하고(잘못된
    /// 값을 저장하지 않게), 꺼져 있으면 `Ok(None)` — 켜져 있을 때만 "시작≠끝"과 "요일 1개 이상"을
    /// 요구한다.
    pub(crate) fn parse(hours: &QuietHours) -> Result<Option<Self>, CoreError> {
        let start_minute = parse_clock(&hours.start)?;
        let end_minute = parse_clock(&hours.end)?;
        let zone: Tz = hours.timezone.trim().parse().map_err(|_| {
            CoreError::InvalidInput(
                "제한 시간대의 시간대(timezone)를 확인할 수 없습니다".to_owned(),
            )
        })?;
        let mut weekdays = [false; 7];
        for day in &hours.weekdays {
            let slot = weekdays.get_mut(usize::from(*day)).ok_or_else(|| {
                CoreError::InvalidInput("요일은 0(일)~6(토) 사이여야 합니다".to_owned())
            })?;
            *slot = true;
        }
        if !hours.enabled {
            return Ok(None);
        }
        if start_minute == end_minute {
            return Err(CoreError::InvalidInput(
                "제한 시간대의 시작과 끝이 같으면 시간대가 없습니다(종일 돌리려면 스위치를 끄세요)"
                    .to_owned(),
            ));
        }
        if !weekdays.iter().any(|checked| *checked) {
            return Err(CoreError::InvalidInput(
                "제한을 적용할 요일을 하나 이상 고르세요".to_owned(),
            ));
        }
        Ok(Some(Self {
            start_minute,
            end_minute,
            zone,
            weekdays,
        }))
    }

    fn wraps(&self) -> bool {
        self.end_minute <= self.start_minute
    }

    fn local_date(&self, at_ms: i64) -> NaiveDate {
        DateTime::<Utc>::from_timestamp_millis(at_ms)
            .unwrap_or_default()
            .with_timezone(&self.zone)
            .date_naive()
    }

    /// 지역 날짜의 벽시계 시각을 순간(ms)으로. DST로 사라진 시각(봄 점프)은 한 시간 뒤로 민다.
    fn instant(&self, day: NaiveDate, minute: u16) -> Option<i64> {
        let (hour, min) = clock_parts(minute);
        let naive = day.and_hms_opt(u32::from(hour), u32::from(min), 0)?;
        self.zone
            .from_local_datetime(&naive)
            .earliest()
            .or_else(|| {
                self.zone
                    .from_local_datetime(&(naive + Duration::hours(1)))
                    .earliest()
            })
            .map(|resolved| resolved.timestamp_millis())
    }

    /// 지역 날짜 `day`에서 시작하는 제한 구간 `[start, end)`. 그 요일이 꺼져 있으면 None.
    /// 자정을 넘기면 끝은 다음 날이다(구간은 시작 요일에 속한다).
    fn segment(&self, day: NaiveDate) -> Option<(i64, i64)> {
        if !self.weekdays[day.weekday().num_days_from_sunday() as usize] {
            return None;
        }
        let start = self.instant(day, self.start_minute)?;
        let end_day = if self.wraps() { day.succ_opt()? } else { day };
        let end = self.instant(end_day, self.end_minute)?;
        (end > start).then_some((start, end))
    }

    /// `at`을 덮을 수 있는 구간은 전날 시작(자정 넘김)과 당일 시작 둘뿐이다.
    fn segment_covering(&self, at_ms: i64) -> Option<(i64, i64)> {
        let day = self.local_date(at_ms);
        [day.pred_opt(), Some(day)]
            .into_iter()
            .flatten()
            .filter_map(|day| self.segment(day))
            .find(|(start, end)| *start <= at_ms && at_ms < *end)
    }

    /// `at`이 제한 구간 안인지.
    pub(crate) fn blocked_at(&self, at_ms: i64) -> bool {
        self.segment_covering(at_ms).is_some()
    }

    /// `at`이 열려 있으면 `at`, 제한 중이면 그 구간이 끝나는 재개 시각. DST로 하루가 짧아져
    /// 구간이 다음 날 구간에 닿는 드문 경우를 위해 몇 번 이어 본다.
    pub(crate) fn resume_at(&self, at_ms: i64) -> i64 {
        let mut at = at_ms;
        for _ in 0..3 {
            if let Some((_, end)) = self.segment_covering(at) {
                at = end;
            } else {
                break;
            }
        }
        at
    }

    /// `at` 이후 처음 시작하는 제한 구간의 시작. 화면의 "HH:MM에 멈춤" 표시용.
    pub(crate) fn next_block_start_after(&self, at_ms: i64) -> Option<i64> {
        let day = self.local_date(at_ms);
        (0..NEXT_BLOCK_SCAN_DAYS)
            .filter_map(|offset| day.checked_add_signed(Duration::days(offset)))
            .filter_map(|day| self.segment(day))
            .map(|(start, _)| start)
            .find(|start| *start > at_ms)
    }

    /// `[from, to]` 중 제한에 걸리지 않는 열린 시간(ms). `from >= to`면 0.
    pub(crate) fn open_ms_between(&self, from_ms: i64, to_ms: i64) -> i64 {
        if from_ms >= to_ms {
            return 0;
        }
        let last = self.local_date(to_ms);
        // 전날 시작해 자정을 넘긴 구간이 `from`을 덮을 수 있어 하루 앞에서 시작한다.
        let mut day = self.local_date(from_ms).pred_opt();
        let mut blocked = 0i64;
        let mut scanned = 0usize;
        while let Some(current) = day {
            if current > last || scanned >= MAX_SCAN_DAYS {
                break;
            }
            if let Some((start, end)) = self.segment(current) {
                blocked += overlap_ms(start, end, from_ms, to_ms);
            }
            day = current.succ_opt();
            scanned += 1;
        }
        (to_ms - from_ms - blocked).max(0)
    }

    /// 사람이 읽는 한 줄 요약(계획 reasoning·AIA용). 예: `월~금 09:00~18:00 제한(Asia/Seoul)`.
    pub(crate) fn describe(&self) -> String {
        format!(
            "{} {} 제한({})",
            describe_weekdays(&self.weekdays),
            self.describe_range(),
            self.zone.name()
        )
    }

    fn describe_range(&self) -> String {
        format!(
            "{}~{}",
            format_clock(self.start_minute),
            format_clock(self.end_minute)
        )
    }
}

/// `HH:MM`을 하루 안의 분으로.
fn parse_clock(value: &str) -> Result<u16, CoreError> {
    let invalid = || CoreError::InvalidInput("제한 시간대는 HH:MM 형식이어야 합니다".to_owned());
    let (hours, minutes) = value.trim().split_once(':').ok_or_else(invalid)?;
    let hours: u16 = hours.parse().map_err(|_| invalid())?;
    let minutes: u16 = minutes.parse().map_err(|_| invalid())?;
    if hours > 23 || minutes > 59 {
        return Err(invalid());
    }
    Ok(hours * 60 + minutes)
}

/// 요일 마스크를 월~일 순서로 요약한다. 전부면 "매일", 연속 구간이면 "월~금", 그 밖은 "월·수·금".
fn describe_weekdays(weekdays: &[bool; 7]) -> String {
    let checked: Vec<(usize, &str)> = DISPLAY_WEEKDAYS
        .into_iter()
        .enumerate()
        .filter(|(_, (day, _))| weekdays[*day])
        .map(|(order_idx, (_, name))| (order_idx, name))
        .collect();
    if checked.len() == DISPLAY_WEEKDAYS.len() {
        return "매일".to_owned();
    }
    let contiguous =
        checked.len() >= 3 && checked.windows(2).all(|pair| pair[1].0 == pair[0].0 + 1);
    if contiguous {
        let first_name = checked[0].1;
        let last_name = checked.last().unwrap().1;
        return format!("{first_name}~{last_name}");
    }
    checked
        .iter()
        .map(|(_, name)| *name)
        .collect::<Vec<_>>()
        .join("·")
}

/// 하루 안의 분을 `(시, 분)`으로 나눈다.
fn clock_parts(minute: u16) -> (u16, u16) {
    (minute / 60, minute % 60)
}

/// 하루 안의 분을 `HH:MM` 형식 문자열로.
fn format_clock(minute: u16) -> String {
    let (hours, minutes) = clock_parts(minute);
    format!("{hours:02}:{minutes:02}")
}

/// 두 반열린 구간 `[a_start, a_end)`와 `[b_start, b_end)`가 겹치는 시간(ms).
fn overlap_ms(a_start: i64, a_end: i64, b_start: i64, b_end: i64) -> i64 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const SEOUL: &str = "Asia/Seoul";
    const HOUR: i64 = 3_600_000;

    fn hours(start: &str, end: &str, weekdays: &[u8]) -> QuietHours {
        QuietHours {
            enabled: true,
            start: start.to_owned(),
            end: end.to_owned(),
            timezone: SEOUL.to_owned(),
            weekdays: weekdays.iter().copied().collect::<BTreeSet<u8>>(),
        }
    }

    fn schedule(start: &str, end: &str, weekdays: &[u8]) -> QuietSchedule {
        QuietSchedule::parse(&hours(start, end, weekdays))
            .expect("parse")
            .expect("enabled")
    }

    /// 지역 벽시계 → ms. 2026-09-03은 목요일이다.
    fn at(zone: &str, day: u32, hour: u32, minute: u32) -> i64 {
        let zone: Tz = zone.parse().expect("zone");
        zone.with_ymd_and_hms(2026, 9, day, hour, minute, 0)
            .single()
            .expect("local time")
            .timestamp_millis()
    }

    const EVERY_DAY: [u8; 7] = [0, 1, 2, 3, 4, 5, 6];
    const WEEKDAYS: [u8; 5] = [1, 2, 3, 4, 5];

    #[test]
    fn daytime_block_stops_only_its_hours() {
        let quiet = schedule("09:00", "18:00", &EVERY_DAY);
        assert!(quiet.blocked_at(at(SEOUL, 3, 12, 0)));
        assert!(quiet.blocked_at(at(SEOUL, 3, 9, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 3, 18, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 3, 20, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 3, 3, 0)));
    }

    #[test]
    fn weekday_only_block_leaves_weekends_open() {
        let quiet = schedule("09:00", "18:00", &WEEKDAYS);
        // 9/4 금, 9/5 토, 9/6 일, 9/7 월
        assert!(quiet.blocked_at(at(SEOUL, 4, 12, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 5, 12, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 6, 12, 0)));
        assert!(quiet.blocked_at(at(SEOUL, 7, 12, 0)));
    }

    #[test]
    fn overnight_block_belongs_to_its_start_weekday() {
        // 금요일(5)만 체크, 22:00 → 06:00.
        let quiet = schedule("22:00", "06:00", &[5]);
        assert!(quiet.blocked_at(at(SEOUL, 4, 23, 0)));
        assert!(quiet.blocked_at(at(SEOUL, 5, 3, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 5, 6, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 5, 23, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 6, 3, 0)));
        assert!(!quiet.blocked_at(at(SEOUL, 4, 12, 0)));
    }

    #[test]
    fn resume_at_returns_now_when_open_and_block_end_when_blocked() {
        let quiet = schedule("09:00", "18:00", &WEEKDAYS);
        let open = at(SEOUL, 3, 20, 0);
        assert_eq!(quiet.resume_at(open), open);
        assert_eq!(quiet.resume_at(at(SEOUL, 3, 14, 0)), at(SEOUL, 3, 18, 0));
        // 자정 넘김 구간의 재개는 다음 날 아침이다.
        let night = schedule("22:00", "06:00", &EVERY_DAY);
        assert_eq!(night.resume_at(at(SEOUL, 4, 2, 0)), at(SEOUL, 4, 6, 0));
    }

    #[test]
    fn next_block_start_after_finds_the_next_checked_day() {
        let quiet = schedule("09:00", "18:00", &WEEKDAYS);
        // 토요일 정오 → 다음 제한은 월요일 09:00.
        assert_eq!(
            quiet.next_block_start_after(at(SEOUL, 5, 12, 0)),
            Some(at(SEOUL, 7, 9, 0))
        );
        // 제한 중이면 다음 날의 시작을 준다.
        assert_eq!(
            quiet.next_block_start_after(at(SEOUL, 3, 12, 0)),
            Some(at(SEOUL, 4, 9, 0))
        );
    }

    #[test]
    fn open_ms_between_subtracts_only_blocked_minutes_across_days() {
        // 9/6(일) 00:00 ~ 9/13(일) 00:00, 평일 09~18 제한 → 168h − 45h.
        let quiet = schedule("09:00", "18:00", &WEEKDAYS);
        let from = at(SEOUL, 6, 0, 0);
        let to = at(SEOUL, 13, 0, 0);
        assert_eq!(quiet.open_ms_between(from, to), (168 - 45) * HOUR);
        // 매일이면 168h − 63h.
        let daily = schedule("09:00", "18:00", &EVERY_DAY);
        assert_eq!(daily.open_ms_between(from, to), (168 - 63) * HOUR);
        // 구간 경계가 제한 안에 있으면 걸친 만큼만 뺀다: 목 12:00 ~ 목 20:00 → 8h − 6h.
        assert_eq!(
            quiet.open_ms_between(at(SEOUL, 3, 12, 0), at(SEOUL, 3, 20, 0)),
            2 * HOUR
        );
        // 전날 시작한 자정 넘김 구간도 잡는다: 22:00→06:00 매일, 금 03:00 ~ 금 12:00 → 9h − 3h.
        let night = schedule("22:00", "06:00", &EVERY_DAY);
        assert_eq!(
            night.open_ms_between(at(SEOUL, 4, 3, 0), at(SEOUL, 4, 12, 0)),
            6 * HOUR
        );
    }

    #[test]
    fn open_ms_between_is_zero_for_inverted_range() {
        let quiet = schedule("09:00", "18:00", &EVERY_DAY);
        assert_eq!(
            quiet.open_ms_between(at(SEOUL, 4, 0, 0), at(SEOUL, 3, 0, 0)),
            0
        );
        assert_eq!(
            quiet.open_ms_between(at(SEOUL, 3, 0, 0), at(SEOUL, 3, 0, 0)),
            0
        );
    }

    #[test]
    fn dst_spring_forward_does_not_panic_or_double_count() {
        // 2026-03-08 02:00 뉴욕은 03:00으로 점프한다. 02:30~03:30 제한은 그날 사라진다.
        let zone = "America/New_York";
        let mut hours = hours("02:30", "03:30", &EVERY_DAY);
        hours.timezone = zone.to_owned();
        let quiet = QuietSchedule::parse(&hours)
            .expect("parse")
            .expect("enabled");
        let tz: Tz = zone.parse().unwrap();
        let day_start = tz
            .with_ymd_and_hms(2026, 3, 8, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let next_day = tz
            .with_ymd_and_hms(2026, 3, 9, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        // 23시간짜리 날. 제한 구간이 사라졌으니 열린 시간은 벽시계 길이 그대로다.
        assert_eq!(
            quiet.open_ms_between(day_start, next_day),
            next_day - day_start
        );
        // 평범한 날은 한 시간을 뺀다.
        let after = tz
            .with_ymd_and_hms(2026, 3, 10, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            quiet.open_ms_between(next_day, after),
            after - next_day - HOUR
        );
    }

    #[test]
    fn disabled_or_equal_bounds_or_no_weekday_mean_no_schedule() {
        let mut off = hours("09:00", "18:00", &WEEKDAYS);
        off.enabled = false;
        assert_eq!(QuietSchedule::parse(&off).expect("parse"), None);
        // 꺼져 있어도 형식은 검증한다.
        off.start = "9시".to_owned();
        assert!(matches!(
            QuietSchedule::parse(&off),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            QuietSchedule::parse(&hours("09:00", "09:00", &WEEKDAYS)),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            QuietSchedule::parse(&hours("09:00", "18:00", &[])),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            QuietSchedule::parse(&hours("09:00", "18:00", &[7])),
            Err(CoreError::InvalidInput(_))
        ));
        let mut bad_zone = hours("09:00", "18:00", &WEEKDAYS);
        bad_zone.timezone = "Mars/Olympus".to_owned();
        assert!(matches!(
            QuietSchedule::parse(&bad_zone),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            QuietSchedule::parse(&hours("24:00", "18:00", &WEEKDAYS)),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn describe_summarizes_weekdays_and_range() {
        assert_eq!(
            schedule("09:00", "18:00", &WEEKDAYS).describe(),
            "월~금 09:00~18:00 제한(Asia/Seoul)"
        );
        assert_eq!(
            schedule("22:00", "06:00", &EVERY_DAY).describe(),
            "매일 22:00~06:00 제한(Asia/Seoul)"
        );
        assert_eq!(
            schedule("09:00", "18:00", &[1, 3, 5]).describe(),
            "월·수·금 09:00~18:00 제한(Asia/Seoul)"
        );
        // 일요일은 표시 순서의 끝이라 토·일이 연속이다.
        assert_eq!(
            schedule("09:00", "18:00", &[5, 6, 0]).describe(),
            "금~일 09:00~18:00 제한(Asia/Seoul)"
        );
    }

    #[test]
    fn display_weekdays_covers_all_seven_days_uniquely() {
        let mut days = DISPLAY_WEEKDAYS
            .iter()
            .map(|(day, _)| *day)
            .collect::<Vec<_>>();
        days.sort_unstable();
        assert_eq!(days, (0..7).collect::<Vec<_>>());
    }

    #[test]
    fn clock_formatting_and_parsing_are_symmetric() {
        for time_str in ["00:00", "09:30", "18:05", "23:59"] {
            let minute = parse_clock(time_str).expect("parse");
            assert_eq!(format_clock(minute), time_str);
        }
    }
}
