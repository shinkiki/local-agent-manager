use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use walkdir::WalkDir;

use crate::chat::identifier_value_is_valid;
use crate::domain::{
    AgentDefinition, AgentDetail, ArtifactDetail, ArtifactGroup, ArtifactSummary, ContentBlock,
    DashboardStats, FileNode, ManagerSnapshot, ModelCount, ProjectCount, ProviderId,
    SessionCatalogUpdate, SessionDetail, SessionInfoBlock, SessionMeta, SessionSummary,
    SessionTranscriptLimit, SkillDetail, SkillSummary, SourceCounts, SourceTotals, StorageOverview,
    StorageUsageItem, TokenUsage, TranscriptItem, WeeklyCount,
};
use crate::providers::inspect_local_environment;
use crate::store;
use crate::{linked_file, CoreError, LinkedFile, LinkedFileDownload};

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const ACTIVE_AG_ROOTS: &[&str] = &["antigravity", "antigravity-cli", "antigravity-ide"];
const ALL_AG_ROOTS: &[&str] = &[
    "antigravity",
    "antigravity-cli",
    "antigravity-ide",
    "antigravity-backup",
];
const MAX_BLOCK_TEXT: usize = 100_000;
// v3: 스캔이 "<synthetic>" 같은 비식별자 모델을 버리도록 바뀌어 기존 캐시를 재스캔해야 한다.
const SESSION_CATALOG_SCHEMA_VERSION: u32 = 3;
const SESSION_CATALOG_FILE_NAME: &str = "session-catalog-v2.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    size_bytes: u64,
    modified_at: Option<i64>,
    prefix_bytes: u64,
    prefix_hash: u64,
    tail_bytes: u64,
    tail_hash: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeScanState {
    parsed_bytes: u64,
    custom_title: Option<String>,
    ai_title: Option<String>,
    first_user: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    model: Option<String>,
    started_at: Option<i64>,
    updated_at: Option<i64>,
    message_count: u64,
    tokens: TokenUsage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeCatalogEntry {
    path: String,
    fingerprint: FileFingerprint,
    scan: ClaudeScanState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionCatalog {
    schema_version: u32,
    revision: u64,
    #[serde(default)]
    claude: Vec<ClaudeCatalogEntry>,
    codex_fingerprint: BTreeMap<String, FileFingerprint>,
    #[serde(default)]
    codex_sessions: Vec<SessionSummary>,
    antigravity_fingerprint: BTreeMap<String, FileFingerprint>,
    #[serde(default)]
    antigravity_sessions: Vec<SessionSummary>,
}

impl Default for PersistedSessionCatalog {
    fn default() -> Self {
        Self {
            schema_version: SESSION_CATALOG_SCHEMA_VERSION,
            revision: 0,
            claude: Vec::new(),
            codex_fingerprint: BTreeMap::new(),
            codex_sessions: Vec::new(),
            antigravity_fingerprint: BTreeMap::new(),
            antigravity_sessions: Vec::new(),
        }
    }
}

struct SessionCatalogState {
    persisted: PersistedSessionCatalog,
    snapshot: ManagerSnapshot,
    resource_revision: u64,
}

#[derive(Clone)]
pub struct SessionCatalog {
    app_data_dir: Arc<PathBuf>,
    home: Arc<PathBuf>,
    reconcile_lock: Arc<Mutex<()>>,
    state: Arc<RwLock<SessionCatalogState>>,
}

impl SessionCatalog {
    pub fn open(app_data_dir: PathBuf) -> Result<Self, CoreError> {
        let home = home_dir()?;
        Self::open_with_home(app_data_dir, home)
    }

    pub(crate) fn open_with_home(app_data_dir: PathBuf, home: PathBuf) -> Result<Self, CoreError> {
        fs::create_dir_all(&app_data_dir)?;
        let cache_path = app_data_dir.join(SESSION_CATALOG_FILE_NAME);
        let cached = load_persisted_session_catalog(&cache_path);
        let mut persisted = cached.unwrap_or_default();
        if persisted.schema_version != SESSION_CATALOG_SCHEMA_VERSION {
            persisted = PersistedSessionCatalog::default();
        }
        if persisted.revision == 0 {
            reconcile_provider_cache(&home, &mut persisted, None, None)?;
            persisted.revision = 1;
            persist_session_catalog(&cache_path, &persisted)?;
        }
        let snapshot = compose_manager_snapshot(&home, &app_data_dir, &persisted, None)?;
        Ok(Self {
            app_data_dir: Arc::new(app_data_dir),
            home: Arc::new(home),
            reconcile_lock: Arc::new(Mutex::new(())),
            state: Arc::new(RwLock::new(SessionCatalogState {
                persisted,
                snapshot,
                resource_revision: 1,
            })),
        })
    }

    pub fn manager_snapshot(&self) -> Result<ManagerSnapshot, CoreError> {
        self.state
            .read()
            .map(|state| state.snapshot.clone())
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))
    }

    pub fn session_summary(
        &self,
        source: ProviderId,
        id: &str,
    ) -> Result<SessionSummary, CoreError> {
        validate_identifier(id)?;
        self.state
            .read()
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))?
            .snapshot
            .sessions
            .iter()
            .find(|session| session.source == source && session.id == id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("세션을 찾을 수 없습니다".to_owned()))
    }

    pub fn linked_file(
        &self,
        source: ProviderId,
        id: &str,
        href: &str,
    ) -> Result<LinkedFile, CoreError> {
        let session = self.session_summary(source, id)?;
        let cwd = session
            .cwd
            .ok_or_else(|| CoreError::InvalidInput("세션 작업 경로가 없습니다".to_owned()))?;
        linked_file::read_linked_file(Path::new(&cwd), href)
    }

    pub fn linked_file_download(
        &self,
        source: ProviderId,
        id: &str,
        href: &str,
    ) -> Result<LinkedFileDownload, CoreError> {
        let session = self.session_summary(source, id)?;
        let cwd = session
            .cwd
            .ok_or_else(|| CoreError::InvalidInput("세션 작업 경로가 없습니다".to_owned()))?;
        linked_file::read_linked_file_download(Path::new(&cwd), href)
    }

    pub fn reconcile(&self) -> Result<SessionCatalogUpdate, CoreError> {
        self.reconcile_scoped(None, None)
    }

    fn reconcile_scoped(
        &self,
        source: Option<ProviderId>,
        target_id: Option<&str>,
    ) -> Result<SessionCatalogUpdate, CoreError> {
        let _reconcile = self.reconcile_lock.lock().map_err(|_| {
            CoreError::Runtime("세션 카탈로그 조정 잠금이 손상되었습니다".to_owned())
        })?;
        let (mut persisted, previous) = self
            .state
            .read()
            .map(|state| (state.persisted.clone(), state.snapshot.clone()))
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        let provider_cache_changed =
            reconcile_provider_cache(&self.home, &mut persisted, source, target_id)?;
        let mut next =
            compose_manager_snapshot(&self.home, &self.app_data_dir, &persisted, Some(&previous))?;
        let changed = next.sessions != previous.sessions || next.folders != previous.folders;
        if changed {
            persisted.revision = persisted.revision.saturating_add(1);
        }
        next.session_catalog_revision = persisted.revision;
        if provider_cache_changed || changed {
            persist_session_catalog(
                &self.app_data_dir.join(SESSION_CATALOG_FILE_NAME),
                &persisted,
            )?;
        }
        let revision = persisted.revision;
        let mut state = self
            .state
            .write()
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        state.persisted = persisted;
        state.snapshot = next;
        Ok(SessionCatalogUpdate { revision, changed })
    }

    pub fn refresh_session(
        &self,
        source: ProviderId,
        id: &str,
    ) -> Result<SessionCatalogUpdate, CoreError> {
        validate_identifier(id)?;
        self.reconcile_scoped(Some(source), Some(id))
    }

    pub fn refresh_resources(&self) -> Result<SessionCatalogUpdate, CoreError> {
        let _reconcile = self.reconcile_lock.lock().map_err(|_| {
            CoreError::Runtime("리소스 카탈로그 조정 잠금이 손상되었습니다".to_owned())
        })?;
        let (persisted, previous, previous_revision) = self
            .state
            .read()
            .map(|state| {
                (
                    state.persisted.clone(),
                    state.snapshot.clone(),
                    state.resource_revision,
                )
            })
            .map_err(|_| CoreError::Runtime("리소스 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        let mut next = compose_manager_snapshot(&self.home, &self.app_data_dir, &persisted, None)?;
        let changed = next.status != previous.status
            || next.skills != previous.skills
            || next.agents != previous.agents
            || next.artifacts != previous.artifacts;
        let revision = if changed {
            previous_revision.saturating_add(1)
        } else {
            previous_revision
        };
        next.session_catalog_revision = previous.session_catalog_revision;
        next.resource_catalog_revision = revision;
        let mut state = self
            .state
            .write()
            .map_err(|_| CoreError::Runtime("리소스 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        state.snapshot = next;
        state.resource_revision = revision;
        Ok(SessionCatalogUpdate { revision, changed })
    }

    pub fn refresh_metadata(&self) -> Result<SessionCatalogUpdate, CoreError> {
        let _reconcile = self.reconcile_lock.lock().map_err(|_| {
            CoreError::Runtime("세션 카탈로그 조정 잠금이 손상되었습니다".to_owned())
        })?;
        let (mut persisted, previous) = self
            .state
            .read()
            .map(|state| (state.persisted.clone(), state.snapshot.clone()))
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        let mut next =
            compose_manager_snapshot(&self.home, &self.app_data_dir, &persisted, Some(&previous))?;
        let changed = next.sessions != previous.sessions || next.folders != previous.folders;
        if changed {
            persisted.revision = persisted.revision.saturating_add(1);
            persist_session_catalog(
                &self.app_data_dir.join(SESSION_CATALOG_FILE_NAME),
                &persisted,
            )?;
        }
        let revision = persisted.revision;
        next.session_catalog_revision = revision;
        let mut state = self
            .state
            .write()
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        state.persisted = persisted;
        state.snapshot = next;
        Ok(SessionCatalogUpdate { revision, changed })
    }
}

fn load_persisted_session_catalog(path: &Path) -> Option<PersistedSessionCatalog> {
    let file = File::open(path).ok()?;
    serde_json::from_reader(BufReader::new(file)).ok()
}

fn persist_session_catalog(
    path: &Path,
    catalog: &PersistedSessionCatalog,
) -> Result<(), CoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("세션 카탈로그 경로가 잘못되었습니다".to_owned()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{SESSION_CATALOG_FILE_NAME}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), CoreError> {
        let mut file = File::create(&temporary)?;
        serde_json::to_writer(&mut file, catalog)?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn compose_manager_snapshot(
    home: &Path,
    app_data_dir: &Path,
    persisted: &PersistedSessionCatalog,
    previous: Option<&ManagerSnapshot>,
) -> Result<ManagerSnapshot, CoreError> {
    let metadata = store::load_metadata(app_data_dir)?;
    let mut sessions = raw_catalog_sessions(persisted);
    sessions.retain(|session| !is_aia_workspace_session(session, app_data_dir));
    sessions = dedupe_sessions_by_identity(sessions);
    for session in &mut sessions {
        apply_session_metadata(session, &metadata.sessions);
    }
    sessions.sort_by_key(|session| Reverse(session.updated_at));

    let (status, skills, agents) = if let Some(previous) = previous {
        (
            previous.status.clone(),
            previous.skills.clone(),
            previous.agents.clone(),
        )
    } else {
        let mut skills = list_skills_from_home(home);
        skills.sort_by_key(|skill| skill.name.to_lowercase());
        let mut agents = list_agents_from_home(home);
        agents.sort_by_key(|agent| agent.name.to_lowercase());
        (inspect_local_environment()?, skills, agents)
    };
    let artifacts = list_artifacts_from_home(home, &sessions);
    let dashboard = build_dashboard(&sessions, skills.len(), agents.len());
    let folders = store::folders_with_counts(&metadata);

    Ok(ManagerSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        session_catalog_revision: persisted.revision,
        resource_catalog_revision: previous
            .map(|snapshot| snapshot.resource_catalog_revision)
            .unwrap_or(1),
        status,
        dashboard,
        sessions,
        folders,
        skills,
        agents,
        artifacts,
    })
}

fn is_aia_workspace_session(session: &SessionSummary, app_data_dir: &Path) -> bool {
    let Some(cwd) = session.cwd.as_deref() else {
        return false;
    };
    let cwd = Path::new(cwd);
    let aia_workspace = app_data_dir.join("aia-workspace");
    match (fs::canonicalize(cwd), fs::canonicalize(&aia_workspace)) {
        (Ok(cwd), Ok(aia_workspace)) => cwd == aia_workspace,
        _ => cwd == aia_workspace,
    }
}

fn raw_catalog_sessions(persisted: &PersistedSessionCatalog) -> Vec<SessionSummary> {
    let mut sessions = persisted
        .claude
        .iter()
        .map(claude_summary_from_entry)
        .collect::<Vec<_>>();
    sessions.extend(persisted.codex_sessions.clone());
    sessions.extend(persisted.antigravity_sessions.clone());
    sessions
}

/// 같은 공급자의 같은 세션 ID는 하나의 논리 세션이므로 목록에 한 번만 남긴다.
/// macOS는 한글 경로를 NFD로 정규화해 저장하므로 `~/.claude/projects` 아래에
/// 같은 작업 경로가 NFC/NFD 두 디렉터리로 갈라지고 같은 세션 기록이 양쪽에 남을 수 있다.
/// 이때 최신·완전한 쪽을 결정론적으로 남겨 새로고침마다 순서가 흔들리지 않게 한다.
fn dedupe_sessions_by_identity(sessions: Vec<SessionSummary>) -> Vec<SessionSummary> {
    let mut positions: HashMap<(ProviderId, String), usize> = HashMap::new();
    let mut deduped: Vec<SessionSummary> = Vec::with_capacity(sessions.len());
    for session in sessions {
        let key = (session.source, session.id.clone());
        match positions.get(&key) {
            Some(&index) => {
                if prefers_session(&session, &deduped[index]) {
                    deduped[index] = session;
                }
            }
            None => {
                positions.insert(key, deduped.len());
                deduped.push(session);
            }
        }
    }
    deduped
}

/// 같은 논리 세션의 후보 중 남길 항목을 고른다. 최근 갱신 → 더 많은 메시지 →
/// 더 큰 파일 순으로 비교하고, 모두 같으면 파일 경로가 앞서는 쪽을 남겨 결과를 고정한다.
fn prefers_session(candidate: &SessionSummary, current: &SessionSummary) -> bool {
    match session_completeness(candidate).cmp(&session_completeness(current)) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => candidate.file_path < current.file_path,
    }
}

fn session_completeness(session: &SessionSummary) -> (i64, u64, u64) {
    (
        session.updated_at.unwrap_or(i64::MIN),
        session.message_count.unwrap_or_default(),
        session.size_bytes.unwrap_or_default(),
    )
}

pub fn load_manager_snapshot(app_data_dir: &Path) -> Result<ManagerSnapshot, CoreError> {
    SessionCatalog::open(app_data_dir.to_path_buf())?.manager_snapshot()
}

pub fn load_session_summary(
    app_data_dir: &Path,
    source: ProviderId,
    id: &str,
) -> Result<SessionSummary, CoreError> {
    validate_identifier(id)?;
    let home = home_dir()?;
    let metadata = store::load_metadata(app_data_dir)?;
    let mut session = match source {
        ProviderId::Claude => find_claude_session(&home, id),
        ProviderId::Codex => find_codex_session(&home, id),
        ProviderId::Antigravity => find_antigravity_session(&home, id),
    }
    .ok_or_else(|| CoreError::NotFound("세션을 찾을 수 없습니다".to_owned()))?;
    apply_session_metadata(&mut session, &metadata.sessions);
    Ok(session)
}

pub fn load_session_detail(
    app_data_dir: &Path,
    source: ProviderId,
    id: &str,
) -> Result<SessionDetail, CoreError> {
    load_session_detail_with_limit(app_data_dir, source, id, SessionTranscriptLimit::default())
}

pub fn load_session_detail_with_limit(
    app_data_dir: &Path,
    source: ProviderId,
    id: &str,
    transcript_limit: SessionTranscriptLimit,
) -> Result<SessionDetail, CoreError> {
    load_session_detail_window(app_data_dir, source, id, transcript_limit, None)
}

/// 이미 표시한 가장 오래된 항목(before_index) 이전 구간을 표시 범위 크기만큼 반환한다.
/// 보완 저장 결과는 최신 구간에서만 병합되므로 이전 구간은 원본 기록만 담는다.
pub fn load_session_transcript_before(
    app_data_dir: &Path,
    source: ProviderId,
    id: &str,
    transcript_limit: SessionTranscriptLimit,
    before_index: usize,
) -> Result<SessionDetail, CoreError> {
    load_session_detail_window(
        app_data_dir,
        source,
        id,
        transcript_limit,
        Some(before_index),
    )
}

fn load_session_detail_window(
    app_data_dir: &Path,
    source: ProviderId,
    id: &str,
    transcript_limit: SessionTranscriptLimit,
    before_index: Option<usize>,
) -> Result<SessionDetail, CoreError> {
    validate_identifier(id)?;
    let home = home_dir()?;
    let metadata = store::load_metadata(app_data_dir)?;
    let mut session = match source {
        ProviderId::Claude => find_claude_session(&home, id),
        ProviderId::Codex => find_codex_session(&home, id),
        ProviderId::Antigravity => find_antigravity_session(&home, id),
    }
    .ok_or_else(|| CoreError::NotFound("세션을 찾을 수 없습니다".to_owned()))?;
    apply_session_metadata(&mut session, &metadata.sessions);

    let supplements = if before_index.is_none() {
        store::captured_turns_for(app_data_dir, source, id)?
    } else {
        Vec::new()
    };

    if !session.readable {
        let (transcript, truncated) = apply_transcript_limit(
            merge_captured_turns(Vec::new(), supplements, 0),
            transcript_limit,
        );
        return Ok(SessionDetail {
            session,
            transcript: if before_index.is_some() {
                Vec::new()
            } else {
                transcript
            },
            truncated: before_index.is_none() && truncated,
            skipped_lines: 0,
            unavailable_reason: Some(
                "Antigravity가 암호화한 .pb 대화는 메타데이터와 아티팩트만 표시합니다.".to_owned(),
            ),
        });
    }

    let parse_limit = transcript_limit
        .max_items()
        .map(|limit| limit.saturating_add(supplements.len()));
    let parsed = match source {
        ProviderId::Claude => {
            parse_claude_transcript(Path::new(&session.file_path), parse_limit, before_index)?
        }
        ProviderId::Codex => {
            parse_codex_transcript(Path::new(&session.file_path), parse_limit, before_index)?
        }
        ProviderId::Antigravity => {
            parse_antigravity_transcript(Path::new(&session.file_path), parse_limit, before_index)?
        }
    };

    if before_index.is_some() {
        return Ok(SessionDetail {
            session,
            transcript: parsed.items,
            truncated: parsed.truncated,
            skipped_lines: parsed.skipped_lines,
            unavailable_reason: parsed.unavailable_reason,
        });
    }

    let (transcript, merged_truncated) = apply_transcript_limit(
        merge_captured_turns(parsed.items, supplements, parsed.total_items),
        transcript_limit,
    );

    Ok(SessionDetail {
        session,
        transcript,
        truncated: parsed.truncated || merged_truncated,
        skipped_lines: parsed.skipped_lines,
        unavailable_reason: parsed.unavailable_reason,
    })
}

pub fn load_storage_overview(app_data_dir: &Path) -> Result<StorageOverview, CoreError> {
    let home = home_dir()?;
    let source_items = vec![
        storage_usage_item(
            "claude",
            "Claude 대화 원본",
            "Claude가 작성한 프로젝트별 세션 기록 · 읽기 전용",
            &[home.join(".claude/projects")],
        ),
        storage_usage_item(
            "codex",
            "Codex 대화 원본",
            "Codex rollout과 세션 색인 · 읽기 전용",
            &[
                home.join(".codex/sessions"),
                home.join(".codex/archived_sessions"),
                home.join(".codex/state_5.sqlite"),
            ],
        ),
        storage_usage_item(
            "antigravity",
            "Antigravity 대화 원본",
            "대화 단계와 세션 요약 DB · 읽기 전용",
            &[
                home.join(".gemini/antigravity/conversations"),
                home.join(".gemini/antigravity-cli/conversations"),
                home.join(".gemini/antigravity-ide/conversations"),
                home.join(".gemini/antigravity-cli/conversation_summaries.db"),
            ],
        ),
    ];
    let manager_items = vec![storage_usage_item(
        "agent-manager",
        "Agent Manager 상태",
        "메타데이터 · 반복 요청 · 보완 응답을 포함한 자체 저장소",
        &[app_data_dir.to_path_buf()],
    )];
    let source_total_bytes = source_items.iter().map(|item| item.size_bytes).sum();
    let manager_total_bytes = manager_items.iter().map(|item| item.size_bytes).sum();
    Ok(StorageOverview {
        source_total_bytes,
        manager_total_bytes,
        total_bytes: source_total_bytes.saturating_add(manager_total_bytes),
        source_items,
        manager_items,
        supplements: store::supplement_storage_stats(app_data_dir)?,
    })
}

pub fn load_skill_detail(id: &str) -> Result<SkillDetail, CoreError> {
    let home = home_dir()?;
    let skill = list_skills_from_home(&home)
        .into_iter()
        .find(|skill| skill.id == id)
        .ok_or_else(|| CoreError::NotFound("스킬을 찾을 수 없습니다".to_owned()))?;
    let text = read_text_limited(Path::new(&skill.path), 5 * 1024 * 1024)?;
    let (_, body) = split_frontmatter(&text);
    let files = build_file_tree(Path::new(&skill.directory), 5_000)?;
    Ok(SkillDetail {
        skill,
        body: body.trim().to_owned(),
        files,
    })
}

pub fn load_agent_detail(name: &str) -> Result<AgentDetail, CoreError> {
    if name.is_empty() || name.len() > 200 {
        return Err(CoreError::InvalidInput(
            "잘못된 에이전트 이름입니다".to_owned(),
        ));
    }
    let home = home_dir()?;
    let definition = list_agents_from_home(&home)
        .into_iter()
        .find(|agent| agent.name == name)
        .ok_or_else(|| CoreError::NotFound("에이전트를 찾을 수 없습니다".to_owned()))?;
    let text = read_text_limited(Path::new(&definition.path), 5 * 1024 * 1024)?;
    let (_, body) = split_frontmatter(&text);
    Ok(AgentDetail {
        definition,
        body: body.trim().to_owned(),
    })
}

pub fn load_artifact_detail(
    conversation_id: &str,
    root_name: &str,
    name: &str,
) -> Result<ArtifactDetail, CoreError> {
    validate_identifier(conversation_id)?;
    if !ALL_AG_ROOTS.contains(&root_name) || !safe_file_name(name) || !name.ends_with(".md") {
        return Err(CoreError::InvalidInput(
            "잘못된 아티팩트 경로입니다".to_owned(),
        ));
    }
    let home = home_dir()?;
    let directory = home
        .join(".gemini")
        .join(root_name)
        .join("brain")
        .join(conversation_id);
    let path = guarded_child(&directory, Path::new(name), true)?;
    let artifact = artifact_from_file(conversation_id, root_name, &directory, &path)?;
    let content = read_text_limited(&path, 5 * 1024 * 1024)?;
    Ok(ArtifactDetail { artifact, content })
}

fn home_dir() -> Result<PathBuf, CoreError> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(CoreError::HomeDirectoryUnavailable)
}

fn storage_usage_item(
    id: &str,
    label: &str,
    description: &str,
    paths: &[PathBuf],
) -> StorageUsageItem {
    let (size_bytes, file_count) = measure_storage_paths(paths);
    StorageUsageItem {
        id: id.to_owned(),
        label: label.to_owned(),
        description: description.to_owned(),
        size_bytes,
        file_count,
    }
}

fn measure_storage_paths(paths: &[PathBuf]) -> (u64, u64) {
    let mut size_bytes = 0_u64;
    let mut file_count = 0_u64;
    for path in paths {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            continue;
        };
        if metadata.is_file() {
            size_bytes = size_bytes.saturating_add(metadata.len());
            file_count = file_count.saturating_add(1);
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        for entry in WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Ok(metadata) = entry.metadata() {
                size_bytes = size_bytes.saturating_add(metadata.len());
                file_count = file_count.saturating_add(1);
            }
        }
    }
    (size_bytes, file_count)
}

fn merge_captured_turns(
    mut transcript: Vec<TranscriptItem>,
    captured_turns: Vec<store::CapturedTranscriptTurn>,
    mut next_index: usize,
) -> Vec<TranscriptItem> {
    let mut known_texts = transcript
        .iter()
        .flat_map(|item| item.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(normalized_transcript_text(text)),
            _ => None,
        })
        .collect::<HashSet<_>>();
    for turn in captured_turns {
        let text = cap_text(turn.text, MAX_BLOCK_TEXT);
        if text.trim().is_empty() || !known_texts.insert(normalized_transcript_text(&text)) {
            continue;
        }
        let type_label = match turn.origin {
            store::SupplementOrigin::Chat => "보완 저장 결과",
            store::SupplementOrigin::Scheduled => "반복 실행 결과",
        };
        transcript.push(TranscriptItem {
            index: next_index,
            role: "assistant".to_owned(),
            timestamp: Some(turn.completed_at),
            model: None,
            type_label: Some(type_label.to_owned()),
            blocks: vec![ContentBlock::Text { text }],
            usage: None,
        });
        next_index += 1;
    }
    transcript.sort_by_key(|item| item.timestamp.unwrap_or(i64::MIN));
    transcript
}

fn apply_transcript_limit(
    mut transcript: Vec<TranscriptItem>,
    limit: SessionTranscriptLimit,
) -> (Vec<TranscriptItem>, bool) {
    let Some(max_items) = limit.max_items() else {
        return (transcript, false);
    };
    if transcript.len() <= max_items {
        return (transcript, false);
    }
    let keep_from = transcript.len() - max_items;
    transcript.drain(..keep_from);
    (transcript, true)
}

fn normalized_transcript_text(text: &str) -> String {
    text.trim().to_owned()
}

fn reconcile_provider_cache(
    home: &Path,
    persisted: &mut PersistedSessionCatalog,
    source: Option<ProviderId>,
    target_id: Option<&str>,
) -> Result<bool, CoreError> {
    let mut changed = false;

    if source.is_none() || source == Some(ProviderId::Claude) {
        if let Some(id) = target_id {
            return reconcile_claude_target(home, persisted, id);
        }
        let previous_entries = std::mem::take(&mut persisted.claude);
        let mut previous_claude = previous_entries
            .into_iter()
            .map(|entry| (entry.path.clone(), entry))
            .collect::<HashMap<_, _>>();
        let mut next_claude = Vec::new();
        let mut claude_changed = false;
        for path in claude_session_paths(home) {
            let path_text = path.to_string_lossy().into_owned();
            let fingerprint = fingerprint_file(&path)?;
            let previous = previous_claude.remove(&path_text);
            let entry = if previous
                .as_ref()
                .is_some_and(|entry| entry.fingerprint == fingerprint)
            {
                previous.expect("checked above")
            } else {
                claude_changed = true;
                scan_claude_catalog_entry(&path, fingerprint, previous.as_ref())?
            };
            next_claude.push(entry);
        }
        next_claude.sort_by(|left, right| left.path.cmp(&right.path));
        if !previous_claude.is_empty() {
            claude_changed = true;
        }
        if claude_changed {
            changed = true;
        }
        persisted.claude = next_claude;
    }

    if source.is_none() || source == Some(ProviderId::Codex) {
        let codex_fingerprint = codex_provider_fingerprint(home)?;
        if codex_fingerprint != persisted.codex_fingerprint {
            persisted.codex_sessions = list_codex_sessions(home);
            persisted.codex_fingerprint = codex_fingerprint;
            changed = true;
        }
    }

    if source.is_none() || source == Some(ProviderId::Antigravity) {
        let antigravity_fingerprint = antigravity_provider_fingerprint(home)?;
        if antigravity_fingerprint != persisted.antigravity_fingerprint {
            persisted.antigravity_sessions = list_antigravity_sessions(home);
            persisted.antigravity_fingerprint = antigravity_fingerprint;
            changed = true;
        }
    }
    Ok(changed)
}

fn reconcile_claude_target(
    home: &Path,
    persisted: &mut PersistedSessionCatalog,
    id: &str,
) -> Result<bool, CoreError> {
    let Some(path) = find_claude_session_path(home, id) else {
        let before = persisted.claude.len();
        persisted
            .claude
            .retain(|entry| claude_entry_id(entry) != Some(id));
        return Ok(persisted.claude.len() != before);
    };
    // 같은 ID의 기록 파일이 여러 디렉터리에 있을 수 있으므로 파일 경로로 대상을 찾는다.
    // 파일 이름만 비교하면 다른 파일의 스캔 결과를 엉뚱한 항목에 덮어써 사본이 생긴다.
    let path_text = path.to_string_lossy().into_owned();
    let previous_index = persisted
        .claude
        .iter()
        .position(|entry| entry.path == path_text);
    let fingerprint = fingerprint_file(&path)?;
    let previous = previous_index.map(|index| persisted.claude[index].clone());
    if previous
        .as_ref()
        .is_some_and(|entry| entry.fingerprint == fingerprint)
    {
        return Ok(false);
    }
    let entry = scan_claude_catalog_entry(&path, fingerprint, previous.as_ref())?;
    if let Some(index) = previous_index {
        persisted.claude[index] = entry;
    } else {
        persisted.claude.push(entry);
        persisted
            .claude
            .sort_by(|left, right| left.path.cmp(&right.path));
    }
    Ok(true)
}

fn claude_session_paths(home: &Path) -> Vec<PathBuf> {
    let root = home.join(".claude/projects");
    let Ok(projects) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(project.path()) else {
            continue;
        };
        paths.extend(files.flatten().filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("jsonl")).then_some(path)
        }));
    }
    paths.sort();
    paths
}

/// 같은 세션 기록이 여러 프로젝트 디렉터리(NFC/NFD 정규화 차이 등)에 남아 있어도
/// 항상 같은 파일을 고르도록 최근 수정 → 큰 파일 → 앞선 경로 순으로 결정한다.
/// 디렉터리 순회 순서에 기대면 목록과 상세 화면이 서로 다른 파일을 볼 수 있다.
fn find_claude_session_path(home: &Path, id: &str) -> Option<PathBuf> {
    let projects = fs::read_dir(home.join(".claude/projects")).ok()?;
    let mut best: Option<((i64, u64), PathBuf)> = None;
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let candidate = project.path().join(format!("{id}.jsonl"));
        let Ok(metadata) = fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let rank = (
            system_time_ms(metadata.modified().ok()).unwrap_or(i64::MIN),
            metadata.len(),
        );
        let better = match best.as_ref() {
            Some((best_rank, best_path)) => match rank.cmp(best_rank) {
                Ordering::Greater => true,
                Ordering::Less => false,
                Ordering::Equal => candidate < *best_path,
            },
            None => true,
        };
        if better {
            best = Some((rank, candidate));
        }
    }
    best.map(|(_, path)| path)
}

fn claude_entry_id(entry: &ClaudeCatalogEntry) -> Option<&str> {
    Path::new(&entry.path)
        .file_stem()
        .and_then(|value| value.to_str())
}

fn fingerprint_file(path: &Path) -> Result<FileFingerprint, CoreError> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let mut prefix = [0_u8; 4096];
    let read = file.read(&mut prefix)?;
    let tail_bytes = metadata.len().min(4096);
    file.seek(SeekFrom::Start(metadata.len().saturating_sub(tail_bytes)))?;
    let mut tail = vec![0_u8; tail_bytes as usize];
    file.read_exact(&mut tail)?;
    Ok(FileFingerprint {
        size_bytes: metadata.len(),
        modified_at: system_time_ms(metadata.modified().ok()),
        prefix_bytes: read as u64,
        prefix_hash: fnv1a(&prefix[..read]),
        tail_bytes,
        tail_hash: fnv1a(&tail),
    })
}

fn fingerprint_paths(
    paths: impl IntoIterator<Item = PathBuf>,
) -> Result<BTreeMap<String, FileFingerprint>, CoreError> {
    let mut fingerprints = BTreeMap::new();
    for path in paths {
        if path.is_file() {
            fingerprints.insert(
                path.to_string_lossy().into_owned(),
                fingerprint_file(&path)?,
            );
        }
    }
    Ok(fingerprints)
}

fn codex_provider_fingerprint(home: &Path) -> Result<BTreeMap<String, FileFingerprint>, CoreError> {
    let database = home.join(".codex/state_5.sqlite");
    fingerprint_paths([
        database.clone(),
        PathBuf::from(format!("{}-wal", database.to_string_lossy())),
    ])
}

fn antigravity_provider_fingerprint(
    home: &Path,
) -> Result<BTreeMap<String, FileFingerprint>, CoreError> {
    let gemini = home.join(".gemini");
    let mut paths = vec![gemini.join("antigravity-cli/conversation_summaries.db")];
    for root_name in ACTIVE_AG_ROOTS {
        let conversations = gemini.join(root_name).join("conversations");
        let Ok(entries) = fs::read_dir(conversations) else {
            continue;
        };
        paths.extend(entries.flatten().filter_map(|entry| {
            let path = entry.path();
            matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("db" | "pb")
            )
            .then_some(path)
        }));
    }
    fingerprint_paths(paths)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn apply_session_metadata(session: &mut SessionSummary, metadata: &HashMap<String, SessionMeta>) {
    session.meta = SessionMeta::default();
    if let Some(meta) = metadata.get(&session_key(session.source, &session.id)) {
        session.meta = meta.clone();
    }
    session.title = session
        .meta
        .custom_title
        .clone()
        .or_else(|| session.source_title.clone())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| format!("(제목 없음) {}", short_id(&session.id)));
}

fn find_claude_session(home: &Path, id: &str) -> Option<SessionSummary> {
    find_claude_session_path(home, id).and_then(|path| scan_claude_session(&path).ok())
}

fn scan_claude_session(path: &Path) -> Result<SessionSummary, CoreError> {
    let fingerprint = fingerprint_file(path)?;
    let entry = scan_claude_catalog_entry(path, fingerprint, None)?;
    Ok(claude_summary_from_entry(&entry))
}

fn scan_claude_catalog_entry(
    path: &Path,
    fingerprint: FileFingerprint,
    previous: Option<&ClaudeCatalogEntry>,
) -> Result<ClaudeCatalogEntry, CoreError> {
    let append = previous.is_some_and(|entry| {
        entry.fingerprint.size_bytes < fingerprint.size_bytes
            && entry.scan.parsed_bytes <= entry.fingerprint.size_bytes
            && file_region_hash(path, 0, entry.fingerprint.prefix_bytes as usize)
                .is_ok_and(|hash| hash == entry.fingerprint.prefix_hash)
            && file_region_hash(
                path,
                entry
                    .fingerprint
                    .size_bytes
                    .saturating_sub(entry.fingerprint.tail_bytes),
                entry.fingerprint.tail_bytes as usize,
            )
            .is_ok_and(|hash| hash == entry.fingerprint.tail_hash)
    });
    let mut scan = if append {
        previous.map(|entry| entry.scan.clone()).unwrap_or_default()
    } else {
        ClaudeScanState::default()
    };
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(scan.parsed_bytes))?;
    let mut reader = BufReader::new(file);
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            if !line.ends_with('\n') {
                break;
            }
            scan.parsed_bytes = scan.parsed_bytes.saturating_add(bytes as u64);
            continue;
        };
        scan.parsed_bytes = scan.parsed_bytes.saturating_add(bytes as u64);
        update_claude_scan(&mut scan, &record);
        if !line.ends_with('\n') {
            break;
        }
    }
    Ok(ClaudeCatalogEntry {
        path: path.to_string_lossy().into_owned(),
        fingerprint,
        scan,
    })
}

fn file_region_hash(path: &Path, offset: u64, length: usize) -> Result<u64, CoreError> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0_u8; length];
    file.read_exact(&mut bytes)?;
    Ok(fnv1a(&bytes))
}

fn update_claude_scan(scan: &mut ClaudeScanState, record: &Value) {
    if let Some(timestamp) = record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_time)
    {
        scan.started_at = Some(
            scan.started_at
                .map_or(timestamp, |value| value.min(timestamp)),
        );
        scan.updated_at = Some(
            scan.updated_at
                .map_or(timestamp, |value| value.max(timestamp)),
        );
    }
    if scan.cwd.is_none() {
        scan.cwd = json_string(record, "cwd");
    }
    if scan.git_branch.is_none() {
        scan.git_branch = json_string(record, "gitBranch");
    }
    match record.get("type").and_then(Value::as_str) {
        Some("custom-title") => {
            scan.custom_title = json_string(record, "customTitle").map(cap_provider_title)
        }
        Some("ai-title") => scan.ai_title = json_string(record, "aiTitle").map(cap_provider_title),
        Some("user") => {
            scan.message_count = scan.message_count.saturating_add(1);
            if scan.first_user.is_none() {
                scan.first_user = record
                    .pointer("/message/content")
                    .and_then(user_content_text)
                    .map(clean_text)
                    .filter(|text| !text.is_empty() && !text.starts_with('<'))
                    .map(cap_provider_title);
            }
        }
        Some("assistant") => {
            scan.message_count = scan.message_count.saturating_add(1);
            // 중단·오류 자리표시자 레코드는 모델이 "<synthetic>"이라 재개 요청에 쓸 수 없다.
            if let Some(value) = record.pointer("/message/model").and_then(Value::as_str) {
                if identifier_value_is_valid(value) {
                    scan.model = Some(value.to_owned());
                }
            }
            scan.tokens.input = scan
                .tokens
                .input
                .saturating_add(json_u64_pointer(record, "/message/usage/input_tokens"));
            scan.tokens.output = scan
                .tokens
                .output
                .saturating_add(json_u64_pointer(record, "/message/usage/output_tokens"));
            scan.tokens.cache_read = scan.tokens.cache_read.saturating_add(json_u64_pointer(
                record,
                "/message/usage/cache_read_input_tokens",
            ));
            scan.tokens.cache_write = scan.tokens.cache_write.saturating_add(json_u64_pointer(
                record,
                "/message/usage/cache_creation_input_tokens",
            ));
        }
        _ => {}
    }
}

fn user_content_text(content: &Value) -> Option<&str> {
    match content {
        Value::String(text) => Some(text),
        Value::Array(blocks) => blocks.iter().find_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        }),
        _ => None,
    }
}

fn claude_summary_from_entry(entry: &ClaudeCatalogEntry) -> SessionSummary {
    let path = Path::new(&entry.path);
    let id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_owned();
    let source_title = entry
        .scan
        .custom_title
        .clone()
        .or_else(|| entry.scan.ai_title.clone())
        .or_else(|| entry.scan.first_user.clone());
    let project = entry.scan.cwd.as_deref().and_then(path_name);
    let token_total = entry.scan.tokens.total();
    SessionSummary {
        source: ProviderId::Claude,
        id,
        title: String::new(),
        source_title,
        project,
        cwd: entry.scan.cwd.clone(),
        started_at: entry.scan.started_at,
        updated_at: entry.scan.updated_at.or(entry.fingerprint.modified_at),
        message_count: Some(entry.scan.message_count),
        token_total: (token_total > 0).then_some(token_total),
        token_usage: (token_total > 0).then_some(entry.scan.tokens),
        model: entry.scan.model.clone(),
        git_branch: entry.scan.git_branch.clone(),
        is_subagent: false,
        archived: false,
        readable: true,
        size_bytes: Some(entry.fingerprint.size_bytes),
        file_path: entry.path.clone(),
        meta: SessionMeta::default(),
    }
}

fn list_codex_sessions(home: &Path) -> Vec<SessionSummary> {
    let database_path = home.join(".codex/state_5.sqlite");
    if !database_path.is_file() {
        return Vec::new();
    }
    let Ok(connection) = open_sqlite_readonly(&database_path) else {
        return Vec::new();
    };
    let Some(sql) = codex_session_sql(&connection, false) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(&sql) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| codex_session_from_row(home, row)) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

fn find_codex_session(home: &Path, id: &str) -> Option<SessionSummary> {
    let connection = open_sqlite_readonly(&home.join(".codex/state_5.sqlite")).ok()?;
    let sql = codex_session_sql(&connection, true)?;
    let mut statement = connection.prepare(&sql).ok()?;
    statement
        .query_row(rusqlite::params![id], |row| {
            codex_session_from_row(home, row)
        })
        .ok()
}

fn codex_session_sql(connection: &Connection, select_one: bool) -> Option<String> {
    let columns = sqlite_columns(connection, "threads");
    if !columns.contains("id") || !columns.contains("rollout_path") {
        return None;
    }
    let text_col = |name: &str| {
        if columns.contains(name) {
            name.to_owned()
        } else {
            format!("NULL AS {name}")
        }
    };
    let title_columns = ["name", "title", "first_user_message", "preview"]
        .into_iter()
        .filter(|name| columns.contains(*name))
        .map(|name| format!("NULLIF(TRIM({name}), '')"))
        .collect::<Vec<_>>();
    let display_title = if title_columns.is_empty() {
        "NULL AS display_title".to_owned()
    } else {
        format!("COALESCE({}) AS display_title", title_columns.join(", "))
    };
    let optional_columns = [
        "cwd",
        "created_at",
        "created_at_ms",
        "updated_at",
        "updated_at_ms",
        "recency_at_ms",
        "tokens_used",
        "archived",
        "git_branch",
        "model",
        "thread_source",
    ]
    .map(text_col)
    .join(", ");
    let filter = if select_one {
        " WHERE id = ?1 LIMIT 1"
    } else {
        ""
    };
    Some(format!(
        "SELECT id, rollout_path, {display_title}, {optional_columns} FROM threads{filter}"
    ))
}

fn codex_session_from_row(
    home: &Path,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SessionSummary> {
    let id = row.get::<_, String>(0)?;
    let rollout_path = row.get::<_, String>(1)?;
    let source_title = clean_option(row.get::<_, Option<String>>(2)?).map(cap_provider_title);
    let cwd = clean_option(row.get::<_, Option<String>>(3)?);
    let created_at = row.get::<_, Option<i64>>(4)?;
    let created_at_ms = row.get::<_, Option<i64>>(5)?;
    let updated_at = row.get::<_, Option<i64>>(6)?;
    let updated_at_ms = row.get::<_, Option<i64>>(7)?;
    let recency_at_ms = row.get::<_, Option<i64>>(8)?;
    let token_total = row.get::<_, Option<u64>>(9)?;
    let archived = row.get::<_, Option<i64>>(10)?.unwrap_or(0) == 1;
    let git_branch = clean_option(row.get::<_, Option<String>>(11)?);
    let model = clean_option(row.get::<_, Option<String>>(12)?);
    let thread_source = row.get::<_, Option<String>>(13)?;
    let resolved_path = resolve_rollout_path(home, &rollout_path);
    let file_metadata = fs::metadata(&resolved_path).ok();
    let indexed_updated_at = normalize_epoch(recency_at_ms.or(updated_at_ms).or(updated_at));
    let file_updated_at = file_metadata
        .as_ref()
        .and_then(|metadata| system_time_ms(metadata.modified().ok()));
    let updated_at = match (indexed_updated_at, file_updated_at) {
        (Some(indexed), Some(file)) => Some(indexed.max(file)),
        (Some(indexed), None) => Some(indexed),
        (None, Some(file)) => Some(file),
        (None, None) => None,
    };
    Ok(SessionSummary {
        source: ProviderId::Codex,
        id,
        title: String::new(),
        source_title,
        project: cwd.as_deref().and_then(path_name),
        cwd,
        started_at: normalize_epoch(created_at_ms.or(created_at)),
        updated_at,
        message_count: None,
        token_total,
        token_usage: None,
        model,
        git_branch,
        is_subagent: thread_source.as_deref() == Some("subagent"),
        archived,
        readable: resolved_path.is_file(),
        size_bytes: file_metadata.as_ref().map(fs::Metadata::len),
        file_path: resolved_path.to_string_lossy().into_owned(),
        meta: SessionMeta::default(),
    })
}

fn resolve_rollout_path(home: &Path, original: &str) -> PathBuf {
    let path = PathBuf::from(original);
    if path.is_file() {
        return path;
    }
    path.file_name()
        .map(|name| home.join(".codex/archived_sessions").join(name))
        .filter(|candidate| candidate.is_file())
        .unwrap_or(path)
}

#[derive(Default, Clone)]
struct AgIndexEntry {
    title: Option<String>,
    step_count: Option<u64>,
    updated_at: Option<i64>,
    workspace: Option<String>,
}

fn list_antigravity_sessions(home: &Path) -> Vec<SessionSummary> {
    let gemini = home.join(".gemini");
    let index = read_ag_summary_index(&gemini);
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    for root_name in ACTIVE_AG_ROOTS {
        let conversations = gemini.join(root_name).join("conversations");
        let Ok(files) = fs::read_dir(conversations) else {
            continue;
        };
        for entry in files.flatten() {
            let path = entry.path();
            let extension = path.extension().and_then(|value| value.to_str());
            if extension != Some("db") && extension != Some("pb") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_owned();
            if !seen.insert(id.clone()) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let indexed = index.get(&id).cloned().unwrap_or_default();
            sessions.push(antigravity_session_from_path(id, path, metadata, indexed));
        }
    }
    sessions
}

fn find_antigravity_session(home: &Path, id: &str) -> Option<SessionSummary> {
    let gemini = home.join(".gemini");
    let indexed = read_ag_summary_index(&gemini)
        .remove(id)
        .unwrap_or_default();
    for root_name in ACTIVE_AG_ROOTS {
        let conversations = gemini.join(root_name).join("conversations");
        for extension in ["db", "pb"] {
            let path = conversations.join(format!("{id}.{extension}"));
            if let Ok(metadata) = fs::metadata(&path) {
                return Some(antigravity_session_from_path(
                    id.to_owned(),
                    path,
                    metadata,
                    indexed,
                ));
            }
        }
    }
    None
}

fn antigravity_session_from_path(
    id: String,
    path: PathBuf,
    metadata: fs::Metadata,
    indexed: AgIndexEntry,
) -> SessionSummary {
    let cwd = indexed.workspace.as_deref().and_then(file_uri_to_path);
    let readable = path.extension().and_then(|value| value.to_str()) == Some("db");
    SessionSummary {
        source: ProviderId::Antigravity,
        id,
        title: String::new(),
        source_title: indexed.title,
        project: cwd.as_deref().and_then(path_name),
        cwd,
        started_at: None,
        updated_at: indexed
            .updated_at
            .or_else(|| system_time_ms(metadata.modified().ok())),
        message_count: indexed.step_count,
        token_total: None,
        token_usage: None,
        model: None,
        git_branch: None,
        is_subagent: false,
        archived: false,
        readable,
        size_bytes: Some(metadata.len()),
        file_path: path.to_string_lossy().into_owned(),
        meta: SessionMeta::default(),
    }
}

fn read_ag_summary_index(gemini: &Path) -> HashMap<String, AgIndexEntry> {
    let path = gemini.join("antigravity-cli/conversation_summaries.db");
    let Ok(connection) = open_sqlite_readonly(&path) else {
        return HashMap::new();
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris FROM conversation_summaries",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        let id = row.get::<_, String>(0)?;
        let title = row.get::<_, Option<String>>(1)?;
        let preview = row.get::<_, Option<String>>(2)?;
        let count = row.get::<_, Option<u64>>(3)?;
        let updated = row.get::<_, Option<String>>(4)?;
        let workspaces = row.get::<_, Option<String>>(5)?;
        Ok((id, title, preview, count, updated, workspaces))
    }) else {
        return HashMap::new();
    };
    rows.flatten()
        .map(|(id, title, preview, step_count, updated, workspaces)| {
            let workspace = workspaces
                .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
                .and_then(|mut paths| (!paths.is_empty()).then(|| paths.remove(0)));
            (
                id,
                AgIndexEntry {
                    title: first_non_empty([title, preview]).map(cap_provider_title),
                    step_count,
                    updated_at: updated.as_deref().and_then(parse_time),
                    workspace,
                },
            )
        })
        .collect()
}

fn list_skills_from_home(home: &Path) -> Vec<SkillSummary> {
    let mut skills = Vec::new();
    scan_skill_parent(
        &home.join(".claude/skills"),
        ProviderId::Claude,
        "personal",
        None,
        &mut skills,
        false,
    );
    for project in claude_project_paths(home) {
        scan_skill_parent(
            &project.join(".claude/skills"),
            ProviderId::Claude,
            "project",
            project
                .file_name()
                .map(|value| value.to_string_lossy().into_owned()),
            &mut skills,
            false,
        );
    }
    let marketplaces = home.join(".claude/plugins/marketplaces");
    for marketplace in child_directories(&marketplaces) {
        for kind in ["plugins", "external_plugins"] {
            for plugin in child_directories(&marketplace.join(kind)) {
                scan_skill_parent(
                    &plugin.join("skills"),
                    ProviderId::Claude,
                    "plugin",
                    plugin
                        .file_name()
                        .map(|value| value.to_string_lossy().into_owned()),
                    &mut skills,
                    false,
                );
            }
        }
    }
    scan_skill_parent(
        &home.join(".codex/skills"),
        ProviderId::Codex,
        "personal",
        None,
        &mut skills,
        true,
    );
    scan_skill_parent(
        &home.join(".codex/skills/.system"),
        ProviderId::Codex,
        "system",
        Some("Codex built-in".to_owned()),
        &mut skills,
        false,
    );
    for root_name in ACTIVE_AG_ROOTS {
        scan_skill_parent(
            &home.join(".gemini").join(root_name).join("builtin/skills"),
            ProviderId::Antigravity,
            "builtin",
            Some((*root_name).to_owned()),
            &mut skills,
            false,
        );
    }
    let mut seen = HashSet::new();
    skills.retain(|skill| seen.insert(skill.path.clone()));
    skills
}

fn scan_skill_parent(
    parent: &Path,
    source: ProviderId,
    scope: &str,
    origin: Option<String>,
    output: &mut Vec<SkillSummary>,
    include_hidden: bool,
) {
    for directory in child_directories(parent) {
        if !include_hidden
            && directory
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        {
            continue;
        }
        let path = directory.join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let Ok(text) = read_text_limited(&path, 5 * 1024 * 1024) else {
            continue;
        };
        let (frontmatter, _) = split_frontmatter(&text);
        let fallback = directory
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "skill".to_owned());
        let name = frontmatter_value(frontmatter, "name").unwrap_or(fallback);
        let description = frontmatter_value(frontmatter, "description").unwrap_or_default();
        output.push(SkillSummary {
            id: stable_id(&path.to_string_lossy()),
            source,
            scope: scope.to_owned(),
            name,
            description,
            path: path.to_string_lossy().into_owned(),
            directory: directory.to_string_lossy().into_owned(),
            origin: origin.clone(),
        });
    }
}

fn claude_project_paths(home: &Path) -> Vec<PathBuf> {
    let path = home.join(".claude.json");
    let Ok(text) = read_text_limited(&path, 10 * 1024 * 1024) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("projects").and_then(Value::as_object).cloned())
        .map(|projects| projects.keys().map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn list_agents_from_home(home: &Path) -> Vec<AgentDefinition> {
    let root = home.join(".claude/agents");
    let Ok(files) = fs::read_dir(root) else {
        return Vec::new();
    };
    files
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                return None;
            }
            let text = read_text_limited(&path, 5 * 1024 * 1024).ok()?;
            let (frontmatter, _) = split_frontmatter(&text);
            let fallback = path.file_stem()?.to_string_lossy().into_owned();
            Some(AgentDefinition {
                name: frontmatter_value(frontmatter, "name").unwrap_or(fallback),
                description: frontmatter_value(frontmatter, "description").unwrap_or_default(),
                tools: frontmatter_list(frontmatter, "tools"),
                model: frontmatter_value(frontmatter, "model"),
                max_turns: frontmatter_value(frontmatter, "maxTurns")
                    .and_then(|value| value.parse().ok()),
                permission_mode: frontmatter_value(frontmatter, "permissionMode"),
                skills: frontmatter_list(frontmatter, "skills"),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

fn list_artifacts_from_home(home: &Path, sessions: &[SessionSummary]) -> Vec<ArtifactGroup> {
    let titles: HashMap<&str, (&str, bool)> = sessions
        .iter()
        .filter(|session| session.source == ProviderId::Antigravity)
        .map(|session| {
            (
                session.id.as_str(),
                (session.title.as_str(), session.readable),
            )
        })
        .collect();
    let mut groups = Vec::new();
    let mut seen = HashSet::new();
    for root_name in ALL_AG_ROOTS {
        let brain = home.join(".gemini").join(root_name).join("brain");
        for directory in child_directories(&brain) {
            let Some(conversation_id) = directory.file_name().and_then(|value| value.to_str())
            else {
                continue;
            };
            if validate_identifier(conversation_id).is_err()
                || !seen.insert(conversation_id.to_owned())
            {
                continue;
            }
            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };
            let mut artifacts = Vec::new();
            let mut image_count = 0;
            for entry in entries.flatten() {
                let path = entry.path();
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if extension == "md" {
                    if let Ok(artifact) =
                        artifact_from_file(conversation_id, root_name, &directory, &path)
                    {
                        artifacts.push(artifact);
                    }
                } else if ["png", "webp", "jpg", "jpeg", "gif"].contains(&extension.as_str()) {
                    image_count += 1;
                }
            }
            if artifacts.is_empty() && image_count == 0 {
                continue;
            }
            artifacts.sort_by_key(|artifact| Reverse(artifact.updated_at));
            let (title, readable) = titles
                .get(conversation_id)
                .map(|(title, readable)| (Some((*title).to_owned()), *readable))
                .unwrap_or((None, false));
            groups.push(ArtifactGroup {
                conversation_id: conversation_id.to_owned(),
                root_name: (*root_name).to_owned(),
                title,
                readable,
                artifacts,
                image_count,
            });
        }
    }
    groups.sort_by(|a, b| {
        let left = a.artifacts.first().and_then(|artifact| artifact.updated_at);
        let right = b.artifacts.first().and_then(|artifact| artifact.updated_at);
        right.cmp(&left)
    });
    groups
}

fn artifact_from_file(
    conversation_id: &str,
    root_name: &str,
    directory: &Path,
    path: &Path,
) -> Result<ArtifactSummary, CoreError> {
    let metadata = fs::metadata(path)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CoreError::InvalidInput("잘못된 파일 이름입니다".to_owned()))?
        .to_owned();
    let sidecar = PathBuf::from(format!("{}.metadata.json", path.to_string_lossy()));
    let sidecar_value = read_text_limited(&sidecar, 1024 * 1024)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let mut versions = Vec::new();
    if let Ok(entries) = fs::read_dir(directory) {
        let prefix = format!("{name}.resolved.");
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if let Some(value) = file_name
                .strip_prefix(&prefix)
                .and_then(|value| value.parse().ok())
            {
                versions.push(value);
            }
        }
    }
    versions.sort_unstable();
    Ok(ArtifactSummary {
        conversation_id: conversation_id.to_owned(),
        root_name: root_name.to_owned(),
        name,
        artifact_type: sidecar_value
            .as_ref()
            .and_then(|value| value.get("artifactType"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        summary: sidecar_value
            .as_ref()
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        updated_at: sidecar_value
            .as_ref()
            .and_then(|value| value.get("updatedAt"))
            .and_then(Value::as_str)
            .and_then(parse_time)
            .or_else(|| system_time_ms(metadata.modified().ok())),
        version: sidecar_value
            .as_ref()
            .and_then(|value| value.get("version"))
            .and_then(Value::as_u64),
        versions,
        size_bytes: metadata.len(),
    })
}

fn build_dashboard(
    sessions: &[SessionSummary],
    skill_count: usize,
    agent_count: usize,
) -> DashboardStats {
    let visible: Vec<_> = sessions
        .iter()
        .filter(|session| !session.meta.hidden)
        .collect();
    let mut sessions_by_source = SourceCounts::default();
    let mut tokens = SourceTotals::default();
    let mut disk = SourceTotals::default();
    let mut models: BTreeMap<String, usize> = BTreeMap::new();
    let mut projects: HashMap<String, (String, usize)> = HashMap::new();
    let week_ms = 7 * 24 * 60 * 60 * 1000_i64;
    let now = now_ms();
    let current_week = now - now.rem_euclid(week_ms);
    let mut weekly = (0..12)
        .rev()
        .map(|offset| WeeklyCount {
            week_start: current_week - offset * week_ms,
            claude: 0,
            codex: 0,
            antigravity: 0,
        })
        .collect::<Vec<_>>();

    for session in &visible {
        sessions_by_source.increment(session.source);
        if let Some(value) = session.token_total {
            match session.source {
                ProviderId::Claude => tokens.claude += value,
                ProviderId::Codex => tokens.codex += value,
                ProviderId::Antigravity => tokens.antigravity += value,
            }
        }
        if let Some(value) = session.size_bytes {
            match session.source {
                ProviderId::Claude => disk.claude += value,
                ProviderId::Codex => disk.codex += value,
                ProviderId::Antigravity => disk.antigravity += value,
            }
        }
        if let Some(model) = &session.model {
            *models.entry(model.clone()).or_default() += 1;
        }
        if let Some(path) = &session.cwd {
            let name = session.project.clone().unwrap_or_else(|| path.clone());
            let entry = projects.entry(path.clone()).or_insert((name, 0));
            entry.1 += 1;
        }
        if let Some(updated_at) = session.updated_at {
            let bucket = updated_at - updated_at.rem_euclid(week_ms);
            if let Some(item) = weekly.iter_mut().find(|item| item.week_start == bucket) {
                match session.source {
                    ProviderId::Claude => item.claude += 1,
                    ProviderId::Codex => item.codex += 1,
                    ProviderId::Antigravity => item.antigravity += 1,
                }
            }
        }
    }
    tokens.total = tokens.claude + tokens.codex + tokens.antigravity;
    disk.total = disk.claude + disk.codex + disk.antigravity;
    let mut model_counts = models
        .into_iter()
        .map(|(model, count)| ModelCount { model, count })
        .collect::<Vec<_>>();
    model_counts.sort_by_key(|model| Reverse(model.count));
    let mut top_projects = projects
        .into_iter()
        .map(|(path, (name, count))| ProjectCount { name, path, count })
        .collect::<Vec<_>>();
    top_projects.sort_by_key(|project| Reverse(project.count));
    top_projects.truncate(10);

    DashboardStats {
        session_count: visible.len(),
        sessions_by_source,
        tokens,
        disk,
        skill_count,
        agent_count,
        models: model_counts,
        top_projects,
        weekly,
        recent: visible.into_iter().take(8).cloned().collect(),
    }
}

struct ParsedTranscript {
    items: Vec<TranscriptItem>,
    truncated: bool,
    total_items: usize,
    skipped_lines: usize,
    unavailable_reason: Option<String>,
}

struct TranscriptCollector {
    items: VecDeque<TranscriptItem>,
    limit: Option<usize>,
    before_index: Option<usize>,
    total: usize,
}

impl TranscriptCollector {
    fn new(limit: Option<usize>, before_index: Option<usize>) -> Self {
        Self {
            items: VecDeque::new(),
            limit,
            before_index,
            total: 0,
        }
    }

    fn next_index(&self) -> usize {
        self.total
    }

    /// before_index 이전 항목을 모두 수집해 더 읽을 필요가 없는 상태.
    fn done(&self) -> bool {
        self.before_index.is_some_and(|before| self.total >= before)
    }

    fn push(&mut self, mut item: TranscriptItem) {
        if self.done() {
            return;
        }
        item.index = self.total;
        self.total += 1;
        self.items.push_back(item);
        if self.limit.is_some_and(|limit| self.items.len() > limit) {
            self.items.pop_front();
        }
    }

    fn finish(self) -> (Vec<TranscriptItem>, bool, usize) {
        let truncated = self.limit.is_some_and(|limit| self.total > limit);
        (self.items.into(), truncated, self.total)
    }
}

/// `cursor` 앞의 한 줄을 찾아 시작 바이트 오프셋과 원문을 반환한다.
/// 제한 조회의 인덱스는 이 오프셋을 사용하므로, 다음 페이지는 같은 파일을
/// 처음부터 다시 스캔하지 않고 바로 이전 줄부터 이어 읽을 수 있다.
fn read_previous_line(
    file: &mut File,
    cursor: &mut u64,
) -> Result<Option<(usize, Vec<u8>)>, CoreError> {
    const CHUNK_BYTES: u64 = 8 * 1024;

    let mut end = *cursor;
    if end == 0 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(end - 1))?;
    let mut last = [0_u8; 1];
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        end -= 1;
    }
    if end == 0 {
        *cursor = 0;
        return Ok(Some((0, Vec::new())));
    }

    let mut search_end = end;
    let mut chunks = Vec::new();
    loop {
        let start = search_end.saturating_sub(CHUNK_BYTES);
        let length = usize::try_from(search_end - start).unwrap_or(8 * 1024);
        let mut buffer = vec![0_u8; length];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buffer)?;
        if let Some(position) = buffer.iter().rposition(|byte| *byte == b'\n') {
            chunks.push(buffer[position + 1..].to_vec());
            chunks.reverse();
            let mut line = chunks.concat();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line_start = start + u64::try_from(position).unwrap_or(0) + 1;
            *cursor = line_start.saturating_sub(1);
            return Ok(Some((
                usize::try_from(line_start).unwrap_or(usize::MAX),
                line,
            )));
        }
        chunks.push(buffer);
        if start == 0 {
            chunks.reverse();
            let mut line = chunks.concat();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            *cursor = 0;
            return Ok(Some((0, line)));
        }
        search_end = start;
    }
}

fn parse_claude_transcript(
    path: &Path,
    limit: Option<usize>,
    before_index: Option<usize>,
) -> Result<ParsedTranscript, CoreError> {
    if let Some(limit) = limit {
        return parse_claude_transcript_tail(path, limit, before_index);
    }
    let file = File::open(path)?;
    let mut collector = TranscriptCollector::new(limit, before_index);
    let mut skipped = 0;
    for line in BufReader::new(file).lines() {
        if collector.done() {
            break;
        }
        let Ok(line) = line else {
            skipped += 1;
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            skipped += 1;
            continue;
        };
        if let Some(item) = claude_transcript_item(&record, collector.next_index()) {
            collector.push(item);
        }
    }
    let (items, truncated, total_items) = collector.finish();
    Ok(ParsedTranscript {
        items,
        truncated,
        total_items,
        skipped_lines: skipped,
        unavailable_reason: None,
    })
}

fn parse_claude_transcript_tail(
    path: &Path,
    limit: usize,
    before_index: Option<usize>,
) -> Result<ParsedTranscript, CoreError> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut cursor = before_index
        .and_then(|index| u64::try_from(index).ok())
        .unwrap_or(file_len)
        .min(file_len);
    let mut items = VecDeque::new();
    let mut skipped = 0;
    let mut truncated = false;

    while let Some((offset, line)) = read_previous_line(&mut file, &mut cursor)? {
        let Ok(record) = serde_json::from_slice::<Value>(&line) else {
            skipped += 1;
            continue;
        };
        let Some(item) = claude_transcript_item(&record, offset) else {
            continue;
        };
        if items.len() >= limit {
            truncated = true;
            break;
        }
        items.push_front(item);
    }

    Ok(ParsedTranscript {
        items: items.into(),
        truncated,
        total_items: usize::try_from(file_len).unwrap_or(usize::MAX),
        skipped_lines: skipped,
        unavailable_reason: None,
    })
}

fn claude_transcript_item(record: &Value, index: usize) -> Option<TranscriptItem> {
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_time);
    let mut blocks = Vec::new();
    let mut role = None;
    let mut model = None;
    let mut usage = None;
    match record.get("type").and_then(Value::as_str) {
        Some("user") => {
            role = Some("user".to_owned());
            blocks = claude_content_blocks(record.pointer("/message/content"), true);
        }
        Some("assistant") => {
            role = Some("assistant".to_owned());
            blocks = claude_content_blocks(record.pointer("/message/content"), false);
            model = record
                .pointer("/message/model")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let value = TokenUsage {
                input: json_u64_pointer(record, "/message/usage/input_tokens"),
                output: json_u64_pointer(record, "/message/usage/output_tokens"),
                cache_read: json_u64_pointer(record, "/message/usage/cache_read_input_tokens"),
                cache_write: json_u64_pointer(record, "/message/usage/cache_creation_input_tokens"),
            };
            usage = (value.total() > 0).then_some(value);
        }
        Some("system") if record.get("isMeta").and_then(Value::as_bool) != Some(true) => {
            let subtype = record.get("subtype").and_then(Value::as_str);
            if subtype != Some("turn_duration") {
                role = Some("system".to_owned());
                if let Some(text) = record.get("content").and_then(Value::as_str) {
                    blocks.push(ContentBlock::Context {
                        label: "시스템 메시지".to_owned(),
                        text: cap_text(text.to_owned(), MAX_BLOCK_TEXT),
                    });
                }
            }
        }
        _ => {}
    }
    role.filter(|_| !blocks.is_empty())
        .map(|role| TranscriptItem {
            index,
            role,
            timestamp,
            model,
            type_label: None,
            blocks,
            usage,
        })
}

fn claude_content_blocks(content: Option<&Value>, user: bool) -> Vec<ContentBlock> {
    let Some(content) = content else {
        return Vec::new();
    };
    if let Some(text) = content.as_str() {
        return vec![transcript_text_block(text, user)];
    }
    let Some(parts) = content.as_array() else {
        return Vec::new();
    };
    parts
        .iter()
        .filter_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("text") => part
                .get("text")
                .and_then(Value::as_str)
                .map(|text| transcript_text_block(text, user)),
            Some("thinking") => {
                part.get("thinking")
                    .and_then(Value::as_str)
                    .map(|text| ContentBlock::Thinking {
                        text: cap_text(text.to_owned(), MAX_BLOCK_TEXT),
                    })
            }
            Some("tool_use") if !user => Some(ContentBlock::ToolUse {
                name: part
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_owned(),
                input_json: pretty_json(part.get("input").unwrap_or(&Value::Null)),
            }),
            Some("tool_result") => Some(ContentBlock::ToolResult {
                text: cap_text(content_value_to_text(part.get("content")), MAX_BLOCK_TEXT),
                is_error: part
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }),
            Some("image") => Some(ContentBlock::Text {
                text: "[이미지 첨부]".to_owned(),
            }),
            _ => None,
        })
        .collect()
}

fn parse_codex_transcript(
    path: &Path,
    limit: Option<usize>,
    before_index: Option<usize>,
) -> Result<ParsedTranscript, CoreError> {
    if let Some(limit) = limit {
        return parse_codex_transcript_tail(path, limit, before_index);
    }
    let file = File::open(path)?;
    let mut collector = TranscriptCollector::new(limit, before_index);
    let mut skipped = 0;
    let mut session_meta_seen = false;
    for line in BufReader::new(file).lines() {
        if collector.done() {
            break;
        }
        let Ok(line) = line else {
            skipped += 1;
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            skipped += 1;
            continue;
        };
        let record_type = record.get("type").and_then(Value::as_str);
        let include_session_meta = record_type == Some("session_meta") && !session_meta_seen;
        if record_type == Some("session_meta") {
            session_meta_seen = true;
        }
        if let Some(value) =
            codex_transcript_item(&record, collector.next_index(), include_session_meta)
        {
            collector.push(value);
        }
    }
    let (items, truncated, total_items) = collector.finish();
    Ok(ParsedTranscript {
        items,
        truncated,
        total_items,
        skipped_lines: skipped,
        unavailable_reason: None,
    })
}

fn parse_codex_transcript_tail(
    path: &Path,
    limit: usize,
    before_index: Option<usize>,
) -> Result<ParsedTranscript, CoreError> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut cursor = before_index
        .and_then(|index| u64::try_from(index).ok())
        .unwrap_or(file_len)
        .min(file_len);
    let mut items = VecDeque::new();
    let mut skipped = 0;
    let mut truncated = false;
    let mut session_meta_seen = false;

    while let Some((offset, line)) = read_previous_line(&mut file, &mut cursor)? {
        let Ok(record) = serde_json::from_slice::<Value>(&line) else {
            skipped += 1;
            continue;
        };
        let record_type = record.get("type").and_then(Value::as_str);
        let include_session_meta = record_type == Some("session_meta") && !session_meta_seen;
        if record_type == Some("session_meta") {
            session_meta_seen = true;
        }
        let Some(item) = codex_transcript_item(&record, offset, include_session_meta) else {
            continue;
        };
        if items.len() >= limit {
            truncated = true;
            break;
        }
        items.push_front(item);
    }

    Ok(ParsedTranscript {
        items: items.into(),
        truncated,
        total_items: usize::try_from(file_len).unwrap_or(usize::MAX),
        skipped_lines: skipped,
        unavailable_reason: None,
    })
}

fn codex_transcript_item(
    record: &Value,
    index: usize,
    include_session_meta: bool,
) -> Option<TranscriptItem> {
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_time);
    let record_type = record.get("type").and_then(Value::as_str);
    let payload = record.get("payload").unwrap_or(&Value::Null);
    let payload_type = payload.get("type").and_then(Value::as_str);
    if record_type == Some("session_meta") && include_session_meta {
        return Some(transcript_item(
            index,
            "meta",
            timestamp,
            Some("세션 정보"),
            codex_session_info(payload),
        ));
    }
    if record_type == Some("compacted") {
        return Some(transcript_item(
            index,
            "meta",
            timestamp,
            Some("컨텍스트 압축"),
            ContentBlock::Context {
                label: "컨텍스트 압축".to_owned(),
                text: "이전 대화가 압축되었습니다.".to_owned(),
            },
        ));
    }
    if record_type != Some("response_item") {
        return None;
    }
    match payload_type {
        Some("message") => {
            let source_role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("system");
            let text = content_value_to_text(payload.get("content"));
            if text.trim().is_empty() {
                return None;
            }
            let context_label = if source_role == "user" {
                automatic_context_label(&text)
            } else if source_role == "assistant" {
                None
            } else {
                Some(role_context_label(source_role))
            };
            let role = if context_label.is_some() {
                "meta"
            } else {
                source_role
            };
            let block = if let Some(label) = context_label {
                ContentBlock::Context {
                    label: label.to_owned(),
                    text: cap_text(text, MAX_BLOCK_TEXT),
                }
            } else {
                ContentBlock::Text {
                    text: cap_text(text, MAX_BLOCK_TEXT),
                }
            };
            Some(transcript_item(
                index,
                role,
                timestamp,
                context_label,
                block,
            ))
        }
        Some("reasoning") => {
            let text = content_value_to_text(payload.get("summary"));
            Some(transcript_item(
                index,
                "assistant",
                timestamp,
                None,
                ContentBlock::Thinking {
                    text: if text.trim().is_empty() {
                        "(암호화된 추론 내용)".to_owned()
                    } else {
                        cap_text(text, MAX_BLOCK_TEXT)
                    },
                },
            ))
        }
        Some("function_call")
        | Some("custom_tool_call")
        | Some("web_search_call")
        | Some("tool_search_call") => Some(transcript_item(
            index,
            "assistant",
            timestamp,
            None,
            ContentBlock::ToolUse {
                name: payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| payload_type.unwrap_or("tool"))
                    .to_owned(),
                input_json: pretty_json(
                    payload
                        .get("arguments")
                        .or_else(|| payload.get("input"))
                        .unwrap_or(payload),
                ),
            },
        )),
        Some("function_call_output") | Some("custom_tool_call_output") => Some(transcript_item(
            index,
            "meta",
            timestamp,
            Some("도구 결과"),
            ContentBlock::ToolResult {
                text: cap_text(content_value_to_text(payload.get("output")), MAX_BLOCK_TEXT),
                is_error: false,
            },
        )),
        _ => None,
    }
}

fn transcript_text_block(text: &str, user: bool) -> ContentBlock {
    let text = cap_text(text.to_owned(), MAX_BLOCK_TEXT);
    if user {
        if let Some(label) = automatic_context_label(&text) {
            return ContentBlock::Context {
                label: label.to_owned(),
                text,
            };
        }
    }
    ContentBlock::Text { text }
}

fn automatic_context_label(text: &str) -> Option<&'static str> {
    let text = text.trim_start();
    [
        ("<environment_context>", "환경 컨텍스트"),
        ("<permissions instructions>", "권한 컨텍스트"),
        ("<app-context>", "앱 컨텍스트"),
        ("<collaboration_mode>", "협업 모드"),
        ("<apps_instructions>", "앱 지침"),
        ("<plugins_instructions>", "플러그인 지침"),
        ("<skills_instructions>", "스킬 지침"),
        ("<recommended_plugins>", "추천 플러그인 목록"),
        ("<user_instructions>", "사용자 지침"),
        ("# AGENTS.md instructions", "프로젝트 지침"),
    ]
    .into_iter()
    .find_map(|(prefix, label)| text.starts_with(prefix).then_some(label))
}

fn role_context_label(role: &str) -> &'static str {
    match role {
        "developer" => "개발자 지침",
        "system" => "시스템 지침",
        _ => "런타임 메타정보",
    }
}

fn codex_session_info(payload: &Value) -> ContentBlock {
    let raw_json = pretty_json(payload);
    let raw_truncated = raw_json.len() > MAX_BLOCK_TEXT;
    ContentBlock::SessionInfo(Box::new(SessionInfoBlock {
        id: json_string(payload, "id").or_else(|| json_string(payload, "session_id")),
        cwd: json_string(payload, "cwd"),
        originator: json_string(payload, "originator"),
        cli_version: json_string(payload, "cli_version"),
        source: json_string(payload, "source"),
        model_provider: json_string(payload, "model_provider"),
        thread_source: json_string(payload, "thread_source"),
        history_mode: json_string(payload, "history_mode"),
        context_window_id: payload
            .pointer("/context_window/window_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        tool_count: payload
            .get("dynamic_tools")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        raw_json: cap_text(raw_json, MAX_BLOCK_TEXT),
        raw_truncated,
    }))
}

fn parse_antigravity_transcript(
    path: &Path,
    limit: Option<usize>,
    before_index: Option<usize>,
) -> Result<ParsedTranscript, CoreError> {
    let connection = open_sqlite_readonly(path)?;
    let mut statement = connection
        .prepare("SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<Vec<u8>>>(3)?,
        ))
    })?;
    let mut collector = TranscriptCollector::new(limit, before_index);
    for (index, step_type, status, payload) in rows.flatten() {
        if collector.done() {
            break;
        }
        let label = step_type.map_or_else(
            || "Antigravity 이벤트".to_owned(),
            |value| format!("Step {value}"),
        );
        let texts = payload
            .as_deref()
            .map(mine_printable_strings)
            .unwrap_or_default();
        let text = if texts.is_empty() {
            status.map_or_else(
                || "상태: 알 수 없음".to_owned(),
                |value| format!("상태 코드: {value}"),
            )
        } else {
            texts.into_iter().take(8).collect::<Vec<_>>().join("\n")
        };
        collector.push(TranscriptItem {
            index: index.max(0) as usize,
            role: "meta".to_owned(),
            timestamp: None,
            model: None,
            type_label: Some(label.clone()),
            blocks: vec![ContentBlock::Context {
                label,
                text: cap_text(text, MAX_BLOCK_TEXT),
            }],
            usage: None,
        });
    }
    let (items, truncated, total_items) = collector.finish();
    Ok(ParsedTranscript {
        truncated,
        items,
        total_items,
        skipped_lines: 0,
        unavailable_reason: None,
    })
}

fn transcript_item(
    index: usize,
    role: &str,
    timestamp: Option<i64>,
    type_label: Option<&str>,
    block: ContentBlock,
) -> TranscriptItem {
    TranscriptItem {
        index,
        role: role.to_owned(),
        timestamp,
        model: None,
        type_label: type_label.map(ToOwned::to_owned),
        blocks: vec![block],
        usage: None,
    }
}

fn build_file_tree(root: &Path, max_entries: usize) -> Result<Vec<FileNode>, CoreError> {
    let mut direct: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for (count, entry) in WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        let entry = entry.map_err(|error| {
            CoreError::Io(
                error
                    .into_io_error()
                    .unwrap_or_else(|| std::io::Error::other("디렉터리를 읽지 못했습니다")),
            )
        })?;
        if count >= max_entries {
            break;
        }
        let parent = entry.path().parent().unwrap_or(root).to_path_buf();
        direct
            .entry(parent)
            .or_default()
            .push(entry.path().to_path_buf());
    }
    fn build(root: &Path, parent: &Path, direct: &HashMap<PathBuf, Vec<PathBuf>>) -> Vec<FileNode> {
        let mut nodes = direct
            .get(parent)
            .into_iter()
            .flatten()
            .filter_map(|path| {
                let metadata = fs::symlink_metadata(path).ok()?;
                if metadata.file_type().is_symlink() {
                    return None;
                }
                Some(FileNode {
                    name: path.file_name()?.to_string_lossy().into_owned(),
                    relative_path: path.strip_prefix(root).ok()?.to_string_lossy().into_owned(),
                    size_bytes: metadata.len(),
                    is_directory: metadata.is_dir(),
                    children: if metadata.is_dir() {
                        build(root, path, direct)
                    } else {
                        Vec::new()
                    },
                })
            })
            .collect::<Vec<_>>();
        nodes.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        nodes
    }
    Ok(build(root, root, &direct))
}

fn sqlite_columns(connection: &Connection, table: &str) -> HashSet<String> {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut statement) = connection.prepare(&sql) else {
        return HashSet::new();
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(1)) else {
        return HashSet::new();
    };
    rows.flatten().collect()
}

fn open_sqlite_readonly(path: &Path) -> rusqlite::Result<Connection> {
    // immutable=1 금지: Antigravity·Codex DB는 WAL 모드라 immutable로 열면
    // WAL 내용이 무시되어 malformed 오류 또는 빈 결과가 나온다.
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_millis(1_000))?;
    Ok(connection)
}

fn split_frontmatter(text: &str) -> (&str, &str) {
    let Some(rest) = text.strip_prefix("---") else {
        return ("", text);
    };
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .unwrap_or(rest);
    if let Some(index) = rest.find("\n---") {
        let after = &rest[index + 4..];
        return (
            &rest[..index],
            after
                .strip_prefix("\r\n")
                .or_else(|| after.strip_prefix('\n'))
                .unwrap_or(after),
        );
    }
    ("", text)
}

fn frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    frontmatter.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix(&prefix)
            .map(str::trim)
            .map(|value| value.trim_matches(['\'', '"']).trim().to_owned())
            .filter(|value| !value.is_empty() && value != ">" && value != "|")
    })
}

fn frontmatter_list(frontmatter: &str, key: &str) -> Vec<String> {
    let prefix = format!("{key}:");
    let lines = frontmatter.lines().collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        let Some(value) = line.trim_start().strip_prefix(&prefix).map(str::trim) else {
            continue;
        };
        if !value.is_empty() {
            return value
                .trim_matches(['[', ']'])
                .split(',')
                .map(|item| item.trim().trim_matches(['\'', '"']).to_owned())
                .filter(|item| !item.is_empty())
                .collect();
        }
        return lines[index + 1..]
            .iter()
            .take_while(|next| next.starts_with(' ') || next.starts_with('\t'))
            .filter_map(|next| next.trim().strip_prefix('-'))
            .map(|item| item.trim().trim_matches(['\'', '"']).to_owned())
            .filter(|item| !item.is_empty())
            .collect();
    }
    Vec::new()
}

fn child_directories(parent: &Path) -> Vec<PathBuf> {
    fs::read_dir(parent)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default()
}

fn read_text_limited(path: &Path, max_bytes: u64) -> Result<String, CoreError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > max_bytes {
        return Err(CoreError::TooLarge(max_bytes));
    }
    let mut file = File::open(path)?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

fn guarded_child(root: &Path, relative: &Path, must_exist: bool) -> Result<PathBuf, CoreError> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(CoreError::InvalidInput(
            "허용된 경로를 벗어났습니다".to_owned(),
        ));
    }
    let root_real = fs::canonicalize(root)?;
    let joined = root_real.join(relative);
    let resolved = if must_exist {
        fs::canonicalize(&joined)?
    } else {
        joined
    };
    if resolved != root_real && !resolved.starts_with(&root_real) {
        return Err(CoreError::InvalidInput(
            "허용된 경로를 벗어났습니다".to_owned(),
        ));
    }
    Ok(resolved)
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.contains('/')
        && !value.contains('\\')
        && value != "."
        && value != ".."
}

fn validate_identifier(value: &str) -> Result<(), CoreError> {
    if (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err(CoreError::InvalidInput("잘못된 식별자입니다".to_owned()))
    }
}

fn session_key(source: ProviderId, id: &str) -> String {
    format!("{}:{id}", source.as_str())
}

fn stable_id(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("skill-{hash:016x}")
}

fn short_id(value: &str) -> &str {
    value.get(..8).unwrap_or(value)
}

fn parse_time(value: &str) -> Option<i64> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .map(|time| time.unix_timestamp_nanos() / 1_000_000)
        .and_then(|value| i64::try_from(value).ok())
}

fn normalize_epoch(value: Option<i64>) -> Option<i64> {
    value.filter(|value| *value > 0).map(|value| {
        if value < 1_000_000_000_000 {
            value * 1000
        } else {
            value
        }
    })
}

fn system_time_ms(time: Option<SystemTime>) -> Option<i64> {
    time.and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_millis()).ok())
}

fn now_ms() -> i64 {
    system_time_ms(Some(SystemTime::now())).unwrap_or(0)
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
}

fn json_u64_pointer(value: &Value, pointer: &str) -> u64 {
    value.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

fn clean_option(value: Option<String>) -> Option<String> {
    value
        .map(|value| clean_text(&value))
        .filter(|value| !value.is_empty())
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cap_text(mut value: String, max: usize) -> String {
    if value.len() <= max {
        return value;
    }
    while !value.is_char_boundary(max.min(value.len())) {
        value.pop();
    }
    value.truncate(max);
    value.push_str("\n…(생략)");
    value
}

fn cap_provider_title(value: String) -> String {
    const MAX_TITLE_CHARS: usize = 200;
    if value.chars().count() <= MAX_TITLE_CHARS {
        return value;
    }
    let mut title = value.chars().take(MAX_TITLE_CHARS - 1).collect::<String>();
    title.push('…');
    title
}

fn first_non_empty<const N: usize>(values: [Option<String>; N]) -> Option<String> {
    values.into_iter().find_map(clean_option)
}

fn path_name(value: &str) -> Option<String> {
    Path::new(value)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
}

fn file_uri_to_path(value: &str) -> Option<String> {
    let raw = value.strip_prefix("file://").unwrap_or(value);
    let decoded = percent_decode(raw);
    (!decoded.is_empty()).then_some(decoded)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = hex(bytes[index + 1]);
            let low = hex(bytes[index + 2]);
            if let (Some(high), Some(low)) = (high, low) {
                output.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn content_value_to_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str().map(ToOwned::to_owned).or_else(|| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(value) => pretty_json(value),
        None => String::new(),
    }
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned())
}

fn mine_printable_strings(bytes: &[u8]) -> Vec<String> {
    let mut output = Vec::new();
    let mut current = VecDeque::new();
    let flush = |buffer: &mut VecDeque<u8>, output: &mut Vec<String>| {
        if buffer.len() >= 8 {
            let bytes = buffer.drain(..).collect::<Vec<_>>();
            let text = String::from_utf8_lossy(&bytes).trim().to_owned();
            if !text.is_empty() && !output.contains(&text) {
                output.push(text);
            }
        } else {
            buffer.clear();
        }
    };
    for byte in bytes {
        if byte.is_ascii_graphic() || *byte == b' ' || *byte == b'\n' || *byte == b'\t' {
            current.push_back(*byte);
        } else {
            flush(&mut current, &mut output);
        }
    }
    flush(&mut current, &mut output);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TEST_SESSION_ID: &str = "session-1234567890abcdef";

    fn claude_session_file(home: &Path) -> PathBuf {
        let project = home.join(".claude/projects/test-project");
        fs::create_dir_all(&project).expect("claude project directory");
        project.join(format!("{TEST_SESSION_ID}.jsonl"))
    }

    fn write_json_lines(path: &Path, records: &[Value]) {
        let text = records
            .iter()
            .map(|record| serde_json::to_string(record).expect("json record"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(path, text).expect("session jsonl");
    }

    fn session_with_cwd(id: &str, cwd: PathBuf) -> SessionSummary {
        SessionSummary {
            source: ProviderId::Codex,
            id: id.to_owned(),
            title: id.to_owned(),
            source_title: Some(id.to_owned()),
            project: cwd
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            started_at: None,
            updated_at: None,
            message_count: None,
            token_total: None,
            token_usage: None,
            model: None,
            git_branch: None,
            is_subagent: false,
            archived: false,
            readable: true,
            size_bytes: None,
            file_path: String::new(),
            meta: SessionMeta::default(),
        }
    }

    fn claude_session_file_in(home: &Path, project_name: &str, id: &str) -> PathBuf {
        let project = home.join(".claude/projects").join(project_name);
        fs::create_dir_all(&project).expect("claude project directory");
        project.join(format!("{id}.jsonl"))
    }

    fn claude_turns(count: usize, minute_offset: usize) -> Vec<Value> {
        (0..count)
            .map(|index| {
                json!({
                    "type": "user",
                    "timestamp": format!("2026-08-06T01:{:02}:00Z", index + minute_offset),
                    "cwd": "/workspace/project",
                    "message": {"content": format!("turn {index}")}
                })
            })
            .collect()
    }

    fn dedupe_candidate(
        id: &str,
        updated_at: i64,
        message_count: u64,
        path: &str,
    ) -> SessionSummary {
        SessionSummary {
            source: ProviderId::Claude,
            id: id.to_owned(),
            updated_at: Some(updated_at),
            message_count: Some(message_count),
            file_path: path.to_owned(),
            ..session_with_cwd(id, PathBuf::from("/workspace/project"))
        }
    }

    #[test]
    fn manager_snapshot_keeps_one_entry_per_session_identity() {
        let sessions = vec![
            dedupe_candidate("shared", 100, 97, "/b.jsonl"),
            dedupe_candidate("shared", 200, 102, "/a.jsonl"),
            dedupe_candidate("other", 150, 12, "/c.jsonl"),
        ];

        let deduped = dedupe_sessions_by_identity(sessions);

        assert_eq!(deduped.len(), 2);
        assert_eq!(deduped[0].id, "shared");
        assert_eq!(deduped[0].message_count, Some(102));
        assert_eq!(deduped[0].file_path, "/a.jsonl");
        assert_eq!(deduped[1].id, "other");
    }

    #[test]
    fn session_identity_dedupe_keeps_different_sources_and_breaks_ties_by_path() {
        let mut codex = dedupe_candidate("shared", 100, 5, "/codex.jsonl");
        codex.source = ProviderId::Codex;
        let sessions = vec![
            dedupe_candidate("shared", 100, 5, "/z.jsonl"),
            codex,
            dedupe_candidate("shared", 100, 5, "/a.jsonl"),
        ];

        let deduped = dedupe_sessions_by_identity(sessions);

        assert_eq!(deduped.len(), 2, "다른 공급자의 같은 ID는 별개 세션이다");
        assert_eq!(deduped[0].source, ProviderId::Claude);
        assert_eq!(
            deduped[0].file_path, "/a.jsonl",
            "모든 지표가 같으면 경로가 앞선 항목으로 고정한다"
        );
        assert_eq!(deduped[1].source, ProviderId::Codex);
    }

    #[test]
    fn claude_session_recorded_in_two_project_directories_lists_once() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        // macOS는 한글 경로를 NFD로 저장해 같은 작업 경로가 두 프로젝트 디렉터리로 갈라진다.
        let stale = claude_session_file_in(
            &home,
            "-Users-me-Documents-\u{1102}\u{1173}",
            TEST_SESSION_ID,
        );
        let latest = claude_session_file_in(&home, "-Users-me-Documents-\u{b4dc}", TEST_SESSION_ID);
        write_json_lines(&stale, &claude_turns(2, 0));
        write_json_lines(&latest, &claude_turns(4, 10));

        let catalog =
            SessionCatalog::open_with_home(data.clone(), home.clone()).expect("session catalog");
        let snapshot = catalog.manager_snapshot().expect("initial snapshot");
        assert_eq!(
            snapshot.sessions.len(),
            1,
            "같은 논리 세션은 한 번만 보여야 한다"
        );
        assert_eq!(snapshot.sessions[0].message_count, Some(4));
        assert_eq!(snapshot.sessions[0].file_path, latest.to_string_lossy());
        assert_eq!(
            find_claude_session_path(&home, TEST_SESSION_ID).as_deref(),
            Some(latest.as_path()),
            "상세 조회도 목록과 같은 기록 파일을 읽어야 한다"
        );

        catalog
            .refresh_session(ProviderId::Claude, TEST_SESSION_ID)
            .expect("single session refresh");
        let refreshed = catalog.manager_snapshot().expect("refreshed snapshot");
        assert_eq!(
            refreshed.sessions.len(),
            1,
            "단일 세션 갱신 후에도 중복이 없어야 한다"
        );
        assert_eq!(refreshed.sessions[0].message_count, Some(4));

        catalog.reconcile().expect("full reconciliation");
        let reconciled = catalog.manager_snapshot().expect("reconciled snapshot");
        assert_eq!(
            reconciled.sessions.len(),
            1,
            "전체 조정 후에도 중복이 되살아나면 안 된다"
        );
        assert_eq!(reconciled.sessions[0].message_count, Some(4));
        assert_eq!(reconciled.sessions[0].file_path, latest.to_string_lossy());
    }

    #[test]
    fn refreshing_one_session_does_not_overwrite_another_files_catalog_entry() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        // 경로 순으로는 오래된 기록이 앞서고, 실제로 고를 파일은 뒤쪽에 있는 실제 재현 배치다.
        let stale = claude_session_file_in(&home, "project-a", TEST_SESSION_ID);
        let latest = claude_session_file_in(&home, "project-b", TEST_SESSION_ID);
        write_json_lines(&stale, &claude_turns(2, 0));
        write_json_lines(&latest, &claude_turns(4, 10));

        let mut persisted = PersistedSessionCatalog::default();
        reconcile_provider_cache(&home, &mut persisted, None, None).expect("initial scan");
        assert_eq!(
            persisted.claude.len(),
            2,
            "파일별 증분 스캔 상태는 그대로 유지한다"
        );

        reconcile_claude_target(&home, &mut persisted, TEST_SESSION_ID).expect("targeted refresh");

        assert_eq!(persisted.claude.len(), 2);
        let paths = persisted
            .claude
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>();
        assert!(paths.contains(&stale.to_string_lossy().into_owned()));
        assert!(paths.contains(&latest.to_string_lossy().into_owned()));
        let stale_entry = persisted
            .claude
            .iter()
            .find(|entry| entry.path == stale.to_string_lossy())
            .expect("stale entry");
        assert_eq!(
            stale_entry.scan.message_count, 2,
            "다른 파일의 스캔 결과가 덮어써지면 안 된다"
        );
    }

    #[test]
    fn manager_snapshot_excludes_aia_workspace_sessions() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        let aia_workspace = data.join("aia-workspace");
        let project = root.path().join("project");
        fs::create_dir_all(&home).expect("home directory");
        fs::create_dir_all(&aia_workspace).expect("AIA workspace");
        fs::create_dir_all(&project).expect("project directory");

        let persisted = PersistedSessionCatalog {
            codex_sessions: vec![
                session_with_cwd("aia-session", aia_workspace),
                session_with_cwd("project-session", project),
            ],
            ..PersistedSessionCatalog::default()
        };

        let snapshot =
            compose_manager_snapshot(&home, &data, &persisted, None).expect("manager snapshot");
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].id, "project-session");
    }

    #[test]
    fn frontmatter_parser_reads_scalar_and_list_fields() {
        let text =
            "---\nname: reviewer\ntools: Read, Grep\nskills:\n  - rust\n  - testing\n---\nBody";
        let (frontmatter, body) = split_frontmatter(text);
        assert_eq!(
            frontmatter_value(frontmatter, "name").as_deref(),
            Some("reviewer")
        );
        assert_eq!(frontmatter_list(frontmatter, "tools"), ["Read", "Grep"]);
        assert_eq!(frontmatter_list(frontmatter, "skills"), ["rust", "testing"]);
        assert_eq!(body, "Body");
    }

    #[test]
    fn stable_skill_id_is_repeatable() {
        assert_eq!(stable_id("/tmp/a/SKILL.md"), stable_id("/tmp/a/SKILL.md"));
        assert_ne!(stable_id("/tmp/a/SKILL.md"), stable_id("/tmp/b/SKILL.md"));
    }

    #[test]
    fn automatic_agent_context_is_not_classified_as_user_text() {
        assert_eq!(
            automatic_context_label("<environment_context>\n<cwd>/tmp</cwd>"),
            Some("환경 컨텍스트")
        );
        assert!(matches!(
            transcript_text_block("<permissions instructions>restricted", true),
            ContentBlock::Context { .. }
        ));
        assert!(matches!(
            transcript_text_block("실제 사용자 요청", true),
            ContentBlock::Text { .. }
        ));
    }

    #[test]
    fn claude_transcript_limit_keeps_the_latest_items_and_all_keeps_everything() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("session.jsonl");
        let records = (0..105)
            .map(|index| {
                json!({
                    "type": "user",
                    "timestamp": format!("2026-08-07T00:{:02}:00Z", index % 60),
                    "message": { "content": format!("message-{index}") }
                })
            })
            .collect::<Vec<_>>();
        write_json_lines(&path, &records);

        let latest = parse_claude_transcript(&path, Some(100), None).expect("latest transcript");
        assert!(latest.truncated);
        assert_eq!(latest.items.len(), 100);
        assert!(latest.items.first().map(|item| item.index).unwrap_or(0) > 0);
        assert!(
            latest.items.last().map(|item| item.index).unwrap_or(0)
                > latest.items.first().map(|item| item.index).unwrap_or(0)
        );
        assert!(matches!(
            latest.items.first().and_then(|item| item.blocks.first()),
            Some(ContentBlock::Text { text }) if text == "message-5"
        ));

        let all = parse_claude_transcript(&path, None, None).expect("complete transcript");
        assert!(!all.truncated);
        assert_eq!(all.items.len(), 105);
        assert_eq!(all.items.first().map(|item| item.index), Some(0));
    }

    #[test]
    fn claude_transcript_before_index_returns_the_previous_window() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("session.jsonl");
        let records = (0..105)
            .map(|index| {
                json!({
                    "type": "user",
                    "timestamp": format!("2026-08-07T00:{:02}:00Z", index % 60),
                    "message": { "content": format!("message-{index}") }
                })
            })
            .collect::<Vec<_>>();
        write_json_lines(&path, &records);

        let latest = parse_claude_transcript(&path, Some(100), None).expect("latest window");
        let before = latest.items.first().expect("oldest latest item").index;
        let earlier =
            parse_claude_transcript(&path, Some(100), Some(before)).expect("earlier window");
        assert!(!earlier.truncated);
        assert_eq!(earlier.items.len(), 5);
        assert!(matches!(
            earlier.items.last().and_then(|item| item.blocks.first()),
            Some(ContentBlock::Text { text }) if text == "message-4"
        ));

        let capped = parse_claude_transcript(&path, Some(2), Some(before)).expect("capped window");
        assert!(capped.truncated);
        assert_eq!(capped.items.len(), 2);
        assert!(matches!(
            capped.items.first().and_then(|item| item.blocks.first()),
            Some(ContentBlock::Text { text }) if text == "message-3"
        ));
        assert!(matches!(
            capped.items.last().and_then(|item| item.blocks.first()),
            Some(ContentBlock::Text { text }) if text == "message-4"
        ));
    }

    #[test]
    fn bounded_claude_transcript_does_not_scan_an_invalid_prefix() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("session.jsonl");
        let mut text = "invalid historical record\n".repeat(10_000);
        for index in 0..3 {
            text.push_str(
                &serde_json::to_string(&json!({
                    "type": "user",
                    "message": { "content": format!("latest-{index}") }
                }))
                .expect("json record"),
            );
            text.push('\n');
        }
        fs::write(&path, text).expect("session jsonl");

        let latest = parse_claude_transcript(&path, Some(2), None).expect("latest transcript");
        assert!(latest.truncated);
        assert_eq!(latest.items.len(), 2);
        assert_eq!(latest.skipped_lines, 0);
        assert!(matches!(
            latest.items.first().and_then(|item| item.blocks.first()),
            Some(ContentBlock::Text { text }) if text == "latest-1"
        ));
    }

    #[test]
    fn percent_decoder_handles_file_paths() {
        assert_eq!(percent_decode("/Users/me/My%20Docs"), "/Users/me/My Docs");
    }

    #[test]
    fn codex_session_metadata_is_summarized_without_losing_raw_details() {
        let payload = json!({
            "id": "thread-123",
            "cwd": "/workspace",
            "originator": "agent-manager",
            "cli_version": "0.146.0",
            "source": "vscode",
            "model_provider": "openai",
            "history_mode": "legacy",
            "context_window": {"window_id": "window-456"},
            "dynamic_tools": [{"name": "read"}, {"name": "exec"}],
            "base_instructions": {"text": "large internal instructions"}
        });

        let block = codex_session_info(&payload);
        let serialized = serde_json::to_value(&block).expect("session info should serialize");
        assert_eq!(serialized["kind"], "session_info");
        assert_eq!(serialized["id"], "thread-123");
        assert_eq!(serialized["toolCount"], 2);

        let ContentBlock::SessionInfo(info) = block else {
            panic!("expected session info block");
        };
        let SessionInfoBlock {
            id,
            cwd,
            originator,
            tool_count,
            context_window_id,
            raw_json,
            raw_truncated,
            ..
        } = *info;
        assert_eq!(id.as_deref(), Some("thread-123"));
        assert_eq!(cwd.as_deref(), Some("/workspace"));
        assert_eq!(originator.as_deref(), Some("agent-manager"));
        assert_eq!(tool_count, 2);
        assert_eq!(context_window_id.as_deref(), Some("window-456"));
        assert!(raw_json.contains("large internal instructions"));
        assert!(!raw_truncated);
    }

    #[test]
    fn bounded_codex_transcript_reads_only_the_latest_valid_records() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("rollout.jsonl");
        let mut text = "invalid historical record\n".repeat(10_000);
        for index in 0..3 {
            text.push_str(
                &serde_json::to_string(&json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": format!("latest-{index}")}]
                    }
                }))
                .expect("json record"),
            );
            text.push('\n');
        }
        fs::write(&path, text).expect("rollout jsonl");

        let latest = parse_codex_transcript(&path, Some(2), None).expect("latest transcript");
        assert!(latest.truncated);
        assert_eq!(latest.items.len(), 2);
        assert_eq!(latest.skipped_lines, 0);
        assert!(matches!(
            latest.items.first().and_then(|item| item.blocks.first()),
            Some(ContentBlock::Text { text }) if text == "latest-1"
        ));
    }

    #[test]
    fn codex_detail_lookup_selects_only_the_requested_thread() {
        let root = tempfile::tempdir().expect("temporary home");
        let codex = root.path().join(".codex");
        fs::create_dir_all(&codex).expect("codex directory");
        let target_rollout = codex.join("target.jsonl");
        fs::write(&target_rollout, "{}\n").expect("target rollout");
        let database = Connection::open(codex.join("state_5.sqlite")).expect("state database");
        database
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    name TEXT,
                    title TEXT,
                    first_user_message TEXT,
                    preview TEXT,
                    cwd TEXT
                );",
            )
            .expect("threads table");
        database
            .execute(
                "INSERT INTO threads (
                    id, rollout_path, name, title, first_user_message, preview, cwd
                ) VALUES (?1, ?2, '', ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    "target-id",
                    target_rollout.to_string_lossy(),
                    "selected title",
                    "unused first message",
                    "unused preview",
                    "/workspace"
                ],
            )
            .expect("target thread");
        database
            .execute(
                "INSERT INTO threads (id, rollout_path, cwd) VALUES (?1, ?2, ?3)",
                rusqlite::params!["other-id", "/missing/other.jsonl", "/other"],
            )
            .expect("other thread");
        drop(database);

        let session = find_codex_session(root.path(), "target-id").expect("target session");
        assert_eq!(session.id, "target-id");
        assert_eq!(session.source_title.as_deref(), Some("selected title"));
        assert_eq!(session.cwd.as_deref(), Some("/workspace"));
        assert_eq!(session.file_path, target_rollout.to_string_lossy());
        assert!(session.readable);
        assert!(find_codex_session(root.path(), "missing-id").is_none());
    }

    #[test]
    fn claude_scan_reads_first_user_text_from_content_blocks() {
        let mut scan = ClaudeScanState::default();
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "user",
                "message": {"content": [
                    {"type": "image", "source": {"type": "base64", "data": ""}},
                    {"type": "text", "text": "  스크린샷   검토 요청  "},
                ]},
            }),
        );
        assert_eq!(scan.first_user.as_deref(), Some("스크린샷 검토 요청"));

        let mut tool_scan = ClaudeScanState::default();
        update_claude_scan(
            &mut tool_scan,
            &json!({
                "type": "user",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "tool-1"}]},
            }),
        );
        assert_eq!(tool_scan.first_user, None);
    }

    #[test]
    fn claude_scan_ignores_synthetic_model_records() {
        let mut scan = ClaudeScanState::default();
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "assistant",
                "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "[Request interrupted by user]"}]},
            }),
        );
        assert_eq!(scan.model, None);

        update_claude_scan(
            &mut scan,
            &json!({
                "type": "assistant",
                "message": {"model": "claude-sonnet", "usage": {"input_tokens": 1, "output_tokens": 2}},
            }),
        );
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "assistant",
                "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "API Error"}]},
            }),
        );
        assert_eq!(scan.model.as_deref(), Some("claude-sonnet"));
    }

    #[test]
    fn session_catalog_reuses_cache_and_reconciles_claude_incrementally() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        let path = claude_session_file(&home);
        write_json_lines(
            &path,
            &[json!({
                "type": "user",
                "timestamp": "2026-08-06T01:00:00Z",
                "cwd": "/workspace/project",
                "message": {"content": "first question"}
            })],
        );

        let catalog = SessionCatalog::open_with_home(data.clone(), home.clone())
            .expect("initial session catalog");
        let initial = catalog.manager_snapshot().expect("initial snapshot");
        assert_eq!(initial.sessions.len(), 1);
        assert_eq!(initial.sessions[0].message_count, Some(1));
        assert!(data.join(SESSION_CATALOG_FILE_NAME).is_file());

        fs::remove_file(&path).expect("temporarily remove provider session");
        let restarted = SessionCatalog::open_with_home(data.clone(), home.clone())
            .expect("cached session catalog");
        assert_eq!(
            restarted
                .manager_snapshot()
                .expect("cached snapshot")
                .sessions
                .len(),
            1,
            "restart must display the persisted catalog before reconciliation"
        );
        let removed = restarted.reconcile().expect("delete reconciliation");
        assert!(removed.changed);
        assert!(restarted
            .manager_snapshot()
            .expect("snapshot after deletion")
            .sessions
            .is_empty());

        write_json_lines(
            &path,
            &[json!({
                "type": "user",
                "timestamp": "2026-08-06T01:00:00Z",
                "cwd": "/workspace/project",
                "message": {"content": "first question"}
            })],
        );
        restarted.reconcile().expect("restore reconciliation");
        let before_append = restarted
            .state
            .read()
            .expect("catalog state")
            .persisted
            .claude[0]
            .scan
            .parsed_bytes;
        let assistant = serde_json::to_string(&json!({
            "type": "assistant",
            "timestamp": "2026-08-06T01:01:00Z",
            "message": {
                "model": "claude-sonnet",
                "usage": {"input_tokens": 3, "output_tokens": 5}
            }
        }))
        .expect("assistant record");
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append session");
        writeln!(file, "{assistant}").expect("append assistant line");

        let appended = restarted
            .refresh_session(ProviderId::Claude, TEST_SESSION_ID)
            .expect("targeted append reconciliation");
        assert!(appended.changed);
        let snapshot = restarted.manager_snapshot().expect("incremental snapshot");
        assert_eq!(snapshot.sessions[0].message_count, Some(2));
        assert_eq!(snapshot.sessions[0].token_total, Some(8));
        let after_append = restarted
            .state
            .read()
            .expect("catalog state")
            .persisted
            .claude[0]
            .scan
            .parsed_bytes;
        assert!(after_append > before_append);

        write_json_lines(
            &path,
            &[json!({
                "type": "user",
                "timestamp": "2026-08-06T02:00:00Z",
                "cwd": "/workspace/replaced",
                "message": {"content": "replacement title"}
            })],
        );
        let replaced = restarted
            .refresh_session(ProviderId::Claude, TEST_SESSION_ID)
            .expect("targeted replacement reconciliation");
        assert!(replaced.changed);
        let replacement = restarted.manager_snapshot().expect("replacement snapshot");
        assert_eq!(replacement.sessions[0].message_count, Some(1));
        assert_eq!(replacement.sessions[0].token_total, None);
        assert_eq!(
            replacement.sessions[0].source_title.as_deref(),
            Some("replacement title")
        );
    }

    #[test]
    fn session_catalog_recovers_corruption_and_caps_provider_titles() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        let path = claude_session_file(&home);
        let long_title = "가".repeat(260);
        write_json_lines(
            &path,
            &[json!({
                "type": "custom-title",
                "timestamp": "2026-08-06T01:00:00Z",
                "customTitle": long_title
            })],
        );
        fs::create_dir_all(&data).expect("app data directory");
        fs::write(data.join(SESSION_CATALOG_FILE_NAME), "{broken").expect("corrupt catalog");

        let catalog =
            SessionCatalog::open_with_home(data.clone(), home).expect("recovered session catalog");
        let snapshot = catalog.manager_snapshot().expect("recovered snapshot");
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(
            snapshot.sessions[0]
                .source_title
                .as_deref()
                .expect("source title")
                .chars()
                .count(),
            200
        );
        let cached: PersistedSessionCatalog = serde_json::from_slice(
            &fs::read(data.join(SESSION_CATALOG_FILE_NAME)).expect("catalog bytes"),
        )
        .expect("valid rebuilt catalog");
        assert_eq!(cached.schema_version, SESSION_CATALOG_SCHEMA_VERSION);
    }

    #[test]
    fn metadata_changes_advance_catalog_revision_without_provider_rescan() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        let path = claude_session_file(&home);
        write_json_lines(
            &path,
            &[json!({
                "type": "user",
                "timestamp": "2026-08-06T01:00:00Z",
                "message": {"content": "provider title"}
            })],
        );
        let catalog = SessionCatalog::open_with_home(data.clone(), home).expect("session catalog");
        let initial_revision = catalog
            .manager_snapshot()
            .expect("initial snapshot")
            .session_catalog_revision;
        let folder =
            store::create_session_folder(&data, "Important", "#2563eb").expect("session folder");
        store::update_session_meta(
            &data,
            ProviderId::Claude,
            TEST_SESSION_ID,
            crate::domain::SessionMetaPatch {
                favorite: Some(true),
                hidden: None,
                note: None,
                custom_title: Some(Some("custom title".to_owned())),
                folder_ids: Some(vec![folder.id.clone()]),
            },
        )
        .expect("metadata update");

        let update = catalog.refresh_metadata().expect("metadata refresh");
        assert!(update.changed);
        assert!(update.revision > initial_revision);
        let snapshot = catalog.manager_snapshot().expect("metadata snapshot");
        assert_eq!(snapshot.sessions[0].title, "custom title");
        assert!(snapshot.sessions[0].meta.favorite);
        assert_eq!(snapshot.folders[0].session_count, 1);
    }

    #[test]
    fn resource_revision_changes_only_when_catalog_content_changes() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        fs::create_dir_all(&home).expect("home directory");
        let catalog = SessionCatalog::open_with_home(data, home.clone()).expect("session catalog");
        let initial = catalog
            .manager_snapshot()
            .expect("initial snapshot")
            .resource_catalog_revision;
        let unchanged = catalog.refresh_resources().expect("unchanged refresh");
        assert!(!unchanged.changed);
        assert_eq!(unchanged.revision, initial);

        let skill_dir = home.join(".codex/skills/example");
        fs::create_dir_all(&skill_dir).expect("skill directory");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: example\ndescription: Example skill\n---\nBody\n",
        )
        .expect("skill file");
        let changed = catalog.refresh_resources().expect("changed refresh");
        assert!(changed.changed);
        assert_eq!(changed.revision, initial + 1);
        let stable = catalog.refresh_resources().expect("stable refresh");
        assert!(!stable.changed);
        assert_eq!(stable.revision, changed.revision);
    }

    #[test]
    fn captured_turn_is_merged_once_and_keeps_its_origin_label() {
        let source_item = TranscriptItem {
            index: 0,
            role: "assistant".to_owned(),
            timestamp: Some(10),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::Text {
                text: "already in provider history".to_owned(),
            }],
            usage: None,
        };
        let turns = vec![
            store::CapturedTranscriptTurn {
                source: ProviderId::Claude,
                session_id: "session-1234567890".to_owned(),
                turn_id: "turn-1234567890abcd".to_owned(),
                completed_at: 20,
                text: "already in provider history".to_owned(),
                origin: store::SupplementOrigin::Chat,
            },
            store::CapturedTranscriptTurn {
                source: ProviderId::Claude,
                session_id: "session-1234567890".to_owned(),
                turn_id: "turn-abcdef1234567890".to_owned(),
                completed_at: 30,
                text: "stored scheduled result".to_owned(),
                origin: store::SupplementOrigin::Scheduled,
            },
        ];

        let merged = merge_captured_turns(vec![source_item], turns, 1);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[1].index, 1);
        assert_eq!(merged[1].type_label.as_deref(), Some("반복 실행 결과"));
        assert!(matches!(
            merged[1].blocks.as_slice(),
            [ContentBlock::Text { text }] if text == "stored scheduled result"
        ));
    }
}
