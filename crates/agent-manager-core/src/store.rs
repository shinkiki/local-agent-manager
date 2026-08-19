use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs4::FileExt;
use serde::{Deserialize, Serialize};

use crate::chat::{ChatApprovalMode, ChatMode, ReasoningEffort};
use crate::domain::{
    DocFile, DocRoot, DocRootStatus, FileNode, ProviderId, SessionFolder, SessionMeta,
    SessionMetaPatch, SupplementStorageStats,
};
use crate::{linked_file, CoreError, LinkedFile, LinkedFileDownload};

const STORE_FILE_NAME: &str = "manager-state.json";
const SUPPLEMENT_STORE_FILE_NAME: &str = "session-supplements-v2.json";
const SUPPLEMENT_LOCK_FILE_NAME: &str = "session-supplements-v2.lock";
const MAX_DOC_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 10_000;
const MAX_SUPPLEMENT_TEXT_BYTES: usize = 256 * 1024;
const MAX_SUPPLEMENT_TURNS: usize = 4_000;
const MAX_SUPPLEMENT_TURNS_PER_SESSION: usize = 200;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppMetadata {
    #[serde(default)]
    pub sessions: HashMap<String, SessionMeta>,
    #[serde(default)]
    pub folders: Vec<SessionFolder>,
    #[serde(default)]
    pub doc_roots: Vec<DocRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SupplementOrigin {
    Chat,
    Scheduled,
}

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
    let path = app_data_dir.join(STORE_FILE_NAME);
    if !path.is_file() {
        return Ok(AppMetadata::default());
    }
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(CoreError::Json)
}

fn save_metadata(app_data_dir: &Path, metadata: &AppMetadata) -> Result<(), CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(STORE_FILE_NAME);
    let text = serde_json::to_string_pretty(metadata)?;
    fs::write(path, text)?;
    Ok(())
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
        .map(|turn| format!("{}:{}", turn.source.as_str(), turn.session_id))
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
    let path = app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME);
    if !path.is_file() {
        return Ok(SupplementStore::default());
    }
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(CoreError::Json)
}

fn with_supplement_store<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut SupplementStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let lock_path = app_data_dir.join(SUPPLEMENT_LOCK_FILE_NAME);
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)?;
    lock.lock().map_err(|error| {
        CoreError::Runtime(format!("보완 저장소 잠금을 얻지 못했습니다: {error}"))
    })?;
    let result = (|| {
        let mut store = load_supplement_store(app_data_dir)?;
        let value = action(&mut store)?;
        let text = serde_json::to_string_pretty(&store)?;
        fs::write(app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME), text)?;
        Ok(value)
    })();
    let _ = FileExt::unlock(&lock);
    result
}

fn cap_supplement_text(text: String) -> String {
    let text = text.trim().to_owned();
    if text.len() <= MAX_SUPPLEMENT_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_SUPPLEMENT_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n[Agent Manager 보관 한도에 따라 일부 생략됨]",
        &text[..end]
    )
}

fn trim_supplements(store: &mut SupplementStore) {
    store.turns.sort_by_key(|turn| turn.completed_at);
    let mut per_session = HashMap::<(ProviderId, String), usize>::new();
    store.turns.reverse();
    store.turns.retain(|turn| {
        let count = per_session
            .entry((turn.source, turn.session_id.clone()))
            .or_default();
        *count += 1;
        *count <= MAX_SUPPLEMENT_TURNS_PER_SESSION
    });
    store.turns.reverse();
    if store.turns.len() > MAX_SUPPLEMENT_TURNS {
        let excess = store.turns.len() - MAX_SUPPLEMENT_TURNS;
        store.turns.drain(0..excess);
    }
}

pub fn update_session_meta(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    patch: SessionMetaPatch,
) -> Result<SessionMeta, CoreError> {
    validate_identifier(session_id)?;
    let mut metadata = load_metadata(app_data_dir)?;
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
    let key = format!("{}:{session_id}", source.as_str());
    let current = metadata.sessions.entry(key).or_default();
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
    let result = current.clone();
    save_metadata(app_data_dir, &metadata)?;
    Ok(result)
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
    validate_identifier(session_id)?;
    let mut metadata = load_metadata(app_data_dir)?;
    let key = format!("{}:{session_id}", source.as_str());
    let current = metadata.sessions.entry(key).or_default();
    if current.reasoning_effort == effort
        && current.mode == Some(mode)
        && current.approval_mode == Some(approval_mode)
    {
        return Ok(());
    }
    current.reasoning_effort = effort;
    current.mode = Some(mode);
    current.approval_mode = Some(approval_mode);
    save_metadata(app_data_dir, &metadata)
}

/// 새 세션을 만든 계정을 최초 한 번만 기록한다. 재개나 활성계정 전환으로 덮어쓰지 않는다.
pub(crate) fn persist_session_creation_account_id(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    account_id: Option<&str>,
) -> Result<(), CoreError> {
    let Some(account_id) = account_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    validate_identifier(session_id)?;
    validate_identifier(account_id)?;
    let mut metadata = load_metadata(app_data_dir)?;
    let key = format!("{}:{session_id}", source.as_str());
    let current = metadata.sessions.entry(key).or_default();
    if current.creation_account_id.is_some() {
        return Ok(());
    }
    current.creation_account_id = Some(account_id.to_owned());
    save_metadata(app_data_dir, &metadata)
}

pub fn list_session_folders(app_data_dir: &Path) -> Result<Vec<SessionFolder>, CoreError> {
    let metadata = load_metadata(app_data_dir)?;
    Ok(folders_with_counts(&metadata))
}

pub fn create_session_folder(
    app_data_dir: &Path,
    name: &str,
    color: &str,
) -> Result<SessionFolder, CoreError> {
    let mut metadata = load_metadata(app_data_dir)?;
    let name = validate_folder_name(name)?;
    let color = validate_folder_color(color)?;
    let sort_order = metadata
        .folders
        .iter()
        .map(|folder| folder.sort_order)
        .max()
        .unwrap_or(-1)
        + 1;
    let folder = SessionFolder {
        id: new_folder_id(&metadata),
        name,
        color,
        sort_order,
        parent_id: None,
        session_count: 0,
    };
    metadata.folders.push(folder.clone());
    save_metadata(app_data_dir, &metadata)?;
    Ok(folder)
}

pub fn update_session_folder(
    app_data_dir: &Path,
    id: &str,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<SessionFolder, CoreError> {
    let mut metadata = load_metadata(app_data_dir)?;
    let folder = metadata
        .folders
        .iter_mut()
        .find(|folder| folder.id == id)
        .ok_or_else(|| CoreError::NotFound("세션 폴더를 찾을 수 없습니다".to_owned()))?;
    if let Some(name) = name {
        folder.name = validate_folder_name(name)?;
    }
    if let Some(color) = color {
        folder.color = validate_folder_color(color)?;
    }
    let result = folder.clone();
    save_metadata(app_data_dir, &metadata)?;
    Ok(result)
}

pub fn delete_session_folder(app_data_dir: &Path, id: &str) -> Result<(), CoreError> {
    let mut metadata = load_metadata(app_data_dir)?;
    let previous = metadata.folders.len();
    metadata.folders.retain(|folder| folder.id != id);
    if metadata.folders.len() == previous {
        return Err(CoreError::NotFound(
            "세션 폴더를 찾을 수 없습니다".to_owned(),
        ));
    }
    for folder in &mut metadata.folders {
        if folder.parent_id.as_deref() == Some(id) {
            folder.parent_id = None;
        }
    }
    for session in metadata.sessions.values_mut() {
        session.folder_ids.retain(|folder_id| folder_id != id);
    }
    save_metadata(app_data_dir, &metadata)
}

pub(crate) fn folders_with_counts(metadata: &AppMetadata) -> Vec<SessionFolder> {
    let mut folders = metadata.folders.clone();
    let mut counts = HashMap::<&str, usize>::new();
    for session in metadata.sessions.values() {
        for folder_id in &session.folder_ids {
            *counts.entry(folder_id).or_default() += 1;
        }
    }
    for folder in &mut folders {
        folder.session_count = counts.get(folder.id.as_str()).copied().unwrap_or(0);
    }
    folders.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    folders
}

pub fn list_doc_roots(app_data_dir: &Path) -> Result<Vec<DocRootStatus>, CoreError> {
    Ok(load_metadata(app_data_dir)?
        .doc_roots
        .into_iter()
        .map(|root| DocRootStatus {
            exists: Path::new(&root.path).is_dir(),
            root,
        })
        .collect())
}

pub fn add_doc_root(
    app_data_dir: &Path,
    name: &str,
    path: &str,
) -> Result<DocRootStatus, CoreError> {
    let canonical = fs::canonicalize(path)?;
    if !canonical.is_dir() {
        return Err(CoreError::InvalidInput(
            "문서 루트는 폴더여야 합니다".to_owned(),
        ));
    }
    let canonical_text = canonical.to_string_lossy().into_owned();
    let mut metadata = load_metadata(app_data_dir)?;
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
    save_metadata(app_data_dir, &metadata)?;
    Ok(DocRootStatus { root, exists: true })
}

pub fn remove_doc_root(app_data_dir: &Path, id: &str) -> Result<(), CoreError> {
    let mut metadata = load_metadata(app_data_dir)?;
    let previous = metadata.doc_roots.len();
    metadata.doc_roots.retain(|root| root.id != id);
    if metadata.doc_roots.len() == previous {
        return Err(CoreError::NotFound(
            "문서 폴더를 찾을 수 없습니다".to_owned(),
        ));
    }
    save_metadata(app_data_dir, &metadata)
}

pub fn list_doc_tree(app_data_dir: &Path, root_id: &str) -> Result<Vec<FileNode>, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let mut remaining = MAX_TREE_ENTRIES;
    build_doc_nodes(&root, &root, &mut remaining)
}

pub fn read_doc(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
) -> Result<DocFile, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let path = resolve_doc_path(&root, relative_path, true)?;
    validate_markdown_file(&path)?;
    let file_metadata = fs::metadata(&path)?;
    if file_metadata.len() > MAX_DOC_BYTES {
        return Err(CoreError::TooLarge(MAX_DOC_BYTES));
    }
    Ok(DocFile {
        root_id: root_id.to_owned(),
        relative_path: normalized_relative(&root, &path)?,
        content: fs::read_to_string(path)?,
        modified_at: modified_ms(&file_metadata),
        size_bytes: file_metadata.len(),
    })
}

pub fn read_doc_linked_file(
    app_data_dir: &Path,
    root_id: &str,
    current_path: &str,
    href: &str,
) -> Result<LinkedFile, CoreError> {
    let doc_root = resolve_root(app_data_dir, root_id)?;
    let current_doc = resolve_doc_path(&doc_root, current_path, true)?;
    validate_markdown_file(&current_doc)?;
    let workspace_root = nearest_repository_root(&doc_root).unwrap_or(&doc_root);
    let current_dir = current_doc.parent().ok_or_else(|| {
        CoreError::InvalidInput("현재 문서의 기준 경로를 확인할 수 없습니다".to_owned())
    })?;

    match linked_file::read_linked_file_from(workspace_root, current_dir, href) {
        Err(CoreError::NotFound(_)) if current_dir != workspace_root => {
            linked_file::read_linked_file(workspace_root, href)
        }
        result => result,
    }
}

pub fn read_doc_linked_file_download(
    app_data_dir: &Path,
    root_id: &str,
    current_path: &str,
    href: &str,
) -> Result<LinkedFileDownload, CoreError> {
    let doc_root = resolve_root(app_data_dir, root_id)?;
    let current_doc = resolve_doc_path(&doc_root, current_path, true)?;
    validate_markdown_file(&current_doc)?;
    let workspace_root = nearest_repository_root(&doc_root).unwrap_or(&doc_root);
    let current_dir = current_doc.parent().ok_or_else(|| {
        CoreError::InvalidInput("현재 문서의 기준 경로를 확인할 수 없습니다".to_owned())
    })?;

    match linked_file::read_linked_file_download_from(workspace_root, current_dir, href) {
        Err(CoreError::NotFound(_)) if current_dir != workspace_root => {
            linked_file::read_linked_file_download(workspace_root, href)
        }
        result => result,
    }
}

fn nearest_repository_root(path: &Path) -> Option<&Path> {
    path.ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
}

pub fn save_doc(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
    content: &str,
    expected_modified_at: Option<i64>,
) -> Result<DocFile, CoreError> {
    if content.len() as u64 > MAX_DOC_BYTES {
        return Err(CoreError::TooLarge(MAX_DOC_BYTES));
    }
    let root = resolve_root(app_data_dir, root_id)?;
    let path = resolve_doc_path(&root, relative_path, false)?;
    validate_markdown_file(&path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        let parent_real = fs::canonicalize(parent)?;
        if !parent_real.starts_with(&root) {
            return Err(CoreError::InvalidInput(
                "허용된 경로를 벗어났습니다".to_owned(),
            ));
        }
    }
    if let (Some(expected), Ok(current)) = (expected_modified_at, fs::metadata(&path)) {
        if modified_ms(&current) != expected {
            return Err(CoreError::Conflict(
                "다른 프로그램에서 문서가 변경되었습니다. 다시 불러온 뒤 저장하세요.".to_owned(),
            ));
        }
    }
    fs::write(&path, content)?;
    read_doc(app_data_dir, root_id, relative_path)
}

fn resolve_root(app_data_dir: &Path, root_id: &str) -> Result<PathBuf, CoreError> {
    let metadata = load_metadata(app_data_dir)?;
    let root = metadata
        .doc_roots
        .into_iter()
        .find(|root| root.id == root_id)
        .ok_or_else(|| CoreError::NotFound("문서 폴더를 찾을 수 없습니다".to_owned()))?;
    let canonical = fs::canonicalize(root.path)?;
    if !canonical.is_dir() {
        return Err(CoreError::NotFound(
            "문서 폴더 경로가 존재하지 않습니다".to_owned(),
        ));
    }
    Ok(canonical)
}

fn build_doc_nodes(
    root: &Path,
    parent: &Path,
    remaining: &mut usize,
) -> Result<Vec<FileNode>, CoreError> {
    if *remaining == 0 {
        return Ok(Vec::new());
    }
    let mut nodes = Vec::new();
    for entry in fs::read_dir(parent)?.flatten() {
        if *remaining == 0 {
            break;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || entry.file_name().to_string_lossy().starts_with('.')
        {
            continue;
        }
        if metadata.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                != Some("md".to_owned())
        {
            continue;
        }
        if !metadata.is_dir() && !metadata.is_file() {
            continue;
        }
        *remaining -= 1;
        let mut children = if metadata.is_dir() {
            build_doc_nodes(root, &path, remaining)?
        } else {
            Vec::new()
        };
        if metadata.is_dir() && children.is_empty() {
            continue;
        }
        children.sort_by(node_order);
        nodes.push(FileNode {
            name: entry.file_name().to_string_lossy().into_owned(),
            relative_path: normalized_relative(root, &path)?,
            size_bytes: metadata.len(),
            is_directory: metadata.is_dir(),
            children,
        });
    }
    nodes.sort_by(node_order);
    Ok(nodes)
}

fn node_order(left: &FileNode, right: &FileNode) -> std::cmp::Ordering {
    right
        .is_directory
        .cmp(&left.is_directory)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
}

fn resolve_doc_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, CoreError> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CoreError::InvalidInput(
            "허용된 경로를 벗어났습니다".to_owned(),
        ));
    }
    let joined = root.join(relative);
    let path = if must_exist {
        fs::canonicalize(joined)?
    } else {
        joined
    };
    if path != root && !path.starts_with(root) {
        return Err(CoreError::InvalidInput(
            "허용된 경로를 벗어났습니다".to_owned(),
        ));
    }
    Ok(path)
}

fn validate_markdown_file(path: &Path) -> Result<(), CoreError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != Some("md".to_owned())
    {
        return Err(CoreError::InvalidInput(
            "Markdown(.md) 문서만 허용됩니다".to_owned(),
        ));
    }
    Ok(())
}

fn normalized_relative(root: &Path, path: &Path) -> Result<String, CoreError> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| CoreError::InvalidInput("허용된 경로를 벗어났습니다".to_owned()))
}

fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_millis()).ok())
        .unwrap_or(0)
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().chars().take(20_000).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn validate_folder_name(value: &str) -> Result<String, CoreError> {
    let name = value.trim();
    if name.is_empty() {
        return Err(CoreError::InvalidInput("폴더 이름을 입력하세요".to_owned()));
    }
    if name.chars().count() > 80 {
        return Err(CoreError::InvalidInput(
            "폴더 이름은 80자 이하여야 합니다".to_owned(),
        ));
    }
    Ok(name.to_owned())
}

fn validate_folder_color(value: &str) -> Result<String, CoreError> {
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(CoreError::InvalidInput(
            "폴더 색상은 #RRGGBB 형식이어야 합니다".to_owned(),
        ))
    }
}

fn new_folder_id(metadata: &AppMetadata) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut suffix = metadata.folders.len();
    loop {
        let candidate = format!("folder-{nanos:x}-{suffix:x}");
        if metadata.folders.iter().all(|folder| folder.id != candidate) {
            return candidate;
        }
        suffix += 1;
    }
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

fn stable_id(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("root-{hash:016x}")
}

fn is_agent_data_path(path: &Path) -> bool {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    home.is_some_and(|home| {
        [".claude", ".codex", ".gemini"]
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
    fn document_path_rejects_parent_traversal() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        assert!(resolve_doc_path(temp.path(), "../secret.md", false).is_err());
    }

    #[test]
    fn registered_doc_root_reads_linked_utf8_source_files() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        let docs = project.join("context");
        fs::create_dir_all(project.join(".git")).expect("repository marker must exist");
        fs::create_dir_all(docs.join("agent")).expect("document directory must exist");
        fs::write(docs.join("agent/change-request.md"), "# Change request\n")
            .expect("current document must exist");
        fs::write(
            project.join("Application.java"),
            "첫째 줄\npublic class Application {}\n",
        )
        .expect("source file must exist");
        let root = add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref())
            .expect("doc root must register");

        let linked = read_doc_linked_file(
            &app_data,
            &root.root.id,
            "agent/change-request.md",
            "Application.java#L2",
        )
        .expect("project-relative linked source must load");

        assert_eq!(linked.relative_path, "Application.java");
        assert_eq!(linked.target_line, Some(2));
        assert!(linked.content.contains("public class"));
    }

    #[test]
    fn folder_assignment_survives_reload_and_delete_cleans_sessions() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let folder =
            create_session_folder(temp.path(), "검토", "#51e97d").expect("folder must be created");
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
}
