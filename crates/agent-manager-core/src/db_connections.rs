//! C10-1~C10-6: 데이터베이스 연결 등록·자격증명·에이전트 공개 목록.
//!
//! # 왜 앱이 연결을 소유하는가
//!
//! SSH 엔드포인트(C9-9)는 `~/.ssh`에 이미 있는 키의 지문에 매달린 메타데이터였다. 데이터
//! 베이스에는 그런 사용자 소유 인벤토리가 없으므로 연결 레코드 자체가 1급 객체가 되고,
//! 앱 데이터에만 저장한다(G7). 사용자의 `~/.my.cnf`·`~/.pgpass` 같은 클라이언트 설정은
//! **고쳐 쓰지 않는다** — 그 파일들은 사용자와 다른 도구가 함께 쓰는 사용자 소유 설정이고,
//! 여기서 필요한 것은 "이 연결을 에이전트에게 열어 줄 것인가"라는 앱 쪽 결정뿐이다.
//!
//! # 비밀값
//!
//! 드라이버는 실제 비밀번호를 필요로 하므로 "앱이 비밀을 보지 않는다"는 SSH(G4, 개인키
//! 경로만 넘김)와 같은 방식으로는 성립하지 않는다. 대신 **저장하지 않는다**를 지킨다.
//!
//! - [`DbCredentialSource::AppKeychain`]: OS 보안 저장소에만 둔다. 앱 데이터 JSON에는
//!   저장 시각만 남고 값은 어느 응답·로그·영수증에도 실리지 않는다.
//! - [`DbCredentialSource::ClientFile`]: 사용자의 `~/.mylogin.cnf`·`~/.pgpass`를 접속할
//!   때마다 **읽기 전용으로** 열어 메모리에서만 쓴다(G1). 앱 안에 사본을 만들지 않는다.
//! - [`DbCredentialSource::None`]: SQLite 파일이나 소켓 신뢰 접속.
//!
//! 어느 경로든 값은 [`Zeroizing`]으로 감싸 함수 밖으로 나가지 않는다.

use std::path::Path;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::clock::now_ms;
use crate::db_credential_files::{
    client_credential_path, read_mylogin_password, read_pgpass_password,
};
use crate::domain::wire_enum;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::CoreError;

const STORE_VERSION: u32 = 1;
/// 연결 정보도 기기 단위 메타데이터라 앱 데이터에만 둔다(G7).
const STORE: JsonStore = JsonStore {
    file: "db-connections-v1.json",
    lock_file: "db-connections-v1.lock",
    label: "데이터베이스 연결 저장소",
    version: STORE_VERSION,
};

/// 비밀번호를 두는 OS 보안 저장소의 서비스명. 계정 볼트·외부 플러그인과 같은 헬퍼를
/// 쓰되 이름공간은 나눈다.
pub(crate) const DB_KEYCHAIN_SERVICE: &str = "Agent Manager Databases";

const MAX_CONNECTIONS: usize = 64;
const MAX_NAME_CHARS: usize = 60;
const MAX_HOST_CHARS: usize = 253;
const MAX_USER_CHARS: usize = 64;
const MAX_DATABASE_CHARS: usize = 128;
const MAX_SECRET_CHARS: usize = 512;
const MAX_SCOPE_ENTRIES: usize = 64;
const MAX_SCOPE_CHARS: usize = 120;
const MAX_MASKED_COLUMNS: usize = 64;
const MAX_PATH_CHARS: usize = 400;
/// 한 번에 돌려주는 행 수의 기본값과 천장. 대화 맥락을 태우지 않는 선이다.
pub(crate) const DEFAULT_MAX_ROWS: u32 = 200;
pub(crate) const MAX_MAX_ROWS: u32 = 5_000;

/// 이 도구가 붙을 수 있는 엔진. 모두 순수 Rust 드라이버가 앱에 정적으로 들어 있어
/// 사용자 기기에 클라이언트를 설치하지 않는다(C10-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbEngineKind {
    Mysql,
    Mariadb,
    Postgres,
    Sqlite,
}

wire_enum!(choices DbEngineKind, "알 수 없는 데이터베이스 엔진입니다", {
    Mysql => "mysql",
    Mariadb => "mariadb",
    Postgres => "postgres" | "postgresql",
    Sqlite => "sqlite",
});

impl DbEngineKind {
    /// MySQL과 MariaDB는 같은 와이어 프로토콜이라 드라이버가 하나다. 표시는 나눈다 —
    /// 사용자가 등록한 것이 무엇인지 화면에서 그대로 보여야 한다.
    pub(crate) fn uses_mysql_driver(self) -> bool {
        matches!(self, Self::Mysql | Self::Mariadb)
    }

    /// 파일 기반이라 호스트·포트·사용자가 없는 엔진인지.
    pub(crate) fn is_file_based(self) -> bool {
        matches!(self, Self::Sqlite)
    }

    pub(crate) fn default_port(self) -> u16 {
        match self {
            Self::Mysql | Self::Mariadb => 3306,
            Self::Postgres => 5432,
            Self::Sqlite => 0,
        }
    }
}

/// 비밀번호가 어디에 있는지. 앱이 보관하는지 사용자 파일을 그때그때 읽는지를 가른다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbCredentialSource {
    /// 앱이 OS 보안 저장소에 보관한다.
    AppKeychain,
    /// 사용자의 클라이언트 자격증명 파일을 접속할 때마다 읽는다(`~/.mylogin.cnf`의
    /// 로그인 경로, `~/.pgpass`).
    ClientFile,
    /// 비밀번호가 없는 접속(SQLite 파일, 소켓 신뢰).
    None,
}

wire_enum!(choices DbCredentialSource, "알 수 없는 자격증명 출처입니다", {
    AppKeychain => "appKeychain" | "app_keychain",
    ClientFile => "clientFile" | "client_file",
    None => "none",
});

/// 이 연결에서 에이전트가 어디까지 할 수 있는지. 쓰기는 어느 단계에서도 사용자 승인을
/// 거치며(C10-12), 이 값은 "승인을 받을 수라도 있는가"를 정한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbWriteMode {
    /// 읽기만. 기본값이다.
    ReadOnly,
    /// INSERT·UPDATE·DELETE를 승인받아 실행할 수 있다.
    DmlWithApproval,
    /// DML에 더해 CREATE·ALTER를 승인받아 실행할 수 있다.
    DdlWithApproval,
}

wire_enum!(choices DbWriteMode, "알 수 없는 쓰기 모드입니다", {
    ReadOnly => "readOnly" | "read_only",
    DmlWithApproval => "dmlWithApproval" | "dml_with_approval",
    DdlWithApproval => "ddlWithApproval" | "ddl_with_approval",
});

impl DbWriteMode {
    pub(crate) fn allows_dml(self) -> bool {
        matches!(self, Self::DmlWithApproval | Self::DdlWithApproval)
    }

    pub(crate) fn allows_ddl(self) -> bool {
        matches!(self, Self::DdlWithApproval)
    }
}

/// 이 연결이 어떤 환경인지. 표시용 라벨이 아니라 **집행되는 값**이다 — 운영으로 표시된
/// 연결은 쓰기 모드를 올릴 수 없다(C10-11).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbEnvironment {
    Local,
    Dev,
    Staging,
    Production,
}

wire_enum!(choices DbEnvironment, "알 수 없는 환경 구분입니다", {
    Local => "local",
    Dev => "dev",
    Staging => "staging",
    Production => "production",
});

impl DbEnvironment {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Local => "로컬",
            Self::Dev => "개발",
            Self::Staging => "스테이징",
            Self::Production => "운영",
        }
    }

    pub(crate) fn is_production(self) -> bool {
        matches!(self, Self::Production)
    }
}

/// 연결 하나. 저장본과 화면 표시가 같은 모양이라 한 타입을 함께 쓴다. 비밀값은 어느
/// 필드에도 없다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionView {
    pub id: String,
    pub display_name: String,
    pub engine: DbEngineKind,
    pub environment: DbEnvironment,
    /// 파일 기반 엔진에서는 비어 있다.
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// 접속할 스키마. SQLite에서는 파일 경로다.
    #[serde(default)]
    pub database: String,
    pub credential_source: DbCredentialSource,
    /// 클라이언트 파일 참조 이름(`~/.mylogin.cnf`의 로그인 경로 이름). 비밀값이 아니다.
    #[serde(default)]
    pub credential_ref: String,
    /// 앱 보관 비밀번호를 저장한 시각. 값 자체는 OS 보안 저장소에만 있다.
    #[serde(default)]
    pub credential_stored_at: Option<i64>,
    /// 에이전트에게 이 연결을 열어 줄지. 꺼져 있으면 어떤 에이전트 경로에도 나오지 않는다.
    #[serde(default)]
    pub agent_enabled: bool,
    pub write_mode: DbWriteMode,
    /// 에이전트가 닿을 수 있는 스키마·테이블 접두사. 비어 있으면 제한하지 않는다.
    #[serde(default)]
    pub schema_scope: Vec<String>,
    /// 결과에서 가릴 컬럼 이름. 대소문자를 가리지 않고 부분 일치로 본다.
    #[serde(default)]
    pub masked_columns: Vec<String>,
    #[serde(default)]
    pub max_rows: u32,
    #[serde(default)]
    pub note: String,
    pub updated_at: i64,
}

impl DbConnectionView {
    /// 사용자와 에이전트가 함께 읽는 대상 표기. 비밀값은 들어가지 않는다.
    pub(crate) fn destination(&self) -> String {
        if self.engine.is_file_based() {
            return format!("{} ({})", self.database, self.engine.as_str());
        }
        let user = if self.user.is_empty() {
            String::new()
        } else {
            format!("{}@", self.user)
        };
        format!("{user}{}:{}/{}", self.host, self.port, self.database)
    }

    pub(crate) fn effective_max_rows(&self) -> u32 {
        match self.max_rows {
            0 => DEFAULT_MAX_ROWS,
            value => value.min(MAX_MAX_ROWS),
        }
    }
}

/// 화면이 읽는 목록. 읽기 실패는 목록 전체를 막지 않고 이유로 실린다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionsSnapshot {
    pub schema_version: u32,
    pub connections: Vec<DbConnectionView>,
    pub issues: Vec<String>,
    /// 화면이 새 연결에 미리 채워 넣는 기본값을 백엔드가 소유한다.
    pub defaults: DbConnectionDefaults,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionDefaults {
    pub engines: Vec<String>,
    pub environments: Vec<String>,
    pub write_modes: Vec<String>,
    pub credential_sources: Vec<String>,
    pub max_rows: u32,
    pub max_rows_ceiling: u32,
    pub masked_columns: Vec<String>,
}

/// 새 연결이 시작하는 마스킹 목록. 개인정보가 조회 결과로 흘러나가는 흔한 자리를
/// 미리 막아 두고, 필요 없으면 사용자가 지운다.
const DEFAULT_MASKED_COLUMNS: &[&str] = &[
    "PASSWORD",
    "PASSWD",
    "PWD",
    "RESID",
    "JUMIN",
    "SSN",
    "ACCT_NO",
    "ACCOUNT_NO",
    "CARD_NO",
    "SECRET",
    "TOKEN",
];

/// 화면 선택지 한 칸. 목록의 출처는 다르지만 나가는 모양은 같은 문자열 배열이라,
/// 네 개의 enum과 마스킹 기본값이 저마다 펼쳐 두던 소유권 복사를 한 줄로 모은다.
fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

/// 새 연결 폼이 미리 채우는 값. 고를 수 있는 값 네 벌은 각 enum의 와이어 표
/// (`WIRE_CHOICES`)에서 그대로 나온다 — 여기에 변이를 손으로 다시 적으면 값을 하나
/// 늘렸을 때 해석은 받아 주는데 화면에는 뜨지 않는 어긋남이 조용히 생긴다.
pub fn connection_defaults() -> DbConnectionDefaults {
    DbConnectionDefaults {
        engines: owned(DbEngineKind::WIRE_CHOICES),
        environments: owned(DbEnvironment::WIRE_CHOICES),
        write_modes: owned(DbWriteMode::WIRE_CHOICES),
        credential_sources: owned(DbCredentialSource::WIRE_CHOICES),
        max_rows: DEFAULT_MAX_ROWS,
        max_rows_ceiling: MAX_MAX_ROWS,
        masked_columns: owned(DEFAULT_MASKED_COLUMNS),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDbConnectionRequest {
    /// 비어 있으면 새 연결을 만든다.
    #[serde(default)]
    pub id: String,
    pub display_name: String,
    pub engine: String,
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub credential_source: String,
    #[serde(default)]
    pub credential_ref: String,
    /// 앱 보관 비밀번호. 저장 뒤에는 어떤 응답에도 나가지 않는다.
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub agent_enabled: bool,
    #[serde(default)]
    pub write_mode: String,
    #[serde(default)]
    pub schema_scope: Vec<String>,
    #[serde(default)]
    pub masked_columns: Vec<String>,
    #[serde(default)]
    pub max_rows: Option<u32>,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionRef {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDbConnectionEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

/// 연결 확인 영수증. 원격에서 아무것도 바꾸지 않았고 비밀값은 어느 필드에도 없다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionCheckReceipt {
    pub id: String,
    pub destination: String,
    pub reachable: bool,
    pub server_version: String,
    pub message: String,
}

/// 에이전트가 읽는 목록의 한 줄. 접속 방법이 아니라 **무엇이 열려 있고 어디까지
/// 허용되는지**를 싣는다 — 실행은 언제나 앱을 거친다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDbConnectionView {
    pub id: String,
    pub display_name: String,
    pub engine: DbEngineKind,
    pub environment: DbEnvironment,
    pub destination: String,
    pub database: String,
    pub write_mode: DbWriteMode,
    pub schema_scope: Vec<String>,
    pub masked_columns: Vec<String>,
    pub max_rows: u32,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDbConnectionSkip {
    pub id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDbConnectionsView {
    pub schema_version: u32,
    pub connections: Vec<AgentDbConnectionView>,
    pub skipped: Vec<AgentDbConnectionSkip>,
    pub issues: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbConnectionStore {
    schema_version: u32,
    #[serde(default)]
    connections: Vec<DbConnectionView>,
}

impl Default for DbConnectionStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            connections: Vec::new(),
        }
    }
}

impl SchemaVersioned for DbConnectionStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

fn snapshot_from(store: DbConnectionStore, issues: Vec<String>) -> DbConnectionsSnapshot {
    let mut connections = store.connections;
    connections.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    DbConnectionsSnapshot {
        schema_version: STORE_VERSION,
        connections,
        issues,
        defaults: connection_defaults(),
    }
}

/// 저장본에서 연결을 찾지 못한 모든 경로가 같은 오류 종류와 문구를 쓰게 한다.
/// 조회·수정·활성화·삭제가 각자 문구를 조립하면 한 경로만 달라져도 호출자가 같은
/// 실패를 서로 다른 오류로 보게 된다.
fn connection_not_found(id: &str) -> CoreError {
    CoreError::NotFound(format!("등록되지 않은 데이터베이스 연결입니다: {id}"))
}

pub fn get_db_connections(app_data_dir: &Path) -> Result<DbConnectionsSnapshot, CoreError> {
    let store: DbConnectionStore = STORE.read(app_data_dir)?;
    Ok(snapshot_from(store, Vec::new()))
}

/// 저장된 연결 하나를 그대로 읽는다. 실행 경로가 정책을 다시 읽는 지점이다 — 화면이
/// 보여 준 값이 아니라 저장본이 판정의 근거다.
pub(crate) fn connection_of(app_data_dir: &Path, id: &str) -> Result<DbConnectionView, CoreError> {
    let store: DbConnectionStore = STORE.read(app_data_dir)?;
    store
        .connections
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| connection_not_found(id))
}

/// 저장 요청에서 검사를 마친 연결 필드 한 벌. 새 등록과 수정이 같은 값을 쓰도록 모은다.
struct ValidatedConnection {
    display_name: String,
    engine: DbEngineKind,
    environment: DbEnvironment,
    host: String,
    port: u16,
    user: String,
    database: String,
    credential_source: DbCredentialSource,
    credential_ref: String,
    write_mode: DbWriteMode,
    schema_scope: Vec<String>,
    masked_columns: Vec<String>,
    max_rows: u32,
    note: String,
    /// 앱 보관을 고른 요청에만 실린다. 값은 OS 보안 저장소로만 나간다.
    secret: Option<String>,
}

impl ValidatedConnection {
    /// 검사한 값으로 연결 레코드 한 벌을 만든다. 수정 경로는 구조체 갱신 문법으로
    /// 보존할 칸(보관 시각·에이전트 공개)만 덮어쓰므로 필드 목록은 여기 한 곳에만 있다.
    fn new_view(&self, id: String, now: i64) -> DbConnectionView {
        DbConnectionView {
            id,
            display_name: self.display_name.clone(),
            engine: self.engine,
            environment: self.environment,
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            database: self.database.clone(),
            credential_source: self.credential_source,
            credential_ref: self.credential_ref.clone(),
            credential_stored_at: None,
            agent_enabled: false,
            write_mode: self.write_mode,
            schema_scope: self.schema_scope.clone(),
            masked_columns: self.masked_columns.clone(),
            max_rows: self.max_rows,
            note: self.note.clone(),
            updated_at: now,
        }
    }
}

/// 비어 있는 칸은 기본값으로 두고, 값이 들어왔을 때만 해석한다. 요청의 열거형 칸마다
/// 같은 모양으로 펼쳐 두던 "비었으면 기본값, 아니면 parse" 갈래를 한 벌로 모은 것이다.
fn parse_or_default<T>(value: &str, default: T) -> Result<T, CoreError>
where
    T: std::str::FromStr<Err = CoreError>,
{
    if value.trim().is_empty() {
        Ok(default)
    } else {
        value.parse()
    }
}

/// 요청의 열거형 네 칸을 해석하고, 칸 하나만 봐서는 판단할 수 없는 환경·쓰기 모드 조합을
/// 막는다.
fn parse_connection_modes(
    request: &SetDbConnectionRequest,
) -> Result<(DbEngineKind, DbEnvironment, DbCredentialSource, DbWriteMode), CoreError> {
    let engine: DbEngineKind = request.engine.parse()?;
    let environment = parse_or_default(&request.environment, DbEnvironment::Dev)?;
    let credential_source = parse_or_default(&request.credential_source, DbCredentialSource::None)?;
    let write_mode = parse_or_default(&request.write_mode, DbWriteMode::ReadOnly)?;
    // C10-11. 운영 연결은 쓰기 모드를 올릴 수 없다. 화면에서 고르지 못하게 하는 것과
    // 별개로, 저장 경로에서도 막아야 다른 호출자가 우회하지 못한다.
    if environment.is_production() && write_mode != DbWriteMode::ReadOnly {
        return Err(CoreError::InvalidInput(
            "운영으로 표시한 연결에는 쓰기 모드를 설정할 수 없습니다. 환경 구분을 바꾸거나 읽기 전용으로 두세요".to_owned(),
        ));
    }
    Ok((engine, environment, credential_source, write_mode))
}

/// 접속 주소 세 칸을 확인한다. 파일 기반 엔진은 주소로 열지 않으므로 빈 값으로 둔다.
fn validate_connection_endpoint(
    engine: DbEngineKind,
    request: &SetDbConnectionRequest,
) -> Result<(String, u16, String), CoreError> {
    if engine.is_file_based() {
        return Ok((String::new(), 0, String::new()));
    }
    let host = validate_argument(&request.host, "호스트", MAX_HOST_CHARS)?;
    let port = request.port.unwrap_or_else(|| engine.default_port());
    let user = validate_argument(&request.user, "사용자", MAX_USER_CHARS)?;
    if port == 0 {
        return Err(CoreError::InvalidInput(
            "포트는 1 이상이어야 합니다".to_owned(),
        ));
    }
    Ok((host, port, user))
}

/// 자격증명 출처가 엔진과 맞는지 보고 참조 문자열을 확인한다.
fn validate_connection_credential(
    engine: DbEngineKind,
    credential_source: DbCredentialSource,
    request: &SetDbConnectionRequest,
) -> Result<String, CoreError> {
    // QA #71. 파일 엔진은 자격증명을 받지 않는다. 받아 두면 화면이 PostgreSQL용 안내를
    // 세우고, 켠 뒤에는 있지도 않은 `~/.pgpass`를 찾다 '사용 불가'로 막힌다.
    if engine.is_file_based() && credential_source != DbCredentialSource::None {
        return Err(CoreError::InvalidInput(
            "파일 기반 엔진은 자격증명을 쓰지 않습니다. 자격증명 출처를 '없음'으로 두세요"
                .to_owned(),
        ));
    }
    let credential_ref = validate_text(&request.credential_ref, "자격증명 참조", 120, true)?;
    if credential_source == DbCredentialSource::ClientFile
        && engine.uses_mysql_driver()
        && credential_ref.is_empty()
    {
        return Err(CoreError::InvalidInput(
            "MySQL 계열의 클라이언트 파일 참조는 ~/.mylogin.cnf의 로그인 경로 이름이 필요합니다"
                .to_owned(),
        ));
    }
    Ok(credential_ref)
}

/// 비밀번호는 앱 보관을 고른 요청에서만 받는다. 여기서는 길이만 확인해 그대로 넘기고,
/// 값은 보안 저장소로 나가기 전까지 다른 곳에 남지 않는다.
fn validate_connection_secret(
    credential_source: DbCredentialSource,
    request: &SetDbConnectionRequest,
) -> Result<Option<String>, CoreError> {
    let secret = request
        .secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_secret)
        .transpose()?;
    if secret.is_some() && credential_source != DbCredentialSource::AppKeychain {
        return Err(CoreError::InvalidInput(
            "앱 보관을 고르지 않은 연결에는 비밀번호를 저장하지 않습니다".to_owned(),
        ));
    }
    Ok(secret)
}

/// 저장 요청의 파싱·기본값 채우기·조합 검사를 모두 끝낸다. 저장소 잠금 안에서는 더
/// 검사하지 않으므로, 잠금을 쥔 구간은 파일 쓰기만 남는다.
///
/// 확인 순서는 화면에 뜨는 오류 문구를 결정하므로, 아래 도우미를 부르는 차례가 곧 계약이다.
fn validate_connection_request(
    request: &SetDbConnectionRequest,
) -> Result<ValidatedConnection, CoreError> {
    let (engine, environment, credential_source, write_mode) = parse_connection_modes(request)?;
    let display_name = validate_text(&request.display_name, "연결 이름", MAX_NAME_CHARS, false)?;
    let note = validate_text(&request.note, "메모", 200, true)?;
    let database = validate_database(engine, &request.database)?;
    let (host, port, user) = validate_connection_endpoint(engine, request)?;
    let credential_ref = validate_connection_credential(engine, credential_source, request)?;
    let schema_scope = validate_list(
        &request.schema_scope,
        "스키마 범위",
        MAX_SCOPE_ENTRIES,
        MAX_SCOPE_CHARS,
    )?;
    let masked_columns = validate_list(
        &request.masked_columns,
        "마스킹 컬럼",
        MAX_MASKED_COLUMNS,
        MAX_SCOPE_CHARS,
    )?;
    let max_rows = match request.max_rows {
        None | Some(0) => DEFAULT_MAX_ROWS,
        Some(value) => value.min(MAX_MAX_ROWS),
    };
    let secret = validate_connection_secret(credential_source, request)?;

    Ok(ValidatedConnection {
        display_name,
        engine,
        environment,
        host,
        port,
        user,
        database,
        credential_source,
        credential_ref,
        write_mode,
        schema_scope,
        masked_columns,
        max_rows,
        note,
        secret,
    })
}

pub fn set_db_connection(
    app_data_dir: &Path,
    request: SetDbConnectionRequest,
) -> Result<DbConnectionsSnapshot, CoreError> {
    let validated = validate_connection_request(&request)?;

    let store = STORE.update(app_data_dir, |store: &mut DbConnectionStore| {
        let now = now_ms();
        let id = if request.id.trim().is_empty() {
            let id = next_id(store, &validated.display_name);
            if store.connections.len() >= MAX_CONNECTIONS {
                return Err(CoreError::InvalidInput(format!(
                    "데이터베이스 연결은 최대 {MAX_CONNECTIONS}개까지 등록할 수 있습니다"
                )));
            }
            store.connections.push(validated.new_view(id.clone(), now));
            id
        } else {
            let id = request.id.trim().to_owned();
            let existing = store
                .connections
                .iter_mut()
                .find(|connection| connection.id == id)
                .ok_or_else(|| connection_not_found(&id))?;
            // 출처를 앱 보관 밖으로 옮기면 보관하던 비밀값을 남겨 두지 않는다.
            let credential_stored_at = if existing.credential_source
                == DbCredentialSource::AppKeychain
                && validated.credential_source != DbCredentialSource::AppKeychain
            {
                crate::accounts::delete_os_keychain_password(DB_KEYCHAIN_SERVICE, &id)?;
                None
            } else {
                existing.credential_stored_at
            };
            *existing = DbConnectionView {
                credential_stored_at,
                agent_enabled: request.agent_enabled,
                ..validated.new_view(id.clone(), now)
            };
            id
        };
        if let Some(secret) = validated.secret.as_ref() {
            crate::accounts::write_os_keychain_password(DB_KEYCHAIN_SERVICE, &id, secret)?;
            if let Some(connection) = store
                .connections
                .iter_mut()
                .find(|connection| connection.id == id)
            {
                connection.credential_stored_at = Some(now);
            }
        }
        Ok(true)
    })?;
    Ok(snapshot_from(store, Vec::new()))
}

pub fn set_db_connection_enabled(
    app_data_dir: &Path,
    request: SetDbConnectionEnabledRequest,
) -> Result<DbConnectionsSnapshot, CoreError> {
    let store = STORE.update(app_data_dir, |store: &mut DbConnectionStore| {
        let connection = store
            .connections
            .iter_mut()
            .find(|connection| connection.id == request.id)
            .ok_or_else(|| connection_not_found(&request.id))?;
        if request.enabled && connection.credential_source == DbCredentialSource::AppKeychain {
            // 저장된 비밀값 없이 켜 두면 목록에는 열려 있는데 접속만 실패한다.
            if connection.credential_stored_at.is_none() {
                return Err(CoreError::InvalidInput(
                    "앱 보관 자격증명이 아직 저장되지 않았습니다. 비밀번호를 먼저 저장하세요"
                        .to_owned(),
                ));
            }
        }
        connection.agent_enabled = request.enabled;
        connection.updated_at = now_ms();
        Ok(true)
    })?;
    Ok(snapshot_from(store, Vec::new()))
}

pub fn remove_db_connection(
    app_data_dir: &Path,
    request: DbConnectionRef,
) -> Result<DbConnectionsSnapshot, CoreError> {
    let store = STORE.update(app_data_dir, |store: &mut DbConnectionStore| {
        let before = store.connections.len();
        store
            .connections
            .retain(|connection| connection.id != request.id);
        if store.connections.len() == before {
            return Err(connection_not_found(&request.id));
        }
        // 연결이 사라지면 그 연결에 묶인 비밀값도 남기지 않는다.
        crate::accounts::delete_os_keychain_password(DB_KEYCHAIN_SERVICE, &request.id)?;
        Ok(true)
    })?;
    Ok(snapshot_from(store, Vec::new()))
}

/// 에이전트 사용을 켠 연결만 담은 목록. 접속 자격증명은 어느 필드에도 없다(C10-7).
pub fn list_agent_db_connections(app_data_dir: &Path) -> Result<AgentDbConnectionsView, CoreError> {
    let store: DbConnectionStore = STORE.read(app_data_dir)?;
    let mut connections = Vec::new();
    let mut skipped = Vec::new();
    for connection in store.connections {
        if !connection.agent_enabled {
            continue;
        }
        if let Err(reason) = usable(&connection) {
            skipped.push(AgentDbConnectionSkip {
                id: connection.id,
                reason,
            });
            continue;
        }
        connections.push(AgentDbConnectionView {
            destination: connection.destination(),
            max_rows: connection.effective_max_rows(),
            id: connection.id,
            display_name: connection.display_name,
            engine: connection.engine,
            environment: connection.environment,
            database: connection.database,
            write_mode: connection.write_mode,
            schema_scope: connection.schema_scope,
            masked_columns: connection.masked_columns,
            note: connection.note,
        });
    }
    Ok(AgentDbConnectionsView {
        schema_version: STORE_VERSION,
        connections,
        skipped,
        issues: Vec::new(),
    })
}

/// 켜 두었지만 지금 쓸 수 없는 이유. 조용히 빼지 않고 사용자에게 그대로 전한다.
fn usable(connection: &DbConnectionView) -> Result<(), String> {
    // QA #71. 파일 엔진은 자격증명 자체가 없다. 자격증명 출처가 무엇으로 저장돼 있든
    // 접속은 파일 경로만 쓰므로, 여기서 `~/.pgpass`가 없다는 이유로 막으면 멀쩡한
    // SQLite 연결이 '사용 불가'가 된다.
    if connection.engine.is_file_based() {
        return Ok(());
    }
    match connection.credential_source {
        DbCredentialSource::AppKeychain if connection.credential_stored_at.is_none() => {
            Err("앱 보관 비밀번호가 저장되지 않았습니다".to_owned())
        }
        DbCredentialSource::ClientFile => {
            let path = client_credential_path(connection);
            if path.as_ref().is_some_and(|path| path.is_file()) {
                Ok(())
            } else {
                Err(format!(
                    "클라이언트 자격증명 파일을 찾지 못했습니다: {}",
                    path.map(|path| path.display().to_string())
                        .unwrap_or_else(|| "홈 디렉터리를 확인할 수 없음".to_owned())
                ))
            }
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// 자격증명 해석
// ---------------------------------------------------------------------------

/// 접속 직전에만 부른다. 값은 [`Zeroizing`]으로 감싸 돌려주고 저장하지 않는다(C10-5).
pub(crate) fn resolve_secret(
    connection: &DbConnectionView,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    // 파일 엔진은 비밀번호를 받지 않는다 — 접속은 파일 경로와 파일 권한이 전부다.
    if connection.engine.is_file_based() {
        return Ok(None);
    }
    match connection.credential_source {
        DbCredentialSource::None => Ok(None),
        DbCredentialSource::AppKeychain => {
            crate::accounts::read_os_keychain_password(DB_KEYCHAIN_SERVICE, &connection.id)
        }
        DbCredentialSource::ClientFile => {
            let path = client_credential_path(connection)
                .ok_or_else(|| CoreError::Runtime("홈 디렉터리를 확인할 수 없습니다".to_owned()))?;
            if connection.engine.uses_mysql_driver() {
                read_mylogin_password(&path, &connection.credential_ref)
            } else {
                read_pgpass_password(
                    &path,
                    &connection.host,
                    connection.port,
                    &connection.database,
                    &connection.user,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

fn next_id(store: &DbConnectionStore, display_name: &str) -> String {
    let base = display_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let base = base.trim_matches('-').to_owned();
    let base = if base.is_empty() {
        "db".to_owned()
    } else {
        base.chars().take(24).collect()
    };
    let mut candidate = base.clone();
    let mut suffix = 2;
    while store
        .connections
        .iter()
        .any(|connection| connection.id == candidate)
    {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

fn validate_text(
    value: &str,
    label: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<String, CoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(String::new());
        }
        return Err(CoreError::InvalidInput(format!("{label}을(를) 입력하세요")));
    }
    if trimmed.chars().count() > max_chars {
        return Err(CoreError::InvalidInput(format!(
            "{label}은(는) {max_chars}자 이하여야 합니다"
        )));
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return Err(CoreError::InvalidInput(format!(
            "{label}에 제어 문자를 쓸 수 없습니다"
        )));
    }
    Ok(trimmed.to_owned())
}

/// 드라이버에 인자로 그대로 넘어가는 값. 공백과 앞머리 `-`를 막는다.
fn validate_argument(value: &str, label: &str, max_chars: usize) -> Result<String, CoreError> {
    let trimmed = validate_text(value, label, max_chars, false)?;
    if trimmed.starts_with('-') || trimmed.chars().any(char::is_whitespace) {
        return Err(CoreError::InvalidInput(format!(
            "{label}에 공백을 쓰거나 -로 시작할 수 없습니다"
        )));
    }
    Ok(trimmed)
}

fn validate_database(engine: DbEngineKind, value: &str) -> Result<String, CoreError> {
    if engine.is_file_based() {
        let trimmed = validate_text(value, "데이터베이스 파일 경로", MAX_PATH_CHARS, false)?;
        let expanded = crate::user_path::expand_home(&trimmed)?;
        if !expanded.is_absolute() {
            return Err(CoreError::InvalidInput(
                "데이터베이스 파일은 절대 경로로 지정하세요".to_owned(),
            ));
        }
        return Ok(expanded.to_string_lossy().into_owned());
    }
    validate_argument(value, "데이터베이스", MAX_DATABASE_CHARS)
}

fn validate_secret(value: &str) -> Result<String, CoreError> {
    if value.chars().count() > MAX_SECRET_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "비밀번호는 {MAX_SECRET_CHARS}자 이하여야 합니다"
        )));
    }
    if value.chars().any(|character| character.is_control()) {
        return Err(CoreError::InvalidInput(
            "비밀번호에 제어 문자를 쓸 수 없습니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_list(
    values: &[String],
    label: &str,
    max_entries: usize,
    max_chars: usize,
) -> Result<Vec<String>, CoreError> {
    let mut result: Vec<String> = Vec::new();
    for value in values {
        let trimmed = validate_text(value, label, max_chars, true)?;
        if trimmed.is_empty() || result.contains(&trimmed) {
            continue;
        }
        result.push(trimmed);
    }
    if result.len() > max_entries {
        return Err(CoreError::InvalidInput(format!(
            "{label}은(는) {max_entries}개까지 지정할 수 있습니다"
        )));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn request(name: &str) -> SetDbConnectionRequest {
        SetDbConnectionRequest {
            id: String::new(),
            display_name: name.to_owned(),
            engine: "mariadb".to_owned(),
            environment: "dev".to_owned(),
            host: "db.example.com".to_owned(),
            port: Some(43306),
            user: "app".to_owned(),
            database: "appdb".to_owned(),
            credential_source: "clientFile".to_owned(),
            credential_ref: "app-dev".to_owned(),
            secret: None,
            agent_enabled: false,
            write_mode: "readOnly".to_owned(),
            schema_scope: Vec::new(),
            masked_columns: Vec::new(),
            max_rows: None,
            note: String::new(),
        }
    }

    /// 화면이 미리 채우는 선택지는 전부 요청 본문으로 되돌아왔을 때 해석돼야 한다.
    /// 목록을 손으로 적던 시절에는 변이를 늘리고 목록을 빠뜨려도 아무것도 깨지지 않았다.
    #[test]
    fn c10_1_offered_choices_all_parse_back_into_their_enum() {
        let defaults = connection_defaults();
        for value in &defaults.engines {
            value.parse::<DbEngineKind>().expect("engine");
        }
        for value in &defaults.environments {
            value.parse::<DbEnvironment>().expect("environment");
        }
        for value in &defaults.write_modes {
            value.parse::<DbWriteMode>().expect("write mode");
        }
        for value in &defaults.credential_sources {
            value
                .parse::<DbCredentialSource>()
                .expect("credential source");
        }
        assert_eq!(defaults.engines.len(), 4);
        assert_eq!(defaults.environments.len(), 4);
        assert_eq!(defaults.write_modes.len(), 3);
        assert_eq!(defaults.credential_sources.len(), 3);
    }

    #[test]
    fn c10_1_registration_derives_an_id_and_keeps_secrets_out_of_the_snapshot() {
        let dir = TempDir::new().expect("temp");
        let snapshot = set_db_connection(dir.path(), request("KBF 개발")).expect("save");
        assert_eq!(snapshot.connections.len(), 1);
        let connection = &snapshot.connections[0];
        assert_eq!(connection.id, "kbf");
        assert_eq!(connection.port, 43306);
        assert!(!connection.agent_enabled);
        assert_eq!(connection.max_rows, DEFAULT_MAX_ROWS);
        let serialized = serde_json::to_string(&snapshot).expect("json");
        assert!(!serialized.contains("password"));
    }

    #[test]
    fn c10_11_production_connections_cannot_take_a_write_mode() {
        let dir = TempDir::new().expect("temp");
        let mut payload = request("운영");
        payload.environment = "production".to_owned();
        payload.write_mode = "dmlWithApproval".to_owned();
        let error = set_db_connection(dir.path(), payload).expect_err("refused");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn c10_7_agent_listing_shows_only_enabled_and_usable_connections() {
        let dir = TempDir::new().expect("temp");
        let mut payload = request("앱 보관");
        payload.credential_source = "appKeychain".to_owned();
        payload.credential_ref = String::new();
        let snapshot = set_db_connection(dir.path(), payload).expect("save");
        let id = snapshot.connections[0].id.clone();
        // 비밀번호가 저장되지 않은 앱 보관 연결은 켜지지 않는다.
        let error = set_db_connection_enabled(
            dir.path(),
            SetDbConnectionEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .expect_err("refused");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let view = list_agent_db_connections(dir.path()).expect("list");
        assert!(view.connections.is_empty());
        assert!(view.skipped.is_empty());
    }

    /// QA #71. 파일 엔진은 자격증명이 없다. 받아 두면 화면이 PostgreSQL 안내를 세우고,
    /// 켠 뒤에는 있지도 않은 `~/.pgpass`를 찾다 '사용 불가'로 막힌다.
    #[test]
    fn file_engines_take_no_credential_and_stay_usable_without_one() {
        let dir = TempDir::new().expect("temp");
        let mut payload = request("파일 DB");
        payload.engine = "sqlite".to_owned();
        // 경로 자체는 이 시험의 관심사가 아니지만 절대 경로여야 한다. `/tmp/...`는
        // Windows에서 절대 경로가 아니라, 하드코딩하면 자격증명이 아니라 경로에서 막힌다.
        payload.database = dir
            .path()
            .join("agent-manager-qa.sqlite")
            .to_string_lossy()
            .into_owned();
        payload.host = String::new();
        payload.port = None;
        payload.user = String::new();
        let refused = set_db_connection(dir.path(), payload.clone()).expect_err("refused");
        assert!(matches!(refused, CoreError::InvalidInput(_)));

        payload.credential_source = "none".to_owned();
        payload.credential_ref = String::new();
        let snapshot = set_db_connection(dir.path(), payload).expect("save");
        let connection = &snapshot.connections[0];
        assert!(client_credential_path(connection).is_none());
        assert!(usable(connection).is_ok());
        assert!(resolve_secret(connection).expect("secret").is_none());
    }
}
