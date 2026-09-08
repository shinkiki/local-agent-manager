use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app_data_file::{read_private_json_or_default, write_private_json};
use crate::chat::{ChatApprovalMode, ChatMode, ReasoningEffort};
use crate::domain::{
    wire_enum, ChatOrigin, DocRoot, DocRootStatus, ProviderId, SessionFolder, SessionLink,
    SessionMeta, SessionMetaPatch, SupplementStorageStats,
};
use crate::identifier::validate_identifier;
use crate::path_guard;
use crate::store_lock;
use crate::user_home;
use crate::CoreError;

const STORE_FILE_NAME: &str = "manager-state.json";
const STORE_LOCK_FILE_NAME: &str = "manager-state.lock";
const SUPPLEMENT_STORE_FILE_NAME: &str = "session-supplements-v2.json";
const SUPPLEMENT_LOCK_FILE_NAME: &str = "session-supplements-v2.lock";
const AGENT_DATA_DIR_NAMES: [&str; 3] = [".claude", ".codex", ".gemini"];
const MAX_SUPPLEMENT_TEXT_BYTES: usize = 256 * 1024;
const MAX_SUPPLEMENT_TURNS: usize = 4_000;
const MAX_SUPPLEMENT_TURNS_PER_SESSION: usize = 200;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppMetadata {
    #[serde(default)]
    pub sessions: HashMap<String, SessionMeta>,
    /// 공급자 색인에 작업 경로가 없는 세션을 프로젝트별로 다시 찾기 위한 장치 로컬
    /// 보완 정보. 공급자 기록은 수정하지 않고, 실행 시 확인한 정규 절대경로만 남긴다.
    #[serde(default)]
    pub session_working_directories: HashMap<String, String>,
    #[serde(default)]
    pub folders: Vec<SessionFolder>,
    #[serde(default)]
    pub doc_roots: Vec<DocRoot>,
    /// 설정에서 제외한 프로젝트의 정규 절대경로. 제외 목록만 저장하므로 새로 감지된
    /// 프로젝트는 아무 조치 없이 활성으로 시작한다.
    #[serde(default)]
    pub excluded_projects: Vec<String>,
    /// 활성 유지/제외 초기값이 결정된 프로젝트. `None`이면 아직 시드 전이라, 카탈로그를
    /// 처음 열 때 현재 프로젝트 전부를 채워 기존 사용자에게 알림이 쏟아지지 않게 한다.
    #[serde(default)]
    pub known_projects: Option<Vec<String>>,
}

impl AppMetadata {
    pub(crate) fn excluded_project_set(&self) -> BTreeSet<PathBuf> {
        self.excluded_projects.iter().map(PathBuf::from).collect()
    }

    /// 시드 전(`None`)이면 결정 대기 판정을 하지 않는다.
    pub(crate) fn known_project_set(&self) -> Option<BTreeSet<PathBuf>> {
        self.known_projects
            .as_ref()
            .map(|known| known.iter().map(PathBuf::from).collect())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SupplementOrigin {
    Chat,
    Scheduled,
}

impl SupplementOrigin {
    #[cfg(test)]
    pub const ALL: [Self; 2] = [Self::Chat, Self::Scheduled];
}

wire_enum!(trimmed SupplementOrigin, "알 수 없는 보완 저장 출처입니다", {
    Chat => "chat",
    Scheduled => "scheduled",
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturedTranscriptTurn {
    pub source: ProviderId,
    pub session_id: String,
    pub turn_id: String,
    pub completed_at: i64,
    pub text: String,
    pub origin: SupplementOrigin,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupplementStore {
    #[serde(default)]
    turns: Vec<CapturedTranscriptTurn>,
}

pub(crate) fn load_metadata(app_data_dir: &Path) -> Result<AppMetadata, CoreError> {
    read_private_json_or_default(&app_data_dir.join(STORE_FILE_NAME))
}

fn save_metadata(app_data_dir: &Path, metadata: &AppMetadata) -> Result<(), CoreError> {
    write_private_json(&app_data_dir.join(STORE_FILE_NAME), metadata)
}

/// 메타데이터 저장소를 잠금 아래에서 한 번 읽고, 고치고, 저장한다. `action`이 돌려주는
/// 첫 값이 `false`면 바뀐 것이 없다고 보고 저장을 건너뛴다.
///
/// 저장소를 고치는 함수마다 "잠금 → 적재 → 수정 → 저장"을 열네 벌 펼쳐 두었고, 그중
/// 몇은 무변경일 때 저장을 건너뛰었다. 잠금 이름이나 무변경 판정을 한 자리에서만 고칠
/// 수 있게 봉투를 한 벌로 모은다.
pub(crate) fn with_metadata_changed<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut AppMetadata) -> Result<(bool, T), CoreError>,
) -> Result<T, CoreError> {
    let _lock = store_lock::acquire(app_data_dir, STORE_LOCK_FILE_NAME, "메타데이터 저장소")?;
    let mut metadata = load_metadata(app_data_dir)?;
    let (changed, value) = action(&mut metadata)?;
    if changed {
        save_metadata(app_data_dir, &metadata)?;
    }
    Ok(value)
}

/// 무변경 갈래가 없어 언제나 저장하는 호출부가 쓰는 갈래.
pub(crate) fn with_metadata<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut AppMetadata) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    with_metadata_changed(app_data_dir, |metadata| Ok((true, action(metadata)?)))
}

/// 세션 메타·작업 경로·보완 저장소·채팅 런타임 저장소가 함께 쓰는 세션 키. 저장소 안의
/// 키 모양은 `공급자:세션ID` 하나뿐이므로 조립도 한 곳에서만 한다.
pub(crate) fn session_key(source: ProviderId, session_id: &str) -> String {
    format!("{}:{session_id}", source.as_str())
}

/// 세션 메타 한 건을 메타데이터 잠금 아래에서 갱신한다. `apply`가 `false`를 돌려주면
/// 바뀐 것이 없다고 보고 저장을 건너뛴다. 기록 계열 `persist_session_*` 함수들이
/// 저마다 펼쳐 두던 잠금·적재·키 조립·무변경 조기 반환 봉투를 한 벌로 모은 것이다.
fn update_session_entry(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    apply: impl FnOnce(&mut SessionMeta) -> bool,
) -> Result<(), CoreError> {
    validate_identifier(session_id)?;
    with_metadata_changed(app_data_dir, |metadata| {
        let entry = metadata
            .sessions
            .entry(session_key(source, session_id))
            .or_default();
        Ok((apply(entry), ()))
    })
}

pub(crate) fn captured_turns_for(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
) -> Result<Vec<CapturedTranscriptTurn>, CoreError> {
    let store = load_supplement_store(app_data_dir)?;
    let mut turns = store
        .turns
        .into_iter()
        .filter(|turn| turn.source == source && turn.session_id == session_id)
        .collect::<Vec<_>>();
    turns.sort_by_key(|turn| turn.completed_at);
    Ok(turns)
}

pub(crate) fn supplement_storage_stats(
    app_data_dir: &Path,
) -> Result<SupplementStorageStats, CoreError> {
    let store = load_supplement_store(app_data_dir)?;
    let session_count = store
        .turns
        .iter()
        .map(|turn| session_key(turn.source, &turn.session_id))
        .collect::<HashSet<_>>()
        .len();
    let size_bytes = fs::metadata(app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME))
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(SupplementStorageStats {
        turn_count: store.turns.len(),
        session_count,
        size_bytes,
    })
}

pub(crate) fn persist_captured_turn(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    turn_id: &str,
    completed_at: i64,
    text: String,
    origin: SupplementOrigin,
) -> Result<(), CoreError> {
    persist_captured_turn_inner(
        app_data_dir,
        captured_turn(source, session_id, turn_id, completed_at, text, origin)?,
        true,
    )
}

pub(crate) fn persist_captured_turn_if_absent(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    turn_id: &str,
    completed_at: i64,
    text: String,
    origin: SupplementOrigin,
) -> Result<(), CoreError> {
    persist_captured_turn_inner(
        app_data_dir,
        captured_turn(source, session_id, turn_id, completed_at, text, origin)?,
        false,
    )
}

fn captured_turn(
    source: ProviderId,
    session_id: &str,
    turn_id: &str,
    completed_at: i64,
    text: String,
    origin: SupplementOrigin,
) -> Result<CapturedTranscriptTurn, CoreError> {
    validate_identifier(session_id)?;
    validate_identifier(turn_id)?;
    Ok(CapturedTranscriptTurn {
        source,
        session_id: session_id.to_owned(),
        turn_id: turn_id.to_owned(),
        completed_at,
        text: cap_supplement_text(text),
        origin,
    })
}

fn persist_captured_turn_inner(
    app_data_dir: &Path,
    next: CapturedTranscriptTurn,
    replace_existing: bool,
) -> Result<(), CoreError> {
    if next.text.is_empty() {
        return Ok(());
    }
    with_supplement_store(app_data_dir, |store| {
        if let Some(existing) = store.turns.iter_mut().find(|turn| {
            turn.source == next.source
                && turn.session_id == next.session_id
                && turn.turn_id == next.turn_id
        }) {
            if replace_existing {
                *existing = next;
            }
        } else {
            store.turns.push(next);
        }
        trim_supplements(store);
        Ok(())
    })
}

fn load_supplement_store(app_data_dir: &Path) -> Result<SupplementStore, CoreError> {
    read_private_json_or_default(&app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME))
}

fn with_supplement_store<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut SupplementStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let _lock = store_lock::acquire(app_data_dir, SUPPLEMENT_LOCK_FILE_NAME, "보완 저장소")?;
    let mut store = load_supplement_store(app_data_dir)?;
    let value = action(&mut store)?;
    let text = serde_json::to_string_pretty(&store)?;
    fs::write(app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME), text)?;
    Ok(value)
}

fn cap_supplement_text(text: String) -> String {
    let text = text.trim().to_owned();
    if text.len() <= MAX_SUPPLEMENT_TEXT_BYTES {
        return text;
    }
    let end = text.floor_char_boundary(MAX_SUPPLEMENT_TEXT_BYTES);
    format!(
        "{}\n\n[Agent Manager 보관 한도에 따라 일부 생략됨]",
        &text[..end]
    )
}

fn trim_supplements(store: &mut SupplementStore) {
    let mut per_session = HashMap::<String, usize>::new();
    store
        .turns
        .sort_by_key(|turn| std::cmp::Reverse(turn.completed_at));
    store.turns.retain(|turn| {
        let key = session_key(turn.source, &turn.session_id);
        let count = per_session.entry(key).or_default();
        *count += 1;
        *count <= MAX_SUPPLEMENT_TURNS_PER_SESSION
    });
    store.turns.truncate(MAX_SUPPLEMENT_TURNS);
    store.turns.sort_by_key(|turn| turn.completed_at);
}

pub fn update_session_meta(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    patch: SessionMetaPatch,
) -> Result<SessionMeta, CoreError> {
    validate_identifier(session_id)?;
    with_metadata(app_data_dir, |metadata| {
        let folder_ids = if let Some(folder_ids) = patch.folder_ids {
            let known = metadata
                .folders
                .iter()
                .map(|folder| folder.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            let mut unique = Vec::new();
            for folder_id in folder_ids {
                if !known.contains(folder_id.as_str()) {
                    return Err(CoreError::NotFound(format!(
                        "세션 폴더를 찾을 수 없습니다: {folder_id}"
                    )));
                }
                if !unique.contains(&folder_id) {
                    unique.push(folder_id);
                }
            }
            Some(unique)
        } else {
            None
        };
        let current = metadata
            .sessions
            .entry(session_key(source, session_id))
            .or_default();
        if let Some(value) = patch.favorite {
            current.favorite = value;
        }
        if let Some(value) = patch.hidden {
            current.hidden = value;
        }
        if let Some(value) = patch.note {
            current.note = clean_optional(value);
        }
        if let Some(value) = patch.custom_title {
            current.custom_title = clean_optional(value);
        }
        if let Some(folder_ids) = folder_ids {
            current.folder_ids = folder_ids;
        }
        if let Some(value) = patch.pinned_account_id {
            current.pinned_account_id = match clean_optional(value) {
                Some(account_id) => {
                    validate_identifier(&account_id)?;
                    Some(account_id)
                }
                None => None,
            };
        }
        Ok(current.clone())
    })
}

/// 채팅이 실행될 때 세션별 추론 수준·요청 모드·승인 처리를 기록해 이어가기 기본값으로 쓴다.
pub(crate) fn persist_session_runtime_settings(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    effort: Option<ReasoningEffort>,
    mode: ChatMode,
    approval_mode: ChatApprovalMode,
) -> Result<(), CoreError> {
    update_session_entry(app_data_dir, source, session_id, |current| {
        if current.reasoning_effort == effort
            && current.mode == Some(mode)
            && current.approval_mode == Some(approval_mode)
        {
            return false;
        }
        current.reasoning_effort = effort;
        current.mode = Some(mode);
        current.approval_mode = Some(approval_mode);
        true
    })
}

/// 채팅 런타임이 확인한 작업 디렉터리를 Agent Manager 소유 메타데이터에 남긴다.
/// Antigravity CLI처럼 공급자 세션 색인이 cwd를 제공하지 않을 때만 카탈로그가 이 값을
/// 사용하며, 공급자 소유 저장소에는 아무것도 쓰지 않는다(G2, G7, G10).
pub(crate) fn persist_session_working_directory(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    cwd: &Path,
) -> Result<(), CoreError> {
    validate_identifier(session_id)?;
    let canonical = fs::canonicalize(cwd)?;
    if !canonical.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "세션 작업 경로가 디렉터리가 아닙니다: {}",
            canonical.display()
        )));
    }
    let canonical = canonical.to_string_lossy().into_owned();

    with_metadata_changed(app_data_dir, |metadata| {
        let key = session_key(source, session_id);
        if metadata.session_working_directories.get(&key) == Some(&canonical) {
            return Ok((false, ()));
        }
        metadata.session_working_directories.insert(key, canonical);
        Ok((true, ()))
    })
}

/// 예전 반복 회차가 남긴 출처와 현재 반복 요청의 작업 경로를 연결해 cwd 보완 정보를
/// 이관한다. 이미 기록됐거나 공급자가 cwd를 제공하는 세션에는 영향을 주지 않으며,
/// 존재하는 디렉터리로 정규화할 수 있는 경로만 Agent Manager 저장소에 남긴다(G7, G10).
pub(crate) fn backfill_scheduled_session_working_directories(
    app_data_dir: &Path,
    schedule_working_directories: &HashMap<String, PathBuf>,
) -> Result<usize, CoreError> {
    let canonical_by_schedule = schedule_working_directories
        .iter()
        .filter_map(|(schedule_id, cwd)| {
            let canonical = fs::canonicalize(cwd).ok()?;
            canonical.is_dir().then(|| {
                (
                    schedule_id.clone(),
                    canonical.to_string_lossy().into_owned(),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    if canonical_by_schedule.is_empty() {
        return Ok(0);
    }

    with_metadata_changed(app_data_dir, |metadata| {
        let additions = metadata
            .sessions
            .iter()
            .filter_map(|(session_key, session_meta)| {
                if metadata
                    .session_working_directories
                    .contains_key(session_key)
                {
                    return None;
                }
                let schedule_id = session_meta.origin.as_ref()?.schedule_id.as_ref()?;
                let cwd = canonical_by_schedule.get(schedule_id)?;
                Some((session_key.clone(), cwd.clone()))
            })
            .collect::<Vec<_>>();
        if additions.is_empty() {
            return Ok((false, 0));
        }
        let count = additions.len();
        metadata.session_working_directories.extend(additions);
        Ok((true, count))
    })
}

/// 서로 다른 공급자 사이의 인계 관계를 Agent Manager 메타데이터에 양방향으로 남긴다.
/// 공급자 세션 파일은 읽거나 수정하지 않는다.
pub(crate) fn persist_session_handoff(
    app_data_dir: &Path,
    target_source: ProviderId,
    target_session_id: &str,
    origin: &SessionLink,
) -> Result<(), CoreError> {
    validate_identifier(target_session_id)?;
    validate_identifier(&origin.id)?;
    if origin.source == target_source && origin.id == target_session_id {
        return Err(CoreError::InvalidInput(
            "세션 인계 원본과 대상이 같습니다".to_owned(),
        ));
    }

    with_metadata(app_data_dir, |metadata| {
        let origin_key = session_key(origin.source, &origin.id);
        let target_key = session_key(target_source, target_session_id);
        let target_link = SessionLink {
            source: target_source,
            id: target_session_id.to_owned(),
        };
        let origin_meta = metadata.sessions.entry(origin_key).or_default();
        if !origin_meta.handoff_targets.contains(&target_link) {
            origin_meta.handoff_targets.push(target_link);
        }
        metadata
            .sessions
            .entry(target_key)
            .or_default()
            .handoff_origin = Some(origin.clone());
        Ok(())
    })
}

/// 세션의 출처(워크플로 실행·반복 요청 등)를 최초 한 번만 기록한다. 재개로 덮어쓰지 않는다.
pub(crate) fn persist_session_origin(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    origin: &ChatOrigin,
) -> Result<(), CoreError> {
    update_session_entry(app_data_dir, source, session_id, |current| {
        if current.origin.is_some() {
            return false;
        }
        current.origin = Some(origin.clone());
        true
    })
}

/// 세션 메타의 계정 칸 하나를 기록한다. 빈 값은 기록하지 않고, `write_once`가 참이면
/// 이미 값이 있을 때 덮어쓰지 않으며, 거짓이면 값이 달라질 때만 파일을 다시 쓴다.
/// 계정 기록 세 갈래가 저마다 펼쳐 두던 다듬기·식별자 검사·무변경 조기 반환을 한 벌로
/// 모은 것이다.
fn persist_session_account_slot(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    account_id: &str,
    write_once: bool,
    slot: fn(&mut SessionMeta) -> &mut Option<String>,
) -> Result<(), CoreError> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return Ok(());
    }
    validate_identifier(session_id)?;
    validate_identifier(account_id)?;
    update_session_entry(app_data_dir, source, session_id, |current| {
        let field = slot(current);
        if write_once {
            if field.is_some() {
                return false;
            }
        } else if field.as_deref() == Some(account_id) {
            return false;
        }
        *field = Some(account_id.to_owned());
        true
    })
}

/// 세션 메타 한 건을 잠금 없이 읽어 온다. 읽기 계열이 저마다 펼쳐 두던 적재·키 조립을
/// 한 곳에 모은 것으로, 메타데이터가 없거나 세션 기록이 없으면 `None`이다.
fn session_meta_snapshot(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
) -> Option<SessionMeta> {
    load_metadata(app_data_dir)
        .ok()?
        .sessions
        .remove(&session_key(source, session_id))
}

/// 새 세션을 만든 계정을 최초 한 번만 기록한다. 재개나 활성계정 전환으로 덮어쓰지 않는다.
pub(crate) fn persist_session_creation_account_id(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    account_id: Option<&str>,
) -> Result<(), CoreError> {
    let Some(account_id) = account_id else {
        return Ok(());
    };
    persist_session_account_slot(
        app_data_dir,
        source,
        session_id,
        account_id,
        true,
        |current| &mut current.creation_account_id,
    )
}

/// 세션이 묶인 계정을 기록한다. 재개·페일오버로 계정이 바뀌면 그때마다 갱신되며,
/// 값이 같으면 파일을 다시 쓰지 않는다.
pub(crate) fn persist_session_bound_account_id(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    account_id: &str,
) -> Result<(), CoreError> {
    persist_session_account_slot(
        app_data_dir,
        source,
        session_id,
        account_id,
        false,
        |current| &mut current.bound_account_id,
    )
}

/// 이 세션의 실행 계정을 고정한다. 이어가기 정책과 페일오버보다 우선하므로,
/// 채팅을 시작할 때 계정을 못 박아 두면 다음 이어가기도 같은 계정으로 간다.
/// 값이 같으면 파일을 다시 쓰지 않는다.
pub(crate) fn persist_session_pinned_account_id(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    account_id: &str,
) -> Result<(), CoreError> {
    persist_session_account_slot(
        app_data_dir,
        source,
        session_id,
        account_id,
        false,
        |current| &mut current.pinned_account_id,
    )
}

/// 이 세션이 마지막으로 실행된 계정. 기록이 없으면 세션을 만든 계정으로 되돌아간다.
/// `ResumeAccountPolicy::LastUsedAccount`에서만 이어가기 기준으로 쓴다.
pub(crate) fn session_last_used_account_id(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
) -> Option<String> {
    let meta = session_meta_snapshot(app_data_dir, source, session_id)?;
    meta.bound_account_id.or(meta.creation_account_id)
}

/// 이 세션에 고정된 실행 계정. 사용자가 명시적으로 고정한 값만 돌려주며, 실행으로
/// 자동 기록되는 `bound_account_id`·`creation_account_id`는 이어가기 기준이 아니다.
/// 고정이 없으면 호출자가 현재 활성 계정을 쓴다.
pub(crate) fn session_pinned_account_id(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
) -> Option<String> {
    session_meta_snapshot(app_data_dir, source, session_id)?.pinned_account_id
}

/// 채팅 런타임 lease와 실행 실패 기록은 [`crate::chat_runtime_store`]가 맡는다. 호출부가
/// 쓰던 `store::` 경로를 그대로 두려고 여기서 다시 내보낸다.
pub(crate) use crate::chat_runtime_store::{
    latest_runtime_failures, managed_chat_runtime_leases, persist_runtime_failure,
    remove_managed_chat_runtime_lease, runtime_failures_for, upsert_managed_chat_runtime_lease,
    ManagedChatRuntimeLease,
};
/// 문서 루트 안의 파일 트리 읽기·쓰기는 [`crate::document_tree`]가 맡는다. 호출부가
/// 쓰던 `store::` 경로를 그대로 두려고 여기서 다시 내보낸다.
pub use crate::document_tree::{
    list_doc_tree, list_document_entries, read_doc, read_doc_linked_file,
    read_doc_linked_file_download, read_document_file, read_document_file_download, save_doc,
    search_document_entries,
};
pub(crate) use crate::session_folders::folders_with_counts;
/// 정리폴더 트리는 [`crate::session_folders`]가 맡는다. 호출부가 쓰던
/// `store::` 경로를 그대로 두려고 여기서 다시 내보낸다.
pub use crate::session_folders::{
    create_session_folder, delete_session_folder, list_session_folders, reorder_session_folder,
    update_session_folder, FolderMoveDirection, MAX_SESSION_FOLDER_DEPTH,
};

pub fn list_doc_roots(app_data_dir: &Path) -> Result<Vec<DocRootStatus>, CoreError> {
    Ok(load_metadata(app_data_dir)?
        .doc_roots
        .into_iter()
        .map(|root| {
            let path = Path::new(&root.path);
            DocRootStatus {
                exists: path.is_dir(),
                restricted: is_restricted_doc_root(app_data_dir, path),
                root,
            }
        })
        .collect())
}

/// 문서 루트를 등록한다.
///
/// `create_if_missing`은 화면이 "만들까요?"를 물어 사용자가 승인했을 때만 켠다. 폴더
/// 생성 자체(`create_directory`)는 임의 위치를 대상으로 해서 호스트 전용으로 남겨 두고,
/// 문서 루트 등록이라는 이 한 자리에서만 원격에도 열어 준다 — 원격에서 폴더를 못 만들어
/// 등록이 막히던 흐름은 여기뿐이었다. 만드는 규칙은 `create_user_directory`와 같아서
/// 이미 있는 상위 폴더 바로 아래 마지막 한 칸만 생기고, 앱 데이터·공급자 홈은 막힌다.
pub fn add_doc_root(
    app_data_dir: &Path,
    name: &str,
    path: &str,
    create_if_missing: bool,
) -> Result<DocRootStatus, CoreError> {
    // 입력 해석은 채팅 작업 경로와 같은 규칙을 쓴다(`user_path`). 없는 폴더는 화면이
    // "만들까요?"를 물을 수 있도록 고정 문구의 NotFound로 올라간다.
    let canonical = match crate::user_path::resolve_existing_directory(path) {
        // 만들지 못하면 그 이유를 그대로 올린다. 상위가 없어 거절됐을 때의 "찾을 수
        // 없습니다: <상위>"가 사용자에게 어디가 잘못됐는지 더 정확히 말해 준다.
        Err(CoreError::NotFound(_)) if create_if_missing => {
            crate::user_path::create_user_directory(app_data_dir, path)?
        }
        other => other?,
    };
    if is_restricted_doc_root(app_data_dir, &canonical) {
        return Err(CoreError::InvalidInput(
            "공급자 인증 저장소 또는 Agent Manager 앱 데이터와 겹치는 폴더는 문서 루트로 등록할 수 없습니다".to_owned(),
        ));
    }
    let canonical_text = canonical.to_string_lossy().into_owned();
    with_metadata(app_data_dir, |metadata| {
        if metadata
            .doc_roots
            .iter()
            .any(|root| root.path == canonical_text)
        {
            return Err(CoreError::Conflict(
                "이미 등록된 문서 폴더입니다".to_owned(),
            ));
        }
        let display_name = name.trim();
        let display_name = if display_name.is_empty() {
            canonical
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| canonical_text.clone())
        } else {
            display_name.chars().take(120).collect()
        };
        let root = DocRoot {
            id: stable_id(&canonical_text),
            name: display_name,
            path: canonical_text,
            agent_data: is_agent_data_path(&canonical),
        };
        metadata.doc_roots.push(root.clone());
        Ok(DocRootStatus {
            root,
            exists: true,
            restricted: false,
        })
    })
}

pub fn remove_doc_root(app_data_dir: &Path, id: &str) -> Result<(), CoreError> {
    with_metadata(app_data_dir, |metadata| {
        let previous = metadata.doc_roots.len();
        metadata.doc_roots.retain(|root| root.id != id);
        if metadata.doc_roots.len() == previous {
            return Err(CoreError::NotFound(
                "문서 폴더를 찾을 수 없습니다".to_owned(),
            ));
        }
        Ok(())
    })
}

/// 설정에서 제외한 프로젝트의 정규 경로 집합. 스냅샷 합성과 지침 배포 원장이 같은
/// 집합을 읽어 어디서든 같은 프로젝트가 빠지게 한다.
pub(crate) fn excluded_project_paths(app_data_dir: &Path) -> Result<BTreeSet<PathBuf>, CoreError> {
    Ok(load_metadata(app_data_dir)?.excluded_project_set())
}

/// 프로젝트 경로 인자를 저장 키로 만든다. 절대경로만 받고 `..`를 거부한다. 디렉터리가
/// 남아 있으면 정규 경로를 키로 쓰고, 사라졌으면(제외한 뒤 지운 프로젝트를 다시 켤 때)
/// 원문을 그대로 키로 쓴다. 두 번째 값은 정규화 전 원문으로, 제거할 때 함께 지운다.
fn project_setting_key(path: &str) -> Result<(String, String), CoreError> {
    let trimmed = path.trim();
    let raw = Path::new(trimmed);
    if trimmed.is_empty() || !raw.is_absolute() {
        return Err(CoreError::InvalidInput(
            "프로젝트 경로는 절대 경로여야 합니다".to_owned(),
        ));
    }
    if path_guard::has_parent_dir(raw) {
        return Err(CoreError::InvalidInput(
            "프로젝트 경로에 상위 디렉터리(..)를 쓸 수 없습니다".to_owned(),
        ));
    }
    let key = fs::canonicalize(raw)
        .map(|canonical| canonical.to_string_lossy().into_owned())
        .unwrap_or_else(|_| trimmed.to_owned());
    Ok((key, trimmed.to_owned()))
}

fn sorted_unique(values: &mut Vec<String>) {
    values.sort();
    values.dedup();
}

/// 프로젝트의 활성 여부를 바꾼다. 제외 목록을 고치고, 어느 쪽으로 정하든 초기값이
/// 결정된 것으로 기록해 감지 알림에서 뺀다. 갱신된 제외 목록을 돌려준다.
pub fn set_project_active(
    app_data_dir: &Path,
    path: &str,
    active: bool,
) -> Result<Vec<String>, CoreError> {
    let (key, raw) = project_setting_key(path)?;
    with_metadata(app_data_dir, |metadata| {
        metadata
            .excluded_projects
            .retain(|value| *value != key && *value != raw);
        if !active {
            metadata.excluded_projects.push(key.clone());
        }
        sorted_unique(&mut metadata.excluded_projects);
        // 시드 전(`None`)에는 목록을 만들지 않는다. 여기서 하나만 채우면 다음 기동의 시드가
        // 건너뛰어져 나머지 기존 프로젝트가 전부 결정 대기로 뜬다.
        if let Some(known) = metadata.known_projects.as_mut() {
            known.push(key);
            sorted_unique(known);
        }
        Ok(metadata.excluded_projects.clone())
    })
}

/// 사용자가 앱에서 직접 고른 작업 경로를 결정된 프로젝트로 기록한다. 감지가 아니라
/// 추가이므로 알림을 띄우지 않기 위해서다. 시드 전에는 아무것도 하지 않는다.
pub(crate) fn mark_project_known(app_data_dir: &Path, path: &str) -> Result<(), CoreError> {
    let (key, _) = project_setting_key(path)?;
    with_metadata_changed(app_data_dir, |metadata| {
        let Some(known) = metadata.known_projects.as_mut() else {
            return Ok((false, ()));
        };
        if known.contains(&key) {
            return Ok((false, ()));
        }
        known.push(key);
        sorted_unique(known);
        Ok((true, ()))
    })
}

/// 결정된 프로젝트 목록이 아직 없으면 현재 프로젝트 전부로 채운다. 기존 사용자가 이
/// 기능을 처음 만났을 때 모든 프로젝트가 "새로 감지됨"으로 뜨지 않게 하는 1회 시드다.
/// 채웠으면 `true`.
pub(crate) fn seed_known_projects_if_needed(
    app_data_dir: &Path,
    paths: &[String],
) -> Result<bool, CoreError> {
    with_metadata_changed(app_data_dir, |metadata| {
        if metadata.known_projects.is_some() {
            return Ok((false, false));
        }
        let mut known = paths.to_vec();
        sorted_unique(&mut known);
        metadata.known_projects = Some(known);
        Ok((true, true))
    })
}

pub(crate) fn is_restricted_doc_root(app_data_dir: &Path, path: &Path) -> bool {
    let redirected_provider_dirs = crate::credential_profiles::inherited_credential_dirs();
    is_restricted_doc_root_with_provider_dirs(app_data_dir, path, &redirected_provider_dirs)
}

fn is_restricted_doc_root_with_provider_dirs(
    app_data_dir: &Path,
    path: &Path,
    redirected_provider_dirs: &[PathBuf],
) -> bool {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let app_data = fs::canonicalize(app_data_dir).unwrap_or_else(|_| app_data_dir.to_path_buf());
    let mut protected = vec![app_data];
    if let Some(home) = user_home::optional_home_dir() {
        protected.extend(AGENT_DATA_DIR_NAMES.into_iter().map(|name| home.join(name)));
    }
    // 공급자 홈을 환경변수로 옮긴 설치도 기본 홈과 똑같은 읽기·쓰기 금지 경계다.
    // 이 변수들은 Agent Manager가 실제 공급자 런타임 구성에 사용하는 경로만 읽는다(G8).
    protected.extend(redirected_provider_dirs.iter().cloned());
    protected.into_iter().any(|item| {
        let item = fs::canonicalize(&item).unwrap_or(item);
        path.starts_with(&item) || item.starts_with(&path)
    })
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().chars().take(20_000).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn stable_id(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("root-{hash:016x}")
}

fn is_agent_data_path(path: &Path) -> bool {
    user_home::optional_home_dir().is_some_and(|home| {
        AGENT_DATA_DIR_NAMES
            .iter()
            .any(|name| path.starts_with(home.join(name)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_round_trip_preserves_session_and_root() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let patch = SessionMetaPatch {
            favorite: Some(true),
            hidden: None,
            note: Some(Some("important".to_owned())),
            custom_title: None,
            folder_ids: None,
            pinned_account_id: None,
        };
        update_session_meta(temp.path(), ProviderId::Claude, "1234567890abcdef", patch)
            .expect("metadata must save");
        let loaded = load_metadata(temp.path()).expect("metadata must load");
        assert!(loaded.sessions["claude:1234567890abcdef"].favorite);
        assert_eq!(
            loaded.sessions["claude:1234567890abcdef"].note.as_deref(),
            Some("important")
        );
    }

    #[test]
    fn session_metadata_and_runtime_settings_share_the_store_lock() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let session_id = "session-lock-123456";
        let key = format!("claude:{session_id}");
        let guard = store_lock::acquire(
            temp.path(),
            STORE_LOCK_FILE_NAME,
            "metadata concurrency test",
        )
        .expect("metadata lock");
        let (sender, receiver) = std::sync::mpsc::channel();
        let app_data_dir = temp.path().to_path_buf();
        let worker = std::thread::spawn(move || {
            let result = update_session_meta(
                &app_data_dir,
                ProviderId::Claude,
                session_id,
                SessionMetaPatch {
                    favorite: None,
                    hidden: None,
                    note: None,
                    custom_title: Some(Some("saved title".to_owned())),
                    folder_ids: None,
                    pinned_account_id: None,
                },
            );
            sender.send(result).expect("test receiver must remain open");
        });

        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        let mut latest = load_metadata(temp.path()).expect("metadata must load");
        let meta = latest.sessions.entry(key.clone()).or_default();
        meta.mode = Some(ChatMode::FullAccess);
        meta.approval_mode = Some(ChatApprovalMode::Never);
        save_metadata(temp.path(), &latest).expect("concurrent runtime settings must save");
        drop(guard);

        receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("metadata update must resume after unlock")
            .expect("metadata update must succeed");
        worker.join().expect("metadata worker must finish");
        let loaded = load_metadata(temp.path()).expect("metadata must load");
        let meta = &loaded.sessions[&key];
        assert_eq!(meta.custom_title.as_deref(), Some("saved title"));
        assert_eq!(meta.mode, Some(ChatMode::FullAccess));
        assert_eq!(meta.approval_mode, Some(ChatApprovalMode::Never));

        let guard = store_lock::acquire(
            temp.path(),
            STORE_LOCK_FILE_NAME,
            "runtime settings concurrency test",
        )
        .expect("metadata lock");
        let (sender, receiver) = std::sync::mpsc::channel();
        let app_data_dir = temp.path().to_path_buf();
        let worker = std::thread::spawn(move || {
            let result = persist_session_runtime_settings(
                &app_data_dir,
                ProviderId::Claude,
                session_id,
                None,
                ChatMode::Manual,
                ChatApprovalMode::Manual,
            );
            sender.send(result).expect("test receiver must remain open");
        });

        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        let mut latest = load_metadata(temp.path()).expect("metadata must load");
        latest
            .sessions
            .get_mut(&key)
            .expect("session metadata must exist")
            .note = Some("saved note".to_owned());
        save_metadata(temp.path(), &latest).expect("concurrent metadata must save");
        drop(guard);

        receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("runtime settings update must resume after unlock")
            .expect("runtime settings update must succeed");
        worker.join().expect("runtime settings worker must finish");
        let loaded = load_metadata(temp.path()).expect("metadata must load");
        let meta = &loaded.sessions[&key];
        assert_eq!(meta.custom_title.as_deref(), Some("saved title"));
        assert_eq!(meta.note.as_deref(), Some("saved note"));
        assert_eq!(meta.mode, Some(ChatMode::Manual));
        assert_eq!(meta.approval_mode, Some(ChatApprovalMode::Manual));
    }

    #[test]
    fn metadata_save_uses_the_private_json_format() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        save_metadata(temp.path(), &AppMetadata::default()).expect("metadata must save");

        let stored = fs::read_to_string(temp.path().join(STORE_FILE_NAME))
            .expect("metadata store must exist");
        assert!(stored.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<AppMetadata>(&stored)
                .expect("metadata store must remain parseable")
                .sessions
                .len(),
            0
        );
    }

    #[test]
    fn runtime_settings_persist_for_continuation_defaults() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let session_id = "session-1234567890";

        persist_session_runtime_settings(
            temp.path(),
            ProviderId::Claude,
            session_id,
            Some(ReasoningEffort::Xhigh),
            ChatMode::FullAccess,
            ChatApprovalMode::Never,
        )
        .expect("runtime settings must save");

        let loaded = load_metadata(temp.path()).expect("metadata must load");
        let meta = &loaded.sessions["claude:session-1234567890"];
        assert_eq!(meta.reasoning_effort, Some(ReasoningEffort::Xhigh));
        assert_eq!(meta.mode, Some(ChatMode::FullAccess));
        assert_eq!(meta.approval_mode, Some(ChatApprovalMode::Never));
    }

    #[test]
    fn session_working_directory_is_canonicalized_and_persisted() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data_dir = temp.path().join("app-data");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&app_data_dir).expect("app data directory must exist");
        fs::create_dir_all(&workspace).expect("workspace must exist");

        persist_session_working_directory(
            &app_data_dir,
            ProviderId::Antigravity,
            "session-1234567890",
            &workspace,
        )
        .expect("working directory must save");

        let loaded = load_metadata(&app_data_dir).expect("metadata must load");
        assert_eq!(
            loaded.session_working_directories["antigravity:session-1234567890"],
            fs::canonicalize(workspace)
                .expect("workspace must canonicalize")
                .to_string_lossy()
        );
    }

    #[test]
    fn scheduled_session_working_directories_backfill_existing_origins_once() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data_dir = temp.path().join("app-data");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&app_data_dir).expect("app data directory must exist");
        fs::create_dir_all(&workspace).expect("workspace must exist");
        let session_key = "antigravity:session-1234567890".to_owned();
        let mut metadata = AppMetadata::default();
        metadata.sessions.insert(
            session_key.clone(),
            SessionMeta {
                origin: Some(ChatOrigin {
                    kind: crate::domain::ChatOriginKind::Workflow,
                    workflow_id: Some("workflow-123".to_owned()),
                    execution_id: Some("execution-123".to_owned()),
                    schedule_id: Some("schedule-123".to_owned()),
                    run_id: Some("run-123".to_owned()),
                    consumer_id: Some("schedule-123".to_owned()),
                }),
                ..SessionMeta::default()
            },
        );
        save_metadata(&app_data_dir, &metadata).expect("metadata must save");
        let schedule_paths = HashMap::from([("schedule-123".to_owned(), workspace.clone())]);

        assert_eq!(
            backfill_scheduled_session_working_directories(&app_data_dir, &schedule_paths)
                .expect("working directories must backfill"),
            1
        );
        assert_eq!(
            backfill_scheduled_session_working_directories(&app_data_dir, &schedule_paths)
                .expect("repeated backfill must be a no-op"),
            0
        );
        let loaded = load_metadata(&app_data_dir).expect("metadata must load");
        assert_eq!(
            loaded.session_working_directories[&session_key],
            fs::canonicalize(workspace)
                .expect("workspace must canonicalize")
                .to_string_lossy()
        );
    }

    #[test]
    fn provider_handoff_links_origin_and_target_without_duplicates() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let origin = SessionLink {
            source: ProviderId::Claude,
            id: "origin-session-123".to_owned(),
        };

        persist_session_handoff(
            temp.path(),
            ProviderId::Codex,
            "target-session-123",
            &origin,
        )
        .expect("handoff must save");
        persist_session_handoff(
            temp.path(),
            ProviderId::Codex,
            "target-session-123",
            &origin,
        )
        .expect("repeated handoff persistence must be idempotent");

        let loaded = load_metadata(temp.path()).expect("metadata must load");
        assert_eq!(
            loaded.sessions["codex:target-session-123"].handoff_origin,
            Some(origin.clone())
        );
        assert_eq!(
            loaded.sessions["claude:origin-session-123"].handoff_targets,
            vec![SessionLink {
                source: ProviderId::Codex,
                id: "target-session-123".to_owned(),
            }]
        );
    }

    #[test]
    fn creation_account_is_recorded_once() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let session_id = "session-1234567890";

        persist_session_creation_account_id(
            temp.path(),
            ProviderId::Codex,
            session_id,
            Some("account-1234567890"),
        )
        .expect("creation account must save");
        persist_session_creation_account_id(
            temp.path(),
            ProviderId::Codex,
            session_id,
            Some("account-0987654321"),
        )
        .expect("existing creation account must remain unchanged");

        let loaded = load_metadata(temp.path()).expect("metadata must load");
        assert_eq!(
            loaded.sessions["codex:session-1234567890"]
                .creation_account_id
                .as_deref(),
            Some("account-1234567890")
        );
    }

    #[test]
    fn bound_account_keeps_being_updated_but_is_not_the_resume_basis() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let session_id = "session-1234567890";

        persist_session_creation_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            Some("claude-account-created-01"),
        )
        .expect("creation account must save");
        persist_session_bound_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            "claude-account-failover-01",
        )
        .expect("bound account must save");
        persist_session_bound_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            "claude-account-failover-02",
        )
        .expect("bound account must update");

        let loaded = load_metadata(temp.path()).expect("metadata must load");
        let meta = &loaded.sessions["claude:session-1234567890"];
        // 최초 한 번만 남는 creation과 달리 실행마다 갱신된다.
        assert_eq!(
            meta.bound_account_id.as_deref(),
            Some("claude-account-failover-02")
        );
        assert_eq!(
            meta.creation_account_id.as_deref(),
            Some("claude-account-created-01")
        );
        // 실행 기록만으로는 이어가기 계정이 고정되지 않는다.
        assert!(session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).is_none());
    }

    #[test]
    fn starting_with_a_pin_fixes_the_account_and_later_runs_do_not_move_it() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let session_id = "session-1234567890";

        persist_session_pinned_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            "claude-account-lane-01",
        )
        .expect("pin must save");
        assert_eq!(
            session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).as_deref(),
            Some("claude-account-lane-01")
        );

        // 같은 값을 다시 써도 결과가 흔들리지 않는다.
        persist_session_pinned_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            "claude-account-lane-01",
        )
        .expect("repeated pin must be a no-op");
        assert_eq!(
            session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).as_deref(),
            Some("claude-account-lane-01")
        );

        // 실행 기록이 다른 계정으로 바뀌어도 고정값은 그대로다.
        persist_session_bound_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            "claude-account-run-02",
        )
        .expect("bound account must update");
        assert_eq!(
            session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).as_deref(),
            Some("claude-account-lane-01")
        );

        // 빈 값은 고정을 지우지 않는다. 해제는 명시적 patch만 한다.
        persist_session_pinned_account_id(temp.path(), ProviderId::Claude, session_id, "   ")
            .expect("blank pin must be ignored");
        assert_eq!(
            session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).as_deref(),
            Some("claude-account-lane-01")
        );
    }

    #[test]
    fn pinned_account_is_set_and_cleared_only_by_an_explicit_patch() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let session_id = "session-1234567890";

        persist_session_bound_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            "claude-account-run-01",
        )
        .expect("bound account must save");

        update_session_meta(
            temp.path(),
            ProviderId::Claude,
            session_id,
            SessionMetaPatch {
                favorite: None,
                hidden: None,
                note: None,
                custom_title: None,
                folder_ids: None,
                pinned_account_id: Some(Some("claude-account-pinned-01".to_owned())),
            },
        )
        .expect("pin must save");
        assert_eq!(
            session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).as_deref(),
            Some("claude-account-pinned-01")
        );

        // 이후 실행이 다른 계정으로 되어도 고정값은 실행 기록에 흔들리지 않는다.
        persist_session_bound_account_id(
            temp.path(),
            ProviderId::Claude,
            session_id,
            "claude-account-run-02",
        )
        .expect("bound account must update");
        assert_eq!(
            session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).as_deref(),
            Some("claude-account-pinned-01")
        );

        update_session_meta(
            temp.path(),
            ProviderId::Claude,
            session_id,
            SessionMetaPatch {
                favorite: None,
                hidden: None,
                note: None,
                custom_title: None,
                folder_ids: None,
                pinned_account_id: Some(None),
            },
        )
        .expect("pin must clear");
        assert!(session_pinned_account_id(temp.path(), ProviderId::Claude, session_id).is_none());

        // 다른 공급자·모르는 세션은 영향을 받지 않는다.
        assert!(session_pinned_account_id(temp.path(), ProviderId::Codex, session_id).is_none());
        assert!(
            session_pinned_account_id(temp.path(), ProviderId::Claude, "session-unknown").is_none()
        );
    }

    #[test]
    fn redirected_provider_homes_are_restricted_document_roots() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let redirected = temp.path().join("provider-state");
        let nested = redirected.join("sessions");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&nested).expect("provider state");

        assert!(is_restricted_doc_root_with_provider_dirs(
            &app_data,
            &redirected,
            std::slice::from_ref(&redirected),
        ));
        assert!(is_restricted_doc_root_with_provider_dirs(
            &app_data,
            &nested,
            std::slice::from_ref(&redirected),
        ));
        assert!(is_restricted_doc_root_with_provider_dirs(
            &app_data,
            temp.path(),
            std::slice::from_ref(&redirected),
        ));
    }

    #[test]
    fn doc_root_registration_can_create_the_missing_last_segment() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data must exist");
        let parent = temp.path().join("Documents");
        fs::create_dir_all(&parent).expect("parent must exist");
        let target = parent.join("agentManagerQA");

        // 기본값은 지금까지와 같다. 없는 폴더는 화면이 "만들까요?"를 물을 수 있도록
        // 고정 문구의 NotFound로 올라간다.
        let error = add_doc_root(&app_data, "QA", target.to_string_lossy().as_ref(), false)
            .expect_err("없는 폴더는 거절한다");
        assert!(matches!(error, CoreError::NotFound(_)));
        assert!(!target.exists());

        // 승인했을 때만 그 한 칸을 만들고 등록한다.
        let root = add_doc_root(&app_data, "QA", target.to_string_lossy().as_ref(), true)
            .expect("만들고 등록한다");
        assert!(target.is_dir());
        assert_eq!(root.root.name, "QA");
        assert!(root.exists);

        // 상위가 없으면 트리를 만들지 않는다 — 오타 하나로 폴더가 줄줄이 생기지 않는다.
        let deep = temp.path().join("Documentz").join("agentManagerQA");
        let error = add_doc_root(&app_data, "QA", deep.to_string_lossy().as_ref(), true)
            .expect_err("상위가 없으면 거절한다");
        assert!(matches!(error, CoreError::NotFound(_)));
        assert!(!temp.path().join("Documentz").exists());

        // 앱 데이터 안은 만들지도 등록하지도 않는다.
        let inside = app_data.join("sneaky");
        let error = add_doc_root(&app_data, "QA", inside.to_string_lossy().as_ref(), true)
            .expect_err("앱 데이터 안은 거절한다");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        assert!(!inside.exists());
    }

    #[test]
    fn folder_assignment_survives_reload_and_delete_cleans_sessions() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let folder = create_session_folder(temp.path(), "검토", "#51e97d", None)
            .expect("folder must be created");
        update_session_meta(
            temp.path(),
            ProviderId::Codex,
            "1234567890abcdef",
            SessionMetaPatch {
                favorite: None,
                hidden: None,
                note: None,
                custom_title: None,
                folder_ids: Some(vec![folder.id.clone()]),
                pinned_account_id: None,
            },
        )
        .expect("folder assignment must save");

        let reloaded = load_metadata(temp.path()).expect("metadata must reload");
        assert_eq!(
            reloaded.sessions["codex:1234567890abcdef"].folder_ids,
            std::slice::from_ref(&folder.id)
        );
        assert_eq!(folders_with_counts(&reloaded)[0].session_count, 1);

        delete_session_folder(temp.path(), &folder.id).expect("folder must delete");
        let reloaded = load_metadata(temp.path()).expect("metadata must reload");
        assert!(reloaded.sessions["codex:1234567890abcdef"]
            .folder_ids
            .is_empty());
    }

    fn assign_session_to_folders(app_data_dir: &Path, session_id: &str, folder_ids: Vec<String>) {
        update_session_meta(
            app_data_dir,
            ProviderId::Codex,
            session_id,
            SessionMetaPatch {
                favorite: None,
                hidden: None,
                note: None,
                custom_title: None,
                folder_ids: Some(folder_ids),
                pinned_account_id: None,
            },
        )
        .expect("folder assignment must save");
    }

    #[test]
    fn folder_tree_is_listed_parent_first_with_rolled_up_counts() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let parent = create_session_folder(temp.path(), "업무", "#51e97d", None)
            .expect("parent must be created");
        let child = create_session_folder(temp.path(), "리뷰", "#2563eb", Some(&parent.id))
            .expect("child must be created");
        let grandchild = create_session_folder(temp.path(), "긴급", "#f0b054", Some(&child.id))
            .expect("grandchild must be created");
        assert_eq!(child.depth, 1);
        assert_eq!(grandchild.depth, 2);

        assign_session_to_folders(temp.path(), "1111111111111111", vec![parent.id.clone()]);
        assign_session_to_folders(
            temp.path(),
            "2222222222222222",
            vec![child.id.clone(), grandchild.id.clone()],
        );

        let folders = list_session_folders(temp.path()).expect("folders must list");
        assert_eq!(
            folders
                .iter()
                .map(|folder| (folder.name.as_str(), folder.depth))
                .collect::<Vec<_>>(),
            vec![("업무", 0), ("리뷰", 1), ("긴급", 2)]
        );
        // 같은 세션이 하위 두 폴더에 담겨 있어도 트리 합계에서는 한 번만 센다.
        assert_eq!(folders[0].session_count, 1);
        assert_eq!(folders[0].total_session_count, 2);
        assert_eq!(folders[1].total_session_count, 1);
    }

    #[test]
    fn hidden_folder_keeps_its_own_count_and_leaves_the_parent_total() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let parent = create_session_folder(temp.path(), "업무", "#51e97d", None)
            .expect("parent must be created");
        let child = create_session_folder(temp.path(), "리뷰", "#2563eb", Some(&parent.id))
            .expect("child must be created");
        let grandchild = create_session_folder(temp.path(), "긴급", "#f0b054", Some(&child.id))
            .expect("grandchild must be created");

        assign_session_to_folders(temp.path(), "1111111111111111", vec![parent.id.clone()]);
        assign_session_to_folders(temp.path(), "2222222222222222", vec![child.id.clone()]);
        assign_session_to_folders(temp.path(), "3333333333333333", vec![grandchild.id.clone()]);

        let hidden = update_session_folder(temp.path(), &child.id, None, None, None, Some(true))
            .expect("folder must hide");
        assert!(hidden.hidden);
        // 숨긴 폴더 자신은 직접·하위 세션을 그대로 세고, 상위 폴더만 그 트리를 뺀다.
        assert_eq!(hidden.session_count, 1);
        assert_eq!(hidden.total_session_count, 2);

        let folders = list_session_folders(temp.path()).expect("folders must list");
        assert_eq!(folders[0].total_session_count, 1);
        assert_eq!(folders[2].total_session_count, 1);

        let shown = update_session_folder(temp.path(), &child.id, None, None, None, Some(false))
            .expect("folder must show again");
        assert!(!shown.hidden);
        let folders = list_session_folders(temp.path()).expect("folders must list");
        assert_eq!(folders[0].total_session_count, 3);
    }

    #[test]
    fn folder_reorder_moves_one_step_among_siblings_only() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let first = create_session_folder(temp.path(), "가", "#51e97d", None)
            .expect("first must be created");
        let second = create_session_folder(temp.path(), "나", "#2563eb", None)
            .expect("second must be created");
        let third = create_session_folder(temp.path(), "다", "#f0b054", None)
            .expect("third must be created");
        let nested = create_session_folder(temp.path(), "라", "#f0b054", Some(&second.id))
            .expect("nested must be created");
        let names = |folders: &[SessionFolder]| {
            folders
                .iter()
                .map(|folder| folder.name.clone())
                .collect::<Vec<_>>()
        };

        let folders = reorder_session_folder(temp.path(), &third.id, FolderMoveDirection::Up)
            .expect("third must move up");
        assert_eq!(names(&folders), vec!["가", "다", "나", "라"]);

        let folders = reorder_session_folder(temp.path(), &first.id, FolderMoveDirection::Down)
            .expect("first must move down");
        assert_eq!(names(&folders), vec!["다", "가", "나", "라"]);

        // 끝에서 더 옮기려 해도 순서는 그대로 두고 오류도 내지 않는다.
        let folders = reorder_session_folder(temp.path(), &third.id, FolderMoveDirection::Up)
            .expect("top folder must stay");
        assert_eq!(names(&folders), vec!["다", "가", "나", "라"]);

        // 형제가 없는 하위 폴더는 다른 단계의 폴더와 자리를 바꾸지 않는다.
        let folders = reorder_session_folder(temp.path(), &nested.id, FolderMoveDirection::Up)
            .expect("only child must stay");
        assert_eq!(names(&folders), vec!["다", "가", "나", "라"]);
        assert_eq!(
            names(&list_session_folders(temp.path()).expect("folders must list")),
            vec!["다", "가", "나", "라"]
        );
    }

    #[test]
    fn folder_move_rejects_its_own_subtree_and_beyond_the_depth_limit() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let mut chain = vec![create_session_folder(temp.path(), "1단계", "#51e97d", None)
            .expect("root must be created")];
        for step in 2..=MAX_SESSION_FOLDER_DEPTH {
            let parent = chain.last().expect("previous level must exist").id.clone();
            chain.push(
                create_session_folder(
                    temp.path(),
                    &format!("{step}단계"),
                    "#51e97d",
                    Some(&parent),
                )
                .expect("nested folder must be created"),
            );
        }
        let deepest = chain.last().expect("deepest level must exist").id.clone();
        assert!(create_session_folder(temp.path(), "초과", "#51e97d", Some(&deepest)).is_err());

        let root = chain[0].id.clone();
        let child = chain[1].id.clone();
        assert!(
            update_session_folder(temp.path(), &root, None, None, Some(Some(&child)), None)
                .is_err()
        );
        assert!(
            update_session_folder(temp.path(), &root, None, None, Some(Some(&root)), None).is_err()
        );

        let moved = update_session_folder(temp.path(), &child, None, None, Some(None), None)
            .expect("subtree must move to the top level");
        assert_eq!(moved.parent_id, None);
        assert_eq!(moved.depth, 0);
        assert_eq!(
            list_session_folders(temp.path())
                .expect("folders must list")
                .len(),
            MAX_SESSION_FOLDER_DEPTH
        );
    }

    #[test]
    fn deleting_a_folder_removes_its_subtree_and_session_assignments() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let parent = create_session_folder(temp.path(), "업무", "#51e97d", None)
            .expect("parent must be created");
        let child = create_session_folder(temp.path(), "리뷰", "#2563eb", Some(&parent.id))
            .expect("child must be created");
        let other = create_session_folder(temp.path(), "보관", "#f0b054", None)
            .expect("sibling must be created");
        assign_session_to_folders(
            temp.path(),
            "3333333333333333",
            vec![child.id.clone(), other.id.clone()],
        );

        let removed = delete_session_folder(temp.path(), &parent.id).expect("folder must delete");
        assert_eq!(removed, vec![parent.id.clone(), child.id.clone()]);

        let metadata = load_metadata(temp.path()).expect("metadata must reload");
        assert_eq!(
            metadata.sessions["codex:3333333333333333"].folder_ids,
            std::slice::from_ref(&other.id)
        );
        assert_eq!(
            list_session_folders(temp.path())
                .expect("folders must list")
                .len(),
            1
        );
    }

    #[test]
    fn broken_parent_references_fall_back_to_the_top_level() {
        let metadata = AppMetadata {
            folders: vec![
                SessionFolder {
                    id: "a".to_owned(),
                    name: "고아".to_owned(),
                    color: "#51e97d".to_owned(),
                    sort_order: 0,
                    parent_id: Some("missing".to_owned()),
                    hidden: false,
                    depth: 0,
                    session_count: 0,
                    total_session_count: 0,
                },
                SessionFolder {
                    id: "b".to_owned(),
                    name: "순환1".to_owned(),
                    color: "#51e97d".to_owned(),
                    sort_order: 1,
                    parent_id: Some("c".to_owned()),
                    hidden: false,
                    depth: 0,
                    session_count: 0,
                    total_session_count: 0,
                },
                SessionFolder {
                    id: "c".to_owned(),
                    name: "순환2".to_owned(),
                    color: "#51e97d".to_owned(),
                    sort_order: 2,
                    parent_id: Some("b".to_owned()),
                    hidden: false,
                    depth: 0,
                    session_count: 0,
                    total_session_count: 0,
                },
            ],
            ..AppMetadata::default()
        };

        let folders = folders_with_counts(&metadata);
        assert_eq!(folders.len(), 3);
        assert!(folders.iter().all(|folder| folder.parent_id.is_none()));
        assert!(folders.iter().all(|folder| folder.depth == 0));
    }

    #[test]
    fn captured_turn_replaces_the_same_turn_and_reports_storage_stats() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        persist_captured_turn(
            temp.path(),
            ProviderId::Claude,
            "session-1234567890",
            "turn-1234567890abcd",
            1,
            "first response".to_owned(),
            SupplementOrigin::Chat,
        )
        .expect("first captured turn");
        persist_captured_turn(
            temp.path(),
            ProviderId::Claude,
            "session-1234567890",
            "turn-1234567890abcd",
            2,
            "final response".to_owned(),
            SupplementOrigin::Chat,
        )
        .expect("replacement captured turn");

        let turns = captured_turns_for(temp.path(), ProviderId::Claude, "session-1234567890")
            .expect("captured turns");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "final response");
        let stats = supplement_storage_stats(temp.path()).expect("supplement stats");
        assert_eq!(stats.turn_count, 1);
        assert_eq!(stats.session_count, 1);
        assert!(stats.size_bytes > 0);
    }
    #[test]
    fn project_exclusion_normalizes_and_toggles() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project directory");
        let canonical = fs::canonicalize(&project)
            .expect("canonical project")
            .to_string_lossy()
            .into_owned();

        // 시드 전에는 known 목록을 만들지 않는다.
        let excluded = set_project_active(temp.path(), &project.to_string_lossy(), false)
            .expect("exclude project");
        assert_eq!(excluded, vec![canonical.clone()]);
        let metadata = load_metadata(temp.path()).expect("metadata");
        assert!(metadata.known_projects.is_none());
        assert!(metadata
            .excluded_project_set()
            .contains(Path::new(&canonical)));

        // 같은 경로를 다시 제외해도 중복되지 않고, 상대·상위 경로는 거부한다.
        let excluded = set_project_active(temp.path(), &project.to_string_lossy(), false)
            .expect("exclude again");
        assert_eq!(excluded.len(), 1);
        assert!(set_project_active(temp.path(), "relative/path", false).is_err());
        assert!(
            set_project_active(temp.path(), &format!("{}/../x", project.display()), false).is_err()
        );

        // 시드 후에는 결정으로 기록된다.
        assert!(seed_known_projects_if_needed(temp.path(), &[]).expect("seed"));
        assert!(
            !seed_known_projects_if_needed(temp.path(), &["/ignored".to_owned()])
                .expect("seed twice")
        );
        let excluded =
            set_project_active(temp.path(), &project.to_string_lossy(), true).expect("reactivate");
        assert!(excluded.is_empty());
        let metadata = load_metadata(temp.path()).expect("metadata");
        assert_eq!(
            metadata.known_projects.as_deref(),
            Some(&[canonical.clone()][..])
        );
        assert_eq!(
            excluded_project_paths(temp.path())
                .expect("excluded set")
                .len(),
            0
        );
    }

    #[test]
    fn project_exclusion_reactivates_vanished_directory() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let project = temp.path().join("vanishing");
        fs::create_dir_all(&project).expect("project directory");
        let canonical = fs::canonicalize(&project)
            .expect("canonical project")
            .to_string_lossy()
            .into_owned();
        set_project_active(temp.path(), &project.to_string_lossy(), false).expect("exclude");
        fs::remove_dir_all(&project).expect("remove project");

        // 디렉터리가 사라져 정규화할 수 없어도 저장된 정규 경로 문자열로 다시 켤 수 있다.
        let excluded = set_project_active(temp.path(), &canonical, true).expect("reactivate");
        assert!(excluded.is_empty());
    }

    #[test]
    fn mark_project_known_is_idempotent_and_waits_for_seed() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let project = temp.path().join("chat-project");
        fs::create_dir_all(&project).expect("project directory");
        let canonical = fs::canonicalize(&project)
            .expect("canonical project")
            .to_string_lossy()
            .into_owned();

        mark_project_known(temp.path(), &project.to_string_lossy()).expect("mark before seed");
        assert!(load_metadata(temp.path())
            .expect("metadata")
            .known_projects
            .is_none());

        assert!(seed_known_projects_if_needed(temp.path(), &["/seeded".to_owned()]).expect("seed"));
        mark_project_known(temp.path(), &project.to_string_lossy()).expect("mark");
        mark_project_known(temp.path(), &project.to_string_lossy()).expect("mark again");
        let metadata = load_metadata(temp.path()).expect("metadata");
        let mut expected = ["/seeded".to_owned(), canonical];
        expected.sort();
        assert_eq!(metadata.known_projects.as_deref(), Some(&expected[..]));
    }

    #[test]
    fn origin_is_persisted_to_session_meta_on_first_session_id() {
        use crate::domain::{ChatOrigin, ChatOriginKind};
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let first = ChatOrigin {
            kind: ChatOriginKind::Workflow,
            workflow_id: Some("wf-qa".to_owned()),
            execution_id: Some("wfexec-1".to_owned()),
            schedule_id: Some("schedule-1".to_owned()),
            run_id: Some("run-1".to_owned()),
            consumer_id: Some("schedule-1".to_owned()),
        };
        persist_session_origin(
            temp.path(),
            ProviderId::Claude,
            "session-origin-0001",
            &first,
        )
        .expect("persist");
        // 재개 실행이 다른 출처를 들고 와도 최초 기록을 덮어쓰지 않는다.
        let later = ChatOrigin::direct(ChatOriginKind::User);
        persist_session_origin(
            temp.path(),
            ProviderId::Claude,
            "session-origin-0001",
            &later,
        )
        .expect("persist");
        let metadata = load_metadata(temp.path()).expect("metadata");
        let meta = metadata
            .sessions
            .get("claude:session-origin-0001")
            .expect("session meta");
        assert_eq!(meta.origin.as_ref(), Some(&first));
        assert!(!metadata.sessions.contains_key("claude:session-origin-0002"));
    }

    /// FolderMoveDirection의 문자열 변환, 파싱, 직렬화, 역직렬화 및 델타 값을 검증한다.
    #[test]
    fn folder_move_direction_contract_and_serde() {
        use std::str::FromStr;

        assert_eq!(FolderMoveDirection::ALL.len(), 2);
        assert_eq!(
            FolderMoveDirection::ALL,
            [FolderMoveDirection::Up, FolderMoveDirection::Down]
        );

        for direction in FolderMoveDirection::ALL {
            let s = direction.as_str();
            assert_eq!(direction.to_string(), s);
            assert_eq!(FolderMoveDirection::from_str(s).expect("parse"), direction);

            let json = serde_json::to_string(&direction).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let deserialized: FolderMoveDirection =
                serde_json::from_str(&json).expect("deserialize");
            assert_eq!(deserialized, direction);
        }

        assert_eq!(FolderMoveDirection::Up.as_str(), "up");
        assert!(FolderMoveDirection::Up.is_up());
        assert!(!FolderMoveDirection::Up.is_down());
        assert_eq!(FolderMoveDirection::Up.delta(), -1);

        assert_eq!(FolderMoveDirection::Down.as_str(), "down");
        assert!(FolderMoveDirection::Down.is_down());
        assert!(!FolderMoveDirection::Down.is_up());
        assert_eq!(FolderMoveDirection::Down.delta(), 1);

        // 대소문자 무시 파싱 검증
        assert_eq!(
            FolderMoveDirection::from_str("UP").expect("case insensitive"),
            FolderMoveDirection::Up
        );
        assert_eq!(
            FolderMoveDirection::from_str("Down").expect("case insensitive"),
            FolderMoveDirection::Down
        );

        // 잘못된 입력 에러 검증
        let error = FolderMoveDirection::from_str("left").expect_err("invalid direction");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn supplement_origin_contract_and_serde() {
        use std::str::FromStr;

        assert_eq!(SupplementOrigin::ALL.len(), 2);
        assert_eq!(
            SupplementOrigin::ALL,
            [SupplementOrigin::Chat, SupplementOrigin::Scheduled]
        );

        for origin in SupplementOrigin::ALL {
            let s = origin.as_str();
            assert_eq!(origin.to_string(), s);
            assert_eq!(SupplementOrigin::from_str(s).expect("parse"), origin);

            let json = serde_json::to_string(&origin).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let deserialized: SupplementOrigin = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(deserialized, origin);
        }

        assert!(" chat ".parse::<SupplementOrigin>().is_ok());
        assert!("scheduled".parse::<SupplementOrigin>().is_ok());
        assert!(matches!(
            "unknown".parse::<SupplementOrigin>(),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn trim_supplements_enforces_per_session_and_global_limits() {
        let mut store = SupplementStore::default();
        for i in 0..210 {
            store.turns.push(CapturedTranscriptTurn {
                source: ProviderId::Claude,
                session_id: "session-1".to_owned(),
                turn_id: format!("turn-{i}"),
                completed_at: i as i64,
                text: "sample".to_owned(),
                origin: SupplementOrigin::Chat,
            });
        }
        trim_supplements(&mut store);
        assert_eq!(store.turns.len(), MAX_SUPPLEMENT_TURNS_PER_SESSION);
        assert_eq!(store.turns.first().unwrap().completed_at, 10);
        assert_eq!(store.turns.last().unwrap().completed_at, 209);
    }

    #[test]
    fn cap_supplement_text_respects_char_boundary_and_limit() {
        let short = "짧은 텍스트".to_owned();
        assert_eq!(cap_supplement_text(short.clone()), short);

        let long = "한글".repeat(MAX_SUPPLEMENT_TEXT_BYTES / 6 + 10);
        let capped = cap_supplement_text(long);
        assert!(capped.contains("[Agent Manager 보관 한도에 따라 일부 생략됨]"));
    }
}
