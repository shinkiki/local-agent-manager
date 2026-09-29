//! 등록 프로젝트 폴더의 파일을 읽기 전용으로 훑는 한 곳(C16-9).
//!
//! 문서 메뉴(`document_tree`)는 사용자가 따로 등록한 문서 루트를 보지만, 프로젝트 화면은
//! 세션에서 확인된 **활성 등록 프로젝트** 폴더를 그대로 본다. 루트를 정하는 자리만 다르고
//! 페이지 창·미리보기 판별·본문 읽기는 같은 헬퍼를 쓴다. 다른 점 셋은 프로젝트라는 대상
//! 때문이다 — 점으로 시작하는 이름(`.github`, `.claude`)은 프로젝트 구성이라 보여 주고,
//! `.git`은 어느 깊이에서든 감추며(저장소 내부는 형상관리 탭이 git 명령으로 읽는다),
//! 심볼릭 링크는 목록에서 감추고 읽기는 거절한다(G10 — 링크를 따라가면 등록 폴더 밖이
//! 보인다). 쓰기 경로는 없다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::doc_roots::is_restricted_doc_root;
use crate::document_tree::{
    directory_first_order, document_entry_page, document_page_window, modified_ms,
    preview_kind_for_path, read_document_text,
};
use crate::domain::{DocumentEntry, DocumentEntryPage, DocumentPreviewKind};
use crate::path_guard::{self, CurDirPolicy, RelativePathIssue};
use crate::user_home::home_dir;
use crate::CoreError;

/// 한 폴더에서 화면에 내주는 항목 상한. 전체를 읽어 정렬한 뒤 이 수에서 자르므로 어느 항목이
/// 남는지는 정해져 있고(폴더 먼저, 이름순), `total`은 자른 뒤의 수다. `node_modules` 같은
/// 폴더를 통째로 페이지에 싣다 화면이 멈추는 것보다 낫다.
const MAX_PROJECT_DIRECTORY_ENTRIES: usize = 10_000;

/// 프로젝트 화면이 다루지 않는 폴더(C16-1·C16-9). 세션 cwd에서 파생되는 등록 프로젝트에는
/// 홈 폴더 자체(홈에서 CLI를 한 번 띄우면 등록된다)나 공급자 홈이 들어올 수 있는데, 그 폴더의
/// 파일 목록은 곧 `~/.claude/.credentials.json`·`~/.ssh`다(G4). 문서 루트와 같은 판정에 홈
/// 자체를 더한 것이고, 파일 탭과 git 탭이 같은 자리에서 거절한다.
pub fn is_restricted_project_root(app_data_dir: &Path, root: &Path) -> bool {
    let is_home = home_dir()
        .ok()
        .and_then(|home| fs::canonicalize(home).ok())
        .is_some_and(|home| fs::canonicalize(root).is_ok_and(|root| root == home));
    is_home || is_restricted_doc_root(app_data_dir, root)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectEntriesRequest {
    pub project_path: String,
    #[serde(default)]
    pub parent_path: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProjectFileRequest {
    pub project_path: String,
    pub relative_path: String,
}

/// 프로젝트 파일 하나의 본문 또는 본문을 줄 수 없는 이유(`kind`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileView {
    pub project_path: String,
    pub relative_path: String,
    pub kind: DocumentPreviewKind,
    pub content: Option<String>,
    pub size_bytes: u64,
    pub modified_at: i64,
}

/// 등록 프로젝트 폴더의 한 폴더를 페이지 단위로 읽는다. `root`는 호출부(`remote`)가
/// 레지스트리에서 검증해 정규화한 경로다.
pub fn list_project_entries(
    root: &Path,
    parent_path: &str,
    cursor: Option<&str>,
    limit: Option<usize>,
) -> Result<DocumentEntryPage, CoreError> {
    let parent = resolve_project_path(root, parent_path)?;
    if !parent.is_dir() {
        return Err(CoreError::InvalidInput(
            "파일 목록 기준 경로가 폴더가 아닙니다".to_owned(),
        ));
    }
    let (offset, limit) = document_page_window(cursor, limit)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&parent)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        let path = item.path();
        let metadata = fs::symlink_metadata(&path)?;
        if is_hidden_project_child(&name, &metadata) {
            continue;
        }
        entries.push(project_entry(root, &path, &metadata)?);
    }
    entries.sort_by(|left, right| {
        directory_first_order(
            (left.is_directory, &left.name),
            (right.is_directory, &right.name),
        )
    });
    entries.truncate(MAX_PROJECT_DIRECTORY_ENTRIES);
    Ok(document_entry_page(entries, offset, limit))
}

/// 프로젝트 파일 하나를 읽는다. 문서 메뉴와 같은 판별을 거쳐 Markdown·텍스트는 본문을,
/// 바이너리·초과 크기는 종류만 돌려준다.
pub fn read_project_file(root: &Path, relative_path: &str) -> Result<ProjectFileView, CoreError> {
    let path = resolve_project_path(root, relative_path)?;
    if path == root {
        return Err(CoreError::InvalidInput(
            "읽을 파일 경로를 지정해 주세요".to_owned(),
        ));
    }
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "선택한 항목이 일반 파일이 아닙니다".to_owned(),
        ));
    }
    let (kind, content) = match preview_kind_for_path(&path, &metadata)? {
        kind @ (DocumentPreviewKind::Markdown | DocumentPreviewKind::Text) => {
            match read_document_text(&path)? {
                Some(content) => (kind, Some(content)),
                None => (DocumentPreviewKind::Binary, None),
            }
        }
        kind @ (DocumentPreviewKind::Binary | DocumentPreviewKind::TooLarge) => (kind, None),
    };
    Ok(ProjectFileView {
        project_path: path_guard::child_facing(root)
            .to_string_lossy()
            .into_owned(),
        relative_path: normalized_relative(root, &path)?,
        kind,
        content,
        size_bytes: metadata.len(),
        modified_at: modified_ms(&metadata),
    })
}

/// 상대 경로를 등록 폴더 안의 실제 경로로 푼다. 빈 경로는 루트 자체다. `.git` 구성요소와
/// 경로 위의 심볼릭 링크는 거절하고, 정규화한 결과가 루트 안인지 다시 확인한다.
fn resolve_project_path(root: &Path, relative: &str) -> Result<PathBuf, CoreError> {
    let relative = Path::new(relative.trim());
    match path_guard::classify_relative_path(relative, CurDirPolicy::Reject) {
        None => {}
        Some(RelativePathIssue::Empty) => return Ok(root.to_path_buf()),
        Some(_) => return Err(path_outside_root()),
    }
    if relative
        .components()
        .any(|component| component.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(CoreError::InvalidInput(
            ".git 내부는 파일 화면에서 열 수 없습니다. 형상관리 탭을 이용하세요".to_owned(),
        ));
    }
    // 경로 위 모든 칸을 루트부터 한 칸씩 내려가며 심볼릭 링크를 거절한다. 마지막 칸만
    // 보면 중간 폴더가 링크인 `docs -> /etc` 꼴이 통과한다.
    let mut probe = root.to_path_buf();
    for component in relative.components() {
        probe.push(component);
        let metadata = fs::symlink_metadata(&probe)?;
        if metadata.file_type().is_symlink() {
            return Err(CoreError::InvalidInput(
                "심볼릭 링크는 프로젝트 파일 화면에서 열 수 없습니다".to_owned(),
            ));
        }
    }
    let path = fs::canonicalize(&probe)?;
    if path != root && !path.starts_with(root) {
        return Err(path_outside_root());
    }
    Ok(path)
}

/// 목록에서 감추는 항목: `.git`(폴더든 워크트리의 링크 파일이든), 심볼릭 링크, 폴더도
/// 파일도 아닌 것. 점으로 시작하는 나머지 이름은 보여 준다.
fn is_hidden_project_child(name: &str, metadata: &fs::Metadata) -> bool {
    name.eq_ignore_ascii_case(".git")
        || metadata.file_type().is_symlink()
        || (!metadata.is_dir() && !metadata.is_file())
}

fn project_entry(
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

fn normalized_relative(root: &Path, path: &Path) -> Result<String, CoreError> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| path_outside_root())
}

fn path_outside_root() -> CoreError {
    CoreError::InvalidInput("프로젝트 폴더를 벗어난 경로입니다".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        fs::create_dir_all(root.join(".git/refs")).expect(".git");
        fs::write(root.join(".git/config"), "[core]\n").expect("config");
        fs::create_dir_all(root.join(".github/workflows")).expect(".github");
        fs::write(root.join(".github/workflows/ci.yml"), "on: push\n").expect("ci");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("main");
        fs::write(root.join("README.md"), "# 제목\n").expect("readme");
        fs::write(root.join("logo.bin"), [0_u8, 159, 146, 150]).expect("bin");
        (dir, root)
    }

    #[test]
    fn c16_9_lists_dot_entries_but_hides_git_and_symlinks() {
        let (_dir, root) = project();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("etc-link")).expect("symlink");
        let page = list_project_entries(&root, "", None, None).expect("list");
        let names: Vec<&str> = page
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        // 폴더가 먼저, 그 다음은 대소문자 구분 없는 이름순이다(문서 메뉴와 같은 차례).
        assert_eq!(names, vec![".github", "src", "logo.bin", "README.md"]);
        assert!(page.entries[0].is_directory);
        assert_eq!(
            page.entries[2].preview_kind,
            Some(DocumentPreviewKind::Binary)
        );

        let nested = list_project_entries(&root, ".github/workflows", None, None).expect("nested");
        assert_eq!(nested.entries[0].relative_path, ".github/workflows/ci.yml");
        assert_eq!(nested.entries[0].parent_path, ".github/workflows");
    }

    /// G4. 홈과 앱 데이터는 등록 프로젝트로 잡혀도 파일 화면이 열리지 않는다.
    #[test]
    fn c16_9_home_and_app_data_are_restricted_roots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data = dir.path().join("app-data");
        let project = dir.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        assert!(is_restricted_project_root(&app_data, &app_data));
        assert!(!is_restricted_project_root(&app_data, &project));
        if let Ok(home) = home_dir() {
            assert!(is_restricted_project_root(&app_data, &home));
        }
    }

    #[test]
    fn c16_9_pages_with_cursor() {
        let (_dir, root) = project();
        let first = list_project_entries(&root, "", None, Some(2)).expect("page 1");
        assert_eq!(first.entries.len(), 2);
        assert_eq!(first.total, 4);
        let cursor = first.next_cursor.expect("next cursor");
        let second = list_project_entries(&root, "", Some(&cursor), Some(2)).expect("page 2");
        assert_eq!(second.entries[0].name, "logo.bin");
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn c16_9_reads_text_markdown_and_binary_kinds() {
        let (_dir, root) = project();
        let readme = read_project_file(&root, "README.md").expect("readme");
        assert_eq!(readme.kind, DocumentPreviewKind::Markdown);
        assert_eq!(readme.content.as_deref(), Some("# 제목\n"));
        let main = read_project_file(&root, "src/main.rs").expect("main");
        assert_eq!(main.kind, DocumentPreviewKind::Text);
        assert_eq!(main.relative_path, "src/main.rs");
        let bin = read_project_file(&root, "logo.bin").expect("bin");
        assert_eq!(bin.kind, DocumentPreviewKind::Binary);
        assert!(bin.content.is_none());
    }

    #[test]
    fn c16_9_refuses_escapes_git_internals_and_symlinks() {
        let (_dir, root) = project();
        for bad in [
            "../x",
            "/etc/passwd",
            ".git/config",
            "src/../.git/HEAD",
            "./src",
        ] {
            assert!(read_project_file(&root, bad).is_err(), "{bad}");
        }
        assert!(list_project_entries(&root, ".git", None, None).is_err());
        assert!(read_project_file(&root, "").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("src"), root.join("alias")).expect("dir link");
            std::os::unix::fs::symlink(root.join("README.md"), root.join("link.md"))
                .expect("file link");
            assert!(read_project_file(&root, "link.md").is_err());
            assert!(read_project_file(&root, "alias/main.rs").is_err());
            assert!(list_project_entries(&root, "alias", None, None).is_err());
        }
    }
}
