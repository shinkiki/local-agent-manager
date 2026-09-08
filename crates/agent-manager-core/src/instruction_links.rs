//! 지침 문서가 참조하는 로컬 문서 링크를 모은다.
//!
//! 화면이 연결 문서 트리를 그리는 규칙(`src/lib/markdownLinks.ts`)과 보관·게시가
//! 함께 다룰 문서를 고르는 규칙이 어긋나면, 사람이 트리에서 본 문서가 보관에서
//! 빠지거나 그 반대가 된다. 그래서 같은 규칙을 여기 한 번 더 구현하고, 사례는
//! `src/lib/markdownLinkCases.json`을 양쪽 테스트가 함께 읽어 검증한다.

use std::collections::BTreeSet;

/// 문서가 참조하는 로컬 파일 링크를 나온 순서대로 모은다. 가져오기 표기(`@경로`)를
/// 먼저 마크다운 링크로 바꾸므로 화면에 링크로 그려지는 것과 목록이 어긋나지 않는다.
pub(crate) fn local_document_links(source: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut seen = BTreeSet::new();
    let mut fenced = false;
    for line in linkify_imports(source).split('\n') {
        if is_fence_line(line) {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for (index, segment) in line.split('`').enumerate() {
            if index % 2 == 1 {
                continue;
            }
            collect_markdown_links(segment, &mut links, &mut seen);
        }
    }
    links
}

/// `@context/agent/rules.md`처럼 지침이 다른 문서를 가져오는 표기를 마크다운 링크로
/// 바꾼다. 경로처럼 보이는 토큰(슬래시가 있거나 확장자로 끝남)만 바꾸고, 코드 블록과
/// 인라인 코드는 원문 그대로 남긴다. 앞이 공백이어야 하므로 이메일은 걸리지 않는다.
fn linkify_imports(source: &str) -> String {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut fenced = false;
    let mut lines = Vec::new();
    for line in normalized.split('\n') {
        if is_fence_line(line) {
            fenced = !fenced;
            lines.push(line.to_owned());
            continue;
        }
        if fenced || !line.contains('@') {
            lines.push(line.to_owned());
            continue;
        }
        let mut rebuilt = String::with_capacity(line.len());
        for (index, segment) in line.split('`').enumerate() {
            if index > 0 {
                rebuilt.push('`');
            }
            if index % 2 == 1 {
                rebuilt.push_str(segment);
            } else {
                rebuilt.push_str(&linkify_segment(segment));
            }
        }
        lines.push(rebuilt);
    }
    lines.join("\n")
}

fn is_fence_line(line: &str) -> bool {
    line.trim_start_matches(is_js_space).starts_with("```")
}

/// 인라인 코드 밖의 한 조각에서 가져오기 표기를 링크로 바꾼다. 표기를 만나면 그
/// 토큰 끝으로 넘어가므로, 링크로 바꾸지 못한 토큰을 다시 훑지 않는다.
fn linkify_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    let mut index = 0;
    while let Some(offset) = segment[index..].find('@') {
        let at = index + offset;
        let lead_ok = match segment[..at].chars().next_back() {
            None => true,
            Some(previous) => is_js_space(previous) || previous == '(',
        };
        let token_end = import_token_end(segment, at + 1);
        if !lead_ok || token_end == at + 1 {
            out.push_str(&segment[index..at + 1]);
            index = at + 1;
            continue;
        }
        let token = &segment[at + 1..token_end];
        let target = token.trim_end_matches(is_import_trailing_punctuation);
        if !is_path_like(target) {
            out.push_str(&segment[index..token_end]);
            index = token_end;
            continue;
        }
        out.push_str(&segment[index..at]);
        out.push_str(&format!("[@{target}]({target})"));
        out.push_str(&token[target.len()..]);
        index = token_end;
    }
    out.push_str(&segment[index..]);
    out
}

/// 가져오기 경로에 쓸 수 있는 문자가 이어지는 끝 위치.
fn import_token_end(segment: &str, from: usize) -> usize {
    segment[from..]
        .char_indices()
        .find(|(_, value)| !is_import_path_char(*value))
        .map(|(offset, _)| from + offset)
        .unwrap_or(segment.len())
}

fn is_import_path_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '~' | '/' | '-')
}

fn is_import_trailing_punctuation(value: char) -> bool {
    matches!(value, '.' | ',' | ';' | ':' | ')' | ']')
}

/// 경로처럼 보이는 토큰. 슬래시가 있거나 확장자로 끝나야 한다.
fn is_path_like(target: &str) -> bool {
    if target.contains('/') {
        return true;
    }
    let Some(dot) = target.rfind('.') else {
        return false;
    };
    let mut extension = target[dot + 1..].chars();
    match extension.next() {
        Some(first) if first.is_ascii_alphabetic() => {
            extension.all(|value| value.is_ascii_alphanumeric())
        }
        _ => false,
    }
}

/// `[라벨](주소)` 형태의 링크 주소를 나온 순서대로 모은다. 라벨 안에 `]`가 없어야
/// 하고 주소는 비어 있을 수 없다. 정규식 훑기와 같게, 여는 괄호에서 실패하면 다음
/// 여는 괄호부터 다시 본다.
fn collect_markdown_links(segment: &str, links: &mut Vec<String>, seen: &mut BTreeSet<String>) {
    let mut index = 0;
    while let Some(offset) = segment[index..].find('[') {
        let open = index + offset;
        let after_open = open + 1;
        let Some(label_end) = segment[after_open..].find(']').map(|at| after_open + at) else {
            return;
        };
        let target_open = label_end + 1;
        if !segment[target_open..].starts_with('(') {
            index = after_open;
            continue;
        }
        let target_start = target_open + 1;
        let Some(target_end) = segment[target_start..]
            .find(')')
            .map(|at| target_start + at)
        else {
            index = after_open;
            continue;
        };
        let href = segment[target_start..target_end].trim();
        index = target_end + 1;
        if target_end == target_start {
            continue;
        }
        if !is_local_file_href(href) || !is_safe_href(href) || !seen.insert(href.to_owned()) {
            continue;
        }
        links.push(href.to_owned());
    }
}

/// 로컬 파일을 가리키는 주소. 웹 주소와 메일, 앵커는 문서가 아니다.
fn is_local_file_href(href: &str) -> bool {
    let lowered = href.to_ascii_lowercase();
    !(lowered.starts_with("https:")
        || lowered.starts_with("http:")
        || lowered.starts_with("mailto:")
        || lowered.starts_with('#'))
}

/// 화면이 링크로 그리는 주소. 판단할 수 없는 스킴은 링크로 만들지 않으므로 보관
/// 대상에서도 뺀다.
fn is_safe_href(href: &str) -> bool {
    if href.starts_with("//") {
        return false;
    }
    let lowered = href.to_ascii_lowercase();
    if lowered.starts_with("https:")
        || lowered.starts_with("http:")
        || lowered.starts_with("mailto:")
        || lowered.starts_with('#')
        || lowered.starts_with('/')
        || lowered.starts_with('\\')
    {
        return true;
    }
    for prefix in ["./", ".\\", "../", "..\\"] {
        if lowered.starts_with(prefix) {
            return true;
        }
    }
    let bytes = lowered.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_lowercase()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return true;
    }
    !href.is_empty() && !href.contains(':')
}

/// 자바스크립트 정규식의 `\s`. 유니코드 White_Space와 미세하게 다르므로 프런트
/// 규칙을 그대로 옮긴다.
fn is_js_space(value: char) -> bool {
    matches!(
        value,
        ' ' | '\t'
            | '\n'
            | '\u{0b}'
            | '\u{0c}'
            | '\r'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// 프런트 테스트(`src/lib/markdownLinks.test.mjs`)와 같은 사례 파일을 읽는다.
    /// 한쪽 규칙만 바뀌면 이 테스트가 먼저 깨진다.
    const CASES: &str = include_str!("../../../src/lib/markdownLinkCases.json");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LinkCase {
        name: String,
        source: String,
        links: Vec<String>,
    }

    #[test]
    fn collects_the_same_links_as_the_frontend_rule() {
        let cases: Vec<LinkCase> = serde_json::from_str(CASES).expect("사례 파일");
        assert!(cases.len() >= 12, "사례가 줄어들면 규칙 검증이 얕아진다");
        for case in cases {
            assert_eq!(
                local_document_links(&case.source),
                case.links,
                "사례: {}",
                case.name
            );
        }
    }

    #[test]
    fn keeps_import_tokens_that_are_not_paths_untouched() {
        assert_eq!(linkify_imports("@mention 확인"), "@mention 확인");
        assert_eq!(
            linkify_imports("@team/notes.md 확인"),
            "[@team/notes.md](team/notes.md) 확인"
        );
    }
}
