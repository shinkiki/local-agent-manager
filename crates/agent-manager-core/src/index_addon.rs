//! G7: reusable source/document indexes live only in app data; source folders are read-only.
//! G4/G10: registered roots, no symlinks, sensitive paths excluded, redaction before persistence.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::session_context::{redact, SessionReadRedaction};
use crate::CoreError;

const DATABASE: &str = "index-addon-v1.sqlite3";
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_SCAN: usize = 50_000;
const MAX_FILES: usize = 5_000;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RESULT_CHARS: usize = 24_000;
const MAX_SOURCES: usize = 32;
const MAX_SELECTED_PROJECTS: usize = 256;

/// 프로젝트 적용으로 새로 생긴 폴더의 첫 색인. 화면 토글 직후와 주기 작업이 같은 폴더를 한꺼번에
/// 훑지 않도록 한 번에 하나만 돈다(잡고 있으면 다음 주기로 미룬다).
static PROJECT_INDEXING: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexSnapshot {
    pub enabled: bool,
    pub auto_refresh: bool,
    pub sources: Vec<IndexSource>,
    /// 프로젝트 적용 방식. 전체 적용이면 활성 프로젝트 폴더가 모두(새 프로젝트 포함) 자동 등록된다.
    pub project_mode: IndexProjectMode,
    /// 선택 적용일 때 고른 프로젝트 경로(정규화). 전체 적용이면 비어 있다.
    pub selected_projects: Vec<String>,
    /// 적용했지만 등록하지 못한 프로젝트와 이유(앱 데이터 안 폴더·상한 등). 마지막 맞추기 결과다.
    pub project_issues: Vec<IndexProjectIssue>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexProjectMode {
    #[default]
    All,
    Selected,
}

impl IndexProjectMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Selected => "selected",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexProjectIssue {
    pub path: String,
    pub reason: String,
}

/// 프로젝트 등록부에서 넘겨받는 프로젝트. 비활성(제외)이면 그 폴더를 지우고, 폴더가 안 보이면
/// 잠깐의 일로 보고 유예 동안 남긴다.
#[derive(Debug, Clone)]
pub struct IndexProject {
    pub path: String,
    pub name: String,
    pub active: bool,
    pub exists: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetIndexProjectsRequest {
    pub mode: IndexProjectMode,
    /// 선택 적용에서 켠 프로젝트 경로. 전체 적용이면 무시한다. 비어 있어도 된다(아무 프로젝트도 안 씀).
    #[serde(default)]
    pub projects: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSource {
    pub id: String,
    pub name: String,
    pub path: String,
    pub agent_enabled: bool,
    pub indexed_at: Option<i64>,
    pub files: usize,
    pub chunks: usize,
    pub excluded: usize,
    pub truncated: bool,
    /// 이 폴더를 쓰는 프로젝트 경로. `None`이면 모든 프로젝트(기본값).
    pub projects: Option<Vec<String>>,
    /// 프로젝트 적용으로 자동 등록된 폴더면 그 프로젝트 경로. 직접 등록한 폴더는 `None`이다.
    pub project_path: Option<String>,
    /// 프로젝트 폴더의 첫 색인이 실패한 이유. 30분 뒤 다시 시도한다.
    pub last_error: Option<String>,
    #[serde(skip)]
    error_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetIndexSettingsRequest {
    pub enabled: bool,
    pub auto_refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddIndexSourceRequest {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexSourceRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetIndexSourceEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetIndexSourceProjectsRequest {
    pub id: String,
    /// `None`이면 모든 프로젝트, 목록이면 그 프로젝트(하위 폴더·워크트리 포함)에서만 쓴다.
    pub projects: Option<Vec<String>>,
}

/// 에이전트가 묻는 프로젝트. `project`가 없으면 화면·AIA처럼 적용 범위를 따지지 않는다.
/// 에이전트 MCP·CLI는 늘 호출한 작업 경로를 채우며, 모르면 빈 값이라 모든 프로젝트 폴더만 본다.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentIndexRequest {
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentIndexSourceRequest {
    pub id: String,
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchIndexRequest {
    pub query: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    /// [`AgentIndexRequest::project`]와 같다.
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexHit {
    pub source_id: String,
    pub source_name: String,
    pub relative_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub digest: String,
    pub excerpt: String,
    pub untrusted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSearchResult {
    pub hits: Vec<IndexHit>,
    pub stale_files: Vec<String>,
    pub truncated: bool,
    pub untrusted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadIndexExcerptRequest {
    pub source_id: String,
    pub relative_path: String,
    pub digest: String,
    pub start_line: usize,
    pub end_line: usize,
    /// [`AgentIndexRequest::project`]와 같다.
    #[serde(default)]
    pub project: Option<String>,
}

fn invalid(message: &str) -> CoreError {
    CoreError::InvalidInput(message.to_owned())
}

/// No read creates a database. SQLite and its sidecars must remain in canonical app data (G7/G10).
fn database_path(app: &Path, create: bool) -> Result<PathBuf, CoreError> {
    if create {
        fs::create_dir_all(app)?;
    }
    let root = fs::canonicalize(app)?;
    let path = root.join(DATABASE);
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let candidate = root.join(format!("{DATABASE}{suffix}"));
        match fs::symlink_metadata(candidate) {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err(invalid("인덱스 저장소에는 일반 파일만 사용할 수 있습니다"));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    if create {
        let file = crate::app_data_file::open_private_file(&path, false)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        drop(file);
    }
    Ok(path)
}

fn open(app: &Path, write: bool) -> Result<Connection, CoreError> {
    let path = database_path(app, write)?;
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let connection = Connection::open_with_flags(
        path,
        flags | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    if write {
        connection.execute_batch("PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, auto_refresh INTEGER NOT NULL);
            INSERT OR IGNORE INTO settings(id,enabled,auto_refresh) VALUES(1,0,0);
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER,
                excluded INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
                file_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
                projects TEXT);
            CREATE TABLE IF NOT EXISTS files (
                source_id TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL,
                PRIMARY KEY(source_id,path));
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
                source_id UNINDEXED, path, start_line UNINDEXED, end_line UNINDEXED,
                digest UNINDEXED, body, tokenize='unicode61');")?;
        for (table, column, ddl) in [
            ("sources", "projects", "TEXT"),
            ("sources", "project_path", "TEXT"),
            ("sources", "missing_since", "INTEGER"),
            ("sources", "last_error", "TEXT"),
            ("sources", "error_at", "INTEGER"),
            ("settings", "project_mode", "TEXT NOT NULL DEFAULT 'all'"),
            (
                "settings",
                "selected_projects",
                "TEXT NOT NULL DEFAULT '[]'",
            ),
            ("settings", "project_issues", "TEXT NOT NULL DEFAULT '[]'"),
        ] {
            add_column(&connection, table, column, ddl)?;
        }
    }
    Ok(connection)
}

/// 옛 저장소에만 칸을 더한다. 자동 갱신과 화면 쓰기가 같은 순간 열면 둘 다 "없음"을
/// 볼 수 있어, 뒤에 온 쪽의 중복 칸 오류는 이미 더해진 것으로 본다.
fn add_column(
    connection: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> Result<(), CoreError> {
    if has_column(connection, table, column)? {
        return Ok(());
    }
    if let Err(error) =
        connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
    {
        if !has_column(connection, table, column)? {
            return Err(error.into());
        }
    }
    Ok(())
}

/// 적용 프로젝트·프로젝트 적용 칸은 나중에 생겼다. 읽기 전용 연결은 옛 저장소를 고치지 않으므로
/// 칸이 없으면 기본값(모든 프로젝트·직접 등록·전체 적용)으로 읽는다.
fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, CoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        params![table, column],
        |r| r.get(0),
    )?)
}

fn column_or(
    connection: &Connection,
    table: &str,
    column: &'static str,
    fallback: &'static str,
) -> Result<&'static str, CoreError> {
    Ok(if has_column(connection, table, column)? {
        column
    } else {
        fallback
    })
}

fn projects_select(connection: &Connection) -> Result<&'static str, CoreError> {
    column_or(connection, "sources", "projects", "NULL")
}

/// 저장된 적용 프로젝트. 깨진 값은 아무 프로젝트에도 열지 않는다.
fn stored_projects(raw: Option<String>) -> Option<Vec<String>> {
    raw.map(|raw| serde_json::from_str(&raw).unwrap_or_default())
}

/// 호출한 작업 경로가 들 수 있는 프로젝트 기준점. `None`은 범위를 따지지 않는 화면·AIA,
/// 빈 목록은 프로젝트를 모르는 에이전트다. 워크트리에서 돈 대화는 본 체크아웃으로도 맞춘다.
fn caller_roots(project: Option<&str>) -> Option<Vec<PathBuf>> {
    let project = project?.trim();
    let path = Path::new(project);
    if project.is_empty() || !path.is_absolute() {
        return Some(Vec::new());
    }
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut roots = Vec::new();
    if let Some(main) = path
        .ancestors()
        .last()
        .and_then(|top| crate::catalog::worktree_main_checkout_path(&path, top))
    {
        // 저장된 프로젝트 경로는 정규화돼 있다. `gitdir:` 원문으로 만든 경로도 같은 꼴로 맞춘다
        // (macOS /var→/private/var, Windows \\?\ 접두, 심볼릭 링크).
        roots.push(fs::canonicalize(&main).unwrap_or(main));
    }
    roots.push(path);
    Some(roots)
}

fn applies_to(projects: Option<&[String]>, caller: Option<&[PathBuf]>) -> bool {
    match (projects, caller) {
        (None, _) | (_, None) => true,
        (Some(projects), Some(roots)) => roots
            .iter()
            .any(|root| projects.iter().any(|project| root.starts_with(project))),
    }
}

fn snapshot(
    connection: &Connection,
    agent_only: bool,
    caller: Option<&[PathBuf]>,
) -> Result<IndexSnapshot, CoreError> {
    let (enabled, auto_refresh) = settings(connection)?;
    let (project_mode, selected_projects, project_issues) = project_settings(connection)?;
    let mut stmt = connection.prepare(&format!(
        "SELECT id,name,path,enabled,indexed_at,
        file_count,chunk_count, excluded,truncated,{},{},{},{}
        FROM sources s WHERE (?1=0 OR enabled=1) ORDER BY name,id",
        projects_select(connection)?,
        column_or(connection, "sources", "project_path", "NULL")?,
        column_or(connection, "sources", "last_error", "NULL")?,
        column_or(connection, "sources", "error_at", "NULL")?
    ))?;
    let sources = stmt
        .query_map([agent_only], |row| {
            Ok(IndexSource {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                agent_enabled: row.get(3)?,
                indexed_at: row.get(4)?,
                files: row.get(5)?,
                chunks: row.get(6)?,
                excluded: row.get(7)?,
                truncated: row.get(8)?,
                projects: stored_projects(row.get(9)?),
                project_path: row.get(10)?,
                last_error: row.get(11)?,
                error_at: row.get(12)?,
            })
        })?
        .filter(|source| {
            source.as_ref().map_or(true, |source| {
                applies_to(source.projects.as_deref(), caller)
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(IndexSnapshot {
        enabled,
        auto_refresh,
        sources: if agent_only && !enabled {
            Vec::new()
        } else {
            sources
        },
        project_mode,
        // 에이전트에는 다른 프로젝트 경로를 내주지 않는다. 적용 설정은 화면·AIA용이다.
        selected_projects: if agent_only {
            Vec::new()
        } else {
            selected_projects
        },
        project_issues: if agent_only {
            Vec::new()
        } else {
            project_issues
        },
    })
}

/// 저장된 프로젝트 적용 설정. 깨진 값은 전체 적용·빈 목록으로 읽는다.
fn project_settings(
    connection: &Connection,
) -> Result<(IndexProjectMode, Vec<String>, Vec<IndexProjectIssue>), CoreError> {
    let (mode, selected, issues): (String, String, String) = connection.query_row(
        &format!(
            "SELECT {},{},{} FROM settings WHERE id=1",
            column_or(connection, "settings", "project_mode", "'all'")?,
            column_or(connection, "settings", "selected_projects", "'[]'")?,
            column_or(connection, "settings", "project_issues", "'[]'")?,
        ),
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let mode = if mode == "selected" {
        IndexProjectMode::Selected
    } else {
        IndexProjectMode::All
    };
    Ok((
        mode,
        serde_json::from_str(&selected).unwrap_or_default(),
        serde_json::from_str(&issues).unwrap_or_default(),
    ))
}

/// 저장·비교에 쓰는 프로젝트 경로. 등록부 경로는 세션 작업 경로 원문이라 정규화해 맞춘다.
fn project_key(path: &str) -> String {
    let path = Path::new(path.trim());
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.components().collect())
        .to_string_lossy()
        .into_owned()
}

fn input_message(error: CoreError) -> String {
    match error {
        CoreError::InvalidInput(message) => message,
        other => other.to_string(),
    }
}

/// 프로젝트 적용 방식을 저장한다. 폴더 등록·삭제는 [`sync_index_projects`]가 등록부를 보고 한다.
pub fn set_index_projects(
    app: &Path,
    request: SetIndexProjectsRequest,
) -> Result<IndexSnapshot, CoreError> {
    let selected = match request.mode {
        IndexProjectMode::All => BTreeSet::new(),
        IndexProjectMode::Selected => {
            if request.projects.len() > MAX_SELECTED_PROJECTS {
                return Err(invalid("적용할 프로젝트가 너무 많습니다"));
            }
            let mut selected = BTreeSet::new();
            for project in &request.projects {
                let path = Path::new(project.trim());
                if !path.is_absolute()
                    || crate::path_guard::has_parent_dir(path)
                    || project.len() > 4096
                {
                    return Err(invalid("프로젝트는 상위 이동이 없는 절대 경로여야 합니다"));
                }
                selected.insert(project_key(project));
            }
            selected
        }
    };
    let connection = open(app, true)?;
    connection.execute(
        "UPDATE settings SET project_mode=?1,selected_projects=?2 WHERE id=1",
        params![
            request.mode.as_str(),
            serde_json::to_string(&selected.into_iter().collect::<Vec<_>>())?
        ],
    )?;
    snapshot(&connection, false, None)
}

/// 등록부에서 잠깐 빠지거나 폴더가 안 보이는(마운트 전 등) 프로젝트 폴더를 지우기까지 기다리는
/// 시간. 바로 지우면 다시 나타날 때 처음부터 훑어야 한다. 사용자가 끄거나 제외한 것은 바로 지운다.
const MISSING_GRACE_MS: i64 = 24 * 60 * 60 * 1000;
/// 첫 색인이 실패한 폴더를 다시 시도하기까지 기다리는 시간. 매 주기 같은 실패로 훑지 않는다.
const FAILED_RETRY_MS: i64 = 30 * 60 * 1000;
/// 자동 갱신이 프로젝트 폴더를 다시 훑는 최소 간격. 저장소 전체라 직접 등록한 폴더(1분)보다 길다.
const PROJECT_REFRESH_MS: i64 = 10 * 60 * 1000;

/// 등록부의 프로젝트와 적용 설정에 맞춰 프로젝트 폴더를 등록·삭제한다. 인덱스가 꺼져 있으면
/// 아무것도 바꾸지 않는다. 자동 등록 폴더는 에이전트 사용이 켜진 채 그 프로젝트(하위 폴더·
/// 워크트리 포함)의 대화에만 적용되고, 색인은 [`index_pending_project_sources`]가 한다.
/// - 직접 등록한 폴더와 경로가 같은 프로젝트는 그 폴더를 그대로 두고 따로 만들지 않는다.
/// - 다른 적용 프로젝트 안에 든 프로젝트(워크트리·하위 폴더 세션)는 바깥 폴더가 덮으므로 따로 만들지 않는다.
/// - 사용자가 끄거나(선택 적용) 제외한(비활성) 프로젝트 폴더는 바로 지운다. 등록부에서 빠졌거나
///   폴더가 안 보이거나 검사가 실패한 것은 [`MISSING_GRACE_MS`] 동안 남겨 둔다.
pub fn sync_index_projects(app: &Path, projects: &[IndexProject]) -> Result<(), CoreError> {
    if !app.join(DATABASE).try_exists()? {
        return Ok(());
    }
    let mut connection = open(app, true)?;
    // 설정은 잠근 뒤에 읽는다. 앞서 읽으면 그 사이 사용자가 끈 프로젝트를 주기 작업이 되살린다.
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if !settings(&tx)?.0 {
        return Ok(());
    }
    let (mode, selected, previous_issues) = project_settings(&tx)?;
    let selected = selected.into_iter().collect::<BTreeSet<_>>();
    let mut desired = BTreeMap::new();
    let mut removed = BTreeSet::new();
    let mut issues = Vec::new();
    for project in projects {
        let key = project_key(&project.path);
        if !project.active || (mode == IndexProjectMode::Selected && !selected.contains(&key)) {
            removed.insert(key);
            continue;
        }
        if !project.exists {
            // 폴더가 안 보이는 것은 잠깐의 일(마운트 전 등)일 수 있다. 이미 있는 폴더는 유예 동안 남긴다.
            continue;
        }
        match validate_root(app, &project.path) {
            Ok(root) => {
                let name = project.name.trim();
                let name = if name.is_empty() {
                    root.file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| key.clone())
                } else {
                    name.to_owned()
                };
                desired
                    .entry(root.to_string_lossy().into_owned())
                    .or_insert_with(|| name.chars().take(80).collect::<String>());
            }
            Err(error) => {
                issues.push(IndexProjectIssue {
                    path: project.path.clone(),
                    reason: match error {
                        CoreError::InvalidInput(_) => "홈·공급자 저장소·앱 데이터와 겹치거나 심볼릭 링크가 든 폴더라 인덱스에 넣을 수 없습니다".to_owned(),
                        other => input_message(other),
                    },
                });
            }
        }
    }
    // 안에 든 프로젝트는 바깥 폴더가 덮는다(그 대화도 바깥 폴더 범위에 든다).
    // 덮는 폴더: 자동 등록될(또는 된) 프로젝트 폴더와, 에이전트 사용이 켜진 채 모든 프로젝트에
    // 적용된 직접 등록 폴더. 사용이 꺼졌거나 범위를 좁힌 직접 등록 폴더는 안쪽 대화가 못 보므로
    // 덮지 않는다(그 안쪽 프로젝트 색인을 지우면 아무것도 남지 않는다).
    let manual = {
        let mut stmt = tx.prepare(
            "SELECT path,enabled=1 AND projects IS NULL FROM sources WHERE project_path IS NULL",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let roots = desired
        .keys()
        .filter(|path| !manual.iter().any(|(manual, _)| manual == *path))
        .cloned()
        .chain(
            manual
                .iter()
                .filter(|(_, covers)| *covers)
                .map(|(path, _)| path.clone()),
        )
        .collect::<Vec<_>>();
    desired.retain(|path, _| {
        !roots
            .iter()
            .any(|root| root != path && Path::new(path).starts_with(root))
    });
    let now = crate::clock::now_ms();
    let managed = {
        let mut stmt = tx.prepare(
            "SELECT id,project_path,missing_since FROM sources WHERE project_path IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (id, path, missing_since) in managed {
        if desired.contains_key(&path) {
            if missing_since.is_some() {
                tx.execute("UPDATE sources SET missing_since=NULL WHERE id=?1", [&id])?;
            }
            continue;
        }
        // 바깥 폴더에 덮인 것·사용자가 끈 것은 바로, 그 밖은 유예가 지나면 지운다.
        let covered = roots
            .iter()
            .any(|root| root != &path && Path::new(&path).starts_with(root));
        let deselected = mode == IndexProjectMode::Selected && !selected.contains(&path);
        let explicit = removed.contains(&path) || covered || deselected;
        let expired = missing_since.is_some_and(|since| now - since > MISSING_GRACE_MS);
        if explicit || expired {
            tx.execute("DELETE FROM chunks WHERE source_id=?1", [&id])?;
            tx.execute("DELETE FROM files WHERE source_id=?1", [&id])?;
            tx.execute("DELETE FROM sources WHERE id=?1", [&id])?;
        } else if missing_since.is_none() {
            tx.execute(
                "UPDATE sources SET missing_since=?1 WHERE id=?2",
                params![now, id],
            )?;
        }
    }
    let existing = {
        let mut stmt = tx.prepare("SELECT path FROM sources")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?;
        rows
    };
    let mut count = existing.len();
    for (path, name) in desired {
        if existing.contains(&path) {
            continue;
        }
        if count >= MAX_SOURCES {
            issues.push(IndexProjectIssue {
                path,
                reason: format!("인덱스 폴더는 최대 {MAX_SOURCES}개입니다"),
            });
            continue;
        }
        tx.execute(
            "INSERT INTO sources(id,name,path,enabled,projects,project_path) VALUES(?1,?2,?3,1,?4,?3)",
            params![
                uuid::Uuid::new_v4().to_string(),
                name,
                path,
                serde_json::to_string(&[&path])?
            ],
        )?;
        count += 1;
    }
    if issues != previous_issues {
        tx.execute(
            "UPDATE settings SET project_issues=?1 WHERE id=1",
            [serde_json::to_string(&issues)?],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn project_indexing_lock() -> Option<std::sync::MutexGuard<'static, ()>> {
    match PROJECT_INDEXING.try_lock() {
        Ok(guard) => Some(guard),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

/// 프로젝트 적용으로 생겼고 아직 한 번도 색인하지 않은 폴더를 색인한다. 자동 갱신이 꺼져
/// 있어도 첫 색인은 해야 검색에 잡힌다. 주기 작업이 돌고 있으면 그쪽에 맡기고 바로 돌아온다.
pub fn index_pending_project_sources(app: &Path) {
    let Some(_guard) = project_indexing_lock() else {
        return;
    };
    index_pending_project_sources_locked(app);
}

fn index_pending_project_sources_locked(app: &Path) {
    let Ok(connection) = open(app, false) else {
        return;
    };
    let Ok(view) = snapshot(&connection, true, None) else {
        return;
    };
    if !view.enabled {
        return;
    }
    let now = crate::clock::now_ms();
    for source in view.sources {
        if source.project_path.is_none() || source.indexed_at.is_some() {
            continue;
        }
        if source.error_at.is_some_and(|at| now - at < FAILED_RETRY_MS) {
            continue;
        }
        let failure = refresh_source(app, &source.id, true, false, None).err();
        if let Ok(connection) = open(app, true) {
            let _ = connection.execute(
                "UPDATE sources SET last_error=?1,error_at=?2 WHERE id=?3",
                params![
                    failure.as_ref().map(|error| error.to_string()),
                    failure.as_ref().map(|_| now),
                    source.id
                ],
            );
        }
    }
}

/// 주기 작업 한 번: 프로젝트 폴더 맞추기 → 첫 색인 → 자동 갱신. 화면 토글 직후의 첫 색인과
/// 같은 폴더를 한꺼번에 훑지 않도록 같은 자물쇠를 잡는다(못 잡으면 다음 주기로 미룬다).
fn index_cycle(app: &Path, projects: Option<Vec<IndexProject>>) {
    let Some(_guard) = project_indexing_lock() else {
        return;
    };
    if index_enabled(app) {
        if let Some(projects) = projects {
            let _ = sync_index_projects(app, &projects);
        }
        index_pending_project_sources_locked(app);
    }
    refresh_automatic_sources(app);
}

/// 프로젝트 적용으로 등록된 폴더는 적용 프로젝트 목록에서만 바꾼다. 여기서 지우거나 끄면
/// 다음 맞추기가 되살리거나 화면과 어긋난다.
fn reject_project_source(connection: &Connection, id: &str) -> Result<(), CoreError> {
    let managed: bool = connection
        .query_row(
            &format!(
                "SELECT {} IS NOT NULL FROM sources WHERE id=?1",
                column_or(connection, "sources", "project_path", "NULL")?
            ),
            [id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if managed {
        return Err(invalid(
            "프로젝트 적용으로 등록된 폴더입니다. 적용 프로젝트 목록에서 끄거나 켜 주세요",
        ));
    }
    Ok(())
}

fn settings(connection: &Connection) -> Result<(bool, bool), CoreError> {
    Ok(connection.query_row(
        "SELECT enabled,auto_refresh FROM settings WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

pub fn set_index_settings(
    app: &Path,
    request: SetIndexSettingsRequest,
) -> Result<IndexSnapshot, CoreError> {
    let connection = open(app, true)?;
    connection.execute(
        "UPDATE settings SET enabled=?1,auto_refresh=?2 WHERE id=1",
        params![request.enabled, request.auto_refresh],
    )?;
    snapshot(&connection, false, None)
}

pub(crate) fn index_enabled(app: &Path) -> bool {
    app.join(DATABASE).try_exists().unwrap_or(false)
        && open(app, false)
            .and_then(|c| settings(&c))
            .is_ok_and(|s| s.0)
}

/// Owned by the running backend; disabled indexes do no scans. All work stays off the async executor.
/// `projects`는 등록부의 활성 프로젝트다. 등록부를 못 읽으면(`None`) 프로젝트 폴더를 건드리지 않는다.
pub(crate) fn start_index_refresh<F>(app: PathBuf, projects: F) -> tokio::task::JoinHandle<()>
where
    F: Fn() -> Option<Vec<IndexProject>> + Send + Sync + 'static,
{
    let projects = std::sync::Arc::new(projects);
    tokio::spawn(async move {
        loop {
            let app = app.clone();
            let projects = std::sync::Arc::clone(&projects);
            let _ = tokio::task::spawn_blocking(move || {
                let list = if index_enabled(&app) {
                    projects()
                } else {
                    None
                };
                index_cycle(&app, list);
            })
            .await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    })
}

fn refresh_automatic_sources(app: &Path) {
    let Ok(view) = get_index_sources(app, true) else {
        return;
    };
    if !view.enabled || !view.auto_refresh {
        return;
    }
    let now = crate::clock::now_ms();
    for source in view.sources {
        // 프로젝트 폴더는 저장소 전체라 더 길게 띄운다. 첫 색인 전 폴더는 첫 색인 쪽이 맡고,
        // 실패한 폴더도 마지막 시도부터 같은 간격을 둔다(매 주기 같은 실패로 훑지 않도록).
        if source.project_path.is_some() {
            let Some(indexed_at) = source.indexed_at else {
                continue;
            };
            let last = source.error_at.map_or(indexed_at, |at| at.max(indexed_at));
            if now - last < PROJECT_REFRESH_MS {
                continue;
            }
        }
        let failure = refresh_source(app, &source.id, true, true, None).err();
        if source.project_path.is_some() && (failure.is_some() || source.last_error.is_some()) {
            if let Ok(connection) = open(app, true) {
                let _ = connection.execute(
                    "UPDATE sources SET last_error=?1,error_at=?2 WHERE id=?3",
                    params![
                        failure.as_ref().map(|error| error.to_string()),
                        failure.as_ref().map(|_| now),
                        source.id
                    ],
                );
            }
        }
    }
}

pub fn get_index_sources(app: &Path, agent_only: bool) -> Result<IndexSnapshot, CoreError> {
    if !app.join(DATABASE).try_exists()? {
        return Ok(IndexSnapshot::default());
    }
    snapshot(&open(app, false)?, agent_only, None)
}

/// 에이전트용 목록. 사용이 켜진 폴더 중 호출한 프로젝트에 적용된 것만 돌려준다.
pub fn list_agent_index_sources(
    app: &Path,
    request: AgentIndexRequest,
) -> Result<IndexSnapshot, CoreError> {
    if !app.join(DATABASE).try_exists()? {
        return Ok(IndexSnapshot::default());
    }
    let caller = caller_roots(request.project.as_deref());
    snapshot(&open(app, false)?, true, caller.as_deref())
}

fn validate_root(app: &Path, path: &str) -> Result<PathBuf, CoreError> {
    let input = Path::new(path.trim());
    if !input.is_absolute() || crate::path_guard::has_parent_dir(input) {
        return Err(invalid(
            "인덱스 폴더는 상위 이동이 없는 절대 경로여야 합니다",
        ));
    }
    let mut current = PathBuf::new();
    for component in input.components() {
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(invalid("인덱스 폴더에는 심볼릭 링크를 사용할 수 없습니다"));
        }
    }
    let root = fs::canonicalize(input)?;
    if !root.is_dir() || crate::project_files::is_restricted_project_root(app, &root) {
        return Err(invalid(
            "홈·공급자 저장소·앱 데이터와 겹치지 않는 폴더를 선택해 주세요",
        ));
    }
    Ok(root)
}

pub fn add_index_source(
    app: &Path,
    request: AddIndexSourceRequest,
) -> Result<IndexSnapshot, CoreError> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(invalid("이름은 1~80자로 입력해 주세요"));
    }
    let root = validate_root(app, &request.path)?;
    let mut connection = open(app, true)?;
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let count: usize = tx.query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?;
    if count >= MAX_SOURCES {
        return Err(invalid("인덱스 폴더는 최대 32개입니다"));
    }
    let path = root.to_string_lossy();
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sources WHERE path=?1)",
        [path.as_ref()],
        |r| r.get(0),
    )?;
    if exists {
        return Err(invalid("이미 등록된 인덱스 폴더입니다"));
    }
    tx.execute(
        "INSERT INTO sources(id,name,path) VALUES(?1,?2,?3)",
        params![uuid::Uuid::new_v4().to_string(), name, path],
    )?;
    tx.commit()?;
    snapshot(&connection, false, None)
}

pub fn set_index_source_enabled(
    app: &Path,
    request: SetIndexSourceEnabledRequest,
) -> Result<IndexSnapshot, CoreError> {
    let connection = open(app, true)?;
    reject_project_source(&connection, &request.id)?;
    if connection.execute(
        "UPDATE sources SET enabled=?1 WHERE id=?2",
        params![request.enabled, request.id],
    )? == 0
    {
        return Err(CoreError::NotFound(
            "등록된 인덱스 폴더가 없습니다".to_owned(),
        ));
    }
    snapshot(&connection, false, None)
}

pub fn set_index_source_projects(
    app: &Path,
    request: SetIndexSourceProjectsRequest,
) -> Result<IndexSnapshot, CoreError> {
    let projects = match request.projects {
        None => None,
        Some(list) => {
            if list.is_empty() || list.len() > 64 {
                return Err(invalid("적용할 프로젝트를 1~64개 골라 주세요"));
            }
            let mut normalized = BTreeSet::new();
            for project in list {
                let path = Path::new(project.trim());
                if !path.is_absolute()
                    || crate::path_guard::has_parent_dir(path)
                    || project.len() > 4096
                {
                    return Err(invalid("프로젝트는 상위 이동이 없는 절대 경로여야 합니다"));
                }
                let path = fs::canonicalize(path).unwrap_or_else(|_| path.components().collect());
                normalized.insert(path.to_string_lossy().into_owned());
            }
            Some(serde_json::to_string(&normalized)?)
        }
    };
    let connection = open(app, true)?;
    reject_project_source(&connection, &request.id)?;
    if connection.execute(
        "UPDATE sources SET projects=?1 WHERE id=?2",
        params![projects, request.id],
    )? == 0
    {
        return Err(CoreError::NotFound(
            "등록된 인덱스 폴더가 없습니다".to_owned(),
        ));
    }
    snapshot(&connection, false, None)
}

pub fn remove_index_source(app: &Path, id: &str) -> Result<IndexSnapshot, CoreError> {
    let mut connection = open(app, true)?;
    reject_project_source(&connection, id)?;
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM chunks WHERE source_id=?1", [id])?;
    tx.execute("DELETE FROM files WHERE source_id=?1", [id])?;
    tx.execute("DELETE FROM sources WHERE id=?1", [id])?;
    tx.commit()?;
    snapshot(&connection, false, None)
}

fn source(
    connection: &Connection,
    id: &str,
    require_enabled: bool,
    caller: Option<&[PathBuf]>,
) -> Result<(String, String), CoreError> {
    if require_enabled && !settings(connection)?.0 {
        return Err(invalid(
            "인덱스 사용이 꺼져 있습니다. 애드온 → 인덱스에서 켜 주세요",
        ));
    }
    let (name, path, projects) = connection
        .query_row(
            &format!(
                "SELECT name,path,{} FROM sources WHERE id=?1 AND (?2=0 OR enabled=1)",
                projects_select(connection)?
            ),
            params![id, require_enabled],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?)),
        )
        .optional()?
        .ok_or_else(|| invalid("등록되어 있고 에이전트 사용이 켜진 인덱스 폴더를 선택해 주세요"))?;
    if !applies_to(stored_projects(projects).as_deref(), caller) {
        return Err(invalid(
            "이 프로젝트에 적용된 인덱스 폴더가 아닙니다. 애드온 → 인덱스에서 적용 프로젝트를 확인해 주세요",
        ));
    }
    Ok((name, path))
}

/// Explicit text/code allowlist: credentials, hidden state, binaries and generated trees never open.
fn allowed_name(name: &str, directory: bool) -> bool {
    let lower = name.to_lowercase();
    if lower.starts_with('.')
        || lower.starts_with("id_")
        || ["credential", "secret", "token", "password"]
            .iter()
            .any(|part| lower.contains(part))
    {
        return false;
    }
    if directory {
        return ![
            "node_modules",
            "target",
            "dist",
            "build",
            "vendor",
            "coverage",
            "__pycache__",
            "venv",
        ]
        .contains(&lower.as_str());
    }
    if [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "cargo.lock",
        "auth.json",
        "config.json",
    ]
    .contains(&lower.as_str())
    {
        return false;
    }
    matches!(
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
    )
}

fn resolve_file(app: &Path, root: &Path, relative: &str) -> Result<PathBuf, CoreError> {
    if relative.is_empty() || relative.contains('\\') {
        return Err(invalid("정규 상대 파일 경로가 필요합니다"));
    }
    let components = Path::new(relative).components().collect::<Vec<_>>();
    let mut path = root.to_path_buf();
    for (i, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(invalid("폴더 밖 경로는 읽을 수 없습니다"));
        };
        let name = name
            .to_str()
            .ok_or_else(|| invalid("UTF-8 파일명만 지원합니다"))?;
        if !allowed_name(name, i + 1 < components.len()) {
            return Err(invalid("인덱스 제외 경로입니다"));
        }
        path.push(name);
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            return Err(invalid("심볼릭 링크는 읽을 수 없습니다"));
        }
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(root) || crate::doc_roots::is_restricted_doc_root(app, &canonical) {
        return Err(invalid("인덱스 폴더 밖 파일은 읽을 수 없습니다"));
    }
    Ok(canonical)
}

fn read_text(path: &Path) -> Result<Option<(String, String)>, CoreError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
        return Ok(None);
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(None);
    };
    if text.lines().any(|line| line.len() > 4_000) || text.contains("-----BEGIN ") {
        return Ok(None);
    }
    // G4: assignments can span tokens, lines or objects. Exclude the entire file
    // rather than persist a partially masked credential. Also applied to range reads.
    if has_structured_credentials(&text) {
        return Ok(None);
    }
    Ok(Some((text, digest)))
}

fn has_structured_credentials(text: &str) -> bool {
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
    fn secret_json(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(fields) => fields.iter().any(|(key, value)| {
                KEYS.contains(&key.to_ascii_lowercase().as_str()) || secret_json(value)
            }),
            serde_json::Value::Array(values) => values.iter().any(secret_json),
            _ => false,
        }
    }
    // JSON escapes in keys must not bypass the text scanner.
    if serde_json::from_str::<serde_json::Value>(text).is_ok_and(|value| secret_json(&value)) {
        return true;
    }
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
        let key = text[start..position].to_ascii_lowercase();
        if !KEYS.contains(&key.as_str()) {
            continue;
        }
        let mut end = position;
        // Quoted JSON/TOML/YAML keys and whitespace before the assignment.
        if end < bytes.len() && matches!(bytes[end], b'"' | b'\'') {
            end += 1;
        }
        while end < bytes.len() && bytes[end].is_ascii_whitespace() {
            end += 1;
        }
        if end >= bytes.len() || !matches!(bytes[end], b':' | b'=') {
            continue;
        }
        if bytes[end] == b':' && is_type_annotation(&text[end + 1..]) {
            continue;
        }
        // G4: a punctuation-containing value can be split by the session redactor,
        // leaving part of a credential visible. Exclude the complete file for every
        // recognized assignment, including compact ones, rather than guessing its end.
        return true;
    }
    false
}

/// A Rust parameter or field type (`token: &str)`, `password: Option<String> }`) names a
/// slot, not a value. Only an exact type spelling closed by `,` `)` `}` on the same line
/// qualifies, so `let token: String = "…"` and every YAML/TOML value stay excluded (G4).
fn is_type_annotation(rest: &str) -> bool {
    const TYPES: &[&str] = &[
        "&str",
        "&String",
        "String",
        "Option<String>",
        "Option<&str>",
        "&[u8]",
        "Vec<u8>",
    ];
    let rest = rest.trim_start_matches([' ', '\t']);
    TYPES.iter().any(|ty| {
        rest.strip_prefix(ty).is_some_and(|after| {
            matches!(
                after.trim_start_matches([' ', '\t']).bytes().next(),
                Some(b',' | b')' | b'}')
            )
        })
    })
}

pub fn refresh_index_source(app: &Path, id: &str) -> Result<IndexSnapshot, CoreError> {
    refresh_source(app, id, false, false, None)
}

pub(crate) fn refresh_agent_index_source(
    app: &Path,
    request: AgentIndexSourceRequest,
) -> Result<IndexSnapshot, CoreError> {
    let caller = caller_roots(request.project.as_deref());
    refresh_source(app, &request.id, true, false, caller.as_deref())
}

fn refresh_source(
    app: &Path,
    id: &str,
    agent_only: bool,
    automatic: bool,
    caller: Option<&[PathBuf]>,
) -> Result<IndexSnapshot, CoreError> {
    refresh_source_with_limit(app, id, agent_only, automatic, caller, MAX_FILES)
}

fn refresh_source_with_limit(
    app: &Path,
    id: &str,
    agent_only: bool,
    automatic: bool,
    caller: Option<&[PathBuf]>,
    max_files: usize,
) -> Result<IndexSnapshot, CoreError> {
    let mut connection = open(app, true)?;
    // Scan outside the write transaction so the user can disable the add-on during a rebuild.
    if automatic && !settings(&connection)?.1 {
        return Err(invalid("자동 갱신이 꺼져 있습니다"));
    }
    let (_, path) = source(&connection, id, agent_only, caller)?;
    let root = validate_root(app, &path)?;
    let mut queue = vec![root.clone()];
    let mut seen = BTreeSet::new();
    let mut scanned = 0;
    let mut excluded = 0;
    let mut total_bytes = 0;
    let mut truncated = false;
    let mut staged = Vec::new();
    'scan: while let Some(directory) = queue.pop() {
        let safe_directory = validate_root(app, &directory.to_string_lossy())?;
        if !safe_directory.starts_with(&root) {
            return Err(invalid("인덱스 폴더 밖 경로입니다"));
        }
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            scanned += 1;
            if scanned % 64 == 0 {
                source(&connection, id, agent_only, caller)?;
                if automatic && !settings(&connection)?.1 {
                    return Err(invalid("자동 갱신이 꺼져 있습니다"));
                }
            }
            if scanned > MAX_SCAN || seen.len() >= max_files {
                truncated = true;
                break 'scan;
            }
            let meta = fs::symlink_metadata(entry.path())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                excluded += 1;
                continue;
            };
            if meta.file_type().is_symlink() || !allowed_name(name, meta.is_dir()) {
                excluded += 1;
                continue;
            }
            if meta.is_dir() {
                queue.push(entry.path());
                continue;
            }
            if !meta.is_file() {
                excluded += 1;
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&root)
                .map_err(|_| invalid("폴더 밖 경로입니다"))?
                .to_string_lossy()
                .replace('\\', "/");
            let safe = resolve_file(app, &root, &relative)?;
            let Some((text, digest)) = read_text(&safe)? else {
                excluded += 1;
                continue;
            };
            total_bytes += text.len() as u64;
            if total_bytes > MAX_TOTAL_BYTES {
                truncated = true;
                break 'scan;
            }
            seen.insert(relative.clone());
            let previous: Option<String> = connection
                .query_row(
                    "SELECT digest FROM files WHERE source_id=?1 AND path=?2",
                    params![id, relative],
                    |r| r.get(0),
                )
                .optional()?;
            if previous.as_ref() == Some(&digest) {
                continue;
            }
            staged.push((
                relative,
                digest,
                redact(&text, SessionReadRedaction::Credentials),
            ));
        }
    }
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (_, current_path) = source(&tx, id, agent_only, caller)?;
    if current_path != path || (automatic && !settings(&tx)?.1) {
        return Err(CoreError::Conflict(
            "갱신 중 인덱스 설정이 변경되었습니다".to_owned(),
        ));
    }
    for (relative, digest, clean) in staged {
        tx.execute(
            "DELETE FROM chunks WHERE source_id=?1 AND path=?2",
            params![id, relative],
        )?;
        let lines = clean.lines().collect::<Vec<_>>();
        let mut start = 0;
        while start < lines.len() {
            let mut end = start;
            let mut bytes = 0;
            while end < lines.len()
                && end - start < 50
                && (end == start || bytes + lines[end].len() < 6_000)
            {
                bytes += lines[end].len() + 1;
                end += 1;
            }
            tx.execute("INSERT INTO chunks(source_id,path,start_line,end_line,digest,body) VALUES(?1,?2,?3,?4,?5,?6)",params![id,relative,start+1,end,digest,lines[start..end].join("\n")])?;
            start = end;
        }
        tx.execute(
            "INSERT OR REPLACE INTO files(source_id,path,digest) VALUES(?1,?2,?3)",
            params![id, relative, digest],
        )?;
    }
    // G7: even a partial scan replaces the previous subset. Retaining unseen rows
    // would accumulate unlimited stale entries across repeated truncated refreshes.
    {
        let mut stmt = tx.prepare("SELECT path FROM files WHERE source_id=?1")?;
        let old = stmt
            .query_map([id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        for path in old.into_iter().filter(|p| !seen.contains(p)) {
            tx.execute(
                "DELETE FROM chunks WHERE source_id=?1 AND path=?2",
                params![id, path],
            )?;
            tx.execute(
                "DELETE FROM files WHERE source_id=?1 AND path=?2",
                params![id, path],
            )?;
        }
    }
    tx.execute(
        "UPDATE sources SET indexed_at=?1,excluded=?2,truncated=?3,
        file_count=(SELECT count(*) FROM files WHERE source_id=?4),
        chunk_count=(SELECT count(*) FROM chunks WHERE source_id=?4) WHERE id=?4",
        params![crate::clock::now_ms(), excluded, truncated, id],
    )?;
    tx.commit()?;
    snapshot(&connection, agent_only, caller)
}

fn match_query(query: &str) -> Result<String, CoreError> {
    if query.len() > 512 {
        return Err(invalid("검색어는 512바이트 이하여야 합니다"));
    }
    let terms = query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty())
        .take(16)
        .map(|s| format!("\"{}\"*", s))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err(invalid("검색어를 입력해 주세요"));
    }
    Ok(terms.join(" AND "))
}

pub fn search_index(
    app: &Path,
    request: SearchIndexRequest,
) -> Result<IndexSearchResult, CoreError> {
    let query = match_query(&request.query)?;
    let mut result = IndexSearchResult {
        hits: Vec::new(),
        stale_files: Vec::new(),
        truncated: false,
        untrusted: true,
    };
    if !app.join(DATABASE).try_exists()? {
        return Ok(result);
    }
    let connection = open(app, false)?;
    // Read transaction gives enablement and the index one consistent snapshot.
    connection.execute_batch("BEGIN")?;
    if !settings(&connection)?.0 {
        return Err(invalid(
            "인덱스 사용이 꺼져 있습니다. 애드온 → 인덱스에서 켜 주세요",
        ));
    }
    let caller = caller_roots(request.project.as_deref());
    if let Some(id) = &request.source_id {
        source(&connection, id, true, caller.as_deref())?;
    }
    // 적용 범위는 순위를 매기기 전에 걸러야 다른 프로젝트 폴더가 상한을 채우지 않는다.
    let allowed = match caller.as_deref() {
        None => None,
        Some(_) => Some(serde_json::to_string(
            &snapshot(&connection, true, caller.as_deref())?
                .sources
                .into_iter()
                .map(|source| source.id)
                .collect::<Vec<_>>(),
        )?),
    };
    let mut stmt = connection.prepare(
        "SELECT c.source_id,s.name,s.path,c.path,c.start_line,c.end_line,c.digest,c.body
        FROM chunks c JOIN sources s ON s.id=c.source_id WHERE chunks MATCH ?1 AND s.enabled=1
        AND (?2 IS NULL OR s.id=?2)
        AND (?3 IS NULL OR s.id IN (SELECT value FROM json_each(?3)))
        ORDER BY bm25(chunks) LIMIT 201",
    )?;
    let rows = stmt.query_map(params![query, request.source_id, allowed], |r| {
        Ok((
            r.get::<_, String>(2)?,
            IndexHit {
                source_id: r.get(0)?,
                source_name: r.get(1)?,
                relative_path: r.get(3)?,
                start_line: r.get(4)?,
                end_line: r.get(5)?,
                digest: r.get(6)?,
                excerpt: r.get(7)?,
                untrusted: true,
            },
        ))
    })?;
    let limit = request.limit.unwrap_or(8).clamp(1, 20);
    let mut checked = HashMap::new();
    let mut chars = 0;
    for (candidate, row) in rows.enumerate() {
        if candidate >= 200 {
            result.truncated = true;
            break;
        }
        let (path, hit) = row?;
        if result.hits.len() >= limit {
            result.truncated = true;
            break;
        }
        let key = format!("{}/{}", hit.source_id, hit.relative_path);
        let fresh = *checked.entry(key.clone()).or_insert_with(|| {
            validate_root(app, &path)
                .and_then(|root| resolve_file(app, &root, &hit.relative_path))
                .and_then(|path| read_text(&path))
                .ok()
                .flatten()
                .is_some_and(|(_, digest)| digest == hit.digest)
        });
        if !fresh {
            if !result.stale_files.contains(&key) {
                chars += key.chars().count();
                if chars > MAX_RESULT_CHARS {
                    result.truncated = true;
                    break;
                }
                result.stale_files.push(key);
            }
            continue;
        }
        chars += hit.excerpt.chars().count()
            + hit.relative_path.chars().count()
            + hit.source_name.chars().count()
            + 160;
        if chars > MAX_RESULT_CHARS {
            result.truncated = true;
            break;
        }
        result.hits.push(hit);
    }

    Ok(result)
}

pub fn read_index_excerpt(
    app: &Path,
    request: ReadIndexExcerptRequest,
) -> Result<IndexHit, CoreError> {
    if request.start_line == 0
        || request.end_line < request.start_line
        || request.end_line - request.start_line >= 100
    {
        return Err(invalid("한 번에 1~100줄 범위를 지정해 주세요"));
    }
    let connection = open(app, false)?;
    connection.execute_batch("BEGIN")?;
    let caller = caller_roots(request.project.as_deref());
    let (name, path) = source(&connection, &request.source_id, true, caller.as_deref())?;
    let root = validate_root(app, &path)?;
    let path = resolve_file(app, &root, &request.relative_path)?;
    let indexed: Option<String> = connection
        .query_row(
            "SELECT digest FROM files WHERE source_id=?1 AND path=?2",
            params![request.source_id, request.relative_path],
            |r| r.get(0),
        )
        .optional()?;
    let Some((text, digest)) = read_text(&path)? else {
        return Err(invalid("인덱스가 지원하는 텍스트 파일이 아닙니다"));
    };
    if indexed.as_ref() != Some(&digest) || digest != request.digest {
        return Err(CoreError::Conflict(
            "파일이 변경되었습니다. 인덱스를 갱신한 뒤 다시 검색해 주세요".to_owned(),
        ));
    }
    let clean = redact(&text, SessionReadRedaction::Credentials);
    let lines = clean.lines().collect::<Vec<_>>();
    if request.end_line > lines.len() {
        return Err(invalid("파일의 줄 범위를 벗어났습니다"));
    }
    let excerpt = lines[request.start_line - 1..request.end_line].join("\n");
    if excerpt.chars().count() > MAX_RESULT_CHARS {
        return Err(invalid("본문 범위를 더 좁혀 주세요"));
    }
    Ok(IndexHit {
        source_id: request.source_id,
        source_name: name,
        relative_path: request.relative_path,
        start_line: request.start_line,
        end_line: request.end_line,
        digest,
        excerpt,
        untrusted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        // macOS의 /var는 /private/var 링크라 validate_root가 거절한다 — 실제 경로로 시작한다.
        let base = fs::canonicalize(temp.path()).unwrap();
        let app = base.join("app");
        let root = base.join("documents");
        fs::create_dir_all(&root).unwrap();
        let view = add_index_source(
            &app,
            AddIndexSourceRequest {
                name: "Documents".into(),
                path: root.to_string_lossy().into(),
            },
        )
        .unwrap();
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: true,
                auto_refresh: false,
            },
        )
        .unwrap();
        let id = view.sources[0].id.clone();
        (temp, app, root, id)
    }
    fn search(app: &Path, query: &str) -> IndexSearchResult {
        search_index(
            app,
            SearchIndexRequest {
                query: query.into(),
                source_id: None,
                limit: None,
                project: None,
            },
        )
        .unwrap()
    }
    #[test]
    fn g7_index_incremental_refresh_and_agent_gate() {
        let (_temp, app, root, id) = setup();
        fs::write(
            root.join("guide.md"),
            "Login session expires\nuse refresh token safely",
        )
        .unwrap();
        refresh_index_source(&app, &id).unwrap();
        assert!(search(&app, "Login").hits.is_empty());
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        let first = search(&app, "Login");
        assert_eq!(first.hits.len(), 1);
        assert_eq!(first.hits[0].start_line, 1);
        refresh_index_source(&app, &id).unwrap();
        assert_eq!(get_index_sources(&app, false).unwrap().sources[0].chunks, 1);
        fs::write(root.join("guide.md"), "Updated instructions").unwrap();
        assert!(search(&app, "Login").hits.is_empty());
        assert_eq!(search(&app, "Login").stale_files.len(), 1);
        refresh_index_source(&app, &id).unwrap();
        assert_eq!(search(&app, "Updated").hits.len(), 1);
        fs::remove_file(root.join("guide.md")).unwrap();
        refresh_index_source(&app, &id).unwrap();
        assert_eq!(get_index_sources(&app, false).unwrap().sources[0].files, 0);
        remove_index_source(&app, &id).unwrap();
        assert!(get_index_sources(&app, false).unwrap().sources.is_empty());
    }
    #[test]
    fn g4_g10_excludes_sensitive_binary_and_linked_files() {
        let (_temp, app, root, id) = setup();
        for name in [
            ".env",
            "credentials.json",
            "private.key",
            "secret.md",
            "auth.json",
        ] {
            fs::write(root.join(name), "neverindexmarker").unwrap();
        }
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/dependency.ts"), "neverindexmarker").unwrap();
        fs::write(root.join("binary.txt"), b"neverindexmarker\0").unwrap();
        fs::write(root.join("safe.md"), "Visible marker").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("safe.md"), root.join("linked.md")).unwrap();
        refresh_index_source(&app, &id).unwrap();
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        assert!(search(&app, "neverindexmarker").hits.is_empty());
        assert!(search(&app, "private-index-test-value").hits.is_empty());
        let persisted = fs::read(app.join(DATABASE)).unwrap();
        assert!(!persisted
            .windows(b"private-index-test-value".len())
            .any(|part| part == b"private-index-test-value"));
        assert!(!search(&app, "Visible").hits[0]
            .excerpt
            .contains("private-index-test-value"));
        assert!(validate_root(&app, app.to_str().unwrap()).is_err());
        assert!(resolve_file(&app, &root, "../safe.md").is_err());
        assert!(resolve_file(&app, &root, ".env").is_err());
    }
    #[test]
    fn g4_structured_credentials_never_reach_sqlite() {
        let (_temp, app, root, id) = setup();
        for (i, body) in [
            r#"{"api_key": "structured-credential-marker"}"#,
            "api_key: structured-credential-marker",
            "password = 'structured-credential-marker'",
            "token:\n  nested: structured-credential-marker",
            "\"access_token\":\n \"structured-credential-marker\"",
            r#"{"api\u005fkey":"structured-credential-marker"}"#,
            "api_key=('structured-credential-marker')",
            "password=a!structured-credential-marker",
            "api_key=structured-credential-marker",
            "let token: String = \"structured-credential-marker\";",
            "password: String structured-credential-marker",
            "token: &str\n= structured-credential-marker",
            "fn f(token: &str) {}\npassword=structured-credential-marker",
        ]
        .iter()
        .enumerate()
        {
            fs::write(root.join(format!("sample{i}.txt")), body).unwrap();
        }
        let view = refresh_index_source(&app, &id).unwrap();
        assert_eq!(view.sources[0].files, 0);
        assert_eq!(view.sources[0].excluded, 13);
        let bytes = fs::read(app.join(DATABASE)).unwrap();
        assert!(!bytes
            .windows(b"structured-credential-marker".len())
            .any(|part| part == b"structured-credential-marker"));
    }

    #[test]
    fn g4_rust_type_annotations_are_not_credentials() {
        let (_temp, app, root, id) = setup();
        fs::write(
            root.join("parameter.rs"),
            "pub fn probe_parameter(token: &str) -> usize { token.len() }",
        )
        .unwrap();
        fs::write(
            root.join("field.rs"),
            "struct Input { password: Option<String> }\npub fn probe_field() {}",
        )
        .unwrap();
        let view = refresh_index_source(&app, &id).unwrap();
        assert_eq!((view.sources[0].files, view.sources[0].excluded), (2, 0));
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        assert!(!search(&app, "probe_parameter").hits.is_empty());
        assert!(!search(&app, "probe_field").hits.is_empty());
    }

    #[test]
    fn g7_truncated_refresh_does_not_accumulate_old_subsets() {
        let (_temp, app, root, id) = setup();
        fs::write(root.join("old.md"), "obsolete marker").unwrap();
        refresh_index_source(&app, &id).unwrap();
        fs::remove_file(root.join("old.md")).unwrap();
        for i in 0..=4 {
            fs::write(root.join(format!("current{i}.md")), "current marker").unwrap();
        }
        let view = refresh_source_with_limit(&app, &id, false, false, None, 4).unwrap();
        assert!(view.sources[0].truncated);
        assert_eq!(view.sources[0].files, 4);
        let connection = open(&app, false).unwrap();
        let old: usize = connection
            .query_row("SELECT count(*) FROM files WHERE path='old.md'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(old, 0);
    }

    #[test]
    fn g10_excerpt_requires_indexed_fresh_file_and_bounded_range() {
        let (_temp, app, root, id) = setup();
        fs::write(root.join("a.md"), "first\nsecond\nthird").unwrap();
        refresh_index_source(&app, &id).unwrap();
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        let hit = search(&app, "first").hits.remove(0);
        let request = || ReadIndexExcerptRequest {
            source_id: id.clone(),
            relative_path: "a.md".into(),
            digest: hit.digest.clone(),
            start_line: 2,
            end_line: 2,
            project: None,
        };
        assert_eq!(
            read_index_excerpt(&app, request()).unwrap().excerpt,
            "second"
        );
        fs::write(root.join("a.md"), "changed").unwrap();
        assert!(matches!(
            read_index_excerpt(&app, request()),
            Err(CoreError::Conflict(_))
        ));
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: false,
            },
        )
        .unwrap();
        assert!(read_index_excerpt(&app, request()).is_err());
    }
    #[test]
    fn g7_queries_do_not_create_storage_and_fts_input_is_literal() {
        let temp = tempfile::tempdir().unwrap();
        // macOS의 /var는 /private/var 링크라 validate_root가 거절한다 — 실제 경로로 시작한다.
        let base = fs::canonicalize(temp.path()).unwrap();
        let app = base.join("absent");
        assert!(get_index_sources(&app, false).unwrap().sources.is_empty());
        assert!(search(&app, "test").hits.is_empty());
        assert!(!app.exists());
        assert!(match_query("\" OR *").unwrap().contains("\"OR\"*"));
        assert!(match_query("  ").is_err());
    }
    #[test]
    fn g7_global_disable_blocks_cached_tools_and_stops_auto_refresh() {
        let (_temp, app, root, id) = setup();
        fs::write(root.join("guide.md"), "initial marker").unwrap();
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        refresh_automatic_sources(&app);
        assert!(get_index_sources(&app, false).unwrap().sources[0]
            .indexed_at
            .is_none());
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: true,
                auto_refresh: true,
            },
        )
        .unwrap();
        refresh_automatic_sources(&app);
        assert_eq!(search(&app, "initial").hits.len(), 1);
        let hit = search(&app, "initial").hits.remove(0);
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: false,
                auto_refresh: true,
            },
        )
        .unwrap();
        fs::write(root.join("guide.md"), "replacement marker").unwrap();
        refresh_automatic_sources(&app);
        assert!(!index_enabled(&app));
        assert!(get_index_sources(&app, true).unwrap().sources.is_empty());
        assert!(search_index(
            &app,
            SearchIndexRequest {
                query: "initial".into(),
                source_id: None,
                limit: None,
                project: None,
            }
        )
        .is_err());
        assert!(read_index_excerpt(
            &app,
            ReadIndexExcerptRequest {
                source_id: id.clone(),
                relative_path: hit.relative_path,
                digest: hit.digest,
                start_line: 1,
                end_line: 1,
                project: None,
            }
        )
        .is_err());
        assert_eq!(get_index_sources(&app, false).unwrap().sources[0].files, 1);
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: true,
                auto_refresh: true,
            },
        )
        .unwrap();
        refresh_automatic_sources(&app);
        assert_eq!(search(&app, "replacement").hits.len(), 1);
    }

    #[test]
    fn project_scope_limits_agent_callers_but_not_the_host() {
        let (temp, app, root, id) = setup();
        fs::write(root.join("guide.md"), "scoped marker").unwrap();
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        refresh_index_source(&app, &id).unwrap();
        let project = temp.path().join("project-a");
        let other = temp.path().join("project-b");
        fs::create_dir_all(project.join("sub")).unwrap();
        fs::create_dir_all(&other).unwrap();
        let caller = |path: &Path| Some(path.to_string_lossy().into_owned());
        let hits = |project: Option<String>| {
            search_index(
                &app,
                SearchIndexRequest {
                    query: "scoped".into(),
                    source_id: None,
                    limit: None,
                    project,
                },
            )
            .unwrap()
            .hits
            .len()
        };
        let listed = |project: Option<String>| {
            list_agent_index_sources(&app, AgentIndexRequest { project })
                .unwrap()
                .sources
                .len()
        };
        // 기본값은 모든 프로젝트다. 프로젝트를 모르는 호출도 그대로 본다.
        assert_eq!(hits(caller(&other)), 1);
        assert_eq!(hits(Some(String::new())), 1);
        assert!(get_index_sources(&app, false).unwrap().sources[0]
            .projects
            .is_none());

        let view = set_index_source_projects(
            &app,
            SetIndexSourceProjectsRequest {
                id: id.clone(),
                projects: Some(vec![project.to_string_lossy().into()]),
            },
        )
        .unwrap();
        assert_eq!(
            view.sources[0].projects.as_deref(),
            Some(
                &[fs::canonicalize(&project)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()][..]
            )
        );
        assert_eq!(hits(caller(&project.join("sub"))), 1);
        assert_eq!(hits(caller(&other)), 0);
        assert_eq!(hits(Some(String::new())), 0);
        assert_eq!(hits(None), 1, "화면·AIA 미리보기는 범위를 따지지 않는다");
        assert_eq!(listed(caller(&project)), 1);
        assert_eq!(listed(caller(&other)), 0);
        assert!(refresh_agent_index_source(
            &app,
            AgentIndexSourceRequest {
                id: id.clone(),
                project: caller(&other),
            },
        )
        .is_err());
        let hit = search(&app, "scoped").hits.remove(0);
        let read = |project: Option<String>| {
            read_index_excerpt(
                &app,
                ReadIndexExcerptRequest {
                    source_id: id.clone(),
                    relative_path: hit.relative_path.clone(),
                    digest: hit.digest.clone(),
                    start_line: 1,
                    end_line: 1,
                    project,
                },
            )
        };
        assert!(read(caller(&other)).is_err());
        assert!(read(caller(&project)).is_ok());

        // 워크트리에서 돈 대화는 본 체크아웃 프로젝트로 맞춘다.
        let worktree = temp.path().join("wt-a");
        fs::create_dir_all(project.join(".git/worktrees/wt-a")).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!(
                "gitdir: {}\n",
                project.join(".git/worktrees/wt-a").display()
            ),
        )
        .unwrap();
        assert_eq!(hits(caller(&worktree)), 1);

        assert!(set_index_source_projects(
            &app,
            SetIndexSourceProjectsRequest {
                id: id.clone(),
                projects: Some(Vec::new()),
            },
        )
        .is_err());
        assert!(set_index_source_projects(
            &app,
            SetIndexSourceProjectsRequest {
                id: id.clone(),
                projects: Some(vec!["relative/path".into()]),
            },
        )
        .is_err());
        set_index_source_projects(&app, SetIndexSourceProjectsRequest { id, projects: None })
            .unwrap();
        assert_eq!(hits(caller(&other)), 1);
    }

    #[test]
    fn old_store_without_project_column_reads_as_all_projects() {
        let (_temp, app, root, id) = setup();
        fs::write(root.join("guide.md"), "legacy marker").unwrap();
        refresh_index_source(&app, &id).unwrap();
        {
            let connection = Connection::open(app.join(DATABASE)).unwrap();
            connection
                .execute_batch(
                    "ALTER TABLE sources DROP COLUMN projects;
                    ALTER TABLE sources DROP COLUMN project_path;
                    ALTER TABLE settings DROP COLUMN project_mode;
                    ALTER TABLE settings DROP COLUMN selected_projects;
                    ALTER TABLE settings DROP COLUMN project_issues;",
                )
                .unwrap();
        }
        let view = get_index_sources(&app, false).unwrap();
        assert!(view.sources[0].projects.is_none());
        assert!(view.sources[0].project_path.is_none());
        assert_eq!(view.project_mode, IndexProjectMode::All);
        set_index_source_enabled(&app, SetIndexSourceEnabledRequest { id, enabled: true }).unwrap();
        let connection = open(&app, false).unwrap();
        for (table, column) in [
            ("sources", "projects"),
            ("sources", "project_path"),
            ("settings", "project_mode"),
            ("settings", "selected_projects"),
            ("settings", "project_issues"),
        ] {
            assert!(
                has_column(&connection, table, column).unwrap(),
                "쓰기 연결이 {table}.{column} 칸을 더한다"
            );
        }
    }

    /// 프로젝트 적용: 인덱스만 켜 둔 저장소와 프로젝트 폴더 셋.
    fn project_setup() -> (tempfile::TempDir, PathBuf, Vec<IndexProject>) {
        let temp = tempfile::tempdir().unwrap();
        // macOS의 /var는 /private/var 링크라 validate_root가 거절한다 — 실제 경로로 시작한다.
        let base = fs::canonicalize(temp.path()).unwrap();
        let app = base.join("app");
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: true,
                auto_refresh: false,
            },
        )
        .unwrap();
        let projects = ["alpha", "beta", "gamma"]
            .iter()
            .map(|name| {
                let path = base.join(name);
                fs::create_dir_all(&path).unwrap();
                fs::write(path.join("notes.md"), format!("{name} orchard marker")).unwrap();
                IndexProject {
                    path: path.to_string_lossy().into_owned(),
                    name: (*name).to_owned(),
                    active: true,
                    exists: true,
                }
            })
            .collect();
        (temp, app, projects)
    }

    fn managed(app: &Path) -> Vec<(String, Option<Vec<String>>, bool)> {
        get_index_sources(app, false)
            .unwrap()
            .sources
            .into_iter()
            .filter(|source| source.project_path.is_some())
            .map(|source| (source.name, source.projects, source.agent_enabled))
            .collect()
    }

    #[test]
    fn project_all_mode_registers_active_projects_and_follows_registry() {
        let (_temp, app, projects) = project_setup();
        assert_eq!(
            get_index_sources(&app, false).unwrap().project_mode,
            IndexProjectMode::All
        );
        sync_index_projects(&app, &projects[..2]).unwrap();
        let view = get_index_sources(&app, false).unwrap();
        assert_eq!(view.sources.len(), 2);
        for source in &view.sources {
            let key = project_key(source.project_path.as_deref().unwrap());
            assert_eq!(source.path, key, "프로젝트 폴더 자체를 등록한다");
            assert_eq!(
                source.projects.as_deref(),
                Some(&[key][..]),
                "그 프로젝트 대화에만 적용"
            );
            assert!(source.agent_enabled);
            assert!(source.indexed_at.is_none());
        }
        index_pending_project_sources_locked(&app);
        assert!(get_index_sources(&app, false)
            .unwrap()
            .sources
            .iter()
            .all(|s| s.files == 1));
        // 같은 목록으로 다시 맞춰도 늘지 않는다.
        sync_index_projects(&app, &projects[..2]).unwrap();
        assert_eq!(managed(&app).len(), 2);
        // 새 프로젝트는 전체 적용이면 자동으로 들어오고, 제외(비활성)한 프로젝트는 색인과 함께 지워진다.
        let mut list = projects.clone();
        list[0].active = false;
        sync_index_projects(&app, &list).unwrap();
        let names = managed(&app).into_iter().map(|m| m.0).collect::<Vec<_>>();
        assert_eq!(names, ["beta", "gamma"]);
        let connection = open(&app, false).unwrap();
        let orphan: usize = connection
            .query_row(
                "SELECT count(*) FROM files WHERE source_id NOT IN (SELECT id FROM sources)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0);
        // 그 프로젝트(하위 폴더 포함)의 에이전트만 본다.
        let caller = format!("{}/sub", projects[1].path);
        let listed = list_agent_index_sources(
            &app,
            AgentIndexRequest {
                project: Some(caller),
            },
        )
        .unwrap()
        .sources;
        assert_eq!(
            listed.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["beta"]
        );
    }

    #[test]
    fn project_selected_mode_keeps_only_chosen_projects() {
        let (_temp, app, projects) = project_setup();
        sync_index_projects(&app, &projects).unwrap();
        assert_eq!(managed(&app).len(), 3);
        let view = set_index_projects(
            &app,
            SetIndexProjectsRequest {
                mode: IndexProjectMode::Selected,
                projects: vec![format!("{}/", projects[0].path)],
            },
        )
        .unwrap();
        assert_eq!(view.project_mode, IndexProjectMode::Selected);
        assert_eq!(view.selected_projects, [project_key(&projects[0].path)]);
        sync_index_projects(&app, &projects).unwrap();
        assert_eq!(
            managed(&app).into_iter().map(|m| m.0).collect::<Vec<_>>(),
            ["alpha"]
        );
        // 선택 적용에서는 새 프로젝트가 저절로 들어오지 않고, 빈 선택은 아무것도 쓰지 않는다.
        set_index_projects(
            &app,
            SetIndexProjectsRequest {
                mode: IndexProjectMode::Selected,
                projects: vec![],
            },
        )
        .unwrap();
        sync_index_projects(&app, &projects).unwrap();
        assert!(managed(&app).is_empty());
        assert!(set_index_projects(
            &app,
            SetIndexProjectsRequest {
                mode: IndexProjectMode::Selected,
                projects: vec!["relative".into()],
            },
        )
        .is_err());
        set_index_projects(
            &app,
            SetIndexProjectsRequest {
                mode: IndexProjectMode::All,
                projects: vec![],
            },
        )
        .unwrap();
        sync_index_projects(&app, &projects).unwrap();
        assert_eq!(managed(&app).len(), 3);
        assert!(get_index_sources(&app, false)
            .unwrap()
            .selected_projects
            .is_empty());
    }

    #[test]
    fn project_sync_respects_disabled_index_restricted_roots_and_manual_folders() {
        let (temp, app, projects) = project_setup();
        // 직접 등록한 폴더와 같은 경로의 프로젝트는 따로 만들지 않는다.
        let manual = add_index_source(
            &app,
            AddIndexSourceRequest {
                name: "Alpha docs".into(),
                path: projects[0].path.clone(),
            },
        )
        .unwrap()
        .sources[0]
            .id
            .clone();
        // 앱 데이터 안 폴더는 등록하지 않고 이유를 남긴다.
        let inside = app.join("inside");
        fs::create_dir_all(&inside).unwrap();
        let mut list = projects.clone();
        list.push(IndexProject {
            path: inside.to_string_lossy().into_owned(),
            name: "inside".into(),
            active: true,
            exists: true,
        });
        sync_index_projects(&app, &list).unwrap();
        let view = get_index_sources(&app, false).unwrap();
        assert_eq!(view.sources.len(), 3, "직접 등록 1 + 자동 2");
        assert_eq!(
            managed(&app).into_iter().map(|m| m.0).collect::<Vec<_>>(),
            ["beta", "gamma"]
        );
        assert_eq!(view.project_issues.len(), 1);
        assert_eq!(view.project_issues[0].path, inside.to_string_lossy());
        // 자동 등록 폴더는 폴더 목록에서 지우거나 끌 수 없다.
        let auto = view
            .sources
            .iter()
            .find(|s| s.project_path.is_some())
            .unwrap()
            .id
            .clone();
        assert!(remove_index_source(&app, &auto).is_err());
        assert!(set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: auto.clone(),
                enabled: false
            }
        )
        .is_err());
        assert!(set_index_source_projects(
            &app,
            SetIndexSourceProjectsRequest {
                id: auto,
                projects: None
            }
        )
        .is_err());
        remove_index_source(&app, &manual).unwrap();
        // 인덱스를 끄면 등록·삭제 모두 하지 않는다.
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: false,
                auto_refresh: false,
            },
        )
        .unwrap();
        sync_index_projects(&app, &[]).unwrap();
        assert_eq!(managed(&app).len(), 2);
        drop(temp);
    }

    #[test]
    fn project_missing_from_registry_is_kept_for_a_grace_period() {
        let (_temp, app, projects) = project_setup();
        sync_index_projects(&app, &projects).unwrap();
        // 등록부에서 빠지거나 폴더가 안 보여도 바로 지우지 않는다(다시 훑지 않도록).
        let mut list = projects[1..].to_vec();
        list[0].exists = false;
        sync_index_projects(&app, &list).unwrap();
        assert_eq!(managed(&app).len(), 3);
        let connection = open(&app, false).unwrap();
        let marked: usize = connection
            .query_row(
                "SELECT count(*) FROM sources WHERE missing_since IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marked, 2, "alpha(빠짐)·beta(폴더 안 보임)");
        drop(connection);
        // 다시 보이면 표시를 지우고, 유예가 지나면 지운다.
        sync_index_projects(&app, &projects[1..]).unwrap();
        let connection = open(&app, true).unwrap();
        connection
            .execute(
                "UPDATE sources SET missing_since=?1 WHERE missing_since IS NOT NULL",
                [crate::clock::now_ms() - MISSING_GRACE_MS - 1],
            )
            .unwrap();
        drop(connection);
        sync_index_projects(&app, &projects[1..]).unwrap();
        assert_eq!(
            managed(&app).into_iter().map(|m| m.0).collect::<Vec<_>>(),
            ["beta", "gamma"]
        );
    }

    #[test]
    fn project_inside_another_project_is_covered_by_the_outer_folder() {
        let (_temp, app, projects) = project_setup();
        let nested = Path::new(&projects[0].path).join("worktree");
        fs::create_dir_all(&nested).unwrap();
        let mut list = vec![IndexProject {
            path: nested.to_string_lossy().into_owned(),
            name: "alpha-worktree".into(),
            active: true,
            exists: true,
        }];
        sync_index_projects(&app, &list).unwrap();
        assert_eq!(
            managed(&app).len(),
            1,
            "바깥 프로젝트가 없으면 안쪽도 등록한다"
        );
        list.push(projects[0].clone());
        sync_index_projects(&app, &list).unwrap();
        assert_eq!(
            managed(&app).into_iter().map(|m| m.0).collect::<Vec<_>>(),
            ["alpha"]
        );
        // 안쪽 대화도 바깥 폴더 범위에 든다.
        let listed = list_agent_index_sources(
            &app,
            AgentIndexRequest {
                project: Some(nested.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        assert_eq!(listed.sources.len(), 1);
        assert!(listed.selected_projects.is_empty() && listed.project_issues.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn project_first_index_failure_is_recorded_and_not_retried_every_cycle() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, app, projects) = project_setup();
        let locked = Path::new(&projects[0].path).join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&locked).is_ok() {
            // root 로 도는 실행기에서는 권한으로 막을 수 없다.
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        sync_index_projects(&app, &projects[..1]).unwrap();
        index_pending_project_sources_locked(&app);
        let source = get_index_sources(&app, false).unwrap().sources.remove(0);
        assert!(source.indexed_at.is_none());
        assert!(source.last_error.is_some(), "실패 이유를 남긴다");
        let first = source.error_at;
        index_pending_project_sources_locked(&app);
        let again = get_index_sources(&app, false).unwrap().sources.remove(0);
        assert_eq!(again.error_at, first, "30분 안에는 다시 훑지 않는다");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn manual_outer_folder_covers_inner_projects_only_when_agents_can_see_it() {
        let (_temp, app, projects) = project_setup();
        let inner = Path::new(&projects[0].path).join("sub");
        fs::create_dir_all(&inner).unwrap();
        let list = vec![
            projects[0].clone(),
            IndexProject {
                path: inner.to_string_lossy().into_owned(),
                name: "alpha-sub".into(),
                active: true,
                exists: true,
            },
        ];
        // 같은 경로를 직접 등록했지만 에이전트 사용이 꺼져 있으면 안쪽 프로젝트는 따로 등록한다.
        let manual = add_index_source(
            &app,
            AddIndexSourceRequest {
                name: "Alpha".into(),
                path: projects[0].path.clone(),
            },
        )
        .unwrap()
        .sources[0]
            .id
            .clone();
        sync_index_projects(&app, &list).unwrap();
        assert_eq!(
            managed(&app).into_iter().map(|m| m.0).collect::<Vec<_>>(),
            ["alpha-sub"]
        );
        // 켜고 모든 프로젝트에 적용하면 바깥 폴더가 덮어 안쪽 자동 등록을 걷는다.
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: manual,
                enabled: true,
            },
        )
        .unwrap();
        sync_index_projects(&app, &list).unwrap();
        assert!(managed(&app).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn project_auto_refresh_failure_waits_like_a_success() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, app, projects) = project_setup();
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: true,
                auto_refresh: true,
            },
        )
        .unwrap();
        sync_index_projects(&app, &projects[..1]).unwrap();
        index_pending_project_sources_locked(&app);
        let locked = Path::new(&projects[0].path).join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&locked).is_ok() {
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let stale = crate::clock::now_ms() - PROJECT_REFRESH_MS - 1;
        open(&app, true)
            .unwrap()
            .execute("UPDATE sources SET indexed_at=?1", [stale])
            .unwrap();
        refresh_automatic_sources(&app);
        let failed = get_index_sources(&app, false).unwrap().sources.remove(0);
        assert!(failed.last_error.is_some());
        let at = failed.error_at;
        refresh_automatic_sources(&app);
        assert_eq!(
            get_index_sources(&app, false)
                .unwrap()
                .sources
                .remove(0)
                .error_at,
            at,
            "실패 뒤에도 10분은 다시 훑지 않는다"
        );
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
