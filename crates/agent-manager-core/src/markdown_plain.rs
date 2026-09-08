//! 마크다운 본문을 미리보기용 순수 텍스트로 옮긴다.
//!
//! AIA 알림 말풍선은 마크다운을 그리지 않고 글자만 띄운다. 원문을 그대로 넣으면
//! `###`·`**`·`|`·백틱 표기가 그대로 보이고, 표기가 차지한 자리만큼 실제 내용이 상한
//! 밖으로 밀려 잘린다. 화면 파서(`MarkdownPreview`)를 Rust로 옮기지 않고 표기만 걷어
//! 내, 남은 글자 수가 곧 사람이 읽는 글자 수가 되게 한다.
//!
//! 미리보기 전용이라 구조는 버린다. 제목·목록·표는 본문만 남겨 줄로 이어 두고, 그
//! 줄들을 어떻게 합치고 어디서 끊을지는 글자 수 상한을 아는 호출부가 정한다.

/// 마크다운 표기를 걷어 낸 줄을 `\n`으로 이어 돌려준다. 빈 줄과 구분선은 버린다.
pub(crate) fn markdown_plain_text(source: &str) -> String {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = Vec::new();
    let mut fenced = false;
    for raw in normalized.split('\n') {
        let trimmed = raw.trim();
        if is_fence(trimmed) {
            fenced = !fenced;
            continue;
        }
        if fenced {
            // 코드 안에서는 표기를 걷지 않는다. 별표·백틱·부등호가 코드의 일부다.
            // 버리지 않고 남기는 이유는, 코드만으로 된 답변에서 미리보기가 통째로
            // 비어 말풍선이 사라지는 것을 막기 위해서다.
            if !trimmed.is_empty() {
                lines.push(trimmed.to_owned());
            }
            continue;
        }
        if trimmed.is_empty() || is_rule_line(trimmed) || is_table_separator(trimmed) {
            continue;
        }
        let text = strip_inline_markup(&strip_block_markers(trimmed));
        let text = text.trim();
        if !text.is_empty() {
            lines.push(text.to_owned());
        }
    }
    lines.join("\n")
}

/// 코드 펜스 경계. 여는 줄의 언어 표기까지 함께 버리므로 여닫이를 구분하지 않는다.
fn is_fence(line: &str) -> bool {
    line.starts_with("```") || line.starts_with("~~~")
}

/// 구분선(`---`)과 setext 제목 밑줄(`===`). 글자가 없으므로 미리보기에서 버린다.
fn is_rule_line(line: &str) -> bool {
    ['-', '*', '_', '='].into_iter().any(|marker| {
        line.chars().filter(|value| *value == marker).count() >= 3
            && line
                .chars()
                .all(|value| value == marker || value.is_whitespace())
    })
}

/// 표 정렬 줄(`|---|:--:|`). 셀에 글자가 없으므로 행으로 옮기지 않고 버린다.
fn is_table_separator(line: &str) -> bool {
    if !line.contains('|') {
        return false;
    }
    line.trim_matches('|').split('|').all(|cell| {
        let cell = cell.trim();
        let core = cell.trim_start_matches(':').trim_end_matches(':');
        core.chars().count() >= 3 && core.chars().all(|value| value == '-')
    })
}

/// 줄 앞의 블록 마커(인용·제목·목록·체크박스)를 벗기고, 표 행이면 셀만 남긴다.
fn strip_block_markers(line: &str) -> String {
    let mut text = line.trim().to_owned();
    // `> - 항목`처럼 겹친 마커는 한 번에 하나씩 벗긴다. 모든 갈래가 최소 한 글자를
    // 소비하므로, 더 벗길 것이 없으면 반드시 멈춘다.
    while let Some(rest) = strip_one_block_marker(&text) {
        text = rest.trim_start().to_owned();
    }
    table_row_cells(&text).unwrap_or(text)
}

fn strip_one_block_marker(text: &str) -> Option<String> {
    if let Some(rest) = text.strip_prefix('>') {
        return Some(rest.to_owned());
    }
    strip_heading(text)
        .or_else(|| strip_bullet(text))
        .or_else(|| strip_ordered(text))
        .or_else(|| strip_task(text))
}

fn strip_heading(text: &str) -> Option<String> {
    let hashes = text.chars().take_while(|value| *value == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &text[hashes..];
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    // 닫는 `###`까지 적은 제목은 뒤쪽 표기도 함께 걷는다.
    Some(rest.trim().trim_end_matches('#').trim_end().to_owned())
}

fn strip_bullet(text: &str) -> Option<String> {
    let mut chars = text.chars();
    if !matches!(chars.next()?, '-' | '*' | '+') {
        return None;
    }
    // 마커 뒤 공백을 요구해야 `**강조**`로 시작하는 줄을 목록으로 보지 않는다.
    marker_body(chars.as_str())
}

fn strip_ordered(text: &str) -> Option<String> {
    let digits = text
        .chars()
        .take_while(|value| value.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    let mut chars = text[digits..].chars();
    if !matches!(chars.next()?, '.' | ')') {
        return None;
    }
    marker_body(chars.as_str())
}

fn strip_task(text: &str) -> Option<String> {
    let rest = ["[ ]", "[x]", "[X]"]
        .into_iter()
        .find_map(|marker| text.strip_prefix(marker))?;
    marker_body(rest)
}

/// 마커 뒤가 공백이거나 줄 끝일 때만 본문으로 인정한다.
fn marker_body(rest: &str) -> Option<String> {
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim_start().to_owned())
}

/// 표 행의 셀만 공백으로 이어 붙인다. 파이프로 시작하는 줄만 행으로 본다.
fn table_row_cells(text: &str) -> Option<String> {
    if !text.starts_with('|') {
        return None;
    }
    let cells = text
        .trim_matches('|')
        .split('|')
        .map(str::trim)
        .filter(|cell| !cell.is_empty())
        .collect::<Vec<_>>();
    Some(cells.join(" "))
}

/// 인라인 표기를 걷어 낸다. 스트리밍 중 잘려 닫히지 않은 표기도 글자는 남긴다.
fn strip_inline_markup(text: &str) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        match current {
            // 이스케이프는 가려진 글자만 남긴다. 백슬래시가 화면에 찍히면 안 된다.
            '\\' if chars.get(index + 1).is_some_and(char::is_ascii_punctuation) => {
                out.push(chars[index + 1]);
                index += 2;
            }
            '`' => {
                let run = marker_run(&chars, index, '`');
                match find_marker_run(&chars, index + run, '`', run) {
                    Some(close) => {
                        out.extend(chars[index + run..close].iter());
                        index = close + run;
                    }
                    None => index += run,
                }
            }
            '*' | '~' => index += marker_run(&chars, index, current),
            '_' => {
                let run = marker_run(&chars, index, '_');
                // `_`는 식별자에 흔해 한 개는 글자로 남기고, 두 개 이상만 표기로 본다.
                if run >= 2 {
                    index += run;
                } else {
                    out.push('_');
                    index += 1;
                }
            }
            // 이미지는 대체 텍스트만, 링크는 라벨만 남기고 주소는 버린다.
            '!' if chars.get(index + 1) == Some(&'[') => match inline_link(&chars, index + 1) {
                Some((label, next)) => {
                    out.push_str(&strip_inline_markup(&label));
                    index = next;
                }
                None => {
                    out.push('!');
                    index += 1;
                }
            },
            '[' => match inline_link(&chars, index) {
                Some((label, next)) => {
                    out.push_str(&strip_inline_markup(&label));
                    index = next;
                }
                None => {
                    out.push('[');
                    index += 1;
                }
            },
            '<' => match angle_span(&chars, index) {
                Some((kept, next)) => {
                    out.push_str(&kept);
                    index = next;
                }
                None => {
                    out.push('<');
                    index += 1;
                }
            },
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    out
}

fn marker_run(chars: &[char], index: usize, marker: char) -> usize {
    chars[index..]
        .iter()
        .take_while(|value| **value == marker)
        .count()
}

/// `from` 이후에서 길이가 정확히 `len`인 마커 뭉치의 시작 위치.
fn find_marker_run(chars: &[char], from: usize, marker: char, len: usize) -> Option<usize> {
    let mut index = from;
    while index < chars.len() {
        if chars[index] != marker {
            index += 1;
            continue;
        }
        let run = marker_run(chars, index, marker);
        if run == len {
            return Some(index);
        }
        index += run;
    }
    None
}

/// `[라벨](주소)`의 라벨과 그 표기가 끝나는 자리. 라벨에는 `[`가 없으므로 중첩되지 않는다.
fn inline_link(chars: &[char], open: usize) -> Option<(String, usize)> {
    let close = (open + 1..chars.len()).find(|index| chars[*index] == ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = (close + 2..chars.len()).find(|index| chars[*index] == ')')?;
    Some((chars[open + 1..close].iter().collect(), end + 1))
}

/// 자동 링크는 주소를 글자로 남기고 HTML 태그는 통째로 버린다. 둘 다 아니면 None을
/// 돌려 `a < b`의 부등호가 글자로 남게 한다.
fn angle_span(chars: &[char], open: usize) -> Option<(String, usize)> {
    let close = (open + 1..chars.len()).find(|index| chars[*index] == '>')?;
    let inner = chars[open + 1..close].iter().collect::<String>();
    if is_autolink(&inner) {
        return Some((inner, close + 1));
    }
    is_html_tag(&inner).then(|| (String::new(), close + 1))
}

fn is_autolink(inner: &str) -> bool {
    ["http://", "https://", "mailto:", "ftp://"]
        .into_iter()
        .any(|scheme| inner.starts_with(scheme))
}

fn is_html_tag(inner: &str) -> bool {
    let name = inner.strip_prefix('/').unwrap_or(inner);
    name.starts_with(|value: char| value.is_ascii_alphabetic())
        && name
            .chars()
            .take_while(|value| !value.is_whitespace())
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_block_markers_and_keeps_body() {
        assert_eq!(
            markdown_plain_text("## 실행 중인 세션\n\n- 첫 번째\n- 두 번째\n"),
            "실행 중인 세션\n첫 번째\n두 번째"
        );
        assert_eq!(
            markdown_plain_text("1. 하나\n2) 둘\n> 인용\n> - 인용 목록\n"),
            "하나\n둘\n인용\n인용 목록"
        );
        assert_eq!(
            markdown_plain_text("- [x] 끝난 일\n- [ ] 남은 일"),
            "끝난 일\n남은 일"
        );
    }

    #[test]
    fn drops_rules_separators_and_fences_but_keeps_code_text() {
        assert_eq!(
            markdown_plain_text("제목\n===\n\n---\n\n```js\nconst a = 1;\n```\n"),
            "제목\nconst a = 1;"
        );
        assert_eq!(
            markdown_plain_text("| 세션 | 상태 |\n| --- | :---: |\n| aia | 실행 |"),
            "세션 상태\naia 실행"
        );
    }

    #[test]
    fn strips_inline_markup_including_unclosed_tokens() {
        assert_eq!(
            markdown_plain_text("**중요**한 `코드`와 [문서](https://example.com)를 봤다."),
            "중요한 코드와 문서를 봤다."
        );
        assert_eq!(
            markdown_plain_text("~~취소~~ *기울임* __강조__"),
            "취소 기울임 강조"
        );
        // 스트리밍 중 잘린 표기: 닫는 백틱이 없어도 글자는 남는다.
        assert_eq!(markdown_plain_text("남은 `코드가 잘림"), "남은 코드가 잘림");
        assert_eq!(markdown_plain_text("![그림](a.png) 뒤"), "그림 뒤");
    }

    #[test]
    fn keeps_characters_that_only_look_like_markup() {
        assert_eq!(
            markdown_plain_text("snake_case 값과 a < b 비교"),
            "snake_case 값과 a < b 비교"
        );
        assert_eq!(markdown_plain_text("<br>줄바꿈<b>태그</b>"), "줄바꿈태그");
        assert_eq!(
            markdown_plain_text("<https://example.com> 확인"),
            "https://example.com 확인"
        );
        assert_eq!(markdown_plain_text("\\*별표\\*는 글자"), "*별표*는 글자");
        assert_eq!(markdown_plain_text("버전 1.5 확인"), "버전 1.5 확인");
        assert_eq!(markdown_plain_text("완료 [링크 아님"), "완료 [링크 아님");
    }
}
