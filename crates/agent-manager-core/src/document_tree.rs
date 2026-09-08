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
use crate::{linked_file, CoreError, LinkedFile, LinkedFileDownload};

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
            "문서 목록 기준 경로가 폴더가 아닙니다".to_owned(),
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
    let root = resolve_root(app_data_dir, root_id)?;
    let path = resolve_doc_path(&root, relative_path, true)?;
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
    let doc_root = resolve_root(app_data_dir, root_id)?;
    let current_doc = resolve_doc_path(&doc_root, current_path, true)?;
    validate_markdown_file(&current_doc)?;
    let workspace_root = nearest_repository_root(&doc_root).unwrap_or(&doc_root);
    let current_dir = current_doc.parent().ok_or_else(|| {
        CoreError::InvalidInput("현재 문서의 기준 경로를 확인할 수 없습니다".to_owned())
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
    if is_restricted_doc_root(app_data_dir, &canonical) {
        return Err(CoreError::InvalidInput(
            "보호된 경로와 겹치는 문서 폴더에는 접근할 수 없습니다".to_owned(),
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

fn document_cursor_offset(cursor: Option<&str>) -> Result<usize, CoreError> {
    match cursor.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(0),
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| CoreError::InvalidInput("문서 목록 커서가 올바르지 않습니다".to_owned())),
    }
}

/// 문서 목록·검색이 공유하는 페이지 창. 커서는 항목을 읽기 전에 해석해,
/// 잘못된 커서가 디렉터리 오류에 가려지지 않게 한다.
fn document_page_window(
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
fn document_entry_page(
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
        if item.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = item.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            continue;
        }
        children.push((path, metadata));
    }
    Ok(children)
}

/// 폴더를 앞세우고 주어진 키를 대소문자 구분 없이 견주는 문서 목록 정렬. 목록은
/// 이름을, 검색은 상대 경로를 키로 쓴다.
fn sort_document_entries(entries: &mut [DocumentEntry], key: fn(&DocumentEntry) -> &str) {
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| key(left).to_lowercase().cmp(&key(right).to_lowercase()))
    });
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
        .and_then(|parent| parent.strip_prefix(root).ok())
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
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
fn read_document_text(path: &Path) -> Result<Option<String>, CoreError> {
    let bytes = fs::read(path)?;
    if bytes.contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

fn preview_kind_for_path(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<DocumentPreviewKind, CoreError> {
    if metadata.len() > MAX_DOC_BYTES {
        return Ok(DocumentPreviewKind::TooLarge);
    }
    if is_markdown_file(path) {
        return Ok(DocumentPreviewKind::Markdown);
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
    right
        .is_directory
        .cmp(&left.is_directory)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
}

fn resolve_doc_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, CoreError> {
    let relative = Path::new(relative);
    // 빈 경로는 루트 자체를 가리키는 정상 입력이라 그대로 통과시킨다.
    if !matches!(
        path_guard::classify_relative_path(relative, CurDirPolicy::Reject),
        None | Some(RelativePathIssue::Empty)
    ) {
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

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        })
}

fn validate_markdown_file(path: &Path) -> Result<(), CoreError> {
    if !is_markdown_file(path) {
        return Err(CoreError::InvalidInput(
            "Markdown(.md, .markdown) 문서만 허용됩니다".to_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::add_doc_root;

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
    fn markdown_file_detection_matches_supported_extensions() {
        assert!(is_markdown_file(Path::new("note.md")));
        assert!(is_markdown_file(Path::new("document.markdown")));
        assert!(is_markdown_file(Path::new("README.MD")));
        assert!(!is_markdown_file(Path::new("code.rs")));
        assert!(!is_markdown_file(Path::new("binary")));
    }
}
