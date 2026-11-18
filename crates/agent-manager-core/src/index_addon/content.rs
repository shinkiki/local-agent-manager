//! G4/G10: exclusion decisions contain metadata only; rejected bodies never reach SQLite.
use super::MAX_FILE_BYTES;
use crate::CoreError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexExclusionReason {
    HiddenPath,
    SensitivePath,
    DependencyOrBuild,
    UnsupportedType,
    Symlink,
    NonRegular,
    TooLarge,
    Binary,
    InvalidUtf8,
    LongLine,
    Credentials,
    /// 파일은 색인했지만 자격증명 줄만 비웠다. 집계는 파일 수가 아니라 줄 수다.
    CredentialLines,
}

impl IndexExclusionReason {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::HiddenPath => "hiddenPath",
            Self::SensitivePath => "sensitivePath",
            Self::DependencyOrBuild => "dependencyOrBuild",
            Self::UnsupportedType => "unsupportedType",
            Self::Symlink => "symlink",
            Self::NonRegular => "nonRegular",
            Self::TooLarge => "tooLarge",
            Self::Binary => "binary",
            Self::InvalidUtf8 => "invalidUtf8",
            Self::LongLine => "longLine",
            Self::Credentials => "credentials",
            Self::CredentialLines => "credentialLines",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexExclusionCount {
    pub reason: IndexExclusionReason,
    pub count: usize,
}

pub(super) enum ContentRead {
    /// `text` is already scrubbed of credential lines (`redacted_lines` of them);
    /// `digest` is of the original bytes so later freshness checks compare with the file.
    Text {
        text: String,
        digest: String,
        redacted_lines: usize,
    },
    Excluded(IndexExclusionReason),
}

pub(super) fn classify_name(name: &str, directory: bool) -> Option<IndexExclusionReason> {
    use IndexExclusionReason::*;
    let lower = name.to_lowercase();
    if lower.starts_with('.') {
        return Some(HiddenPath);
    }
    if lower.starts_with("id_")
        || lower.ends_with("cypress.env.json")
        || ["credential", "secret", "token", "password"]
            .iter()
            .any(|part| lower.contains(part))
    {
        return Some(SensitivePath);
    }
    if directory {
        return [
            "node_modules",
            "target",
            "dist",
            "build",
            "vendor",
            "coverage",
            "__pycache__",
            "venv",
        ]
        .contains(&lower.as_str())
        .then_some(DependencyOrBuild);
    }
    if ["auth.json", "config.json"].contains(&lower.as_str()) {
        return Some(SensitivePath);
    }
    if [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "cargo.lock",
    ]
    .contains(&lower.as_str())
    {
        return Some(DependencyOrBuild);
    }
    let supported = matches!(
        Path::new(&lower).extension().and_then(|s| s.to_str()),
        Some(
            "rs" | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "py"
                | "go"
                | "java"
                | "kt"
                | "swift"
                | "c"
                | "h"
                | "cpp"
                | "hpp"
                | "cs"
                | "rb"
                | "php"
                | "vue"
                | "svelte"
                | "html"
                | "css"
                | "scss"
                | "md"
                | "mdx"
                | "txt"
                | "rst"
                | "adoc"
                | "sql"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "xml"
        )
    );
    (!supported).then_some(UnsupportedType)
}

pub(super) fn read_text_detailed(path: &Path) -> Result<ContentRead, CoreError> {
    use IndexExclusionReason::*;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Ok(ContentRead::Excluded(NonRegular));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Ok(ContentRead::Excluded(TooLarge));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Ok(ContentRead::Excluded(TooLarge));
    }
    if bytes.contains(&0) {
        return Ok(ContentRead::Excluded(Binary));
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(ContentRead::Excluded(InvalidUtf8));
    };
    if text.lines().any(|line| line.len() > 4_000) {
        return Ok(ContentRead::Excluded(LongLine));
    }
    if text.contains("-----BEGIN ") {
        return Ok(ContentRead::Excluded(Credentials));
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let Some((text, redacted_lines)) = scrub_credential_lines(text, extension) else {
        return Ok(ContentRead::Excluded(Credentials));
    };
    Ok(ContentRead::Text {
        text,
        digest,
        redacted_lines,
    })
}

/// 줄 단위로 비울 수 있는 소스 언어. 데이터·문서 형식(YAML 블록 스칼라, TOML 여러 줄 문자열,
/// Markdown 코드 블록)은 값이 다음 줄로 이어지는 것이 보통이라 지금처럼 파일 전체를 뺀다.
fn line_level_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "swift"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "rb"
            | "php"
            | "vue"
            | "svelte"
    )
}

pub(super) const CREDENTIAL_LINE_PLACEHOLDER: &str = "[제거된 자격증명 줄]";

/// G4: a credential assignment in a source file removes **that line and every line down to
/// the next blank line** (each replaced by the placeholder so line numbering survives) instead
/// of the whole file. The block, not the line, is what makes this safe without a grammar for
/// every language: a value that continues onto later lines — an open quote, bracket, heredoc,
/// a trailing operator, a `+`/`.` on the next line, a getter body, a case arm — is almost
/// always written inside the same paragraph as its key, and the paragraph ends at the blank
/// line. A value that spans a blank line is the one shape this does not cover; it is an
/// accepted risk (user decision, 2026-11-09) in exchange for the file being searchable at all.
/// `None` keeps the whole-file exclusion for data and document formats, for a JSON document
/// with a secret key, and for a file left with nothing but placeholders.
fn scrub_credential_lines(text: String, extension: &str) -> Option<(String, usize)> {
    if !line_level_extension(extension) {
        return (!has_structured_credentials(&text, extension)).then_some((text, 0));
    }
    if serde_json::from_str::<serde_json::Value>(&text).is_ok_and(|value| secret_json(&value)) {
        return None;
    }
    let mut lines = text.split('\n').map(str::to_owned).collect::<Vec<_>>();
    let mut redacted = 0;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].as_str();
        let flagged = credential_separator(line, extension, true).is_some()
            || (names_credential_word(line)
                && !line.trim_end().ends_with([')', ']', '}', '{', ';'])
                && lines
                    .get(index + 1)
                    .is_some_and(|next| next_line_continues(next.trim_start())));
        if !flagged {
            index += 1;
            continue;
        }
        // A CR-only or whitespace-only line ends the paragraph like an empty one; so does
        // the end of the file.
        let block_end = lines[index..]
            .iter()
            .position(|l| l.trim().is_empty())
            .unwrap_or(lines.len() - index);
        for scrubbed in &mut lines[index..index + block_end] {
            *scrubbed = CREDENTIAL_LINE_PLACEHOLDER.to_owned();
            redacted += 1;
        }
        index += block_end;
    }
    // A file whose every non-blank line was scrubbed carries nothing to index; report it as
    // the whole-file exclusion it effectively is, so the diagnostics do not call it indexed.
    if redacted > 0
        && lines
            .iter()
            .all(|l| l.trim().is_empty() || l == CREDENTIAL_LINE_PLACEHOLDER)
    {
        return None;
    }
    Some((lines.join("\n"), redacted))
}

/// A line that names a credential key without assigning it on that line (`val password:
/// String`, `let token: &str`, `$password`) is flagged when the next line reads as its
/// continuation — an operator, opener or quote, or a property accessor keyword (`get() =`,
/// `set`, `by lazy`). A `* ` is doc-comment decoration, not multiplication, and a `/` is far
/// more often a comment than a division, so neither counts. A line that already closed
/// (`GetAccessToken()`, `};`) is complete, so an Allman `{` or a JSX `<` below it does not
/// pull a whole method body into the block.
fn names_credential_word(line: &str) -> bool {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|word| !word.is_empty() && names_credential(word, true))
}

fn next_line_continues(next: &str) -> bool {
    if next == "*" || next.starts_with("* ") {
        return false;
    }
    if next.starts_with(|c: char| {
        matches!(
            c,
            '+' | '-'
                | '*'
                | '%'
                | '.'
                | '?'
                | ':'
                | '|'
                | '&'
                | '^'
                | '='
                | '<'
                | '>'
                | ','
                | '('
                | '['
                | '{'
                | '"'
                | '\''
                | '`'
                | '\\'
        )
    }) {
        return true;
    }
    let word = next
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .next()
        .unwrap_or_default();
    matches!(word, "get" | "set" | "by" | "then" | "when")
}

const KEYS: &[&str] = &[
    "access_token",
    "accesstoken",
    "api_key",
    "apikey",
    "auth_token",
    "authtoken",
    "client_secret",
    "clientsecret",
    "id_token",
    "password",
    "passwd",
    "private_key",
    "refresh_token",
    "refreshtoken",
    "secret",
    "session_token",
    "token",
];

/// Exact key match for the whole-file rule. The line-level scrub (`compound`) also accepts the
/// key as the last `_` segment or suffix of a longer identifier (`db_password`, `githubToken`),
/// because one scrubbed line is a price a file can pay where a whole exclusion was not — and
/// because the first exact-key line no longer shields the others.
fn names_credential(identifier: &str, compound: bool) -> bool {
    let lower = identifier.to_ascii_lowercase();
    KEYS.iter().any(|secret| {
        lower == *secret
            || (compound && lower.ends_with(secret) && lower.len() > secret.len() && {
                let prefix = &lower[..lower.len() - secret.len()];
                prefix.ends_with('_') || !prefix.ends_with(|c: char| c.is_ascii_digit())
            })
    })
}

fn secret_json(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(fields) => fields.iter().any(|(key, value)| {
            KEYS.iter().any(|secret| secret.eq_ignore_ascii_case(key)) || secret_json(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(secret_json),
        _ => false,
    }
}

fn has_structured_credentials(text: &str, extension: &str) -> bool {
    if serde_json::from_str::<serde_json::Value>(text).is_ok_and(|value| secret_json(&value)) {
        return true;
    }
    credential_separator(text, extension, false).is_some()
}

/// Byte offset of the `=`/`:` that follows the first credential key assigned a value in
/// `text`. Declarations that `is_type_annotation` recognises are skipped. With `mutations`
/// (the line-level scrub only — the whole-file rule keeps its original reach) compound
/// assignments (`+=`, `.=`, `||=`, `??=`) and a method call on the key next to a string
/// literal (`password.push_str("…")`) count too, since the line that first assigned the
/// variable no longer shields the rest of the file. Helper calls (`set_password("…")`) are
/// outside this scanner, as they were before.
const VALUE_WRITING_METHODS: &[&str] = &[
    "push_str", "push", "append", "concat", "assign", "set", "insert", "extend", "write",
    "replace", "reset",
];

fn credential_separator(text: &str, extension: &str, mutations: bool) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut position = 0;
    while position < bytes.len() {
        if !bytes[position].is_ascii_alphabetic() && bytes[position] != b'_' {
            position += 1;
            continue;
        }
        let start = position;
        while position < bytes.len()
            && (bytes[position].is_ascii_alphanumeric() || bytes[position] == b'_')
        {
            position += 1;
        }
        if !names_credential(&text[start..position], mutations) {
            continue;
        }
        let mut end = position;
        // `password.push_str("…")`: only a method that writes into the variable counts, so a
        // read such as `token.startsWith("Bearer ")` keeps its paragraph searchable.
        if mutations && end + 1 < bytes.len() && bytes[end] == b'.' {
            let mut method_end = end + 1;
            while method_end < bytes.len()
                && (bytes[method_end].is_ascii_alphanumeric() || bytes[method_end] == b'_')
            {
                method_end += 1;
            }
            if VALUE_WRITING_METHODS.contains(&&text[end + 1..method_end])
                && text[method_end..].trim_start().starts_with('(')
                && text.contains(['"', '\'', '`'])
            {
                return Some(end);
            }
        }
        if end < bytes.len() && matches!(bytes[end], b'"' | b'\'') {
            end += 1;
        }
        while end < bytes.len() && bytes[end].is_ascii_whitespace() {
            end += 1;
        }
        if mutations
            && end < bytes.len()
            && matches!(bytes[end], b'+' | b'-' | b'*' | b'.' | b'|' | b'?')
        {
            let mut assign = end + 1;
            while assign < bytes.len() && bytes[assign] == bytes[end] {
                assign += 1;
            }
            if assign < bytes.len() && bytes[assign] == b'=' {
                return Some(assign);
            }
            continue;
        }
        if end >= bytes.len() || !matches!(bytes[end], b':' | b'=') {
            continue;
        }
        if bytes[end] == b':' && is_type_annotation(&text[end + 1..], extension) {
            continue;
        }
        return Some(end);
    }
    None
}

// G4: only declarations in a source language may name a credential slot. A value assignment,
// quoted value, unknown type, or the same spelling in YAML/TOML/text remains excluded.
fn is_type_annotation(rest: &str, extension: &str) -> bool {
    let rust = [
        "&str",
        "&String",
        "String",
        "Option<String>",
        "Option<&str>",
        "&'static str",
        "&'a str",
        "&[u8]",
        "Vec<u8>",
    ];
    let typescript = [
        "string",
        "string | null",
        "string | undefined",
        "number",
        "boolean",
        "unknown",
        "Uint8Array",
    ];
    let types: &[&str] = match extension.to_ascii_lowercase().as_str() {
        "rs" => &rust,
        "ts" | "tsx" => &typescript,
        _ => return false,
    };
    let rest = rest.trim_start_matches([' ', '\t']);
    types.iter().any(|ty| {
        rest.strip_prefix(ty).is_some_and(|after| {
            matches!(
                after.trim_start_matches([' ', '\t']).bytes().next(),
                Some(b',' | b')' | b'}' | b';')
            )
        })
    })
}
