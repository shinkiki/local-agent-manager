use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, RwLock, TryLockError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::clock;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use walkdir::WalkDir;

use crate::app_data_file::write_private_bytes;
use crate::catalog_health::{self, CatalogHealth, ScanKind};
use crate::chat_settings::identifier_value_is_valid;
use crate::domain::{
    AgentDefinition, AgentDetail, AppStatus, ArtifactDetail, ArtifactGroup, ArtifactSummary,
    ContentBlock, DashboardStats, FileNode, ManagerSnapshot, ModelCount, ProjectCount,
    ProjectRegistryEntry, ProviderId, SessionCatalogUpdate, SessionDetail, SessionInfoBlock,
    SessionLastFailure, SessionMeta, SessionRuntimeFailure, SessionSummary, SessionTranscriptLimit,
    SkillDetail, SkillSummary, SourceCounts, SourceTotals, StorageOverview, StorageUsageItem,
    TokenUsage, TranscriptImageBlock, TranscriptItem, WeeklyCount,
};
use crate::identifier::validate_identifier;
use crate::project_registry::{build_project_registry, ProjectPathResolver, ProjectPolicy};
use crate::providers::inspect_local_environment;
use crate::store;
use crate::user_home::home_dir;
use crate::{linked_file, CoreError, LinkedFile, LinkedFileDownload};

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
pub(crate) const ACTIVE_AG_ROOTS: &[&str] = &["antigravity", "antigravity-cli", "antigravity-ide"];
const ALL_AG_ROOTS: &[&str] = &[
    "antigravity",
    "antigravity-cli",
    "antigravity-ide",
    "antigravity-backup",
];
const MAX_BLOCK_TEXT: usize = 100_000;
/// 보완 저장 결과가 원본 기록에 이미 있는지 견줄 때 쓰는 비교 문자열의 최대 길이.
const MAX_TEXT_PROBE_BYTES: usize = 8_192;
/// 보완 저장 결과 판정을 위해 표시 범위보다 더 읽는 항목 수. 한 턴 분량을 넉넉히 덮는다.
const TRANSCRIPT_DEDUP_LOOKBACK: usize = 400;
/// 표시 한도로 잘린 텍스트 블록 끝에 붙는 표시(`cap_text`).
const TRANSCRIPT_TRUNCATION_MARK: &str = "\n…(생략)";
/// 보관 한도로 잘린 보완 저장 결과 끝에 붙는 표시(`store::cap_supplement_text`).
const SUPPLEMENT_TRUNCATION_MARK: &str = "\n\n[Agent Manager 보관 한도에 따라 일부 생략됨]";
/// 사용자가 응답을 끊은 지점을 나타내는 트랜스크립트 역할. 사용자 요청도 에이전트 응답도 아니다.
pub(crate) const INTERRUPTED_ROLE: &str = "interrupted";
/// 응답이 끝나지 못한 지점을 나타내는 트랜스크립트 역할.
pub(crate) const RUNTIME_FAILURE_ROLE: &str = "runtime_failure";
/// 앱 기록과 공급자 원문이 같은 사건을 남겼다고 볼 시각 차이. 실측 차이는 100ms 안쪽이지만,
/// 원문 기록 시각과 턴 종료 시각이 갈리는 만큼 넉넉히 잡는다.
const RUNTIME_FAILURE_TWIN_TOLERANCE_MS: i64 = 5_000;
// v3: 스캔이 "<synthetic>" 같은 비식별자 모델을 버리도록 바뀌어 기존 캐시를 재스캔해야 한다.
// v4: 중단 자리표시자를 메시지 수·제목에서 빼도록 바뀌어 다시 재스캔해야 한다.
// v5: Antigravity 제목을 대화 DB에서 직접 뽑도록 바뀌어 기존 "(제목 없음)" 항목을 재스캔해야 한다.
// v7: 슬래시 명령 세션의 제목 폴백(firstCommand)과 명령 출력 레코드 집계 제외로 재스캔해야 한다.
// v8: 마지막 요청의 실패(lastFailure)를 스캔에서 추적하므로 예전 항목도 다시 읽어야 한다.
const SESSION_CATALOG_SCHEMA_VERSION: u32 = 8;
/// Codex 롤아웃 꼬리에서 마지막 턴의 끝맺음을 찾을 때 읽는 바이트 수. 끝맺음 뒤에는 토큰
/// 집계 몇 줄만 따르고, `task_complete`는 마지막 답 본문을 함께 담으므로 이 정도가 필요하다.
const CODEX_ROLLOUT_TAIL_BYTES: u64 = 64 * 1024;
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
    /// 슬래시 명령만 있는 세션의 제목 폴백. 실제 사용자 텍스트가 있으면 그쪽이 이긴다.
    first_command: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    model: Option<String>,
    started_at: Option<i64>,
    updated_at: Option<i64>,
    message_count: u64,
    tokens: TokenUsage,
    /// 가장 최근 레코드가 실패 안내였으면 그 실패. 뒤에 사용자 요청이나 정상 응답이 오면 비운다.
    #[serde(default)]
    last_failure: Option<SessionLastFailure>,
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
    /// `persisted`/`snapshot`의 읽고-고쳐-쓰기를 직렬화하는 짧은 임계구역 잠금.
    /// 무거운 파일시스템 스캔은 이 잠금 **밖에서** 끝낸다.
    reconcile_lock: Arc<Mutex<()>>,
    /// 같은 범위의 조정 요청을 한 번의 스캔으로 합치는 관문.
    gate: Arc<ReconcileGate>,
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
        // 결정된 프로젝트 목록이 없는 첫 기동에는 현재 프로젝트 전부를 채워, 이후 새로
        // 나타난 프로젝트만 결정 대기로 뜨게 한다. 실패해도 카탈로그 열기를 막지 않는다.
        let _ = seed_known_projects(&app_data_dir, &persisted);
        let projects = registered_project_paths(&app_data_dir, &persisted)?;
        let resources = SnapshotResources::scan(&home, &app_data_dir, &projects, 1)?;
        let snapshot = compose_manager_snapshot(&home, &app_data_dir, &persisted, resources)?;
        Ok(Self {
            app_data_dir: Arc::new(app_data_dir),
            home: Arc::new(home),
            reconcile_lock: Arc::new(Mutex::new(())),
            gate: Arc::new(ReconcileGate::default()),
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

    /// 세션에서 확인한 프로젝트 전체와 이 장치의 활성 여부. 스냅샷은 제외 프로젝트의
    /// 세션을 이미 걷어낸 상태라 여기서는 저장된 색인을 다시 읽어 필터 전 목록을 만든다.
    pub fn project_registry(&self) -> Result<Vec<ProjectRegistryEntry>, CoreError> {
        let persisted = self.read_persisted()?;
        let (sessions, metadata) = catalog_sessions_with_metadata(&self.app_data_dir, &persisted)?;
        let policy = project_policy(&metadata);
        let mut resolver = ProjectPathResolver::default();
        Ok(build_project_registry(&sessions, &policy, &mut resolver))
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

    /// 세션 색인을 다시 읽어 스냅샷에 반영한다.
    ///
    /// 무거운 공급자 스캔은 관문(`gate`)이 같은 범위의 요청을 하나로 합친 뒤 조정
    /// 잠금 **밖에서** 수행한다. 예전에는 요청마다 잠금을 잡고 스캔해서, 화면이 재시도할
    /// 때마다 blocking 스레드가 쌓여 런타임 blocking 풀(기본 512)까지 말라붙었다.
    fn reconcile_scoped(
        &self,
        source: Option<ProviderId>,
        target_id: Option<&str>,
    ) -> Result<SessionCatalogUpdate, CoreError> {
        let scope = ReconcileScope::of(source, target_id);
        self.gate
            .run(scope, || self.run_reconcile(source, target_id))
    }

    /// 실제 스캔·합성 1회. 관문이 동시에 하나만 실행되도록 보장한다.
    fn run_reconcile(
        &self,
        source: Option<ProviderId>,
        target_id: Option<&str>,
    ) -> Result<SessionCatalogUpdate, CoreError> {
        // 1단계: 잠금 밖에서 공급자 색인을 읽는다. 여기가 초 단위로 길어질 수 있다.
        let mut scanned = self.read_persisted()?;
        let provider_cache_changed =
            reconcile_provider_cache(&self.home, &mut scanned, source, target_id)?;

        // 2단계: 짧은 임계구역에서 최신 상태에 합친다. 1단계 도중 다른 갱신이 개정
        // 번호를 올렸을 수 있으므로 색인만 옮기고 개정 번호는 현재 값을 기준으로 삼는다.
        let _reconcile =
            lock_with_timeout(&self.reconcile_lock, CATALOG_LOCK_TIMEOUT, "세션 목록")?;
        let (mut persisted, previous) = self
            .state
            .read()
            .map(|state| (state.persisted.clone(), state.snapshot.clone()))
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        adopt_scanned_caches(&mut persisted, scanned);
        let mut next = compose_manager_snapshot(
            &self.home,
            &self.app_data_dir,
            &persisted,
            SnapshotResources::reuse(&previous),
        )?;
        let changed = next.sessions != previous.sessions
            || next.folders != previous.folders
            || next.pending_projects != previous.pending_projects;
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

    fn read_persisted(&self) -> Result<PersistedSessionCatalog, CoreError> {
        self.state
            .read()
            .map(|state| state.persisted.clone())
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))
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
        // 스킬·에이전트·CLI 상태 스캔은 잠금을 잡기 전에 끝낸다. 예전에는 잠금 안에서
        // 스캔해서, 응답하지 않는 스킬 루트 하나가 세션 조정까지 프로세스 수명 내내
        // 막아 세션 목록이 기동 시점 상태로 굳었다.
        let sessions = self.manager_snapshot()?.sessions;
        let projects = crate::skill_library::project_paths_from_sessions(&sessions);
        let scanned = SnapshotResources::scan(&self.home, &self.app_data_dir, &projects, 1)?;
        note_resource_scan_attempt();
        let _reconcile =
            match lock_with_timeout(&self.reconcile_lock, CATALOG_LOCK_TIMEOUT, "리소스 목록")
            {
                Ok(guard) => guard,
                // 리소스 갱신은 배경 타이머가 도는 작업이다. 잠금을 못 잡으면 오류로 올리지
                // 않고 이번 회차만 건너뛴다. 다음 회차가 같은 일을 다시 한다.
                Err(CoreError::Busy(_)) => return self.unchanged_resource_update(),
                Err(error) => return Err(error),
            };
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
        let mut next =
            compose_manager_snapshot(&self.home, &self.app_data_dir, &persisted, scanned)?;
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
        catalog_health::note_resource_scan(revision);
        Ok(SessionCatalogUpdate { revision, changed })
    }

    /// 이번 회차에 리소스를 다시 읽지 않았음을 알리는 응답. 개정 번호가 그대로라
    /// 호출자는 스냅샷을 다시 받지 않는다.
    fn unchanged_resource_update(&self) -> Result<SessionCatalogUpdate, CoreError> {
        let revision = self
            .state
            .read()
            .map(|state| state.resource_revision)
            .map_err(|_| CoreError::Runtime("리소스 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        Ok(SessionCatalogUpdate {
            revision,
            changed: false,
        })
    }

    /// 배경 타이머용 리소스 갱신. 직전 스캔이 `min_interval`보다 최근이면 건너뛴다.
    ///
    /// 예전에는 번역 워커가 3초마다 전체 스킬·에이전트·아티팩트 스캔과 CLI 프로브를
    /// 다시 돌려, 바뀐 것이 없어도 상시 파일시스템 부하와 잠금 경합을 만들었다.
    pub fn refresh_resources_if_stale(
        &self,
        min_interval: Duration,
    ) -> Result<SessionCatalogUpdate, CoreError> {
        if resource_scan_age().is_some_and(|age| age < min_interval) {
            return self.unchanged_resource_update();
        }
        self.refresh_resources()
    }

    /// 화면이 "지금 보고 있는 목록이 언제 기준인지"를 표시하기 위한 갱신 상태.
    pub fn health(&self) -> Result<CatalogHealth, CoreError> {
        let mut health = catalog_health::health();
        if let Ok(state) = self.state.read() {
            health.session_revision = state.snapshot.session_catalog_revision;
            health.resource_revision = state.resource_revision;
        }
        Ok(health)
    }

    /// 배경에서 주기적으로 세션 색인을 다시 읽는다.
    ///
    /// 갱신을 화면 진입에만 의존하면 세션 목록을 열지 않는 동안 새 대화가 색인되지
    /// 않는다. 관문이 화면 요청과 이 타이머를 하나로 합치므로 스캔이 겹치지 않는다.
    pub fn spawn_periodic_reconcile(&self, interval: Duration) {
        let catalog = self.clone();
        let spawned = thread::Builder::new()
            .name("session-reconcile".to_owned())
            .spawn(move || loop {
                // `Busy`는 화면 요청이 이미 같은 조정을 돌리고 있다는 뜻이라 정상이다.
                let _ = catalog.reconcile();
                thread::sleep(interval);
            });
        if spawned.is_err() {
            // 진행 중 카운터는 건드리지 않고 마지막 오류만 남긴다.
            catalog_health::finish_reconcile(Err(
                "주기 세션 갱신 스레드를 시작하지 못했습니다".to_owned()
            ));
        }
    }

    pub fn refresh_metadata(&self) -> Result<SessionCatalogUpdate, CoreError> {
        let _reconcile = lock_with_timeout(
            &self.reconcile_lock,
            CATALOG_LOCK_TIMEOUT,
            "세션 메타데이터",
        )?;
        let (mut persisted, previous) = self
            .state
            .read()
            .map(|state| (state.persisted.clone(), state.snapshot.clone()))
            .map_err(|_| CoreError::Runtime("세션 카탈로그 잠금이 손상되었습니다".to_owned()))?;
        let mut next = compose_manager_snapshot(
            &self.home,
            &self.app_data_dir,
            &persisted,
            SnapshotResources::reuse(&previous),
        )?;
        let changed = next.sessions != previous.sessions
            || next.folders != previous.folders
            || next.pending_projects != previous.pending_projects;
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

/// 카탈로그 임계구역을 기다릴 최대 시간. 이 시간을 넘기면 `Busy`로 돌려보내
/// 호출자가 스레드를 붙잡은 채 무한히 기다리지 않게 한다. 임계구역 자체는 합성과
/// 파일 저장뿐이라 정상 상황에서는 밀리초 단위로 끝난다.
const CATALOG_LOCK_TIMEOUT: Duration = Duration::from_secs(3);

/// 이미 진행 중인 조정이 끝나기를 기다릴 최대 시간. 초과하면 `Busy`다.
const RECONCILE_JOIN_TIMEOUT: Duration = Duration::from_secs(20);

/// 잠금을 `timeout` 안에만 기다린다.
///
/// `Mutex::lock`은 취소할 수 없어서, 한 요청이 오래 잡고 있으면 뒤따르는 모든 요청이
/// 스레드를 물고 무한 대기했다. 그렇게 쌓인 대기가 런타임 blocking 풀을 고갈시켜
/// 앱 전체가 응답하지 못하는 상태로 번졌다.
fn lock_with_timeout<'a>(
    lock: &'a Mutex<()>,
    timeout: Duration,
    what: &str,
) -> Result<MutexGuard<'a, ()>, CoreError> {
    let deadline = Instant::now() + timeout;
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => {
                return Err(CoreError::Runtime(format!(
                    "{what} 갱신 잠금이 손상되었습니다"
                )));
            }
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(CoreError::Busy(format!(
                        "{what} 갱신이 진행 중입니다. 잠시 후 다시 시도하세요"
                    )));
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// 조정 요청이 덮는 범위.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReconcileScope {
    /// 모든 공급자를 다시 읽는다.
    Full,
    /// 한 세션만 다시 읽는다.
    Target(ProviderId, String),
}

impl ReconcileScope {
    fn of(source: Option<ProviderId>, target_id: Option<&str>) -> Self {
        match (source, target_id) {
            (Some(source), Some(id)) => Self::Target(source, id.to_owned()),
            _ => Self::Full,
        }
    }

    /// 진행 중인 이 범위가 `other` 요청까지 처리해 주는가.
    fn covers(&self, other: &Self) -> bool {
        match self {
            Self::Full => true,
            Self::Target(..) => self == other,
        }
    }
}

#[derive(Default)]
struct ReconcileGateState {
    active: Option<ReconcileScope>,
    /// 완료 회차. 대기자는 이 값이 바뀌면 자기 요청이 처리된 것으로 본다.
    generation: u64,
    last: Option<SessionCatalogUpdate>,
}

/// 같은 범위의 조정 요청을 한 번의 스캔으로 합치는 관문.
///
/// 화면은 실패를 재시도하고 스케줄러 폴링도 갱신을 요청하므로, 요청마다 스캔을 띄우면
/// 같은 파일을 여러 스레드가 동시에 읽는다. 관문은 진행 중 스캔이 내 요청까지 덮으면
/// 그 결과를 그대로 돌려주고, 덮지 않으면 자리가 빈 뒤 실행한다.
#[derive(Default)]
struct ReconcileGate {
    state: Mutex<ReconcileGateState>,
    finished: Condvar,
}

impl ReconcileGate {
    fn run(
        &self,
        scope: ReconcileScope,
        run: impl FnOnce() -> Result<SessionCatalogUpdate, CoreError>,
    ) -> Result<SessionCatalogUpdate, CoreError> {
        let deadline = Instant::now() + RECONCILE_JOIN_TIMEOUT;
        let mut state = self.state.lock().map_err(|_| Self::poisoned())?;
        while let Some(active) = state.active.clone() {
            let joined = active.covers(&scope);
            let generation = state.generation;
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(Self::busy());
            };
            let (next, timeout) = self
                .finished
                .wait_timeout(state, remaining)
                .map_err(|_| Self::poisoned())?;
            state = next;
            if joined && state.generation != generation {
                // 내 요청을 덮는 스캔이 끝났다. 그 결과를 그대로 쓴다.
                return state.last.ok_or_else(Self::busy);
            }
            if timeout.timed_out() {
                return Err(Self::busy());
            }
        }
        state.active = Some(scope);
        drop(state);

        catalog_health::begin_reconcile();
        let result = run();
        catalog_health::finish_reconcile(match &result {
            Ok(update) => Ok(update.revision),
            Err(error) => Err(error.to_string()),
        });

        if let Ok(mut state) = self.state.lock() {
            state.active = None;
            state.generation = state.generation.saturating_add(1);
            state.last = result.as_ref().ok().copied();
        }
        self.finished.notify_all();
        result
    }

    fn busy() -> CoreError {
        CoreError::Busy("세션 목록 갱신이 진행 중입니다. 잠시 후 다시 시도하세요".to_owned())
    }

    fn poisoned() -> CoreError {
        CoreError::Runtime("세션 카탈로그 조정 관문이 손상되었습니다".to_owned())
    }
}

/// 잠금 밖에서 새로 읽은 공급자 색인을 현재 상태에 옮긴다.
///
/// 스캔 중에 다른 갱신이 개정 번호를 올렸을 수 있으므로 색인과 지문만 옮기고 개정
/// 번호는 현재 값을 유지한다.
fn adopt_scanned_caches(current: &mut PersistedSessionCatalog, scanned: PersistedSessionCatalog) {
    current.schema_version = scanned.schema_version;
    current.claude = scanned.claude;
    current.codex_fingerprint = scanned.codex_fingerprint;
    current.codex_sessions = scanned.codex_sessions;
    current.antigravity_fingerprint = scanned.antigravity_fingerprint;
    current.antigravity_sessions = scanned.antigravity_sessions;
}

/// 마지막 리소스 스캔 시각. 배경 타이머가 최소 간격을 지키는 데 쓴다.
fn last_resource_scan() -> &'static Mutex<Option<Instant>> {
    static AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    AT.get_or_init(|| Mutex::new(None))
}

fn note_resource_scan_attempt() {
    if let Ok(mut at) = last_resource_scan().lock() {
        *at = Some(Instant::now());
    }
}

fn resource_scan_age() -> Option<Duration> {
    last_resource_scan()
        .lock()
        .ok()
        .and_then(|at| at.map(|at| at.elapsed()))
}

fn load_persisted_session_catalog(path: &Path) -> Option<PersistedSessionCatalog> {
    let file = File::open(path).ok()?;
    serde_json::from_reader(BufReader::new(file)).ok()
}

fn persist_session_catalog(
    path: &Path,
    catalog: &PersistedSessionCatalog,
) -> Result<(), CoreError> {
    // 세션 색인은 수천 건까지 자라므로 저장 형식은 이전처럼 압축 JSON으로 둔다.
    write_private_bytes(path, &serde_json::to_vec(catalog)?)
}

/// 스냅샷에서 세션 색인이 아닌 부분(CLI 상태·스킬·에이전트)과 그 개정 번호.
///
/// 스킬 스캔은 통합 세션 카탈로그에서 확인한 프로젝트 경로를 전부 열거하므로 클라우드
/// 동기화 폴더·보호 폴더·죽은 마운트가 섞이면 `read_dir`이 커널에서 돌아오지 않는다.
/// 그래서 이 값은 조정 잠금 **밖에서** 만들고, 잠금 안에서는 이미 만들어진 값만 쓴다.
struct SnapshotResources {
    status: AppStatus,
    skills: Vec<SkillSummary>,
    agents: Vec<AgentDefinition>,
    revision: u64,
}

impl SnapshotResources {
    /// 새로 스캔한다. 잠금을 잡기 전에 호출해야 한다.
    fn scan(
        home: &Path,
        app_data_dir: &Path,
        projects: &[PathBuf],
        revision: u64,
    ) -> Result<Self, CoreError> {
        let skills = scan_skills_with_watchdog(home, app_data_dir, projects);
        let agents = scan_agents_with_watchdog(home);
        Ok(Self {
            status: inspect_local_environment()?,
            skills,
            agents,
            revision,
        })
    }

    /// 이전 스냅샷 값을 그대로 재사용한다. 세션 조정은 리소스를 다시 읽지 않는다.
    fn reuse(previous: &ManagerSnapshot) -> Self {
        Self {
            status: previous.status.clone(),
            skills: previous.skills.clone(),
            agents: previous.agents.clone(),
            revision: previous.resource_catalog_revision,
        }
    }
}

fn compose_manager_snapshot(
    home: &Path,
    app_data_dir: &Path,
    persisted: &PersistedSessionCatalog,
    resources: SnapshotResources,
) -> Result<ManagerSnapshot, CoreError> {
    let (mut sessions, metadata) = catalog_sessions_with_metadata(app_data_dir, persisted)?;
    // 제외 프로젝트의 세션은 여기서 빠진다. 이 목록을 읽는 모든 곳(대시보드·아티팩트·스킬
    // 스캔·지침 배포 대상·세션 참조·AIA 작업 루트·화면)이 같은 결과를 본다.
    let registry = apply_project_policy(&mut sessions, &metadata);
    let pending_projects = registry
        .into_iter()
        .filter(|entry| entry.pending)
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| Reverse(session.updated_at));

    let SnapshotResources {
        status,
        skills,
        agents,
        revision,
    } = resources;
    let artifacts = scan_artifacts_with_watchdog(home, &sessions);
    let dashboard = build_dashboard(&sessions, skills.len(), agents.len());
    let folders = store::folders_with_counts(&metadata);

    Ok(ManagerSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        session_catalog_revision: persisted.revision,
        resource_catalog_revision: revision,
        status,
        dashboard,
        sessions,
        folders,
        skills,
        agents,
        artifacts,
        pending_projects,
    })
}

/// 저장된 세션 색인에 장치별 메타(숨김·즐겨찾기)와 AIA 작업공간 표시를 적용한 목록.
/// 스냅샷 합성, 초기 리소스 스캔의 프로젝트 판정, 프로젝트 레지스트리가 같은 순서를 쓴다.
fn catalog_sessions_with_metadata(
    app_data_dir: &Path,
    persisted: &PersistedSessionCatalog,
) -> Result<(Vec<SessionSummary>, store::AppMetadata), CoreError> {
    let metadata = store::load_metadata(app_data_dir)?;
    let mut sessions = dedupe_sessions_by_identity(raw_catalog_sessions(persisted));
    let aia_workspace = canonical_aia_workspace(app_data_dir);
    // 원문에 답이 남지 않은 실패(기동 실패·응답 시간 초과)는 Agent Manager 기록에만 있다.
    // 읽기에 실패해도 목록 자체를 막지 않고 태그만 빠진다.
    let runtime_failures = store::latest_runtime_failures(app_data_dir).unwrap_or_default();
    for session in &mut sessions {
        apply_session_metadata(session, &metadata.sessions);
        apply_session_working_directory(session, &metadata.session_working_directories);
        mark_aia_workspace_session(session, &aia_workspace);
        apply_runtime_failure_tag(session, &runtime_failures);
    }
    Ok((sessions, metadata))
}

/// Agent Manager가 남긴 마지막 실행 실패가 세션의 마지막 사건이면 실패 태그를 단다.
/// 원문이 이미 실패를 남겼으면 그쪽을 두고, 실패 뒤에 원문이 더 자랐으면(새 요청·정상
/// 응답) 지난 일이라 달지 않는다. 사용자 중단(`interrupted`)은 실패가 아니다.
fn apply_runtime_failure_tag(
    session: &mut SessionSummary,
    failures: &HashMap<String, SessionRuntimeFailure>,
) {
    if session.last_failure.is_some() {
        return;
    }
    let Some(failure) = failures.get(&session_key(session.source, &session.id)) else {
        return;
    };
    if failure.status != "failed" {
        return;
    }
    let outdated = session.updated_at.is_some_and(|updated_at| {
        failure.occurred_at + RUNTIME_FAILURE_TWIN_TOLERANCE_MS < updated_at
    });
    if outdated {
        return;
    }
    session.last_failure = Some(SessionLastFailure::new(
        &failure.message,
        Some(failure.occurred_at),
    ));
}

fn project_policy(metadata: &store::AppMetadata) -> ProjectPolicy {
    ProjectPolicy {
        excluded: metadata.excluded_project_set(),
        known: metadata.known_project_set(),
    }
}

/// 제외 프로젝트의 세션을 걸러낸다. 걸러내기 **전** 목록으로 만든 레지스트리를 돌려주므로
/// 결정 대기 프로젝트와 세션이 사라진 제외 프로젝트까지 함께 확인할 수 있다.
fn apply_project_policy(
    sessions: &mut Vec<SessionSummary>,
    metadata: &store::AppMetadata,
) -> Vec<ProjectRegistryEntry> {
    let policy = project_policy(metadata);
    let mut resolver = ProjectPathResolver::default();
    let registry = build_project_registry(sessions, &policy, &mut resolver);
    sessions.retain(|session| !resolver.is_excluded(&policy, session));
    registry
}

/// 결정된 프로젝트 목록이 없으면 현재 프로젝트 전부로 채운다(1회 시드).
fn seed_known_projects(
    app_data_dir: &Path,
    persisted: &PersistedSessionCatalog,
) -> Result<(), CoreError> {
    let (sessions, metadata) = catalog_sessions_with_metadata(app_data_dir, persisted)?;
    if metadata.known_projects.is_some() {
        return Ok(());
    }
    let policy = project_policy(&metadata);
    let mut resolver = ProjectPathResolver::default();
    let paths = build_project_registry(&sessions, &policy, &mut resolver)
        .into_iter()
        .map(|entry| entry.path)
        .collect::<Vec<_>>();
    store::seed_known_projects_if_needed(app_data_dir, &paths)?;
    Ok(())
}

/// AIA 작업공간 세션의 프로젝트 이름. 작업 경로가 앱 데이터 안쪽이라 경로 마지막 조각
/// (`aia-workspace`)을 그대로 쓰면 목록·필터에서 어떤 대화인지 알아보기 어렵다.
const AIA_WORKSPACE_PROJECT: &str = "AIA 작업공간";

/// AIA 작업공간 세션도 목록에 남기되 어느 대화가 AIA와 나눈 것인지 표시한다.
/// 화면은 이 표시로 목록에서 빼거나 배지를 붙이고, 새 채팅 프로젝트 후보에서는 제외한다.
fn mark_aia_workspace_session(session: &mut SessionSummary, aia_workspace: &Path) {
    if !is_aia_workspace_session(session, aia_workspace) {
        return;
    }
    session.aia_workspace = true;
    session.project = Some(AIA_WORKSPACE_PROJECT.to_owned());
}

/// 앱 데이터 아래 AIA 작업공간의 정규 경로. 채팅은 정규화한 경로를 세션 cwd로 남기므로
/// (macOS `/var` → `/private/var`처럼) 양쪽을 같은 기준으로 맞춰야 비교가 어긋나지 않는다.
fn canonical_aia_workspace(app_data_dir: &Path) -> PathBuf {
    let workspace = app_data_dir.join("aia-workspace");
    fs::canonicalize(&workspace).unwrap_or(workspace)
}

fn is_aia_workspace_session(session: &SessionSummary, aia_workspace: &Path) -> bool {
    let Some(cwd) = session.cwd.as_deref() else {
        return false;
    };
    let cwd = Path::new(cwd);
    cwd == aia_workspace || fs::canonicalize(cwd).is_ok_and(|cwd| cwd == aia_workspace)
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

/// 초기 리소스 스캔도 이후 갱신과 같은 등록 프로젝트 판정을 쓴다. 저장된 세션에
/// 장치별 숨김 메타와 AIA 작업공간 표시를 먼저 적용해야 내부 경로가 잠깐 배포 후보로
/// 노출되지 않는다.
fn registered_project_paths(
    app_data_dir: &Path,
    persisted: &PersistedSessionCatalog,
) -> Result<Vec<PathBuf>, CoreError> {
    let (mut sessions, metadata) = catalog_sessions_with_metadata(app_data_dir, persisted)?;
    apply_project_policy(&mut sessions, &metadata);
    Ok(crate::skill_library::project_paths_from_sessions(&sessions))
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
        ProviderId::Claude => find_claude_session(app_data_dir, &home, id),
        ProviderId::Codex => find_codex_session(&home, id),
        ProviderId::Antigravity => find_antigravity_session(&home, id),
    }
    .ok_or_else(|| CoreError::NotFound("세션을 찾을 수 없습니다".to_owned()))?;
    apply_session_metadata(&mut session, &metadata.sessions);
    apply_session_working_directory(&mut session, &metadata.session_working_directories);
    mark_aia_workspace_session(&mut session, &canonical_aia_workspace(app_data_dir));
    Ok(session)
}

/// 대화 기록에 base64로 저장된 이미지 한 장. 목록 응답을 가볍게 유지하려고
/// 위치 정보만 먼저 내려보내고, 표시 시점에 이 함수로 원본 바이트를 읽는다.
pub struct TranscriptImage {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

const MAX_TRANSCRIPT_IMAGE_BYTES: usize = 32 * 1024 * 1024;

pub fn load_session_transcript_image(
    source: ProviderId,
    id: &str,
    offset: usize,
    pointer: &str,
) -> Result<TranscriptImage, CoreError> {
    validate_identifier(id)?;
    if !pointer.starts_with('/') || pointer.len() > 256 {
        return Err(CoreError::InvalidInput(
            "이미지 위치가 올바르지 않습니다".to_owned(),
        ));
    }
    let home = home_dir()?;
    // 이미지는 기록 파일의 위치만 있으면 읽는다. Claude는 요약을 만들려고 파일 전체를
    // 다시 훑을 이유가 없으므로 경로만 찾는다.
    let file_path = match source {
        ProviderId::Claude => find_claude_session_path(&home, id),
        ProviderId::Codex => {
            find_codex_session(&home, id).map(|session| PathBuf::from(session.file_path))
        }
        ProviderId::Antigravity => {
            find_antigravity_session(&home, id).map(|session| PathBuf::from(session.file_path))
        }
    }
    .ok_or_else(|| CoreError::NotFound("세션을 찾을 수 없습니다".to_owned()))?;
    read_transcript_image(&file_path, offset, pointer)
}

/// 기록 파일의 특정 줄에서 JSON 포인터가 가리키는 이미지를 읽어 온다.
fn read_transcript_image(
    path: &Path,
    offset: usize,
    pointer: &str,
) -> Result<TranscriptImage, CoreError> {
    let missing = || CoreError::NotFound("이미지를 담은 기록을 찾지 못했습니다".to_owned());
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(u64::try_from(offset).unwrap_or(u64::MAX)))?;
    let mut line = Vec::new();
    BufReader::new(file).read_until(b'\n', &mut line)?;
    let record = serde_json::from_slice::<Value>(&line).map_err(|_| missing())?;
    let part = record.pointer(pointer).ok_or_else(missing)?;
    let (media_type, data) = transcript_image_payload(part).ok_or_else(missing)?;
    if base64_byte_size(data) > MAX_TRANSCRIPT_IMAGE_BYTES {
        return Err(CoreError::TooLarge(MAX_TRANSCRIPT_IMAGE_BYTES as u64));
    }
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data)
        .map_err(|_| CoreError::NotFound("이미지를 읽지 못했습니다".to_owned()))?;
    Ok(TranscriptImage {
        media_type: media_type.to_owned(),
        bytes,
    })
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
        ProviderId::Claude => find_claude_session(app_data_dir, &home, id),
        ProviderId::Codex => find_codex_session(&home, id),
        ProviderId::Antigravity => find_antigravity_session(&home, id),
    }
    .ok_or_else(|| CoreError::NotFound("세션을 찾을 수 없습니다".to_owned()))?;
    apply_session_metadata(&mut session, &metadata.sessions);
    apply_session_working_directory(&mut session, &metadata.session_working_directories);
    mark_aia_workspace_session(&mut session, &canonical_aia_workspace(app_data_dir));

    let supplements = if before_index.is_none() {
        store::captured_turns_for(app_data_dir, source, id)?
    } else {
        Vec::new()
    };
    let runtime_failures = store::runtime_failures_for(app_data_dir, source, id)?;

    if !session.readable {
        let (mut transcript, truncated) = apply_transcript_limit(
            merge_captured_turns(Vec::new(), supplements, 0),
            transcript_limit,
        );
        merge_runtime_failures(&mut transcript, runtime_failures);
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

    // 보완 저장 결과와 견줄 원본 텍스트가 표시 범위 바로 앞 턴에 있을 수 있다. 판정에 쓸
    // 만큼 더 읽고, 넘치는 앞부분은 병합 뒤 표시 범위로 다시 잘라낸다.
    let parse_limit = transcript_limit.max_items().map(|limit| {
        if supplements.is_empty() {
            limit
        } else {
            limit.saturating_add(supplements.len() + TRANSCRIPT_DEDUP_LOOKBACK)
        }
    });
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

    if let Some(before) = before_index {
        let mut transcript = parsed.items;
        // 화면이 이미 들고 있는 첫 기록의 시각을 알아야 이 구간이 맡을 실패를 가를 수 있다.
        // 경계를 못 읽으면 겹쳐 보이는 쪽보다 최신 구간에 맡기는 쪽이 안전하다.
        if let Some(boundary) =
            transcript_window_start(source, Path::new(&session.file_path), before)
        {
            let failures = failures_within(
                runtime_failures,
                &transcript,
                parsed.truncated,
                Some(boundary),
            );
            merge_runtime_failures(&mut transcript, failures);
        }
        return Ok(SessionDetail {
            session,
            transcript,
            truncated: parsed.truncated,
            skipped_lines: parsed.skipped_lines,
            unavailable_reason: parsed.unavailable_reason,
        });
    }

    let (mut transcript, merged_truncated) = apply_transcript_limit(
        merge_captured_turns(parsed.items, supplements, parsed.total_items),
        transcript_limit,
    );
    let has_older = parsed.truncated || merged_truncated;
    let runtime_failures = failures_within(runtime_failures, &transcript, has_older, None);
    merge_runtime_failures(&mut transcript, runtime_failures);

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

pub fn load_skill_detail(app_data_dir: &Path, id: &str) -> Result<SkillDetail, CoreError> {
    let snapshot = load_manager_snapshot(app_data_dir)?;
    load_skill_detail_from_snapshot(&snapshot, id)
}

pub(crate) fn load_skill_detail_from_snapshot(
    snapshot: &ManagerSnapshot,
    id: &str,
) -> Result<SkillDetail, CoreError> {
    let skill = snapshot
        .skills
        .iter()
        .cloned()
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

/// 보완 저장 결과 중 원본 기록에 이미 있는 것을 걸러내고 남은 것만 뒤에 붙인다.
///
/// 예전 판(과 실패한 턴)의 보완 기록은 한 턴에서 나온 assistant 텍스트 여러 개를 구분자
/// 없이 이어 담는다. 블록 하나와 완전히 같은지만 보던 판정은 그런 기록을 걸러내지 못해,
/// 방금 읽은 응답이 "보완 저장 결과" 카드로 한 번 더 보였다. 원본 텍스트 블록을 순서대로
/// 이어 붙인 사본에 포함되는지로 판정해 이어 담긴 기록도 걸러낸다.
fn merge_captured_turns(
    mut transcript: Vec<TranscriptItem>,
    captured_turns: Vec<store::CapturedTranscriptTurn>,
    mut next_index: usize,
) -> Vec<TranscriptItem> {
    // 견줄 보완 기록이 없으면 사본을 만들지 않는다. 원본 텍스트를 한 번 더 들고 있게 되므로
    // 표시 범위가 '전체'인 긴 대화에서 헛되게 메모리를 쓰지 않도록 한다.
    let mut known_text = if captured_turns.is_empty() {
        String::new()
    } else {
        transcript
            .iter()
            .flat_map(|item| item.blocks.iter())
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(collapsed_transcript_text(text)),
                _ => None,
            })
            .collect::<String>()
    };
    let provider_items = transcript.len();
    for turn in captured_turns {
        let text = cap_text(turn.text, MAX_BLOCK_TEXT);
        let collapsed = collapsed_transcript_text(&text);
        if collapsed.is_empty() || known_text.contains(text_probe(&collapsed)) {
            continue;
        }
        known_text.push_str(&collapsed);
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
    place_appended_by_timestamp(&mut transcript, provider_items);
    transcript
}

/// 원문 레코드는 파일 순서가 논리 순서다. CLI가 로컬 명령 안내처럼 뒤따르는 레코드보다
/// 1ms 늦은 timestamp를 먼저 쓰기도 해서, 전체를 timestamp로 재정렬하면 안내가 자기가
/// 설명하는 명령 뒤로 밀린다. 뒤에 덧붙인 항목만 자기 시각 위치로 옮긴다.
fn place_appended_by_timestamp(transcript: &mut Vec<TranscriptItem>, appended_from: usize) {
    let appended = transcript.split_off(appended_from);
    for item in appended {
        let key = item.timestamp.unwrap_or(i64::MIN);
        let position = transcript
            .iter()
            .position(|existing| existing.timestamp.unwrap_or(i64::MIN) > key)
            .unwrap_or(transcript.len());
        transcript.insert(position, item);
    }
}

/// 앱이 남긴 실행 실패를 일어난 시각 위치에 끼운다. 표시 범위를 잘라낸 뒤에 부르므로
/// 실패 기록이 한도에 밀려 사라지지 않는다. 표시 범위보다 오래된 실패는 목록 맨 앞에
/// 놓이는데, 그 실패는 지금 보이는 어떤 항목보다도 먼저 일어난 것이라 순서가 맞다.
fn merge_runtime_failures(
    transcript: &mut Vec<TranscriptItem>,
    failures: Vec<SessionRuntimeFailure>,
) {
    if failures.is_empty() {
        return;
    }
    // 화면이 항목 식별에 쓰는 순번이라 겹치면 안 된다. 또한 '이전 구간 더 보기' 커서는
    // 가장 작은 순번을 쓰므로(원본 파일의 바이트 오프셋), 새 항목은 뒤에만 붙인다.
    let mut next_index = transcript
        .iter()
        .map(|item| item.index)
        .max()
        .map_or(0, |max| max.saturating_add(1));
    // 견줄 대상은 공급자 원문이 남긴 표식뿐이다. 끼워 넣은 항목까지 함께 보면 몇 초
    // 안에 잇달아 난 실패가 서로를 원문 기록으로 착각해 하나만 남는다.
    let provider_markers = transcript
        .iter()
        .filter(|item| item.role == INTERRUPTED_ROLE || item.role == RUNTIME_FAILURE_ROLE)
        .filter_map(|item| item.timestamp)
        .collect::<Vec<_>>();
    let provider_items = transcript.len();
    for failure in failures {
        // 같은 사건을 공급자 원문이 이미 남겼으면 그 기록을 남긴다. 문구로 견주면 실패
        // 안내와 같은 문장을 담은 진짜 응답까지 지워지므로, 실패 표식의 시각으로만 견준다.
        let twin = provider_markers.iter().any(|timestamp| {
            (timestamp - failure.occurred_at).abs() <= RUNTIME_FAILURE_TWIN_TOLERANCE_MS
        });
        if twin {
            continue;
        }
        transcript.push(TranscriptItem {
            index: next_index,
            role: RUNTIME_FAILURE_ROLE.to_owned(),
            timestamp: Some(failure.occurred_at),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::RuntimeFailure {
                status: failure.status,
                code: failure.code,
                text: failure.message,
            }],
            usage: None,
        });
        next_index += 1;
    }
    place_appended_by_timestamp(transcript, provider_items);
}

/// 표시 구간이 담당할 실행 실패만 고른다. 실패를 늘 최신 구간에 몰아넣으면, 이전 구간을
/// 불러왔을 때 그 구간 안에서 일어난 실패가 구간 뒤에 남아 순서가 어긋난다. 구간마다
/// 자기 시각 범위의 실패만 가져가 어느 구간에서도 한 번씩만 보이게 한다.
fn failures_within(
    failures: Vec<SessionRuntimeFailure>,
    transcript: &[TranscriptItem],
    has_older: bool,
    upper: Option<i64>,
) -> Vec<SessionRuntimeFailure> {
    // 앞에 더 읽을 기록이 없으면 이 구간이 대화의 시작이라 아래쪽 경계를 두지 않는다.
    let lower = has_older
        .then(|| transcript.iter().find_map(|item| item.timestamp))
        .flatten();
    failures
        .into_iter()
        .filter(|failure| {
            lower.is_none_or(|lower| failure.occurred_at >= lower)
                && upper.is_none_or(|upper| failure.occurred_at < upper)
        })
        .collect()
}

/// 이전 구간 조회에서 화면이 이미 들고 있는 첫 기록의 시각. 그 시각부터는 최신 구간이
/// 실패를 맡으므로, 이전 구간과 최신 구간이 같은 실패를 두 번 보여 주지 않게 하는 경계다.
/// 순번이 파일 바이트 오프셋인 jsonl 공급자에만 해당한다.
fn transcript_window_start(source: ProviderId, path: &Path, before_index: usize) -> Option<i64> {
    if matches!(source, ProviderId::Antigravity) {
        return None;
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(u64::try_from(before_index).ok()?))
        .ok()?;
    let mut line = Vec::new();
    BufReader::new(file).read_until(b'\n', &mut line).ok()?;
    let record = serde_json::from_slice::<Value>(&line).ok()?;
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_time)
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

/// 보완 저장 결과와 원본 텍스트를 견주기 위한 비교용 문자열. 줄바꿈·들여쓰기만 다른
/// 같은 응답을 같게 보고, 저장 한도로 잘린 표시는 떼어낸다.
fn collapsed_transcript_text(text: &str) -> String {
    let mut body = text;
    for mark in [TRANSCRIPT_TRUNCATION_MARK, SUPPLEMENT_TRUNCATION_MARK] {
        if let Some((head, _)) = body.split_once(mark) {
            body = head;
        }
    }
    body.split_whitespace().collect()
}

/// 견줄 때 실제로 대조하는 앞부분. 원본과 보완이 서로 다른 한도에서 잘릴 수 있으므로,
/// 앞부분이 통째로 같으면 같은 응답으로 본다.
fn text_probe(collapsed: &str) -> &str {
    let mut end = MAX_TEXT_PROBE_BYTES.min(collapsed.len());
    while !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    &collapsed[..end]
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
            persisted.codex_sessions = list_codex_sessions(home, &persisted.codex_sessions);
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

/// 공급자 색인이 cwd를 제공하지 않을 때만 Agent Manager가 실행 시 기록한 경로를 쓴다.
/// 공급자가 가진 경로가 언제나 우선이므로 파생 메타데이터가 원본을 덮지 않는다.
fn apply_session_working_directory(
    session: &mut SessionSummary,
    working_directories: &HashMap<String, String>,
) {
    if session.cwd.is_some() {
        return;
    }
    let Some(cwd) = working_directories.get(&session_key(session.source, &session.id)) else {
        return;
    };
    if session.project.is_none() {
        session.project = path_name(cwd);
    }
    session.cwd = Some(cwd.clone());
}

/// 세션 상세·요약을 열 때 쓰는 Claude 세션 요약.
///
/// 카탈로그가 이미 훑어 둔 결과가 같은 파일을 가리키면 그대로 쓴다. 재사용 판정은 목록
/// 갱신과 똑같은 지문 비교이므로 결과도 목록과 같고, 파일이 바뀌었으면 그때만 훑는다.
/// 예전에는 여기서 늘 파일 전체를 처음부터 다시 훑어, 10MB짜리 기록 하나를 여는 데
/// 목록이 이미 알고 있는 값을 다시 만드느라 수백 ms를 썼다.
fn find_claude_session(app_data_dir: &Path, home: &Path, id: &str) -> Option<SessionSummary> {
    let path = find_claude_session_path(home, id)?;
    let Ok(fingerprint) = fingerprint_file(&path) else {
        return None;
    };
    let path_text = path.to_string_lossy().into_owned();
    let cached = load_persisted_session_catalog(&app_data_dir.join(SESSION_CATALOG_FILE_NAME))
        .and_then(|catalog| {
            catalog
                .claude
                .into_iter()
                .find(|entry| entry.path == path_text)
        });
    if let Some(entry) = cached
        .as_ref()
        .filter(|entry| entry.fingerprint == fingerprint)
    {
        return Some(claude_summary_from_entry(entry));
    }
    scan_claude_catalog_entry(&path, fingerprint, cached.as_ref())
        .ok()
        .map(|entry| claude_summary_from_entry(&entry))
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
            // 중단 자리표시자와 CLI 자동 주입은 사용자가 보낸 요청이 아니고, 도구 결과와
            // 슬래시 명령 출력은 사용자 턴 자리에 기록될 뿐 메시지가 아니다. 넷 다
            // 메시지 수·제목에서 뺀다.
            if record_interrupt_label(record).is_some()
                || record.get("isMeta").and_then(Value::as_bool) == Some(true)
                || user_record_is_tool_result(record)
                || user_record_is_local_command_output(record)
            {
                return;
            }
            scan.message_count = scan.message_count.saturating_add(1);
            // 새 요청이 들어왔으면 앞선 실패는 지난 일이다.
            scan.last_failure = None;
            if scan.first_user.is_none() {
                scan.first_user = record
                    .pointer("/message/content")
                    .and_then(user_content_text)
                    .map(clean_text)
                    .filter(|text| !text.is_empty() && !text.starts_with('<'))
                    .map(cap_provider_title);
            }
            if scan.first_command.is_none() {
                scan.first_command = record
                    .pointer("/message/content")
                    .and_then(user_content_text)
                    .and_then(slash_command_text)
                    .map(cap_provider_title);
            }
        }
        Some("assistant") => {
            // 중단·오류 자리표시자 레코드는 모델이 "<synthetic>"이라 재개 요청에 쓸 수 없다.
            let model = record
                .pointer("/message/model")
                .and_then(Value::as_str)
                .filter(|value| identifier_value_is_valid(value));
            if model.is_none() && record_interrupt_label(record).is_some() {
                return;
            }
            // CLI가 답 자리에 남긴 실패 안내(한도·인증 만료·거절)는 이 세션의 마지막
            // 사건으로 남기고, 정상 응답이 오면 지운다.
            scan.last_failure = claude_api_error_text(record).map(|text| {
                SessionLastFailure::new(
                    &text,
                    record
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(parse_time),
                )
            });
            scan.message_count = scan.message_count.saturating_add(1);
            if let Some(value) = model {
                scan.model = Some(value.to_owned());
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

/// 슬래시 명령의 출력은 isMeta 표시 없이 `type: "user"`로 남는 CLI 주입 레코드다.
fn user_record_is_local_command_output(record: &Value) -> bool {
    record
        .pointer("/message/content")
        .and_then(user_content_text)
        .is_some_and(|text| text.trim_start().starts_with("<local-command-stdout>"))
}

/// 도구 결과는 `type: "user"`로 남지만 사람이 보낸 메시지가 아니다.
fn user_record_is_tool_result(record: &Value) -> bool {
    record
        .pointer("/message/content")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            !parts.is_empty()
                && parts
                    .iter()
                    .all(|part| part.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
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

/// Claude CLI는 사용자 턴 자리에 여러 가지를 주입하고 `isMeta: true`로 표시한다.
/// Skill 도구가 읽은 SKILL.md 전문, 이미지 첨부 시의 크기 안내, 이어서 진행 지시,
/// 로컬 명령 안내가 모두 여기에 해당한다. 실제 사용자 요청에는 이 표시가 붙지 않으므로
/// isMeta 레코드는 전부 작업 로그 컨텍스트로 돌리고, 무엇이 주입됐는지 라벨로 알려 준다.
fn claude_meta_user_label(record: &Value) -> Option<String> {
    const SKILL_PREFIX: &str = "Base directory for this skill:";
    if record.get("isMeta").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let Some(text) = record
        .pointer("/message/content")
        .and_then(user_content_text)
    else {
        return Some("CLI 자동 주입".to_owned());
    };
    let text = text.trim_start();
    if let Some(base_directory) = text
        .lines()
        .next()
        .and_then(|line| line.strip_prefix(SKILL_PREFIX))
    {
        let name = path_name(base_directory.trim())
            .filter(|name| identifier_value_is_valid(name))
            .unwrap_or_else(|| "이름 확인 불가".to_owned());
        return Some(format!("사용 스킬 · {name}"));
    }
    Some(
        [
            ("[Image:", "이미지 크기 안내"),
            ("Continue from where you left off.", "이어서 진행 지시"),
            ("<local-command-caveat>", "로컬 명령 안내"),
            ("<local-command-stdout>", "로컬 명령 출력"),
        ]
        .into_iter()
        .find_map(|(prefix, label)| text.starts_with(prefix).then_some(label))
        .unwrap_or("CLI 자동 주입")
        .to_owned(),
    )
}

/// 사용자가 응답 도중 중단하면 CLI가 사용자 턴 자리에 남기는 자리표시자. 사용자가 실제로
/// 보낸 요청이 아니므로 제목·메시지 수에서 빼고, 대화에서는 구분선으로만 보여준다.
fn interrupt_marker_label(text: &str) -> Option<&'static str> {
    let text = text.trim_start();
    [
        (
            "[Request interrupted by user for tool use]",
            "도구 실행 중 중단됨",
        ),
        ("[Request interrupted by user]", "사용자가 중단함"),
    ]
    .into_iter()
    .find_map(|(marker, label)| text.starts_with(marker).then_some(label))
}

fn record_interrupt_label(record: &Value) -> Option<&'static str> {
    record
        .pointer("/message/content")
        .and_then(user_content_text)
        .and_then(interrupt_marker_label)
}

/// `isApiErrorMessage` 응답의 본문. CLI가 답 자리에 남긴 합성 실패 안내로, 한도 초과·인증
/// 만료·안전장치 거절이 모두 이 모양이다. 본문이 비면 실패로 보지 않는다.
fn claude_api_error_text(record: &Value) -> Option<String> {
    if record.get("isApiErrorMessage").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let text = record
        .pointer("/message/content")
        .and_then(user_content_text)
        .map(clean_text)
        .filter(|text| !text.is_empty());
    text.or_else(|| {
        record
            .pointer("/message/content")
            .and_then(Value::as_str)
            .map(clean_text)
            .filter(|text| !text.is_empty())
    })
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
        .or_else(|| entry.scan.first_user.clone())
        .or_else(|| entry.scan.first_command.clone());
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
        aia_workspace: false,
        archived: false,
        readable: true,
        size_bytes: Some(entry.fingerprint.size_bytes),
        file_path: entry.path.clone(),
        meta: SessionMeta::default(),
        last_failure: entry.scan.last_failure.clone(),
    }
}

/// 상태 DB는 스레드가 하나만 바뀌어도 통째로 다시 읽으므로, 롤아웃 파일이 그대로인
/// 세션은 지난 목록의 실패 판정을 물려받아 꼬리 읽기를 건너뛴다. 롤아웃은 덧붙이기만
/// 하는 파일이라 크기가 같으면 내용도 같다.
fn list_codex_sessions(home: &Path, previous: &[SessionSummary]) -> Vec<SessionSummary> {
    let previous_failures = previous
        .iter()
        .filter_map(|session| {
            session.size_bytes.map(|size| {
                (
                    (session.file_path.clone(), size),
                    session.last_failure.clone(),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    let mut sessions = list_codex_sessions_uncached(home);
    for session in &mut sessions {
        let Some(size) = session.size_bytes else {
            continue;
        };
        session.last_failure = match previous_failures.get(&(session.file_path.clone(), size)) {
            Some(failure) => failure.clone(),
            None => codex_rollout_last_failure(Path::new(&session.file_path)),
        };
    }
    sessions
}

fn list_codex_sessions_uncached(home: &Path) -> Vec<SessionSummary> {
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
    let mut session = statement
        .query_row(rusqlite::params![id], |row| {
            codex_session_from_row(home, row)
        })
        .ok()?;
    session.last_failure = codex_rollout_last_failure(Path::new(&session.file_path));
    Some(session)
}

/// 롤아웃 꼬리에서 마지막 턴이 어떻게 끝났는지 읽는다. `task_complete`가 `error`를 담으면
/// 실패(한도 초과·서버 과부하 등), 정상 `task_complete`나 사용자 중단(`turn_aborted`)이면
/// 실패가 아니다. 꼬리 안에서 끝맺음을 못 찾으면(진행 중이거나 줄이 아주 길면) 달지 않는다.
fn codex_rollout_last_failure(path: &Path) -> Option<SessionLastFailure> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let start = size.saturating_sub(CODEX_ROLLOUT_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((size - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    // 중간부터 읽었으면 첫 줄은 잘린 조각일 수 있다. JSON이 아니면 그냥 건너뛴다.
    for line in text.lines().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let payload = record.get("payload").unwrap_or(&Value::Null);
        match payload.get("type").and_then(Value::as_str) {
            Some("task_complete") => {
                let message = payload
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|message| !message.is_empty())?;
                let occurred_at = record
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_time);
                return Some(SessionLastFailure::new(message, occurred_at));
            }
            Some("turn_aborted" | "task_started") => return None,
            _ => {}
        }
    }
    None
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
        aia_workspace: false,
        archived,
        readable: resolved_path.is_file(),
        size_bytes: file_metadata.as_ref().map(fs::Metadata::len),
        file_path: resolved_path.to_string_lossy().into_owned(),
        meta: SessionMeta::default(),
        last_failure: None,
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
    // CLI로 시작한 대화는 conversation_summaries.db에 행이 생기지 않아 색인 제목·스텝 수가 늘 빈다.
    // 그럴 때는 대화 DB를 직접 읽어 채운다.
    let scanned = if readable && (indexed.title.is_none() || indexed.step_count.is_none()) {
        scan_antigravity_conversation(&path)
    } else {
        AgConversationScan::default()
    };
    SessionSummary {
        source: ProviderId::Antigravity,
        id,
        title: String::new(),
        source_title: indexed.title.or(scanned.title),
        project: cwd.as_deref().and_then(path_name),
        cwd,
        started_at: None,
        updated_at: indexed
            .updated_at
            .or_else(|| system_time_ms(metadata.modified().ok())),
        message_count: indexed.step_count.or(scanned.step_count),
        token_total: None,
        token_usage: None,
        model: None,
        git_branch: None,
        is_subagent: false,
        aia_workspace: false,
        archived: false,
        readable,
        size_bytes: Some(metadata.len()),
        file_path: path.to_string_lossy().into_owned(),
        meta: SessionMeta::default(),
        last_failure: None,
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

/// Antigravity 대화 DB의 사용자 스텝 배치. `(스텝 종류, 메시지 필드, 생성 제목 필드, 사용자 입력 필드)`
/// 순서이며 제목 필드가 없는 스텝은 `None`이다.
const AG_USER_STEP_FIELDS: &[(i64, u64, Option<u64>, u64)] =
    &[(23, 30, Some(4), 19), (14, 19, None, 2)];
/// 제목을 찾을 때 훑는 앞쪽 스텝 수. 제목은 첫 사용자 턴 근처에만 나온다.
const AG_TITLE_STEP_SCAN: usize = 6;
/// 스텝 페이로드에서 읽어들일 최대 바이트. 도구 결과가 커도 앞부분에 제목·입력이 들어 있다.
const AG_TITLE_PAYLOAD_BYTES: usize = 131_072;

/// 요약 색인이 비었을 때 대화 DB에서 직접 건져낸 값.
#[derive(Debug, Default)]
struct AgConversationScan {
    title: Option<String>,
    step_count: Option<u64>,
}

/// 대화 DB에서 제목과 스텝 수를 읽는다. 요약 색인의 `step_count`도 스텝 테이블 행 수와 같은 값이다.
fn scan_antigravity_conversation(path: &Path) -> AgConversationScan {
    let Ok(connection) = open_sqlite_readonly(path) else {
        return AgConversationScan::default();
    };
    AgConversationScan {
        title: antigravity_title_from_db(&connection),
        step_count: connection
            .query_row("SELECT COUNT(*) FROM steps", [], |row| row.get::<_, u64>(0))
            .ok(),
    }
}

/// 대화 DB 앞부분에서 Antigravity가 생성한 제목을 찾고, 없으면 첫 사용자 입력을 대신 쓴다.
fn antigravity_title_from_db(connection: &Connection) -> Option<String> {
    let mut statement = connection
        .prepare("SELECT step_type, substr(step_payload, 1, ?1) FROM steps ORDER BY idx LIMIT ?2")
        .ok()?;
    let rows = statement
        .query_map(
            rusqlite::params![AG_TITLE_PAYLOAD_BYTES, AG_TITLE_STEP_SCAN],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                ))
            },
        )
        .ok()?;
    let mut first_input = None;
    for (step_type, payload) in rows.flatten() {
        let (Some(step_type), Some(payload)) = (step_type, payload) else {
            continue;
        };
        let Some(&(_, message_field, title_field, input_field)) = AG_USER_STEP_FIELDS
            .iter()
            .find(|(kind, ..)| *kind == step_type)
        else {
            continue;
        };
        let Some(message) = proto_field_bytes(&payload, message_field) else {
            continue;
        };
        if let Some(title) = title_field
            .and_then(|field| proto_field_bytes(message, field))
            .and_then(proto_field_text)
        {
            return Some(cap_provider_title(title));
        }
        if first_input.is_none() {
            first_input = proto_field_bytes(message, input_field).and_then(proto_field_text);
        }
    }
    first_input.map(cap_provider_title)
}

/// 프로토버프 메시지에서 지정한 필드 번호의 길이 지정 값을 찾는다. 형식이 어긋나면 거기서 멈춘다.
fn proto_field_bytes(bytes: &[u8], field: u64) -> Option<&[u8]> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let key = proto_varint(bytes, &mut offset)?;
        match key & 7 {
            0 => {
                proto_varint(bytes, &mut offset)?;
            }
            1 => offset = offset.checked_add(8).filter(|end| *end <= bytes.len())?,
            2 => {
                let length = usize::try_from(proto_varint(bytes, &mut offset)?).ok()?;
                let end = offset
                    .checked_add(length)
                    .filter(|end| *end <= bytes.len())?;
                if key >> 3 == field {
                    return Some(&bytes[offset..end]);
                }
                offset = end;
            }
            5 => offset = offset.checked_add(4).filter(|end| *end <= bytes.len())?,
            _ => return None,
        }
    }
    None
}

fn proto_varint(bytes: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *bytes.get(*offset)?;
        *offset += 1;
        value |= u64::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
}

fn proto_field_text(bytes: &[u8]) -> Option<String> {
    clean_option(std::str::from_utf8(bytes).ok().map(ToOwned::to_owned))
}

/// 스킬·에이전트·아티팩트 스캔 전체를 포기할 시간.
///
/// 루트별로 [`DIR_LIST_TIMEOUT`]과 격리가 먼저 걸리므로, 이 값은 "느린 루트 몇 개를
/// 건너뛰고도 나머지를 다 모을" 여유로 잡는다. 짧게 잡으면 루트 하나가 느릴 때 목록
/// 전체를 잃고, 첫 스캔이라 유지할 이전 결과도 없으면 메뉴가 빈 채로 남는다.
const SKILL_SCAN_TIMEOUT: Duration = Duration::from_secs(10);

/// 스캔 루트 하나를 나열할 때 기다릴 시간.
const DIR_LIST_TIMEOUT: Duration = Duration::from_millis(1_500);

/// 응답하지 않은 루트를 다시 건드리지 않을 시간.
const DIR_QUARANTINE: Duration = Duration::from_secs(300);
/// 한 번 멈춘 뒤 다시 스캔을 시도하기까지의 대기 시간. 3초마다 도는 리소스 갱신이
/// 멈춘 경로에 매번 스레드를 새로 붙이지 않게 한다.
const SKILL_SCAN_COOLDOWN: Duration = Duration::from_secs(60);

/// 응답하지 않아 격리한 스캔 루트와 재시도 시각.
fn directory_quarantine() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static QUARANTINE: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    QUARANTINE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 스캔 루트 하나를 나열한다. 응답하지 않으면 그 루트만 건너뛰고 격리한다.
///
/// `read_dir`은 로컬 경로로 보이는 곳에서도 돌아오지 않을 수 있다(iCloud 데스크톱·문서
/// 동기화, 클라우드 드라이브, 죽은 마운트). 경로 모양이나 마운트 종류로는 미리 가려낼 수
/// 없어서, 실제로 열어 보고 시간이 지나면 포기하는 방법만 통한다. 전체 스캔에 감시자를
/// 하나만 두면 느린 루트 하나 때문에 나머지 루트의 결과까지 통째로 잃는다.
fn guarded_directory_listing(parent: &Path) -> Vec<PathBuf> {
    if let Ok(mut quarantine) = directory_quarantine().lock() {
        match quarantine.get(parent) {
            Some(retry_at) if Instant::now() < *retry_at => return Vec::new(),
            Some(_) => {
                quarantine.remove(parent);
            }
            None => {}
        }
    }
    let target = parent.to_path_buf();
    let (sender, receiver) = mpsc::channel();
    if thread::Builder::new()
        .name("skill-dir-scan".to_owned())
        .spawn(move || {
            let _ = sender.send(crate::skill_library::skill_directories(&target));
        })
        .is_err()
    {
        return Vec::new();
    }
    match receiver.recv_timeout(DIR_LIST_TIMEOUT) {
        Ok(directories) => directories,
        // 커널 `open`에 걸린 스레드는 취소할 수 없다. 버리고 그 루트를 격리한다.
        Err(RecvTimeoutError::Timeout) => {
            if let Ok(mut quarantine) = directory_quarantine().lock() {
                quarantine.insert(parent.to_path_buf(), Instant::now() + DIR_QUARANTINE);
            }
            Vec::new()
        }
        Err(RecvTimeoutError::Disconnected) => Vec::new(),
    }
}

/// 지금 격리된 루트 목록. 화면에 "어느 경로를 건너뛰었는지" 알리는 데 쓴다.
fn quarantined_directories() -> Vec<PathBuf> {
    let Ok(quarantine) = directory_quarantine().lock() else {
        return Vec::new();
    };
    let now = Instant::now();
    let mut paths = quarantine
        .iter()
        .filter(|(_, retry_at)| now < **retry_at)
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

/// macOS가 접근을 통제하는 홈 하위 폴더.
///
/// 이 아래에서 나열이 멈추는 것은 대개 마운트가 죽은 것이 아니라 프로세스에 폴더 접근
/// 권한이 없는 경우다. 권한이 없고 동의 창을 띄울 주체도 없으면(터미널에서 떼어 낸
/// 서버처럼) 커널 호출이 약 20초 멈춘 뒤 EINTR로 실패한다. 원인이 다르면 사용자가 할
/// 조치도 다르므로 문구를 나눈다.
const PERMISSION_GATED_HOME_FOLDERS: [&str; 6] = [
    "Documents",
    "Desktop",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
];

/// 문구에 경로 이름을 그대로 적을 최대 개수. 나머지는 개수로만 센다.
const REPORTED_SKIPPED_ROOTS: usize = 3;

/// 이 경로가 macOS 권한 통제 폴더 안에 있는가.
///
/// 파일시스템을 건드리지 않고 경로 모양만 본다. 멈춘 경로를 확인차 다시 열면 그
/// 스레드도 20초 잡힌다.
fn sits_in_permission_gated_folder(path: &Path, home: &Path) -> bool {
    path.strip_prefix(home).is_ok_and(|relative| {
        relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            .is_some_and(|name| PERMISSION_GATED_HOME_FOLDERS.contains(&name))
    })
}

/// 건너뛴 경로 안내 문구.
///
/// 경로를 하나만 적고 나머지를 "외 N곳"으로 묶으면 사용자가 어디를 못 읽었는지 알 수
/// 없어 조치할 수 없다. 화면에 들어가는 만큼은 이름을 다 적는다.
fn skipped_roots_message(skipped: &[PathBuf], home: Option<&Path>) -> String {
    let listed = skipped
        .iter()
        .take(REPORTED_SKIPPED_ROOTS)
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let more = skipped.len().saturating_sub(REPORTED_SKIPPED_ROOTS);
    let suffix = if more > 0 {
        format!(" 외 {more}곳")
    } else {
        String::new()
    };
    let permission_gated = home.is_some_and(|home| {
        skipped
            .iter()
            .any(|path| sits_in_permission_gated_folder(path, home))
    });
    let remedy = if permission_gated {
        " macOS 폴더 접근 권한이 없으면 이렇게 멈춥니다. 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근에서 Agent Manager를 허용하세요."
    } else {
        ""
    };
    format!("{listed}{suffix} 경로가 응답하지 않아 스킬 목록에서 건너뛰었습니다.{remedy}")
}

/// 스캔은 성공했지만 건너뛴 루트가 있으면 그대로 알린다. 성공 처리가 상태를 지운
/// 뒤에 호출해야, 일부만 모은 목록이 정상으로 보이지 않는다.
fn report_quarantined_skill_roots() {
    let skipped = quarantined_directories();
    if skipped.is_empty() {
        return;
    }
    let home = home_dir().ok();
    catalog_health::note_scan_timeout(
        ScanKind::Skills,
        DIR_QUARANTINE.as_millis(),
        skipped_roots_message(&skipped, home.as_deref()),
    );
}

/// 스캔 감시 상태. 마지막으로 성공한 목록과, 멈춘 경우의 재시도 시점을 갖는다.
#[derive(Default)]
struct ScanGuardState<T> {
    last_good: Option<T>,
    retry_at: Option<Instant>,
}

/// 응답하지 않는 파일시스템 때문에 리소스 갱신 스레드가 영구히 묶이는 것을 막는 감시자.
#[derive(Default)]
struct ScanGuard<T> {
    state: Mutex<ScanGuardState<T>>,
}

type SkillScanGuard = ScanGuard<Vec<SkillSummary>>;

fn skill_scan_guard() -> &'static SkillScanGuard {
    static GUARD: OnceLock<SkillScanGuard> = OnceLock::new();
    GUARD.get_or_init(SkillScanGuard::default)
}

fn agent_scan_guard() -> &'static ScanGuard<Vec<AgentDefinition>> {
    static GUARD: OnceLock<ScanGuard<Vec<AgentDefinition>>> = OnceLock::new();
    GUARD.get_or_init(ScanGuard::default)
}

fn artifact_scan_guard() -> &'static ScanGuard<Vec<ArtifactGroup>> {
    static GUARD: OnceLock<ScanGuard<Vec<ArtifactGroup>>> = OnceLock::new();
    GUARD.get_or_init(ScanGuard::default)
}

fn scan_skills_with_watchdog(
    home: &Path,
    app_data_dir: &Path,
    projects: &[PathBuf],
) -> Vec<SkillSummary> {
    let home = home.to_path_buf();
    let app_data_dir = app_data_dir.to_path_buf();
    let projects = projects.to_vec();
    let skills = guarded_scan(
        skill_scan_guard(),
        ScanKind::Skills,
        SKILL_SCAN_TIMEOUT,
        SKILL_SCAN_COOLDOWN,
        move || {
            let mut skills = list_skills_from_home(&home, &app_data_dir, &projects);
            skills.sort_by_key(|skill| skill.name.to_lowercase());
            skills
        },
    );
    report_quarantined_skill_roots();
    skills
}

/// 에이전트 정의 스캔. `~/.claude/agents`는 보통 로컬이지만, 홈이 동기화 폴더에
/// 걸린 환경에서는 여기서도 `read_dir`이 돌아오지 않는다.
fn scan_agents_with_watchdog(home: &Path) -> Vec<AgentDefinition> {
    let home = home.to_path_buf();
    guarded_scan(
        agent_scan_guard(),
        ScanKind::Agents,
        SKILL_SCAN_TIMEOUT,
        SKILL_SCAN_COOLDOWN,
        move || {
            let mut agents = list_agents_from_home(&home);
            agents.sort_by_key(|agent| agent.name.to_lowercase());
            agents
        },
    )
}

/// 아티팩트 스캔. 대화 제목만 필요하므로 Antigravity 세션만 복사해 넘긴다.
fn scan_artifacts_with_watchdog(home: &Path, sessions: &[SessionSummary]) -> Vec<ArtifactGroup> {
    let home = home.to_path_buf();
    let antigravity = sessions
        .iter()
        .filter(|session| session.source == ProviderId::Antigravity)
        .cloned()
        .collect::<Vec<_>>();
    guarded_scan(
        artifact_scan_guard(),
        ScanKind::Artifacts,
        SKILL_SCAN_TIMEOUT,
        SKILL_SCAN_COOLDOWN,
        move || list_artifacts_from_home(&home, &antigravity),
    )
}

/// 스킬 목록 스캔. 기존 이름을 유지해 감시자 회귀 테스트가 그대로 대상을 가리킨다.
#[cfg(test)]
fn guarded_skill_scan(
    guard: &ScanGuard<Vec<SkillSummary>>,
    timeout: Duration,
    cooldown: Duration,
    scan: impl FnOnce() -> Vec<SkillSummary> + Send + 'static,
) -> Vec<SkillSummary> {
    guarded_scan(guard, ScanKind::Skills, timeout, cooldown, scan)
}

/// 스캔을 별도 스레드에서 수행하고 `timeout` 안에 끝나지 않으면 포기한다.
///
/// 포기한 경우 마지막으로 성공한 목록을 그대로 돌려주고 `cooldown` 동안에는 스캔을
/// 다시 띄우지 않는다. 커널 `open`에 걸린 스레드는 취소할 수 없으므로, 쿨다운이
/// 없으면 갱신 주기마다 멈춘 스레드가 쌓인다. 첫 스캔이 멈춘 경우에만 빈 목록이 되고,
/// 그때도 세션 목록·채팅 등 다른 기능은 계속 갱신된다. 포기 사실은 갱신 상태에 남겨
/// 화면이 "어느 경로가 응답하지 않는지"를 알린다.
fn guarded_scan<T>(
    guard: &ScanGuard<T>,
    kind: ScanKind,
    timeout: Duration,
    cooldown: Duration,
    scan: impl FnOnce() -> T + Send + 'static,
) -> T
where
    T: Default + Clone + Send + 'static,
{
    {
        let Ok(mut state) = guard.state.lock() else {
            return T::default();
        };
        match state.retry_at {
            Some(retry_at) if Instant::now() < retry_at => {
                return state.last_good.clone().unwrap_or_default();
            }
            Some(_) => state.retry_at = None,
            None => {}
        }
    }
    let (sender, receiver) = mpsc::channel();
    if thread::Builder::new()
        .name(format!("{}-scan", kind.thread_name()))
        .spawn(move || {
            let _ = sender.send(scan());
        })
        .is_err()
    {
        return guard
            .state
            .lock()
            .ok()
            .and_then(|state| state.last_good.clone())
            .unwrap_or_default();
    }
    match receiver.recv_timeout(timeout) {
        Ok(scanned) => {
            if let Ok(mut state) = guard.state.lock() {
                state.last_good = Some(scanned.clone());
                state.retry_at = None;
            }
            catalog_health::note_scan_ok(kind);
            scanned
        }
        Err(RecvTimeoutError::Timeout) => {
            catalog_health::note_scan_timeout(
                kind,
                cooldown.as_millis(),
                format!(
                    "{} 스캔이 {}초 안에 응답하지 않아 이전 결과를 유지합니다",
                    kind.label(),
                    timeout.as_secs().max(1)
                ),
            );
            guard
                .state
                .lock()
                .ok()
                .map(|mut state| {
                    state.retry_at = Some(Instant::now() + cooldown);
                    state.last_good.clone().unwrap_or_default()
                })
                .unwrap_or_default()
        }
        // 스캔 스레드가 패닉으로 끝난 경우다. 쿨다운을 걸지 않고 다음 회차에 다시 시도한다.
        Err(RecvTimeoutError::Disconnected) => guard
            .state
            .lock()
            .ok()
            .and_then(|state| state.last_good.clone())
            .unwrap_or_default(),
    }
}

/// 스킬을 훑을 부모 디렉터리 한 곳. 공급자마다 위치·범위·숨김 처리만 다르고 훑는 방식은
/// 같아서, 어디를 어떤 자격으로 읽는지를 이 목록 하나로 모아 둔다.
struct SkillScanSource {
    parent: PathBuf,
    source: ProviderId,
    scope: &'static str,
    origin: Option<String>,
    /// 숨김(`.`으로 시작하는) 디렉터리까지 훑을지. Codex 개인 스킬만 `.system` 하위를
    /// 따로 읽어야 해서 켠다.
    include_hidden: bool,
}

impl SkillScanSource {
    fn new(parent: PathBuf, source: ProviderId, scope: &'static str) -> Self {
        Self {
            parent,
            source,
            scope,
            origin: None,
            include_hidden: false,
        }
    }

    fn origin(mut self, origin: Option<String>) -> Self {
        self.origin = origin;
        self
    }

    fn include_hidden(mut self) -> Self {
        self.include_hidden = true;
        self
    }
}

/// 프로젝트 스킬의 출처 이름. 저장소 디렉터리 이름을 그대로 쓴다.
fn project_origin(project: &Path) -> Option<String> {
    project
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
}

/// 훑을 부모 디렉터리를 공급자·범위 순서대로 늘어놓는다. 뒤에서 경로로 중복을 제거하므로
/// 이 순서가 곧 같은 경로가 여러 범위에 걸릴 때 살아남는 범위를 정한다.
fn skill_scan_sources(home: &Path, projects: &[PathBuf]) -> Vec<SkillScanSource> {
    let mut sources = vec![SkillScanSource::new(
        home.join(".claude/skills"),
        ProviderId::Claude,
        "personal",
    )];
    sources.extend(projects.iter().map(|project| {
        SkillScanSource::new(
            project.join(".claude/skills"),
            ProviderId::Claude,
            "project",
        )
        .origin(project_origin(project))
    }));
    sources.extend(claude_installed_plugin_skill_dirs(home).into_iter().map(
        |(name, skills_dir)| {
            SkillScanSource::new(skills_dir, ProviderId::Claude, "plugin").origin(Some(name))
        },
    ));
    sources.push(
        SkillScanSource::new(home.join(".codex/skills"), ProviderId::Codex, "personal")
            .include_hidden(),
    );
    sources.push(
        SkillScanSource::new(
            home.join(".codex/skills/.system"),
            ProviderId::Codex,
            "system",
        )
        .origin(Some("Codex built-in".to_owned())),
    );
    // Codex도 저장소 안 `.codex/skills`를 프로젝트 스킬로 읽는다.
    sources.extend(projects.iter().map(|project| {
        SkillScanSource::new(project.join(".codex/skills"), ProviderId::Codex, "project")
            .origin(project_origin(project))
    }));
    sources.extend(ACTIVE_AG_ROOTS.iter().map(|root_name| {
        SkillScanSource::new(
            home.join(".gemini").join(root_name).join("builtin/skills"),
            ProviderId::Antigravity,
            "builtin",
        )
        .origin(Some((*root_name).to_owned()))
    }));
    sources
}

fn list_skills_from_home(
    home: &Path,
    app_data_dir: &Path,
    projects: &[PathBuf],
) -> Vec<SkillSummary> {
    let mut skills = Vec::new();
    for source in skill_scan_sources(home, projects) {
        scan_skill_parent(&source, &mut skills);
    }
    let mut seen = HashSet::new();
    skills.retain(|skill| seen.insert(skill.path.clone()));
    // 보관 원본에서 배포된 설치본을 표시한다. 링크본과 사본 모두 디렉터리 이름이 원본 키다.
    let archived = crate::skill_library::archived_repository_skill_keys(app_data_dir);
    for skill in &mut skills {
        skill.archived = Path::new(&skill.directory)
            .file_name()
            .is_some_and(|name| archived.contains(name.to_string_lossy().as_ref()));
    }
    skills
}

/// `SKILL.md`의 이름·설명 캐시 키. 내용은 이 파일에서만 나오므로 크기와 수정시각이
/// 그대로면 다시 읽지 않아도 결과가 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillFrontmatterKey {
    size: u64,
    modified_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct CachedSkillFrontmatter {
    key: SkillFrontmatterKey,
    name: String,
    description: String,
}

fn skill_frontmatter_cache() -> &'static Mutex<HashMap<String, CachedSkillFrontmatter>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSkillFrontmatter>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 스킬 이름·설명을 돌려준다. 바뀌지 않은 파일은 다시 읽지 않는다.
///
/// 배경 리소스 갱신은 전체 스킬을 반복해서 훑으므로, 매 회차마다 모든 `SKILL.md`를
/// 최대 5MB까지 읽어 파싱하면 바뀐 것이 없어도 상시 디스크 부하가 된다.
fn skill_frontmatter(
    path: &Path,
    metadata: &fs::Metadata,
    fallback: &str,
) -> Option<(String, String)> {
    let path_text = path.to_string_lossy().into_owned();
    let key = SkillFrontmatterKey {
        size: metadata.len(),
        modified_at: system_time_ms(metadata.modified().ok()),
    };
    if let Ok(cache) = skill_frontmatter_cache().lock() {
        if let Some(hit) = cache.get(&path_text).filter(|hit| hit.key == key) {
            return Some((hit.name.clone(), hit.description.clone()));
        }
    }
    let text = read_text_limited(path, 5 * 1024 * 1024).ok()?;
    let (frontmatter, _) = split_frontmatter(&text);
    let name = frontmatter_value(frontmatter, "name").unwrap_or_else(|| fallback.to_owned());
    let description = frontmatter_value(frontmatter, "description").unwrap_or_default();
    if let Ok(mut cache) = skill_frontmatter_cache().lock() {
        cache.insert(
            path_text,
            CachedSkillFrontmatter {
                key,
                name: name.clone(),
                description: description.clone(),
            },
        );
    }
    Some((name, description))
}

fn scan_skill_parent(source: &SkillScanSource, output: &mut Vec<SkillSummary>) {
    // 링크로 노출된 스킬도 목록에 넣는다. 공통 원본을 링크로 노출하는 도구가
    // 흔해서, 링크를 건너뛰면 실제로 동작하는 스킬이 목록에서 사라진다.
    for directory in guarded_directory_listing(&source.parent) {
        if !source.include_hidden
            && directory
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        {
            continue;
        }
        let path = directory.join("SKILL.md");
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let fallback = directory
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "skill".to_owned());
        let Some((name, description)) = skill_frontmatter(&path, &metadata, &fallback) else {
            continue;
        };
        output.push(SkillSummary {
            id: stable_id(&path.to_string_lossy()),
            source: source.source,
            scope: source.scope.to_owned(),
            name,
            description,
            path: path.to_string_lossy().into_owned(),
            directory: directory.to_string_lossy().into_owned(),
            origin: source.origin.clone(),
            archived: false,
        });
    }
}

// 실사용 경로는 세션 카탈로그 기반으로 옮겨졌고, 홈 기준 테스트 헬퍼만 남아 쓴다.
#[cfg(test)]
pub(crate) fn claude_project_paths(home: &Path) -> Vec<PathBuf> {
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
    let now = clock::now_ms();
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
        // AIA 작업공간 대화는 사용자가 직접 만든 세션이 아니라 앱이 자기 자신을 조작한 기록이라
        // 최근 세션 목록에서는 뺀다. 집계(세션 수·토큰·프로젝트)에는 그대로 포함한다.
        recent: visible
            .into_iter()
            .filter(|session| !session.aia_workspace)
            .take(12)
            .cloned()
            .collect(),
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

/// 앞에서부터 한 줄씩 읽으면서 각 줄의 시작 바이트 오프셋을 함께 알려 준다.
/// 이미지 블록은 이 오프셋으로 원본 줄을 다시 찾으므로, 줄바꿈 종류와 무관하게
/// 실제로 읽은 바이트 수만 누적해야 한다.
#[derive(Default)]
struct TranscriptLineReader {
    buffer: Vec<u8>,
    offset: usize,
}

impl TranscriptLineReader {
    fn next_line<R: BufRead>(
        &mut self,
        reader: &mut R,
    ) -> Result<Option<(usize, &[u8])>, CoreError> {
        self.buffer.clear();
        let read = reader.read_until(b'\n', &mut self.buffer)?;
        if read == 0 {
            return Ok(None);
        }
        let offset = self.offset;
        self.offset += read;
        Ok(Some((offset, self.buffer.as_slice())))
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
    let mut reader = BufReader::new(File::open(path)?);
    let mut collector = TranscriptCollector::new(limit, before_index);
    let mut skipped = 0;
    let mut lines = TranscriptLineReader::default();
    while let Some((offset, line)) = lines.next_line(&mut reader)? {
        if collector.done() {
            break;
        }
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            skipped += 1;
            continue;
        };
        if let Some(item) = claude_transcript_item(&record, collector.next_index(), offset) {
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
        let Some(item) = claude_transcript_item(&record, offset, offset) else {
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

fn claude_transcript_item(
    record: &Value,
    index: usize,
    line_offset: usize,
) -> Option<TranscriptItem> {
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_time);
    let mut blocks = Vec::new();
    let mut role = None;
    let mut model = None;
    let mut usage = None;
    let mut type_label = None;
    let interrupt = record_interrupt_label(record);
    match record.get("type").and_then(Value::as_str) {
        Some("user") => {
            // 슬래시 명령 출력은 isMeta 표시가 없어도 CLI 주입이다. 사용자 말풍선으로
            // 두면 명령 출력이 요청처럼 보인다.
            let meta_label = claude_meta_user_label(record).or_else(|| {
                user_record_is_local_command_output(record).then(|| "로컬 명령 출력".to_owned())
            });
            // 중단 자리표시자는 턴 구분선으로, CLI가 주입한 메타 레코드는 작업 로그
            // 컨텍스트로 보여준다. 둘 다 실제 사용자 요청 말풍선이 아니다.
            role = Some(
                if meta_label.is_some() {
                    "meta"
                } else {
                    interrupt.map_or("user", |_| INTERRUPTED_ROLE)
                }
                .to_owned(),
            );
            type_label = meta_label
                .clone()
                .or_else(|| interrupt.map(ToOwned::to_owned));
            blocks = claude_content_blocks(record.pointer("/message/content"), true, line_offset);
            if let Some(label) = meta_label {
                for block in &mut blocks {
                    if let ContentBlock::Text { text } = block {
                        let text = std::mem::take(text);
                        *block = ContentBlock::Context {
                            label: label.clone(),
                            text,
                        };
                    }
                }
            }
        }
        Some("assistant") => {
            role = Some("assistant".to_owned());
            blocks = claude_content_blocks(record.pointer("/message/content"), false, line_offset);
            model = record
                .pointer("/message/model")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            // 일부 CLI 판은 중단 자리표시자를 model "<synthetic>" 응답으로 남긴다.
            if let Some(label) =
                interrupt.filter(|_| !model.as_deref().is_some_and(identifier_value_is_valid))
            {
                role = Some(INTERRUPTED_ROLE.to_owned());
                type_label = Some(label.to_owned());
                model = None;
            }
            // CLI가 답 자리에 남긴 실패 안내(레이트리밋 등)는 model이 "<synthetic>"인 합성
            // 응답이다. 일반 말풍선으로 두면 진짜 답과 구분되지 않아 실패 표식으로 바꾼다.
            if record.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                let text = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    role = Some(RUNTIME_FAILURE_ROLE.to_owned());
                    model = None;
                    blocks = vec![ContentBlock::RuntimeFailure {
                        status: "failed".to_owned(),
                        code: record
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("apiError")
                            .to_owned(),
                        text,
                    }];
                }
            }
            let value = TokenUsage {
                input: json_u64_pointer(record, "/message/usage/input_tokens"),
                output: json_u64_pointer(record, "/message/usage/output_tokens"),
                cache_read: json_u64_pointer(record, "/message/usage/cache_read_input_tokens"),
                cache_write: json_u64_pointer(record, "/message/usage/cache_creation_input_tokens"),
            };
            let failed = role.as_deref() == Some(RUNTIME_FAILURE_ROLE);
            usage = (!failed && value.total() > 0).then_some(value);
        }
        Some("system") if record.get("isMeta").and_then(Value::as_bool) != Some(true) => {
            if let Some((label, text)) = claude_system_context(record) {
                role = Some("system".to_owned());
                blocks.push(ContentBlock::Context {
                    label,
                    text: cap_text(text, MAX_BLOCK_TEXT),
                });
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
            type_label,
            blocks,
            usage,
        })
}

/// system 레코드는 종류마다 내용을 담는 자리가 다르다. `content`만 읽던 때에는
/// 그 자리가 비어 있는 `api_error`가 통째로 사라져, 인증 만료나 레이트리밋으로 턴이
/// 끊긴 이유를 화면에서 알 수 없었다. 종류별로 읽을 자리를 지정해 컨텍스트로 남긴다.
fn claude_system_context(record: &Value) -> Option<(String, String)> {
    let content = record
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    match record.get("subtype").and_then(Value::as_str) {
        // 턴 소요 시간은 표시할 문장이 없고, 훅 요약은 셸 커맨드 원문뿐이라 남기지 않는다.
        Some("turn_duration" | "stop_hook_summary") => None,
        Some("api_error") => {
            let message = record
                .pointer("/error/formatted")
                .and_then(Value::as_str)
                .or_else(|| record.pointer("/error/message").and_then(Value::as_str))
                .or(content)?;
            let attempt = json_u64_pointer(record, "/retryAttempt");
            let text = if attempt > 0 {
                let max = json_u64_pointer(record, "/maxRetries");
                format!("{message}\n재시도 {attempt}/{max}")
            } else {
                message.to_owned()
            };
            Some(("API 오류".to_owned(), text))
        }
        Some("compact_boundary") => {
            let trigger = record
                .pointer("/compactMetadata/trigger")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let pre_tokens = json_u64_pointer(record, "/compactMetadata/preTokens");
            let head = content.unwrap_or("Conversation compacted");
            Some((
                "대화 압축".to_owned(),
                format!("{head}\n트리거 {trigger} · 압축 전 {pre_tokens} 토큰"),
            ))
        }
        Some("local_command") => {
            // 슬래시 명령이 남긴 출력. 감싼 태그는 CLI 내부 표기라 벗겨서 보여 준다.
            let text = content?;
            let body = tagged_value(text, "local-command-stdout").unwrap_or(text);
            Some(("로컬 명령 출력".to_owned(), body.trim().to_owned()))
        }
        _ => content.map(|text| ("시스템 메시지".to_owned(), text.to_owned())),
    }
}

fn claude_content_blocks(
    content: Option<&Value>,
    user: bool,
    line_offset: usize,
) -> Vec<ContentBlock> {
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
        .enumerate()
        .flat_map(|(position, part)| {
            let pointer = format!("/message/content/{position}");
            match part.get("type").and_then(Value::as_str) {
                Some("text") => part
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| vec![transcript_text_block(text, user)])
                    .unwrap_or_default(),
                // sdk-cli로 띄운 세션은 추론 원문을 남기지 않고 서명만 적는다. 빈 카드는
                // 읽을 것이 없으면서 작업 로그 개수만 부풀리므로 블록을 만들지 않는다.
                Some("thinking") => part
                    .get("thinking")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .map(|text| {
                        vec![ContentBlock::Thinking {
                            text: cap_text(text.to_owned(), MAX_BLOCK_TEXT),
                        }]
                    })
                    .unwrap_or_default(),
                Some("tool_use") if !user => vec![ContentBlock::ToolUse {
                    name: part
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_owned(),
                    input_json: pretty_json(part.get("input").unwrap_or(&Value::Null)),
                }],
                Some("tool_result") => {
                    let mut blocks = vec![ContentBlock::ToolResult {
                        text: cap_text(content_value_to_text(part.get("content")), MAX_BLOCK_TEXT),
                        is_error: part
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }];
                    blocks.extend(transcript_image_blocks(
                        part.get("content"),
                        line_offset,
                        &format!("{pointer}/content"),
                    ));
                    blocks
                }
                Some("image") => transcript_image_block(part, line_offset, pointer)
                    .into_iter()
                    .collect(),
                _ => Vec::new(),
            }
        })
        .collect()
}

/// 내용 배열에 섞여 있는 이미지 조각만 골라 위치 정보를 담은 블록으로 만든다.
fn transcript_image_blocks(
    content: Option<&Value>,
    line_offset: usize,
    pointer_prefix: &str,
) -> Vec<ContentBlock> {
    let Some(parts) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    parts
        .iter()
        .enumerate()
        .filter_map(|(position, part)| {
            transcript_image_block(part, line_offset, format!("{pointer_prefix}/{position}"))
        })
        .collect()
}

/// 이미지 조각을 화면에서 다시 읽을 수 있는 위치·크기 정보로 바꾼다.
/// base64 원문은 응답에 담지 않고, 표시 시점에 해당 줄에서 다시 읽는다.
fn transcript_image_block(
    part: &Value,
    line_offset: usize,
    pointer: String,
) -> Option<ContentBlock> {
    let (media_type, data) = transcript_image_payload(part)?;
    Some(ContentBlock::Image(Box::new(TranscriptImageBlock {
        media_type: media_type.to_owned(),
        byte_size: base64_byte_size(data),
        source_offset: line_offset,
        source_pointer: pointer,
    })))
}

/// Claude는 `source.data`에 base64를, Codex는 `image_url`에 data URL을 담는다.
fn transcript_image_payload(part: &Value) -> Option<(&str, &str)> {
    if let Some(data) = part.pointer("/source/data").and_then(Value::as_str) {
        let media_type = part
            .pointer("/source/media_type")
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        return supported_image_media_type(media_type).map(|media_type| (media_type, data));
    }
    let url = part.get("image_url").and_then(|value| match value {
        Value::String(url) => Some(url.as_str()),
        value => value.get("url").and_then(Value::as_str),
    })?;
    let (media_type, data) = url.strip_prefix("data:")?.split_once(',')?;
    let media_type = media_type.strip_suffix(";base64")?;
    supported_image_media_type(media_type).map(|media_type| (media_type, data))
}

/// 브라우저가 이미지로 그릴 수 있고 스크립트를 품지 않는 형식만 허용한다.
fn supported_image_media_type(media_type: &str) -> Option<&str> {
    matches!(
        media_type,
        "image/png"
            | "image/jpeg"
            | "image/jpg"
            | "image/gif"
            | "image/webp"
            | "image/bmp"
            | "image/avif"
            | "image/heic"
            | "image/heif"
            | "image/tiff"
    )
    .then_some(media_type)
}

/// base64 문자열이 나타내는 원본 바이트 수.
fn base64_byte_size(data: &str) -> usize {
    let padding = data.bytes().rev().take_while(|byte| *byte == b'=').count();
    (data.len() / 4 * 3).saturating_sub(padding)
}

fn parse_codex_transcript(
    path: &Path,
    limit: Option<usize>,
    before_index: Option<usize>,
) -> Result<ParsedTranscript, CoreError> {
    if let Some(limit) = limit {
        return parse_codex_transcript_tail(path, limit, before_index);
    }
    let mut reader = BufReader::new(File::open(path)?);
    let mut collector = TranscriptCollector::new(limit, before_index);
    let mut skipped = 0;
    let mut session_meta_seen = false;
    let mut lines = TranscriptLineReader::default();
    while let Some((offset, line)) = lines.next_line(&mut reader)? {
        if collector.done() {
            break;
        }
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            skipped += 1;
            continue;
        };
        let record_type = record.get("type").and_then(Value::as_str);
        let include_session_meta = record_type == Some("session_meta") && !session_meta_seen;
        if record_type == Some("session_meta") {
            session_meta_seen = true;
        }
        if let Some(value) = codex_transcript_item(
            &record,
            collector.next_index(),
            include_session_meta,
            offset,
        ) {
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
        let Some(item) = codex_transcript_item(&record, offset, include_session_meta, offset)
        else {
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
    line_offset: usize,
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
            let images =
                transcript_image_blocks(payload.get("content"), line_offset, "/payload/content");
            if text.trim().is_empty() && images.is_empty() {
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
            let mut blocks = Vec::new();
            if !text.trim().is_empty() {
                if let Some(label) = context_label {
                    blocks.push(ContentBlock::Context {
                        label: label.to_owned(),
                        text: cap_text(text, MAX_BLOCK_TEXT),
                    });
                } else if let Some(pasted) = (source_role == "user")
                    .then(|| pasted_files_blocks(&text))
                    .flatten()
                {
                    blocks.extend(pasted);
                } else {
                    blocks.push(ContentBlock::Text {
                        text: cap_text(text, MAX_BLOCK_TEXT),
                    });
                }
            }
            blocks.extend(images);
            Some(transcript_item_with_blocks(
                index,
                role,
                timestamp,
                context_label,
                blocks,
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
        Some("function_call_output") | Some("custom_tool_call_output") => {
            let mut blocks = vec![ContentBlock::ToolResult {
                text: cap_text(content_value_to_text(payload.get("output")), MAX_BLOCK_TEXT),
                is_error: false,
            }];
            blocks.extend(transcript_image_blocks(
                payload.get("output"),
                line_offset,
                "/payload/output",
            ));
            Some(transcript_item_with_blocks(
                index,
                "meta",
                timestamp,
                Some("도구 결과"),
                blocks,
            ))
        }
        _ => None,
    }
}

/// `<command-name>` 묶음 안에서 한 태그의 값을 꺼낸다.
fn tagged_value<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let rest = &text[text.find(&open)? + open.len()..];
    Some(&rest[..rest.find(&close)?])
}

/// 슬래시 명령은 이름·설명·인자를 각각 태그로 감싼 사용자 레코드로 기록된다.
/// CLI 내부 표기일 뿐 사람이 친 것은 한 줄이므로, 원문 XML 대신 그 한 줄로 되돌린다.
fn slash_command_text(text: &str) -> Option<String> {
    let text = text.trim_start();
    if !text.starts_with("<command-name>") {
        return None;
    }
    let name = tagged_value(text, "command-name")?.trim();
    if name.is_empty() {
        return None;
    }
    let args = tagged_value(text, "command-args")
        .map(str::trim)
        .unwrap_or_default();
    Some(if args.is_empty() {
        name.to_owned()
    } else {
        format!("{name} {args}")
    })
}

/// 슬래시 명령 출력 레코드의 본문. 감싼 태그는 CLI 내부 표기라 벗겨서 보여 준다.
fn local_command_stdout_text(text: &str) -> Option<String> {
    let text = text.trim_start();
    if !text.starts_with("<local-command-stdout>") {
        return None;
    }
    Some(
        tagged_value(text, "local-command-stdout")
            .unwrap_or(text)
            .trim()
            .to_owned(),
    )
}

fn transcript_text_block(text: &str, user: bool) -> ContentBlock {
    if user {
        if let Some(command) = slash_command_text(text) {
            return ContentBlock::Text { text: command };
        }
        if let Some(body) = local_command_stdout_text(text) {
            return ContentBlock::Context {
                label: "로컬 명령 출력".to_owned(),
                text: cap_text(body, MAX_BLOCK_TEXT),
            };
        }
    }
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

/// ChatGPT 앱에서 파일을 붙여넣으면 Codex는 사용자가 쓴 요청을 이 봉투로 감싸 기록한다.
/// 봉투째 마크다운으로 그리면 제목 두 단계가 말풍선을 차지하고, 정작 사용자가 쓴 요청은
/// 맨 아래 작은 한 줄로 밀린다.
const PASTED_FILES_HEADING: &str = "# Files pasted by the user:";
const PASTED_REQUEST_HEADING: &str = "## My request:";

/// 붙여넣기 봉투를 풀어 붙인 파일 목록은 접어 두고 사용자가 쓴 요청만 본문으로 남긴다.
/// 봉투가 아니거나 요청 자리가 비어 있으면 원문을 건드리지 않는다.
fn pasted_files_blocks(text: &str) -> Option<Vec<ContentBlock>> {
    let (files, request) = text
        .trim_start()
        .strip_prefix(PASTED_FILES_HEADING)?
        .split_once(PASTED_REQUEST_HEADING)?;
    let request = request.trim();
    if request.is_empty() {
        return None;
    }
    let files = files
        .lines()
        .filter_map(|line| line.trim().strip_prefix("## "))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let mut blocks = Vec::new();
    if !files.is_empty() {
        blocks.push(ContentBlock::Context {
            label: "붙여넣은 파일".to_owned(),
            text: cap_text(files, MAX_BLOCK_TEXT),
        });
    }
    blocks.push(ContentBlock::Text {
        text: cap_text(request.to_owned(), MAX_BLOCK_TEXT),
    });
    Some(blocks)
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
        // 하니스가 user 턴으로 주입하는 시스템 메시지. 사용자 요청으로 표시하지 않는다.
        ("<task-notification>", "백그라운드 작업 알림"),
        ("[SYSTEM NOTIFICATION", "백그라운드 작업 알림"),
        ("<system-reminder>", "시스템 알림"),
        ("<system_reminder>", "시스템 알림"),
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
    transcript_item_with_blocks(index, role, timestamp, type_label, vec![block])
}

fn transcript_item_with_blocks(
    index: usize,
    role: &str,
    timestamp: Option<i64>,
    type_label: Option<&str>,
    blocks: Vec<ContentBlock>,
) -> TranscriptItem {
    TranscriptItem {
        index,
        role: role.to_owned(),
        timestamp,
        model: None,
        type_label: type_label.map(ToOwned::to_owned),
        blocks,
        usage: None,
    }
}

pub(crate) fn build_file_tree(root: &Path, max_entries: usize) -> Result<Vec<FileNode>, CoreError> {
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

pub(crate) fn split_frontmatter(text: &str) -> (&str, &str) {
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

pub(crate) fn frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    let lines: Vec<&str> = frontmatter.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let Some(raw) = line.trim_start().strip_prefix(&prefix) else {
            continue;
        };
        let raw = raw.trim();
        // YAML 블록 스칼라(`>-`, `|` 등)는 마커 다음의 들여쓰기 줄들이 실제 값이다.
        // 마커를 값으로 돌려주면 스킬 설명이 ">-" 두 글자로 저장되고 번역까지
        // 그 쓰레기 값을 대상으로 하게 된다.
        if matches!(raw, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
            let folded = raw.starts_with('>');
            let mut collected: Vec<String> = Vec::new();
            for follow in &lines[index + 1..] {
                let trimmed = follow.trim();
                if trimmed.is_empty() {
                    if collected.is_empty() {
                        break;
                    }
                    continue;
                }
                if !follow.starts_with(' ') && !follow.starts_with('\t') {
                    break;
                }
                collected.push(trimmed.to_owned());
            }
            let joined = collected.join(if folded { " " } else { "\n" });
            return if joined.is_empty() {
                None
            } else {
                Some(joined)
            };
        }
        let value = raw.trim_matches(['\'', '"']).trim().to_owned();
        if value.is_empty() {
            continue;
        }
        return Some(value);
    }
    None
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

pub(crate) fn child_directories(parent: &Path) -> Vec<PathBuf> {
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

/// 설치 레지스트리는 플러그인 항목마다 수백 바이트라 1 MB면 수천 개까지 담는다.
const MAX_PLUGIN_REGISTRY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaudeInstalledPlugin {
    pub(crate) plugin_id: String,
    pub(crate) name: String,
    pub(crate) marketplace: String,
    pub(crate) version: Option<String>,
    pub(crate) install_path: PathBuf,
    pub(crate) default_enabled: bool,
}

/// 설치된 Claude 플러그인의 (표시 이름, skills 디렉터리) 목록. 플러그인 실체는
/// 설치 레지스트리(`~/.claude/plugins/installed_plugins.json`)의 installPath에
/// 있다. 마켓플레이스 클론은 설치 여부와 무관한 카탈로그 사본일 뿐이고, 외부
/// URL 소스 플러그인(superpowers 등)은 클론에 실체가 아예 없으므로 훑지 않는다.
pub(crate) fn claude_installed_plugin_skill_dirs(home: &Path) -> Vec<(String, PathBuf)> {
    claude_installed_plugins(home)
        .into_iter()
        .map(|plugin| (plugin.name, plugin.install_path.join("skills")))
        .collect()
}

/// 설치 레지스트리를 UI용 플러그인 인벤토리로 읽는다. 사용 여부는 이 레지스트리가 아니라
/// settings.json의 `enabledPlugins`가 결정하므로 여기서는 설치 메타데이터만 돌려준다.
pub(crate) fn claude_installed_plugins(home: &Path) -> Vec<ClaudeInstalledPlugin> {
    let registry = home.join(".claude/plugins/installed_plugins.json");
    let Ok(text) = read_text_limited(&registry, MAX_PLUGIN_REGISTRY_BYTES) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(plugins) = value.get("plugins").and_then(|entry| entry.as_object()) else {
        return Vec::new();
    };
    let mut plugins_out = Vec::new();
    let mut seen = BTreeSet::new();
    for (key, installs) in plugins {
        // 키는 `이름@마켓플레이스` 형태다. 표시 출처는 이름만 쓴다.
        let (name, marketplace) = key.split_once('@').unwrap_or((key, ""));
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // 레지스트리 v2는 설치본 배열, 그 이전 형식은 객체 하나를 값으로 둔다.
        let installs: Vec<&serde_json::Value> = match installs {
            serde_json::Value::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        for install in installs {
            let Some(path) = install.get("installPath").and_then(|entry| entry.as_str()) else {
                continue;
            };
            if !seen.insert(path.to_owned()) {
                continue;
            }
            let install_path = PathBuf::from(path);
            let default_enabled =
                read_text_limited(&install_path.join(".claude-plugin/plugin.json"), 256 * 1024)
                    .ok()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                    .and_then(|manifest| {
                        manifest
                            .get("defaultEnabled")
                            .and_then(|value| value.as_bool())
                    })
                    .unwrap_or(true);
            plugins_out.push(ClaudeInstalledPlugin {
                plugin_id: key.to_owned(),
                name: name.to_owned(),
                marketplace: marketplace.trim().to_owned(),
                version: install
                    .get("version")
                    .and_then(|entry| entry.as_str())
                    .map(str::to_owned),
                install_path,
                default_enabled,
            });
        }
    }
    plugins_out
}

pub(crate) fn read_text_limited(path: &Path, max_bytes: u64) -> Result<String, CoreError> {
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

fn session_key(source: ProviderId, id: &str) -> String {
    format!("{}:{id}", source.as_str())
}

pub(crate) fn stable_id(value: &str) -> String {
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
    use crate::domain::SessionFailureKind;
    use serde_json::json;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

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
            aia_workspace: false,
            archived: false,
            readable: true,
            size_bytes: None,
            file_path: String::new(),
            meta: SessionMeta::default(),
            last_failure: None,
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
    fn session_working_directory_fills_only_a_missing_provider_path() {
        let mut session = session_with_cwd(
            TEST_SESSION_ID,
            PathBuf::from("/provider/authoritative-project"),
        );
        session.source = ProviderId::Antigravity;
        session.cwd = None;
        session.project = None;
        let working_directories = HashMap::from([(
            session_key(session.source, &session.id),
            "/workspace/recovered-project".to_owned(),
        )]);

        apply_session_working_directory(&mut session, &working_directories);

        assert_eq!(session.cwd.as_deref(), Some("/workspace/recovered-project"));
        assert_eq!(session.project.as_deref(), Some("recovered-project"));

        session.cwd = Some("/provider/authoritative-project".to_owned());
        session.project = Some("authoritative-project".to_owned());
        apply_session_working_directory(&mut session, &working_directories);
        assert_eq!(
            session.cwd.as_deref(),
            Some("/provider/authoritative-project")
        );
        assert_eq!(session.project.as_deref(), Some("authoritative-project"));
    }

    #[test]
    fn dashboard_keeps_twelve_recent_sessions_to_fill_the_overview_panel() {
        let sessions = (0..13)
            .map(|index| {
                session_with_cwd(
                    &format!("session-{index:02}"),
                    PathBuf::from("/workspace/project"),
                )
            })
            .collect::<Vec<_>>();

        let dashboard = build_dashboard(&sessions, 0, 0);

        assert_eq!(dashboard.recent.len(), 12);
        assert_eq!(dashboard.recent[0].id, "session-00");
        assert_eq!(dashboard.recent[11].id, "session-11");
    }

    #[test]
    fn dashboard_recent_sessions_skip_aia_workspace_conversations() {
        let mut aia = session_with_cwd("aia-session", PathBuf::from("/data/aia-workspace"));
        aia.aia_workspace = true;
        let sessions = vec![
            aia,
            session_with_cwd("session-00", PathBuf::from("/workspace/project")),
        ];

        let dashboard = build_dashboard(&sessions, 0, 0);

        assert_eq!(dashboard.recent.len(), 1);
        assert_eq!(dashboard.recent[0].id, "session-00");
        assert_eq!(dashboard.session_count, 2, "집계에는 AIA 세션도 남는다");
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
    fn session_detail_reuses_the_catalog_scan_when_the_file_has_not_changed() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        let path = claude_session_file_in(&home, "test-project", TEST_SESSION_ID);
        write_json_lines(&path, &claude_turns(3, 0));
        let fingerprint = fingerprint_file(&path).expect("fingerprint");
        persist_test_catalog(
            &data,
            &PersistedSessionCatalog {
                claude: vec![ClaudeCatalogEntry {
                    path: path.to_string_lossy().into_owned(),
                    fingerprint,
                    // 다시 훑으면 나올 수 없는 값이라, 목록의 스캔 결과를 그대로 썼는지 구분된다.
                    scan: ClaudeScanState {
                        first_user: Some("카탈로그가 기억한 제목".to_owned()),
                        message_count: 99,
                        ..ClaudeScanState::default()
                    },
                }],
                ..PersistedSessionCatalog::default()
            },
        );

        let reused = find_claude_session(&data, &home, TEST_SESSION_ID).expect("세션 요약");
        assert_eq!(
            reused.source_title.as_deref(),
            Some("카탈로그가 기억한 제목")
        );
        assert_eq!(reused.message_count, Some(99));

        // 기록이 바뀌면 지문이 어긋나므로 그때만 파일을 다시 훑는다.
        write_json_lines(&path, &claude_turns(1, 0));
        let rescanned = find_claude_session(&data, &home, TEST_SESSION_ID).expect("세션 요약");
        assert_eq!(rescanned.message_count, Some(1));
    }

    fn skill_named(name: &str) -> SkillSummary {
        SkillSummary {
            id: name.to_owned(),
            source: ProviderId::Claude,
            scope: "personal".to_owned(),
            origin: None,
            name: name.to_owned(),
            description: String::new(),
            path: format!("/tmp/{name}/SKILL.md"),
            directory: format!("/tmp/{name}"),
            archived: false,
        }
    }

    /// 응답하지 않는 루트는 그 루트만 건너뛴다. 전체 스캔에 감시자를 하나만 두면
    /// 느린 루트 하나 때문에 나머지 루트의 스킬까지 통째로 사라진다.
    #[test]
    fn a_quarantined_scan_root_is_skipped_until_its_retry_time_passes() {
        let root = tempfile::tempdir().expect("temporary root");
        let parent = root.path().join("skills");
        let skill = parent.join("mine");
        fs::create_dir_all(&skill).expect("skill directory");

        assert_eq!(
            guarded_directory_listing(&parent),
            vec![skill.clone()],
            "정상 루트는 그대로 나열한다"
        );

        directory_quarantine()
            .lock()
            .expect("quarantine")
            .insert(parent.clone(), Instant::now() + Duration::from_secs(60));
        assert!(
            guarded_directory_listing(&parent).is_empty(),
            "격리된 루트는 열어 보지 않는다"
        );
        assert!(quarantined_directories().contains(&parent));

        directory_quarantine()
            .lock()
            .expect("quarantine")
            .insert(parent.clone(), Instant::now());
        assert_eq!(
            guarded_directory_listing(&parent),
            vec![skill],
            "재시도 시각이 지나면 다시 열어 본다"
        );
        assert!(!quarantined_directories().contains(&parent));
        directory_quarantine()
            .lock()
            .expect("quarantine")
            .remove(&parent);
    }

    #[test]
    fn the_skipped_root_notice_names_every_path_it_can_and_counts_the_rest() {
        let home = Path::new("/Users/tester");
        let skipped = [
            PathBuf::from("/opt/one/.claude/skills"),
            PathBuf::from("/opt/two/.claude/skills"),
            PathBuf::from("/opt/three/.claude/skills"),
            PathBuf::from("/opt/four/.claude/skills"),
        ];

        let message = skipped_roots_message(&skipped[..1], Some(home));
        assert!(
            message.starts_with("/opt/one/.claude/skills 경로가"),
            "{message}"
        );
        assert!(
            !message.contains("외"),
            "한 곳뿐이면 개수를 붙이지 않는다: {message}"
        );

        let message = skipped_roots_message(&skipped, Some(home));
        for path in &skipped[..REPORTED_SKIPPED_ROOTS] {
            assert!(
                message.contains(&path.display().to_string()),
                "적을 수 있는 경로는 다 적는다: {message}"
            );
        }
        assert!(message.contains("외 1곳"), "{message}");
        assert!(
            !message.contains("four"),
            "네 번째부터는 개수로만 센다: {message}"
        );
    }

    #[test]
    fn a_root_under_a_permission_gated_folder_gets_the_permission_remedy() {
        let home = Path::new("/Users/tester");
        let gated = [PathBuf::from("/Users/tester/Documents/work/.claude/skills")];
        let plain = [PathBuf::from(
            "/Users/tester/gsProjects/work/.claude/skills",
        )];

        assert!(
            skipped_roots_message(&gated, Some(home)).contains("전체 디스크 접근"),
            "권한 통제 폴더는 조치 방법을 알린다"
        );
        assert!(
            !skipped_roots_message(&plain, Some(home)).contains("전체 디스크 접근"),
            "권한과 무관한 경로에 권한 안내를 붙이면 원인을 잘못 짚게 한다"
        );
        assert!(
            !skipped_roots_message(&gated, None).contains("전체 디스크 접근"),
            "홈을 모르면 통제 폴더인지 판정할 수 없다"
        );
        assert!(
            !sits_in_permission_gated_folder(Path::new("/Users/other/Documents/work"), home),
            "다른 홈 아래 경로는 이 홈 기준으로 판정하지 않는다"
        );
    }

    fn agent_named(name: &str) -> AgentDefinition {
        AgentDefinition {
            name: name.to_owned(),
            description: String::new(),
            tools: Vec::new(),
            model: None,
            max_turns: None,
            permission_mode: None,
            skills: Vec::new(),
            path: format!("/tmp/{name}.md"),
        }
    }

    /// 감시자는 스킬 전용이 아니다. 에이전트·아티팩트 스캔이 멈춰도 같은 방식으로
    /// 마지막 결과를 유지하고 다음 회차를 계속 돌린다.
    #[test]
    fn a_blocked_agent_scan_keeps_the_previous_list() {
        let guard = ScanGuard::<Vec<AgentDefinition>>::default();
        let first = guarded_scan(
            &guard,
            ScanKind::Agents,
            Duration::from_secs(5),
            Duration::from_secs(60),
            || vec![agent_named("ready")],
        );
        assert_eq!(first, vec![agent_named("ready")]);

        let (release, blocked) = mpsc::channel::<()>();
        let served = guarded_scan(
            &guard,
            ScanKind::Agents,
            Duration::from_millis(20),
            Duration::from_secs(60),
            move || {
                let _ = blocked.recv();
                vec![agent_named("never")]
            },
        );
        assert_eq!(served, vec![agent_named("ready")]);
        drop(release);
    }

    /// 잠금을 잡은 채 오래 걸리는 작업이 있어도 뒤따르는 요청은 스레드를 물고 무한히
    /// 기다리지 않는다. 예전에는 이 대기가 쌓여 런타임 blocking 풀을 고갈시켰다.
    #[test]
    fn a_held_catalog_lock_reports_busy_instead_of_blocking_forever() {
        let lock = Mutex::new(());
        let held = lock.lock().expect("first lock");
        let error = lock_with_timeout(&lock, Duration::from_millis(40), "테스트")
            .expect_err("잠금을 잡을 수 없어야 한다");
        assert!(matches!(error, CoreError::Busy(_)), "{error}");
        drop(held);
        assert!(lock_with_timeout(&lock, Duration::from_millis(40), "테스트").is_ok());
    }

    /// 진행 중 조정이 내 요청까지 덮으면 새 스캔을 띄우지 않고 그 결과를 그대로 쓴다.
    #[test]
    fn requests_covered_by_an_active_reconcile_reuse_its_result() {
        let gate = Arc::new(ReconcileGate::default());
        let scans = Arc::new(AtomicUsize::new(0));
        let (entered, entered_signal) = mpsc::channel::<()>();
        let (release, blocked) = mpsc::channel::<()>();

        let runner = {
            let gate = Arc::clone(&gate);
            let scans = Arc::clone(&scans);
            thread::spawn(move || {
                gate.run(ReconcileScope::Full, || {
                    scans.fetch_add(1, AtomicOrdering::SeqCst);
                    let _ = entered.send(());
                    let _ = blocked.recv();
                    Ok(SessionCatalogUpdate {
                        revision: 7,
                        changed: true,
                    })
                })
            })
        };
        entered_signal
            .recv_timeout(Duration::from_secs(5))
            .expect("첫 조정이 시작되어야 한다");

        let (ready, ready_signal) = mpsc::channel::<()>();
        let joiners = (0..4)
            .map(|_| {
                let gate = Arc::clone(&gate);
                let scans = Arc::clone(&scans);
                let ready = ready.clone();
                thread::spawn(move || {
                    let _ = ready.send(());
                    gate.run(ReconcileScope::Full, || {
                        scans.fetch_add(1, AtomicOrdering::SeqCst);
                        Ok(SessionCatalogUpdate {
                            revision: 99,
                            changed: true,
                        })
                    })
                })
            })
            .collect::<Vec<_>>();
        for _ in 0..4 {
            ready_signal
                .recv_timeout(Duration::from_secs(5))
                .expect("대기자가 관문에 도달해야 한다");
        }
        // 대기자들이 조건변수에 들어갈 시간을 준 뒤 진행 중 조정을 끝낸다.
        thread::sleep(Duration::from_millis(100));
        drop(release);

        let first = runner.join().expect("runner").expect("첫 조정 결과");
        assert_eq!(first.revision, 7);
        for joiner in joiners {
            let update = joiner.join().expect("joiner").expect("합쳐진 결과");
            assert_eq!(update.revision, 7, "대기자는 진행 중 조정의 결과를 받는다");
        }
        assert_eq!(
            scans.load(AtomicOrdering::SeqCst),
            1,
            "요청이 4건 더 와도 스캔은 한 번만 돈다"
        );
    }

    /// 다른 세션만 다시 읽는 요청은 진행 중 요청이 덮어 주지 않으므로 자리가 빈 뒤
    /// 자기 스캔을 돌린다. 합쳐 버리면 그 세션이 목록에 들어오지 않는다.
    #[test]
    fn a_request_the_active_reconcile_does_not_cover_runs_on_its_own() {
        let gate = Arc::new(ReconcileGate::default());
        let scans = Arc::new(AtomicUsize::new(0));
        let (entered, entered_signal) = mpsc::channel::<()>();
        let (release, blocked) = mpsc::channel::<()>();

        let runner = {
            let gate = Arc::clone(&gate);
            let scans = Arc::clone(&scans);
            thread::spawn(move || {
                gate.run(
                    ReconcileScope::Target(ProviderId::Claude, "first".to_owned()),
                    || {
                        scans.fetch_add(1, AtomicOrdering::SeqCst);
                        let _ = entered.send(());
                        let _ = blocked.recv();
                        Ok(SessionCatalogUpdate {
                            revision: 1,
                            changed: false,
                        })
                    },
                )
            })
        };
        entered_signal
            .recv_timeout(Duration::from_secs(5))
            .expect("첫 조정이 시작되어야 한다");

        let other = {
            let gate = Arc::clone(&gate);
            let scans = Arc::clone(&scans);
            thread::spawn(move || {
                gate.run(
                    ReconcileScope::Target(ProviderId::Claude, "second".to_owned()),
                    || {
                        scans.fetch_add(1, AtomicOrdering::SeqCst);
                        Ok(SessionCatalogUpdate {
                            revision: 2,
                            changed: true,
                        })
                    },
                )
            })
        };
        thread::sleep(Duration::from_millis(100));
        drop(release);

        assert_eq!(runner.join().expect("runner").expect("first").revision, 1);
        assert_eq!(other.join().expect("other").expect("second").revision, 2);
        assert_eq!(scans.load(AtomicOrdering::SeqCst), 2);
    }

    #[test]
    fn a_blocked_skill_scan_gives_up_and_keeps_the_previous_list() {
        let guard = SkillScanGuard::default();
        let first = guarded_skill_scan(
            &guard,
            Duration::from_secs(5),
            Duration::from_secs(60),
            || vec![skill_named("ready")],
        );
        assert_eq!(first.len(), 1);

        // 응답하지 않는 파일시스템 대신, 돌아오지 않는 스캔으로 같은 상황을 만든다.
        let (release, blocked) = mpsc::channel::<()>();
        let served = guarded_skill_scan(
            &guard,
            Duration::from_millis(20),
            Duration::from_secs(60),
            move || {
                let _ = blocked.recv();
                vec![skill_named("never")]
            },
        );
        assert_eq!(
            served,
            vec![skill_named("ready")],
            "스캔이 멈추면 마지막으로 성공한 목록을 유지한다"
        );
        drop(release);
    }

    #[test]
    fn a_blocked_skill_scan_is_not_retried_until_the_cooldown_expires() {
        let guard = SkillScanGuard::default();
        let (release, blocked) = mpsc::channel::<()>();
        guarded_skill_scan(
            &guard,
            Duration::from_millis(20),
            Duration::from_millis(80),
            move || {
                let _ = blocked.recv();
                Vec::new()
            },
        );

        let attempted = Arc::new(Mutex::new(false));
        let flag = Arc::clone(&attempted);
        let during_cooldown = guarded_skill_scan(
            &guard,
            Duration::from_secs(5),
            Duration::from_millis(80),
            move || {
                *flag.lock().expect("스캔 시도 표시") = true;
                vec![skill_named("during")]
            },
        );
        assert!(during_cooldown.is_empty());
        assert!(
            !*attempted.lock().expect("스캔 시도 표시"),
            "쿨다운 동안에는 멈춘 경로에 스캔을 다시 붙이지 않는다"
        );

        thread::sleep(Duration::from_millis(120));
        let after_cooldown = guarded_skill_scan(
            &guard,
            Duration::from_secs(5),
            Duration::from_millis(80),
            || vec![skill_named("recovered")],
        );
        assert_eq!(
            after_cooldown,
            vec![skill_named("recovered")],
            "쿨다운이 지나면 다시 스캔해 복구된 목록을 반영한다"
        );
        drop(release);
    }

    #[test]
    fn manager_snapshot_marks_aia_workspace_sessions() {
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

        let projects = registered_project_paths(&data, &persisted).expect("registered projects");
        let resources = SnapshotResources::scan(&home, &data, &projects, 1).expect("resource scan");
        let snapshot = compose_manager_snapshot(&home, &data, &persisted, resources)
            .expect("manager snapshot");
        assert_eq!(snapshot.sessions.len(), 2);
        let aia = snapshot
            .sessions
            .iter()
            .find(|session| session.id == "aia-session")
            .expect("AIA 작업공간 세션도 목록에 남는다");
        assert!(aia.aia_workspace);
        assert_eq!(aia.project.as_deref(), Some(AIA_WORKSPACE_PROJECT));
        let project = snapshot
            .sessions
            .iter()
            .find(|session| session.id == "project-session")
            .expect("프로젝트 세션");
        assert!(!project.aia_workspace);
        assert_eq!(project.project.as_deref(), Some("project"));
    }

    fn persist_test_catalog(data: &Path, persisted: &PersistedSessionCatalog) {
        fs::create_dir_all(data).expect("data directory");
        persist_session_catalog(&data.join(SESSION_CATALOG_FILE_NAME), persisted)
            .expect("persisted catalog");
    }

    #[test]
    fn excluded_project_sessions_leave_snapshot_and_registered_paths() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        let alpha = root.path().join("alpha");
        let beta = root.path().join("beta");
        for directory in [&home, &data, &alpha, &beta] {
            fs::create_dir_all(directory).expect("directory");
        }
        let persisted = PersistedSessionCatalog {
            codex_sessions: vec![
                session_with_cwd("alpha-session", alpha.clone()),
                session_with_cwd("beta-session", beta.clone()),
            ],
            ..PersistedSessionCatalog::default()
        };
        store::set_project_active(&data, &beta.to_string_lossy(), false).expect("exclude beta");

        let projects = registered_project_paths(&data, &persisted).expect("registered projects");
        assert_eq!(
            projects,
            vec![fs::canonicalize(&alpha).expect("canonical alpha")]
        );

        let resources = SnapshotResources::scan(&home, &data, &projects, 1).expect("resource scan");
        let snapshot = compose_manager_snapshot(&home, &data, &persisted, resources)
            .expect("manager snapshot");
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].id, "alpha-session");
        assert!(snapshot
            .dashboard
            .top_projects
            .iter()
            .all(|project| project.name != "beta"));
        assert!(snapshot.pending_projects.is_empty());
    }

    #[test]
    fn open_seeds_known_projects_once_and_new_projects_wait_for_a_decision() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path().join("home");
        let data = root.path().join("data");
        let alpha = root.path().join("alpha");
        let beta = root.path().join("beta");
        for directory in [&home, &data, &alpha, &beta] {
            fs::create_dir_all(directory).expect("directory");
        }
        let alpha_canonical = fs::canonicalize(&alpha).expect("canonical alpha");
        let beta_canonical = fs::canonicalize(&beta).expect("canonical beta");

        // 첫 기동: 이미 있던 alpha는 시드로 결정된 것으로 본다.
        let mut persisted = PersistedSessionCatalog {
            schema_version: SESSION_CATALOG_SCHEMA_VERSION,
            revision: 1,
            codex_sessions: vec![session_with_cwd("alpha-session", alpha.clone())],
            ..PersistedSessionCatalog::default()
        };
        persist_test_catalog(&data, &persisted);
        let catalog =
            SessionCatalog::open_with_home(data.clone(), home.clone()).expect("session catalog");
        let known = store::load_metadata(&data)
            .expect("metadata")
            .known_projects
            .expect("seeded known projects");
        assert_eq!(known, vec![alpha_canonical.to_string_lossy().into_owned()]);
        assert!(catalog
            .manager_snapshot()
            .expect("snapshot")
            .pending_projects
            .is_empty());

        // 다음 기동에 beta가 새로 나타나면 활성으로 보이되 결정 대기로 뜬다.
        persisted.revision = 2;
        persisted
            .codex_sessions
            .push(session_with_cwd("beta-session", beta.clone()));
        persist_test_catalog(&data, &persisted);
        let catalog =
            SessionCatalog::open_with_home(data.clone(), home.clone()).expect("session catalog");
        let snapshot = catalog.manager_snapshot().expect("snapshot");
        assert_eq!(snapshot.sessions.len(), 2);
        assert_eq!(snapshot.pending_projects.len(), 1);
        assert_eq!(
            snapshot.pending_projects[0].path,
            beta_canonical.to_string_lossy()
        );
        assert!(snapshot.pending_projects[0].active);

        // 제외로 결정하면 세션이 빠지고 결정 대기도 끝난다. 레지스트리에는 비활성으로 남는다.
        store::set_project_active(&data, &beta.to_string_lossy(), false).expect("exclude beta");
        let update = catalog.refresh_metadata().expect("metadata refresh");
        assert!(update.changed);
        let snapshot = catalog.manager_snapshot().expect("snapshot");
        assert_eq!(snapshot.sessions.len(), 1);
        assert!(snapshot.pending_projects.is_empty());
        let registry = catalog.project_registry().expect("registry");
        assert_eq!(registry.len(), 2);
        let beta_entry = registry
            .iter()
            .find(|entry| entry.path == beta_canonical.to_string_lossy())
            .expect("beta entry");
        assert!(!beta_entry.active);
        assert!(!beta_entry.pending);
        assert_eq!(beta_entry.session_count, 1);

        // 다시 켜면 세션이 돌아오고 결정은 유지된다.
        store::set_project_active(&data, &beta.to_string_lossy(), true).expect("reactivate beta");
        assert!(
            catalog
                .refresh_metadata()
                .expect("metadata refresh")
                .changed
        );
        let snapshot = catalog.manager_snapshot().expect("snapshot");
        assert_eq!(snapshot.sessions.len(), 2);
        assert!(snapshot.pending_projects.is_empty());
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
        assert_eq!(
            automatic_context_label("<task-notification>\n<task-id>abc</task-id>"),
            Some("백그라운드 작업 알림")
        );
        assert_eq!(
            automatic_context_label(
                "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>…</task-notification>"
            ),
            Some("백그라운드 작업 알림")
        );
        assert_eq!(
            automatic_context_label("<system-reminder>메모리 컨텍스트</system-reminder>"),
            Some("시스템 알림")
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
    fn claude_meta_skill_injection_is_logged_as_named_context() {
        let injection = json!({
            "type": "user",
            "isMeta": true,
            "message": {
                "content": [{
                    "type": "text",
                    "text": "Base directory for this skill: /workspace/.claude/skills/kbfps-hrm\n\n# KBFPS HRM"
                }]
            },
        });
        let item = claude_transcript_item(&injection, 0, 0).expect("skill context item");
        assert_eq!(item.role, "meta");
        assert_eq!(item.type_label.as_deref(), Some("사용 스킬 · kbfps-hrm"));
        assert!(matches!(
            item.blocks.as_slice(),
            [ContentBlock::Context { label, text }]
                if label == "사용 스킬 · kbfps-hrm"
                    && text.starts_with("Base directory for this skill:")
        ));

        let literal_user_request = json!({
            "type": "user",
            "message": {"content": "Base directory for this skill: 설명해줘"},
        });
        let item =
            claude_transcript_item(&literal_user_request, 1, 0).expect("literal user request");
        assert_eq!(item.role, "user");
        assert!(matches!(
            item.blocks.as_slice(),
            [ContentBlock::Text { .. }]
        ));
    }

    #[test]
    fn claude_meta_injections_never_become_user_requests() {
        // CLI가 이미지 첨부 옆에 남기는 크기 안내. 진짜 요청과 같은 타임스탬프로 들어와
        // 요청 말풍선으로 새면 화면에서 요청과 응답 사이를 갈라놓는다.
        let cases = [
            (
                json!({
                    "type": "user",
                    "isMeta": true,
                    "turnCompanion": true,
                    "message": {"content": [{
                        "type": "text",
                        "text": "[Image: original 1440x2927, displayed at 984x2000. Multiply coordinates by 1.46 to map to original image.]"
                    }]},
                }),
                "이미지 크기 안내",
            ),
            (
                json!({
                    "type": "user",
                    "isMeta": true,
                    "message": {"content": "Continue from where you left off."},
                }),
                "이어서 진행 지시",
            ),
            (
                json!({
                    "type": "user",
                    "isMeta": true,
                    "message": {"content": "<local-command-caveat>Caveat: The messages below…"},
                }),
                "로컬 명령 안내",
            ),
            (
                json!({
                    "type": "user",
                    "isMeta": true,
                    "message": {"content": "처음 보는 주입문"},
                }),
                "CLI 자동 주입",
            ),
        ];
        for (record, label) in cases {
            let item = claude_transcript_item(&record, 0, 0).expect("meta item");
            assert_eq!(item.role, "meta", "{label}");
            assert_eq!(item.type_label.as_deref(), Some(label));
            assert!(
                matches!(item.blocks.as_slice(), [ContentBlock::Context { label: found, .. }] if found == label),
                "{label} 블록이 컨텍스트가 아니다"
            );
        }
    }

    #[test]
    fn claude_slash_commands_are_shown_as_the_typed_line() {
        let record = json!({
            "type": "user",
            "message": {"content": [{
                "type": "text",
                "text": "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args>codex</command-args>"
            }]},
        });
        let item = claude_transcript_item(&record, 0, 0).expect("slash command item");
        assert_eq!(item.role, "user");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Text { text }] if text == "/mcp codex"),
            "{:?}",
            item.blocks
        );

        let without_args = json!({
            "type": "user",
            "message": {"content": "<command-name>/clear</command-name>\n<command-args></command-args>"},
        });
        let item = claude_transcript_item(&without_args, 1, 0).expect("slash command item");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Text { text }] if text == "/clear"),
            "{:?}",
            item.blocks
        );

        // 태그를 흉내 낸 본문은 명령이 아니므로 원문 그대로 둔다.
        let literal = json!({
            "type": "user",
            "message": {"content": "이 로그에 <command-name>이 왜 있죠?"},
        });
        let item = claude_transcript_item(&literal, 2, 0).expect("literal item");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Text { text }] if text.starts_with("이 로그에")),
            "{:?}",
            item.blocks
        );
    }

    #[test]
    fn claude_local_command_stdout_is_labeled_output_not_a_request() {
        // 슬래시 명령의 출력은 isMeta 표시 없이 `type:"user"`로 남는다. 사용자 말풍선으로
        // 두면 원문 태그가 요청처럼 보이고, 세션 읽기에서도 userRequest로 분류된다.
        let record = json!({
            "type": "user",
            "message": {"content": "<local-command-stdout>✓ Installed superpowers. Plugin is now active.</local-command-stdout>"},
        });
        let item = claude_transcript_item(&record, 0, 0).expect("stdout item");
        assert_eq!(item.role, "meta");
        assert_eq!(item.type_label.as_deref(), Some("로컬 명령 출력"));
        assert!(
            matches!(
                item.blocks.as_slice(),
                [ContentBlock::Context { label, text }]
                    if label == "로컬 명령 출력"
                        && text == "✓ Installed superpowers. Plugin is now active."
            ),
            "{:?}",
            item.blocks
        );

        // 태그를 흉내 낸 본문은 출력이 아니므로 사용자 요청 그대로 둔다.
        let literal = json!({
            "type": "user",
            "message": {"content": "이 로그에 <local-command-stdout>이 왜 있죠?"},
        });
        let item = claude_transcript_item(&literal, 1, 0).expect("literal item");
        assert_eq!(item.role, "user");
        assert!(matches!(
            item.blocks.as_slice(),
            [ContentBlock::Text { .. }]
        ));
    }

    #[test]
    fn claude_thinking_blocks_without_text_are_dropped() {
        // sdk-cli 세션은 추론 원문 대신 서명만 남긴다. 빈 카드로 보여 줄 것이 없다.
        let signature_only = json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus-5",
                "content": [{"type": "thinking", "thinking": "", "signature": "CAIS…"}],
            },
        });
        assert!(claude_transcript_item(&signature_only, 0, 0).is_none());

        let recorded = json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus-5",
                "content": [{"type": "thinking", "thinking": "확인해 보자"}],
            },
        });
        let item = claude_transcript_item(&recorded, 1, 0).expect("thinking item");
        assert!(matches!(
            item.blocks.as_slice(),
            [ContentBlock::Thinking { text }] if text == "확인해 보자"
        ));
    }

    #[test]
    fn codex_pasted_file_envelope_folds_the_files_and_keeps_the_request_as_the_body() {
        let record = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "\n# Files pasted by the user:\n\n## \"00:00:00 --> 00:00:02 Example: sample text\": /Users/example/.codex/attachments/example/pasted-text.txt\n\n## My request:\n회의록 정리해서 등록해줘\n"}],
            },
        });
        let item = codex_transcript_item(&record, 0, false, 0).expect("pasted file item");
        assert_eq!(item.role, "user");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Context { label, text }, ContentBlock::Text { text: body }]
                if label == "붙여넣은 파일"
                    && text.contains("pasted-text.txt")
                    && text.contains("Example")
                    && !text.contains("Files pasted")
                    && body == "회의록 정리해서 등록해줘"),
            "{:?}",
            item.blocks
        );
    }

    #[test]
    fn codex_pasted_file_envelope_without_a_request_stays_untouched() {
        let record = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "# Files pasted by the user:\n\n## \"note\": /tmp/note.txt\n\n## My request:\n"}],
            },
        });
        let item = codex_transcript_item(&record, 0, false, 0).expect("envelope item");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Text { text }] if text.starts_with("# Files pasted by the user:")),
            "{:?}",
            item.blocks
        );

        // 봉투를 흉내 낸 평범한 요청은 그대로 본문으로 남는다.
        let plain = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "# Files pasted by the user: 이 문구가 왜 보이지?"}],
            },
        });
        let item = codex_transcript_item(&plain, 1, false, 0).expect("plain item");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Text { text }] if text.contains("왜 보이지")),
            "{:?}",
            item.blocks
        );
    }

    #[test]
    fn claude_api_errors_and_compaction_survive_the_empty_content_field() {
        let api_error = json!({
            "type": "system",
            "subtype": "api_error",
            "error": {"formatted": "401 OAuth access token has been revoked.", "status": 401},
            "retryAttempt": 1,
            "maxRetries": 10,
        });
        let item = claude_transcript_item(&api_error, 0, 0).expect("api error item");
        assert_eq!(item.role, "system");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Context { label, text }]
                if label == "API 오류"
                    && text.contains("OAuth access token has been revoked.")
                    && text.contains("재시도 1/10")),
            "{:?}",
            item.blocks
        );

        let compaction = json!({
            "type": "system",
            "subtype": "compact_boundary",
            "content": "Conversation compacted",
            "compactMetadata": {"trigger": "auto", "preTokens": 998_480},
        });
        let item = claude_transcript_item(&compaction, 1, 0).expect("compaction item");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Context { label, text }]
                if label == "대화 압축" && text.contains("트리거 auto") && text.contains("998480")),
            "{:?}",
            item.blocks
        );

        let local_command = json!({
            "type": "system",
            "subtype": "local_command",
            "content": "<local-command-stdout>\"codex\" isn't a recognized /mcp action.</local-command-stdout>",
        });
        let item = claude_transcript_item(&local_command, 2, 0).expect("local command item");
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::Context { label, text }]
                if label == "로컬 명령 출력" && text == "\"codex\" isn't a recognized /mcp action."),
            "{:?}",
            item.blocks
        );

        // 훅 요약과 턴 소요 시간은 읽을 내용이 없으므로 그대로 버린다.
        for noise in [
            json!({"type": "system", "subtype": "stop_hook_summary", "hookCount": 1}),
            json!({"type": "system", "subtype": "turn_duration", "durationMs": 304_820}),
        ] {
            assert!(claude_transcript_item(&noise, 2, 0).is_none());
        }
    }

    #[test]
    fn claude_api_error_reply_becomes_a_runtime_failure() {
        // CLI가 답 자리에 남기는 실패 안내는 합성 응답이라 일반 말풍선이면 진짜 답처럼 읽힌다.
        let failed_reply = json!({
            "type": "assistant",
            "timestamp": "2026-08-07T00:02:00Z",
            "isApiErrorMessage": true,
            "message": {
                "model": "<synthetic>",
                "content": [{"type": "text", "text": "Claude usage limit reached|1788230000"}],
                "usage": {"input_tokens": 3, "output_tokens": 12},
            },
        });
        let item = claude_transcript_item(&failed_reply, 0, 0).expect("failed reply item");
        assert_eq!(item.role, RUNTIME_FAILURE_ROLE);
        // 실패 안내의 토큰 수는 응답 사용량이 아니다.
        assert!(item.usage.is_none());
        assert!(
            matches!(item.blocks.as_slice(), [ContentBlock::RuntimeFailure { status, code, text }]
                if status == "failed" && code == "apiError" && text.contains("usage limit")),
            "{:?}",
            item.blocks
        );
    }

    #[test]
    fn runtime_failures_merge_into_the_transcript_once() {
        let item = |index: usize, role: &str, timestamp: i64| TranscriptItem {
            index,
            role: role.to_owned(),
            timestamp: Some(timestamp),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::Text {
                text: "본문".to_owned(),
            }],
            usage: None,
        };
        let failure = |occurred_at: i64, code: &str| SessionRuntimeFailure {
            id: format!("failure-{occurred_at}"),
            turn_id: "turn-1".to_owned(),
            status: "failed".to_owned(),
            code: code.to_owned(),
            message: "실행 파일을 찾을 수 없습니다".to_owned(),
            occurred_at,
        };
        let mut transcript = vec![item(0, "user", 1_000), item(1, INTERRUPTED_ROLE, 50_000)];
        merge_runtime_failures(
            &mut transcript,
            vec![failure(52_000, "twin"), failure(120_000, "spawnFailed")],
        );
        // 원문의 중단 표식과 같은 시각(허용 오차 안)의 실패는 이미 남은 기록으로 보고 끼우지 않는다.
        assert_eq!(transcript.len(), 3);
        let added = transcript.last().expect("appended failure");
        assert_eq!(added.role, RUNTIME_FAILURE_ROLE);
        // '이전 구간 더 보기' 커서가 최소 순번을 쓰므로 새 항목의 순번은 기존 최대 뒤에 온다.
        assert_eq!(added.index, 2);
        assert!(
            matches!(added.blocks.as_slice(), [ContentBlock::RuntimeFailure { code, .. }] if code == "spawnFailed"),
            "{:?}",
            added.blocks
        );
    }

    #[test]
    fn each_window_takes_only_the_failures_that_happened_inside_it() {
        // 실패를 늘 최신 구간에 몰아넣으면 이전 구간을 불러왔을 때 순서가 어긋난다.
        let item = |index: usize, timestamp: i64| TranscriptItem {
            index,
            role: "assistant".to_owned(),
            timestamp: Some(timestamp),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::Text {
                text: "본문".to_owned(),
            }],
            usage: None,
        };
        let failure = |occurred_at: i64| SessionRuntimeFailure {
            id: format!("failure-{occurred_at}"),
            turn_id: format!("turn-{occurred_at}"),
            status: "failed".to_owned(),
            code: "responseTimeout".to_owned(),
            message: "응답을 시작하지 않았습니다".to_owned(),
            occurred_at,
        };
        let all = || vec![failure(100), failure(2_500), failure(7_000)];
        let codes = |failures: Vec<SessionRuntimeFailure>| {
            failures
                .into_iter()
                .map(|failure| failure.occurred_at)
                .collect::<Vec<_>>()
        };

        // 최신 구간은 자기 첫 항목부터 맡는다. 그보다 오래된 실패는 이전 구간 몫이다.
        let latest = vec![item(300, 5_000), item(400, 9_000)];
        assert_eq!(
            codes(failures_within(all(), &latest, true, None)),
            vec![7_000]
        );

        // 이전 구간은 자기 첫 항목부터 최신 구간이 시작하는 시각 앞까지 맡는다.
        let earlier = vec![item(100, 2_000), item(200, 3_000)];
        assert_eq!(
            codes(failures_within(all(), &earlier, true, Some(5_000))),
            vec![2_500]
        );

        // 앞에 더 읽을 기록이 없는 구간은 대화의 시작이라 더 오래된 실패까지 맡는다.
        assert_eq!(
            codes(failures_within(all(), &earlier, false, Some(5_000))),
            vec![100, 2_500]
        );

        // 파일을 통째로 보여 주는 구간은 모든 실패를 맡는다.
        assert_eq!(
            codes(failures_within(all(), &latest, false, None)),
            vec![100, 2_500, 7_000]
        );
    }

    #[test]
    fn runtime_failures_sit_at_the_time_they_happened() {
        // 실패를 목록 끝에 몰아 두면 어느 요청에서 끊겼는지 알 수 없다. 대화 사이에 들어가야 한다.
        let item = |index: usize, role: &str, timestamp: i64| TranscriptItem {
            index,
            role: role.to_owned(),
            timestamp: Some(timestamp),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::Text {
                text: "본문".to_owned(),
            }],
            usage: None,
        };
        let failure = |occurred_at: i64, code: &str| SessionRuntimeFailure {
            id: format!("failure-{occurred_at}"),
            turn_id: format!("turn-{occurred_at}"),
            status: "failed".to_owned(),
            code: code.to_owned(),
            message: "응답을 시작하지 않았습니다".to_owned(),
            occurred_at,
        };
        let mut transcript = vec![
            item(0, "user", 1_000),
            item(1, "assistant", 2_000),
            item(2, "user", 5_000),
        ];
        merge_runtime_failures(
            &mut transcript,
            // 표시 범위보다 오래된 실패, 두 요청 사이의 실패, 마지막 항목 뒤의 실패.
            vec![
                failure(500, "older"),
                failure(3_000, "between"),
                failure(9_000, "newest"),
            ],
        );
        let order = transcript
            .iter()
            .map(|item| item.timestamp.unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(order, vec![500, 1_000, 2_000, 3_000, 5_000, 9_000]);
        assert_eq!(transcript[0].role, RUNTIME_FAILURE_ROLE);
        assert_eq!(transcript[3].role, RUNTIME_FAILURE_ROLE);
        assert_eq!(transcript[5].role, RUNTIME_FAILURE_ROLE);
        // 순번이 겹치면 화면이 같은 항목으로 본다.
        let mut indexes = transcript.iter().map(|item| item.index).collect::<Vec<_>>();
        indexes.sort_unstable();
        indexes.dedup();
        assert_eq!(indexes.len(), transcript.len());
    }

    #[test]
    fn claude_transcript_images_are_read_back_from_the_recorded_line() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("session.jsonl");
        let png = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"\x89PNG\r\n\x1a\n screenshot bytes",
        );
        write_json_lines(
            &path,
            &[
                json!({
                    "type": "user",
                    "timestamp": "2026-08-07T00:00:00Z",
                    "message": {"content": "앞선 메시지"},
                }),
                json!({
                    "type": "user",
                    "timestamp": "2026-08-07T00:01:00Z",
                    "message": {"content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": png}},
                        {"type": "text", "text": "이 화면 확인해줘"},
                    ]},
                }),
            ],
        );

        for parsed in [
            parse_claude_transcript(&path, None, None).expect("full transcript"),
            parse_claude_transcript(&path, Some(10), None).expect("latest transcript"),
        ] {
            let blocks = &parsed.items.last().expect("image item").blocks;
            let Some(ContentBlock::Image(image)) = blocks.first() else {
                panic!("첨부 이미지 블록이 없습니다: {blocks:?}");
            };
            assert_eq!(image.media_type, "image/png");
            assert_eq!(image.byte_size, 25);
            assert_eq!(image.source_pointer, "/message/content/0");
            assert!(
                matches!(blocks.get(1), Some(ContentBlock::Text { text }) if text == "이 화면 확인해줘")
            );

            let read = read_transcript_image(&path, image.source_offset, &image.source_pointer)
                .expect("image bytes");
            assert_eq!(read.media_type, "image/png");
            assert_eq!(read.bytes, b"\x89PNG\r\n\x1a\n screenshot bytes");
        }
    }

    #[test]
    fn codex_transcript_keeps_messages_that_only_carry_an_image() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("rollout.jsonl");
        let data =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"webp bytes");
        write_json_lines(
            &path,
            &[json!({
                "type": "response_item",
                "timestamp": "2026-08-07T00:00:00Z",
                "payload": {"type": "message", "role": "user", "content": [
                    {"type": "input_image", "image_url": format!("data:image/webp;base64,{data}")},
                    {"type": "input_image", "image_url": "data:text/html;base64,PHNjcmlwdD4="},
                ]},
            })],
        );

        let parsed = parse_codex_transcript(&path, None, None).expect("transcript");
        let item = parsed.items.first().expect("image item");
        assert_eq!(item.role, "user");
        assert_eq!(item.blocks.len(), 1, "이미지가 아닌 데이터 URL은 제외한다");
        let Some(ContentBlock::Image(image)) = item.blocks.first() else {
            panic!("첨부 이미지 블록이 없습니다: {:?}", item.blocks);
        };
        assert_eq!(image.media_type, "image/webp");
        assert_eq!(image.source_pointer, "/payload/content/0");
        let read = read_transcript_image(&path, image.source_offset, &image.source_pointer)
            .expect("image bytes");
        assert_eq!(read.bytes, b"webp bytes");
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
    fn claude_scan_keeps_the_last_api_error_until_the_next_request_or_reply() {
        // 한도·인증 만료 안내는 답 자리에 남는 합성 응답이다. 그 뒤로 아무 일도 없으면
        // 세션은 실패로 끝난 것이고, 새 요청이나 정상 응답이 오면 지난 일이 된다.
        let user = json!({
            "type": "user",
            "timestamp": "2026-09-05T00:00:00Z",
            "message": {"content": "다음 작업"},
        });
        let limit = json!({
            "type": "assistant",
            "timestamp": "2026-09-05T00:00:05Z",
            "isApiErrorMessage": true,
            "message": {
                "model": "<synthetic>",
                "content": [{"type": "text", "text": "You've hit your session limit · resets 2:40pm"}],
            },
        });
        let expired = json!({
            "type": "assistant",
            "timestamp": "2026-09-05T00:01:00Z",
            "isApiErrorMessage": true,
            "message": {
                "model": "<synthetic>",
                "content": [{"type": "text", "text": "Failed to authenticate: OAuth session expired"}],
            },
        });
        let reply = json!({
            "type": "assistant",
            "timestamp": "2026-09-05T00:02:00Z",
            "message": {"model": "claude-opus-5", "content": [{"type": "text", "text": "끝"}]},
        });

        let mut scan = ClaudeScanState::default();
        update_claude_scan(&mut scan, &user);
        update_claude_scan(&mut scan, &limit);
        let failure = scan.last_failure.clone().expect("limit failure");
        assert_eq!(failure.kind, SessionFailureKind::UsageLimit);
        assert_eq!(failure.occurred_at, parse_time("2026-09-05T00:00:05Z"));
        assert!(failure.message.contains("session limit"));

        update_claude_scan(&mut scan, &user);
        assert!(
            scan.last_failure.is_none(),
            "새 요청이 오면 지난 실패는 사라진다"
        );

        update_claude_scan(&mut scan, &expired);
        assert_eq!(
            scan.last_failure.as_ref().map(|failure| failure.kind),
            Some(SessionFailureKind::Error)
        );

        update_claude_scan(&mut scan, &reply);
        assert!(
            scan.last_failure.is_none(),
            "정상 응답이 오면 실패가 아니다"
        );

        // 사용자 중단 자리표시자는 실패가 아니고, 앞선 실패를 지우지도 않는다.
        update_claude_scan(&mut scan, &limit);
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "user",
                "message": {"content": "[Request interrupted by user]"},
            }),
        );
        assert!(scan.last_failure.is_some());
    }

    #[test]
    fn codex_rollout_tail_reports_only_task_complete_errors() {
        let root = tempfile::tempdir().expect("temporary home");
        let write = |name: &str, lines: &[&str]| {
            let path = root.path().join(name);
            fs::write(&path, format!("{}\n", lines.join("\n"))).expect("rollout");
            path
        };
        let started = r#"{"timestamp":"2026-08-26T02:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#;
        let tokens = r#"{"timestamp":"2026-08-26T02:14:36Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#;
        let limited = r#"{"timestamp":"2026-08-26T02:14:36.092Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":null,"error":{"message":"You've hit your usage limit. Try again at 3:54 PM.","codex_error_info":"usage_limit_exceeded"}}}"#;
        let overloaded = r#"{"timestamp":"2026-07-28T00:00:00Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","error":{"message":"Selected model is at capacity. Please try a different model.","codex_error_info":"server_overloaded"}}}"#;
        let completed = r#"{"timestamp":"2026-08-26T02:20:00Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t2","last_agent_message":"done"}}"#;
        let aborted = r#"{"timestamp":"2026-08-26T02:20:00Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t2","reason":"interrupted"}}"#;

        let failure =
            codex_rollout_last_failure(&write("limit.jsonl", &[started, limited, tokens]))
                .expect("usage limit failure");
        assert_eq!(failure.kind, SessionFailureKind::UsageLimit);
        assert_eq!(failure.occurred_at, parse_time("2026-08-26T02:14:36.092Z"));
        assert!(failure.message.starts_with("You've hit your usage limit"));

        let failure = codex_rollout_last_failure(&write("overload.jsonl", &[started, overloaded]))
            .expect("overload failure");
        assert_eq!(failure.kind, SessionFailureKind::Error);

        assert!(codex_rollout_last_failure(&write(
            "ok.jsonl",
            &[started, limited, started, completed]
        ))
        .is_none());
        assert!(codex_rollout_last_failure(&write(
            "aborted.jsonl",
            &[started, limited, started, aborted]
        ))
        .is_none());
        assert!(
            codex_rollout_last_failure(&write("running.jsonl", &[started, limited, started]))
                .is_none()
        );
        assert!(codex_rollout_last_failure(&write("empty.jsonl", &[])).is_none());
        assert!(codex_rollout_last_failure(&root.path().join("missing.jsonl")).is_none());
    }

    #[test]
    fn codex_listing_reuses_failure_judgements_for_unchanged_rollouts() {
        let root = tempfile::tempdir().expect("temporary home");
        let codex = root.path().join(".codex");
        fs::create_dir_all(&codex).expect("codex directory");
        let rollout = codex.join("limit.jsonl");
        fs::write(
            &rollout,
            concat!(
                r#"{"timestamp":"2026-08-26T02:14:36Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","error":{"message":"You've hit your usage limit. Try again at 3:54 PM."}}}"#,
                "\n"
            ),
        )
        .expect("rollout");
        let database = Connection::open(codex.join("state_5.sqlite")).expect("state database");
        database
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT);",
            )
            .expect("threads table");
        database
            .execute(
                "INSERT INTO threads (id, rollout_path, cwd) VALUES (?1, ?2, ?3)",
                rusqlite::params!["limited", rollout.to_string_lossy(), "/workspace"],
            )
            .expect("thread");
        drop(database);

        let fresh = list_codex_sessions(root.path(), &[]);
        assert_eq!(fresh.len(), 1);
        assert_eq!(
            fresh[0].last_failure.as_ref().map(|failure| failure.kind),
            Some(SessionFailureKind::UsageLimit)
        );

        // 크기가 같은 롤아웃은 지난 판정을 물려받는다(꼬리를 다시 읽지 않는다는 증거로 지난
        // 판정을 비워 두고 같은 값이 돌아오는지 본다).
        let mut previous = fresh.clone();
        previous[0].last_failure = None;
        let reused = list_codex_sessions(root.path(), &previous);
        assert!(reused[0].last_failure.is_none());

        // 크기가 바뀐 롤아웃은 다시 읽는다.
        let mut stale = fresh.clone();
        stale[0].size_bytes = Some(1);
        let rescanned = list_codex_sessions(root.path(), &stale);
        assert!(rescanned[0].last_failure.is_some());

        let single = find_codex_session(root.path(), "limited").expect("single lookup");
        assert!(single.last_failure.is_some());
    }

    #[test]
    fn runtime_failure_tag_applies_only_when_the_failure_is_the_last_event() {
        let failure = |status: &str, occurred_at: i64| SessionRuntimeFailure {
            id: "chat:turn".to_owned(),
            turn_id: "turn".to_owned(),
            status: status.to_owned(),
            code: "runtimeFailed".to_owned(),
            message: "You've hit your usage limit. Try again later.".to_owned(),
            occurred_at,
        };
        let mut session = session_with_cwd("s1", PathBuf::from("/workspace"));
        session.source = ProviderId::Claude;
        session.updated_at = Some(10_000);
        let key = session_key(ProviderId::Claude, "s1");

        // 실패가 마지막 기록보다 나중이면 실패로 끝난 세션이다.
        let mut tagged = session.clone();
        apply_runtime_failure_tag(
            &mut tagged,
            &HashMap::from([(key.clone(), failure("failed", 12_000))]),
        );
        let last = tagged.last_failure.expect("tagged");
        assert_eq!(last.kind, SessionFailureKind::UsageLimit);
        assert_eq!(last.occurred_at, Some(12_000));

        // 원문 기록 시각과 실패 시각이 몇 초 안에서 갈리는 정도는 같은 사건으로 본다.
        let mut close = session.clone();
        apply_runtime_failure_tag(
            &mut close,
            &HashMap::from([(
                key.clone(),
                failure("failed", 10_000 - RUNTIME_FAILURE_TWIN_TOLERANCE_MS),
            )]),
        );
        assert!(close.last_failure.is_some());

        // 실패 뒤에 원문이 더 자랐으면(새 요청·정상 응답) 지난 일이다.
        let mut outdated = session.clone();
        apply_runtime_failure_tag(
            &mut outdated,
            &HashMap::from([(key.clone(), failure("failed", 1_000))]),
        );
        assert!(outdated.last_failure.is_none());

        // 사용자 중단·백엔드 재기동은 실패가 아니다.
        let mut interrupted = session.clone();
        apply_runtime_failure_tag(
            &mut interrupted,
            &HashMap::from([(key.clone(), failure("interrupted", 12_000))]),
        );
        assert!(interrupted.last_failure.is_none());

        // 다른 세션의 실패는 상관없다.
        let mut other = session.clone();
        apply_runtime_failure_tag(
            &mut other,
            &HashMap::from([(
                session_key(ProviderId::Codex, "s1"),
                failure("failed", 12_000),
            )]),
        );
        assert!(other.last_failure.is_none());

        // 원문이 이미 실패를 남겼으면 그쪽을 둔다.
        let mut provider = session.clone();
        provider.last_failure = Some(SessionLastFailure::new("Login expired", Some(9_000)));
        apply_runtime_failure_tag(
            &mut provider,
            &HashMap::from([(key, failure("failed", 12_000))]),
        );
        assert_eq!(
            provider
                .last_failure
                .as_ref()
                .map(|failure| failure.occurred_at),
            Some(Some(9_000))
        );
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
        assert_eq!(tool_scan.message_count, 0);
    }

    #[test]
    fn claude_scan_skips_cli_injections_and_tool_results() {
        let mut scan = ClaudeScanState::default();
        // 첫 요청이 이미지 한 장뿐이면 읽을 텍스트가 없다. 뒤따르는 크기 안내를 세면
        // 세션 제목이 "[Image: original …]"이 되어 버린다.
        for record in [
            json!({
                "type": "user",
                "message": {"content": [{"type": "image", "source": {"type": "base64", "data": ""}}]},
            }),
            json!({
                "type": "user",
                "isMeta": true,
                "turnCompanion": true,
                "message": {"content": [{"type": "text", "text": "[Image: original 1440x2927, displayed at 984x2000."}]},
            }),
            json!({
                "type": "user",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "tool-1"}]},
            }),
        ] {
            update_claude_scan(&mut scan, &record);
        }
        assert_eq!(scan.first_user, None);
        assert_eq!(scan.message_count, 1);

        update_claude_scan(
            &mut scan,
            &json!({"type": "user", "message": {"content": "이 화면 분석해줘"}}),
        );
        assert_eq!(scan.first_user.as_deref(), Some("이 화면 분석해줘"));
        assert_eq!(scan.message_count, 2);
    }

    #[test]
    fn claude_scan_keeps_the_first_slash_command_as_a_title_fallback() {
        // CLI에서 슬래시 명령만 실행한 세션은 `<`로 시작하는 레코드뿐이라 제목 후보가
        // 없었다. 명령을 폴백으로 남기되, 출력 레코드는 메시지 수·제목에서 뺀다.
        let mut scan = ClaudeScanState::default();
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "user",
                "message": {"content": "<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>install superpowers@claude-plugins-official</command-args>"},
            }),
        );
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "user",
                "message": {"content": "<local-command-stdout>(no content)</local-command-stdout>"},
            }),
        );
        assert_eq!(scan.first_user, None);
        assert_eq!(
            scan.first_command.as_deref(),
            Some("/plugin install superpowers@claude-plugins-official")
        );
        assert_eq!(scan.message_count, 1);
    }

    #[test]
    fn claude_summary_title_prefers_user_text_over_the_command_fallback() {
        let entry = |first_user: Option<&str>, first_command: Option<&str>| ClaudeCatalogEntry {
            path: "/tmp/e13cb4a6.jsonl".to_owned(),
            fingerprint: FileFingerprint {
                size_bytes: 0,
                modified_at: None,
                prefix_bytes: 0,
                prefix_hash: 0,
                tail_bytes: 0,
                tail_hash: 0,
            },
            scan: ClaudeScanState {
                first_user: first_user.map(str::to_owned),
                first_command: first_command.map(str::to_owned),
                ..ClaudeScanState::default()
            },
        };
        let summary = claude_summary_from_entry(&entry(Some("실제 요청"), Some("/clear")));
        assert_eq!(summary.source_title.as_deref(), Some("실제 요청"));
        let summary = claude_summary_from_entry(&entry(None, Some("/clear")));
        assert_eq!(summary.source_title.as_deref(), Some("/clear"));
    }

    #[test]
    fn claude_interrupt_placeholders_are_not_user_requests() {
        let mut scan = ClaudeScanState::default();
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "user",
                "message": {"content": "[Request interrupted by user]"},
            }),
        );
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "user",
                "message": {"content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]},
            }),
        );
        update_claude_scan(
            &mut scan,
            &json!({
                "type": "assistant",
                "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "[Request interrupted by user]"}]},
            }),
        );
        assert_eq!(scan.message_count, 0);
        assert_eq!(scan.first_user, None);

        update_claude_scan(
            &mut scan,
            &json!({"type": "user", "message": {"content": "실제 요청"}}),
        );
        assert_eq!(scan.message_count, 1);
        assert_eq!(scan.first_user.as_deref(), Some("실제 요청"));
    }

    #[test]
    fn claude_interrupt_placeholders_get_the_interrupted_role() {
        let item = claude_transcript_item(
            &json!({
                "type": "user",
                "message": {"content": "[Request interrupted by user]"},
            }),
            0,
            0,
        )
        .expect("interrupt item");
        assert_eq!(item.role, INTERRUPTED_ROLE);
        assert_eq!(item.type_label.as_deref(), Some("사용자가 중단함"));

        let synthetic = claude_transcript_item(
            &json!({
                "type": "assistant",
                "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]},
            }),
            1,
            0,
        )
        .expect("synthetic interrupt item");
        assert_eq!(synthetic.role, INTERRUPTED_ROLE);
        assert_eq!(synthetic.type_label.as_deref(), Some("도구 실행 중 중단됨"));
        assert_eq!(synthetic.model, None);

        let request = claude_transcript_item(
            &json!({"type": "user", "message": {"content": "중단하지 않은 요청"}}),
            2,
            0,
        )
        .expect("user item");
        assert_eq!(request.role, "user");
        assert_eq!(request.type_label, None);
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
        let folder = store::create_session_folder(&data, "Important", "#2563eb", None)
            .expect("session folder");
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
                pinned_account_id: None,
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

    #[test]
    fn a_captured_turn_that_concatenates_several_messages_is_not_merged_again() {
        // 예전 판이 남긴 기록. 한 턴에서 나온 텍스트 메시지 셋을 구분자 없이 이어 담았다.
        let source_items = [
            "먼저 파일을 읽습니다:",
            "정리했습니다.\n\n## 결과",
            "끝입니다.",
        ]
        .into_iter()
        .enumerate()
        .map(|(position, text)| TranscriptItem {
            index: position,
            role: "assistant".to_owned(),
            timestamp: Some(10 + position as i64),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            usage: None,
        })
        .collect::<Vec<_>>();
        let turns = vec![
            store::CapturedTranscriptTurn {
                source: ProviderId::Claude,
                session_id: "session-1234567890".to_owned(),
                turn_id: "turn-1234567890abcd".to_owned(),
                completed_at: 20,
                text: "먼저 파일을 읽습니다:정리했습니다.\n\n## 결과끝입니다.".to_owned(),
                origin: store::SupplementOrigin::Chat,
            },
            store::CapturedTranscriptTurn {
                source: ProviderId::Claude,
                session_id: "session-1234567890".to_owned(),
                turn_id: "turn-abcdef1234567890".to_owned(),
                completed_at: 30,
                text: "원본에 없는 응답".to_owned(),
                origin: store::SupplementOrigin::Chat,
            },
        ];

        let merged = merge_captured_turns(source_items, turns, 3);
        assert_eq!(merged.len(), 4);
        assert_eq!(merged[3].type_label.as_deref(), Some("보완 저장 결과"));
        assert!(matches!(
            merged[3].blocks.as_slice(),
            [ContentBlock::Text { text }] if text == "원본에 없는 응답"
        ));
    }

    #[test]
    fn a_captured_turn_matches_the_source_across_line_break_differences() {
        let source_item = TranscriptItem {
            index: 0,
            role: "assistant".to_owned(),
            timestamp: Some(10),
            model: None,
            type_label: None,
            blocks: vec![ContentBlock::Text {
                text: "정리했습니다.\n\n- 첫째\n- 둘째".to_owned(),
            }],
            usage: None,
        };
        let turns = vec![store::CapturedTranscriptTurn {
            source: ProviderId::Claude,
            session_id: "session-1234567890".to_owned(),
            turn_id: "turn-1234567890abcd".to_owned(),
            completed_at: 20,
            text: "정리했습니다.\n- 첫째\n\n- 둘째\n".to_owned(),
            origin: store::SupplementOrigin::Chat,
        }];

        assert_eq!(merge_captured_turns(vec![source_item], turns, 1).len(), 1);
    }

    #[test]
    fn provider_record_order_survives_reversed_timestamps() {
        // CLI는 로컬 명령 안내(caveat)를 파일에 먼저 쓰면서 timestamp는 뒤따르는 명령보다
        // 1ms 늦게 찍는다. timestamp로 재정렬하면 안내가 자기가 설명하는 명령 뒤로 밀린다.
        let items = [(679, "meta"), (678, "user"), (678, "meta")]
            .into_iter()
            .enumerate()
            .map(|(position, (timestamp, role))| TranscriptItem {
                index: position,
                role: role.to_owned(),
                timestamp: Some(timestamp),
                model: None,
                type_label: None,
                blocks: vec![ContentBlock::Text {
                    text: format!("record {position}"),
                }],
                usage: None,
            })
            .collect::<Vec<_>>();

        let merged = merge_captured_turns(items, Vec::new(), 3);
        let order = merged.iter().map(|item| item.index).collect::<Vec<_>>();
        assert_eq!(order, vec![0, 1, 2]);
    }

    #[test]
    fn captured_turns_keep_their_chronological_position() {
        let items = [10, 20]
            .into_iter()
            .enumerate()
            .map(|(position, timestamp)| TranscriptItem {
                index: position,
                role: "assistant".to_owned(),
                timestamp: Some(timestamp),
                model: None,
                type_label: None,
                blocks: vec![ContentBlock::Text {
                    text: format!("record {position}"),
                }],
                usage: None,
            })
            .collect::<Vec<_>>();
        let turns = vec![store::CapturedTranscriptTurn {
            source: ProviderId::Claude,
            session_id: "session-1234567890".to_owned(),
            turn_id: "turn-1234567890abcd".to_owned(),
            completed_at: 15,
            text: "중간에 끼울 보완 기록".to_owned(),
            origin: store::SupplementOrigin::Chat,
        }];

        let merged = merge_captured_turns(items, turns, 2);
        let order = merged.iter().map(|item| item.index).collect::<Vec<_>>();
        assert_eq!(order, vec![0, 2, 1]);
    }

    #[test]
    fn installed_skills_are_marked_when_a_common_source_exists() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path();
        let common = home.join("resource-repository/skills/shared");
        fs::create_dir_all(&common).expect("common skill directory");
        fs::write(common.join("SKILL.md"), "---\nname: shared\n---\n").expect("common SKILL.md");
        for key in ["shared", "local"] {
            let directory = home.join(".claude/skills").join(key);
            fs::create_dir_all(&directory).expect("install directory");
            fs::write(
                directory.join("SKILL.md"),
                format!("---\nname: {key}\n---\n"),
            )
            .expect("install SKILL.md");
        }

        let skills = list_skills_from_home(home, home, &[]);
        let archived = |name: &str| {
            skills
                .iter()
                .find(|skill| skill.name == name)
                .map(|skill| skill.archived)
        };
        assert_eq!(archived("shared"), Some(true));
        assert_eq!(archived("local"), Some(false));
    }

    /// 스킬 요약 목록도 라이브러리와 같은 이유로 설치 레지스트리를 읽어야 한다.
    /// 외부 URL 소스 플러그인은 마켓플레이스 클론에 실체가 없다.
    #[test]
    fn plugin_skill_summaries_come_from_installed_plugin_registry() {
        let root = tempfile::tempdir().expect("temporary root");
        let home = root.path();
        let install_dir =
            home.join(".claude/plugins/cache/claude-plugins-official/superpowers/6.3.0");
        let skill_dir = install_dir.join("skills/tdd");
        fs::create_dir_all(&skill_dir).expect("plugin skill directory");
        fs::write(skill_dir.join("SKILL.md"), "---\nname: tdd\n---\n").expect("plugin SKILL.md");
        // 마켓플레이스 클론에만 있는(설치되지 않은) 플러그인.
        let clone_dir = home.join(
            ".claude/plugins/marketplaces/claude-plugins-official/plugins/vendored/skills/vend",
        );
        fs::create_dir_all(&clone_dir).expect("clone skill directory");
        fs::write(clone_dir.join("SKILL.md"), "---\nname: vend\n---\n").expect("clone SKILL.md");
        fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"version":2,"plugins":{{"superpowers@claude-plugins-official":[{{"scope":"user","installPath":{}}}]}}}}"#,
                serde_json::to_string(&install_dir.to_string_lossy()).expect("path json")
            ),
        )
        .expect("write registry");

        let skills = list_skills_from_home(home, home, &[]);
        let plugin: Vec<_> = skills
            .iter()
            .filter(|skill| skill.scope == "plugin")
            .collect();
        assert_eq!(
            plugin.len(),
            1,
            "설치 레지스트리의 installPath에서만 플러그인 스킬을 읽는다"
        );
        assert_eq!(plugin[0].name, "tdd");
        assert_eq!(plugin[0].origin.as_deref(), Some("superpowers"));
    }

    fn proto_varint_bytes(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                bytes.push(byte);
                return bytes;
            }
            bytes.push(byte | 0x80);
        }
    }

    fn proto_bytes_field(field: u64, payload: &[u8]) -> Vec<u8> {
        let mut bytes = proto_varint_bytes(field << 3 | 2);
        bytes.extend(proto_varint_bytes(payload.len() as u64));
        bytes.extend_from_slice(payload);
        bytes
    }

    fn write_antigravity_conversation(path: &Path, steps: &[(i64, Vec<u8>)]) {
        let connection = Connection::open(path).expect("conversation db");
        connection
            .execute_batch(
                "CREATE TABLE steps (idx integer primary key, step_type integer, step_payload blob)",
            )
            .expect("steps table");
        for (index, (step_type, payload)) in steps.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO steps (idx, step_type, step_payload) VALUES (?1, ?2, ?3)",
                    rusqlite::params![index as i64, step_type, payload],
                )
                .expect("step row");
        }
    }

    #[test]
    fn antigravity_title_prefers_generated_title_over_user_input() {
        let root = tempfile::tempdir().expect("temporary root");
        let path = root.path().join("conversation.db");
        let user_step = proto_bytes_field(
            30,
            &[
                proto_bytes_field(4, "Checking AI Presence".as_bytes()),
                proto_bytes_field(19, "살아있니".as_bytes()),
            ]
            .concat(),
        );
        write_antigravity_conversation(
            &path,
            &[
                (
                    14,
                    proto_bytes_field(19, &proto_bytes_field(2, "살아있니".as_bytes())),
                ),
                (23, user_step),
            ],
        );

        let scan = scan_antigravity_conversation(&path);
        assert_eq!(scan.title.as_deref(), Some("Checking AI Presence"));
        assert_eq!(scan.step_count, Some(2));
    }

    #[test]
    fn antigravity_title_falls_back_to_first_user_input() {
        let root = tempfile::tempdir().expect("temporary root");
        let path = root.path().join("conversation.db");
        write_antigravity_conversation(
            &path,
            &[
                (
                    14,
                    proto_bytes_field(19, &proto_bytes_field(2, "  살아있니\n?  ".as_bytes())),
                ),
                (8, proto_bytes_field(30, b"View index html file")),
            ],
        );

        assert_eq!(
            scan_antigravity_conversation(&path).title.as_deref(),
            Some("살아있니 ?")
        );
    }

    #[test]
    fn antigravity_title_ignores_unreadable_payloads() {
        let root = tempfile::tempdir().expect("temporary root");
        let path = root.path().join("conversation.db");
        write_antigravity_conversation(&path, &[(23, vec![0xff, 0xff, 0xff, 0x30, 0x0a])]);

        let scan = scan_antigravity_conversation(&path);
        assert_eq!(scan.title, None);
        assert_eq!(scan.step_count, Some(1));
    }

    #[test]
    fn antigravity_step_count_falls_back_to_the_steps_table() {
        let root = tempfile::tempdir().expect("temporary root");
        let path = root.path().join("conversation.db");
        write_antigravity_conversation(
            &path,
            &[
                (
                    14,
                    proto_bytes_field(19, &proto_bytes_field(2, "살아있니".as_bytes())),
                ),
                (15, Vec::new()),
                (8, Vec::new()),
            ],
        );
        let metadata = fs::metadata(&path).expect("conversation metadata");

        let session = antigravity_session_from_path(
            "conversation".to_owned(),
            path,
            metadata,
            AgIndexEntry::default(),
        );

        assert_eq!(session.message_count, Some(3));
        assert_eq!(session.source_title.as_deref(), Some("살아있니"));
    }
}
