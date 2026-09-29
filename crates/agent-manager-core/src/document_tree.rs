//! 등록된 문서 루트 안의 파일 트리를 읽고 쓰는 한 곳.
//!
//! `store`는 Agent Manager 소유 메타데이터(세션 메타·정리폴더·문서 루트 등록·프로젝트
//! 활성)를 다루는 모듈인데, 그 등록을 실제 파일시스템으로 풀어내는 계층까지 같은 파일에
//! 얹혀 2900줄을 넘어섰다. 두 계층은 쓰는 것이 다르다 — 메타데이터 쪽은 저장 잠금과
//! JSON 스키마를, 문서 트리 쪽은 경로 경계·페이지 창·미리보기 판별을 본다. 잠금 아래에서
//! 읽는 것은 루트 등록 조회(`resolve_root`) 한 곳뿐이라 경계가 이미 얇았다.
//!
//! 그래서 문서 트리 계층만 여기로 옮긴다. 옮긴 것은 자리뿐이고 동작은 그대로다. 문서
//! 루트의 등록·해제와 보호 경계 판정(`store::is_restricted_doc_root`)은 메타데이터
//! 쪽 일이라 `store`에 남는다. 호출부는 `crate::` 재내보내기로 들어오므로 경로도
//! 그대로다([`crate::store`]가 같은 이름을 다시 내보낸다).

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::domain::{
    DocFile, DocumentEntry, DocumentEntryPage, DocumentFile, DocumentPreviewKind, FileNode,
};
use crate::path_guard::{self, CurDirPolicy, RelativePathIssue};
use crate::store::{is_restricted_doc_root, load_metadata};
use crate::{linked_file, CoreError, LinkedFile, LinkedFileDownload, LinkedFileSource};

const MAX_DOC_BYTES: u64 = 5 * 1024 * 1024;
const MAX_DOCUMENT_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_DOCUMENT_PAGE_SIZE: usize = 200;
const MAX_DOCUMENT_PAGE_SIZE: usize = 500;
const MAX_TREE_ENTRIES: usize = 10_000;

pub fn list_doc_tree(app_data_dir: &Path, root_id: &str) -> Result<Vec<FileNode>, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let mut remaining = MAX_TREE_ENTRIES;
    build_doc_nodes(&root, &root, &mut remaining)
}

/// 등록된 문서 루트의 한 폴더를 페이지 단위로 읽는다. 숨김 항목과 심볼릭 링크는
/// AIA 직접 작업공간 경계와 별개로 문서 목록·검색·변경 감지에서는 노출하지 않는다.
pub fn list_document_entries(
    app_data_dir: &Path,
    root_id: &str,
    parent_path: &str,
    cursor: Option<&str>,
    limit: Option<usize>,
) -> Result<DocumentEntryPage, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let parent = if parent_path.trim().is_empty() {
        root.clone()
    } else {
        resolve_doc_path(&root, parent_path, true)?
    };
    if !parent.is_dir() {
        return Err(CoreError::InvalidInput(
            "파일 목록 기준 경로가 폴더가 아닙니다".to_owned(),
        ));
    }
    let (offset, limit) = document_page_window(cursor, limit)?;
    let mut entries = read_document_directory(&root, &parent)?;
    sort_document_entries(&mut entries, |entry| &entry.name);
    Ok(document_entry_page(entries, offset, limit))
}

pub fn search_document_entries(
    app_data_dir: &Path,
    root_id: &str,
    query: &str,
    cursor: Option<&str>,
    limit: Option<usize>,
) -> Result<DocumentEntryPage, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return list_document_entries(app_data_dir, root_id, "", cursor, limit);
    }
    let (offset, limit) = document_page_window(cursor, limit)?;
    let mut entries = Vec::new();
    collect_document_entries(&root, &root, &query, &mut entries)?;
    sort_document_entries(&mut entries, |entry| &entry.relative_path);
    Ok(document_entry_page(entries, offset, limit))
}

pub fn read_document_file(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
) -> Result<DocumentFile, CoreError> {
    let (root, path) = resolve_root_entry(app_data_dir, root_id, relative_path, true)?;
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "선택한 항목이 일반 파일이 아닙니다".to_owned(),
        ));
    }
    let relative_path = normalized_relative(&root, &path)?;
    let (kind, content) = match preview_kind_for_path(&path, &metadata)? {
        // 트리 스캔은 앞 8KB 표본만 보고 텍스트라 판정하므로(qa50), 뒤쪽이 바이너리인
        // 파일은 본문을 읽어야만 드러난다. 그때 오류를 내지 않고 바이너리로 내려
        // 프런트가 다운로드 분기를 그대로 타게 한다.
        kind @ (DocumentPreviewKind::Markdown | DocumentPreviewKind::Text) => {
            match read_document_text(&path)? {
                Some(content) => (kind, Some(content)),
                None => (DocumentPreviewKind::Binary, None),
            }
        }
        kind @ (DocumentPreviewKind::Binary | DocumentPreviewKind::TooLarge) => (kind, None),
    };
    Ok(DocumentFile {
        root_id: root_id.to_owned(),
        relative_path,
        kind,
        content,
        modified_at: modified_ms(&metadata),
        size_bytes: metadata.len(),
        downloadable: metadata.len() <= MAX_DOCUMENT_DOWNLOAD_BYTES,
    })
}

pub fn read_document_file_download(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
) -> Result<LinkedFileDownload, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    linked_file::read_linked_file_download_within(
        &root,
        &root,
        relative_path,
        MAX_DOCUMENT_DOWNLOAD_BYTES,
    )
}

/// 문서 파일을 읽지 않고 자리만 확인한다. 내려받기를 데스크톱 셸에서 이어 복사로
/// 처리하는 경로가 쓴다 — 바이트가 메모리를 지나지 않으므로
/// [`MAX_DOCUMENT_DOWNLOAD_BYTES`]가 막던 크기 제한이 여기에는 없다.
pub fn read_document_file_source(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
) -> Result<LinkedFileSource, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    linked_file::read_linked_file_source_from(&root, &root, relative_path, u64::MAX)
}

/// 문서 안 링크가 가리키는 파일의 자리만 확인한다. 링크 해석 규칙은 미리보기·내려받기와
/// 같은 [`read_doc_link`]를 지난다.
pub fn read_doc_linked_file_source(
    app_data_dir: &Path,
    root_id: &str,
    current_path: &str,
    href: &str,
) -> Result<LinkedFileSource, CoreError> {
    read_doc_link(
        app_data_dir,
        root_id,
        current_path,
        href,
        |root, base, href| linked_file::read_linked_file_source_from(root, base, href, u64::MAX),
    )
}

pub fn read_doc(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
) -> Result<DocFile, CoreError> {
    let (root, path) = resolve_root_entry(app_data_dir, root_id, relative_path, true)?;
    validate_markdown_file(&path)?;
    let file_metadata = fs::metadata(&path)?;
    ensure_doc_size(file_metadata.len())?;
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
    read_doc_link(
        app_data_dir,
        root_id,
        current_path,
        href,
        linked_file::read_linked_file_from,
    )
}

pub fn read_doc_linked_file_download(
    app_data_dir: &Path,
    root_id: &str,
    current_path: &str,
    href: &str,
) -> Result<LinkedFileDownload, CoreError> {
    read_doc_link(
        app_data_dir,
        root_id,
        current_path,
        href,
        linked_file::read_linked_file_download_from,
    )
}

/// 문서 미리보기와 내려받기가 공유하는 상대 링크 해석. 현재 문서가 있는 폴더를
/// 기준으로 먼저 찾고, 거기서 못 찾으면 작업공간 루트 기준으로 한 번 더 찾는다.
/// 루트 기준 재시도는 `read`에 base로 루트를 그대로 넘겨 표현한다.
fn read_doc_link<T>(
    app_data_dir: &Path,
    root_id: &str,
    current_path: &str,
    href: &str,
    read: impl Fn(&Path, &Path, &str) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let (doc_root, current_doc) = resolve_root_entry(app_data_dir, root_id, current_path, true)?;
    validate_markdown_file(&current_doc)?;
    let workspace_root = nearest_repository_root(&doc_root).unwrap_or(&doc_root);
    let current_dir = current_doc.parent().ok_or_else(|| {
        CoreError::InvalidInput("현재 파일의 기준 경로를 확인할 수 없습니다".to_owned())
    })?;

    match read(workspace_root, current_dir, href) {
        Err(CoreError::NotFound(_)) if current_dir != workspace_root => {
            read(workspace_root, workspace_root, href)
        }
        result => result,
    }
}

fn nearest_repository_root(path: &Path) -> Option<&Path> {
    path.ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
}

/// 새 문서 전용 입구. **이미 있는 경로는 절대 덮어쓰지 않는다.**
///
/// QA #65 — 새 문서 만들기는 `save_doc`을 `expected_modified_at: None`으로 불렀다. 그 값은
/// "변경 검사를 하지 않는다"는 뜻이라, 같은 이름의 문서가 이미 있으면 아무 확인 없이 본문이
/// `# 새 문서` 한 줄로 날아갔다. 만들기와 저장은 다른 계약이므로 입구를 나눈다. 존재 검사와
/// 쓰기 사이의 틈이 없도록 `create_new`로 연다 — 먼저 `exists()`를 보고 쓰면 그 사이에 생긴
/// 파일을 다시 덮어쓴다.
pub fn create_doc(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
    content: &str,
) -> Result<DocFile, CoreError> {
    ensure_doc_size(content.len() as u64)?;
    let (root, path) = resolve_root_entry(app_data_dir, root_id, relative_path, false)?;
    validate_markdown_file(&path)?;
    prepare_doc_parent(&root, &path)?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(content.as_bytes())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(CoreError::Conflict(
                "같은 이름의 파일이 이미 있습니다. 다른 이름을 쓰거나 그 파일을 열어 편집하세요."
                    .to_owned(),
            ));
        }
        Err(error) => return Err(error.into()),
    }
    read_doc(app_data_dir, root_id, relative_path)
}

/// 저장·생성이 함께 쓰는 준비. 상위 폴더를 만들고, 그 실체가 등록 폴더 밖으로 새지 않는지 본다.
fn prepare_doc_parent(root: &Path, path: &Path) -> Result<(), CoreError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)?;
    let parent_real = fs::canonicalize(parent)?;
    if !parent_real.starts_with(root) {
        return Err(path_outside_root());
    }
    Ok(())
}

pub fn save_doc(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
    content: &str,
    expected_modified_at: Option<i64>,
) -> Result<DocFile, CoreError> {
    ensure_doc_size(content.len() as u64)?;
    let (root, path) = resolve_root_entry(app_data_dir, root_id, relative_path, false)?;
    validate_markdown_file(&path)?;
    prepare_doc_parent(&root, &path)?;
    if let (Some(expected), Ok(current)) = (expected_modified_at, fs::metadata(&path)) {
        if modified_ms(&current) != expected {
            return Err(CoreError::Conflict(
                "다른 프로그램에서 파일이 변경되었습니다. 다시 불러온 뒤 저장하세요.".to_owned(),
            ));
        }
    }
    fs::write(&path, content)?;
    read_doc(app_data_dir, root_id, relative_path)
}

/// 읽기·생성·저장이 공유하는 Markdown 본문 크기 상한.
fn ensure_doc_size(size_bytes: u64) -> Result<(), CoreError> {
    if size_bytes > MAX_DOC_BYTES {
        return Err(CoreError::TooLarge(MAX_DOC_BYTES));
    }
    Ok(())
}

/// 문서 루트를 열고 그 안의 상대 경로까지 해석하는 진입점 공통 준비. 진입점마다 두 줄로
/// 펼쳐 두면 루트 검사와 경로 검사 중 하나만 빠뜨려도 컴파일은 지나가므로 한 벌로 묶는다.
fn resolve_root_entry(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
    must_exist: bool,
) -> Result<(PathBuf, PathBuf), CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let path = resolve_doc_path(&root, relative_path, must_exist)?;
    Ok((root, path))
}

fn resolve_root(app_data_dir: &Path, root_id: &str) -> Result<PathBuf, CoreError> {
    let metadata = load_metadata(app_data_dir)?;
    let root = metadata
        .doc_roots
        .into_iter()
        .find(|root| root.id == root_id)
        .ok_or_else(|| CoreError::NotFound("등록 폴더를 찾을 수 없습니다".to_owned()))?;
    let canonical = fs::canonicalize(root.path)?;
    if !canonical.is_dir() {
        return Err(CoreError::NotFound(
            "등록 폴더 경로가 존재하지 않습니다".to_owned(),
        ));
    }
    if is_restricted_doc_root(app_data_dir, &canonical) {
        return Err(CoreError::InvalidInput(
            "보호된 경로와 겹치는 등록 폴더에는 접근할 수 없습니다".to_owned(),
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
        if is_hidden_document_child(&entry.file_name().to_string_lossy(), &metadata) {
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

fn document_cursor_offset(cursor: Option<&str>) -> Result<usize, CoreError> {
    match cursor.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(0),
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| CoreError::InvalidInput("파일 목록 커서가 올바르지 않습니다".to_owned())),
    }
}

/// 문서 목록·검색이 공유하는 페이지 창. 커서는 항목을 읽기 전에 해석해,
/// 잘못된 커서가 디렉터리 오류에 가려지지 않게 한다.
pub(crate) fn document_page_window(
    cursor: Option<&str>,
    limit: Option<usize>,
) -> Result<(usize, usize), CoreError> {
    Ok((
        document_cursor_offset(cursor)?,
        limit
            .unwrap_or(DEFAULT_DOCUMENT_PAGE_SIZE)
            .clamp(1, MAX_DOCUMENT_PAGE_SIZE),
    ))
}

/// 정렬이 끝난 항목을 한 페이지로 자르고 다음 커서를 붙인다. 정렬 기준은 목록과
/// 검색이 서로 달라 호출부에 남긴다.
pub(crate) fn document_entry_page(
    entries: Vec<DocumentEntry>,
    offset: usize,
    limit: usize,
) -> DocumentEntryPage {
    let total = entries.len();
    let page = entries
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next = offset.saturating_add(page.len());
    DocumentEntryPage {
        entries: page,
        next_cursor: (next < total).then(|| next.to_string()),
        total,
    }
}

/// 문서 목록·검색이 공유하는 폴더 훑기. 숨김 항목, 심볼릭 링크, 폴더도 파일도
/// 아닌 항목은 여기서 한 번에 걸러 두 경로가 같은 것을 본다는 것을 보장한다.
fn visible_document_children(parent: &Path) -> Result<Vec<(PathBuf, fs::Metadata)>, CoreError> {
    let mut children = Vec::new();
    for item in fs::read_dir(parent)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        // 숨김 이름은 상태 조회 없이 먼저 걸러 낸다. 나머지 판정은 트리 훑기와 같은 자리를 쓴다.
        if name.starts_with('.') {
            continue;
        }
        let path = item.path();
        let metadata = fs::symlink_metadata(&path)?;
        if is_hidden_document_child(&name, &metadata) {
            continue;
        }
        children.push((path, metadata));
    }
    Ok(children)
}

/// 문서 트리·목록·검색이 함께 감추는 항목: 숨김 이름, 심볼릭 링크, 그리고 폴더도 파일도
/// 아닌 것(소켓·장치 등). 판정이 경로마다 따로 적혀 있으면 트리에는 뜨는데 목록에는
/// 없는 항목이 생기므로 한 자리에만 둔다.
fn is_hidden_document_child(name: &str, metadata: &fs::Metadata) -> bool {
    name.starts_with('.')
        || metadata.file_type().is_symlink()
        || (!metadata.is_dir() && !metadata.is_file())
}

/// 폴더를 앞세우고 주어진 키를 대소문자 구분 없이 견주는 문서 목록 정렬. 목록은
/// 이름을, 검색은 상대 경로를 키로 쓴다.
fn sort_document_entries(entries: &mut [DocumentEntry], key: fn(&DocumentEntry) -> &str) {
    entries.sort_by(|left, right| {
        directory_first_order(
            (left.is_directory, key(left)),
            (right.is_directory, key(right)),
        )
    });
}

/// 문서 트리와 목록이 함께 쓰는 차례: 폴더가 먼저고, 같은 종류끼리는 주어진 키를
/// 대소문자 구분 없이 견준다. 비교가 두 벌로 적혀 있으면 한쪽만 고쳐도 같은 폴더가
/// 트리와 목록에서 다른 자리에 놓이므로 이 자리 하나만 둔다.
pub(crate) fn directory_first_order(left: (bool, &str), right: (bool, &str)) -> std::cmp::Ordering {
    right
        .0
        .cmp(&left.0)
        .then_with(|| left.1.to_lowercase().cmp(&right.1.to_lowercase()))
}

fn read_document_directory(root: &Path, parent: &Path) -> Result<Vec<DocumentEntry>, CoreError> {
    visible_document_children(parent)?
        .iter()
        .map(|(path, metadata)| document_entry(root, path, metadata))
        .collect()
}

fn collect_document_entries(
    root: &Path,
    parent: &Path,
    query: &str,
    entries: &mut Vec<DocumentEntry>,
) -> Result<(), CoreError> {
    for (path, metadata) in visible_document_children(parent)? {
        let entry = document_entry(root, &path, &metadata)?;
        if entry.relative_path.to_lowercase().contains(query) {
            entries.push(entry);
        }
        if metadata.is_dir() {
            collect_document_entries(root, &path, query, entries)?;
        }
    }
    Ok(())
}

fn document_entry(
    root: &Path,
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<DocumentEntry, CoreError> {
    let relative_path = normalized_relative(root, path)?;
    let parent_path = path
        .parent()
        .and_then(|parent| normalized_relative(root, parent).ok())
        .unwrap_or_default();
    Ok(DocumentEntry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| relative_path.clone()),
        relative_path,
        parent_path,
        size_bytes: metadata.len(),
        modified_at: modified_ms(metadata),
        is_directory: metadata.is_dir(),
        preview_kind: metadata
            .is_file()
            .then(|| preview_kind_for_path(path, metadata))
            .transpose()?,
    })
}

/// 문서 본문을 UTF-8 텍스트로 읽는다. 표본 판정을 통과했더라도 뒤쪽에 잘못된 UTF-8이나
/// NUL 바이트가 있으면 `None`을 돌려 호출부가 바이너리로 격하하게 한다. 입출력 오류만 오류다.
pub(crate) fn read_document_text(path: &Path) -> Result<Option<String>, CoreError> {
    let bytes = fs::read(path)?;
    if bytes.contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

pub(crate) fn preview_kind_for_path(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<DocumentPreviewKind, CoreError> {
    if metadata.len() > MAX_DOC_BYTES {
        return Ok(DocumentPreviewKind::TooLarge);
    }
    if is_markdown_file(path) {
        return Ok(DocumentPreviewKind::Markdown);
    }
    // OneDrive 같은 온디맨드 자리표시자는 8KB만 읽으려 해도 여는 순간 파일 전체가
    // 내려받아진다. 목록과 검색은 폴더를 훑기만 하는데도 이 표본 판정 때문에 5MB 이하
    // 파일을 모조리 로컬로 끌어와 디스크를 채운다. 그래서 자리표시자는 열지 않고
    // 확장자만으로 가르고, 본문을 정말 보여 줘야 하는 미리보기·다운로드에서만 내려받게
    // 남긴다 — 그때는 사용자가 그 파일 하나를 고른 것이다.
    if is_cloud_placeholder(metadata) {
        return Ok(if has_text_extension(path) {
            DocumentPreviewKind::Text
        } else {
            DocumentPreviewKind::Binary
        });
    }
    let mut sample = vec![0_u8; usize::try_from(metadata.len().min(8 * 1024)).unwrap_or(8 * 1024)];
    let read = File::open(path)?.read(&mut sample)?;
    sample.truncate(read);
    Ok(
        if std::str::from_utf8(&sample).is_ok() && !sample.contains(&0) {
            DocumentPreviewKind::Text
        } else {
            DocumentPreviewKind::Binary
        },
    )
}

fn node_order(left: &FileNode, right: &FileNode) -> std::cmp::Ordering {
    directory_first_order(
        (left.is_directory, &left.name),
        (right.is_directory, &right.name),
    )
}

fn resolve_doc_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, CoreError> {
    let relative = Path::new(relative);
    // 빈 경로는 루트 자체를 가리키는 정상 입력이라 그대로 통과시킨다.
    if !matches!(
        path_guard::classify_relative_path(relative, CurDirPolicy::Reject),
        None | Some(RelativePathIssue::Empty)
    ) {
        return Err(path_outside_root());
    }
    let joined = root.join(relative);
    let path = if must_exist {
        fs::canonicalize(joined)?
    } else {
        joined
    };
    if path != root && !path.starts_with(root) {
        return Err(path_outside_root());
    }
    Ok(path)
}

/// 문서 루트 경계 밖을 가리키는 모든 경로 판정이 공유하는 오류.
fn path_outside_root() -> CoreError {
    CoreError::InvalidInput("허용된 경로를 벗어났습니다".to_owned())
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        })
}

/// 표본을 읽지 않고도 텍스트로 볼 파일인지 확장자로 어림잡는다. 클라우드 자리표시자
/// 판정에만 쓴다 — 이미 내려받은 파일은 지금까지처럼 앞 8KB를 실제로 보고 가른다.
fn has_text_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "txt"
                    | "log"
                    | "csv"
                    | "tsv"
                    | "json"
                    | "jsonl"
                    | "yaml"
                    | "yml"
                    | "toml"
                    | "ini"
                    | "cfg"
                    | "conf"
                    | "env"
                    | "xml"
                    | "html"
                    | "htm"
                    | "css"
                    | "scss"
                    | "js"
                    | "jsx"
                    | "mjs"
                    | "cjs"
                    | "ts"
                    | "tsx"
                    | "rs"
                    | "py"
                    | "rb"
                    | "go"
                    | "java"
                    | "kt"
                    | "c"
                    | "h"
                    | "cpp"
                    | "hpp"
                    | "cs"
                    | "sh"
                    | "bash"
                    | "zsh"
                    | "ps1"
                    | "sql"
            )
        })
}

/// 클라우드 공급자가 자리만 남겨 둔 파일인지 본다. Windows는 파일 속성의 OFFLINE과
/// 두 RECALL 비트로 알 수 있고, 이 비트가 선 파일을 여는 것은 곧 내려받기다.
#[cfg(windows)]
fn is_cloud_placeholder(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

    metadata.file_attributes()
        & (FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_RECALL_ON_OPEN
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
        != 0
}

/// macOS의 iCloud 자리표시자는 별도 이름으로 보여 여는 것만으로 내려받지 않는다.
/// 알아볼 방법이 없는 플랫폼에서는 지금까지 하던 표본 판정을 그대로 둔다.
#[cfg(not(windows))]
fn is_cloud_placeholder(_metadata: &fs::Metadata) -> bool {
    false
}

fn validate_markdown_file(path: &Path) -> Result<(), CoreError> {
    if !is_markdown_file(path) {
        return Err(CoreError::InvalidInput(
            "Markdown(.md, .markdown) 파일만 허용됩니다".to_owned(),
        ));
    }
    Ok(())
}

fn normalized_relative(root: &Path, path: &Path) -> Result<String, CoreError> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| path_outside_root())
}

pub(crate) fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::add_doc_root;

    #[test]
    fn document_path_rejects_parent_traversal() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        assert!(resolve_doc_path(temp.path(), "../secret.md", false).is_err());
    }

    /// QA #65. 새 문서 만들기가 같은 이름의 문서를 조용히 덮어써 본문이 사라졌다.
    /// 생성 전용 입구는 이미 있는 경로를 거절하고 원본을 그대로 둔다.
    #[test]
    fn create_doc_refuses_an_existing_path_and_keeps_its_content() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let docs = temp.path().join("docs");
        fs::create_dir_all(&docs).expect("document directory must exist");
        let root = add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref(), false)
            .expect("doc root must register");
        let root_id = root.root.id;

        let created = create_doc(&app_data, &root_id, "메모-2.md", "# 새 문서\n")
            .expect("first create must succeed");
        assert_eq!(created.relative_path, "메모-2.md");
        save_doc(
            &app_data,
            &root_id,
            "메모-2.md",
            "# 지키고 싶은 본문\n",
            None,
        )
        .expect("save must succeed");

        let conflict = create_doc(&app_data, &root_id, "메모-2.md", "# 새 문서\n")
            .expect_err("an existing path must be refused");
        assert!(matches!(conflict, CoreError::Conflict(_)));
        assert_eq!(
            fs::read_to_string(docs.join("메모-2.md")).expect("read"),
            "# 지키고 싶은 본문\n",
            "거절된 만들기는 원본을 건드리지 않는다"
        );
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
        let root = add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref(), false)
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
    fn document_entries_include_all_normal_files_and_page_without_truncation() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let docs = temp.path().join("docs");
        fs::create_dir_all(docs.join("nested")).expect("document directory must exist");
        fs::write(docs.join("README.md"), "# 문서\n").expect("markdown file");
        fs::write(docs.join("app.rs"), "fn main() {}\n").expect("source file");
        fs::write(docs.join("archive"), [0_u8, 159, 146, 150]).expect("binary file");
        fs::write(docs.join(".secret"), "hidden").expect("hidden file");
        for index in 0..520 {
            fs::write(
                docs.join("nested").join(format!("file-{index:04}.txt")),
                "text",
            )
            .expect("paged file");
        }
        let root = add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref(), false)
            .expect("doc root must register");

        let top = list_document_entries(&app_data, &root.root.id, "", None, Some(200))
            .expect("top entries");
        assert_eq!(top.total, 4);
        assert!(top.entries.iter().any(|entry| {
            entry.name == "app.rs" && entry.preview_kind == Some(DocumentPreviewKind::Text)
        }));
        assert!(top.entries.iter().any(|entry| {
            entry.name == "archive" && entry.preview_kind == Some(DocumentPreviewKind::Binary)
        }));
        assert!(!top.entries.iter().any(|entry| entry.name == ".secret"));

        let first = list_document_entries(&app_data, &root.root.id, "nested", None, Some(500))
            .expect("first page");
        assert_eq!(first.entries.len(), 500);
        assert_eq!(first.total, 520);
        let second = list_document_entries(
            &app_data,
            &root.root.id,
            "nested",
            first.next_cursor.as_deref(),
            Some(500),
        )
        .expect("second page");
        assert_eq!(second.entries.len(), 20);
        assert!(second.next_cursor.is_none());
    }

    /// 내려받기 상한(100MB)은 바이트를 메모리에 올리는 경로만의 제약이다. 자리만
    /// 확인하는 경로는 같은 파일을 그대로 돌려줘야 데스크톱 셸이 이어 복사할 수 있다.
    #[test]
    fn document_source_resolves_files_the_buffered_download_refuses() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let docs = temp.path().join("docs");
        fs::create_dir_all(&docs).expect("document directory must exist");
        let huge = fs::File::create(docs.join("archive.zip")).expect("large file");
        huge.set_len(MAX_DOCUMENT_DOWNLOAD_BYTES + 1)
            .expect("large file length");
        let root = add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref(), false)
            .expect("doc root must register");

        assert!(
            !read_document_file(&app_data, &root.root.id, "archive.zip")
                .expect("file metadata")
                .downloadable
        );
        assert!(matches!(
            read_document_file_download(&app_data, &root.root.id, "archive.zip"),
            Err(CoreError::TooLarge(MAX_DOCUMENT_DOWNLOAD_BYTES))
        ));

        let source = read_document_file_source(&app_data, &root.root.id, "archive.zip")
            .expect("resolve source");
        assert_eq!(source.relative_path, "archive.zip");
        assert_eq!(source.size_bytes, MAX_DOCUMENT_DOWNLOAD_BYTES + 1);
        assert!(matches!(
            read_document_file_source(&app_data, &root.root.id, "../outside.zip"),
            Err(CoreError::InvalidInput(_)) | Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn document_file_preview_keeps_markdown_text_and_binary_distinct() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let docs = temp.path().join("docs");
        fs::create_dir_all(&docs).expect("document directory must exist");
        fs::write(docs.join("guide.markdown"), "# Guide\n").expect("markdown file");
        fs::write(docs.join("script.js"), "export const ok = true;\n").expect("text file");
        fs::write(docs.join("image.bin"), [0_u8, 1, 2, 3]).expect("binary file");
        let root = add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref(), false)
            .expect("doc root must register");

        assert_eq!(
            read_document_file(&app_data, &root.root.id, "guide.markdown")
                .expect("markdown preview")
                .kind,
            DocumentPreviewKind::Markdown
        );
        assert_eq!(
            read_document_file(&app_data, &root.root.id, "script.js")
                .expect("text preview")
                .kind,
            DocumentPreviewKind::Text
        );
        let binary =
            read_document_file(&app_data, &root.root.id, "image.bin").expect("binary metadata");
        assert_eq!(binary.kind, DocumentPreviewKind::Binary);
        assert!(binary.content.is_none());
        assert!(binary.downloadable);
    }

    /// qa50: 앞 8KB만 텍스트인 파일은 트리에서는 텍스트로 보이지만, 열 때는 오류 대신
    /// 바이너리(content 없음, 다운로드 가능)로 내려와야 한다.
    #[test]
    fn document_file_with_text_sample_and_binary_tail_downgrades_to_binary() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let docs = temp.path().join("docs");
        fs::create_dir_all(&docs).expect("document directory must exist");
        let mut bytes = "line of text\n".repeat(700).into_bytes();
        assert!(bytes.len() > 8 * 1024);
        bytes.extend_from_slice(&[0_u8, 0xFF, 0xFE, 0, 159, 146, 150]);
        fs::write(docs.join("mixed.log"), &bytes).expect("mixed file");
        let root = add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref(), false)
            .expect("doc root must register");

        let listed =
            list_document_entries(&app_data, &root.root.id, "", None, Some(10)).expect("entries");
        assert_eq!(
            listed.entries[0].preview_kind,
            Some(DocumentPreviewKind::Text),
            "tree scan keeps the cheap 8KB sample verdict"
        );

        let opened = read_document_file(&app_data, &root.root.id, "mixed.log")
            .expect("opening a mixed file must not fail");
        assert_eq!(opened.kind, DocumentPreviewKind::Binary);
        assert!(opened.content.is_none());
        assert!(opened.downloadable);
        assert_eq!(opened.size_bytes, bytes.len() as u64);
    }

    #[test]
    fn text_extensions_decide_placeholder_preview_without_opening() {
        assert!(has_text_extension(Path::new("note.txt")));
        assert!(has_text_extension(Path::new("REPORT.CSV")));
        assert!(has_text_extension(Path::new("tsconfig.json")));
        assert!(!has_text_extension(Path::new("설계서.pptx")));
        assert!(!has_text_extension(Path::new("사진.jpg")));
        assert!(!has_text_extension(Path::new("no-extension")));
    }

    /// 목록 한 번에 OneDrive 폴더가 통째로 내려받아지던 자리. 자리표시자 비트가 선
    /// 파일은 열지 않고 확장자로만 갈라야 한다.
    #[cfg(windows)]
    #[test]
    fn cloud_placeholders_are_classified_without_being_opened() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_OFFLINE};

        fn mark_offline(path: &Path) -> bool {
            let wide = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            // SAFETY: 방금 만든 파일 경로 하나에만 속성을 세운다.
            unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_OFFLINE) != 0 }
        }

        let temp = tempfile::tempdir().expect("temp dir");
        let binary = temp.path().join("placeholder.docx");
        fs::write(&binary, b"not really a document").expect("write");
        if !mark_offline(&binary) {
            // 볼륨이 OFFLINE 비트를 받아 주지 않으면 이 테스트로 확인할 것이 없다.
            return;
        }
        let metadata = fs::symlink_metadata(&binary).expect("metadata");
        assert!(is_cloud_placeholder(&metadata));
        assert_eq!(
            preview_kind_for_path(&binary, &metadata).expect("preview kind"),
            DocumentPreviewKind::Binary,
            "자리표시자는 표본을 읽지 않고 확장자로 갈린다"
        );

        let text = temp.path().join("placeholder.txt");
        fs::write(&text, b"hello").expect("write");
        assert!(mark_offline(&text));
        let text_metadata = fs::symlink_metadata(&text).expect("metadata");
        assert_eq!(
            preview_kind_for_path(&text, &text_metadata).expect("preview kind"),
            DocumentPreviewKind::Text
        );
    }

    #[test]
    fn markdown_file_detection_matches_supported_extensions() {
        assert!(is_markdown_file(Path::new("note.md")));
        assert!(is_markdown_file(Path::new("document.markdown")));
        assert!(is_markdown_file(Path::new("README.MD")));
        assert!(!is_markdown_file(Path::new("code.rs")));
        assert!(!is_markdown_file(Path::new("binary")));
    }
}
