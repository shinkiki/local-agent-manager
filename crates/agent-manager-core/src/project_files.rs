//! 등록 프로젝트 폴더의 파일을 읽기 전용으로 훑는 한 곳(C16-9).
//!
//! 문서 메뉴(`document_tree`)는 사용자가 따로 등록한 문서 루트를 보지만, 프로젝트 화면은
//! 세션에서 확인된 **활성 등록 프로젝트** 폴더를 그대로 본다. 루트를 정하는 자리만 다르고
//! 페이지 창·미리보기 판별·본문 읽기는 같은 헬퍼를 쓴다. 다른 점 셋은 프로젝트라는 대상
//! 때문이다 — 점으로 시작하는 이름(`.github`, `.claude`)은 프로젝트 구성이라 보여 주고,
//! `.git`은 어느 깊이에서든 감추며(저장소 내부는 형상관리 탭이 git 명령으로 읽는다),
//! 심볼릭 링크는 목록에서 감추고 읽기는 거절한다(G10 — 링크를 따라가면 등록 폴더 밖이
//! 보인다). 쓰기 경로는 없다.

use std::collections::BTreeSet;
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
use crate::project_git::{project_git_status, GitChangeKind, GitStatus};
use crate::project_overlays::list_project_overlay_sets;
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

/// 검색이 한 번에 내주는 결과 상한(F2). 트리 전체를 훑는 호출이라 상한이 없으면
/// `node_modules`가 딸린 저장소에서 한 번의 검색이 수만 개를 직렬화해 화면을 멈춘다.
/// 상한에 닿으면 자르고 `truncated`로 알린다 — 조용히 일부만 주지 않는다.
const MAX_PROJECT_SEARCH_HITS: usize = 200;

/// 검색이 훑는 항목 상한. 결과 상한과 별개인 이유는, 질의에 맞는 것이 하나도 없어도
/// 트리는 끝까지 걸어야 하기 때문이다. 둘 중 먼저 닿는 쪽에서 멈춘다.
const MAX_PROJECT_SEARCH_SCAN: usize = 100_000;

/// 내용 검색이 **여는** 파일의 크기 상한(F3). 파일 판별의 5MB 상한과 따로 둔 이유는, 하나를
/// 열어 보여 주는 것과 트리 전체를 열어 훑는 것의 비용이 다르기 때문이다. 이 크기를 넘는
/// 파일은 이름으로는 여전히 걸리지만 본문은 읽지 않고 `excluded`로 센다.
const MAX_PROJECT_SEARCH_CONTENT_BYTES: u64 = 1024 * 1024;

/// 내용 검색이 본문을 읽지 않는 폴더 이름(F3). 받은 산출물·의존성 폴더는 사용자가 쓴 것이
/// 아니라 질의에 걸려도 답이 되지 않고, `node_modules` 하나가 수만 개 파일이라 여기서
/// 멈추지 않으면 내용 검색이 사실상 끝나지 않는다. 이름·상대경로 검색(F1)은 이 목록을
/// 보지 않는다 — 거기서 빼면 "분명히 있는 파일이 검색되지 않는다"가 되고, 그것은 이 항목이
/// 말하는 "읽지 않는다"와 다른 이야기다.
const EXCLUDED_CONTENT_SEARCH_DIRECTORIES: [&str; 11] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".cache",
];

/// 상대경로가 제외 폴더 안인지. 경로 성분 하나와 통째로 같을 때만 제외한다 — `contains`로
/// 보면 `src/targeting/`처럼 이름이 겹치는 사용자 폴더가 조용히 빠진다.
fn is_excluded_content_path(relative: &str) -> bool {
    relative.split('/').any(|segment| {
        EXCLUDED_CONTENT_SEARCH_DIRECTORIES
            .iter()
            .any(|excluded| segment.eq_ignore_ascii_case(excluded))
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProjectFileRequest {
    pub project_path: String,
    pub relative_path: String,
}

/// 파일명·상대경로 검색 요청(F1). `query`는 이름이나 상대경로의 일부이며 대소문자를 가리지
/// 않는다. 본문 검색은 이 요청이 하지 않는다 — 읽는 비용과 거절 규칙이 다르므로 따로 켠다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileSearchRequest {
    pub project_path: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
    /// 본문도 볼지(F3). 기본은 꺼짐이고, 켜도 결과에 본문이 실리지는 않는다 — 켜는 것이
    /// 바꾸는 것은 "무엇이 걸리는가"뿐이다(F5).
    #[serde(default)]
    pub search_contents: bool,
}

/// 검색 결과 한 줄(F4). 목록과 같은 `DocumentEntry`를 그대로 펼쳐 싣고(`serde(flatten)` —
/// 화면은 트리에서 쓰던 칸을 다시 배우지 않는다) 검색에서만 쓰는 세 칸을 더한다.
///
/// - `git_status`: 작업 트리 기준의 변경 종류. 저장소가 아니거나 `git status`가 실패하면
///   `None`이고, 그 사실이 오류가 되지는 않는다 — 검색은 git 없이도 답해야 한다.
/// - `modified_at`: 마지막 수정 시각(ms). `DocumentEntry`가 이미 같은 값을 들고 있지만,
///   결과 줄이 자기 힘으로 정렬·표시될 수 있도록 한 칸으로 고정한다.
/// - `in_overlay`: 이 파일이 overlay 세트에 들어 있는가. overlay 어댑터는 C19 예외가 선
///   뒤에야 생기므로 **지금은 언제나 `false`**다. 칸을 미리 두는 이유는 화면과 계약이
///   나중에 모양을 바꾸지 않게 하기 위해서이고, 값을 지어내지 않는 것이 조건이다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileSearchHit {
    #[serde(flatten)]
    pub entry: DocumentEntry,
    pub git_status: Option<GitChangeKind>,
    pub modified_at: i64,
    pub in_overlay: bool,
}

/// 검색 결과. `scanned`는 실제로 훑은 항목 수이고, `truncated`는 결과 상한이나 훑기 상한에
/// 닿아 더 있을 수 있다는 뜻이다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileSearchPage {
    pub query: String,
    pub entries: Vec<ProjectFileSearchHit>,
    pub scanned: usize,
    pub truncated: bool,
    /// git 상태를 읽었는지. 거짓이면 저장소가 아니거나 상태를 읽지 못한 것이고, 그때 모든
    /// 줄의 `gitStatus`는 null이다 — "변경 없음"과 구별된다(F4).
    pub git_status_available: bool,
    /// 내용 검색을 켜고 돌았는지. 결과가 적을 때 "본문까지 본 결과인가"를 화면이 말할 수 있다.
    pub searched_contents: bool,
    /// 내용 검색을 켰는데도 **열지 않은** 파일 수 — 제외 폴더·크기 초과·바이너리. 조용히
    /// 건너뛰면 사용자는 없는 것과 못 본 것을 구별할 수 없다.
    pub excluded: usize,
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

/// 등록 프로젝트 폴더를 훑어 이름·상대경로가 `query`를 품은 파일과 폴더를 찾는다(F1).
///
/// 목록과 같은 규칙을 그대로 쓴다 — `.git`은 어느 깊이에서든 건너뛰고, 심볼릭 링크는 따라가지
/// 않으며(G10 — 따라가면 등록 폴더 밖이 보인다), 결과 경로는 루트 기준 상대경로다. 결과와
/// 훑기 둘 다 상한이 있고, 어느 쪽에 닿아도 `truncated`로 알린다.
pub fn search_project_files(
    app_data_dir: &Path,
    root: &Path,
    query: &str,
    limit: Option<usize>,
    search_contents: bool,
) -> Result<ProjectFileSearchPage, CoreError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Err(CoreError::InvalidInput("검색어를 입력해 주세요".to_owned()));
    }
    let limit = limit
        .unwrap_or(MAX_PROJECT_SEARCH_HITS)
        .min(MAX_PROJECT_SEARCH_HITS);
    let mut entries = Vec::new();
    let mut scanned = 0_usize;
    let mut excluded = 0_usize;
    let mut truncated = false;
    let mut queue = vec![root.to_path_buf()];
    while let Some(dir) = queue.pop() {
        if truncated {
            break;
        }
        for item in fs::read_dir(&dir)? {
            let item = item?;
            let name = item.file_name().to_string_lossy().into_owned();
            let path = item.path();
            let metadata = fs::symlink_metadata(&path)?;
            if is_hidden_project_child(&name, &metadata) {
                continue;
            }
            scanned += 1;
            if scanned >= MAX_PROJECT_SEARCH_SCAN {
                truncated = true;
                break;
            }
            let relative = normalized_relative(root, &path)?;
            let mut matched = relative.to_lowercase().contains(&needle);
            if !matched && search_contents && metadata.is_file() {
                match content_matches(&path, &metadata, &relative, &needle)? {
                    ContentMatch::Hit => matched = true,
                    ContentMatch::Miss => {}
                    ContentMatch::NotRead => excluded += 1,
                }
            }
            if matched {
                if entries.len() >= limit {
                    truncated = true;
                    break;
                }
                entries.push(project_entry(root, &path, &metadata)?);
            }
            if metadata.is_dir() {
                queue.push(path);
            }
        }
    }
    entries.sort_by(|left, right| {
        directory_first_order(
            (left.is_directory, &left.relative_path),
            (right.is_directory, &right.relative_path),
        )
    });
    // git 상태는 결과가 정해진 뒤 한 번만 읽는다(F4). 줄마다 `git status`를 부르면 결과
    // 상한만큼 프로세스를 띄우게 되고, 저장소가 아니면 그 비용이 전부 헛것이 된다.
    let status = project_git_status(app_data_dir, root).ok();
    // overlay 장부도 같은 이유로 한 번만 읽는다. git 상태와 달리 git을 띄우지 않으므로,
    // 저장소가 잠겨 있거나 저장소가 아니어도 이 칸은 답할 수 있다 —
    // `list_project_overlay_sets`가 그렇게 설계된 조회다(C19-1).
    let overlay_paths = overlay_paths_in_project(app_data_dir, root);
    let hits = entries
        .into_iter()
        .map(|entry| project_search_hit(root, entry, status.as_ref(), &overlay_paths))
        .collect();
    Ok(ProjectFileSearchPage {
        query: needle,
        entries: hits,
        scanned,
        truncated,
        git_status_available: status.is_some(),
        searched_contents: search_contents,
        excluded,
    })
}

/// 한 결과 줄에 git 상태와 overlay 포함 여부를 붙인다(F4).
///
/// 프로젝트가 저장소의 하위 폴더일 수 있으므로(C16-1) `git status`의 경로는 저장소 루트
/// 기준이고 검색 결과의 경로는 프로젝트 루트 기준이다. 둘을 그대로 비교하면 하위 폴더
/// 프로젝트에서 모든 줄이 "변경 없음"으로 보인다 — 그래서 저장소 루트 대비 프로젝트의
/// 자리(`offset`)를 앞에 붙여 맞춘다.
///
/// **overlay 장부도 같은 기준이다.** 2026-10-04 실측: overlay 세트에 담기는 경로는
/// `ProjectOverlayPanel`이 `get_project_git_status`의 변경 목록에서 그대로 가져오고
/// (`status.entries[].path`), `snapshot_project_overlay`·`apply_project_overlay`는 그 경로를
/// 저장소 최상위에서 도는 git에 pathspec으로 넘긴다(`GitRunner::root`는 `--show-toplevel`
/// 결과다). 즉 세트의 경로는 처음부터 **저장소 루트 기준**이고, `ProjectOverlaySet.paths`의
/// 타입 주석이 적어 둔 그대로다. `save_project_overlay_set`이 `validate_repo_path`에 넘기는
/// 루트가 등록 프로젝트 루트라는 사실은 이 기준을 바꾸지 않는다 — 그 검증은 경로를 변환하지
/// 않고 받아들이기만 한다.
fn project_search_hit(
    root: &Path,
    entry: DocumentEntry,
    status: Option<&GitStatus>,
    overlay_paths: &BTreeSet<String>,
) -> ProjectFileSearchHit {
    // 저장소 루트 대비 프로젝트의 자리. git 상태를 읽어야만 알 수 있으므로, 읽지 못하면
    // 빈 값으로 두고 프로젝트가 곧 저장소 루트인 흔한 경우에 맞춘다 — 하위 폴더 프로젝트에서
    // git이 잠겨 있는 동안 overlay 표시가 비는 것은, 그 때문에 검색이 죽는 것보다 낫다.
    let offset = status
        .and_then(|status| {
            // 양쪽을 같은 표기로 맞춘 뒤에 뗀다. `root`는 디스패처가 정규화해 넘긴 경로라
            // Windows에서 `\\?\C:\...` 꼴이고 `GitStatus::project_path`는 자식에게 보여 줄
            // 표기(`child_facing`)로 `\\?\`가 떨어져 있다. 그대로 `strip_prefix`하면 하위 폴더
            // 프로젝트에서 **언제나** 실패해 offset이 비고, git 상태 칸과 overlay 칸이 둘 다
            // 조용히 비어 버린다(2026-10-04 실측).
            normalized_relative(
                &path_guard::child_facing(Path::new(&status.project_path)),
                &path_guard::child_facing(root),
            )
            .ok()
        })
        .unwrap_or_default();
    let repo_relative = if offset.is_empty() {
        entry.relative_path.clone()
    } else {
        format!("{}/{}", offset.trim_end_matches('/'), entry.relative_path)
    };
    let git_status = status.and_then(|status| {
        status
            .entries
            .iter()
            .find(|item| item.path == repo_relative)
            .map(|item| {
                if item.worktree_status == GitChangeKind::Unmodified {
                    item.index_status
                } else {
                    item.worktree_status
                }
            })
    });
    // overlay 세트에 담긴 경로인가(F4). 세트의 경로는 git 상태와 **같은** 저장소 루트
    // 기준이므로(위 주석의 실측) `offset`을 붙인 경로로 맞춘다. 붙이지 않으면 하위 폴더
    // 프로젝트에서는 어떤 줄도 overlay로 표시되지 않는다.
    //
    // 세트 상태(`registered`/`stored`/`applied`)는 가리지 않는다. 이 칸이 답하는 것은 "이
    // 파일을 overlay가 관리하는가"이고, 아직 patch를 뜨지 않은 `registered`도 다음 스냅샷에서
    // 작업 트리가 HEAD 원본으로 되돌려지는 파일이다. 어느 세트의 어느 상태인지는 overlay
    // 탭이 세트 단위로 보여 준다.
    let in_overlay = overlay_paths.contains(&repo_relative);
    ProjectFileSearchHit {
        modified_at: entry.modified_at,
        entry,
        git_status,
        in_overlay,
    }
}

/// 이 프로젝트의 overlay 세트들이 담고 있는 대상 경로 전부(C19-1).
///
/// 장부를 읽지 못하면 **검색을 실패시키지 않고 빈 집합으로 둔다**. overlay 장부 하나 때문에
/// 파일 검색이 통째로 죽는 것은 F1이 약속한 것보다 나쁘고, 이 칸은 결과에 붙는 부가 정보지
/// 결과 자체가 아니다. 그때 모든 줄의 `inOverlay`는 false다 — git 상태가 같은 상황에서
/// `gitStatusAvailable`로 "못 읽었다"를 따로 말하는 것과 달리, 여기서는 세트가 없는 것과
/// 못 읽은 것이 화면에서 같게 보인다. 세트 목록 자체는 overlay 탭이 같은 조회로 보여 주므로
/// 읽히지 않는 장부는 거기서 드러난다.
fn overlay_paths_in_project(app_data_dir: &Path, root: &Path) -> BTreeSet<String> {
    let Ok(sets) = list_project_overlay_sets(app_data_dir, root) else {
        return BTreeSet::new();
    };
    sets.sets
        .into_iter()
        .flat_map(|set| set.paths.into_iter())
        .collect()
}

/// 내용 검색에서 파일 하나를 본 결과. "걸리지 않았다"와 "열지 않았다"를 가르는 것이
/// 이 타입의 전부다 — 둘을 섞으면 `excluded`가 셀 것이 없어진다.
enum ContentMatch {
    Hit,
    Miss,
    NotRead,
}

/// 파일 하나의 본문에 질의가 있는지. **본문은 돌려주지 않는다**(F5) — 돌려주는 것은
/// 세 갈래의 판정뿐이고, 그래서 결과 JSON에 파일 안의 문자열이 실릴 길이 없다.
///
/// 열지 않는 셋: 제외 폴더 안, `MAX_PROJECT_SEARCH_CONTENT_BYTES` 초과, 그리고 판별이
/// 바이너리·크기초과로 간 것. 바이너리 판별은 `preview_kind_for_path`가 앞 표본으로 하므로
/// 파일 전체를 읽어 보고 나서 버리는 일은 없다.
fn content_matches(
    path: &Path,
    metadata: &fs::Metadata,
    relative: &str,
    needle: &str,
) -> Result<ContentMatch, CoreError> {
    if is_excluded_content_path(relative) || metadata.len() > MAX_PROJECT_SEARCH_CONTENT_BYTES {
        return Ok(ContentMatch::NotRead);
    }
    match preview_kind_for_path(path, metadata)? {
        DocumentPreviewKind::Markdown | DocumentPreviewKind::Text => {}
        DocumentPreviewKind::Binary | DocumentPreviewKind::TooLarge => {
            return Ok(ContentMatch::NotRead)
        }
    }
    let Some(text) = read_document_text(path)? else {
        // 판별은 텍스트로 갈렸는데 전체를 읽으니 UTF-8이 아니었다. 바이너리와 같은 자리다.
        return Ok(ContentMatch::NotRead);
    };
    Ok(if text.to_lowercase().contains(needle) {
        ContentMatch::Hit
    } else {
        ContentMatch::Miss
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
        // C16-9 / G10: Unix의 역슬래시는 파일명 일부다. 실제 경로 성분 사이만 정규화한다.
        .map(|relative| {
            relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .map_err(|_| path_outside_root())
}

fn path_outside_root() -> CoreError {
    CoreError::InvalidInput("프로젝트 폴더를 벗어난 경로입니다".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 검색은 git 상태를 붙이려고 앱 데이터 경로를 받는다(F4). 시험의 임시 폴더는 저장소가
    /// 아니므로 `git status`는 실패하고, 그때 모든 줄의 `gitStatus`가 null이 된다.
    fn project() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("project")).expect("project dir");
        let root = fs::canonicalize(dir.path().join("project")).expect("canonical root");
        let app_data = dir.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(root.join(".git/refs")).expect(".git");
        fs::write(root.join(".git/config"), "[core]\n").expect("config");
        fs::create_dir_all(root.join(".github/workflows")).expect(".github");
        fs::write(root.join(".github/workflows/ci.yml"), "on: push\n").expect("ci");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("main");
        fs::write(root.join("README.md"), "# 제목\n").expect("readme");
        fs::write(root.join("logo.bin"), [0_u8, 159, 146, 150]).expect("bin");
        (dir, root, app_data)
    }

    #[test]
    fn c16_9_lists_dot_entries_but_hides_git_and_symlinks() {
        let (_dir, root, _app_data) = project();
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
        let (_dir, root, _app_data) = project();
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
        let (_dir, root, _app_data) = project();
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

    #[cfg(unix)]
    #[test]
    fn c16_9_literal_backslashes_round_trip_through_list_read_and_search() {
        let (_dir, root, app_data) = project();
        fs::write(root.join(r"src\main.rs"), "literal backslash file\n").expect("file");
        fs::create_dir(root.join(r"docs\drafts")).expect("directory");
        fs::write(root.join(r"docs\drafts/note.md"), "# literal directory\n").expect("note");

        let page = list_project_entries(&root, "", None, None).expect("list");
        let file = page
            .entries
            .iter()
            .find(|entry| entry.name == r"src\main.rs")
            .expect("file entry");
        assert_eq!(file.relative_path, r"src\main.rs");
        let view = read_project_file(&root, &file.relative_path).expect("read returned path");
        assert_eq!(view.relative_path, file.relative_path);
        assert_eq!(view.content.as_deref(), Some("literal backslash file\n"));
        assert_eq!(
            read_project_file(&root, "src/main.rs")
                .expect("nested file")
                .content
                .as_deref(),
            Some("fn main() {}\n")
        );

        let directory = page
            .entries
            .iter()
            .find(|entry| entry.name == r"docs\drafts")
            .expect("directory entry");
        let nested =
            list_project_entries(&root, &directory.relative_path, None, None).expect("nested list");
        assert_eq!(nested.entries[0].parent_path, r"docs\drafts");
        assert_eq!(nested.entries[0].relative_path, r"docs\drafts/note.md");
        assert_eq!(
            read_project_file(&root, &nested.entries[0].relative_path)
                .expect("nested read")
                .content
                .as_deref(),
            Some("# literal directory\n")
        );

        let search = search_project_files(&app_data, &root, r"\", None, false).expect("search");
        let paths: Vec<&str> = search
            .entries
            .iter()
            .map(|hit| hit.entry.relative_path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec![r"docs\drafts", r"docs\drafts/note.md", r"src\main.rs"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn c16_1_literal_backslash_project_offset_matches_git_and_overlay_paths() {
        let (_dir, repo, _app_data) = project();
        let root = repo.join(r"app\local");
        fs::create_dir(&root).expect("subproject");
        let path = root.join("main.rs");
        fs::write(&path, "fn main() {}\n").expect("file");
        let status = GitStatus {
            project_path: repo.to_string_lossy().into_owned(),
            head: Default::default(),
            upstream: None,
            entries: vec![crate::project_git::GitStatusEntry {
                path: r"app\local/main.rs".to_owned(),
                original_path: None,
                index_status: GitChangeKind::Unmodified,
                worktree_status: GitChangeKind::Modified,
                is_submodule: false,
                unmerged: None,
                rename_score: None,
            }],
            truncated: false,
            conflicted_count: 0,
            staged_count: 0,
            unstaged_count: 1,
            untracked_count: 0,
        };
        let overlay_paths = BTreeSet::from([r"app\local/main.rs".to_owned()]);
        let entry =
            project_entry(&root, &path, &fs::metadata(&path).expect("metadata")).expect("entry");
        let hit = project_search_hit(&root, entry.clone(), Some(&status), &overlay_paths);
        assert_eq!(hit.git_status, Some(GitChangeKind::Modified));
        assert!(hit.in_overlay);
        let wrong_paths = BTreeSet::from(["app/local/main.rs".to_owned()]);
        assert!(!project_search_hit(&root, entry, Some(&status), &wrong_paths).in_overlay);
    }

    #[test]
    fn c16_9_refuses_escapes_git_internals_and_symlinks() {
        let (_dir, root, _app_data) = project();
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

    /// F1. 검색은 이름과 상대경로 어느 쪽으로도 걸리고, `.git`은 어느 깊이에서든 빠지며,
    /// 상한에 닿으면 자르고 truncated로 알린다. 2026-10-01 측정: 상한 없이 트리를 훑던
    /// 초안이 node_modules가 있는 저장소에서 수만 건을 직렬화했다.
    #[test]
    fn project_files_search_matches_paths_and_caps_hits() {
        let (_dir, root, app_data) = project();
        let hit = search_project_files(&app_data, &root, "MAIN.RS", None, false).expect("search");
        assert_eq!(
            hit.entries
                .iter()
                .map(|hit| hit.entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/main.rs"]
        );
        assert!(!hit.truncated);

        // 상대경로의 조각으로도 걸린다(폴더 이름).
        let nested =
            search_project_files(&app_data, &root, "workflows", None, false).expect("nested");
        assert!(nested
            .entries
            .iter()
            .any(|hit| hit.entry.relative_path == ".github/workflows"));

        // `.git` 안은 어느 깊이에서도 결과에 오지 않는다.
        let git = search_project_files(&app_data, &root, "config", None, false).expect("git");
        assert!(git
            .entries
            .iter()
            .all(|hit| !hit.entry.relative_path.starts_with(".git/")));

        // 상한에 닿으면 자르고 알린다.
        let capped = search_project_files(&app_data, &root, ".", Some(1), false).expect("capped");
        assert_eq!(capped.entries.len(), 1);
        assert!(capped.truncated);

        assert!(search_project_files(&app_data, &root, "   ", None, false).is_err());
    }

    /// F5. 검색은 **본문을 결과에 싣지 않는다** — 걸린 것이 5MB를 넘는 파일이든 바이너리든,
    /// 결과에 오는 것은 경로·크기·판별 종류뿐이다. 2026-10-01 측정: 이 시험이 없던 동안
    /// `search_project_files`가 내주는 `DocumentEntry`에 본문 칸이 없다는 것이 아무 데도
    /// 고정돼 있지 않았고, 뒤에 붙을 내용 검색(F3)이 같은 경로에 본문을 얹으면 5MB 파일과
    /// 바이너리가 조용히 직렬화에 섞인다. 그래서 두 가지를 함께 못박는다 — 큰 파일은 열지
    /// 않고 `TooLarge`로 갈리고(`preview_kind_for_path`가 크기를 먼저 본다), 바이너리는
    /// 앞 8KB 표본으로만 갈리며, 어느 쪽이든 파일 안의 문자열은 응답 JSON에 나타나지 않는다.
    /// 상한도 같이 본다: 호출자가 더 큰 `limit`을 주어도 `MAX_PROJECT_SEARCH_HITS`를 넘지 않는다.
    #[test]
    fn project_files_search_excludes_binary_and_oversized_entries() {
        const SENTINEL: &str = "SENTINEL-PROJECT-FILE-BODY";
        let (_dir, root, app_data) = project();
        fs::create_dir_all(root.join("assets")).expect("assets");
        // 바이너리: NUL이 섞인 앞 8KB 표본으로 갈린다.
        let mut binary = Vec::new();
        binary.extend_from_slice(SENTINEL.as_bytes());
        binary.extend_from_slice(&[0_u8, 159, 146, 150]);
        fs::write(root.join("assets/payload.bin"), &binary).expect("payload");
        // 5MB를 넘는 텍스트: 내용만 보면 Text지만 크기가 먼저 걸려 열리지 않는다.
        let mut huge = SENTINEL.as_bytes().to_vec();
        huge.resize(5 * 1024 * 1024 + 1, b'a');
        fs::write(root.join("assets/huge.log"), &huge).expect("huge");

        let page = search_project_files(&app_data, &root, "assets/", None, false).expect("search");
        let kinds = |name: &str| {
            page.entries
                .iter()
                .find(|hit| hit.entry.relative_path == name)
                .unwrap_or_else(|| panic!("{name} 이 검색 결과에 없다"))
                .entry
                .preview_kind
        };
        assert_eq!(
            kinds("assets/payload.bin"),
            Some(DocumentPreviewKind::Binary)
        );
        assert_eq!(
            kinds("assets/huge.log"),
            Some(DocumentPreviewKind::TooLarge)
        );

        // 검색 응답에는 어떤 파일의 본문도 실리지 않는다.
        let encoded = serde_json::to_string(&page).expect("serialize");
        assert!(
            !encoded.contains(SENTINEL),
            "검색 결과에 파일 본문이 실렸다: {encoded}"
        );

        // 본문을 정말 달라고 했을 때만 종류가 사유로 돌아오고, 그때도 본문은 없다.
        for (name, expected) in [
            ("assets/payload.bin", DocumentPreviewKind::Binary),
            ("assets/huge.log", DocumentPreviewKind::TooLarge),
        ] {
            let view = read_project_file(&root, name).expect("read");
            assert_eq!(view.kind, expected);
            assert!(view.content.is_none(), "{name} 의 본문이 실렸다");
        }

        // 상한: 호출자가 더 크게 불러도 결과 상한을 넘지 않는다.
        let wide = search_project_files(
            &app_data,
            &root,
            ".",
            Some(MAX_PROJECT_SEARCH_HITS + 500),
            false,
        )
        .expect("wide");
        assert!(wide.entries.len() <= MAX_PROJECT_SEARCH_HITS);
    }

    /// F3. 내용 검색은 **명시로 켤 때만** 돌고, 켜도 열지 않는 셋이 있다 — 제외 폴더
    /// (`node_modules` 같은 받은 산출물), 1MB 초과, 바이너리. 그리고 켜도 결과에 본문은
    /// 실리지 않는다(F5와 같은 자리). 2026-10-02 측정: 이 시험을 쓰기 전 `search_contents`는
    /// 요청 타입에만 있고 traversal은 이름만 보고 있었다. 가장 쉬운 구현 — 걸린 파일마다
    /// `read_document_text`로 열어 보는 것 — 은 `node_modules`가 딸린 저장소에서 검색 한 번에
    /// 수만 파일을 열고, 5MB 상한까지는 열리므로 로그 파일 하나가 검색을 멈춰 세운다.
    /// 그래서 여는 쪽에만 따로 상한과 제외 목록을 두고, 열지 않은 것은 `excluded`로 센다 —
    /// 조용히 건너뛰면 "검색에 안 나온다"와 "안 봤다"를 사용자가 구별할 수 없다.
    #[test]
    fn project_files_content_search_is_opt_in_and_skips_excluded_paths() {
        const NEEDLE: &str = "ZZ-CONTENT-ONLY-NEEDLE";
        let (_dir, root, app_data) = project();
        fs::write(
            root.join("src/lib.rs"),
            format!(
                "// {NEEDLE}
"
            ),
        )
        .expect("lib");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("node_modules");
        fs::write(
            root.join("node_modules/pkg/index.js"),
            format!("/* {NEEDLE} */"),
        )
        .expect("dep");
        // 1MB를 넘는 텍스트: 판별로는 Text지만 내용 검색이 열지 않는다.
        let mut big = NEEDLE.as_bytes().to_vec();
        big.resize(MAX_PROJECT_SEARCH_CONTENT_BYTES as usize + 1, b'a');
        fs::write(root.join("big.log"), &big).expect("big");
        // 바이너리: 질의가 바이트로는 들어 있어도 열지 않는다.
        let mut binary = NEEDLE.as_bytes().to_vec();
        binary.extend_from_slice(&[0_u8, 159, 146, 150]);
        fs::write(root.join("blob.bin"), &binary).expect("blob");

        // 끄면 이름·상대경로만 본다 — 본문에만 있는 질의는 하나도 걸리지 않는다.
        let off = search_project_files(&app_data, &root, NEEDLE, None, false).expect("off");
        assert!(off.entries.is_empty(), "{:?}", off.entries);
        assert!(!off.searched_contents);
        assert_eq!(off.excluded, 0);

        let on = search_project_files(&app_data, &root, NEEDLE, None, true).expect("on");
        let hits: Vec<&str> = on
            .entries
            .iter()
            .map(|hit| hit.entry.relative_path.as_str())
            .collect();
        assert_eq!(hits, vec!["src/lib.rs"]);
        assert!(on.searched_contents);
        // 열지 않은 셋이 모두 세어진다: node_modules 안, 1MB 초과, 바이너리.
        assert!(on.excluded >= 3, "excluded={}", on.excluded);

        // 켠 검색의 응답에도 본문은 없다.
        let encoded = serde_json::to_string(&on).expect("serialize");
        assert!(
            !encoded.contains(
                "ZZ-CONTENT-ONLY-NEEDLE
"
            ),
            "내용 검색 결과에 본문이 실렸다: {encoded}"
        );

        // 이름 검색은 제외 목록을 보지 않는다 — 있는 파일이 조용히 사라지지 않는다.
        let by_name =
            search_project_files(&app_data, &root, "index.js", None, false).expect("by name");
        assert!(by_name
            .entries
            .iter()
            .any(|hit| hit.entry.relative_path == "node_modules/pkg/index.js"));

        // 이름이 겹치는 사용자 폴더는 제외되지 않는다.
        assert!(is_excluded_content_path("node_modules/pkg/index.js"));
        assert!(!is_excluded_content_path("src/targeting/rule.rs"));
    }

    /// F4. 검색 결과 줄은 목록의 칸을 그대로 펼쳐 싣고 거기에 세 칸을 더한다 —
    /// `gitStatus`·`modifiedAt`·`inOverlay`. 2026-10-02 측정: 이 시험이 없던 동안 결과는
    /// `DocumentEntry` 배열이었고, 화면이 "이 파일이 바뀌었나"를 알려면 검색과 별도로
    /// `get_project_git_status` 전체를 받아 경로로 맞춰야 했다.
    ///
    /// 두 가지를 함께 못박는다. (1) 저장소가 아닌 폴더에서는 `gitStatusAvailable`이 거짓이고
    /// 모든 줄의 `gitStatus`가 null이다 — "변경 없음"으로 꾸미지 않는다. git이 없거나
    /// `git status`가 실패해도 검색 자체는 성공해야 하므로 이 경로가 오류가 되지 않는 것도
    /// 같이 고정한다. (2) `inOverlay`는 overlay 어댑터(C19)가 서기 전까지 언제나 거짓이다.
    /// 칸을 미리 두되 값을 지어내지 않는다는 뜻이고, O1이 설 때 이 단언이 그 자리를 가리킨다.
    /// 평탄화도 함께 본다: 응답 JSON에 `relativePath`가 중첩 없이 그대로 있어야 화면이
    /// 트리에서 쓰던 칸을 다시 배우지 않는다.
    #[test]
    fn project_files_search_hits_carry_git_status_and_overlay_flag() {
        let (_dir, root, app_data) = project();
        let page = search_project_files(&app_data, &root, "main.rs", None, false).expect("search");
        let hit = page.entries.first().expect("검색 결과가 비었다");
        assert_eq!(hit.entry.relative_path, "src/main.rs");
        assert_eq!(hit.modified_at, hit.entry.modified_at);
        assert!(
            !hit.in_overlay,
            "overlay 세트를 하나도 저장하지 않았는데 inOverlay가 참이다"
        );
        assert!(
            !page.git_status_available,
            "저장소가 아닌 폴더인데 git 상태를 읽었다고 말한다"
        );
        assert!(page.entries.iter().all(|hit| hit.git_status.is_none()));

        let encoded = serde_json::to_string(&page).expect("serialize");
        assert!(
            encoded.contains("\"relativePath\":\"src/main.rs\""),
            "검색 줄이 평탄화되지 않았다: {encoded}"
        );
        assert!(encoded.contains("\"inOverlay\":false"));
        assert!(encoded.contains("\"gitStatus\":null"));
    }

    /// 2026-10-04. 검색 줄의 `inOverlay`가 **실제 overlay 장부를 보고** 정해지는지 고정한다
    /// (F4, C19-1).
    ///
    /// 이 칸은 C19가 서기 전에 `in_overlay: false` 상수로 못박혀 있었고, "O1이 서면 그 자리에서
    /// 바꾼다"는 주석만 남아 있었다. C19·O1이 선 뒤에도 상수는 그대로였다 — 점검표의 F4
    /// (타입에 칸이 있다·화면이 그 칸을 쓴다)는 셋 다 녹색인데 제품은 모든 파일을 "overlay
    /// 아님"으로 답하고 있었다. 측정이 통과하는데 기능이 없는 자리다.
    ///
    /// 고정하는 것 셋: 세트에 담은 경로만 참이고, 같은 폴더의 다른 파일은 거짓이며, 세트를
    /// **저장하기 전**에는 같은 검색이 전부 거짓이다. 셋째가 "항상 참"으로 뒤집는 반대 방향의
    /// 상수를 잡는다.
    ///
    /// git을 띄우지 않는 것도 일부러다. overlay 장부 조회는 git 없이 답하도록 만들어져 있어
    /// (C19-1), 저장소가 아닌 폴더에서도 이 칸은 사실대로 나와야 한다.
    #[test]
    fn project_files_search_marks_paths_registered_in_an_overlay_set() {
        let (_dir, root, app_data) = project();
        // 세트에 담지 않은 같은 확장자 파일. 없으면 "전부 참"으로 뒤집어도 시험이 통과한다.
        fs::write(
            root.join("src/other.rs"),
            "pub fn other() {}
",
        )
        .expect("other");

        let before =
            search_project_files(&app_data, &root, "main.rs", None, false).expect("before");
        assert!(
            before.entries.iter().all(|hit| !hit.in_overlay),
            "세트를 저장하기 전인데 inOverlay가 참인 줄이 있다"
        );

        let receipt = crate::project_overlays::save_project_overlay_set(
            &app_data,
            &root,
            &crate::project_overlays::SaveProjectOverlaySetRequest {
                project_path: root.to_string_lossy().into_owned(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["src/main.rs".to_owned()],
            },
        )
        .expect("세트 저장");
        assert!(receipt.succeeded, "{}", receipt.message);

        let page = search_project_files(&app_data, &root, ".rs", None, false).expect("search");
        let marked: Vec<&str> = page
            .entries
            .iter()
            .filter(|hit| hit.in_overlay)
            .map(|hit| hit.entry.relative_path.as_str())
            .collect();
        assert_eq!(
            marked,
            vec!["src/main.rs"],
            "세트에 담은 경로만 표시되어야 한다: {:?}",
            page.entries
                .iter()
                .map(|hit| (hit.entry.relative_path.as_str(), hit.in_overlay))
                .collect::<Vec<_>>()
        );
        assert!(
            page.entries.len() > marked.len(),
            "비교 대상이 될 다른 파일이 결과에 없어 시험이 공허하다"
        );

        let encoded = serde_json::to_string(&page).expect("serialize");
        assert!(encoded.contains("\"inOverlay\":true"), "{encoded}");
    }

    /// 2026-10-04. 프로젝트가 저장소의 **하위 폴더**일 때 `inOverlay`가 어느 기준으로
    /// 맞춰지는지 고정한다(F4, C19-1, C16-1).
    ///
    /// 앞 시험(`..._marks_paths_registered_in_an_overlay_set`)은 프로젝트가 곧 저장소 루트인
    /// 폴더에서 돌아 두 기준이 같은 문자열이라, 기준을 틀려도 통과한다. 실제로 그랬다 —
    /// 구현은 세트 경로를 **프로젝트 루트 기준**으로 보고 검색 줄의 상대 경로와 그대로
    /// 비교했고, 그 전제는 "세트를 저장할 때 `validate_repo_path`에 넘긴 루트가 등록 프로젝트
    /// 루트"라는 사실에서 나왔다.
    ///
    /// 실측으로 뒤집혔다. 세트에 담기는 경로는 `ProjectOverlayPanel`이 `git status`의 변경
    /// 목록에서 그대로 가져오고(저장소 루트 기준), 스냅샷과 적용은 그 경로를 저장소 최상위에서
    /// 도는 git에 pathspec으로 넘긴다. `validate_repo_path`는 경로를 **변환하지 않고** 받기만
    /// 하므로 그 호출의 루트는 기준을 정하지 못한다. 그래서 하위 폴더 프로젝트에서는 어떤
    /// 파일도 overlay로 표시되지 않았다 — 점검표 F4 세 점검은 전부 녹색인 채로.
    ///
    /// 두 방향을 함께 못박는다. 저장소 루트 기준 경로(`app/src/main.rs`)는 표시되고, 예전
    /// 구현이 기대하던 프로젝트 루트 기준 경로(`src/main.rs`)는 표시되지 않는다. 둘째가 없으면
    /// "둘 다 맞춰 본다"는 느슨한 구현이 그대로 통과한다.
    ///
    /// 쓰는 동안 **두 번째 결함**이 같은 자리에서 드러났다. 기준을 맞춰도 offset이 비어 있었는데,
    /// 디스패처가 넘기는 `root`는 정규화된 Windows 경로(`\\?\C:\...`)이고
    /// `GitStatus::project_path`는 `child_facing` 표기라 `strip_prefix`가 **언제나** 실패했기
    /// 때문이다. 그래서 하위 폴더 프로젝트에서는 overlay 칸뿐 아니라 git 상태 칸도 늘 비어
    /// 있었다 — 그 칸도 이 시험이 함께 못박는다.
    #[test]
    fn project_files_overlay_flag_uses_repository_root_paths_in_a_subfolder_project() {
        let Ok(executable) = crate::providers::resolve_named_executable(&["git"]) else {
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = fs::canonicalize(dir.path())
            .expect("canonical")
            .join("repo");
        let root = repo.join("app");
        let app_data = fs::canonicalize(dir.path())
            .expect("canonical")
            .join("app-data");
        fs::create_dir_all(root.join("src")).expect("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::write(
            root.join("src/main.rs"),
            "fn main() {}
",
        )
        .expect("main");
        fs::write(
            root.join("src/other.rs"),
            "pub fn other() {}
",
        )
        .expect("other");
        let git = |args: &[&str]| {
            std::process::Command::new(&executable)
                .args(args)
                .current_dir(&repo)
                .env(
                    "GIT_CONFIG_GLOBAL",
                    if cfg!(windows) { "NUL" } else { "/dev/null" },
                )
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "AM Test")
                .env("GIT_AUTHOR_EMAIL", "am@test.invalid")
                .env("GIT_COMMITTER_NAME", "AM Test")
                .env("GIT_COMMITTER_EMAIL", "am@test.invalid")
                .output()
                .expect("git")
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["add", "-A"]).status.success());
        assert!(git(&["commit", "-q", "-m", "base"]).status.success());
        // overlay가 받는 것은 추적 파일의 unstaged 변경뿐이다(C19-3). 그 모양 그대로 만든다.
        fs::write(
            root.join("src/main.rs"),
            "fn main() { let port = 4000; }
",
        )
        .expect("edit");

        // 저장소 루트가 읽히지 않으면 이 시험이 묻는 것 자체가 성립하지 않는다.
        let probe = search_project_files(&app_data, &root, ".rs", None, false).expect("probe");
        if !probe.git_status_available {
            return;
        }
        // 같은 `offset`이 git 상태 칸도 맞춘다. 하위 폴더 프로젝트에서 이 칸이 비어 있던 것이
        // overlay 칸이 비어 있던 것과 같은 원인이다.
        assert_eq!(
            probe
                .entries
                .iter()
                .find(|hit| hit.entry.relative_path == "src/main.rs")
                .and_then(|hit| hit.git_status),
            Some(GitChangeKind::Modified),
            "하위 폴더 프로젝트에서 git 상태 칸이 비었다: {:?}",
            probe
                .entries
                .iter()
                .map(|hit| (hit.entry.relative_path.as_str(), hit.git_status))
                .collect::<Vec<_>>()
        );

        // 화면이 세트에 담는 경로는 `git status`가 준 저장소 루트 기준 경로다.
        let receipt = crate::project_overlays::save_project_overlay_set(
            &app_data,
            &root,
            &crate::project_overlays::SaveProjectOverlaySetRequest {
                project_path: root.to_string_lossy().into_owned(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["app/src/main.rs".to_owned()],
            },
        )
        .expect("세트 저장");
        assert!(receipt.succeeded, "{}", receipt.message);

        let page = search_project_files(&app_data, &root, ".rs", None, false).expect("search");
        let marked: Vec<&str> = page
            .entries
            .iter()
            .filter(|hit| hit.in_overlay)
            .map(|hit| hit.entry.relative_path.as_str())
            .collect();
        assert_eq!(
            marked,
            vec!["src/main.rs"],
            "저장소 루트 기준 경로를 담았는데 표시되지 않는다: {:?}",
            page.entries
                .iter()
                .map(|hit| (hit.entry.relative_path.as_str(), hit.in_overlay))
                .collect::<Vec<_>>()
        );
        assert!(
            page.entries.len() > marked.len(),
            "비교 대상이 될 다른 파일이 결과에 없어 시험이 공허하다"
        );

        // 반대 방향: 프로젝트 루트 기준 경로는 이 저장소에서 overlay 경로가 아니다.
        let receipt = crate::project_overlays::save_project_overlay_set(
            &app_data,
            &root,
            &crate::project_overlays::SaveProjectOverlaySetRequest {
                project_path: root.to_string_lossy().into_owned(),
                set_id: None,
                name: "프로젝트 기준".to_owned(),
                paths: vec!["src/other.rs".to_owned()],
            },
        )
        .expect("세트 저장");
        assert!(receipt.succeeded, "{}", receipt.message);

        let page = search_project_files(&app_data, &root, ".rs", None, false).expect("search");
        let marked: Vec<&str> = page
            .entries
            .iter()
            .filter(|hit| hit.in_overlay)
            .map(|hit| hit.entry.relative_path.as_str())
            .collect();
        assert_eq!(
            marked,
            vec!["src/main.rs"],
            "프로젝트 루트 기준 경로까지 overlay로 읽었다: {:?}",
            page.entries
                .iter()
                .map(|hit| (hit.entry.relative_path.as_str(), hit.in_overlay))
                .collect::<Vec<_>>()
        );
    }
}
