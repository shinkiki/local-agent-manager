//! ASCII 식별자 문자 집합 판정.
//!
//! `store`·`catalog`·`terminal`·`chat`·`system_workflows`·`project_instructions`가
//! "영숫자·`-`·`_`만 쓴 값인가"를 각자 적어 두었고, 같은 조건을 바이트로 세는 판과
//! 문자로 세는 판, `matches!`로 적은 판과 `==`로 적은 판이 섞여 있었다. `store`와
//! `catalog`에는 길이 범위까지 같은 함수가 통째로 두 벌 있었다.
//!
//! 문자 집합 판정만 여기 모은다. 길이 상한과 거절 문구는 그 값이 무엇인지 아는 호출부가
//! 계속 정하고, 시작 문자·예약 이름·경로 탈출 같은 그 자리에서만 뜻이 있는 규칙도
//! 호출부에 남긴다.

use crate::CoreError;

/// 저장본 식별자(세션·채팅·턴·계정 id)에 허용하는 길이. UUID(36자)와 공급자 id를
/// 함께 담으면서 경로 구성요소로 써도 되는 범위다.
const STORED_ID_LENGTHS: std::ops::RangeInclusive<usize> = 16..=128;

/// 영숫자·`-`·`_`만으로 이루어졌는지. 빈 값도 참이므로 길이는 호출부가 함께 본다.
pub(crate) fn is_slug_body(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// 길이가 `1..=max_len`이고 영숫자·`-`·`_`만 쓴 값인지.
pub(crate) fn is_slug(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && is_slug_body(value)
}

/// 소문자·숫자·`-`·`_`만 쓰고 영숫자로 시작하는 `1..=max_len` 값인지.
///
/// MCP 서버 이름으로 그대로 나가는 id가 쓰는 좁은 집합이다. Claude의 `[a-zA-Z0-9_-]+`와
/// Codex의 TOML bare key가 겹치는 자리라 대문자를 뺀다.
pub(crate) fn is_lowercase_slug(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
}

/// 저장본 식별자 공용 검증. 경로 탈출과 셸 메타문자를 문자 집합 단계에서 함께 막는다.
pub(crate) fn validate_identifier(value: &str) -> Result<(), CoreError> {
    if STORED_ID_LENGTHS.contains(&value.len()) && is_slug_body(value) {
        Ok(())
    } else {
        Err(CoreError::InvalidInput("잘못된 식별자입니다".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_body_accepts_only_alphanumeric_dash_underscore() {
        assert!(is_slug_body("abc-DEF_012"));
        assert!(is_slug_body(""));
        assert!(!is_slug_body("a.b"));
        assert!(!is_slug_body("../escape"));
        assert!(!is_slug_body("한글"));
    }

    #[test]
    fn slug_enforces_length_bounds() {
        assert!(is_slug("a", 1));
        assert!(!is_slug("", 8));
        assert!(!is_slug("abcdefghi", 8));
    }

    #[test]
    fn lowercase_slug_rejects_uppercase_and_leading_symbol() {
        assert!(is_lowercase_slug("notion-bizple", 32));
        assert!(is_lowercase_slug("0abc", 32));
        assert!(!is_lowercase_slug("Notion", 32));
        assert!(!is_lowercase_slug("-lead", 32));
        assert!(!is_lowercase_slug("_lead", 32));
        assert!(!is_lowercase_slug("toolong", 3));
    }

    #[test]
    fn stored_identifier_matches_previous_range() {
        assert!(validate_identifier("019fb787-9c1e-7782-8128-2aecfba9af0c").is_ok());
        assert!(validate_identifier("0123456789abcdef").is_ok());
        assert!(validate_identifier("0123456789abcde").is_err());
        assert!(validate_identifier(&"a".repeat(129)).is_err());
        assert!(validate_identifier("../../../etc/passwd").is_err());
    }
}
