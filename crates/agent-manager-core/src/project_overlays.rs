//! 브랜치 독립 로컬 overlay 세트의 보관소(C19).
//!
//! 브랜치마다 다른 로컬 설정(디버그 플래그, 로컬 포트, 실험용 상수)을 브랜치를 옮길 때마다
//! 손으로 되돌리는 일을 없애는 기능이다. 이 모듈이 맡는 것은 그 기능의 **세트 장부**다 —
//! 어느 저장소의 어느 파일을 overlay로 다룰지 적어 두고, 조회하고, 지운다. 작업 트리를
//! 건드리는 스냅샷·적용은 아직 여기 없다.
//!
//! 세트는 `<app data>/git-overlays/<저장소 식별자>/<세트 id>/meta.json`에만 쓴다(C19-1).
//! 사용자 저장소 안에는 patch도 메타데이터도 잠금 파일도 두지 않는다 — 저장소 안에 두면 그
//! 파일이 브랜치를 따라다니고, overlay가 없애려던 문제를 overlay가 다시 만든다.
//!
//! patch 본문에는 파일 **내용**이 그대로 들어가므로 민감 경로는 등록 단계에서 사유와 함께
//! 거절한다(C19-2). 거절은 조용하지 않다 — 어느 경로가 어느 규칙에 걸렸는지 영수증에 싣는다.
//! G4가 금지하는 것은 Agent Manager 파일에 비밀값을 남기는 것이고, 앱 데이터 안의 patch가
//! 바로 그 파일이다.
//!
//! 이 모듈은 git을 띄우지 않는다. 세트 장부는 저장소가 잠겨 있거나 git이 없어도 읽고 쓸 수
//! 있어야 하고, C19-3이 이 예외에 더한 git 명령은 스냅샷·적용의 둘뿐이기 때문이다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app_data_file::{read_private_json, write_private_json};
use crate::project_git::{
    pathspec_payload, validate_repo_path, BusyGuard, GitRunner, LOCAL_MUTATION_TIMEOUT,
};
use crate::CoreError;

/// 세트 장부가 쌓이는 앱 데이터 아래 한 폴더. 이름을 바꾸면 기존 세트가 보이지 않으므로
/// 상수 하나로 둔다(C19-1).
const OVERLAY_ROOT: &str = "git-overlays";

/// 삭제한 세트가 가는 앱 소유 휴지통(C3-11, C19-5). patch는 사용자 로컬 데이터라 지우면 그
/// 변경의 유일한 사본이 사라진다. 그래서 지우지 않고 옮긴다.
const OVERLAY_TRASH: &str = ".trash";

const META_FILE: &str = "meta.json";
const MANIFEST_FILE: &str = "manifest.json";

const OVERLAY_SCHEMA_VERSION: u32 = 1;

/// patch 하나가 가질 수 있는 최대 크기. 로컬 설정 변경을 담는 용도라 넉넉하되 유한하다.
const MAX_PATCH_BYTES: u64 = 16 * 1024 * 1024;

/// 저장소 하나가 가질 수 있는 세트 수. 브랜치마다 하나씩 두고도 남으면서, 조회마다 훑는
/// 폴더가 무한정 자라지 않게 한다.
const MAX_SETS_PER_REPOSITORY: usize = 64;

/// 세트 하나가 담는 경로 수. git 어댑터의 요청당 경로 상한보다 작게 잡는다 — overlay는
/// 손으로 고른 설정 파일 몇 개를 위한 것이지 트리 전체를 위한 것이 아니다.
const MAX_PATHS_PER_SET: usize = 200;

const MAX_NAME_CHARS: usize = 120;

/// 경로에 걸리면 등록을 거절하는 조각(C19-2). 파일명·폴더명 어느 성분에 걸려도 거절이다 —
/// `config/credentials/aws.json`처럼 폴더 쪽에만 있는 경우가 오히려 흔하다.
///
/// v1은 예외 등록을 제공하지 않는다. 거절 사유만 보여 주고, 민감 경로를 overlay에 넣는 길은
/// 열지 않는다.
const SENSITIVE_FRAGMENTS: &[&str] = &[
    ".env",
    "credential",
    "credentials",
    "secrets",
    ".npmrc",
    ".netrc",
];

/// 확장자나 접두어로 걸리는 민감 파일명(C19-2).
const SENSITIVE_SUFFIXES: &[&str] = &[".pem", ".key"];
const SENSITIVE_PREFIXES: &[&str] = &["id_"];

// ---------------------------------------------------------------------------
// 모양
// ---------------------------------------------------------------------------

/// 세트가 지금 어떤 상태인지. 장부만 있는 단계와 patch가 떠 있는 단계를 가른다 —
/// 적용·되돌림은 patch가 있을 때만 의미가 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectOverlayState {
    /// 대상 경로만 등록돼 있고 아직 뜬 patch가 없다.
    Registered,
    /// patch를 떠 두었고 작업 트리는 HEAD 원본이다.
    Stored,
    /// patch를 작업 트리에 적용해 둔 상태다.
    Applied,
}

/// overlay 세트 하나의 메타데이터(C19-1). 파일 내용과 patch 본문은 여기 들어가지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlaySet {
    pub schema_version: u32,
    pub set_id: String,
    pub name: String,
    /// 앱 데이터 아래 폴더 이름이 되는 저장소 식별자. 단일 경로 성분이다(C3-6).
    pub repository_id: String,
    /// 정규화한 저장소 루트. 식별자가 어느 저장소의 것인지 사람이 확인하는 자리다.
    pub repository_root: String,
    /// 저장소 루트 기준 상대 경로. `.git` 성분과 pathspec 매직은 이미 걸러진 뒤다(C16-5).
    pub paths: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// patch를 뜰 때의 기준 HEAD. 아직 뜨지 않았으면 null이다.
    pub base_head: Option<String>,
    pub snapshot_id: Option<String>,
    /// 저장한 patch의 SHA-256. 적용 시점에 같은 patch인지 확인한다(C19-5).
    pub patch_digest: Option<String>,
    pub state: ProjectOverlayState,
}

/// 거절한 경로 하나와 그 사유(C19-2, C19-5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayRejection {
    pub path: String,
    pub reason: String,
}

/// 한 저장소의 세트 목록. 화면은 프로젝트 단위로 묻고 답은 저장소 단위다 — 프로젝트가
/// 저장소의 하위 폴더여도 overlay는 저장소에 매인다(C16-1과 같은 기준).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlaySets {
    pub schema_version: u32,
    pub repository_id: String,
    pub repository_root: String,
    pub sets: Vec<ProjectOverlaySet>,
    /// 읽지 못한 세트 폴더. 조용히 빼면 화면에서 사라진 세트를 사용자가 지울 수도 없다.
    pub unreadable: Vec<String>,
}

/// overlay 변경 하나의 결과(C19-5). C16-6과 같은 모양이라 화면이 git 영수증과 같은 틀로
/// 그린다. patch 본문도 파일 내용도 싣지 않는다(G4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayReceipt {
    pub action: String,
    pub succeeded: bool,
    pub outcome: ProjectOverlayOutcome,
    pub message: String,
    /// 되돌림의 기준점. 작업 트리를 건드리지 않는 변경에서는 둘 다 null이다.
    pub head_before: Option<String>,
    pub head_after: Option<String>,
    pub set_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub patch_digest: Option<String>,
    /// 검사 실패 시 충돌한 경로.
    pub affected: Vec<String>,
    pub rejected: Vec<ProjectOverlayRejection>,
    /// 앱이 시작한 작업인지 외부 Git 작업을 보고 내민 것인지.
    pub trigger: ProjectOverlayTrigger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectOverlayOutcome {
    Saved,
    Deleted,
    Rejected,
    /// patch를 떠서 보관하고 작업 트리를 HEAD 원본으로 되돌렸다(C19-3).
    Snapshotted,
    /// `git apply --check`가 통과했다. 검사만 했고 적용은 하지 않았다(C19-3).
    Applicable,
    /// patch를 작업 트리에 되돌려 넣었다(C19-3).
    Applied,
    /// 검사가 실패해 **아무것도 적용하지 않았다**. 충돌한 경로가 `affected`에 실린다.
    /// 이름을 직접 적는 이유는 화면과 시험이 이 문자열을 그대로 읽기 때문이다 — 변형 이름을
    /// 바꾼 사람이 여기서 멈춘다(C19-5).
    #[serde(rename = "overlayNeedsResolution")]
    OverlayNeedsResolution,
    /// 같은 저장소에서 다른 변경이 돌고 있어 아무것도 하지 않았다(C19-3).
    Busy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectOverlayTrigger {
    App,
    External,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayTarget {
    pub project_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectOverlaySetRequest {
    pub project_path: String,
    /// 기존 세트를 고칠 때만 채운다. 비우면 새 세트를 만든다.
    #[serde(default)]
    pub set_id: Option<String>,
    pub name: String,
    /// 저장소 루트 기준 상대 경로.
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotProjectOverlayRequest {
    pub project_path: String,
    pub set_id: String,
    /// 앱이 시작한 작업인지 외부 Git 작업을 보고 내민 것인지(C19-5). 비우면 `app`이다.
    #[serde(default)]
    pub trigger: Option<ProjectOverlayTrigger>,
}

/// 보관한 patch가 지금 작업 트리에 다시 적용될 수 있는지 묻는 요청(C19-3).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckProjectOverlayApplyRequest {
    pub project_path: String,
    pub set_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectOverlaySetRequest {
    pub project_path: String,
    pub set_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProjectOverlayRequest {
    pub project_path: String,
    pub set_id: String,
}

// ---------------------------------------------------------------------------
// 경로
// ---------------------------------------------------------------------------

/// 저장소 루트를 앱 데이터 아래 단일 경로 성분으로 옮긴다(C19-1, C3-6).
///
/// 이름만 쓰면 `~/a/web`과 `~/b/web`이 같은 폴더를 쓰고, 경로를 그대로 쓰면 성분이 여럿이
/// 된다. 그래서 읽을 수 있는 이름과 정규화 경로의 해시를 함께 쓴다 — 사람이 폴더를 열었을 때
/// 어느 저장소인지 알아볼 수 있고, 두 저장소가 겹치지도 않는다.
pub fn overlay_repository_id(repository_root: &Path) -> String {
    let canonical = repository_root.to_string_lossy().replace('\\', "/");
    let digest = Sha256::digest(canonical.as_bytes());
    let short: String = format!("{digest:x}").chars().take(16).collect();
    let name: String = repository_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if name.is_empty() {
        format!("repo-{short}")
    } else {
        format!("{name}-{short}")
    }
}

fn overlay_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(OVERLAY_ROOT)
}

fn repository_dir(app_data_dir: &Path, repository_id: &str) -> PathBuf {
    overlay_root(app_data_dir).join(repository_id)
}

/// 세트 id는 폴더 이름이 되므로 단일 경로 성분으로 검증한다(C3-6, G10). 생성은 UUID라
/// 이 규칙을 저절로 지키지만, 요청이 들고 온 id는 사용자 입력과 같은 급으로 본다.
fn validate_set_id(value: &str) -> Result<String, CoreError> {
    let id = value.trim();
    if id.is_empty() || id.len() > 64 {
        return Err(CoreError::InvalidInput(
            "세트 id가 비었거나 너무 깁니다".to_owned(),
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(CoreError::InvalidInput(format!(
            "세트 id로 쓸 수 없는 값입니다: {id}"
        )));
    }
    Ok(id.to_owned())
}

/// 경로가 민감 규칙에 걸리면 사유를 돌려준다(C19-2). 걸리지 않으면 `None`.
fn sensitive_reason(path: &str) -> Option<String> {
    let lowered = path.to_ascii_lowercase();
    for component in lowered.split('/') {
        if SENSITIVE_PREFIXES
            .iter()
            .any(|prefix| component.starts_with(prefix))
        {
            return Some(format!("비밀키로 보이는 이름입니다: {component}"));
        }
        if SENSITIVE_SUFFIXES
            .iter()
            .any(|suffix| component.ends_with(suffix))
        {
            return Some(format!("비밀키로 보이는 확장자입니다: {component}"));
        }
        for fragment in SENSITIVE_FRAGMENTS {
            if component.contains(fragment) {
                return Some(format!("민감 경로 규칙에 걸립니다: {fragment}"));
            }
        }
    }
    None
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/// 이 저장소의 overlay 세트 목록. git을 띄우지 않으므로 저장소가 잠겨 있어도 답한다.
pub fn list_project_overlay_sets(
    app_data_dir: &Path,
    repository_root: &Path,
) -> Result<ProjectOverlaySets, CoreError> {
    let repository_id = overlay_repository_id(repository_root);
    let dir = repository_dir(app_data_dir, &repository_id);
    let mut sets = Vec::new();
    let mut unreadable = Vec::new();
    if dir.is_dir() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            match read_private_json::<ProjectOverlaySet>(&entry.path().join(META_FILE)) {
                Ok(Some(set)) if set.schema_version == OVERLAY_SCHEMA_VERSION => sets.push(set),
                _ => unreadable.push(name),
            }
        }
    }
    sets.sort_by(|a, b| a.name.cmp(&b.name).then(a.set_id.cmp(&b.set_id)));
    unreadable.sort();
    Ok(ProjectOverlaySets {
        schema_version: OVERLAY_SCHEMA_VERSION,
        repository_root: repository_root.to_string_lossy().into_owned(),
        repository_id,
        sets,
        unreadable,
    })
}

// ---------------------------------------------------------------------------
// 변경
// ---------------------------------------------------------------------------

/// 세트를 만들거나 고친다. 경로 검증과 민감 경로 거절이 여기서 끝나므로, 뒤따르는 스냅샷은
/// 이미 걸러진 목록만 본다.
///
/// 거절한 경로가 하나라도 있으면 **아무것도 저장하지 않는다**. 일부만 담아 두면 사용자는
/// 자기가 고른 파일이 overlay에 들어갔다고 믿은 채 브랜치를 옮기게 된다.
pub fn save_project_overlay_set(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &SaveProjectOverlaySetRequest,
) -> Result<ProjectOverlayReceipt, CoreError> {
    let name = request.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "세트 이름은 1~{MAX_NAME_CHARS}자여야 합니다"
        )));
    }
    if request.paths.is_empty() {
        return Err(CoreError::InvalidInput(
            "overlay에 넣을 경로를 하나 이상 고르세요".to_owned(),
        ));
    }
    if request.paths.len() > MAX_PATHS_PER_SET {
        return Err(CoreError::InvalidInput(format!(
            "한 세트에는 경로를 {MAX_PATHS_PER_SET}개까지 담을 수 있습니다"
        )));
    }

    let mut paths: Vec<String> = Vec::new();
    let mut rejected: Vec<ProjectOverlayRejection> = Vec::new();
    for raw in &request.paths {
        // `.git` 성분·pathspec 매직·루트 밖 탈출은 git 어댑터와 같은 한 곳에서 거른다
        // (C16-5, G10). 규칙이 두 벌이 되면 한쪽만 고쳐지는 날이 온다.
        let path = match validate_repo_path(repository_root, raw) {
            Ok(path) => path,
            Err(error) => {
                rejected.push(ProjectOverlayRejection {
                    path: raw.trim().to_owned(),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        if let Some(reason) = sensitive_reason(&path) {
            rejected.push(ProjectOverlayRejection { path, reason });
            continue;
        }
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    if !rejected.is_empty() {
        return Ok(ProjectOverlayReceipt {
            action: "saveOverlaySet".to_owned(),
            succeeded: false,
            outcome: ProjectOverlayOutcome::Rejected,
            message: "overlay에 담을 수 없는 경로가 있어 저장하지 않았습니다".to_owned(),
            head_before: None,
            head_after: None,
            set_id: request.set_id.clone(),
            snapshot_id: None,
            patch_digest: None,
            affected: Vec::new(),
            rejected,
            trigger: ProjectOverlayTrigger::App,
        });
    }

    let repository_id = overlay_repository_id(repository_root);
    let dir = repository_dir(app_data_dir, &repository_id);
    let existing = list_project_overlay_sets(app_data_dir, repository_root)?;
    let now = now_seconds();
    let (set_id, created_at, base_head, snapshot_id, patch_digest, state) = match &request.set_id {
        Some(raw) => {
            let id = validate_set_id(raw)?;
            let previous = existing
                .sets
                .iter()
                .find(|set| set.set_id == id)
                .ok_or_else(|| {
                    CoreError::NotFound(format!("overlay 세트를 찾지 못했습니다: {id}"))
                })?;
            (
                id,
                previous.created_at,
                previous.base_head.clone(),
                previous.snapshot_id.clone(),
                previous.patch_digest.clone(),
                previous.state,
            )
        }
        None => {
            if existing.sets.len() >= MAX_SETS_PER_REPOSITORY {
                return Err(CoreError::InvalidInput(format!(
                    "저장소 하나에 overlay 세트는 {MAX_SETS_PER_REPOSITORY}개까지 둘 수 있습니다"
                )));
            }
            (
                Uuid::new_v4().to_string(),
                now,
                None,
                None,
                None,
                ProjectOverlayState::Registered,
            )
        }
    };

    let set = ProjectOverlaySet {
        schema_version: OVERLAY_SCHEMA_VERSION,
        set_id: set_id.clone(),
        name,
        repository_id: repository_id.clone(),
        repository_root: repository_root.to_string_lossy().into_owned(),
        paths,
        created_at,
        updated_at: now,
        base_head,
        snapshot_id: snapshot_id.clone(),
        patch_digest: patch_digest.clone(),
        state,
    };
    // staged write 뒤 atomic replace, 0600(C19-1). 쓰다 만 meta.json이 남으면 다음 조회에서
    // 그 세트가 통째로 사라진 것처럼 보인다.
    write_private_json(&dir.join(&set_id).join(META_FILE), &set)?;

    Ok(ProjectOverlayReceipt {
        action: "saveOverlaySet".to_owned(),
        succeeded: true,
        outcome: ProjectOverlayOutcome::Saved,
        message: format!("overlay 세트 '{}'을(를) 저장했습니다", set.name),
        head_before: None,
        head_after: None,
        set_id: Some(set_id),
        snapshot_id,
        patch_digest,
        affected: Vec::new(),
        rejected: Vec::new(),
        trigger: ProjectOverlayTrigger::App,
    })
}

/// 세트를 지운다 — 지우지 않고 앱 소유 휴지통으로 **옮긴다**(C19-5, C3-11).
///
/// patch는 캐시가 아니라 사용자 로컬 데이터라 다시 만들어 주는 주체가 없다. 지우면 그
/// 변경의 유일한 사본이 사라지므로, 되돌릴 자리를 남긴다. 매니페스트는 옮긴 **뒤에** 쓴다 —
/// 매니페스트 없는 폴더는 미완성이라 목록에 올리지 않는다(C3-11과 같은 순서).
pub fn delete_project_overlay_set(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &DeleteProjectOverlaySetRequest,
) -> Result<ProjectOverlayReceipt, CoreError> {
    let set_id = validate_set_id(&request.set_id)?;
    let repository_id = overlay_repository_id(repository_root);
    let source = repository_dir(app_data_dir, &repository_id).join(&set_id);
    let set: ProjectOverlaySet = read_private_json(&source.join(META_FILE))?
        .ok_or_else(|| CoreError::NotFound(format!("overlay 세트를 찾지 못했습니다: {set_id}")))?;

    let group = format!("{}-{}", now_seconds(), Uuid::new_v4());
    let trash = overlay_root(app_data_dir).join(OVERLAY_TRASH).join(&group);
    fs::create_dir_all(&trash)?;
    fs::rename(&source, trash.join(&set_id))?;
    write_private_json(
        &trash.join(MANIFEST_FILE),
        &serde_json::json!({
            "schemaVersion": OVERLAY_SCHEMA_VERSION,
            "repositoryId": repository_id,
            "repositoryRoot": set.repository_root,
            "setId": set_id,
            "name": set.name,
            "deletedAt": now_seconds(),
        }),
    )?;

    Ok(ProjectOverlayReceipt {
        action: "deleteOverlaySet".to_owned(),
        succeeded: true,
        outcome: ProjectOverlayOutcome::Deleted,
        message: format!("overlay 세트 '{}'을(를) 휴지통으로 옮겼습니다", set.name),
        head_before: None,
        head_after: None,
        set_id: Some(set_id),
        snapshot_id: set.snapshot_id,
        patch_digest: set.patch_digest,
        affected: Vec::new(),
        rejected: Vec::new(),
        trigger: ProjectOverlayTrigger::App,
    })
}

// ---------------------------------------------------------------------------
// 스냅샷 — patch를 먼저 쓰고 확인한 뒤에만 되돌린다(C19-3)
// ---------------------------------------------------------------------------

/// 왜 이 경로를 overlay에 담지 않았는지. 거절은 조용하지 않다 — 영수증에 그대로 싣는다(C19-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OverlayRejectionReason {
    /// 민감 경로. patch 본문에 내용이 들어가므로 애초에 담지 않는다(C19-2).
    Sensitive,
    /// HEAD에 아직 커밋이 없다. 되돌릴 원본 자체가 없다.
    UnbornHead,
    /// 추적되지 않는 파일. 되돌리면 내용이 사라지는데 `restore`는 그것을 복구하지 못한다.
    Untracked,
    /// 인덱스에 올라간 변경이 있다. `git diff`는 그것을 patch에 담지 않는데 `--worktree`
    /// 되돌림은 작업 트리에서 지운다 — patch 없는 소실이다.
    Staged,
    /// 작업 트리에서 지워진 파일.
    Deleted,
    /// 이름이 바뀐 파일.
    Rename,
    /// 모드만 바뀐 파일.
    ModeChange,
    /// 서브모듈.
    Submodule,
    /// 충돌 중인 파일.
    Conflicted,
    /// 심볼릭 링크.
    Symlink,
    /// 되돌릴 unstaged 변경이 없다.
    Unchanged,
}

impl OverlayRejectionReason {
    /// 영수증에 싣는 이름. 화면과 시험이 같은 문자열을 읽는다.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Sensitive => "sensitive",
            Self::UnbornHead => "unbornHead",
            Self::Untracked => "untracked",
            Self::Staged => "staged",
            Self::Deleted => "deleted",
            Self::Rename => "rename",
            Self::ModeChange => "modeChange",
            Self::Submodule => "submodule",
            Self::Conflicted => "conflicted",
            Self::Symlink => "symlink",
            Self::Unchanged => "unchanged",
        }
    }
}

/// 거절한 경로 하나와 그 사유.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OverlayRejection {
    pub(crate) path: String,
    pub(crate) reason: OverlayRejectionReason,
}

/// 저장이 끝난 patch. 본문은 담지 않는다 — 영수증과 메타데이터에 파일 내용이 들어가는 길을
/// 열지 않기 위해서다(C19-5, G4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredOverlayPatch {
    /// 저장한 patch의 SHA-256. 재적용 시점에 같은 patch인지 확인하는 값이다.
    pub(crate) patch_digest: String,
    /// 디스크에 남은 바이트 수.
    pub(crate) patch_bytes: u64,
}

/// 스냅샷 한 번의 결말. `head_before`/`head_after`는 되돌림의 기준점이다(C19-5, C16-6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OverlaySnapshotOutcome {
    pub(crate) snapshot_id: String,
    pub(crate) patch: StoredOverlayPatch,
    pub(crate) head_before: Option<String>,
    pub(crate) head_after: Option<String>,
    /// 담긴 경로. 거절된 것은 여기 없다.
    pub(crate) captured: Vec<String>,
    /// 거절한 경로와 사유(C19-2, C19-5).
    pub(crate) rejected: Vec<OverlayRejection>,
    /// 되돌림까지 끝났는지. patch만 남고 작업 트리는 그대로인 경우와 구분한다.
    pub(crate) restored: bool,
}

/// 스냅샷 요청의 결말. 다른 git 변경과 겹치면 아무것도 하지 않고 `busy`를 돌려준다(C19-3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OverlaySnapshotResult {
    Snapshot(Box<OverlaySnapshotOutcome>),
    /// 담을 수 있는 경로가 하나도 없었다. 작업 트리는 손대지 않았다.
    Rejected(Vec<OverlayRejection>),
    Busy,
}

/// v1이 담을 수 있는 것은 **HEAD에 있는 추적된 일반 파일의 unstaged 변경**뿐이다(C19-3).
/// 나머지는 사유와 함께 거절한다. 판정은 git의 porcelain 출력과 인덱스 모드 비트로 한다 —
/// 파일시스템을 다시 보면 git이 보는 것과 어긋날 수 있다.
fn classify_overlay_paths(
    runner: &GitRunner,
    paths: &[String],
    head_present: bool,
) -> Result<(Vec<String>, Vec<OverlayRejection>), CoreError> {
    let mut captured = Vec::new();
    let mut rejected = Vec::new();
    if !head_present {
        for path in paths {
            rejected.push(OverlayRejection {
                path: path.clone(),
                reason: OverlayRejectionReason::UnbornHead,
            });
        }
        return Ok((captured, rejected));
    }
    // 요청 경로를 먼저 검증한다. 판정에 쓰지는 않지만 `.git` 성분·pathspec 매직·루트 밖
    // 경로는 여기서 걸러야 한다(C16-5, G10) — 뒤의 되돌림이 같은 목록으로 만들어지기 때문이다.
    let _validated = pathspec_payload(runner.overlay_lock_key(), paths)?;
    // 2026-10-02 실측: `status`와 `ls-files`는 `--pathspec-from-file`을 **받지 않는다**
    // (`error: unknown option`, git 2.45). 그 옵션을 받는 것은 add·restore·diff 쪽뿐이다.
    // 경로를 argv로 옮기는 길은 C16-5가 막으므로, 두 읽기는 pathspec 없이 저장소 전체를 읽고
    // 요청 경로를 그 출력에서 찾는다. 출력이 상한에 걸려 잘리면 찾지 못한 경로는 `unchanged`
    // 또는 `untracked`로 **거절**되므로, 잘림은 담기지 않는 쪽으로 기운다.
    let status = runner.overlay_read_with_input(
        &[
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
        None,
        LOCAL_MUTATION_TIMEOUT,
    )?;
    if !status.success {
        return Err(CoreError::Runtime(
            "작업 트리 상태를 읽지 못했습니다".to_owned(),
        ));
    }
    let index = runner.overlay_read_with_input(
        &["ls-files", "--stage", "-z"],
        None,
        LOCAL_MUTATION_TIMEOUT,
    )?;
    for raw in paths {
        let path = raw.trim().replace('\\', "/");
        let reason = if sensitive_reason(&path).is_some() {
            Some(OverlayRejectionReason::Sensitive)
        } else {
            index_reason(&index.stdout, &path).or_else(|| status_reason(&status.stdout, &path))
        };
        match reason {
            Some(reason) => rejected.push(OverlayRejection { path, reason }),
            None => captured.push(path),
        }
    }
    Ok((captured, rejected))
}

/// 인덱스 모드 비트로 가리는 것: 서브모듈(160000)과 심볼릭 링크(120000), 그리고 추적되지
/// 않아 인덱스에 아예 없는 경로.
fn index_reason(stdout: &str, path: &str) -> Option<OverlayRejectionReason> {
    for record in stdout.split('\0').filter(|record| !record.is_empty()) {
        // `<mode> <sha> <stage>\t<path>`
        let Some((meta, name)) = record.split_once('\t') else {
            continue;
        };
        if name != path {
            continue;
        }
        let mut fields = meta.split_whitespace();
        let mode = fields.next().unwrap_or_default();
        let stage = fields.nth(1).unwrap_or("0");
        if stage != "0" {
            return Some(OverlayRejectionReason::Conflicted);
        }
        return match mode {
            "160000" => Some(OverlayRejectionReason::Submodule),
            "120000" => Some(OverlayRejectionReason::Symlink),
            _ => None,
        };
    }
    Some(OverlayRejectionReason::Untracked)
}

/// porcelain 두 글자로 가리는 것. 통과하는 것은 `' M'` 하나뿐이다.
fn status_reason(stdout: &str, path: &str) -> Option<OverlayRejectionReason> {
    for record in stdout.split('\0').filter(|record| record.len() > 3) {
        let (code, name) = record.split_at(3);
        if name != path {
            continue;
        }
        let mut chars = code.chars();
        let index = chars.next().unwrap_or(' ');
        let worktree = chars.next().unwrap_or(' ');
        return match (index, worktree) {
            ('?', _) => Some(OverlayRejectionReason::Untracked),
            ('U', _) | (_, 'U') => Some(OverlayRejectionReason::Conflicted),
            ('R', _) => Some(OverlayRejectionReason::Rename),
            (_, 'D') => Some(OverlayRejectionReason::Deleted),
            (_, 'T') => Some(OverlayRejectionReason::ModeChange),
            (' ', 'M') => None,
            _ => Some(OverlayRejectionReason::Staged),
        };
    }
    // porcelain에 줄이 없다는 것은 바뀐 것이 없다는 뜻이다.
    Some(OverlayRejectionReason::Unchanged)
}

/// patch 파일이 놓일 자리. `<app data>/git-overlays/<저장소 식별자>/<세트 id>/overlay.patch`.
///
/// 저장소 식별자와 세트 id는 폴더 이름이 되므로 단일 경로 성분이어야 한다(C19-1, C3-6, G10).
/// 하나라도 성분을 벗어나면 patch가 앱 데이터 밖으로 나가고, 그 순간 이 모듈은 임의 경로에
/// 파일을 쓰는 기능이 된다. 판정은 세트 장부가 이미 쓰는 `validate_set_id` 하나로 한다.
pub(crate) fn overlay_patch_path(
    app_data_dir: &Path,
    repository_id: &str,
    snapshot_id: &str,
) -> Result<PathBuf, CoreError> {
    let repository_id = validate_set_id(repository_id)?;
    let snapshot_id = validate_set_id(snapshot_id)?;
    Ok(repository_dir(app_data_dir, &repository_id)
        .join(snapshot_id)
        .join("overlay.patch"))
}

/// 1단계. 선택된 경로의 unstaged 변경을 patch로 떠서 `patch_path`에 **직접** 쓴다.
///
/// 경로를 stdin으로 넘기지 못하는 유일한 자리다. 2026-10-02 실측(git 2.45): `--pathspec-from-file`
/// 을 받는 것은 add·restore·rm·commit·reset 쪽이고 `diff`는 `error: invalid option`으로 거절한다.
/// 인덱스를 건드리지 않고 unstaged 변경만 뜨는 다른 명령이 없으므로, 여기서는 `--`(`end-of-options`
/// 역할) 뒤에 operand로 넘긴다. C16-5가 argv를 피하는 이유 둘 — 옵션 주입과 `ps` 노출 — 중
/// 앞의 것은 `--` + C16-2의 `--literal-pathspecs` + `validate_repo_path`(선행 `-`·pathspec
/// 매직·`.git` 성분 거절)가 이미 닫았고, 뒤의 것은 사용자가 직접 고른 설정 파일의 상대 경로라
/// 비밀이 아니다. 되돌림(`restore`)은 stdin 경로를 그대로 쓴다.
pub(crate) fn write_overlay_patch(
    runner: &GitRunner,
    patch_path: &Path,
    paths: &[String],
) -> Result<(), CoreError> {
    if let Some(parent) = patch_path.parent() {
        fs::create_dir_all(parent).map_err(CoreError::Io)?;
    }
    // 2026-10-02 실측: 앱 데이터 경로는 `fs::canonicalize`를 거치면 Windows 확장 길이 형식
    // (`\\?\C:\...`)이 되고, 그대로 넘기면 git이 `could not open '//?/C:/...': Invalid
    // argument`로 거절한다. 자식에게 넘기는 경로는 이 저장소의 다른 자리와 같은 변환을
    // 지난다(`path_guard::child_facing`).
    let output = format!(
        "--output={}",
        crate::path_guard::child_facing(patch_path).to_string_lossy()
    );
    let mut args = vec!["diff", "--binary", "--full-index", output.as_str(), "--"];
    args.extend(paths.iter().map(String::as_str));
    let outcome = runner.overlay_read_with_input(&args, None, LOCAL_MUTATION_TIMEOUT)?;
    if !outcome.success {
        // 실패한 쓰기가 반쯤 남는 길을 닫는다. 작업 트리는 아직 손대지 않았다.
        let _ = fs::remove_file(patch_path);
        return Err(CoreError::Runtime(format!(
            "overlay patch를 뜨지 못했습니다: {}",
            outcome.stderr.lines().next().unwrap_or("").trim()
        )));
    }
    Ok(())
}

/// 2단계. 디스크에 남은 patch를 다시 읽어 digest를 낸다. 되돌림의 전제조건이다.
pub(crate) fn verify_stored_patch(patch_path: &Path) -> Result<StoredOverlayPatch, CoreError> {
    let metadata = fs::metadata(patch_path).map_err(CoreError::Io)?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "overlay patch가 일반 파일이 아닙니다".to_owned(),
        ));
    }
    if metadata.len() == 0 {
        return Err(CoreError::InvalidInput(
            "되돌릴 변경이 없습니다 — 빈 patch로는 작업 트리를 바꾸지 않습니다".to_owned(),
        ));
    }
    if metadata.len() > MAX_PATCH_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "overlay patch가 너무 큽니다({}바이트, 상한 {MAX_PATCH_BYTES})",
            metadata.len()
        )));
    }
    let bytes = fs::read(patch_path).map_err(CoreError::Io)?;
    Ok(StoredOverlayPatch {
        patch_digest: format!("{:x}", Sha256::digest(&bytes)),
        patch_bytes: bytes.len() as u64,
    })
}

/// 3단계. 선택된 경로만 HEAD 원본으로 되돌린다.
///
/// `git checkout`이 아니라 `restore`인 이유는 범위가 좁기 때문이다(C19-3). `--source=HEAD`는
/// 무엇으로 되돌리는지를 못박고, `--worktree`는 인덱스를 건드리지 않는다는 뜻이다.
pub(crate) fn restore_worktree_from_head(
    runner: &GitRunner,
    pathspec_payload: &[u8],
) -> Result<(), CoreError> {
    let outcome = runner.overlay_write_with_input(
        &[
            "restore",
            "--source=HEAD",
            "--worktree",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        Some(pathspec_payload),
        LOCAL_MUTATION_TIMEOUT,
    )?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "작업 트리를 HEAD 원본으로 되돌리지 못했습니다: {}",
            outcome.stderr.lines().next().unwrap_or("").trim()
        )));
    }
    Ok(())
}

/// 세 단계를 그 순서로만 묶는 하나뿐인 입구.
///
/// 되돌림을 부르는 다른 길을 두지 않는 것이 요점이다 — [`restore_worktree_from_head`]를
/// 저장 없이 부를 수 있게 두면 C19가 연 조건이 코드에서는 선택이 된다. 그래서 자격 판정
/// (C19-2 민감 경로, C19-3 지원 상태)과 저장소 단위 잠금(C19-3)도 이 함수 안에 있다.
pub(crate) fn snapshot_patch_then_restore(
    runner: &GitRunner,
    app_data_dir: &Path,
    repository_id: &str,
    snapshot_id: &str,
    paths: &[String],
) -> Result<OverlaySnapshotResult, CoreError> {
    // 저장 자리는 호출부가 고르지 않는다. patch가 앱 데이터 밖에 놓일 수 있다면 "앱 데이터에만
    // 쓴다"는 C19-1은 호출부마다 다시 지켜야 하는 약속이 된다.
    let patch_path = overlay_patch_path(app_data_dir, repository_id, snapshot_id)?;
    let patch_path = patch_path.as_path();
    // C16-3의 저장소 단위 잠금을 git 어댑터와 **공유**한다. overlay 되돌림과 `git` 변경이
    // 서로를 가로지르면 둘 다 자기 영수증의 `head_before`를 믿을 수 없게 된다.
    let Some(_guard) = BusyGuard::acquire(runner.overlay_lock_key()) else {
        return Ok(OverlaySnapshotResult::Busy);
    };
    let head_before = runner.overlay_head_sha()?;
    let (captured, rejected) = classify_overlay_paths(runner, paths, head_before.is_some())?;
    if captured.is_empty() {
        // 담을 것이 없으면 patch도 없고, patch가 없으면 되돌리지 않는다.
        return Ok(OverlaySnapshotResult::Rejected(rejected));
    }
    let payload = pathspec_payload(runner.overlay_lock_key(), &captured)?;
    write_overlay_patch(runner, patch_path, &captured)?;
    let patch = verify_stored_patch(patch_path)?;
    restore_worktree_from_head(runner, &payload)?;
    let head_after = runner.overlay_head_sha()?;
    Ok(OverlaySnapshotResult::Snapshot(Box::new(
        OverlaySnapshotOutcome {
            snapshot_id: snapshot_id.to_owned(),
            patch,
            head_before,
            head_after,
            captured,
            rejected,
            restored: true,
        },
    )))
}

/// 세트 하나를 스냅샷으로 뜬다 — 이 기능이 **작업 트리를 바꾸는 유일한 공개 입구**다.
///
/// 하는 일 자체는 [`snapshot_patch_then_restore`]가 이미 세 단계로 묶어 두었고, 여기서 더하는
/// 것은 그 세 단계를 바깥에서 부를 수 있게 하는 자리와 결말을 영수증으로 옮기는 일이다.
/// 세 단계를 거치지 않고 되돌림만 부르는 길은 여전히 없다 — 그것이 C19가 연 조건이
/// 코드에서도 조건으로 남는 이유다.
///
/// 결말은 오류가 아니라 영수증이다(C19-5). 겹친 호출은 `busy`, 담을 수 있는 경로가 없으면
/// `rejected`이고, 둘 다 작업 트리를 한 글자도 바꾸지 않는다.
pub fn snapshot_project_overlay(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &SnapshotProjectOverlayRequest,
) -> Result<ProjectOverlayReceipt, CoreError> {
    snapshot_project_overlay_with_env(app_data_dir, repository_root, request, Vec::new())
}

/// [`snapshot_project_overlay`]와 같은 일을 하되 git 자식 프로세스에 환경을 더 얹는다.
///
/// 시험이 사용자 전역 git 설정과 무관하게 돌기 위한 자리다(`overlay_test_env`). 제품 경로는
/// 위의 공개 함수가 빈 환경으로 부르므로 동작이 갈라지지 않는다.
pub(crate) fn snapshot_project_overlay_with_env(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &SnapshotProjectOverlayRequest,
    extra_env: Vec<(String, String)>,
) -> Result<ProjectOverlayReceipt, CoreError> {
    let set_id = validate_set_id(&request.set_id)?;
    let trigger = request.trigger.unwrap_or(ProjectOverlayTrigger::App);
    let repository_id = overlay_repository_id(repository_root);
    let dir = repository_dir(app_data_dir, &repository_id).join(&set_id);
    let mut set: ProjectOverlaySet = read_private_json(&dir.join(META_FILE))?
        .ok_or_else(|| CoreError::NotFound(format!("overlay 세트를 찾지 못했습니다: {set_id}")))?;
    let runner = GitRunner::open_with_env(app_data_dir, repository_root, extra_env)?;

    // patch는 세트 폴더 안에 둔다. 세트를 휴지통으로 옮기면 patch도 같이 간다(C19-5) —
    // 따로 두면 삭제가 "유일한 사본"을 남겨 두는 대신 흘린다.
    match snapshot_patch_then_restore(&runner, app_data_dir, &repository_id, &set_id, &set.paths)? {
        OverlaySnapshotResult::Busy => Ok(ProjectOverlayReceipt {
            action: "snapshotOverlay".to_owned(),
            succeeded: false,
            outcome: ProjectOverlayOutcome::Busy,
            message: "같은 저장소에서 다른 변경이 진행 중입니다. 끝난 뒤 다시 시도하세요"
                .to_owned(),
            head_before: None,
            head_after: None,
            set_id: Some(set_id),
            snapshot_id: None,
            patch_digest: None,
            affected: Vec::new(),
            rejected: Vec::new(),
            trigger,
        }),
        OverlaySnapshotResult::Rejected(rejections) => Ok(ProjectOverlayReceipt {
            action: "snapshotOverlay".to_owned(),
            succeeded: false,
            outcome: ProjectOverlayOutcome::Rejected,
            message: "담을 수 있는 변경이 없어 작업 트리를 되돌리지 않았습니다".to_owned(),
            head_before: None,
            head_after: None,
            set_id: Some(set_id),
            snapshot_id: None,
            patch_digest: None,
            affected: Vec::new(),
            rejected: rejections.into_iter().map(Into::into).collect(),
            trigger,
        }),
        OverlaySnapshotResult::Snapshot(outcome) => {
            // 장부는 되돌림이 끝난 **뒤에** 고친다. 먼저 고치면 되돌림이 실패했을 때 세트가
            // `stored`라고 주장하는데 작업 트리에는 변경이 그대로 남는다.
            set.base_head = outcome.head_before.clone();
            set.snapshot_id = Some(outcome.snapshot_id.clone());
            set.patch_digest = Some(outcome.patch.patch_digest.clone());
            set.state = ProjectOverlayState::Stored;
            set.updated_at = now_seconds();
            write_private_json(&dir.join(META_FILE), &set)?;
            Ok(ProjectOverlayReceipt {
                action: "snapshotOverlay".to_owned(),
                succeeded: true,
                outcome: ProjectOverlayOutcome::Snapshotted,
                message: format!(
                    "{}개 경로를 patch로 보관하고 작업 트리를 HEAD 원본으로 되돌렸습니다",
                    outcome.captured.len()
                ),
                head_before: outcome.head_before.clone(),
                head_after: outcome.head_after.clone(),
                set_id: Some(set_id),
                snapshot_id: Some(outcome.snapshot_id.clone()),
                patch_digest: Some(outcome.patch.patch_digest.clone()),
                affected: Vec::new(),
                rejected: outcome
                    .rejected
                    .clone()
                    .into_iter()
                    .map(Into::into)
                    .collect(),
                trigger,
            })
        }
    }
}

/// 재적용의 **앞단**. 보관한 patch가 지금 작업 트리에 들어갈 수 있는지만 묻는다(C19-3).
///
/// 작업 트리는 한 글자도 바뀌지 않는다. 이 함수가 도는 git 명령은 `apply --check` 하나이고,
/// 검사가 실패하면 적용으로 넘어가지 않고 `overlayNeedsResolution`과 충돌한 `affected` 경로를
/// 영수증에 실어 돌려준다 — 부분 적용과 3-way 자동 병합은 v1에 없다. 절반 적용된 작업 트리는
/// 이 기능이 되돌릴 수 없는 상태이고, 그 상태를 만들지 않는 것이 검사가 먼저 도는 이유다.
///
/// 검사는 쓰기가 아니므로 저장소 잠금(C16-3)을 잡지 않고, 게이트 없는 조회로 원격에도
/// 열린다(C19-4).
pub fn check_project_overlay_apply(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &CheckProjectOverlayApplyRequest,
) -> Result<ProjectOverlayReceipt, CoreError> {
    let set_id = validate_set_id(&request.set_id)?;
    let repository_id = overlay_repository_id(repository_root);
    let dir = repository_dir(app_data_dir, &repository_id).join(&set_id);
    let set: ProjectOverlaySet = read_private_json(&dir.join(META_FILE))?
        .ok_or_else(|| CoreError::NotFound(format!("overlay 세트를 찾지 못했습니다: {set_id}")))?;

    let Some(snapshot_id) = set.snapshot_id.clone() else {
        return Ok(check_rejected(
            set_id,
            None,
            None,
            "보관된 patch가 없어 검사할 것이 없습니다".to_owned(),
        ));
    };
    let patch_path = overlay_patch_path(app_data_dir, &repository_id, &snapshot_id)?;
    let stored = verify_stored_patch(&patch_path)?;
    // 장부가 적어 둔 digest와 디스크의 patch가 다르면 적용 대상이 무엇인지 알 수 없다.
    // 검사를 통과시키면 그다음 적용이 사용자가 보관한 적 없는 변경을 작업 트리에 넣는다.
    if set.patch_digest.as_deref() != Some(stored.patch_digest.as_str()) {
        return Ok(check_rejected(
            set_id,
            Some(snapshot_id),
            Some(stored.patch_digest),
            "보관 시점과 다른 patch입니다. 세트를 다시 스냅샷하세요".to_owned(),
        ));
    }
    let patch = fs::read(&patch_path).map_err(CoreError::Io)?;

    let runner = GitRunner::open(app_data_dir, repository_root)?;
    let head = runner.overlay_head_sha()?;
    // `--check`는 적용하지 않고 적용 가능 여부만 본다. `--binary`는 patch를 뜰 때와 같은
    // 모양으로 읽기 위한 것이고(C19-1), patch는 argv가 아니라 stdin으로만 들어간다(C16-5).
    let outcome = runner.overlay_read_with_input(
        &["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
        Some(&patch),
        LOCAL_MUTATION_TIMEOUT,
    )?;
    let applicable = outcome.success && !outcome.timed_out;
    let affected = if applicable {
        Vec::new()
    } else {
        affected_paths_from_apply_output(&format!("{}\n{}", outcome.stdout, outcome.stderr))
    };
    Ok(ProjectOverlayReceipt {
        action: "checkOverlayApply".to_owned(),
        succeeded: applicable,
        outcome: if applicable {
            ProjectOverlayOutcome::Applicable
        } else {
            ProjectOverlayOutcome::OverlayNeedsResolution
        },
        message: if applicable {
            "지금 작업 트리에 다시 적용할 수 있습니다".to_owned()
        } else if outcome.timed_out {
            "검사가 시간 안에 끝나지 않아 아무것도 적용하지 않았습니다".to_owned()
        } else {
            "지금 작업 트리에는 적용되지 않습니다. 충돌한 경로를 먼저 정리하세요".to_owned()
        },
        // 검사는 HEAD를 움직이지 않으므로 전후가 같다. 그래도 싣는 이유는 영수증 하나로
        // "어느 커밋 위에서 물었는가"를 되짚을 수 있어야 하기 때문이다(C19-5).
        head_before: head.clone(),
        head_after: head,
        set_id: Some(set_id),
        snapshot_id: Some(snapshot_id),
        patch_digest: Some(stored.patch_digest),
        affected,
        rejected: Vec::new(),
        trigger: ProjectOverlayTrigger::App,
    })
}

fn check_rejected(
    set_id: String,
    snapshot_id: Option<String>,
    patch_digest: Option<String>,
    message: String,
) -> ProjectOverlayReceipt {
    ProjectOverlayReceipt {
        action: "checkOverlayApply".to_owned(),
        succeeded: false,
        outcome: ProjectOverlayOutcome::Rejected,
        message,
        head_before: None,
        head_after: None,
        set_id: Some(set_id),
        snapshot_id,
        patch_digest,
        affected: Vec::new(),
        rejected: Vec::new(),
        trigger: ProjectOverlayTrigger::App,
    }
}

/// `git apply --check`가 실패하면서 댄 경로를 뽑는다(C19-5의 `affected`).
///
/// git은 같은 실패를 여러 문장으로 적으므로(`error: patch failed: a.txt:3`와
/// `error: a.txt: patch does not apply`) 중복을 없애고, 경로가 아닌 설명문은 거른 뒤
/// 상한에서 끊는다.
fn affected_paths_from_apply_output(output: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("error: ")
            .or_else(|| trimmed.strip_prefix("fatal: "))
        else {
            continue;
        };
        let candidate = if let Some(failed) = rest.strip_prefix("patch failed: ") {
            // `a.txt:3` 꼴. 뒤의 줄 번호를 뗀다.
            failed
                .rsplit_once(':')
                .map(|(path, _)| path)
                .unwrap_or(failed)
        } else if let Some((path, reason)) = rest.split_once(": ") {
            if reason.is_empty() {
                continue;
            }
            path
        } else {
            continue;
        };
        let candidate = candidate.trim();
        // 경로에 공백이 들어갈 수는 있지만, 공백이 든 조각은 거의 언제나 설명문이다.
        // 영수증은 사람에게 보여 줄 경로 목록이라 문장을 섞는 쪽이 더 나쁘다.
        if candidate.is_empty() || candidate.contains(' ') {
            continue;
        }
        if paths.iter().any(|known| known == candidate) {
            continue;
        }
        if paths.len() >= MAX_PATHS_PER_SET {
            break;
        }
        paths.push(candidate.to_owned());
    }
    paths
}

impl From<OverlayRejection> for ProjectOverlayRejection {
    fn from(rejection: OverlayRejection) -> Self {
        Self {
            path: rejection.path,
            reason: rejection.reason.as_str().to_owned(),
        }
    }
}

// ---------------------------------------------------------------------------
// 적용 — 검사가 통과할 때만 작업 트리에 되돌려 넣는다(C19-3)
// ---------------------------------------------------------------------------

/// 영수증에 실리는 행동 이름. 화면과 시험이 같은 문자열을 읽는다.
const APPLY_ACTION: &str = "applyOverlay";

/// `git apply --check`가 막았을 때 어느 경로가 막았는지.
///
/// git은 실패를 두 모양으로 적는다 — `error: patch failed: <경로>:<줄>`과
/// `error: <경로>: <사유>`. 둘 다 읽는다. 사유 문구는 싣지 않는다: 거기에는 충돌한 줄의
/// **내용**이 섞여 들어올 수 있고, 영수증에 파일 내용이 들어가는 길은 C19-5가 닫은 길이다.
fn apply_failure_paths(stderr: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for line in stderr.lines() {
        let Some(rest) = line.trim().strip_prefix("error: ") else {
            continue;
        };
        let candidate = match rest.strip_prefix("patch failed: ") {
            // `<경로>:<줄>` 꼬리를 뗀다. 경로 자체에 콜론이 있을 수 있으므로 **마지막**
            // 콜론만 보고, 그 뒤가 숫자일 때만 뗀다.
            Some(tail) => match tail.rsplit_once(':') {
                Some((path, line_no)) if line_no.chars().all(|c| c.is_ascii_digit()) => path,
                _ => tail,
            },
            None => match rest.split_once(": ") {
                Some((path, _reason)) => path,
                None => continue,
            },
        }
        .trim();
        if candidate.is_empty() || paths.iter().any(|seen| seen == candidate) {
            continue;
        }
        paths.push(candidate.to_owned());
        if paths.len() >= MAX_PATHS_PER_SET {
            break;
        }
    }
    paths
}

/// 저장해 둔 patch를 작업 트리에 되돌려 넣는다(C19-3).
///
/// 순서가 이 기능의 전부다. **검사가 먼저이고, 통과하지 못하면 아무것도 적용하지 않는다.**
/// `git apply`는 적용할 수 있는 조각만 먼저 쓰고 나머지에서 멈추는 일이 없도록 원자적으로
/// 동작하지만, 그 판정을 적용 시도 자체에 맡기면 실패한 요청과 성공한 요청이 같은 길을 지나게
/// 된다. 검사를 따로 돌리면 실패는 작업 트리를 **한 번도 열지 않은 채** 끝나고, 사용자는
/// 어느 경로가 막았는지만 받는다(`overlayNeedsResolution`).
///
/// 되돌릴 자리: patch는 앱 데이터에 그대로 남는다. 적용이 막혀도 세트는 `stored` 그대로라
/// 사용자가 충돌을 푼 뒤 같은 요청을 다시 부르면 된다(C19-5).
pub fn apply_project_overlay(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &ApplyProjectOverlayRequest,
) -> Result<ProjectOverlayReceipt, CoreError> {
    apply_project_overlay_with_env(app_data_dir, repository_root, request, Vec::new())
}

/// [`apply_project_overlay`]와 같은 일을 하되 git 자식 프로세스에 환경을 더 얹는다
/// (`snapshot_project_overlay_with_env`와 같은 이유).
pub(crate) fn apply_project_overlay_with_env(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &ApplyProjectOverlayRequest,
    extra_env: Vec<(String, String)>,
) -> Result<ProjectOverlayReceipt, CoreError> {
    let set_id = validate_set_id(&request.set_id)?;
    let repository_id = overlay_repository_id(repository_root);
    let meta_path = repository_dir(app_data_dir, &repository_id)
        .join(&set_id)
        .join(META_FILE);
    let set: ProjectOverlaySet = read_private_json(&meta_path)?
        .ok_or_else(|| CoreError::NotFound(format!("overlay 세트를 찾지 못했습니다: {set_id}")))?;

    match set.state {
        ProjectOverlayState::Stored => {}
        ProjectOverlayState::Registered => {
            return Err(CoreError::InvalidInput(
                "아직 뜬 patch가 없습니다 — 먼저 스냅샷을 뜨세요".to_owned(),
            ));
        }
        ProjectOverlayState::Applied => {
            return Err(CoreError::InvalidInput(
                "이미 적용된 세트입니다 — 다시 적용하려면 먼저 스냅샷을 뜨세요".to_owned(),
            ));
        }
    }
    let snapshot_id = set.snapshot_id.clone().ok_or_else(|| {
        CoreError::InvalidInput("세트에 스냅샷 id가 없어 patch를 찾지 못합니다".to_owned())
    })?;
    let expected_digest = set.patch_digest.clone().ok_or_else(|| {
        CoreError::InvalidInput("세트에 patch digest가 없어 적용할 수 없습니다".to_owned())
    })?;

    // 디스크의 patch가 저장 시점의 그 patch인지 **먼저** 본다. digest가 어긋난 patch를
    // 적용하면 사용자가 승인한 적 없는 변경이 작업 트리에 들어간다(C19-5).
    let patch_path = overlay_patch_path(app_data_dir, &repository_id, &snapshot_id)?;
    let stored = verify_stored_patch(&patch_path)?;
    if stored.patch_digest != expected_digest {
        return Err(CoreError::InvalidInput(
            "저장된 patch가 스냅샷 시점과 다릅니다 — 적용하지 않았습니다".to_owned(),
        ));
    }
    let patch_bytes = fs::read(&patch_path).map_err(CoreError::Io)?;

    let runner = GitRunner::open_with_env(app_data_dir, repository_root, extra_env)?;
    // C16-3의 저장소 단위 잠금을 git 어댑터와 공유한다. 적용과 `git` 변경이 서로를 가로지르면
    // 둘 다 자기 영수증의 `head_before`를 믿을 수 없게 된다(C19-3).
    let Some(_guard) = BusyGuard::acquire(runner.overlay_lock_key()) else {
        return Ok(ProjectOverlayReceipt {
            action: APPLY_ACTION.to_owned(),
            succeeded: false,
            outcome: ProjectOverlayOutcome::Busy,
            message: "이 저장소에서 다른 git 변경이 진행 중입니다. 끝난 뒤 다시 시도하세요"
                .to_owned(),
            head_before: None,
            head_after: None,
            set_id: Some(set_id),
            snapshot_id: Some(snapshot_id),
            patch_digest: Some(expected_digest),
            affected: Vec::new(),
            rejected: Vec::new(),
            trigger: ProjectOverlayTrigger::App,
        });
    };
    let head_before = runner.overlay_head_sha()?;

    // 1단계. 검사. patch는 argv가 아니라 stdin으로 넘긴다(C16-5) — 인수 자리에 경로를 두면
    // 그 경로가 `ps`에 남고, 여기서는 넘길 이유도 없다. `--check`는 아무것도 쓰지 않으므로
    // 읽기 갈래로 돈다.
    let checked = runner.overlay_read_with_input(
        &["apply", "--check"],
        Some(&patch_bytes),
        LOCAL_MUTATION_TIMEOUT,
    )?;
    if !checked.success {
        let affected = apply_failure_paths(&checked.stderr);
        let head_after = runner.overlay_head_sha()?;
        return Ok(ProjectOverlayReceipt {
            action: APPLY_ACTION.to_owned(),
            succeeded: false,
            outcome: ProjectOverlayOutcome::OverlayNeedsResolution,
            message: "지금 작업 트리에는 이 overlay를 적용할 수 없습니다. 막은 경로를 손으로                 푼 뒤 다시 적용하세요 — 작업 트리는 바뀌지 않았고 patch도 그대로입니다"
                .to_owned(),
            head_before,
            head_after,
            set_id: Some(set_id),
            snapshot_id: Some(snapshot_id),
            patch_digest: Some(expected_digest),
            affected,
            rejected: Vec::new(),
            trigger: ProjectOverlayTrigger::App,
        });
    }

    // 2단계. 검사를 통과했을 때만 적용한다.
    let applied =
        runner.overlay_write_with_input(&["apply"], Some(&patch_bytes), LOCAL_MUTATION_TIMEOUT)?;
    if !applied.success {
        return Err(CoreError::Runtime(format!(
            "overlay를 적용하지 못했습니다: {}",
            applied.stderr.lines().next().unwrap_or("").trim()
        )));
    }
    let head_after = runner.overlay_head_sha()?;

    // 장부는 적용이 끝난 **뒤에** 옮긴다. 먼저 옮기면 적용에 실패한 세트가 `applied`로 남아
    // 다음 요청이 거절된다.
    let updated = ProjectOverlaySet {
        state: ProjectOverlayState::Applied,
        updated_at: now_seconds(),
        ..set
    };
    write_private_json(&meta_path, &updated)?;

    Ok(ProjectOverlayReceipt {
        action: APPLY_ACTION.to_owned(),
        succeeded: true,
        outcome: ProjectOverlayOutcome::Applied,
        message: format!(
            "overlay 세트 '{}'을(를) 작업 트리에 적용했습니다",
            updated.name
        ),
        head_before,
        head_after,
        set_id: Some(updated.set_id.clone()),
        snapshot_id: Some(snapshot_id),
        patch_digest: Some(expected_digest),
        affected: Vec::new(),
        rejected: Vec::new(),
        trigger: ProjectOverlayTrigger::App,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-02. `git apply --check`가 막았을 때 **어느 경로가 막았는지만** 영수증에
    /// 싣는지 고정한다(C19-3, C19-5).
    ///
    /// 실측한 git stderr 두 모양을 그대로 넣는다 — `error: patch failed: <경로>:<줄>`과
    /// `error: <경로>: <사유>`. 한쪽만 읽으면 영수증의 `affected`가 비어 사용자는 무엇을
    /// 풀어야 하는지 알 수 없다. 사유 문구를 버리는 것도 일부러다: 거기에는 충돌한 줄의
    /// 내용이 섞여 들어올 수 있고, 파일 내용이 영수증에 들어가는 길은 C19-5가 닫았다.
    #[test]
    fn overlay_c19_apply_failure_names_only_the_blocking_paths() {
        let stderr = concat!(
            "error: patch failed: src/config.ts:12
",
            "error: src/config.ts: patch does not apply
",
            "error: docs/notes.md: does not exist in index
",
            "hint: Use 'git apply --3way' to attempt a merge
",
        );
        let affected = apply_failure_paths(stderr);
        assert_eq!(affected, vec!["src/config.ts", "docs/notes.md"]);
        assert!(
            !affected.iter().any(|path| path.contains("does not apply")),
            "사유 문구가 경로로 실렸다: {affected:?}"
        );
    }

    /// 2026-10-02. 적용이 **장부의 상태와 digest를 먼저 본 뒤에만** git에 닿는지 고정한다
    /// (C19-3, C19-5).
    ///
    /// 세트가 `registered`(아직 뜬 patch가 없다)인데도 git을 띄우면, 저장소가 없거나 잠겨
    /// 있을 때 "patch가 없다" 대신 git 오류가 돌아온다. 이 시험은 저장소가 **아닌** 폴더를
    /// 대상으로 주고도 사유가 patch 쪽 문구인지를 본다 — git을 먼저 띄웠다면 여기서 다른
    /// 문구가 나온다.
    #[test]
    fn overlay_c19_apply_refuses_a_set_with_no_stored_patch() {
        let temp = std::env::temp_dir().join(format!("overlay-c19-apply-{}", Uuid::new_v4()));
        let app_data = temp.join("app-data");
        let repository = temp.join("repository");
        fs::create_dir_all(&repository).expect("저장소 폴더");
        let receipt = save_project_overlay_set(
            &app_data,
            &repository,
            &SaveProjectOverlaySetRequest {
                project_path: repository.to_string_lossy().into_owned(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["src/config.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        let set_id = receipt.set_id.clone().expect("세트 id");

        let error = apply_project_overlay(
            &app_data,
            &repository,
            &ApplyProjectOverlayRequest {
                project_path: repository.to_string_lossy().into_owned(),
                set_id,
            },
        )
        .expect_err("patch 없는 세트는 거절한다");
        let message = error.to_string();
        assert!(
            message.contains("스냅샷"),
            "patch가 없다는 사유가 아니다: {message}"
        );

        let _ = fs::remove_dir_all(&temp);
    }

    /// 2026-10-02. 없는 세트를 적용하라는 요청이 `NotFound`인지 고정한다.
    ///
    /// 장부를 읽지 못한 것을 적용 실패로 뭉뚱그리면 화면은 "충돌을 푸세요"라고 말하게 되고,
    /// 사용자는 있지도 않은 충돌을 찾는다.
    #[test]
    fn overlay_c19_apply_reports_a_missing_set_as_not_found() {
        let temp = std::env::temp_dir().join(format!("overlay-c19-apply-{}", Uuid::new_v4()));
        let app_data = temp.join("app-data");
        let repository = temp.join("repository");
        fs::create_dir_all(&repository).expect("저장소 폴더");

        let error = apply_project_overlay(
            &app_data,
            &repository,
            &ApplyProjectOverlayRequest {
                project_path: repository.to_string_lossy().into_owned(),
                set_id: Uuid::new_v4().to_string(),
            },
        )
        .expect_err("없는 세트");
        assert!(
            matches!(error, CoreError::NotFound(_)),
            "없는 세트가 NotFound가 아니다: {error}"
        );

        let _ = fs::remove_dir_all(&temp);
    }

    /// 2026-10-02. 세트 장부가 **사용자 저장소 밖**에만 쌓이는지 고정한다(C19-1).
    ///
    /// 저장소 안에 메타데이터를 두면 그 파일이 브랜치를 따라다녀 overlay가 없애려던 문제를
    /// overlay가 다시 만든다. 그래서 "저장 뒤 저장소 트리가 한 글자도 바뀌지 않았다"를
    /// 디렉터리 목록으로 직접 확인한다 — 경로 문자열만 보는 시험은 저장 위치를 바꾼 사람에게
    /// 아무 말도 하지 않는다.
    #[test]
    fn overlay_sets_live_only_in_app_data_c19_1() {
        let temp = std::env::temp_dir().join(format!("overlay-c19-1-{}", Uuid::new_v4()));
        let app_data = temp.join("app-data");
        let repo = temp.join("repo");
        fs::create_dir_all(repo.join("src")).expect("repo");
        fs::write(repo.join("src/main.rs"), "fn main() {}").expect("file");

        let receipt = save_project_overlay_set(
            &app_data,
            &repo,
            &SaveProjectOverlaySetRequest {
                project_path: repo.to_string_lossy().into_owned(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["src/main.rs".to_owned()],
            },
        )
        .expect("save");
        assert!(receipt.succeeded);
        assert_eq!(receipt.outcome, ProjectOverlayOutcome::Saved);

        let in_repo: Vec<String> = fs::read_dir(&repo)
            .expect("repo entries")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            in_repo,
            vec!["src".to_owned()],
            "저장소 안에는 아무것도 쓰지 않는다"
        );
        assert!(app_data.join(OVERLAY_ROOT).is_dir());

        let listed = list_project_overlay_sets(&app_data, &repo).expect("list");
        assert_eq!(listed.sets.len(), 1);
        assert_eq!(listed.sets[0].paths, vec!["src/main.rs".to_owned()]);
        assert_eq!(listed.sets[0].state, ProjectOverlayState::Registered);

        let _ = fs::remove_dir_all(&temp);
    }

    /// 2026-10-02. 민감 경로는 사유와 함께 거절하고 **아무것도 저장하지 않는다**(C19-2).
    ///
    /// 실제로 틀렸던 자리는 "일부만 담는" 쪽이다: `.env`를 걸러 내고 나머지만 저장하면
    /// 사용자는 자기가 고른 파일이 전부 들어갔다고 믿은 채 브랜치를 옮긴다. 그래서 거절이
    /// 하나라도 있으면 세트가 생기지 않았음을 목록으로 확인한다. patch 본문에는 파일 내용이
    /// 그대로 들어가므로 이 거절이 G4를 지키는 자리이기도 하다.
    #[test]
    fn sensitive_paths_are_refused_with_reasons_c19_2() {
        let temp = std::env::temp_dir().join(format!("overlay-c19-2-{}", Uuid::new_v4()));
        let app_data = temp.join("app-data");
        let repo = temp.join("repo");
        fs::create_dir_all(&repo).expect("repo");

        for path in [
            ".env",
            "config/credentials/aws.json",
            "certs/server.pem",
            "keys/id_rsa",
        ] {
            let receipt = save_project_overlay_set(
                &app_data,
                &repo,
                &SaveProjectOverlaySetRequest {
                    project_path: repo.to_string_lossy().into_owned(),
                    set_id: None,
                    name: "민감".to_owned(),
                    paths: vec!["src/main.rs".to_owned(), path.to_owned()],
                },
            )
            .expect("save");
            assert!(!receipt.succeeded, "{path}는 거절되어야 한다");
            assert_eq!(receipt.outcome, ProjectOverlayOutcome::Rejected);
            assert_eq!(receipt.rejected.len(), 1, "{path}");
            assert!(
                !receipt.rejected[0].reason.is_empty(),
                "사유 없는 거절은 없다"
            );
        }
        assert!(
            list_project_overlay_sets(&app_data, &repo)
                .expect("list")
                .sets
                .is_empty(),
            "거절된 요청은 세트를 만들지 않는다"
        );

        let _ = fs::remove_dir_all(&temp);
    }

    /// 2026-10-02. 삭제는 지우지 않고 앱 소유 휴지통으로 옮긴다(C19-5, C3-11).
    ///
    /// patch는 캐시가 아니라 사용자 로컬 데이터라 다시 만들어 주는 주체가 없다. 영수증의
    /// `setId`와 휴지통에 남은 폴더가 복구의 근거이므로 둘 다 확인한다.
    #[test]
    fn deleting_a_set_moves_it_to_the_app_trash_c19_5() {
        let temp = std::env::temp_dir().join(format!("overlay-c19-5-{}", Uuid::new_v4()));
        let app_data = temp.join("app-data");
        let repo = temp.join("repo");
        fs::create_dir_all(&repo).expect("repo");

        let saved = save_project_overlay_set(
            &app_data,
            &repo,
            &SaveProjectOverlaySetRequest {
                project_path: repo.to_string_lossy().into_owned(),
                set_id: None,
                name: "디버그 플래그".to_owned(),
                paths: vec!["src/config.ts".to_owned()],
            },
        )
        .expect("save");
        let set_id = saved.set_id.expect("set id");

        let receipt = delete_project_overlay_set(
            &app_data,
            &repo,
            &DeleteProjectOverlaySetRequest {
                project_path: repo.to_string_lossy().into_owned(),
                set_id: set_id.clone(),
            },
        )
        .expect("delete");
        assert_eq!(receipt.outcome, ProjectOverlayOutcome::Deleted);
        assert_eq!(receipt.set_id.as_deref(), Some(set_id.as_str()));
        assert!(list_project_overlay_sets(&app_data, &repo)
            .expect("list")
            .sets
            .is_empty());

        let trash = app_data.join(OVERLAY_ROOT).join(OVERLAY_TRASH);
        let groups: Vec<PathBuf> = fs::read_dir(&trash)
            .expect("trash")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .collect();
        assert_eq!(groups.len(), 1, "삭제한 세트는 휴지통에 남는다");
        assert!(groups[0].join(&set_id).join(META_FILE).is_file());
        assert!(groups[0].join(MANIFEST_FILE).is_file());

        let _ = fs::remove_dir_all(&temp);
    }

    /// 2026-10-02. 저장소 식별자는 단일 경로 성분이고, 이름이 같은 다른 저장소와 겹치지
    /// 않는다(C19-1, C3-6). 이름만 쓰면 `~/a/web`과 `~/b/web`이 서로의 세트를 보게 된다.
    #[test]
    fn repository_id_is_one_path_component_and_distinguishes_same_named_repositories_c19_1() {
        let left = overlay_repository_id(Path::new("/home/me/a/web"));
        let right = overlay_repository_id(Path::new("/home/me/b/web"));
        assert_ne!(left, right);
        for id in [&left, &right] {
            assert!(id.starts_with("web-"), "{id}");
            assert!(
                !id.contains('/') && !id.contains('\\') && id != "..",
                "{id}"
            );
        }
    }

    /// 2026-10-02. C19-3의 순서를 코드가 아니라 **인자**로도 고정한다. patch를 뜨는 쪽에서
    /// `--full-index`가 빠지면 축약 blob 해시 때문에 재적용이 모호해지고, `--binary`가 빠지면
    /// 바이너리 변경이 조용히 사라진다. 되돌리는 쪽에서 `--source=HEAD`가 빠지면 인덱스를
    /// 기준으로 되돌아가 staged 변경이 작업 트리를 덮고, `--worktree`가 빠지면 restore는
    /// 아무것도 하지 않는다. 네 인자 중 하나라도 지워지면 이 시험이 먼저 깨진다.
    #[test]
    fn overlay_c19_snapshot_keeps_required_git_arguments() {
        let source = include_str!("project_overlays.rs");
        for literal in [
            "\"--binary\"",
            "\"--full-index\"",
            "\"--source=HEAD\"",
            "\"--worktree\"",
        ] {
            assert!(
                source.contains(literal),
                "C19-3이 요구하는 git 인자 {literal}이 사라졌습니다"
            );
        }
    }

    /// 2026-10-02. 빈 patch로 되돌리면 사용자의 변경이 patch 없이 사라진다. 실제로 겪은
    /// 입력은 "아무것도 고치지 않은 파일을 overlay에 담기"였고, git diff는 성공하면서 0바이트
    /// 파일을 남긴다 — 성공 반환값만 보면 통과하는 자리다. 그래서 되돌림의 전제는 반환값이
    /// 아니라 디스크에 남은 바이트다.
    #[test]
    fn overlay_c19_refuses_to_restore_without_a_stored_patch() {
        let dir = std::env::temp_dir().join(format!(
            "agent-manager-overlay-{}-{}",
            std::process::id(),
            line!()
        ));
        fs::create_dir_all(&dir).expect("임시 폴더");
        let patch = dir.join("overlay.patch");

        // 파일 자체가 없을 때.
        assert!(verify_stored_patch(&patch).is_err());

        // 0바이트일 때.
        fs::write(&patch, b"").expect("빈 patch");
        let empty = verify_stored_patch(&patch).expect_err("빈 patch는 거절된다");
        assert!(matches!(empty, CoreError::InvalidInput(_)), "{empty:?}");

        // 내용이 있을 때만 digest가 난다.
        fs::write(&patch, b"diff --git a/x b/x\n").expect("patch");
        let stored = verify_stored_patch(&patch).expect("digest");
        assert_eq!(stored.patch_bytes, 19);
        assert_eq!(stored.patch_digest.len(), 64);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 2026-10-02. C19-2. patch 본문에는 파일 내용이 그대로 들어가므로, 비밀값이 실릴 만한
    /// 경로는 되돌림 대상이 되기 전에 걸러져야 한다. 걸린 입력은 경로 **성분** 단위라
    /// `apps/web/.env.production`과 `server/credentials/gcp.json`이 모두 같은 규칙에 걸린다 —
    /// 파일 이름만 보면 전자는 잡히고 후자는 빠진다.
    /// C19-3. 재적용은 `git apply --check`가 먼저 돌고, 실패하면 충돌 경로를 영수증에
    /// 싣는다. 2026-10-02 측정: git 은 같은 파일을 두 문장으로 적어
    /// (`error: patch failed: src/a.rs:3` 와 `error: src/a.rs: patch does not apply`)
    /// 그대로 모으면 화면에 같은 파일이 두 번 뜨고, 설명문 줄(`error: 2 lines applied
    /// after fuzzing`)까지 경로로 세면 영수증의 `affected` 에 사람에게 보여 줄 수 없는
    /// 문장이 실린다. 통과한 검사는 경로를 하나도 내놓지 않아야 한다 — 내놓으면 화면이
    /// "적용 가능"이라고 적으면서 충돌 목록을 함께 그린다.
    #[test]
    fn overlay_c19_apply_check_names_each_conflicted_path_once() {
        assert_eq!(
            affected_paths_from_apply_output(
                "error: patch failed: src/a.rs:3\n\
                 error: src/a.rs: patch does not apply\n\
                 error: config/b.toml: does not exist in index\n\
                 error: 2 lines applied after fuzzing\n\
                 fatal: unrecognized input\n",
            ),
            vec!["src/a.rs".to_owned(), "config/b.toml".to_owned()]
        );
        assert!(affected_paths_from_apply_output("").is_empty());
    }

    #[test]
    fn overlay_c19_refuses_sensitive_paths_by_component() {
        for path in [
            ".env",
            "apps/web/.env.production",
            "server/credentials/gcp.json",
            "infra/secrets/db.yaml",
            "certs/server.pem",
            "certs/Server.KEY",
            "home/.ssh/id_ed25519",
            ".npmrc",
            "tools/.netrc",
            // 조각 비교는 성분 **부분 일치**다. `secretsmanager.md`처럼 민감하지 않은
            // 이름도 걸리지만, overlay에서 빠지는 비용이 patch에 비밀값이 실리는 비용보다
            // 싸다. v1은 예외 등록을 제공하지 않으므로 넓은 쪽을 고른다(C19-2).
            "src/secretsmanager.md",
        ] {
            assert!(sensitive_reason(path).is_some(), "{path}은 거절돼야 한다");
        }
        for path in [
            "src/environment.ts",
            "docs/keyboard.md",
            "src/lib/identity.ts",
        ] {
            assert!(!sensitive_reason(path).is_some(), "{path}은 담을 수 있다");
        }
    }

    /// 2026-10-02. C19-3. v1이 담는 것은 추적된 일반 파일의 unstaged 변경뿐이다. 특히
    /// `staged`가 중요하다 — `git diff`는 인덱스에 올라간 변경을 patch에 담지 않는데
    /// `restore --worktree`는 그것을 작업 트리에서 지운다. 둘을 합치면 patch 없는 소실이다.
    #[test]
    fn overlay_c19_accepts_only_unstaged_modifications() {
        let status = " M src/app.ts\0?? new.ts\0M  staged.ts\0MM both.ts\0 D gone.ts\0 T mode.ts\0UU conflict.ts\0";
        let reason = |path: &str| status_reason(status, path).map(OverlayRejectionReason::as_str);
        assert_eq!(reason("src/app.ts"), None);
        assert_eq!(reason("new.ts"), Some("untracked"));
        assert_eq!(reason("staged.ts"), Some("staged"));
        assert_eq!(reason("both.ts"), Some("staged"));
        assert_eq!(reason("gone.ts"), Some("deleted"));
        assert_eq!(reason("mode.ts"), Some("modeChange"));
        assert_eq!(reason("conflict.ts"), Some("conflicted"));
        // porcelain에 줄이 없으면 바뀐 것이 없다 — 빈 patch로 되돌리는 길을 여기서도 막는다.
        assert_eq!(reason("untouched.ts"), Some("unchanged"));

        let index = "100644 abc 0\tsrc/app.ts\x00120000 def 0\tlink.ts\x00160000 123 0\tvendor\x00100644 aaa 1\tconflict.ts\0";
        let mode = |path: &str| index_reason(index, path).map(OverlayRejectionReason::as_str);
        assert_eq!(mode("src/app.ts"), None);
        assert_eq!(mode("link.ts"), Some("symlink"));
        assert_eq!(mode("vendor"), Some("submodule"));
        assert_eq!(mode("conflict.ts"), Some("conflicted"));
        assert_eq!(mode("absent.ts"), Some("untracked"));
    }

    /// 2026-10-02. C19-1, G10. patch가 놓일 자리를 정하는 두 값은 사용자 입력에서 온다
    /// (저장소 식별자·세트 id). 성분을 벗어나는 값이 통과하면 이 모듈은 앱 데이터 밖 임의
    /// 경로에 파일을 쓰는 기능이 된다 — `..`과 절대 경로 둘 다 막아야 하고, Windows의
    /// `C:\\`·역슬래시도 같은 자리에서 걸러야 한다.
    #[test]
    fn project_overlay_c19_rejects_paths_outside_repository() {
        let app_data = Path::new("/tmp/agent-manager");
        let good = overlay_patch_path(app_data, "repo-1", "set_2").expect("단일 성분은 통과한다");
        assert!(good.starts_with(app_data.join("git-overlays")));
        assert!(good.ends_with("overlay.patch"));

        for bad in ["..", "../escape", "a/b", "a\\b", "/abs", "C:\\abs", ""] {
            assert!(
                overlay_patch_path(app_data, bad, "set").is_err(),
                "저장소 식별자 {bad:?}는 거절돼야 한다"
            );
            assert!(
                overlay_patch_path(app_data, "repo", bad).is_err(),
                "세트 id {bad:?}는 거절돼야 한다"
            );
        }

        // 저장소 안의 대상 경로도 같은 규칙을 지난다. `pathspec_payload`가 `.git`과 `..`을
        // 거절하므로 overlay가 저장소 밖이나 `.git` 안을 되돌릴 길이 없다.
        let root = std::env::temp_dir();
        for bad in ["../outside.ts", ".git/config", "/etc/hosts"] {
            assert!(
                pathspec_payload(&root, &[bad.to_owned()]).is_err(),
                "대상 경로 {bad:?}는 거절돼야 한다"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 실제 git 왕복 — overlay 스냅샷
    //
    // 위의 `status_reason`/`index_reason` 시험은 git이 **이미 찍은 문자열**을 읽는다. 그
    // 문자열을 받아오는 인자(`--untracked-files=all`, `--no-renames`, `-z`)가 바뀌면 판정
    // 함수는 그대로인 채 입력만 달라지고, 문자열 시험은 그것을 보지 못한다. 그래서 아래 둘은
    // 실제 저장소를 만들어 `snapshot_patch_then_restore`를 통째로 돌린다.
    // -----------------------------------------------------------------------

    struct OverlayRepo {
        _dir: tempfile::TempDir,
        root: PathBuf,
        app_data: PathBuf,
    }

    /// 사용자 git 설정과 무관한 환경. 전역 설정이 섞이면 `core.autocrlf`나 훅 하나로 시험이
    /// 기계마다 다르게 돈다.
    fn overlay_test_env() -> Vec<(String, String)> {
        let null_config = if cfg!(windows) { "NUL" } else { "/dev/null" };
        vec![
            ("GIT_CONFIG_GLOBAL".into(), null_config.into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_AUTHOR_NAME".into(), "AM Test".into()),
            ("GIT_AUTHOR_EMAIL".into(), "am@test.invalid".into()),
            ("GIT_COMMITTER_NAME".into(), "AM Test".into()),
            ("GIT_COMMITTER_EMAIL".into(), "am@test.invalid".into()),
        ]
    }

    fn overlay_git(root: &Path, args: &[&str]) {
        let mut command = std::process::Command::new("git");
        command.current_dir(root).args(args);
        for (key, value) in overlay_test_env() {
            command.env(key, value);
        }
        let output = command.output().expect("git 실행");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// HEAD 커밋 하나를 가진 저장소를 만든다. git이 없으면 `None`이라 호출부가 건너뛴다.
    fn overlay_repo() -> Option<OverlayRepo> {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|out| !out.status.success())
            .unwrap_or(true)
        {
            return None;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let base = fs::canonicalize(dir.path()).expect("base");
        let root = base.join("repo");
        let app_data = base.join("app-data");
        fs::create_dir_all(root.join("src")).expect("repo");
        fs::create_dir_all(&app_data).expect("app data");
        for (path, body) in [
            ("src/app.ts", "export const port = 443;\n"),
            ("staged.ts", "staged original\n"),
            ("gone.ts", "gone original\n"),
            ("untouched.ts", "untouched\n"),
        ] {
            fs::write(root.join(path), body).expect("seed");
        }
        overlay_git(&root, &["init", "-q", "-b", "main"]);
        overlay_git(&root, &["add", "-A"]);
        overlay_git(&root, &["commit", "-q", "-m", "seed"]);
        Some(OverlayRepo {
            _dir: dir,
            root,
            app_data,
        })
    }

    fn overlay_runner(repo: &OverlayRepo) -> GitRunner {
        match GitRunner::open_with_env(&repo.app_data, &repo.root, overlay_test_env()) {
            Ok(runner) => runner,
            Err(failure) => panic!("{}", CoreError::from(failure)),
        }
    }

    /// 2026-10-02. C19-2, C19-3. v1이 담는 것은 추적된 일반 파일의 **unstaged** 변경뿐이고,
    /// 나머지는 사유와 함께 거절된다. 여기서 고정하는 것은 사유 문자열만이 아니라 **거절된
    /// 경로의 작업 트리가 손대지지 않았다**는 사실이다.
    ///
    /// 실제로 틀릴 수 있는 모양이 그것이다. 되돌림의 pathspec을 요청 경로에서 거절 목록을
    /// 빼지 않고 만들면, staged 변경은 patch에 담기지 않은 채 작업 트리에서만 지워진다 —
    /// patch 없는 소실이고 되돌릴 방법이 남지 않는다. 문자열 시험
    /// (`overlay_c19_accepts_only_unstaged_modifications`)은 `status_reason`의 판정만 보므로
    /// 이 결선을 보지 못한다.
    ///
    /// 입력: 커밋된 네 파일 위에 unstaged 수정(`src/app.ts`), staged 수정(`staged.ts`),
    /// 삭제(`gone.ts`), 추적되지 않은 새 파일(`new.ts`), 변경 없는 파일(`untouched.ts`),
    /// 그리고 민감 경로(`.env`).
    #[test]
    fn project_overlay_c19_snapshot_rejects_unsupported_file_states() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let runner = overlay_runner(&repo);

        fs::write(repo.root.join("src/app.ts"), "export const port = 8080;\n").expect("unstaged");
        fs::write(repo.root.join("staged.ts"), "staged edited\n").expect("staged");
        overlay_git(&repo.root, &["add", "staged.ts"]);
        fs::remove_file(repo.root.join("gone.ts")).expect("deleted");
        fs::write(repo.root.join("new.ts"), "untracked\n").expect("untracked");

        let paths: Vec<String> = [
            "src/app.ts",
            "staged.ts",
            "gone.ts",
            "new.ts",
            "untouched.ts",
            ".env",
        ]
        .iter()
        .map(|path| (*path).to_owned())
        .collect();

        let result = snapshot_patch_then_restore(
            &runner,
            &repo.app_data,
            "repo-states",
            "set-states",
            &paths,
        )
        .expect("스냅샷");
        let OverlaySnapshotResult::Snapshot(outcome) = result else {
            panic!("담을 수 있는 경로가 하나 있으므로 스냅샷이 나와야 한다: {result:?}");
        };

        // 담긴 것은 unstaged 수정 하나뿐이다.
        assert_eq!(outcome.captured, vec!["src/app.ts".to_owned()]);
        assert!(outcome.restored);

        let reason = |path: &str| {
            outcome
                .rejected
                .iter()
                .find(|rejection| rejection.path == path)
                .map(|rejection| rejection.reason.as_str())
        };
        assert_eq!(reason("staged.ts"), Some("staged"));
        assert_eq!(reason("gone.ts"), Some("deleted"));
        assert_eq!(reason("new.ts"), Some("untracked"));
        assert_eq!(reason("untouched.ts"), Some("unchanged"));
        // 민감 경로는 git 상태를 보기 전에 걸린다(C19-2).
        assert_eq!(reason(".env"), Some("sensitive"));

        // 담긴 경로만 HEAD 원본으로 돌아갔다.
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("읽기"),
            "export const port = 443;\n"
        );
        // 거절된 경로는 한 글자도 바뀌지 않았다 — 이것이 patch 없는 소실을 막는 자리다.
        assert_eq!(
            fs::read_to_string(repo.root.join("staged.ts")).expect("읽기"),
            "staged edited\n"
        );
        assert!(
            !repo.root.join("gone.ts").exists(),
            "삭제는 되살리지 않는다"
        );
        assert_eq!(
            fs::read_to_string(repo.root.join("new.ts")).expect("읽기"),
            "untracked\n"
        );
    }

    /// 2026-10-02. C19-3/C19-5. 적용 전에 `git apply --check`가 실패하면 실제 `git apply`
    /// 로 넘어가지 않아야 한다. 충돌 난 파일의 현재 내용과 porcelain 상태를 함께 고정한다:
    /// 영수증만 `overlayNeedsResolution`으로 돌리고 작업 트리가 달라지면, 사용자는 충돌을
    /// 풀기도 전에 자신의 새 변경을 잃는다.
    ///
    /// 2026-10-02 개명. 두 레인이 같은 날 같은 결선을 서로 모르고 시험으로 적었고, 반영
    /// 시점에 `project_overlay_c19_apply_check_failure_preserves_git_state`가 이 모듈에 두 번
    /// 생겨 크레이트의 lib test가 `E0428`로 통째로 컴파일되지 않았다. 점검표가 그 이름으로
    /// 거는 쪽은 patch 바이트·장부 상태·HEAD 전후까지 보는 아래쪽 시험이라 그것이 이름을
    /// 갖고, 이쪽은 그 시험이 보지 않는 **porcelain 상태 동일성**을 혼자 고정하므로 지우지
    /// 않고 자기 이름을 받았다. 둘 중 하나를 버렸다면 그 자리 하나가 다음 회차에 조용히 열린다.
    #[test]
    fn project_overlay_c19_apply_check_failure_keeps_worktree_status() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let project_path = repo.root.to_string_lossy().into_owned();

        let saved = save_project_overlay_set(
            &repo.app_data,
            &repo.root,
            &SaveProjectOverlaySetRequest {
                project_path: project_path.clone(),
                set_id: None,
                name: "local port".to_owned(),
                paths: vec!["src/app.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        let set_id = saved.set_id.expect("세트 id");

        fs::write(repo.root.join("src/app.ts"), "export const port = 8080;\n")
            .expect("overlay 변경");
        let snapshot = snapshot_project_overlay(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                trigger: None,
            },
        )
        .expect("스냅샷");
        assert_eq!(snapshot.outcome, ProjectOverlayOutcome::Snapshotted);

        // 같은 행을 다르게 고쳐 patch가 더는 적용될 수 없게 만든다.
        fs::write(repo.root.join("src/app.ts"), "export const port = 3000;\n").expect("충돌 변경");
        let runner = overlay_runner(&repo);
        let before_body = fs::read_to_string(repo.root.join("src/app.ts")).expect("적용 전 내용");
        let before_status = runner
            .overlay_read_with_input(
                &["status", "--porcelain", "--untracked-files=all"],
                None,
                LOCAL_MUTATION_TIMEOUT,
            )
            .expect("적용 전 상태")
            .stdout;

        let receipt = apply_project_overlay(
            &repo.app_data,
            &repo.root,
            &ApplyProjectOverlayRequest {
                project_path,
                set_id,
            },
        )
        .expect("검사 실패는 영수증");

        assert!(!receipt.succeeded);
        assert_eq!(
            receipt.outcome,
            ProjectOverlayOutcome::OverlayNeedsResolution
        );
        assert!(receipt.affected.iter().any(|path| path == "src/app.ts"));
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("적용 후 내용"),
            before_body
        );
        let after_status = runner
            .overlay_read_with_input(
                &["status", "--porcelain", "--untracked-files=all"],
                None,
                LOCAL_MUTATION_TIMEOUT,
            )
            .expect("적용 후 상태")
            .stdout;
        assert_eq!(
            after_status, before_status,
            "검사 실패는 git 상태를 바꾸지 않는다"
        );
    }

    /// 2026-10-02. C19-1. patch 본문에는 파일 **내용**이 그대로 들어간다. 그 파일이 저장소
    /// 안에 떨어지면 두 가지가 한꺼번에 깨진다 — overlay가 없애려던 "브랜치를 따라다니는
    /// 로컬 변경"을 overlay 자신이 만들고, 다음 커밋이 사용자 로컬 설정을 통째로 올린다.
    ///
    /// 경로 문자열만 보는 시험으로는 부족하다. `--output=`에 상대 경로가 들어가면 git은 그것을
    /// 저장소 루트가 아니라 **자식 프로세스의 작업 디렉터리** 기준으로 풀고, 경로 조립 함수는
    /// 그대로 통과한다. 그래서 스냅샷을 실제로 돌린 뒤 저장소 트리를 훑어 확인한다.
    #[test]
    fn project_overlay_c19_patches_live_outside_the_repository() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let runner = overlay_runner(&repo);
        fs::write(repo.root.join("src/app.ts"), "export const port = 8080;\n").expect("unstaged");

        let result = snapshot_patch_then_restore(
            &runner,
            &repo.app_data,
            "repo-store",
            "set-store",
            &["src/app.ts".to_owned()],
        )
        .expect("스냅샷");
        let OverlaySnapshotResult::Snapshot(outcome) = result else {
            panic!("{result:?}");
        };

        // patch는 앱 데이터 아래에만 있다.
        let patch_path =
            overlay_patch_path(&repo.app_data, "repo-store", "set-store").expect("patch 경로");
        assert!(patch_path.starts_with(&repo.app_data), "{patch_path:?}");
        assert!(patch_path.is_file(), "patch가 앱 데이터에 없다");
        assert!(outcome.patch.patch_bytes > 0);

        // 그리고 저장소 트리 어디에도 없다. `.git` 안까지 포함해 훑는다 — `--output=`이
        // 상대 경로로 풀리면 가장 먼저 떨어지는 자리가 저장소 루트다.
        let mut found = Vec::new();
        let mut stack = vec![repo.root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).expect("읽기").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".patch") || name == "meta.json" || name == "manifest.json" {
                    found.push(path);
                }
            }
        }
        assert!(
            found.is_empty(),
            "overlay 산출물이 저장소 안에 떨어졌습니다: {found:?}"
        );

        // 작업 트리는 되돌아갔고, 저장소에는 추적되지 않은 새 파일도 남지 않았다.
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("읽기"),
            "export const port = 443;\n"
        );
        let status = runner
            .overlay_read_with_input(
                &["status", "--porcelain", "--untracked-files=all"],
                None,
                LOCAL_MUTATION_TIMEOUT,
            )
            .expect("status");
        assert!(
            status.stdout.trim().is_empty(),
            "스냅샷 뒤 저장소는 깨끗해야 합니다: {}",
            status.stdout
        );
    }

    /// 2026-10-02. C19-3, C19-5. 적용은 **검사가 먼저**다. 그 검사가 막았을 때 남아야 하는
    /// 것이 무엇인지 고정한다 — 작업 트리, HEAD, 보관한 patch, 그리고 세트의 상태 네 가지다.
    ///
    /// 실제로 틀릴 수 있는 모양이 여럿이다. 검사 결과를 보지 않고 바로 `git apply`로 넘어가면
    /// 막힌 경로를 비켜 간 조각이 작업 트리에 들어간다. 장부를 적용 **전에** 옮기면 막힌 세트가
    /// `applied`로 남아 다음 요청이 "이미 적용됨"으로 거절되고, 사용자는 patch를 가진 채 다시
    /// 넣을 길을 잃는다. 실패를 영수증이 아니라 오류로 던지면 어느 경로가 막았는지(`affected`)와
    /// 어느 커밋 위에서 막혔는지(`head_before`/`head_after`)가 사라진다.
    /// `overlay_c19_apply_failure_names_only_the_blocking_paths`는 stderr 문자열 판정만 보므로
    /// 이 결선을 보지 못한다.
    ///
    /// 입력: 커밋된 `src/app.ts`(`443`)를 `8080`으로 고쳐 스냅샷으로 보관한 뒤, 같은 파일을
    /// 손으로 `9999`로 바꿔 patch의 전제(`443`)를 깨뜨린 상태에서 적용을 부른다. 마지막으로
    /// 그 방해를 치우면 **같은 patch가 그대로 들어간다** — 실패가 patch를 상하게 하지 않았다는
    /// 증거다.
    #[test]
    fn project_overlay_c19_apply_check_failure_preserves_git_state() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let env = overlay_test_env();
        let runner = overlay_runner(&repo);
        let original = "export const port = 443;
";

        fs::write(
            repo.root.join("src/app.ts"),
            "export const port = 8080;
",
        )
        .expect("unstaged");
        let saved = save_project_overlay_set(
            &repo.app_data,
            &repo.root,
            &SaveProjectOverlaySetRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["src/app.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        assert!(saved.succeeded, "{saved:?}");
        let set_id = saved.set_id.clone().expect("set id");

        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                set_id: set_id.clone(),
                trigger: None,
            },
            env.clone(),
        )
        .expect("스냅샷");
        assert!(snapshot.succeeded, "{snapshot:?}");
        let patch_digest = snapshot.patch_digest.clone().expect("digest");
        let patch_path = overlay_patch_path(
            &repo.app_data,
            &overlay_repository_id(&repo.root),
            &snapshot.snapshot_id.clone().expect("snapshot id"),
        )
        .expect("patch 경로");
        let patch_before = fs::read(&patch_path).expect("patch 읽기");
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("읽기"),
            original,
            "스냅샷은 작업 트리를 HEAD 원본으로 되돌린다"
        );

        // patch의 전제를 깨뜨린다. 같은 파일을 다른 내용으로 고쳐 두면 `apply --check`가 막는다.
        fs::write(
            repo.root.join("src/app.ts"),
            "export const port = 9999;
",
        )
        .expect("방해");
        let head_before_apply = runner.overlay_head_sha().expect("head");

        let blocked = apply_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &ApplyProjectOverlayRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                set_id: set_id.clone(),
            },
            env.clone(),
        )
        .expect("막힌 적용도 오류가 아니라 영수증이다");

        assert!(!blocked.succeeded, "{blocked:?}");
        assert!(
            matches!(
                blocked.outcome,
                ProjectOverlayOutcome::OverlayNeedsResolution
            ),
            "{blocked:?}"
        );
        assert!(
            blocked.affected.iter().any(|path| path == "src/app.ts"),
            "막은 경로를 영수증이 이름으로 대야 한다: {:?}",
            blocked.affected
        );
        // HEAD는 움직이지 않았고, 영수증이 그 사실을 전후 두 칸으로 말한다(C19-5).
        assert_eq!(blocked.head_before, head_before_apply);
        assert_eq!(blocked.head_after, head_before_apply);

        // 1. 작업 트리는 사용자가 둔 그대로다 — patch의 어느 조각도 들어가지 않았다.
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("읽기"),
            "export const port = 9999;
"
        );
        // 2. 보관한 patch는 바이트 하나 달라지지 않았다.
        assert_eq!(fs::read(&patch_path).expect("patch 읽기"), patch_before);
        // 3. 세트는 `stored` 그대로라 충돌을 푼 뒤 같은 요청을 다시 부를 수 있다.
        let listed = list_project_overlay_sets(&repo.app_data, &repo.root).expect("목록");
        let set = listed
            .sets
            .iter()
            .find(|set| set.set_id == set_id)
            .expect("세트");
        assert!(
            matches!(set.state, ProjectOverlayState::Stored),
            "막힌 적용은 장부를 옮기지 않는다: {:?}",
            set.state
        );
        assert_eq!(set.patch_digest.as_deref(), Some(patch_digest.as_str()));

        // 방해를 치우면 같은 patch가 그대로 들어간다.
        fs::write(repo.root.join("src/app.ts"), original).expect("되돌림");
        let applied = apply_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &ApplyProjectOverlayRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                set_id: set_id.clone(),
            },
            env,
        )
        .expect("적용");
        assert!(applied.succeeded, "{applied:?}");
        assert!(matches!(applied.outcome, ProjectOverlayOutcome::Applied));
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("읽기"),
            "export const port = 8080;
"
        );
    }

    /// 2026-10-02. C19-3. overlay 되돌림과 `git` 변경이 같은 저장소에서 겹치면 둘 다 자기
    /// 영수증의 `head_before`를 믿을 수 없게 된다. 그래서 잠금은 overlay 전용이 아니라 git
    /// 어댑터와 **공유하는** 것이고, 이 시험은 그 공유를 고정한다 — 같은 루트로 두 번 잡으면
    /// 두 번째는 반드시 비어 있어야 하고, 첫 번째가 떨어진 뒤에는 다시 잡혀야 한다.
    #[test]
    fn project_overlay_c19_serializes_concurrent_requests() {
        let root = std::env::temp_dir().join("agent-manager-overlay-busy");
        fs::create_dir_all(&root).expect("임시 폴더");

        let first = BusyGuard::acquire(&root).expect("처음에는 잡힌다");
        assert!(
            BusyGuard::acquire(&root).is_none(),
            "겹친 요청은 busy로 돌아가야 한다"
        );
        drop(first);
        assert!(
            BusyGuard::acquire(&root).is_some(),
            "앞 요청이 끝나면 다시 잡혀야 한다"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
