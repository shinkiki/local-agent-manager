//! C10-8~C10-14: 등록된 연결에서 SQL 한 문장을 실행한다.
//!
//! # 왜 앱이 대신 실행하는가
//!
//! SSH(C9-14)와 같은 이유이고 하나가 더 있다. 셸이 없는 AIA에게 길을 내주는 것이 첫째고,
//! 둘째는 **자격증명이 에이전트에게 넘어가지 않는다**는 것이다. 에이전트가 자기 셸에서
//! `mysql`을 부르면 비밀번호를 알아야 하지만, 여기서는 비밀값이 이 모듈 안에서만 살고
//! 문장 하나가 오갈 뿐이다.
//!
//! # 집행이 성립하는 조건
//!
//! 세 겹이다.
//!
//! 1. 문장 검사([`crate::db_sql`]) — 한 호출에 한 문장, 대신 실행하지 않는 앞머리 거절.
//! 2. **엔진 수준 읽기 전용** — 읽기 경로는 `START TRANSACTION READ ONLY`(SQLite는 읽기
//!    전용으로 파일 열기) 안에서만 돈다. 문자열 검사가 뚫려도 엔진이 쓰기를 거부한다.
//! 3. 승인(C10-12) — 쓰기는 예행(트랜잭션 실행 후 되돌림)으로 영향 행 수를 세어 카드에
//!    싣고, 사용자가 허용한 뒤 같은 문장을 한 번 더 실행해 커밋한다.
//!
//! 서버에서 강제되는 제한은 아니다. 서버측 제한은 그 계정에 준 권한뿐이고, 이 모듈은
//! **이 앱의 실행 경로**만 좁힌다(C9-16과 같은 한계).

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::db_approvals::{DbApprovalConsume, DbApprovalGate, DbApprovalKind, DbApprovalOpen};
use crate::db_connections::{
    connection_of, resolve_secret, DbConnectionCheckReceipt, DbConnectionRef, DbConnectionView,
    DbEngineKind, MAX_MAX_ROWS,
};
use crate::db_sql::{ensure_scope, parse_sql, DbStatementKind, ParsedSql};
use crate::CoreError;

/// 접속에 드는 시간의 상한. 사내망 밖에서 부르면 여기서 끊긴다.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 한 문장이 서버에서 도는 시간의 상한. 엔진 세션 설정으로도 걸고, 소켓 타임아웃으로도 건다.
const STATEMENT_TIMEOUT: Duration = Duration::from_secs(30);
/// 한 응답에 담는 본문의 상한. 대화 맥락을 태우지 않는 선이다.
const MAX_RESULT_BYTES: usize = 64 * 1024;
/// 마스킹된 값이 놓이는 자리.
const MASK: &str = "●●●●";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryRequest {
    pub connection_id: String,
    pub sql: String,
    #[serde(default)]
    pub max_rows: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStatementRequest {
    pub connection_id: String,
    pub sql: String,
    /// 승인 카드에서 받은 id. 비어 있으면 예행만 하고 승인을 연다.
    #[serde(default)]
    pub approval_id: Option<String>,
}

/// 조회 영수증. 비밀값은 어느 필드에도 없고, 마스킹된 컬럼은 값 대신 표시만 남는다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryReceipt {
    pub connection_id: String,
    pub destination: String,
    pub environment: String,
    pub sql: String,
    pub columns: Vec<String>,
    /// 값은 모두 문자열이거나 null이다. 엔진마다 다른 수치 표현을 옮기면서 정밀도를
    /// 잃지 않게, 서버가 준 표기를 그대로 싣는다.
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
    pub truncated: bool,
    pub masked_columns: Vec<String>,
    pub elapsed_ms: u64,
    pub message: String,
}

/// 변경 영수증. 승인 대기 상태와 실행 결과가 한 타입이다 — 호출한 쪽은 언제나 같은
/// 모양을 받고 `approvalRequired`로 갈린다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbStatementReceipt {
    pub connection_id: String,
    pub destination: String,
    pub environment: String,
    pub sql: String,
    pub kind: String,
    pub approval_required: bool,
    pub approval_id: Option<String>,
    pub expires_at: Option<i64>,
    pub reason: String,
    /// 예행에서 바뀐 행 수. 승인 전 카드에 실린 값과 같다.
    pub previewed_rows: Option<u64>,
    /// 실제로 커밋한 행 수.
    pub affected_rows: Option<u64>,
    pub committed: bool,
    pub elapsed_ms: u64,
    pub message: String,
}

/// 저장된 연결로 한 번 붙어 서버 버전만 읽고 끊는다. 원격에서는 아무것도 바뀌지 않는다.
pub fn check_db_connection(
    app_data_dir: &std::path::Path,
    request: DbConnectionRef,
) -> Result<DbConnectionCheckReceipt, CoreError> {
    let connection = connection_of(app_data_dir, &request.id)?;
    let destination = connection.destination();
    match version_probe(&connection) {
        Ok(version) => Ok(DbConnectionCheckReceipt {
            id: connection.id,
            destination,
            reachable: true,
            server_version: version,
            message: "접속에 성공했습니다".to_owned(),
        }),
        Err(error) => Ok(DbConnectionCheckReceipt {
            id: connection.id,
            destination,
            reachable: false,
            server_version: String::new(),
            message: scrub(&error.to_string()),
        }),
    }
}

/// 읽기 문장 하나를 실행한다. 엔진 수준 읽기 전용 트랜잭션 안에서만 돈다(C10-9).
pub fn run_db_query(
    app_data_dir: &std::path::Path,
    request: DbQueryRequest,
) -> Result<DbQueryReceipt, CoreError> {
    let connection = agent_connection(app_data_dir, &request.connection_id)?;
    let parsed = parse_sql(&request.sql)?;
    if parsed.kind != DbStatementKind::Read {
        return Err(CoreError::InvalidInput(format!(
            "{}는 조회 작업으로 실행할 수 없습니다. 변경 문장은 승인을 받는 실행 작업으로 부르세요",
            parsed.kind.as_str()
        )));
    }
    ensure_scope(&parsed, &connection.schema_scope)?;
    let limit = request
        .max_rows
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_MAX_ROWS))
        .unwrap_or_else(|| connection.effective_max_rows())
        .min(connection.effective_max_rows()) as usize;

    let started = Instant::now();
    let result = query(&connection, &parsed.normalized, limit)?;
    let masked = mask_columns(&connection, &result.columns);
    let rows = apply_mask(result.rows, &result.columns, &masked);
    let message = if result.truncated {
        format!(
            "{}행에서 끊었습니다. 더 필요하면 조건을 좁히거나 maxRows를 올리세요(천장 {MAX_MAX_ROWS}행)",
            rows.len()
        )
    } else {
        format!("{}행", rows.len())
    };
    Ok(DbQueryReceipt {
        connection_id: connection.id.clone(),
        destination: connection.destination(),
        environment: connection.environment.label().to_owned(),
        sql: parsed.normalized,
        columns: result.columns,
        row_count: rows.len(),
        rows,
        truncated: result.truncated,
        masked_columns: masked,
        elapsed_ms: started.elapsed().as_millis() as u64,
        message,
    })
}

/// 변경 문장 하나를 실행한다. 승인 없이 부르면 예행만 하고 승인 카드를 연다(C10-12).
pub fn run_db_statement(
    app_data_dir: &std::path::Path,
    request: DbStatementRequest,
    gate: Option<&dyn DbApprovalGate>,
) -> Result<DbStatementReceipt, CoreError> {
    let connection = agent_connection(app_data_dir, &request.connection_id)?;
    let parsed = parse_sql(&request.sql)?;
    let kind = write_kind(parsed.kind)?;
    ensure_write_allowed(&connection, kind)?;
    ensure_scope(&parsed, &connection.schema_scope)?;
    let Some(gate) = gate else {
        return Err(CoreError::InvalidInput(
            "변경 문장은 사용자 승인 카드가 뜨는 대화에서만 실행할 수 있습니다. 이 호출에는 승인을 띄울 대화가 없습니다".to_owned(),
        ));
    };

    let pending = PendingStatement::new(&connection, parsed, kind);
    match request.approval_id.as_deref().map(str::trim) {
        Some(approval_id) if !approval_id.is_empty() => pending.commit(gate, approval_id),
        _ => pending.open_approval(gate),
    }
}

/// 이 경로가 받는 것은 변경 문장뿐이다. 읽기 문장에는 대응하는 승인 종류가 없다.
fn write_kind(kind: DbStatementKind) -> Result<DbApprovalKind, CoreError> {
    match kind {
        DbStatementKind::Read => Err(CoreError::InvalidInput(
            "읽기 문장은 조회 작업으로 부르세요. 이 작업은 변경 문장만 받습니다".to_owned(),
        )),
        DbStatementKind::Dml => Ok(DbApprovalKind::Dml),
        DbStatementKind::Ddl => Ok(DbApprovalKind::Ddl),
    }
}

/// 저장본 기준으로 이 연결에 이 종류의 변경을 실행해도 되는지 본다.
///
/// C10-11. 운영 라벨은 저장 경로에서 이미 막히지만, 저장본이 다른 경로로 바뀌었을
/// 경우를 대비해 실행 직전에도 본다.
fn ensure_write_allowed(
    connection: &DbConnectionView,
    kind: DbApprovalKind,
) -> Result<(), CoreError> {
    if connection.environment.is_production() {
        return Err(CoreError::InvalidInput(
            "운영으로 표시된 연결에는 변경 문장을 실행하지 않습니다".to_owned(),
        ));
    }
    match kind {
        DbApprovalKind::Dml if !connection.write_mode.allows_dml() => Err(CoreError::InvalidInput(format!(
            "이 연결은 {}로 설정돼 있어 변경 문장을 실행할 수 없습니다. 애드온 → 데이터베이스에서 쓰기 모드를 올려 달라고 사용자에게 요청하세요",
            connection.write_mode.as_str()
        ))),
        DbApprovalKind::Ddl if !connection.write_mode.allows_ddl() => {
            Err(CoreError::InvalidInput(format!(
                "이 연결은 {}로 설정돼 있어 구조 변경을 실행할 수 없습니다",
                connection.write_mode.as_str()
            )))
        }
        _ => Ok(()),
    }
}

/// 검사를 모두 지난 변경 문장 하나. 여기서 갈래가 둘로 나뉘고(승인 소비·승인 열기),
/// 두 갈래가 같은 영수증 모양을 쓰므로 공통 값은 한 번만 모아 둔다.
struct PendingStatement<'a> {
    connection: &'a DbConnectionView,
    parsed: ParsedSql,
    kind: DbApprovalKind,
    destination: String,
    environment: String,
    started: Instant,
}

impl<'a> PendingStatement<'a> {
    fn new(connection: &'a DbConnectionView, parsed: ParsedSql, kind: DbApprovalKind) -> Self {
        Self {
            destination: connection.destination(),
            environment: connection.environment.label().to_owned(),
            connection,
            parsed,
            kind,
            started: Instant::now(),
        }
    }

    /// 두 갈래가 공유하는 자리만 채운 영수증. 나머지는 갈래가 덮는다. 경과 시간을
    /// 여기서 재므로 실행이 끝난 뒤에 부른다.
    fn base_receipt(self) -> DbStatementReceipt {
        DbStatementReceipt {
            connection_id: self.connection.id.clone(),
            destination: self.destination,
            environment: self.environment,
            kind: self.parsed.kind.as_str().to_owned(),
            sql: self.parsed.normalized,
            approval_required: false,
            approval_id: None,
            expires_at: None,
            reason: String::new(),
            previewed_rows: None,
            affected_rows: None,
            committed: false,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            message: String::new(),
        }
    }

    /// 승인을 소비하고 같은 문장을 한 번 더 실행해 커밋한다.
    fn commit(
        self,
        gate: &dyn DbApprovalGate,
        approval_id: &str,
    ) -> Result<DbStatementReceipt, CoreError> {
        gate.consume_db_approval(DbApprovalConsume {
            approval_id,
            connection_id: &self.connection.id,
            sql: &self.parsed.normalized,
            kind: self.kind,
        })?;
        let affected = commit_statement(self.connection, &self.parsed, self.kind)?;
        Ok(DbStatementReceipt {
            approval_id: Some(approval_id.to_owned()),
            affected_rows: Some(affected),
            committed: true,
            message: format!("{affected}행을 바꾸고 커밋했습니다"),
            ..self.base_receipt()
        })
    }

    /// 아직 아무것도 바꾸지 않은 채 승인 카드를 연다.
    fn open_approval(self, gate: &dyn DbApprovalGate) -> Result<DbStatementReceipt, CoreError> {
        // C10-12. DML은 먼저 트랜잭션 안에서 돌려 영향 행 수를 세고 되돌린다. DDL은
        // 암시적 커밋이라 예행이 성립하지 않으므로 세지 않고 카드에 그 사실을 적는다.
        let previewed = match self.kind {
            DbApprovalKind::Dml => Some(preview_statement(self.connection, &self.parsed)?),
            DbApprovalKind::Ddl => None,
        };
        let reason = match self.kind {
            DbApprovalKind::Dml => {
                "데이터를 바꾸는 문장이라 실행마다 사용자 승인을 받습니다".to_owned()
            }
            DbApprovalKind::Ddl => {
                "구조를 바꾸는 문장이라 실행마다 사용자 승인을 받습니다. 되돌릴 수 없습니다"
                    .to_owned()
            }
        };
        let ticket = gate.open_db_approval(DbApprovalOpen {
            connection_id: &self.connection.id,
            destination: &self.destination,
            environment: &self.environment,
            sql: &self.parsed.normalized,
            kind: self.kind,
            previewed_rows: previewed,
            reason: &reason,
        })?;
        let destination = &self.destination;
        let message = match previewed {
            Some(rows) => format!(
                "아직 아무것도 바꾸지 않았습니다. 예행 결과 {rows}행이 바뀝니다. 사용자에게 대상({destination})·SQL·영향 행 수를 그대로 전하고 승인 카드에서 허용을 받은 뒤, 같은 approvalId와 글자 하나까지 같은 SQL로 한 번 더 호출하세요"
            ),
            None => format!(
                "아직 아무것도 바꾸지 않았습니다. 구조 변경은 예행이 성립하지 않아 행 수를 세지 못했습니다. 사용자에게 대상({destination})과 SQL을 그대로 전하고 승인을 받은 뒤 같은 approvalId로 한 번 더 호출하세요"
            ),
        };
        Ok(DbStatementReceipt {
            approval_required: true,
            approval_id: Some(ticket.id),
            expires_at: Some(ticket.expires_at),
            reason,
            previewed_rows: previewed,
            message,
            ..self.base_receipt()
        })
    }
}
/// 에이전트 사용을 켠 연결만 실행 경로에 들어온다. 화면이 무엇을 보여 줬든 판정은
/// 저장본으로 한다.
fn agent_connection(
    app_data_dir: &std::path::Path,
    id: &str,
) -> Result<DbConnectionView, CoreError> {
    let connection = connection_of(app_data_dir, id)?;
    if !connection.agent_enabled {
        return Err(CoreError::InvalidInput(format!(
            "{}은(는) 에이전트 사용이 꺼져 있습니다. 애드온 → 데이터베이스에서 켜 달라고 사용자에게 요청하세요",
            connection.display_name
        )));
    }
    Ok(connection)
}

/// 컬럼 이름이 마스킹 목록에 걸리는지. 대소문자를 가리지 않고 부분 일치로 본다.
fn mask_columns(connection: &DbConnectionView, columns: &[String]) -> Vec<String> {
    if connection.masked_columns.is_empty() {
        return Vec::new();
    }
    let patterns: Vec<String> = connection
        .masked_columns
        .iter()
        .map(|value| value.to_uppercase())
        .collect();
    columns
        .iter()
        .filter(|column| {
            let upper = column.to_uppercase();
            patterns.iter().any(|pattern| upper.contains(pattern))
        })
        .cloned()
        .collect()
}

/// 마스킹 대상 컬럼의 값을 표시로 바꾼다. 자리와 널 여부는 남긴다 — 값이 있었는지
/// 없었는지는 조회의 의미이고, 가리는 것은 내용이다.
fn apply_mask(
    mut rows: Vec<Vec<Option<String>>>,
    columns: &[String],
    masked: &[String],
) -> Vec<Vec<Option<String>>> {
    if masked.is_empty() {
        return rows;
    }
    let indexes: Vec<usize> = columns
        .iter()
        .enumerate()
        .filter(|(_, column)| masked.contains(column))
        .map(|(index, _)| index)
        .collect();
    for row in &mut rows {
        for index in &indexes {
            if let Some(value) = row.get_mut(*index) {
                if value.is_some() {
                    *value = Some(MASK.to_owned());
                }
            }
        }
    }
    rows
}

// ---------------------------------------------------------------------------
// 엔진
// ---------------------------------------------------------------------------

struct QueryOutcome {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
}

/// 세 엔진이 똑같이 지켜야 하는 결과 상한 — 행 수와 바이트 총량 중 먼저 닿는 쪽에서 읽기를
/// 끊고 잘렸다는 사실을 남긴다. 커서를 도는 모양은 엔진마다 다르고 값 변환도 제각각이라
/// 루프 자체는 합치지 못하지만, 상한을 세는 규칙만은 한곳에 둔다.
struct RowCollector {
    limit: usize,
    rows: Vec<Vec<Option<String>>>,
    bytes: usize,
    truncated: bool,
}

impl RowCollector {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            rows: Vec::new(),
            bytes: 0,
            truncated: false,
        }
    }

    /// 행 하나를 담아 본다. 행 수·바이트 상한 중 어느 쪽에 닿든 잘림을 표시하고 false를
    /// 돌려주므로, 호출부는 돌아온 값이 false면 커서를 끊으면 된다.
    ///
    /// 값 변환을 클로저로 미루는 이유는 행 수 상한 때문이다 — 이미 상한에 닿았으면 엔진이
    /// 돌려준 행을 문자열로 옮기는 일 자체를 하지 않는다. 세 엔진이 저마다 "더 담아도
    /// 되는지 묻고 → 변환하고 → 담고" 세 조각을 펼쳐 두던 자리다.
    fn offer(&mut self, values: impl FnOnce() -> Vec<Option<String>>) -> bool {
        if self.rows.len() >= self.limit {
            self.truncated = true;
            return false;
        }
        let values = values();
        self.bytes += values
            .iter()
            .map(|value| value.as_ref().map_or(4, String::len))
            .sum::<usize>();
        self.rows.push(values);
        if self.bytes >= MAX_RESULT_BYTES {
            self.truncated = true;
            return false;
        }
        true
    }

    fn finish(self, columns: Vec<String>) -> QueryOutcome {
        QueryOutcome {
            columns,
            rows: self.rows,
            truncated: self.truncated,
        }
    }
}

/// 원격이 돌려준 문구에서 자격증명처럼 보이는 것을 지운다. 오류 문구는 그대로 화면과
/// 대화에 남으므로, 접속 문자열이 통째로 실리는 일이 없어야 한다(G4).
fn scrub(message: &str) -> String {
    let mut cleaned = message
        .replace("password", "***")
        .replace("Password", "***");
    if cleaned.chars().count() > 400 {
        cleaned = cleaned.chars().take(400).collect::<String>() + "…";
    }
    cleaned
}

fn version_probe(connection: &DbConnectionView) -> Result<String, CoreError> {
    match connection.engine {
        DbEngineKind::Sqlite => {
            let handle = open_sqlite(connection, true)?;
            let version: String = handle
                .query_row("SELECT sqlite_version()", [], |row| row.get(0))
                .map_err(CoreError::Sqlite)?;
            Ok(format!("SQLite {version}"))
        }
        DbEngineKind::Postgres => {
            let mut client = open_postgres(connection)?;
            let rows = client
                .simple_query("SELECT version()")
                .map_err(postgres_error)?;
            Ok(first_simple_value(&rows).unwrap_or_else(|| "PostgreSQL".to_owned()))
        }
        _ => {
            let mut handle = open_mysql(connection)?;
            let version = mysql::prelude::Queryable::query_first::<String, _>(
                &mut handle,
                "SELECT VERSION()",
            )
            .map_err(mysql_error)?;
            Ok(version.unwrap_or_else(|| "MySQL".to_owned()))
        }
    }
}

fn query(
    connection: &DbConnectionView,
    sql: &str,
    limit: usize,
) -> Result<QueryOutcome, CoreError> {
    match connection.engine {
        DbEngineKind::Sqlite => query_sqlite(connection, sql, limit),
        DbEngineKind::Postgres => query_postgres(connection, sql, limit),
        _ => query_mysql(connection, sql, limit),
    }
}

/// 변경 문장을 트랜잭션 안에서 끝낼 때 어느 쪽으로 닫을지.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TxEnd {
    Commit,
    Rollback,
}

impl TxEnd {
    fn sql(self) -> &'static str {
        match self {
            TxEnd::Commit => "COMMIT",
            TxEnd::Rollback => "ROLLBACK",
        }
    }
}

/// 예행. 트랜잭션 안에서 실행해 영향 행 수를 세고 반드시 되돌린다.
fn preview_statement(connection: &DbConnectionView, parsed: &ParsedSql) -> Result<u64, CoreError> {
    execute_statement(connection, &parsed.normalized, Some(TxEnd::Rollback))
}

/// 승인을 받은 뒤의 본 실행. DML은 트랜잭션 안에서 돌고 커밋한다. DDL은 엔진이 암시적
/// 커밋을 하므로 트랜잭션을 열지 않는다 — 여는 척하면 되돌릴 수 있다는 오해만 남는다.
fn commit_statement(
    connection: &DbConnectionView,
    parsed: &ParsedSql,
    kind: DbApprovalKind,
) -> Result<u64, CoreError> {
    let end = match kind {
        DbApprovalKind::Dml => Some(TxEnd::Commit),
        DbApprovalKind::Ddl => None,
    };
    execute_statement(connection, &parsed.normalized, end)
}

/// 변경 문장 하나를 엔진에 맞는 연결로 실행한다. 트랜잭션을 어떻게 여닫는지는
/// [`in_optional_transaction`]이 정하고, 여기서는 엔진별 연결과 문장 실행 방법만 고른다.
fn execute_statement(
    connection: &DbConnectionView,
    sql: &str,
    end: Option<TxEnd>,
) -> Result<u64, CoreError> {
    match connection.engine {
        DbEngineKind::Sqlite => in_optional_transaction(
            &mut open_sqlite(connection, false)?,
            end,
            "BEGIN",
            |handle, statement| handle.execute_batch(statement),
            |handle| handle.execute(sql, []).map(|affected| affected as u64),
            CoreError::Sqlite,
        ),
        DbEngineKind::Postgres => in_optional_transaction(
            &mut open_postgres(connection)?,
            end,
            "BEGIN",
            |client, statement| client.batch_execute(statement),
            |client| client.execute(sql, &[]),
            postgres_error,
        ),
        _ => {
            use mysql::prelude::Queryable;
            in_optional_transaction(
                &mut open_mysql(connection)?,
                end,
                "START TRANSACTION",
                |handle, statement| handle.query_drop(statement),
                |handle| {
                    handle.query_drop(sql)?;
                    // 영향 행 수는 연결 상태라 트랜잭션을 닫기 전에 읽는다.
                    Ok(handle.affected_rows())
                },
                mysql_error,
            )
        }
    }
}

/// 변경 문장 하나를 감싸는 선택적 트랜잭션 봉투. `end`가 없으면 문장만 그대로 돌리고,
/// 있으면 열고 → 돌리고 → 성공한 쪽만 그 방향으로 닫는다. 실패했을 때의 되돌리기는
/// 최선 노력으로만 하고 실행 오류를 그대로 올린다 — 되돌리기 실패 문구가 원인을 가리면
/// 안 된다.
///
/// 세 엔진이 저마다 같은 모양을 펼쳐 두던 자리다. 엔진마다 다른 것은 "문장 하나를 돌리는
/// 법"·"본 문장을 돌리고 영향 행 수를 읽는 법"·"오류를 [`CoreError`]로 옮기는 법" 셋뿐이라
/// 그것만 인자로 받는다.
fn in_optional_transaction<H, E>(
    handle: &mut H,
    end: Option<TxEnd>,
    begin: &str,
    run: impl Fn(&mut H, &str) -> Result<(), E>,
    body: impl FnOnce(&mut H) -> Result<u64, E>,
    to_error: impl Fn(E) -> CoreError,
) -> Result<u64, CoreError> {
    if end.is_some() {
        run(handle, begin).map_err(&to_error)?;
    }
    match body(handle) {
        Ok(affected) => {
            if let Some(end) = end {
                run(handle, end.sql()).map_err(&to_error)?;
            }
            Ok(affected)
        }
        Err(error) => {
            if end.is_some() {
                let _ = run(handle, TxEnd::Rollback.sql());
            }
            Err(to_error(error))
        }
    }
}

// --- MySQL / MariaDB -------------------------------------------------------

fn mysql_error(error: mysql::Error) -> CoreError {
    CoreError::Runtime(scrub(&format!("MySQL 오류: {error}")))
}

fn open_mysql(connection: &DbConnectionView) -> Result<mysql::Conn, CoreError> {
    let secret = resolve_secret(connection)?;
    // MariaDB와 MySQL은 문장 제한 시간 변수 이름이 다르다. 한쪽 이름을 반대 엔진에
    // 보내면 접속 자체가 실패하므로, 등록된 엔진 그대로 고른다.
    let init = match connection.engine {
        DbEngineKind::Mariadb => format!(
            "SET SESSION max_statement_time={}",
            STATEMENT_TIMEOUT.as_secs()
        ),
        _ => format!(
            "SET SESSION max_execution_time={}",
            STATEMENT_TIMEOUT.as_millis()
        ),
    };
    let options = mysql::OptsBuilder::new()
        .ip_or_hostname(Some(connection.host.clone()))
        .tcp_port(connection.port)
        .user(Some(connection.user.clone()))
        .pass(secret.as_ref().map(|value| value.to_string()))
        .db_name(Some(connection.database.clone()))
        .tcp_connect_timeout(Some(CONNECT_TIMEOUT))
        .read_timeout(Some(STATEMENT_TIMEOUT + CONNECT_TIMEOUT))
        .write_timeout(Some(CONNECT_TIMEOUT))
        .init(vec![init]);
    mysql::Conn::new(options).map_err(mysql_error)
}

fn query_mysql(
    connection: &DbConnectionView,
    sql: &str,
    limit: usize,
) -> Result<QueryOutcome, CoreError> {
    use mysql::prelude::Queryable;
    let mut handle = open_mysql(connection)?;
    // C10-9. 읽기는 엔진 수준 읽기 전용 트랜잭션 안에서만 돈다. 지원하지 않는 옛 서버는
    // 평범한 트랜잭션으로 물러서되, 문장 검사가 읽기로 판정한 것만 여기 닿는다.
    if handle.query_drop("START TRANSACTION READ ONLY").is_err() {
        handle
            .query_drop("START TRANSACTION")
            .map_err(mysql_error)?;
    }
    let outcome = (|| -> Result<QueryOutcome, CoreError> {
        let mut result = handle.query_iter(sql).map_err(mysql_error)?;
        let columns: Vec<String> = result
            .columns()
            .as_ref()
            .iter()
            .map(|column| column.name_str().to_string())
            .collect();
        let mut collector = RowCollector::new(limit);
        for row in result.by_ref() {
            let row = row.map_err(mysql_error)?;
            if !collector.offer(|| {
                row.unwrap()
                    .into_iter()
                    .map(mysql_value_to_string)
                    .collect()
            }) {
                break;
            }
        }
        Ok(collector.finish(columns))
    })();
    let _ = handle.query_drop("ROLLBACK");
    outcome
}

fn mysql_value_to_string(value: mysql::Value) -> Option<String> {
    match value {
        mysql::Value::NULL => None,
        mysql::Value::Bytes(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        mysql::Value::Int(number) => Some(number.to_string()),
        mysql::Value::UInt(number) => Some(number.to_string()),
        mysql::Value::Float(number) => Some(number.to_string()),
        mysql::Value::Double(number) => Some(number.to_string()),
        mysql::Value::Date(year, month, day, hour, minute, second, micro) => Some(format!(
            "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{micro:06}"
        )),
        mysql::Value::Time(negative, days, hours, minutes, seconds, micro) => Some(format!(
            "{}{days}d {hours:02}:{minutes:02}:{seconds:02}.{micro:06}",
            if negative { "-" } else { "" }
        )),
    }
}

// --- PostgreSQL ------------------------------------------------------------

fn postgres_error(error: postgres::Error) -> CoreError {
    CoreError::Runtime(scrub(&format!("PostgreSQL 오류: {error}")))
}

fn open_postgres(connection: &DbConnectionView) -> Result<postgres::Client, CoreError> {
    let secret = resolve_secret(connection)?;
    let mut config = postgres::Config::new();
    config
        .host(&connection.host)
        .port(connection.port)
        .user(&connection.user)
        .dbname(&connection.database)
        .application_name("Agent Manager")
        .connect_timeout(CONNECT_TIMEOUT);
    if let Some(secret) = secret.as_ref() {
        config.password(secret.as_str());
    }
    let mut client = config.connect(postgres::NoTls).map_err(postgres_error)?;
    client
        .batch_execute(&format!(
            "SET statement_timeout = '{}s'",
            STATEMENT_TIMEOUT.as_secs()
        ))
        .map_err(postgres_error)?;
    Ok(client)
}

fn first_simple_value(messages: &[postgres::SimpleQueryMessage]) -> Option<String> {
    messages.iter().find_map(|message| match message {
        postgres::SimpleQueryMessage::Row(row) => row.get(0).map(str::to_owned),
        _ => None,
    })
}

fn query_postgres(
    connection: &DbConnectionView,
    sql: &str,
    limit: usize,
) -> Result<QueryOutcome, CoreError> {
    let mut client = open_postgres(connection)?;
    // C10-9. 읽기 전용 트랜잭션은 PostgreSQL이 직접 거부해 준다.
    client
        .batch_execute("BEGIN TRANSACTION READ ONLY")
        .map_err(postgres_error)?;
    let outcome = (|| -> Result<QueryOutcome, CoreError> {
        // simple_query는 모든 값을 텍스트로 돌려주므로 타입 변환표가 필요 없다.
        let messages = client.simple_query(sql).map_err(postgres_error)?;
        let mut columns: Vec<String> = Vec::new();
        let mut collector = RowCollector::new(limit);
        for message in messages {
            match message {
                postgres::SimpleQueryMessage::RowDescription(description) => {
                    columns = description
                        .iter()
                        .map(|column| column.name().to_owned())
                        .collect();
                }
                postgres::SimpleQueryMessage::Row(row) => {
                    if columns.is_empty() {
                        columns = row
                            .columns()
                            .iter()
                            .map(|column| column.name().to_owned())
                            .collect();
                    }
                    if !collector.offer(|| {
                        (0..columns.len())
                            .map(|index| row.get(index).map(str::to_owned))
                            .collect()
                    }) {
                        break;
                    }
                }
                postgres::SimpleQueryMessage::CommandComplete(_) => {}
                _ => {}
            }
        }
        Ok(collector.finish(columns))
    })();
    let _ = client.batch_execute("ROLLBACK");
    outcome
}

// --- SQLite ----------------------------------------------------------------

fn open_sqlite(
    connection: &DbConnectionView,
    read_only: bool,
) -> Result<rusqlite::Connection, CoreError> {
    use rusqlite::OpenFlags;
    // C10-9. SQLite에는 읽기 전용 트랜잭션이 없다. 대신 파일 자체를 읽기 전용으로 연다 —
    // 더 강한 보장이다.
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX
    };
    let handle = rusqlite::Connection::open_with_flags(&connection.database, flags)
        .map_err(CoreError::Sqlite)?;
    handle
        .busy_timeout(CONNECT_TIMEOUT)
        .map_err(CoreError::Sqlite)?;
    Ok(handle)
}

fn query_sqlite(
    connection: &DbConnectionView,
    sql: &str,
    limit: usize,
) -> Result<QueryOutcome, CoreError> {
    let handle = open_sqlite(connection, true)?;
    let mut statement = handle.prepare(sql).map_err(CoreError::Sqlite)?;
    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut collector = RowCollector::new(limit);
    let mut cursor = statement.query([]).map_err(CoreError::Sqlite)?;
    while let Some(row) = cursor.next().map_err(CoreError::Sqlite)? {
        if !collector.offer(|| {
            (0..columns.len())
                .map(|index| sqlite_value_to_string(row.get_ref(index).ok()))
                .collect()
        }) {
            break;
        }
    }
    Ok(collector.finish(columns))
}

fn sqlite_value_to_string(value: Option<rusqlite::types::ValueRef<'_>>) -> Option<String> {
    match value? {
        rusqlite::types::ValueRef::Null => None,
        rusqlite::types::ValueRef::Integer(number) => Some(number.to_string()),
        rusqlite::types::ValueRef::Real(number) => Some(number.to_string()),
        rusqlite::types::ValueRef::Text(text) => Some(String::from_utf8_lossy(text).into_owned()),
        rusqlite::types::ValueRef::Blob(bytes) => Some(format!("<{} bytes>", bytes.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_connections::{
        set_db_connection, set_db_connection_enabled, SetDbConnectionEnabledRequest,
        SetDbConnectionRequest,
    };
    use tempfile::TempDir;

    /// SQLite는 설치 없이 도는 엔진이라 실행 경로 전체를 실제로 확인할 수 있다.
    fn fixture() -> (TempDir, String) {
        let dir = TempDir::new().expect("temp");
        let file = dir.path().join("fixture.sqlite3");
        let handle = rusqlite::Connection::open(&file).expect("open");
        handle
            .execute_batch(
                "CREATE TABLE tb_member (id INTEGER PRIMARY KEY, name TEXT, password TEXT);
                 INSERT INTO tb_member (name, password) VALUES ('가', 'p1'), ('나', 'p2');",
            )
            .expect("seed");
        let snapshot = set_db_connection(
            dir.path(),
            SetDbConnectionRequest {
                id: String::new(),
                display_name: "fixture".to_owned(),
                engine: "sqlite".to_owned(),
                environment: "local".to_owned(),
                host: String::new(),
                port: None,
                user: String::new(),
                database: file.to_string_lossy().into_owned(),
                credential_source: "none".to_owned(),
                credential_ref: String::new(),
                secret: None,
                agent_enabled: false,
                write_mode: "dmlWithApproval".to_owned(),
                schema_scope: Vec::new(),
                masked_columns: vec!["PASSWORD".to_owned()],
                max_rows: None,
                note: String::new(),
            },
        )
        .expect("save");
        let id = snapshot.connections[0].id.clone();
        set_db_connection_enabled(
            dir.path(),
            SetDbConnectionEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .expect("enable");
        (dir, id)
    }

    #[test]
    fn c10_9_a_read_returns_rows_and_marks_masked_columns() {
        let (dir, id) = fixture();
        let receipt = run_db_query(
            dir.path(),
            DbQueryRequest {
                connection_id: id,
                sql: "SELECT name, password FROM tb_member ORDER BY id".to_owned(),
                max_rows: None,
            },
        )
        .expect("query");
        assert_eq!(receipt.columns, vec!["name", "password"]);
        assert_eq!(receipt.row_count, 2);
        assert_eq!(receipt.masked_columns, vec!["password"]);
        assert!(!receipt.truncated);
    }

    #[test]
    fn c10_9_the_row_limit_truncates_instead_of_flooding() {
        let (dir, id) = fixture();
        let receipt = run_db_query(
            dir.path(),
            DbQueryRequest {
                connection_id: id,
                sql: "SELECT * FROM tb_member".to_owned(),
                max_rows: Some(1),
            },
        )
        .expect("query");
        assert_eq!(receipt.row_count, 1);
        assert!(receipt.truncated);
    }

    #[test]
    fn c10_12_a_write_without_a_gate_is_refused_and_changes_nothing() {
        let (dir, id) = fixture();
        let error = run_db_statement(
            dir.path(),
            DbStatementRequest {
                connection_id: id.clone(),
                sql: "UPDATE tb_member SET name = '다'".to_owned(),
                approval_id: None,
            },
            None,
        )
        .expect_err("no gate");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let receipt = run_db_query(
            dir.path(),
            DbQueryRequest {
                connection_id: id,
                sql: "SELECT name FROM tb_member WHERE name = '다'".to_owned(),
                max_rows: None,
            },
        )
        .expect("query");
        assert_eq!(receipt.row_count, 0);
    }

    #[test]
    fn c10_9_a_write_cannot_be_run_through_the_query_path() {
        let (dir, id) = fixture();
        let error = run_db_query(
            dir.path(),
            DbQueryRequest {
                connection_id: id,
                sql: "UPDATE tb_member SET name = '다'".to_owned(),
                max_rows: None,
            },
        )
        .expect_err("write");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn c10_13_a_disabled_connection_is_not_reachable_from_the_agent_path() {
        let (dir, id) = fixture();
        set_db_connection_enabled(
            dir.path(),
            SetDbConnectionEnabledRequest {
                id: id.clone(),
                enabled: false,
            },
        )
        .expect("disable");
        let error = run_db_query(
            dir.path(),
            DbQueryRequest {
                connection_id: id,
                sql: "SELECT 1".to_owned(),
                max_rows: None,
            },
        )
        .expect_err("disabled");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
}
