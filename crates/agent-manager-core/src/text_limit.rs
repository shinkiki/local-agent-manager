//! 문자열을 글자 수·바이트 수 상한까지 줄이는 공통 연산.
//!
//! `external_plugins`·`mcp_registry`·`cli_updates`·`translation`이 "앞에서 N글자만 남기고
//! 말줄임표를 붙인다"를 각자 적어 두었고, `session_context`·`session_management`는 같은
//! 골격에서 세는 단위와 잘림 표시 문구만 달랐다. 자르는 방법만 여기 모으고, 상한값과 표시
//! 문구는 그 의미를 아는 호출부가 계속 정한다.

/// 잘렸음을 알리는 기본 표시.
pub(crate) const ELLIPSIS: &str = "…";

/// 경계를 찾을 때 상한의 몇 %보다 뒤만 인정할지. 앞쪽 경계까지 허용하면 한 문장짜리
/// 답변이 몇 글자만 남는다.
const BOUNDARY_MIN_RATIO_PERCENT: usize = 60;

/// 앞에서부터 `max_chars` 글자만 남긴다. 실제로 잘렸을 때만 `marker`를 덧붙인다.
///
/// 상한 이하이면 원문을 그대로 돌려주므로, 표시가 붙었다는 것은 곧 뒤가 잘렸다는 뜻이다.
pub(crate) fn truncate_chars_with(value: &str, max_chars: usize, marker: &str) -> String {
    let Some((byte_idx, _)) = value.char_indices().nth(max_chars) else {
        return value.to_owned();
    };
    format!("{}{marker}", &value[..byte_idx])
}

/// `truncate_chars_with`에 기본 말줄임표를 쓴 것.
pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    truncate_chars_with(value, max_chars, ELLIPSIS)
}

/// 낱말·문장을 끊지 않는 자리까지만 남긴다. 상한 이하이면 원문을 그대로 돌려준다.
///
/// 상한에서 그냥 자르면 미리보기가 글자 중간에서 끊겨, 읽는 사람에게는 "덜 보여 준
/// 발췌"가 아니라 "깨진 문장"으로 보인다. 그래서 상한 안쪽에서 마지막 문장 끝을 먼저
/// 찾고, 없으면 마지막 공백에서 끊는다. 너무 앞에서 끊어 내용이 사라지지 않도록 상한의
/// `BOUNDARY_MIN_RATIO_PERCENT`% 뒤에서만 경계를 찾고, 그 안에 경계가 없으면 상한에서
/// 그대로 자른다.
pub(crate) fn truncate_chars_at_boundary(value: &str, max_chars: usize) -> String {
    let chars = value.chars().take(max_chars + 1).collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_owned();
    }
    let floor = max_chars * BOUNDARY_MIN_RATIO_PERCENT / 100;
    let window = floor..max_chars;
    let cut = window
        .clone()
        .rev()
        .find(|index| is_sentence_break(&chars, *index))
        .map(|index| index + 1)
        .or_else(|| window.rev().find(|index| chars[*index].is_whitespace()))
        .unwrap_or(max_chars);
    let kept = chars[..cut].iter().collect::<String>();
    format!("{}{ELLIPSIS}", kept.trim_end())
}

/// 문장을 닫는 부호이고 그 뒤가 공백(또는 글자 끝)인 자리인지. 뒤를 함께 보지 않으면
/// `1.5`의 소수점이나 파일명의 마침표에서 끊긴다.
fn is_sentence_break(chars: &[char], index: usize) -> bool {
    matches!(chars[index], '.' | '!' | '?' | '。' | '！' | '？' | '…')
        && chars.get(index + 1).is_none_or(|next| next.is_whitespace())
}

/// 바이트 상한으로 줄인다. `marker`까지 포함해 `max_bytes`를 넘지 않는다.
///
/// 저장 크기가 상한인 곳(전사 블록 등)은 글자 수로는 한도를 지킬 수 없어 바이트로 센다.
/// UTF-8 경계 앞으로 물러나 자르므로 잘린 자리에 깨진 글자가 남지 않는다.
pub(crate) fn truncate_bytes_with(value: &str, max_bytes: usize, marker: &str) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    if max_bytes < marker.len() {
        let end = value.floor_char_boundary(max_bytes);
        return value[..end].to_owned();
    }
    let end = value.floor_char_boundary(max_bytes - marker.len());
    format!("{}{marker}", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_value_within_char_limit() {
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(truncate_chars("짧음", 100), "짧음");
    }

    #[test]
    fn marks_truncated_char_limit() {
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        assert_eq!(truncate_chars_with("가나다라", 2, "…(잘림)"), "가나…(잘림)");
        assert_eq!(truncate_chars("", 0), "");
        assert_eq!(truncate_chars("abc", 0), "…");
    }

    #[test]
    fn counts_characters_not_bytes() {
        assert_eq!(truncate_chars("가나다", 3), "가나다");
    }

    #[test]
    fn boundary_truncation_ends_on_a_sentence_or_word() {
        let sentences = "첫 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다.";
        assert_eq!(
            truncate_chars_at_boundary(sentences, 30),
            "첫 문장입니다. 두 번째 문장입니다.…"
        );
        assert_eq!(
            truncate_chars_at_boundary("실행 중인 세션은 두 개이고 대기 중인 작업은 없습니다", 20),
            "실행 중인 세션은 두 개이고 대기…"
        );
        // 경계가 상한의 60% 앞에만 있으면 내용이 너무 줄어드니 상한에서 자른다.
        assert_eq!(
            truncate_chars_at_boundary("짧다. 가나다라마바사아자차카타파하", 12),
            "짧다. 가나다라마바사아…"
        );
        // 소수점은 뒤가 숫자라 문장 끝이 아니다. 경계가 없으면 상한에서 자른다.
        assert_eq!(
            truncate_chars_at_boundary("버전 1.5678901234567890", 12),
            "버전 1.5678901…"
        );
    }

    #[test]
    fn boundary_truncation_keeps_short_text_and_hard_cuts_unbroken_text() {
        assert_eq!(truncate_chars_at_boundary("짧음", 100), "짧음");
        let unbroken = "가".repeat(20);
        assert_eq!(
            truncate_chars_at_boundary(&unbroken, 10),
            format!("{}…", "가".repeat(10))
        );
        let large = "가".repeat(10_000);
        assert_eq!(
            truncate_chars_at_boundary(&large, 10),
            format!("{}…", "가".repeat(10))
        );
    }

    #[test]
    fn truncate_bytes_stays_within_limit_on_char_boundary() {
        let marker = "\n…[truncated]";
        let value = "가".repeat(20);
        let cut = truncate_bytes_with(&value, 20, marker);
        assert!(cut.len() <= 20);
        assert!(cut.ends_with(marker));
        assert_eq!(truncate_bytes_with("abc", 20, marker), "abc");
    }

    #[test]
    fn truncate_bytes_drops_marker_if_limit_is_too_small() {
        let marker = "\n…[truncated]";
        assert_eq!(truncate_bytes_with("abcdef", 1, marker), "a");
        assert_eq!(truncate_bytes_with("가나다라", 1, marker), "");
    }
}
