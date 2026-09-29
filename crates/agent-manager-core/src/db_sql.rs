//! C10-8~C10-10: 실행 전에 SQL 한 문장을 읽는 자리.
//!
//! # 왜 문자열 검사를 하는가
//!
//! 엔진 수준 방어(읽기 전용 트랜잭션, 승인 게이트)가 먼저이고 이 검사는 그 앞의 좁힘이다.
//! SSH가 셸 메타문자를 통째로 거절한 것과 같은 이유로 **한 호출에 한 문장만** 받는다 —
//! `SELECT 1; DROP TABLE x`가 읽기로 분류되면 쓰기 모드라는 설정이 장식이 된다.
//!
//! 여기서 하는 판정은 세 가지다: 문장이 하나인가, 무엇을 하는 문장인가(읽기·DML·DDL),
//! 어떤 경우에도 대신 실행하지 않는 문장인가. 스키마 범위 대조는 이름을 훑는 **좁힘**이지
//! 파서가 아니다 — 서버에서 강제되는 제한이 아니라는 점은 SSH 명령 목록(C9-16)과 같다.

use crate::CoreError;

/// 한 문장의 상한. 규칙과 맞춰 보는 값이지만 SQL은 명령줄보다 길다.
const MAX_SQL_CHARS: usize = 8_000;

/// 문장이 무엇을 하는지. 정책이 보는 값이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DbStatementKind {
    Read,
    Dml,
    Ddl,
}

impl DbStatementKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Dml => "dml",
            Self::Ddl => "ddl",
        }
    }
}

/// 읽어 낸 문장 하나.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedSql {
    /// 끝의 `;`와 여백만 덜어 낸 본문. 승인 카드에 실리고 대조에도 쓰이는 정본이다.
    pub normalized: String,
    pub kind: DbStatementKind,
    /// 따옴표·주석 밖의 낱말을 대문자로 모은 것.
    pub words: Vec<String>,
    /// FROM·JOIN·UPDATE·INTO·TABLE 뒤에 온 이름. 스키마 범위 대조에 쓴다.
    pub references: Vec<String>,
}

/// 읽기로 시작하는 앞머리.
const READ_HEADS: &[&str] = &[
    "SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "VALUES", "TABLE",
];

/// 행을 바꾸는 앞머리.
const DML_HEADS: &[&str] = &["INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT"];

/// 구조를 바꾸는 앞머리. `DROP`·`TRUNCATE`는 여기 없다 — 아래 거절 목록이다.
const DDL_HEADS: &[&str] = &["CREATE", "ALTER", "RENAME", "COMMENT", "REINDEX", "ANALYZE"];

/// 어떤 쓰기 모드에서도, 어떤 승인으로도 이 인터페이스가 대신 실행하지 않는 앞머리.
///
/// 세 부류다. 되돌릴 수 없는 파괴(`DROP`·`TRUNCATE`), 권한과 세션 상태를 바꾸는 것
/// (`GRANT`·`SET`·`USE`), 그리고 한 줄로 나머지 규칙 전부를 무의미하게 만드는 것
/// (`CALL`·`EXECUTE`·`LOAD`·`COPY`·`PRAGMA`·`ATTACH`). 트랜잭션 제어는 앱이 소유하므로
/// 문장으로 받지 않는다.
const REFUSED_HEADS: &[&str] = &[
    "DROP",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "SET",
    "RESET",
    "USE",
    "CALL",
    "EXEC",
    "EXECUTE",
    "PREPARE",
    "DEALLOCATE",
    "HANDLER",
    "LOAD",
    "IMPORT",
    "COPY",
    "PRAGMA",
    "ATTACH",
    "DETACH",
    "VACUUM",
    "SHUTDOWN",
    "KILL",
    "LOCK",
    "UNLOCK",
    "FLUSH",
    "PURGE",
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "DO",
    "SOURCE",
    "BACKUP",
    "RESTORE",
    "INSTALL",
    "UNINSTALL",
];

/// 문장 어디에 있어도 거절하는 낱말. 파일과 셸에 닿는 통로다.
const REFUSED_WORDS: &[&str] = &[
    "OUTFILE",
    "DUMPFILE",
    "LOAD_FILE",
    "SYS_EXEC",
    "SYS_EVAL",
    "XP_CMDSHELL",
    "PG_READ_FILE",
    "PG_READ_BINARY_FILE",
    "PG_LS_DIR",
    "PG_WRITE_FILE",
    "LO_IMPORT",
    "LO_EXPORT",
    "DBMS_PIPE",
    "UTL_FILE",
    "READFILE",
    "WRITEFILE",
];

/// 이름을 뒤따르게 하는 앞 낱말. 스키마 범위 대조의 시작점이다.
const REFERENCE_MARKERS: &[&str] = &["FROM", "JOIN", "INTO", "UPDATE", "TABLE"];

/// SQL 원본 텍스트의 기본 유효성(공백, 길이 제한, 제어 문자)을 검사한다.
fn validate_sql_text(raw: &str) -> Result<&str, CoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(
            "실행할 SQL이 비어 있습니다".to_owned(),
        ));
    }
    if trimmed.chars().count() > MAX_SQL_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "SQL은 {MAX_SQL_CHARS}자 이하여야 합니다"
        )));
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(CoreError::InvalidInput(
            "SQL에 제어 문자를 쓸 수 없습니다".to_owned(),
        ));
    }
    Ok(trimmed)
}

/// SQL 문자열을 훑어 낱말과 정규화된 본문을 추출하는 어휘 분석기.
struct SqlScanner<'a> {
    characters: &'a [char],
    index: usize,
    words: Vec<String>,
    current: String,
    terminator: Option<usize>,
}

impl<'a> SqlScanner<'a> {
    fn new(characters: &'a [char]) -> Self {
        Self {
            characters,
            index: 0,
            words: Vec::new(),
            current: String::new(),
            terminator: None,
        }
    }

    /// 현재 모아 둔 낱말 글자를 대문자로 확정해 낱말 목록에 담는다.
    fn flush_word(&mut self) {
        if !self.current.is_empty() {
            self.words
                .push(std::mem::take(&mut self.current).to_uppercase());
        }
    }

    /// 따옴표 리터럴 안을 건너뛴다.
    fn skip_quoted(&mut self, quote: char) -> Result<(), CoreError> {
        self.index += 1;
        loop {
            let Some(&inner) = self.characters.get(self.index) else {
                return Err(CoreError::InvalidInput(
                    "따옴표가 닫히지 않았습니다".to_owned(),
                ));
            };
            if inner == '\\' && quote != '`' {
                // MySQL 계열의 역슬래시 이스케이프. 다음 글자는 그대로 넘긴다.
                self.index += 2;
                continue;
            }
            if inner == quote {
                if self.characters.get(self.index + 1).copied() == Some(quote) {
                    self.index += 2;
                    continue;
                }
                self.index += 1;
                return Ok(());
            }
            self.index += 1;
        }
    }

    /// 한 줄 주석(`--` 또는 `#`)을 개행까지 건너뛴다.
    fn skip_line_comment(&mut self) {
        while self.index < self.characters.len() && self.characters[self.index] != '\n' {
            self.index += 1;
        }
    }

    /// 블록 주석(`/* ... */`)을 건너뛴다.
    fn skip_block_comment(&mut self) -> Result<(), CoreError> {
        self.index += 2;
        loop {
            let Some(&inner) = self.characters.get(self.index) else {
                return Err(CoreError::InvalidInput(
                    "주석이 닫히지 않았습니다".to_owned(),
                ));
            };
            if inner == '*' && self.characters.get(self.index + 1).copied() == Some('/') {
                self.index += 2;
                return Ok(());
            }
            self.index += 1;
        }
    }

    /// 낱말 추출 및 정규화 본문을 생성한다.
    fn scan(mut self, trimmed: &str) -> Result<(Vec<String>, String), CoreError> {
        while self.index < self.characters.len() {
            let character = self.characters[self.index];
            let next = self.characters.get(self.index + 1).copied();
            // 낱말이 끊기는 자리에서 모아 둔 글자를 확정한다.
            let is_word_char = character.is_ascii_alphanumeric()
                || matches!(character, '_' | '$' | '.')
                || !character.is_ascii();
            if !is_word_char {
                self.flush_word();
            }
            if self.terminator.is_some()
                && !character.is_whitespace()
                && !(character == '-' && next == Some('-'))
                && !(character == '/' && next == Some('*'))
                && character != '#'
            {
                return Err(CoreError::InvalidInput(
                    "한 번에 한 문장만 실행합니다. 세미콜론으로 이어 붙인 여러 문장은 받지 않습니다 — 단계마다 따로 호출하세요".to_owned(),
                ));
            }
            match character {
                '\'' | '"' | '`' => {
                    self.skip_quoted(character)?;
                }
                '-' if next == Some('-') => {
                    self.skip_line_comment();
                }
                '#' => {
                    self.skip_line_comment();
                }
                '/' if next == Some('*') => {
                    self.skip_block_comment()?;
                }
                ';' => {
                    self.terminator = Some(self.index);
                    self.index += 1;
                }
                '\\' => {
                    return Err(CoreError::InvalidInput(
                        "SQL에 역슬래시로 시작하는 클라이언트 명령을 쓸 수 없습니다".to_owned(),
                    ));
                }
                _ => {
                    if is_word_char {
                        self.current.push(character);
                    }
                    self.index += 1;
                }
            }
        }
        self.flush_word();

        let normalized = match self.terminator {
            Some(position) => self.characters[..position].iter().collect::<String>(),
            None => trimmed.to_owned(),
        };
        let normalized = normalized.trim().to_owned();
        if normalized.is_empty() {
            return Err(CoreError::InvalidInput(
                "실행할 SQL이 비어 있습니다".to_owned(),
            ));
        }

        Ok((self.words, normalized))
    }
}

/// 추출된 낱말을 바탕으로 거절 대상 및 문장 종류를 판정한다.
fn validate_statement_policy(words: &[String]) -> Result<(&str, DbStatementKind), CoreError> {
    let Some(head) = words.first().map(String::as_str) else {
        return Err(CoreError::InvalidInput(
            "실행할 SQL을 읽지 못했습니다".to_owned(),
        ));
    };
    if let Some(&refused) = REFUSED_HEADS.iter().find(|value| **value == head) {
        return Err(CoreError::InvalidInput(format!(
            "{refused}(으)로 시작하는 문장은 이 인터페이스가 대신 실행하지 않습니다. 되돌릴 수 없거나 권한·세션 상태를 바꾸는 문장이라 승인으로도 열리지 않습니다"
        )));
    }
    if let Some(&refused) = REFUSED_WORDS
        .iter()
        .find(|value| words.iter().any(|word| word == *value))
    {
        return Err(CoreError::InvalidInput(format!(
            "{refused}(을)를 쓰는 문장은 실행하지 않습니다. 파일이나 셸에 닿는 통로는 이 인터페이스에 없습니다"
        )));
    }

    let kind = classify(head, words).ok_or_else(|| {
        CoreError::InvalidInput(format!(
            "{head}(으)로 시작하는 문장은 지원하지 않습니다. 읽기는 SELECT·SHOW·EXPLAIN·DESCRIBE, 변경은 INSERT·UPDATE·DELETE, 구조 변경은 CREATE·ALTER를 씁니다"
        ))
    })?;

    Ok((head, kind))
}

/// SQL 한 문장을 읽는다. 문장이 둘 이상이거나 대신 실행하지 않는 문장이면 거절한다.
pub(crate) fn parse_sql(raw: &str) -> Result<ParsedSql, CoreError> {
    let trimmed = validate_sql_text(raw)?;
    let characters: Vec<char> = trimmed.chars().collect();
    let (words, normalized) = SqlScanner::new(&characters).scan(trimmed)?;
    let (_head, kind) = validate_statement_policy(&words)?;

    Ok(ParsedSql {
        normalized,
        kind,
        references: references(&words),
        words,
    })
}

/// 앞머리로 성격을 가른다. `WITH`는 뒤따르는 본문이 정하므로 낱말 전체를 본다 —
/// `WITH x AS (…) DELETE …`가 읽기로 분류되면 CTE 한 줄로 쓰기 모드를 지나간다.
fn classify(head: &str, words: &[String]) -> Option<DbStatementKind> {
    if head == "WITH" {
        if words.iter().any(|word| DML_HEADS.contains(&word.as_str())) {
            return Some(DbStatementKind::Dml);
        }
        return Some(DbStatementKind::Read);
    }
    if READ_HEADS.contains(&head) {
        return Some(DbStatementKind::Read);
    }
    if DML_HEADS.contains(&head) {
        return Some(DbStatementKind::Dml);
    }
    if DDL_HEADS.contains(&head) {
        return Some(DbStatementKind::Ddl);
    }
    None
}

/// FROM·JOIN·UPDATE·INTO·TABLE 바로 뒤의 이름을 모은다. 하위 질의 괄호나 키워드가 오면
/// 그 자리는 건너뛴다 — 모으지 못한 이름이 있다는 사실 자체가 이 대조의 한계다.
fn references(words: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let keywords = ["SELECT", "VALUES", "SET", "WHERE", "AS", "ON", "DUAL"];
    for pair in words.windows(2) {
        if !REFERENCE_MARKERS.contains(&pair[0].as_str()) {
            continue;
        }
        let candidate = &pair[1];
        if keywords.contains(&candidate.as_str()) || candidate.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if !result.contains(candidate) {
            result.push(candidate.clone());
        }
    }
    result
}

/// 이 문장이 닿는 이름이 모두 허용 범위 안인지. 범위가 비어 있으면 제한하지 않는다.
pub(crate) fn ensure_scope(parsed: &ParsedSql, scope: &[String]) -> Result<(), CoreError> {
    if scope.is_empty() {
        return Ok(());
    }
    let allowed: Vec<String> = scope.iter().map(|value| value.to_uppercase()).collect();
    for reference in &parsed.references {
        if !allowed
            .iter()
            .any(|prefix| reference.starts_with(prefix.as_str()))
        {
            return Err(CoreError::InvalidInput(format!(
                "{reference}은(는) 이 연결에 허용된 스키마 범위({})가 아닙니다",
                scope.join(", ")
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c10_8_only_one_statement_passes() {
        let parsed = parse_sql("SELECT 1;").expect("single");
        assert_eq!(parsed.normalized, "SELECT 1");
        assert_eq!(parsed.kind, DbStatementKind::Read);
        let error = parse_sql("SELECT 1; DROP TABLE t").expect_err("two");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn c10_8_a_semicolon_inside_a_literal_is_not_a_terminator() {
        let parsed = parse_sql("SELECT * FROM t WHERE a = 'x; y'").expect("literal");
        assert_eq!(parsed.kind, DbStatementKind::Read);
        assert!(parsed.normalized.ends_with("'x; y'"));
    }

    #[test]
    fn c10_8_comments_cannot_hide_a_second_statement() {
        parse_sql("SELECT 1 -- ; DROP TABLE t").expect("comment only");
        let error = parse_sql("SELECT 1; /* gap */ UPDATE t SET a = 1").expect_err("two");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn c10_9_a_cte_that_writes_is_classified_as_a_write() {
        let parsed = parse_sql(
            "WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)",
        )
        .expect("cte");
        assert_eq!(parsed.kind, DbStatementKind::Dml);
        let read = parse_sql("WITH x AS (SELECT 1) SELECT * FROM x").expect("read cte");
        assert_eq!(read.kind, DbStatementKind::Read);
    }

    #[test]
    fn c10_10_destructive_and_shell_paths_are_refused_outright() {
        for sql in [
            "DROP TABLE t",
            "TRUNCATE TABLE t",
            "GRANT ALL ON db.* TO app",
            "SET GLOBAL max_connections = 1",
            "USE other",
            "CALL do_everything()",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "SELECT load_file('/etc/passwd')",
            "BEGIN",
        ] {
            let error = parse_sql(sql).expect_err(sql);
            assert!(matches!(error, CoreError::InvalidInput(_)), "{sql}");
        }
    }

    #[test]
    fn c10_10_scope_is_matched_against_referenced_names() {
        let parsed =
            parse_sql("SELECT * FROM TB_MENU_BAS m JOIN TB_PGM_BAS p ON 1 = 1").expect("read");
        assert_eq!(parsed.references, vec!["TB_MENU_BAS", "TB_PGM_BAS"]);
        ensure_scope(&parsed, &["tb_".to_owned()]).expect("in scope");
        let error = ensure_scope(&parsed, &["APRV".to_owned()]).expect_err("out of scope");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        // 범위를 비워 두면 대조하지 않는다.
        ensure_scope(&parsed, &[]).expect("no scope");
    }

    #[test]
    fn c10_8_client_side_backslash_commands_are_refused() {
        let error = parse_sql("\\! rm -rf /").expect_err("shell escape");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
}
