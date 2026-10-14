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
//! patch 본문에는 파일 **내용**이 그대로 들어간다. 그래도 민감해 보이는 이름을 거절하지는
//! 않는다(C19-2, 2026-10-05 사용자 결정) — `.env`나 키 파일이야말로 브랜치를 옮길 때마다
//! 잃어서는 안 되는 것이고, 그것을 막으면 이 기능이 서 있을 이유가 사라진다. G4는 금지가
//! 아니라 보관 **자리**로 받는다: 세트는 저장소 밖 앱 데이터에만 쓰고 디렉터리는 0700, 본문
//! 파일은 0600이다. 거절은 파일 **상태**(C19-3)로만 하고, 거절은 조용하지 않다 — 어느 경로가
//! 어느 사유에 걸렸는지 영수증에 싣는다.
//!
//! 이 모듈은 git을 띄우지 않는다. 세트 장부는 저장소가 잠겨 있거나 git이 없어도 읽고 쓸 수
//! 있어야 하고, C19-3이 이 예외에 더한 git 명령은 스냅샷·적용의 둘뿐이기 때문이다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app_data_file::{
    open_private_file, read_private_json, sync_dir, write_private_bytes, write_private_json,
};
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

/// 화면 하나에 실어 보내는 patch 본문의 상한(C19-5의 "patch 본문도 파일 내용도 싣지
/// 않는다"는 **영수증**의 규칙이고, 사용자가 자기 patch를 열어 보는 읽기는 그 규칙이 막는
/// 대상이 아니다). 보관 상한 16 MiB를 그대로 한 응답에 실으면 화면이 멈추므로, 읽기 쪽은
/// 따로 끊고 끊었다는 사실을 함께 싣는다.
const MAX_PATCH_TEXT_BYTES: usize = 512 * 1024;

// 민감 경로(`.env`·`*.pem`·`*.key`·`id_*`·`credential(s)`·`secrets`·`.npmrc`·`.netrc`)를
// 거절하는 규칙은 **일부러 없다**(C19-2, 2026-10-05 사용자 결정). overlay가 존재하는 이유가
// 바로 그런 로컬 전용 설정을 브랜치를 옮길 때마다 잃지 않는 것이라, 그것을 막으면 기능이 서
// 있을 이유가 사라진다. 막아 두어도 그 값은 어차피 사용자의 작업 트리에 그대로 있었다 —
// overlay는 그것을 더 느슨한 자리로 옮기지 않는다.
//
// G4는 금지가 아니라 보관 **자리**로 받는다: 세트는 저장소 밖 `<app data>/git-overlays/`에만
// 쓰고 디렉터리는 0700, 본문 파일은 0600이다(C19-1, `write_overlay_patch`). 영수증에 patch
// 본문도 파일 내용도 싣지 않는 것은 그대로다(C19-5).

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

/// 외부 Git 작업을 보고 재적용을 **내밀어야 하는지**만 묻는 조회(C19-3).
///
/// C19-3이 가른 두 자리 가운데 바깥쪽이다. 앱이 시작한 switch·pull·rebase 뒤에는 앱이
/// 스스로 검사하고 적용하지만, 터미널에서 사람이 브랜치를 옮긴 경우에는 앱이 그 사실을
/// 알 길이 없어 patch가 보관된 채로 남는다. 그 상태를 화면이 알아차리지 못하면 overlay는
/// "브랜치를 옮겨도 로컬 설정이 따라온다"는 약속을 조용히 어긴다 — 사용자는 설정이 적용된
/// 줄 알고 작업한다.
///
/// 자동으로 적용하지는 않는다. C19-3이 외부 작업 뒤의 자동 적용을 금지했기 때문이다:
/// 사람이 터미널에서 무엇을 하던 중인지 앱은 모르고, 그 한가운데 작업 트리를 바꾸는 것은
/// 되돌리기 어려운 종류의 친절이다. 이 조회가 답하는 것은 "검사 결과와 적용 버튼을 내밀
/// 자리가 있는가"까지다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayDrift {
    pub schema_version: u32,
    pub repository_id: String,
    pub repository_root: String,
    /// 지금 HEAD. 커밋이 하나도 없으면 null이다.
    pub current_head: Option<String>,
    /// patch가 보관된 세트만 실린다. 장부만 있는 세트와 이미 적용된 세트는 내밀 것이 없다.
    pub sets: Vec<ProjectOverlayDriftEntry>,
    /// 읽지 못한 세트 폴더. 목록 조회와 같은 이유로 숨기지 않는다.
    pub unreadable: Vec<String>,
}

/// 보관된 세트 하나가 지금 어떤 자리에 있는지(C19-3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayDriftEntry {
    pub set_id: String,
    pub name: String,
    pub state: ProjectOverlayState,
    /// patch를 뜰 때의 기준 HEAD.
    pub base_head: Option<String>,
    /// 기준 HEAD와 지금 HEAD가 다른가. 이것이 "외부 Git 작업이 있었다"의 신호다.
    pub head_moved: bool,
    /// `external`이면 화면은 **자동으로 적용하지 않고** 검사와 적용 버튼만 내민다(C19-3).
    pub trigger: ProjectOverlayTrigger,
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

/// 보관한 patch 본문을 사람이 읽기 위한 요청(C19-5).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProjectOverlayPatchRequest {
    pub project_path: String,
    pub set_id: String,
}

/// 보관한 patch 본문 하나(C19-5).
///
/// 왜 이 읽기가 필요한가. 스냅샷이 끝나면 작업 트리는 HEAD 원본으로 돌아가고, 사용자가 하던
/// 변경의 **유일한 사본**은 앱 데이터 안의 patch 파일이 된다. 그 파일을 열 길이 없으면
/// `git apply --check`가 실패해 `overlayNeedsResolution`이 돌아온 순간 사용자는 충돌한 경로
/// 이름만 쥐고, 무엇을 손으로 다시 적어야 하는지는 알 수 없다. C19-5가 "patch를 잃는 경로는
/// 어디에도 없다"고 적은 것은 파일이 남는다는 뜻만이 아니라 그 내용에 닿을 수 있다는 뜻이다.
///
/// 영수증과 가르는 선은 분명하다. C19-5가 본문을 금지한 것은 **영수증**이다 — 영수증은
/// 변경마다 자동으로 쌓이고 화면·이력·AIA가 두루 읽으므로 파일 내용이 거기 실리면 사용자가
/// 고르지 않은 자리에 내용이 번진다. 이 읽기는 사용자가 한 세트를 지목해 물을 때만 답하고
/// 아무 데도 쌓이지 않는다.
///
/// 2026-10-05 결정(C19-2)으로 민감 경로 거절이 사라진 뒤로는 담기는 내용에 `.env`나 키 파일의
/// 원문이 들어 있을 수 있다. "어차피 `read_project_file`(C16-9)로도 읽힌다"는 옛 등가 논거는
/// 더 쓰지 않는다 — 스냅샷이 끝나면 작업 트리는 HEAD 원본이라 그 읽기가 닿는 곳에 로컬 값이
/// 없고, 이 읽기만이 유일한 창구다. 그래서 여기 적는 근거는 등가가 아니라 **지목**이다:
/// 사용자가 세트를 골라 물을 때만 답하고, 결과는 어느 영수증·이력·로그에도 남기지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayPatch {
    pub schema_version: u32,
    pub set_id: String,
    pub name: String,
    pub repository_id: String,
    pub repository_root: String,
    pub state: ProjectOverlayState,
    pub snapshot_id: Option<String>,
    /// patch를 뜰 때의 기준 HEAD. 본문을 읽는 사람이 "어느 커밋 위의 변경인가"를 안다.
    pub base_head: Option<String>,
    /// 장부가 적어 둔 digest.
    pub patch_digest: Option<String>,
    /// 지금 디스크에 있는 patch의 digest. 둘이 다르면 장부와 파일이 어긋났다는 뜻이다.
    pub stored_digest: Option<String>,
    /// 두 digest가 같은가. 거짓이면 화면은 본문을 "보관 시점과 다른 patch"로 표시해야 한다 —
    /// `check_project_overlay_apply`가 같은 어긋남을 적용 전에 거절하는 것과 같은 판정이다.
    pub digest_matches: bool,
    /// 세트가 담는 저장소 루트 기준 상대 경로.
    pub paths: Vec<String>,
    /// 디스크에 있는 patch의 바이트 수. 끊긴 경우에도 원본 크기를 적는다.
    pub bytes: u64,
    /// 상한에서 끊었는가(`MAX_PATCH_TEXT_BYTES`).
    pub truncated: bool,
    /// patch 본문. 보관된 patch가 없거나 UTF-8이 아니면 null이다.
    pub text: Option<String>,
    /// 본문을 싣지 못한 사유. 실었으면 null이다.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProjectOverlayRequest {
    pub project_path: String,
    pub set_id: String,
}

/// 앱이 시작한 Git 작업 뒤의 일괄 재적용 요청(C19-3). 세트를 고르지 않는 것이 요점이다 —
/// 어떤 세트를 다시 넣을지는 장부의 상태(`stored`)가 정하고, 호출부는 "방금 이 저장소에서
/// Git 작업을 했다"는 사실만 전한다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReapplyProjectOverlaysRequest {
    pub project_path: String,
    /// 직전 Git 작업이 **실패해서** 이전 브랜치 위에서 되돌리는 중인가(C19-3의 실행 규칙 7).
    ///
    /// 다시 넣는 일 자체는 성공한 뒤와 똑같다 — 판정은 여전히 장부의 `stored`다. 다른 것은
    /// 영수증이 말하는 사실이다. 실패한 switch는 HEAD를 움직이지 않았으므로 "브랜치를 옮긴
    /// 뒤 다시 넣었다"는 문장이 거짓이 되고, 사용자가 보는 것은 실패한 Git 영수증 옆에
    /// 붙은 복구 기록이어야 한다. 그래서 호출부가 아는 사실(직전 작업이 실패했다)을 그대로
    /// 받아 [`ProjectOverlayReapply::recovery`]로 되돌려준다.
    #[serde(default)]
    pub recovery: bool,
}

/// 일괄 재적용의 영수증 묶음(C19-5). 세트마다의 영수증을 그대로 싣고, 화면이 한 줄로
/// 요약할 수 있도록 결말 수만 따로 센다. patch 본문도 파일 내용도 들어가지 않는다(G4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayReapply {
    pub schema_version: u32,
    pub repository_id: String,
    pub repository_root: String,
    /// 재적용을 마친 뒤의 HEAD. 재적용은 HEAD를 움직이지 않으므로 Git 작업 뒤의 그 값이다.
    pub head: Option<String>,
    /// 언제나 `app`이다. 외부 Git 작업 뒤의 자동 적용은 C19-3이 금지했고, 그 자리는
    /// `get_project_overlay_drift`가 버튼만 내미는 것으로 끝난다.
    pub trigger: ProjectOverlayTrigger,
    pub receipts: Vec<ProjectOverlayReceipt>,
    pub applied: usize,
    pub needs_resolution: usize,
    pub busy: usize,
    /// 다시 넣기 자체가 오류로 끝난 세트(C19-3). `needs_resolution`과 다른 종류다 —
    /// 저쪽은 `git apply --check`가 통과하지 못해 **아무것도 적용하지 않고** 멈춘 정상
    /// 결말이고, 이쪽은 세트를 읽거나 적용하는 길에서 오류가 난 것이다. 어느 쪽이든
    /// patch는 앱 데이터에 그대로 남는다.
    pub failed: Vec<ProjectOverlayReapplyFailure>,
    /// 직전 Git 작업이 실패해 되돌리는 중이었는가. 요청이 전한 사실을 그대로 싣는다.
    pub recovery: bool,
    pub unreadable: Vec<String>,
}

/// 다시 넣기가 오류로 끝난 세트 하나(C19-5). patch 본문도 파일 내용도 싣지 않는다(G4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverlayReapplyFailure {
    pub set_id: String,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// 경로
// ---------------------------------------------------------------------------

/// 등록 프로젝트 경로에서 그 **저장소**의 최상위를 찾는다(C19-1, C16-1).
///
/// 2026-10-04 실측. overlay 명령은 모두 `remote.rs`의 `project()` 결과 — 등록 프로젝트
/// 루트 — 를 받는데, C19의 나머지는 전부 저장소 단위다: 세트에 담기는 경로는 저장소 루트
/// 기준이고, 스냅샷·적용은 `GitRunner`가 `--show-toplevel`로 찾은 최상위에서 돌며, 겹침을
/// 막는 잠금 키(`GitRunner::overlay_lock_key`)도 그 최상위다. 그래서 식별자만 프로젝트
/// 루트에서 나오면 한 저장소의 하위 폴더 둘이 각각 등록된 경우 **같은 작업 트리 하나에
/// 장부가 둘** 생긴다. 앱이 브랜치를 옮긴 직후 부르는 `reapply_project_overlays`와
/// `get_project_overlay_drift`는 지금 화면에 띄운 프로젝트의 장부만 보므로, 다른 프로젝트
/// 이름으로 보관해 둔 세트는 자동 재적용되지 않는다 — C19-3이 약속한 자리가 조용히 빈다.
///
/// 찾는 방법은 git을 띄우지 않는 위로 걷기다. `list_project_overlay_sets`는 "저장소가 잠겨
/// 있어도 답한다"가 계약이라 여기서 자식 프로세스를 띄울 수 없고, 식별자는 장부 위치를
/// 정하는 값이라 git 가용 여부에 따라 달라지면 안 된다. `.git`은 디렉터리일 수도 파일일
/// 수도 있으므로(링크된 워크트리·서브모듈) 존재만 본다.
///
/// 홈 디렉터리 위로는 올라가지 않는다 — `GitRunner`의 발견 천장과 같은 자리이고, 홈 자체가
/// 저장소인 경우는 C16-1이 `restrictedRepository`로 이미 거절한다.
///
/// **경로의 표기는 바꾸지 않는다.** 들어온 경로의 조상을 그대로 돌려주므로 Windows의 정규화
/// 표기는 그대로 남는다. 여기서 `path_guard::child_facing`으로 다듬으면 해시가 통째로 달라져
/// **이미 저장된 모든 세트의 장부가 보이지 않게 된다** — patch는 그 변경의 유일한
/// 사본이다(C19-5). 프로젝트가 곧 저장소 최상위인 흔한 경우는 첫 걸음에서 `.git`을 찾아
/// 입력과 같은 경로를 돌려주므로 식별자가 한 글자도 바뀌지 않는다.
pub(crate) fn overlay_repository_root(project_root: &Path) -> PathBuf {
    let ceiling = crate::user_home::home_dir().ok();
    let mut current = project_root;
    loop {
        if current.join(".git").exists() {
            return current.to_path_buf();
        }
        if ceiling.as_deref() == Some(current) {
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    project_root.to_path_buf()
}

/// overlay 변경이 git 어댑터와 **공유하는** 저장소 단위 잠금 키(C19-3).
///
/// 2026-10-05 실측. overlay 명령은 전부 `remote.rs`의 `project()` 결과 — 등록 프로젝트
/// 루트 — 를 받는데, `snapshot`·`apply`는 `GitRunner`를 열어 `overlay_lock_key()`
/// (= `--show-toplevel`을 정규화한 **저장소 최상위**)로 잠근다. `exclude`만 받은 경로를
/// 그대로 `BusyGuard`에 넘기고 있어서, 프로젝트가 하위 폴더로 등록된 경우 두 값이 다른
/// `PathBuf`가 되어 잠금이 서로를 전혀 막지 못했다 — `exclude`의 patch 재작성과 `apply`가
/// 같은 작업 트리에서 동시에 돌고, `apply`가 digest를 확인한 patch와 실제로 적용하는
/// patch가 달라진다(C19-5).
///
/// git을 띄우지 않는 이유는 `exclude`의 계약이다 — 이 조작은 앱 데이터만 고치므로 저장소가
/// 잠겨 있거나 git이 없어도 답해야 한다. 그래서 [`overlay_repository_root`]의 위로 걷기로
/// 최상위를 찾고, `GitRunner`와 **같은 다듬기**(`canonical_child_facing`)를 한 번 더
/// 적용해 두 키가 같은 값이 되게 한다. 식별자 쪽에 이 다듬기를 넣지 않는 이유는
/// [`overlay_repository_root`]에 적어 둔 그대로다 — 해시가 바뀌면 이미 보관한 장부가 통째로
/// 보이지 않게 된다. 잠금 키는 디스크에 남지 않으므로 그 제약이 없다.
///
/// 정규화에 실패하면(경로가 사라진 드문 경우) 찾은 최상위를 그대로 쓴다. 잠그지 않는 것보다
/// 낫고, 그 상태에서는 어차피 뒤따르는 파일 조작이 실패한다.
fn overlay_lock_root(project_root: &Path) -> PathBuf {
    let repository_root = overlay_repository_root(project_root);
    crate::path_guard::canonical_child_facing(&repository_root).unwrap_or(repository_root)
}

/// 저장소 루트를 앱 데이터 아래 단일 경로 성분으로 옮긴다(C19-1, C3-6).
///
/// 이름만 쓰면 `~/a/web`과 `~/b/web`이 같은 폴더를 쓰고, 경로를 그대로 쓰면 성분이 여럿이
/// 된다. 그래서 읽을 수 있는 이름과 정규화 경로의 해시를 함께 쓴다 — 사람이 폴더를 열었을 때
/// 어느 저장소인지 알아볼 수 있고, 두 저장소가 겹치지도 않는다.
///
/// 인자는 등록 프로젝트 루트여도 된다. 저장소 최상위는 [`overlay_repository_root`]가 찾는다.
pub fn overlay_repository_id(project_root: &Path) -> String {
    let repository_root = overlay_repository_root(project_root);
    let repository_root = repository_root.as_path();
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
        repository_root: overlay_repository_root(repository_root)
            .to_string_lossy()
            .into_owned(),
        repository_id,
        sets,
        unreadable,
    })
}

/// 보관된 overlay 세트 가운데 기준 HEAD에서 벗어난 것을 찾는다(C19-3).
///
/// 판정은 한 줄이다 — 상태가 `stored`(patch는 떠 있고 작업 트리는 HEAD 원본)인데 지금
/// HEAD가 `base_head`와 다르면 그 사이에 앱이 모르는 Git 작업이 있었다는 뜻이다. 앱이
/// 시작한 작업은 그 자리에서 바로 검사·적용으로 이어지므로 이 상태로 남지 않는다.
///
/// `applied`는 싣지 않는다. 이미 작업 트리에 들어가 있어 내밀 버튼이 없고, 적용된 세트를
/// 여기 실으면 화면이 "다시 적용하라"고 권하게 된다 — 그 길은 중복 적용이라 `apply`가
/// 이미 거절한다. `registered`도 같은 이유로 뺀다(뜬 patch가 없다).
///
/// git은 `rev-parse` 한 번만 띄운다. 저장소가 잠겨 있어 HEAD를 읽지 못하면 `head_moved`를
/// 참으로 꾸미지 않고 거짓으로 둔다 — 모르는 것을 "움직였다"로 적으면 화면이 근거 없이
/// 적용을 권하게 되고, 그것은 C19-3이 외부 작업 뒤 자동 적용을 금지한 이유와 같은 종류의
/// 잘못이다.
pub fn get_project_overlay_drift(
    app_data_dir: &Path,
    repository_root: &Path,
) -> Result<ProjectOverlayDrift, CoreError> {
    get_project_overlay_drift_with_env(app_data_dir, repository_root, Vec::new())
}

/// [`get_project_overlay_drift`]와 같은 일을 하되 git 자식 프로세스에 환경을 더 얹는다
/// (`snapshot_project_overlay_with_env`와 같은 이유 — 시험이 임시 저장소를 쓴다).
pub(crate) fn get_project_overlay_drift_with_env(
    app_data_dir: &Path,
    repository_root: &Path,
    extra_env: Vec<(String, String)>,
) -> Result<ProjectOverlayDrift, CoreError> {
    let listed = list_project_overlay_sets(app_data_dir, repository_root)?;
    let runner = GitRunner::open_with_env(app_data_dir, repository_root, extra_env)?;
    let current_head = runner.overlay_head_sha()?;
    let sets = listed
        .sets
        .into_iter()
        .filter(|set| set.state == ProjectOverlayState::Stored)
        .map(|set| {
            let head_moved = match (current_head.as_deref(), set.base_head.as_deref()) {
                (Some(now), Some(base)) => now != base,
                _ => false,
            };
            ProjectOverlayDriftEntry {
                set_id: set.set_id,
                name: set.name,
                state: set.state,
                base_head: set.base_head,
                head_moved,
                trigger: if head_moved {
                    ProjectOverlayTrigger::External
                } else {
                    ProjectOverlayTrigger::App
                },
            }
        })
        .collect();
    Ok(ProjectOverlayDrift {
        schema_version: OVERLAY_SCHEMA_VERSION,
        repository_id: listed.repository_id,
        repository_root: listed.repository_root,
        current_head,
        sets,
        unreadable: listed.unreadable,
    })
}

/// 한 세트에 보관된 patch 본문을 읽는다(C19-5).
///
/// git을 띄우지 않는다. 묻는 것이 "디스크에 무엇이 보관돼 있는가"이지 "지금 적용되는가"가
/// 아니기 때문이다 — 뒤쪽은 `check_project_overlay_apply`가 답하고, 그쪽은 저장소가 잠겨
/// 있으면 답하지 못한다. patch를 읽는 일까지 저장소 상태에 매이면, 정작 사용자가 본문을
/// 가장 급히 보려는 때(충돌·잠김)에 못 보게 된다.
///
/// 보관된 patch가 없는 상태(`registered`)는 오류가 아니라 사유가 실린 답이다. 세트 목록과
/// 같은 이유다 — 화면이 세트를 그리는 중에 하나가 통째로 사라지는 것보다 "아직 뜬 patch가
/// 없습니다"가 낫다.
pub fn read_project_overlay_patch(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &ReadProjectOverlayPatchRequest,
) -> Result<ProjectOverlayPatch, CoreError> {
    let set_id = validate_set_id(&request.set_id)?;
    let repository_id = overlay_repository_id(repository_root);
    let dir = repository_dir(app_data_dir, &repository_id).join(&set_id);
    let set: ProjectOverlaySet = read_private_json(&dir.join(META_FILE))?
        .ok_or_else(|| CoreError::NotFound(format!("overlay 세트를 찾지 못했습니다: {set_id}")))?;

    let mut answer = ProjectOverlayPatch {
        schema_version: OVERLAY_SCHEMA_VERSION,
        set_id: set.set_id.clone(),
        name: set.name.clone(),
        repository_id: repository_id.clone(),
        repository_root: overlay_repository_root(repository_root)
            .to_string_lossy()
            .into_owned(),
        state: set.state,
        snapshot_id: set.snapshot_id.clone(),
        base_head: set.base_head.clone(),
        patch_digest: set.patch_digest.clone(),
        stored_digest: None,
        digest_matches: false,
        paths: set.paths.clone(),
        bytes: 0,
        truncated: false,
        text: None,
        reason: None,
    };

    let Some(snapshot_id) = set.snapshot_id.as_deref() else {
        answer.reason = Some("아직 뜬 patch가 없습니다".to_owned());
        return Ok(answer);
    };
    let patch_path = overlay_patch_path(app_data_dir, &repository_id, snapshot_id)?;
    // 크기·일반 파일·상한 판정은 적용 경로와 같은 함수를 쓴다. 읽기만 따로 판정하면 화면이
    // "열리는 patch"를 보여 주는데 적용은 거절하는 어긋남이 생긴다.
    let stored = match verify_stored_patch(&patch_path) {
        Ok(stored) => stored,
        Err(error) => {
            answer.reason = Some(error.to_string());
            return Ok(answer);
        }
    };
    answer.bytes = stored.patch_bytes;
    answer.digest_matches = set.patch_digest.as_deref() == Some(stored.patch_digest.as_str());
    answer.stored_digest = Some(stored.patch_digest);

    let bytes = fs::read(&patch_path).map_err(CoreError::Io)?;
    // `--binary`로 뜬 patch의 바이너리 덩어리는 git이 base64로 적으므로 보통은 UTF-8이다.
    // 그래도 파일 내용이 그대로 들어가는 자리라 UTF-8이 아닐 수 있고, 그때 손실 변환으로
    // 꾸며 보여 주면 사용자가 그 글자를 그대로 옮겨 적는다. 사유만 적고 본문은 비운다.
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            answer.reason = Some("UTF-8로 읽을 수 없는 patch라 본문을 싣지 않았습니다".to_owned());
            return Ok(answer);
        }
    };
    if text.len() > MAX_PATCH_TEXT_BYTES {
        // 글자 경계에서 끊는다. 바이트로 자르면 뒤쪽이 깨진 문자가 되어 화면에 치환 문자가
        // 남고, 그것이 patch의 일부인지 잘린 자국인지 구분되지 않는다.
        let mut end = MAX_PATCH_TEXT_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        answer.truncated = true;
        answer.reason = Some(format!(
            "patch가 {}바이트라 앞 {MAX_PATCH_TEXT_BYTES}바이트만 실었습니다",
            stored.patch_bytes
        ));
        answer.text = Some(text[..end].to_owned());
    } else {
        answer.text = Some(text);
    }
    Ok(answer)
}

// ---------------------------------------------------------------------------
// 변경
// ---------------------------------------------------------------------------

/// 세트를 만들거나 고친다. 여기서 끝나는 것은 **경로 검증**(`.git` 성분·pathspec 매직·루트
/// 밖 탈출)이다. 파일 상태 판정(C19-3)은 git을 띄워야 알 수 있어 스냅샷이 다시 한다.
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
        repository_root: overlay_repository_root(repository_root)
            .to_string_lossy()
            .into_owned(),
        paths,
        created_at,
        updated_at: now,
        base_head,
        snapshot_id: snapshot_id.clone(),
        patch_digest: patch_digest.clone(),
        state,
    };
    // staged write 뒤 atomic replace, 0600(C19-1). 쓰다 만 meta.json이 남으면 다음 조회에서
    // 그 세트가 통째로 사라진 것처럼 보인다. 폴더를 먼저 0700으로 만드는 이유는
    // `write_private_json`의 `create_dir_all`이 umask를 따라 0755로 만들기 때문이다 —
    // 세트 폴더를 처음 만드는 자리가 여기다.
    let set_dir = dir.join(&set_id);
    create_private_dir_all(&set_dir, overlay_boundary(&set_dir))?;
    write_private_json(&set_dir.join(META_FILE), &set)?;

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
    let root = overlay_root(app_data_dir);
    let trash = root.join(OVERLAY_TRASH).join(&group);
    // 휴지통도 overlay 저장 폴더다(C19-1, 0700). `create_dir_all`은 umask를 따라 0755로
    // 만들어, 지운 세트의 이름·저장소 경로가 담긴 자리를 다른 사용자가 훑을 수 있었다.
    create_private_dir_all(&trash, Some(&root))?;
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
        // 민감 경로라는 이유로 거르는 단계는 없다(C19-2). 판정은 파일 상태 하나뿐이다.
        let reason =
            index_reason(&index.stdout, &path).or_else(|| status_reason(&status.stdout, &path));
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
    let parent = patch_path.parent().ok_or_else(|| {
        CoreError::InvalidInput("overlay patch 경로에 상위 폴더가 없습니다".to_owned())
    })?;
    create_private_dir_all(parent, overlay_boundary(parent))?;
    sweep_stale_patch_temporaries(parent);
    // 같은 디렉터리의 임시 파일에 먼저 받는다(C19-1). git은 `--output`을 O_TRUNC로 열므로,
    // 먼저 0600으로 만들어 두면 본문이 디스크에 닿는 순간부터 소유자만 읽을 수 있다 —
    // 나중에 chmod 하면 그 사이에 patch(=사용자 파일 본문)가 0644로 존재한다.
    let temporary = parent.join(format!("{PATCH_TEMP_PREFIX}{}.tmp", Uuid::new_v4()));
    let result = write_overlay_patch_to(runner, patch_path, &temporary, parent, paths);
    if result.is_err() {
        // 실패한 쓰기가 반쯤 남는 길을 닫는다. 작업 트리도, 이전 patch도 아직 그대로다.
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// `write_overlay_patch`의 본체. 임시 파일 정리를 호출부 한 자리에 모으려고 분리했다.
fn write_overlay_patch_to(
    runner: &GitRunner,
    patch_path: &Path,
    temporary: &Path,
    parent: &Path,
    paths: &[String],
) -> Result<(), CoreError> {
    drop(open_private_file(temporary, true)?);
    // 2026-10-02 실측: 앱 데이터 경로는 `fs::canonicalize`를 거치면 Windows 확장 길이 형식
    // (`\\?\C:\...`)이 되고, 그대로 넘기면 git이 `could not open '//?/C:/...': Invalid
    // argument`로 거절한다. 자식에게 넘기는 경로는 이 저장소의 다른 자리와 같은 변환을
    // 지난다(`path_guard::child_facing`).
    let output = format!(
        "--output={}",
        crate::path_guard::child_facing(temporary).to_string_lossy()
    );
    let mut args = OVERLAY_DIFF_ARGS.to_vec();
    args.push(output.as_str());
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    let outcome = runner.overlay_read_with_input(&args, None, LOCAL_MUTATION_TIMEOUT)?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "overlay patch를 뜨지 못했습니다: {}",
            outcome.stderr.lines().next().unwrap_or("").trim()
        )));
    }
    // git이 파일을 지웠다 다시 만들었을 수 있으므로 권한을 한 번 더 못박는다.
    set_private_file_mode(temporary)?;
    // 내용이 디스크에 닿은 뒤에야 이름을 바꾼다. 여기서 전원이 끊겨도 최종 경로에는
    // 이전 patch가 온전히 남거나 새 patch가 온전히 들어가거나 둘 중 하나다.
    //
    // `File::open`이 아니라 `open_private_file`로 다시 여는 이유: Windows의 `sync_all`은
    // `FlushFileBuffers`이고 이 API는 핸들에 쓰기 권한을 요구한다. 읽기 전용 핸들로 부르면
    // 그 플랫폼에서만 `액세스가 거부되었습니다`로 떨어져 overlay 저장이 통째로 죽는다.
    open_private_file(temporary, false)?.sync_all()?;
    fs::rename(temporary, patch_path)?;
    // 이름이 이미 바뀐 뒤다. 상위 폴더 fsync가 실패해도 디스크에는 새 patch가 온전히 들어가
    // 있으므로, 여기서 Err를 올리면 "실패했다고 적힌 성공"이 되어 장부의 digest만 어긋난다.
    let _ = sync_dir(parent);
    Ok(())
}

/// 앱 데이터 overlay 루트. `create_private_dir_all`이 0700을 박아도 되는 천장이다.
///
/// patch 경로는 `<app data>/git-overlays/<저장소>/<스냅샷>/overlay.patch`라, 세트 폴더에서
/// 두 단계 위가 overlay 루트다. 그 위(앱 데이터 자체, 나아가 `~/Library/Application Support`)
/// 는 이 어댑터의 쓰기 대상이 아니므로 권한을 건드리지 않는다.
fn overlay_boundary(set_dir: &Path) -> Option<&Path> {
    set_dir.parent().and_then(Path::parent)
}

/// 남은 임시 patch를 치운다. 저장 중에 프로세스가 죽으면 `.overlay.patch.<uuid>.tmp`가
/// 세트 폴더에 남고, 치우는 자리가 없으면 세트를 지울 때 휴지통까지 따라간다. 저장소 잠금을
/// 쥔 상태에서만 불리므로 지금 쓰이는 임시 파일과 경합하지 않는다. 실패는 무시한다 —
/// 청소가 안 됐다고 저장을 막을 이유는 없다.
///
/// 이 접두어는 `exclude_project_overlay_paths`가 같은 폴더에 쓸 때 `write_private_bytes`가
/// 만드는 임시 이름(`.overlay.patch.<uuid>.tmp`)과 **같다**. 둘 다 같은 저장소 잠금
/// (`overlay_lock_root`) 안에서만 돌기 때문에 지금은 겹치지 않는다 — 잠금 밖에서 세트 폴더에
/// 쓰는 자리가 생기면 진행 중인 임시 파일을 여기서 지우게 된다.
fn sweep_stale_patch_temporaries(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(PATCH_TEMP_PREFIX) || !name.ends_with(".tmp") {
            continue;
        }
        if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

const PATCH_TEMP_PREFIX: &str = ".overlay.patch.";

/// 세트 폴더는 소유자만 들어갈 수 있어야 한다(C19-1). `create_dir_all`은 umask에 따라
/// 0755로도 만들므로, 만든 단계와 **목적지 자체**에 0700을 다시 박는다. 목적지를 조건 없이
/// 박는 이유는 세트 폴더를 처음 만드는 쪽이 `write_private_json`(meta.json)일 수 있기
/// 때문이다 — 그때 umask가 남긴 0755를 여기서 좁히지 않으면 C19-1은 제품 경로에서 성립하지
/// 않는다. 이 경로들은 모두 앱이 소유하므로 넓히는 일은 없고, `boundary` 위로는 올라가지
/// 않는다.
fn create_private_dir_all(dir: &Path, boundary: Option<&Path>) -> Result<(), CoreError> {
    let mut created = Vec::new();
    let mut cursor = Some(dir);
    while let Some(path) = cursor {
        if path.exists() {
            break;
        }
        created.push(path.to_path_buf());
        if boundary == Some(path) {
            break;
        }
        cursor = path.parent();
    }
    fs::create_dir_all(dir)?;
    for path in created {
        set_private_dir_mode(&path)?;
    }
    set_private_dir_mode(dir)?;
    Ok(())
}

/// `fs::set_permissions`는 링크를 따라간다. 세트 폴더 자리에 디렉터리 심볼릭 링크가 놓여
/// 있으면 **그 대상**의 권한을 좁히게 되고, 그 대상은 앱 데이터 밖일 수 있다. 권한을 바꾸기
/// 전에 그 자리가 링크가 아닌 진짜 디렉터리인지 확인한다(G10).
fn set_private_dir_mode(path: &Path) -> Result<(), CoreError> {
    let kind = fs::symlink_metadata(path)?.file_type();
    if !kind.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "overlay 저장 폴더가 일반 디렉터리가 아닙니다: {}",
            path.display()
        )));
    }
    set_dir_mode_0700(path)
}

#[cfg(unix)]
fn set_dir_mode_0700(path: &Path) -> Result<(), CoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_dir_mode_0700(_path: &Path) -> Result<(), CoreError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_mode(path: &Path) -> Result<(), CoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_mode(_path: &Path) -> Result<(), CoreError> {
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

/// C19-3이 요구하는 patch 인자. 제품과 가드 시험이 **같은 값**을 보도록 이름을 붙였다.
///
/// 2026-10-04 실측: 이 자리가 날것의 argv 리터럴이었을 때, `overlay_c19_snapshot_keeps_
/// required_git_arguments`는 `include_str!`로 **파일 본문에 그 문자열이 있는지**만 봤다.
/// 그래서 제품 argv에서 네 인자를 전부 빼고 `mod tests`에 쓰이지도 않는
/// `const LEGACY_OVERLAY_ARGS: &[&str] = &["--binary", …]` 한 줄을 두자 가드는 통과했다 —
/// 그 상태의 제품은 patch를 축약 해시로 뜨고 되돌림은 `restore --staged`라 작업 트리를
/// 한 글자도 바꾸지 않는다. 상수로 올리면 가드가 보는 것이 본문이 아니라 제품이 실제로
/// 넘기는 값이 되므로, 미끼로는 통과시킬 수 없다.
pub(crate) const OVERLAY_DIFF_ARGS: [&str; 3] = ["diff", "--binary", "--full-index"];

/// 되돌림의 argv. `--source=HEAD`는 무엇으로 되돌리는지를 못박고, `--worktree`는 인덱스를
/// 건드리지 않는다는 뜻이다. 경로는 argv가 아니라 stdin으로 간다(C16-5).
pub(crate) const OVERLAY_RESTORE_ARGS: [&str; 5] = [
    "restore",
    "--source=HEAD",
    "--worktree",
    "--pathspec-from-file=-",
    "--pathspec-file-nul",
];

/// 3단계. 선택된 경로만 HEAD 원본으로 되돌린다.
///
/// `git checkout`이 아니라 `restore`인 이유는 범위가 좁기 때문이다(C19-3). `--source=HEAD`는
/// 무엇으로 되돌리는지를 못박고, `--worktree`는 인덱스를 건드리지 않는다는 뜻이다.
pub(crate) fn restore_worktree_from_head(
    runner: &GitRunner,
    pathspec_payload: &[u8],
) -> Result<(), CoreError> {
    let outcome = runner.overlay_write_with_input(
        &OVERLAY_RESTORE_ARGS,
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
/// (C19-3 지원 상태 — 민감 경로 거절은 2026-10-05 결정으로 없다)과 저장소 단위 잠금(C19-3)도
/// 이 함수 안에 있다.
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
        apply_failure_paths(
            &format!("{}\n{}", outcome.stdout, outcome.stderr),
            &set.paths,
        )
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

/// `git apply --check`가 막았을 때 어느 경로가 막았는지(C19-5의 `affected`).
///
/// 검사(`check_project_overlay_apply`)와 적용(`apply_project_overlay`)이 **같은 함수**를
/// 쓴다. 2026-10-05 이전에는 두 벌이 따로 있었고 한쪽만 이름에 공백이 든 경로를 버렸다 —
/// 같은 충돌을 검사는 빈 목록으로, 적용은 경로 하나로 적었다.
///
/// git은 실패를 두 모양으로 적는다 — `error: patch failed: <경로>:<줄>`과
/// `error: <경로>: <사유>`. 둘 다 읽는다. 사유 문구는 싣지 않는다: 거기에는 충돌한 줄의
/// **내용**이 섞여 들어올 수 있고, 영수증에 파일 내용이 들어가는 길은 C19-5가 닫은 길이다.
///
/// 설명문을 경로로 세지 않기 위해 **세트가 적어 둔 경로를 먼저 본다**. 2026-10-05 실측:
/// 이름에 공백이 든 파일(`my file.txt`)에 대해 git 은
/// `error: patch failed: my file.txt:1` / `error: my file.txt: patch does not apply` 를
/// 적는다. 공백이 든 조각을 설명문으로 보고 버리면 이 파일은 영수증에서 사라지고, 화면은
/// "충돌했으니 풀어라"라고만 적으면서 무엇을 풀어야 하는지 말하지 못한다. 세트에 없는
/// 경로는 예전 기준(공백 없음)으로만 받는다 — 세트 밖 이름을 git 이 댈 일은 없지만, 댔을
/// 때 목록을 통째로 비우는 쪽이 더 나쁘다.
fn apply_failure_paths(output: &str, set_paths: &[String]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("error: ")
            .or_else(|| trimmed.strip_prefix("fatal: "))
        else {
            continue;
        };
        let candidate = match rest.strip_prefix("patch failed: ") {
            // `<경로>:<줄>` 꼬리를 뗀다. 경로 자체에 콜론이 있을 수 있으므로 **마지막**
            // 콜론만 보고, 그 뒤가 숫자일 때만 뗀다.
            Some(tail) => match tail.rsplit_once(':') {
                Some((path, line_no))
                    if !line_no.is_empty() && line_no.chars().all(|c| c.is_ascii_digit()) =>
                {
                    path
                }
                _ => tail,
            },
            None => match rest.split_once(": ") {
                Some((path, reason)) if !reason.trim().is_empty() => path,
                _ => continue,
            },
        }
        .trim();
        if candidate.is_empty() {
            continue;
        }
        let known = set_paths.iter().any(|path| path == candidate);
        if !known && candidate.contains(' ') {
            continue;
        }
        if paths.iter().any(|seen| seen == candidate) {
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
        let affected = apply_failure_paths(&checked.stderr, &set.paths);
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

/// 앱이 시작한 Git 작업 뒤에 보관된 overlay를 **스스로 다시 넣는다**(C19-3).
///
/// C19-3은 자동 검사·적용을 "앱이 시작한 Git 작업(switch/pull/rebase/merge) 뒤"로만
/// 허용하고, 터미널 같은 외부 작업 뒤에는 검사 결과와 적용 버튼만 내밀라고 못박았다.
/// 바깥쪽 절반은 [`get_project_overlay_drift`]가 맡고 있었는데 안쪽 절반 — 앱이 브랜치를
/// 옮긴 **직후** 다시 넣는 고리 — 는 비어 있었다. 그래서 형상관리 탭에서 브랜치를 옮기면
/// 사용자가 overlay 탭으로 건너가 검사와 적용을 두 번 더 눌러야 했고, 그 수고가 바로
/// overlay가 없애려던 수고였다.
///
/// 판정을 `head_moved`로 하지 **않는** 것이 이 함수에서 가장 조심한 자리다. C19-3은 "Git
/// 작업 자체가 실패하면 이전 브랜치에서 재적용을 시도"하라고 적었는데, 실패한 switch는
/// HEAD를 움직이지 않는다. 그 경우까지 담으려면 기준은 "HEAD가 움직였는가"가 아니라
/// "patch가 보관된 채인가"여야 한다 — `stored`는 작업 트리가 HEAD 원본으로 되돌아가 있고
/// 로컬 변경이 빠져 있다는 뜻이므로, 성공했든 실패했든 다시 넣는 것이 맞다. `registered`는
/// 뜬 patch가 없고 `applied`는 이미 들어가 있어 둘 다 건너뛴다.
///
/// 세트마다 [`apply_project_overlay`]를 그대로 부른다. 검사(`git apply --check`)가 먼저
/// 돌고 통과할 때만 적용하는 계약을 여기서 다시 쓰지 않기 위해서다 — 자동 경로가 자기만의
/// 적용 경로를 가지면 수동 경로에만 있는 안전장치가 생긴다. 한 세트가 `overlayNeedsResolution`
/// 으로 막혀도 나머지는 계속 시도한다. 세트는 서로 독립이고, 하나가 충돌했다고 다른 세트의
/// 로컬 설정까지 빠뜨릴 이유가 없다. 막힌 세트의 patch는 앱 데이터에 그대로 남는다(C19-3).
pub fn reapply_project_overlays(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &ReapplyProjectOverlaysRequest,
) -> Result<ProjectOverlayReapply, CoreError> {
    reapply_project_overlays_with_env(app_data_dir, repository_root, request, Vec::new())
}

/// [`reapply_project_overlays`]와 같은 일을 하되 git 자식 프로세스에 환경을 더 얹는다
/// (`snapshot_project_overlay_with_env`와 같은 이유 — 시험이 임시 저장소를 쓴다).
pub(crate) fn reapply_project_overlays_with_env(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &ReapplyProjectOverlaysRequest,
    extra_env: Vec<(String, String)>,
) -> Result<ProjectOverlayReapply, CoreError> {
    let listed = list_project_overlay_sets(app_data_dir, repository_root)?;
    let project_path = repository_root.to_string_lossy().into_owned();
    let mut receipts = Vec::new();
    let mut failed = Vec::new();
    for set in listed
        .sets
        .iter()
        .filter(|set| set.state == ProjectOverlayState::Stored)
    {
        // 한 세트의 오류로 **되돌아가지 않는다**(C19-3). `?`로 끊으면 세트 하나를 읽지
        // 못한 것이 나머지 세트의 복구를 통째로 가져가고, 돌아가는 것은 오류뿐이라
        // "재적용까지 실패해도 patch는 보존하고 복구 영수증을 남긴다"는 조건이 깨진다 —
        // 남는 영수증이 아예 없기 때문이다. 그래서 사유만 적고 다음 세트로 간다.
        match apply_project_overlay_with_env(
            app_data_dir,
            repository_root,
            &ApplyProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set.set_id.clone(),
            },
            extra_env.clone(),
        ) {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => failed.push(ProjectOverlayReapplyFailure {
                set_id: set.set_id.clone(),
                reason: error.to_string(),
            }),
        }
    }
    let head = GitRunner::open_with_env(app_data_dir, repository_root, extra_env)
        .ok()
        .and_then(|runner| runner.overlay_head_sha().ok())
        .flatten();
    let applied = receipts
        .iter()
        .filter(|receipt| receipt.outcome == ProjectOverlayOutcome::Applied)
        .count();
    let needs_resolution = receipts
        .iter()
        .filter(|receipt| receipt.outcome == ProjectOverlayOutcome::OverlayNeedsResolution)
        .count();
    let busy = receipts
        .iter()
        .filter(|receipt| receipt.outcome == ProjectOverlayOutcome::Busy)
        .count();
    Ok(ProjectOverlayReapply {
        schema_version: OVERLAY_SCHEMA_VERSION,
        repository_id: listed.repository_id,
        repository_root: listed.repository_root,
        head,
        trigger: ProjectOverlayTrigger::App,
        applied,
        needs_resolution,
        busy,
        failed,
        recovery: request.recovery,
        receipts,
        unreadable: listed.unreadable,
    })
}

// ---------------------------------------------------------------------------
// 제외 — 충돌한 경로를 세트에서 빼고 나머지 patch는 살린다(C19-3 충돌 해결, C19-5)
// ---------------------------------------------------------------------------

/// 영수증에 실리는 행동 이름. 화면과 시험이 같은 문자열을 읽는다.
const EXCLUDE_ACTION: &str = "excludeOverlayPaths";

/// 세트에서 경로 몇 개를 빼는 요청.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludeProjectOverlayPathsRequest {
    pub project_path: String,
    pub set_id: String,
    /// 세트에서 뺄 저장소 루트 기준 상대 경로.
    pub paths: Vec<String>,
}

/// 보관한 patch에서 한 파일의 구역이 어디서 시작하는지 알리는 표식.
const PATCH_SECTION_HEADER: &[u8] = b"diff --git ";

/// patch 한 구역의 머리글에서 대상 경로를 읽는다.
///
/// 머리글은 `diff --git a/<경로> b/<경로>`다. 경로에 공백이 들어갈 수 있으므로 `" b/"`를
/// 처음 만나는 자리에서 자르면 틀린다 — 양쪽을 다 떼어 **같은 값일 때만** 경로로 받는다.
/// git이 따옴표로 감싼 머리글은 여기서 풀지 않고 `None`을 돌려주며, 호출부는 그때 아무것도
/// 바꾸지 않는다. 읽지 못한 구역을 "지울 것이 아니다"로 넘기면 빼 달라고 한 파일의 내용이
/// patch에 남고, 반대로 지우면 남겨야 할 변경을 잃는다.
fn patch_section_path(header_line: &[u8]) -> Option<String> {
    let header = std::str::from_utf8(header_line).ok()?.trim_end();
    let rest = header.strip_prefix("diff --git ")?;
    if rest.starts_with('"') {
        return None;
    }
    let left = rest.strip_prefix("a/")?;
    let mut from = 0usize;
    while let Some(offset) = left[from..].find(" b/") {
        let at = from + offset;
        let (a_side, b_side) = (&left[..at], &left[at + 3..]);
        if a_side == b_side && !a_side.is_empty() {
            return Some(a_side.to_owned());
        }
        from = at + 1;
    }
    None
}

/// 보관한 patch를 파일 구역으로 가르고, `removed`에 든 경로의 구역만 뺀 새 patch를 만든다.
///
/// 구역을 하나라도 읽지 못하면 `None`이다. 부분적으로만 확신할 수 있는 patch를 쓰는 길은
/// 열지 않는다 — 그 patch는 다음 적용에서 무엇이 들어갈지 사용자도 앱도 모른다(C19-3).
fn patch_without_paths(patch: &[u8], removed: &[String]) -> Option<(Vec<u8>, Vec<String>)> {
    let mut starts: Vec<usize> = Vec::new();
    for at in 0..patch.len() {
        if patch[at..].starts_with(PATCH_SECTION_HEADER) && (at == 0 || patch[at - 1] == b'\n') {
            starts.push(at);
        }
    }
    if starts.is_empty() {
        return None;
    }
    let mut kept: Vec<u8> = Vec::with_capacity(patch.len());
    let mut dropped: Vec<String> = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(patch.len());
        let section = &patch[*start..end];
        let header_end = section
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap_or(section.len());
        let path = patch_section_path(&section[..header_end])?;
        if removed.contains(&path) {
            dropped.push(path);
        } else {
            kept.extend_from_slice(section);
        }
    }
    Some((kept, dropped))
}

/// 세트에서 경로를 빼고, 보관한 patch에서도 그 경로의 구역을 덜어낸다.
///
/// 계획의 충돌 해결 UX가 사용자에게 주기로 한 선택지 가운데 하나다. `apply`가
/// `overlayNeedsResolution`으로 막혔을 때 지금까지 남은 길은 충돌한 파일을 손으로 정리하거나
/// 세트를 통째로 버리는 둘뿐이었다. 그런데 막는 것은 보통 세트 안의 **한 파일**이고, 나머지
/// 경로의 변경은 그대로 들어갈 수 있다. 그 하나 때문에 세트를 버리면 patch는 휴지통으로 가고
/// 나머지 파일의 로컬 설정도 같이 사라진다 — overlay가 없애려던 수고가 그 자리에서 돌아온다.
///
/// 되돌릴 자리(C19-5): 덜어내기 **전의** patch는 지우지 않고 세트 삭제와 같은 앱 소유
/// 휴지통으로 옮긴다. patch는 캐시가 아니라 사용자 로컬 데이터라 다시 만들어 주는 주체가
/// 없고, 덜어낸 구역이 그 변경의 유일한 사본이기 때문이다. 순서도 스냅샷과 같다 — 새 patch를
/// 먼저 쓰고 digest까지 확인한 뒤에야 장부를 고친다.
///
/// 작업 트리는 한 글자도 바뀌지 않는다. 이 함수는 git을 띄우지 않고 앱 데이터만 고친다.
/// 그래도 저장소 단위 잠금(C16-3)을 잡는 이유는 patch 파일 자체를 바꾸기 때문이다 —
/// `apply`가 digest를 확인한 뒤 적용하기 전 사이에 patch가 바뀌면 그 확인이 무의미해진다.
pub fn exclude_project_overlay_paths(
    app_data_dir: &Path,
    repository_root: &Path,
    request: &ExcludeProjectOverlayPathsRequest,
) -> Result<ProjectOverlayReceipt, CoreError> {
    let set_id = validate_set_id(&request.set_id)?;
    if request.paths.is_empty() {
        return Err(CoreError::InvalidInput(
            "세트에서 뺄 경로를 하나 이상 고르세요".to_owned(),
        ));
    }
    if request.paths.len() > MAX_PATHS_PER_SET {
        return Err(CoreError::InvalidInput(format!(
            "한 번에 경로를 {MAX_PATHS_PER_SET}개까지 뺄 수 있습니다"
        )));
    }
    let repository_id = overlay_repository_id(repository_root);
    let dir = repository_dir(app_data_dir, &repository_id).join(&set_id);
    let mut set: ProjectOverlaySet = read_private_json(&dir.join(META_FILE))?
        .ok_or_else(|| CoreError::NotFound(format!("overlay 세트를 찾지 못했습니다: {set_id}")))?;

    // 요청 경로는 세트에 적힌 것과 **같은 정규화**를 지나야 비교가 성립한다(C16-5, G10).
    let mut removed: Vec<String> = Vec::new();
    let mut rejected: Vec<ProjectOverlayRejection> = Vec::new();
    for raw in &request.paths {
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
        if !set.paths.contains(&path) {
            rejected.push(ProjectOverlayRejection {
                path,
                reason: "이 세트에 없는 경로입니다".to_owned(),
            });
            continue;
        }
        if !removed.contains(&path) {
            removed.push(path);
        }
    }
    // 하나라도 빼지 못하면 아무것도 바꾸지 않는다. 일부만 빼 두면 사용자는 충돌한 파일이
    // 세트에서 나갔다고 믿은 채 다시 적용을 누르고, 같은 자리에서 또 막힌다.
    if !rejected.is_empty() {
        return Ok(exclude_rejected(
            set_id,
            set.snapshot_id,
            set.patch_digest,
            "세트에서 뺄 수 없는 경로가 있어 아무것도 바꾸지 않았습니다".to_owned(),
            rejected,
        ));
    }
    let remaining: Vec<String> = set
        .paths
        .iter()
        .filter(|path| !removed.contains(path))
        .cloned()
        .collect();
    if remaining.is_empty() {
        return Ok(exclude_rejected(
            set_id,
            set.snapshot_id,
            set.patch_digest,
            "세트의 경로를 모두 빼면 남는 것이 없습니다 — 세트를 지우세요".to_owned(),
            Vec::new(),
        ));
    }

    // patch 파일을 바꾸므로 git 변경·적용과 겹치지 않게 저장소 단위 잠금을 잡는다(C19-3).
    let Some(_guard) = BusyGuard::acquire(&overlay_lock_root(repository_root)) else {
        return Ok(ProjectOverlayReceipt {
            action: EXCLUDE_ACTION.to_owned(),
            succeeded: false,
            outcome: ProjectOverlayOutcome::Busy,
            message: "같은 저장소에서 다른 변경이 진행 중입니다. 끝난 뒤 다시 시도하세요"
                .to_owned(),
            head_before: None,
            head_after: None,
            set_id: Some(set_id),
            snapshot_id: set.snapshot_id.clone(),
            patch_digest: set.patch_digest.clone(),
            affected: Vec::new(),
            rejected: Vec::new(),
            trigger: ProjectOverlayTrigger::App,
        });
    };

    let mut dropped_from_patch: Vec<String> = Vec::new();
    if let Some(snapshot_id) = set.snapshot_id.clone() {
        let patch_path = overlay_patch_path(app_data_dir, &repository_id, &snapshot_id)?;
        let stored = verify_stored_patch(&patch_path)?;
        // 장부가 적어 둔 digest와 디스크의 patch가 다르면 무엇을 덜어내는지 알 수 없다.
        if set.patch_digest.as_deref() != Some(stored.patch_digest.as_str()) {
            return Ok(exclude_rejected(
                set_id,
                Some(snapshot_id),
                Some(stored.patch_digest),
                "보관 시점과 다른 patch입니다. 세트를 다시 스냅샷하세요".to_owned(),
                Vec::new(),
            ));
        }
        let bytes = fs::read(&patch_path).map_err(CoreError::Io)?;
        let Some((kept, dropped)) = patch_without_paths(&bytes, &removed) else {
            return Ok(exclude_rejected(
                set_id,
                Some(snapshot_id),
                set.patch_digest.clone(),
                "보관한 patch의 구역을 읽지 못해 아무것도 바꾸지 않았습니다".to_owned(),
                Vec::new(),
            ));
        };
        dropped_from_patch = dropped;

        // 덜어내기 전의 patch를 먼저 휴지통으로 **옮긴다**(C19-5, C3-11). 지우지 않으므로
        // 덜어낸 구역이 유일한 사본인 채로 사라지는 길이 없다. 매니페스트는 옮긴 뒤에 쓴다.
        let group = format!("{}-{}", now_seconds(), Uuid::new_v4());
        let root = overlay_root(app_data_dir);
        let trash = root.join(OVERLAY_TRASH).join(&group);
        create_private_dir_all(&trash.join(&set_id), Some(&root))?;
        fs::rename(&patch_path, trash.join(&set_id).join("overlay.patch"))?;
        write_private_json(
            &trash.join(MANIFEST_FILE),
            &serde_json::json!({
                "schemaVersion": OVERLAY_SCHEMA_VERSION,
                "repositoryId": repository_id,
                "repositoryRoot": set.repository_root,
                "setId": set_id,
                "name": set.name,
                "action": EXCLUDE_ACTION,
                "excludedPaths": removed,
                "deletedAt": now_seconds(),
            }),
        )?;

        if kept.is_empty() {
            // 남은 경로에 담긴 변경이 하나도 없다. patch 없이 `stored`로 두면 적용이
            // "보관된 patch가 없다"로 끝나므로 장부도 등록 단계로 되돌린다.
            set.base_head = None;
            set.snapshot_id = None;
            set.patch_digest = None;
            set.state = ProjectOverlayState::Registered;
        } else {
            write_private_bytes(&patch_path, &kept)?;
            // 새 patch도 스냅샷과 같은 확인을 지난다 — 쓰고 끝내지 않고 다시 읽어 digest를 낸다.
            let rewritten = verify_stored_patch(&patch_path)?;
            set.patch_digest = Some(rewritten.patch_digest);
        }
    }

    set.paths = remaining;
    set.updated_at = now_seconds();
    write_private_json(&dir.join(META_FILE), &set)?;

    Ok(ProjectOverlayReceipt {
        action: EXCLUDE_ACTION.to_owned(),
        succeeded: true,
        outcome: ProjectOverlayOutcome::Saved,
        message: format!(
            "{}개 경로를 세트에서 뺐습니다(patch에서 덜어낸 파일 {}개, 이전 patch는 휴지통에 있습니다)",
            removed.len(),
            dropped_from_patch.len()
        ),
        head_before: None,
        head_after: None,
        set_id: Some(set_id),
        snapshot_id: set.snapshot_id.clone(),
        patch_digest: set.patch_digest.clone(),
        // 세트에서 빠진 경로를 싣는다. 검사 실패의 `affected`와 같은 칸을 쓰는 이유는 화면이
        // "이번 요청이 건드린 경로"를 한 자리에서 읽기 때문이다 — 충돌한 경로를 보고 그대로
        // 이 요청에 넘기고, 돌아온 영수증의 같은 칸에서 빠진 것을 확인한다.
        affected: removed,
        rejected: Vec::new(),
        trigger: ProjectOverlayTrigger::App,
    })
}

fn exclude_rejected(
    set_id: String,
    snapshot_id: Option<String>,
    patch_digest: Option<String>,
    message: String,
    rejected: Vec<ProjectOverlayRejection>,
) -> ProjectOverlayReceipt {
    ProjectOverlayReceipt {
        action: EXCLUDE_ACTION.to_owned(),
        succeeded: false,
        outcome: ProjectOverlayOutcome::Rejected,
        message,
        head_before: None,
        head_after: None,
        set_id: Some(set_id),
        snapshot_id,
        patch_digest,
        affected: Vec::new(),
        rejected,
        trigger: ProjectOverlayTrigger::App,
    }
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
        let set_paths = vec!["src/config.ts".to_owned(), "docs/notes.md".to_owned()];
        let affected = apply_failure_paths(stderr, &set_paths);
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

    /// 2026-10-05 사용자 결정(C19-2). 민감해 보이는 경로를 **거절하지 않는다.**
    ///
    /// 뒤집은 것이지 느슨해진 것이 아니다. overlay가 존재하는 이유가 바로 `.env`·키 파일 같은
    /// 로컬 전용 설정을 브랜치를 옮길 때마다 잃지 않는 것이라, 그것을 막으면 기능이 서 있을
    /// 이유가 사라진다. 막아 두어도 그 값은 어차피 사용자의 작업 트리에 그대로 있었다.
    ///
    /// 그래서 "거절하지 않는다"만 보면 모자란다 — 받아들인 **대신** 지켜야 하는 자리까지 한
    /// 번에 고정한다. 실제 git·실제 파일로 끝까지 돌려서 (1) 저장이 거절 없이 성공하고
    /// (2) 민감 경로가 patch에 실제로 담기고 (3) 작업 트리가 HEAD 원본으로 돌아가고
    /// (4) 보관 자리가 C19-1의 0700/0600이고 (5) 다시 적용하면 값이 글자 그대로 돌아오는
    /// 것을 본다. (4)가 없으면 이 결정은 비밀값을 0644로 옮기는 변경이 된다.
    #[test]
    fn project_overlay_c19_2_accepts_sensitive_paths() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        // 커밋된 민감 파일들. overlay가 담는 것은 추적된 파일의 unstaged 변경이다(C19-3).
        let sensitive = [
            (".env", "TOKEN=prod\n", "TOKEN=local-dev\n"),
            (
                "config/credentials/aws.json",
                "{\"key\":\"prod\"}\n",
                "{\"key\":\"local\"}\n",
            ),
            ("certs/server.pem", "PROD PEM\n", "LOCAL PEM\n"),
            ("keys/id_rsa", "PROD KEY\n", "LOCAL KEY\n"),
            (".npmrc", "registry=prod\n", "registry=local\n"),
        ];
        for (path, committed, _) in sensitive {
            let target = repo.root.join(path);
            fs::create_dir_all(target.parent().expect("부모")).expect("폴더");
            fs::write(&target, committed).expect("seed");
        }
        overlay_git(&repo.root, &["add", "-A"]);
        overlay_git(&repo.root, &["commit", "-q", "-m", "sensitive seed"]);
        for (path, _, edited) in sensitive {
            fs::write(repo.root.join(path), edited).expect("edit");
        }

        let paths: Vec<String> = sensitive
            .iter()
            .map(|(path, _, _)| (*path).to_owned())
            .collect();
        let project_path = repo.root.to_string_lossy().into_owned();

        // (1) 저장이 거절 없이 성공한다.
        let saved = save_project_overlay_set(
            &repo.app_data,
            &repo.root,
            &SaveProjectOverlaySetRequest {
                project_path: project_path.clone(),
                set_id: None,
                name: "로컬 비밀".to_owned(),
                paths: paths.clone(),
            },
        )
        .expect("저장");
        assert!(
            saved.succeeded && saved.rejected.is_empty(),
            "민감 경로를 거절했다: {saved:?}"
        );
        let set_id = saved.set_id.expect("세트 id");

        // (2)(3) 스냅샷이 전부 담고 작업 트리를 HEAD 원본으로 되돌린다.
        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                trigger: None,
            },
            overlay_test_env(),
        )
        .expect("스냅샷");
        assert!(
            snapshot.succeeded && snapshot.rejected.is_empty(),
            "스냅샷이 민감 경로를 거절했다: {snapshot:?}"
        );
        for (path, committed, _) in sensitive {
            assert_eq!(
                fs::read_to_string(repo.root.join(path)).expect("읽기"),
                committed,
                "{path}가 HEAD 원본으로 돌아가지 않았다"
            );
        }

        // (4) 보관 자리는 C19-1의 0700/0600이고, patch에 값이 실제로 담겼다.
        let snapshot_id = list_project_overlay_sets(&repo.app_data, &repo.root)
            .expect("목록")
            .sets
            .into_iter()
            .find(|set| set.set_id == set_id)
            .and_then(|set| set.snapshot_id)
            .expect("snapshot id");
        let patch_path = overlay_patch_path(
            &repo.app_data,
            &overlay_repository_id(&repo.root),
            &snapshot_id,
        )
        .expect("patch 경로");
        let patch = fs::read_to_string(&patch_path).expect("patch");
        for (path, _, edited) in sensitive {
            assert!(
                patch.contains(path) && patch.contains(edited.trim_end()),
                "{path}의 로컬 값이 patch에 담기지 않았다"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&patch_path)
                    .expect("patch 권한")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
                "비밀값이 든 patch가 0600이 아니다"
            );
            assert_eq!(
                fs::metadata(patch_path.parent().expect("세트 폴더"))
                    .expect("폴더 권한")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700,
                "비밀값이 든 세트 폴더가 0700이 아니다"
            );
        }

        // (5) 다시 적용하면 로컬 값이 글자 그대로 돌아온다.
        let applied = apply_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &ApplyProjectOverlayRequest {
                project_path,
                set_id,
            },
            overlay_test_env(),
        )
        .expect("적용");
        assert!(applied.succeeded, "재적용이 실패했다: {applied:?}");
        for (path, _, edited) in sensitive {
            assert_eq!(
                fs::read_to_string(repo.root.join(path)).expect("읽기"),
                edited,
                "{path}의 로컬 값이 돌아오지 않았다"
            );
        }
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in [&trash, &groups[0]] {
                let mode = fs::metadata(dir).expect("휴지통 폴더").permissions().mode();
                assert_eq!(
                    mode & 0o777,
                    0o700,
                    "휴지통 폴더는 0700(C19-1): {}",
                    dir.display()
                );
            }
        }

        let _ = fs::remove_dir_all(&temp);
    }

    /// 2026-10-04. 장부의 자리는 **저장소**다 — 등록 프로젝트가 아니다(C19-1).
    ///
    /// 무엇이 틀려 있었나. overlay 명령은 전부 `remote.rs`의 `project()` 결과, 곧 등록
    /// 프로젝트 루트를 받는데 `overlay_repository_id`가 그 경로를 그대로 해시했다. C19의
    /// 나머지는 전부 저장소 단위다: 세트에 담기는 경로는 저장소 루트 기준이고(F4 회차가
    /// 실측으로 확정했다), 스냅샷·적용은 `GitRunner`가 `--show-toplevel`로 찾은 최상위에서
    /// 돌고, 겹침을 막는 잠금도 그 최상위를 키로 쓴다. 그래서 한 저장소의 하위 폴더 둘이
    /// 각각 프로젝트로 등록되면 **작업 트리 하나에 장부가 둘** 생겼다.
    ///
    /// 조용한 실패가 그 다음이다. 브랜치를 옮기면 작업 트리는 통째로 바뀌는데,
    /// `reapply_project_overlays`와 `get_project_overlay_drift`는 지금 화면에 띄운
    /// 프로젝트의 장부만 본다 — 다른 프로젝트 이름으로 보관해 둔 세트는 자동 재적용되지
    /// 않고, 화면에도 뜨지 않는다. patch 파일은 남지만 C19-3이 약속한 자리가 빈다.
    ///
    /// 입력은 하위 폴더 프로젝트(`<repo>/app`)에서 저장소 루트 기준 경로(`app/service.ts`)
    /// 를 담은 세트 하나다. 셋을 못박는다. (1) 저장소 최상위로 들어와도 같은 세트가 보인다.
    /// (2) 두 입구의 `repository_id`가 같다. (3) 앱 데이터의 장부 폴더가 **하나**다 —
    /// 셋째가 없으면 "둘 다 만들어 두고 둘 다 보여 준다"는 느슨한 구현이 통과한다.
    ///
    /// 넷째가 호환이다. 프로젝트가 곧 저장소 최상위인 흔한 경우의 식별자는 한 글자도 바뀌면
    /// 안 된다 — 바뀌면 이미 저장된 사용자의 세트가 통째로 보이지 않게 되고, patch는 그
    /// 변경의 유일한 사본이다(C19-5).
    #[test]
    fn overlay_ledger_is_keyed_by_the_repository_top_level_not_the_registered_subfolder_c19_1() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let project = repo.root.join("app");
        fs::create_dir_all(&project).expect("app dir");
        fs::write(
            project.join("service.ts"),
            "export const port = 443;
",
        )
        .expect("seed");
        overlay_git(&repo.root, &["add", "-A"]);
        overlay_git(&repo.root, &["commit", "-q", "-m", "app"]);

        let saved = save_project_overlay_set(
            &repo.app_data,
            &project,
            &SaveProjectOverlaySetRequest {
                project_path: project.to_string_lossy().into_owned(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["app/service.ts".to_owned()],
            },
        )
        .expect("save");
        assert_eq!(
            saved.outcome,
            ProjectOverlayOutcome::Saved,
            "{}",
            saved.message
        );
        let set_id = saved.set_id.expect("set id");

        let from_root = list_project_overlay_sets(&repo.app_data, &repo.root).expect("list root");
        assert_eq!(
            from_root.sets.len(),
            1,
            "같은 저장소인데 최상위에서 장부가 보이지 않는다"
        );
        assert_eq!(from_root.sets[0].set_id, set_id);

        let from_project =
            list_project_overlay_sets(&repo.app_data, &project).expect("list project");
        assert_eq!(from_project.repository_id, from_root.repository_id);
        assert_eq!(from_project.sets.len(), 1);

        let ledgers: Vec<String> = fs::read_dir(repo.app_data.join(OVERLAY_ROOT))
            .expect("overlay root")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(ledgers.len(), 1, "장부 폴더가 둘로 갈렸다: {ledgers:?}");

        // 호환: 프로젝트가 곧 저장소 최상위이면 식별자는 예전과 같은 값이어야 한다.
        let digest = format!(
            "{:x}",
            Sha256::digest(repo.root.to_string_lossy().replace('\\', "/").as_bytes())
        );
        assert_eq!(
            overlay_repository_id(&repo.root),
            format!("repo-{}", &digest[..16])
        );
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
    ///
    /// 2026-10-04. **이 시험은 그 약속을 지키지 못하고 있었다.** 본문이
    /// `include_str!("project_overlays.rs")` 로 파일을 읽어 `"--binary"` 같은 문자열이
    /// **파일 어딘가에** 있는지만 봤다. 실측한 입력은 이렇다 — 제품의 diff argv 에서
    /// `--binary`·`--full-index` 를 빼고, 되돌림 argv 를 `restore --staged` 로 바꾼 다음,
    /// `mod tests` 안에 쓰이지도 않는
    /// `const LEGACY_OVERLAY_ARGS: &[&str] = &["--binary", "--full-index", "--source=HEAD",
    /// "--worktree"];` 한 줄을 두었다. 그 상태의 제품은 patch 를 축약 blob 해시로 뜨고
    /// 되돌림은 인덱스만 내려 **작업 트리를 한 글자도 바꾸지 않는데**, 이 가드는 `ok` 를
    /// 냈다. 옛 인자 목록을 참고로 남기는 상수는 꾸며 낸 모양이 아니라 흔한 모양이다.
    ///
    /// 그래서 보는 대상을 본문에서 **제품이 실제로 넘기는 값**으로 옮겼다. 두 상수는
    /// 제품이 그대로 git 에 넘기는 배열이므로(`OVERLAY_DIFF_ARGS` 는 `--output`·`--` 앞에,
    /// `OVERLAY_RESTORE_ARGS` 는 통째로), 여기서 통과한다는 것은 argv 가 그렇다는 뜻이다.
    /// 미끼 상수를 몇 개 두든 이 단언은 움직이지 않는다.
    ///
    /// 되돌림 쪽은 **금지 인자**도 같이 못박는다. `--staged` 가 끼면 `--worktree` 가 남아
    /// 있어도 인덱스까지 함께 바뀌어 C19-3 이 약속한 범위를 넘는다 — 빠진 것만 보는 단언은
    /// 그 모양을 통과시킨다.
    #[test]
    fn overlay_c19_snapshot_keeps_required_git_arguments() {
        // patch 를 뜨는 쪽: git 하위명령이 맨 앞이고 두 인자가 뒤따른다.
        assert_eq!(OVERLAY_DIFF_ARGS[0], "diff");
        for required in ["--binary", "--full-index"] {
            assert!(
                OVERLAY_DIFF_ARGS.contains(&required),
                "C19-3이 요구하는 patch 인자 {required}가 argv 에서 사라졌습니다:                  {OVERLAY_DIFF_ARGS:?}"
            );
        }

        // 되돌리는 쪽: 하위명령은 restore 여야 한다. checkout 은 범위가 넓어 C19-3 이
        // 고른 명령이 아니다.
        assert_eq!(OVERLAY_RESTORE_ARGS[0], "restore");
        for required in [
            "--source=HEAD",
            "--worktree",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ] {
            assert!(
                OVERLAY_RESTORE_ARGS.contains(&required),
                "C19-3이 요구하는 되돌림 인자 {required}가 argv 에서 사라졌습니다:                  {OVERLAY_RESTORE_ARGS:?}"
            );
        }
        for forbidden in ["--staged", "--source", "checkout"] {
            assert!(
                !OVERLAY_RESTORE_ARGS.contains(&forbidden),
                "되돌림 argv 에 {forbidden}이 들어왔습니다: {OVERLAY_RESTORE_ARGS:?}"
            );
        }

        // 경로는 argv 가 아니라 stdin 으로 간다(C16-5). pathspec 이 argv 에 섞이면
        // `-` 로 시작하는 경로가 git 의 옵션으로 읽힌다.
        for arg in OVERLAY_DIFF_ARGS.iter().chain(OVERLAY_RESTORE_ARGS.iter()) {
            assert!(
                arg.starts_with('-') || !arg.contains('/'),
                "argv 에 경로처럼 보이는 인자가 있습니다: {arg}"
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

    /// 2026-10-02. C19-3. 재적용은 `git apply --check`가 먼저 돌고, 실패하면 충돌 경로를 영수증에
    /// 싣는다. 2026-10-02 측정: git 은 같은 파일을 두 문장으로 적어
    /// (`error: patch failed: src/a.rs:3` 와 `error: src/a.rs: patch does not apply`)
    /// 그대로 모으면 화면에 같은 파일이 두 번 뜨고, 설명문 줄(`error: 2 lines applied
    /// after fuzzing`)까지 경로로 세면 영수증의 `affected` 에 사람에게 보여 줄 수 없는
    /// 문장이 실린다. 통과한 검사는 경로를 하나도 내놓지 않아야 한다 — 내놓으면 화면이
    /// "적용 가능"이라고 적으면서 충돌 목록을 함께 그린다.
    #[test]
    fn overlay_c19_apply_check_names_each_conflicted_path_once() {
        assert_eq!(
            apply_failure_paths(
                "error: patch failed: src/a.rs:3\n\
                 error: src/a.rs: patch does not apply\n\
                 error: config/b.toml: does not exist in index\n\
                 error: 2 lines applied after fuzzing\n\
                 fatal: unrecognized input\n",
                &["src/a.rs".to_owned(), "config/b.toml".to_owned()],
            ),
            vec!["src/a.rs".to_owned(), "config/b.toml".to_owned()]
        );
        assert!(apply_failure_paths("", &[]).is_empty());
    }

    /// 2026-10-05 실측. 이름에 **공백이 든 파일**이 충돌했을 때 검사와 적용이 같은 경로를
    /// 적는지 고정한다(C19-5의 `affected`).
    ///
    /// 임시 저장소에 `my file.txt` 를 두고 patch 를 뜬 뒤 같은 줄을 다르게 고쳐
    /// `git apply --check --binary --whitespace=nowarn -` 를 돌리면 git 은 정확히
    /// `error: patch failed: my file.txt:1` 과 `error: my file.txt: patch does not apply`
    /// 를 적는다. 이 회차 전에는 검사 쪽 파서만 "공백이 든 조각은 설명문"이라고 보고
    /// 버려서, 같은 충돌을 적용은 `["my file.txt"]` 로 검사는 `[]` 로 적었다. 영수증이
    /// 비면 화면은 "충돌한 경로를 먼저 정리하세요" 라고만 적고 어느 파일인지는 말하지
    /// 못한다. `patch_section_path` 가 공백 든 경로를 일부러 지원하므로 세트에 그런 경로가
    /// 들어올 수 있고, 따라서 닿지 않는 가정이 아니다.
    #[test]
    fn overlay_c19_apply_failure_names_a_path_that_has_a_space() {
        let stderr = concat!(
            "error: patch failed: my file.txt:1\n",
            "error: my file.txt: patch does not apply\n",
        );
        let set_paths = vec!["my file.txt".to_owned()];
        assert_eq!(
            apply_failure_paths(stderr, &set_paths),
            vec!["my file.txt".to_owned()],
            "세트가 적어 둔 공백 경로가 영수증에서 사라졌다"
        );
        // 세트에 없는 이름은 예전 기준(공백 없음)으로만 받는다 — 설명문이 경로로 실리는
        // 길을 열지 않기 위해서다.
        assert!(apply_failure_paths(stderr, &[]).is_empty());
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

    /// 2026-10-10. C19-1. patch 저장이 **staged write 뒤 atomic replace**이고, 폴더는 0700·
    /// 파일은 0600인지를 실제 git·실제 파일로 고정한다.
    ///
    /// 왜 이 자리인가. 이전 구현은 git의 `--output`을 최종 경로에 바로 겨눴다. 그러면 두
    /// 가지가 동시에 깨진다. 첫째, 같은 세트를 다시 뜨는 순간 최종 경로가 먼저 비워지므로,
    /// git이 중간에 실패하면 **사용자 변경의 유일한 사본**이 반쯤 잘린 채 남는다(C19-5의
    /// "patch를 잃는 경로는 어디에도 없다"가 깨지는 자리다). 둘째, git이 만드는 파일은
    /// umask를 따라 0644가 되는데, patch 본문은 사용자 작업 트리의 파일 내용 그 자체다 —
    /// 민감 경로 거절을 걷어낸 2026-10-05 결정(C19-2) 뒤로는 비밀값이 그대로 들어 있을 수
    /// 있어서 권한이 곧 보관 자리의 전부가 된다.
    ///
    /// 그래서 문자열이 아니라 결과를 본다. 성공 뒤에는 (1) 세트 폴더 0700 (2) patch 0600
    /// (3) 임시 파일이 하나도 남지 않음을 디렉터리 목록으로 확인하고, 실패를 일부러
    /// 만들어(`.git`을 치워 git이 거절하게 한다) (4) 이전 patch가 **바이트 그대로** 남는지
    /// 본다. 네 번째가 이 항목의 핵심이다 — 임시 파일 없이 바로 쓰면 여기서만 깨진다.
    #[test]
    fn project_overlay_c19_1_patch_write_is_atomic_and_private() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let runner = overlay_runner(&repo);
        fs::write(repo.root.join("src/app.ts"), "export const port = 3000;\n").expect("edit");

        let patch_path =
            overlay_patch_path(&repo.app_data, "repo-c19-1", "snap-c19-1").expect("patch 경로");
        let paths = vec!["src/app.ts".to_owned()];

        // 제품에서 세트 폴더를 처음 만드는 쪽은 `save_project_overlay_set`의
        // `write_private_json`이고, 그 `create_dir_all`은 umask를 따른다. 그 상태를 그대로
        // 만들어 둔다 — 저장이 자기가 만든 폴더만 좁히면 C19-1은 제품 경로에서 성립하지 않고,
        // 이 시험만 통과한다. 죽은 회차가 남긴 임시 파일도 함께 심는다.
        let set_dir = patch_path.parent().expect("세트 폴더").to_path_buf();
        fs::create_dir_all(&set_dir).expect("세트 폴더");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&set_dir, fs::Permissions::from_mode(0o755)).expect("0755");
        }
        let stale = set_dir.join(format!("{PATCH_TEMP_PREFIX}dead.tmp"));
        fs::write(&stale, b"half written").expect("임시 파일");

        write_overlay_patch(&runner, &patch_path, &paths).expect("첫 저장");
        assert!(
            !stale.exists(),
            "죽은 회차가 남긴 임시 patch가 치워지지 않았다"
        );

        let first = fs::read(&patch_path).expect("patch 읽기");
        assert!(
            String::from_utf8_lossy(&first).contains("3000"),
            "patch에 변경 내용이 없다"
        );

        let set_dir = set_dir.as_path();
        let entries = |dir: &Path| -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(dir)
                .expect("폴더 목록")
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        assert_eq!(
            entries(set_dir),
            vec!["overlay.patch".to_owned()],
            "임시 파일이 남았다"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(set_dir)
                    .expect("폴더 권한")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700,
                "세트 폴더가 소유자 전용이 아니다"
            );
            assert_eq!(
                fs::metadata(&patch_path)
                    .expect("patch 권한")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
                "patch가 소유자 전용이 아니다"
            );
        }

        // 두 번째 저장을 일부러 실패시킨다. git이 거절하는 가장 단순한 상태가 "저장소가
        // 아니다"이고, 이때 이전 patch가 한 바이트라도 달라지면 원자 저장이 아니다.
        fs::rename(repo.root.join(".git"), repo.root.join(".git-moved")).expect("git 치우기");
        let failure = write_overlay_patch(&runner, &patch_path, &paths);
        assert!(failure.is_err(), "저장소가 없는데도 저장이 성공했다");
        fs::rename(repo.root.join(".git-moved"), repo.root.join(".git")).expect("git 되돌리기");

        assert_eq!(
            fs::read(&patch_path).expect("이전 patch"),
            first,
            "실패한 저장이 이전 patch를 건드렸다"
        );
        assert_eq!(
            entries(set_dir),
            vec!["overlay.patch".to_owned()],
            "실패한 저장이 임시 파일을 남겼다"
        );
    }

    /// 2026-10-11. C19-3·C19-5. **같은 세트를 다시 뜨다 실패해도** 먼저 뜬 patch가 그대로
    /// 남고 작업 트리도 그대로인지를, 저장·되돌림을 묶는 입구
    /// [`snapshot_patch_then_restore`]에서 실제 git으로 고정한다.
    ///
    /// 왜 O18의 시험으로 부족한가. 그쪽은 `write_overlay_patch`를 직접 불러 쓰기 한 단계만
    /// 본다. 사용자가 실제로 겪는 자리는 "어제 뜬 세트를 오늘 다시 뜬다"이고, 그 호출은
    /// 잠금·HEAD 읽기·상태 분류를 지나 같은 `snapshot_id`의 **같은 patch 경로**를 겨눈다.
    /// patch를 잃는 경로는 어디에도 없다(C19-5)는 문장이 걸리는 곳은 이 입구다.
    ///
    /// 실패를 어떻게 만드는가. 담길 파일에서 읽기 권한을 뺀다. 2026-10-11 실측(git 2.x):
    /// `rev-parse HEAD`와 `status --porcelain`은 그대로 성공해 경로가 **담기는 것까지 간
    /// 뒤**, `diff`만 `cannot hash`로 죽는다 — 즉 세 단계 중 저장 단계에서 실패한다.
    /// 게다가 git은 그 전에 `--output` 파일을 0바이트로 만들어 둔다. 최종 경로를 바로
    /// 겨눴다면 바로 그 0바이트가 사용자 변경의 유일한 사본을 덮는다.
    ///
    /// 마지막에 권한을 되돌려 다시 뜨는 것까지 본다. 실패가 남긴 무엇도 다음 스냅샷을
    /// 막지 않아야 하고(임시 파일이 쌓이지 않아야 하고), 그때는 새 내용이 담겨야 한다.
    #[test]
    fn project_overlay_resnapshot_failure_keeps_previous_patch() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        if !cfg!(unix) {
            // 읽기 권한을 빼는 것이 이 시험의 실패 주입이다. 권한 모형이 다른 플랫폼에서는
            // 주입 자체가 성립하지 않으므로, 거짓 통과 대신 건너뛴다.
            return;
        }
        let runner = overlay_runner(&repo);
        let target = repo.root.join("src/app.ts");
        let paths = vec!["src/app.ts".to_owned()];

        // 1. 처음 뜬다. patch가 생기고 작업 트리는 HEAD 원본으로 돌아간다.
        fs::write(&target, "export const port = 3000;\n").expect("첫 변경");
        let first =
            snapshot_patch_then_restore(&runner, &repo.app_data, "repo-o19", "set-o19", &paths)
                .expect("첫 스냅샷");
        assert!(
            matches!(first, OverlaySnapshotResult::Snapshot(_)),
            "첫 스냅샷이 나오지 않았다: {first:?}"
        );
        let patch_path =
            overlay_patch_path(&repo.app_data, "repo-o19", "set-o19").expect("patch 경로");
        let kept = fs::read(&patch_path).expect("첫 patch");
        assert!(
            String::from_utf8_lossy(&kept).contains("3000"),
            "첫 patch에 변경 내용이 없다"
        );
        assert_eq!(
            fs::read_to_string(&target).expect("읽기"),
            "export const port = 443;\n",
            "첫 스냅샷이 작업 트리를 되돌리지 않았다"
        );

        // 2. 같은 세트를 다시 뜬다. 담길 파일을 읽을 수 없게 만들어 저장 단계에서 죽인다.
        fs::write(&target, "export const port = 8080;\n").expect("두 번째 변경");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o000)).expect("읽기 차단");
        }
        let failure =
            snapshot_patch_then_restore(&runner, &repo.app_data, "repo-o19", "set-o19", &paths);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).expect("권한 복구");
        }
        assert!(
            failure.is_err(),
            "읽을 수 없는 파일을 담았는데도 스냅샷이 성공했다: {failure:?}"
        );

        // 3. 이전 patch는 바이트 그대로이고, 작업 트리도 되돌려지지 않았다.
        assert_eq!(
            fs::read(&patch_path).expect("이전 patch"),
            kept,
            "실패한 재스냅샷이 이전 patch를 덮었다"
        );
        assert_eq!(
            fs::read_to_string(&target).expect("읽기"),
            "export const port = 8080;\n",
            "저장이 실패했는데 작업 트리를 되돌렸다"
        );
        let mut names: Vec<String> = fs::read_dir(patch_path.parent().expect("세트 폴더"))
            .expect("폴더 목록")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["overlay.patch".to_owned()],
            "실패한 재스냅샷이 임시 파일을 남겼다"
        );

        // 4. 실패가 다음 스냅샷을 막지 않는다 — 같은 세트가 새 내용으로 다시 떠진다.
        let retry =
            snapshot_patch_then_restore(&runner, &repo.app_data, "repo-o19", "set-o19", &paths)
                .expect("재시도 스냅샷");
        assert!(
            matches!(retry, OverlaySnapshotResult::Snapshot(_)),
            "재시도가 스냅샷을 내지 않았다: {retry:?}"
        );
        let rewritten = fs::read(&patch_path).expect("새 patch");
        assert!(
            String::from_utf8_lossy(&rewritten).contains("8080"),
            "재시도한 patch에 새 변경이 담기지 않았다"
        );
        assert_eq!(
            fs::read_to_string(&target).expect("읽기"),
            "export const port = 443;\n",
            "재시도가 작업 트리를 되돌리지 않았다"
        );
    }

    /// 2026-10-10. C19-1·G10. 권한을 박는 자리가 **링크를 따라가지 않는지** 고정한다.
    ///
    /// `fs::set_permissions`는 링크를 따른다. 세트 폴더 자리에 다른 곳을 가리키는 디렉터리
    /// 링크가 놓여 있으면 앱이 앱 데이터 **밖** 폴더의 권한을 0700으로 좁히게 된다 — 내용을
    /// 쓰는 것과 달리 권한 변경은 되돌려 주는 쪽이 없다. 그래서 거절이 맞다.
    #[cfg(unix)]
    #[test]
    fn project_overlay_c19_1_patch_write_refuses_a_symlinked_set_directory() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let runner = overlay_runner(&repo);
        fs::write(repo.root.join("src/app.ts"), "export const port = 3000;\n").expect("edit");

        let outside = repo.app_data.join("outside");
        fs::create_dir_all(&outside).expect("바깥 폴더");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).expect("0755");

        let patch_path =
            overlay_patch_path(&repo.app_data, "repo-link", "snap-link").expect("patch 경로");
        let set_dir = patch_path.parent().expect("세트 폴더");
        fs::create_dir_all(set_dir.parent().expect("저장소 폴더")).expect("저장소 폴더");
        std::os::unix::fs::symlink(&outside, set_dir).expect("링크");

        let failure = write_overlay_patch(&runner, &patch_path, &["src/app.ts".to_owned()]);
        assert!(failure.is_err(), "링크된 세트 폴더에 저장했다");
        assert_eq!(
            fs::metadata(&outside)
                .expect("바깥 폴더 권한")
                .permissions()
                .mode()
                & 0o777,
            0o755,
            "링크를 따라가 바깥 폴더의 권한을 바꿨다"
        );
    }

    /// 2026-10-04. C19-5. 보관한 patch 본문을 **읽을 수 있는지**를 고정한다.
    ///
    /// 왜 이 자리가 필요한가. 스냅샷이 끝나면 작업 트리는 `git restore --source=HEAD`로
    /// 돌아가므로, 사용자가 하던 변경의 **유일한 사본**은 앱 데이터 안의 patch 파일이 된다.
    /// 그런데 이 회차 전까지 그 파일에 닿는 길은 어디에도 없었다 — 세트 목록도 영수증도
    /// digest와 경로 이름만 실었고(C19-5가 영수증에 본문을 금지한 결과다), `apply`가
    /// `overlayNeedsResolution`으로 막히면 화면에 남는 것은 충돌한 경로 이름뿐이었다.
    /// 그 상태에서 사용자가 할 수 있는 일은 없다: 무엇을 손으로 다시 적어야 하는지 모른다.
    /// "patch를 잃는 경로는 어디에도 없다"는 C19-5의 약속은 파일이 남는다는 뜻만이 아니라
    /// 그 내용에 닿을 수 있다는 뜻이다.
    ///
    /// 실제로 틀릴 수 있는 모양이 넷이고, 넷을 모두 입력으로 만든다.
    /// 1. 보관된 patch가 없는 세트(`registered`)에서 오류를 던지면 화면이 세트 하나 때문에
    ///    통째로 빈다. 사유를 실은 답이어야 한다.
    /// 2. 본문이 비어 돌아오면(`text: None`) 읽기가 있으나 마나다 — 실제 변경 줄이 들어
    ///    있는지 본다.
    /// 3. 장부의 digest와 디스크의 patch가 어긋난 상태를 `digest_matches: true`로 적으면
    ///    화면은 "적용할 수 있는 patch"로 보여 주는데 `check`·`apply`는 같은 어긋남을
    ///    거절한다 — 두 화면이 서로 다른 말을 한다.
    /// 4. 상한을 넘겼는데 끊은 사실을 숨기면 사용자는 잘린 diff를 온전한 것으로 믿고 옮겨
    ///    적는다.
    #[test]
    fn project_overlay_c19_reads_stored_patch_body() {
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
                name: "로컬 포트".to_owned(),
                paths: vec!["src/app.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        let set_id = saved.set_id.expect("set id");
        let request = ReadProjectOverlayPatchRequest {
            project_path: project_path.clone(),
            set_id: set_id.clone(),
        };

        // (1) 아직 뜬 patch가 없다. 오류가 아니라 사유가 실린 답이다.
        let empty = read_project_overlay_patch(&repo.app_data, &repo.root, &request).expect("읽기");
        assert_eq!(empty.state, ProjectOverlayState::Registered);
        assert!(empty.text.is_none(), "{empty:?}");
        assert!(empty.reason.is_some(), "사유 없이 비어 있다: {empty:?}");
        assert_eq!(empty.bytes, 0);
        assert_eq!(empty.paths, vec!["src/app.ts".to_owned()]);

        // (2) 스냅샷 뒤에는 본문이 실린다. 작업 트리는 이미 HEAD 원본으로 돌아갔으므로
        // 이 본문이 `8080`이라는 변경의 유일한 사본이다.
        fs::write(
            repo.root.join("src/app.ts"),
            "export const port = 8080;
",
        )
        .expect("unstaged");
        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                trigger: None,
            },
            overlay_test_env(),
        )
        .expect("스냅샷");
        assert_eq!(
            snapshot.outcome,
            ProjectOverlayOutcome::Snapshotted,
            "{snapshot:?}"
        );
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("읽기"),
            "export const port = 443;
",
            "스냅샷은 작업 트리를 HEAD 원본으로 되돌린다"
        );

        let view = read_project_overlay_patch(&repo.app_data, &repo.root, &request).expect("읽기");
        let body = view.text.clone().expect("본문");
        assert!(body.contains("src/app.ts"), "{body}");
        assert!(
            body.contains("+export const port = 8080;"),
            "patch에 변경 줄이 없다: {body}"
        );
        assert!(!view.truncated);
        assert!(view.reason.is_none(), "{view:?}");
        assert!(view.digest_matches, "{view:?}");
        assert_eq!(view.stored_digest, view.patch_digest);
        assert_eq!(view.state, ProjectOverlayState::Stored);
        assert_eq!(view.bytes as usize, body.len());

        // (3) 디스크의 patch를 바꾼다. 장부의 digest는 그대로이므로 둘이 어긋난다 —
        // `check_project_overlay_apply`가 같은 어긋남으로 적용을 거절하는 상태다.
        let patch_path = overlay_patch_path(
            &repo.app_data,
            &overlay_repository_id(&repo.root),
            &view.snapshot_id.clone().expect("snapshot id"),
        )
        .expect("patch 경로");
        let original_patch = fs::read(&patch_path).expect("patch 읽기");
        fs::write(
            &patch_path,
            b"diff --git a/x b/x
",
        )
        .expect("patch 덮어쓰기");
        let tampered =
            read_project_overlay_patch(&repo.app_data, &repo.root, &request).expect("읽기");
        assert!(
            !tampered.digest_matches,
            "장부와 디스크가 다른데 같다고 적었다: {tampered:?}"
        );
        assert_ne!(tampered.stored_digest, tampered.patch_digest);
        assert!(
            tampered.text.is_some(),
            "어긋났다고 본문까지 숨기면 손으로 풀 길이 없다"
        );

        // (4) 상한을 넘기면 끊고, 끊었다는 사실을 함께 싣는다.
        let mut oversized = original_patch.clone();
        oversized.extend(std::iter::repeat_n(b'x', MAX_PATCH_TEXT_BYTES));
        fs::write(&patch_path, &oversized).expect("큰 patch");
        let cut = read_project_overlay_patch(&repo.app_data, &repo.root, &request).expect("읽기");
        assert!(cut.truncated, "{cut:?}");
        assert!(cut.reason.is_some(), "끊고도 사유가 없다: {cut:?}");
        assert_eq!(cut.bytes as usize, oversized.len());
        assert_eq!(cut.text.expect("본문").len(), MAX_PATCH_TEXT_BYTES);
    }

    /// 2026-10-04. C19-3. 외부 Git 작업을 보고 **재적용을 내미는 자리**가 실제로 켜지는지
    /// 고정한다. C19-3은 자동 검사·적용을 "앱이 시작한 Git 작업" 뒤로만 허용하고, 터미널
    /// 같은 외부 작업은 검사 결과와 적용 버튼만 내밀라고 못박는다. 그런데 그 둘을 가를
    /// 신호가 어디에도 없으면 화면은 영영 같은 자리를 못 찾고, overlay는 "브랜치를 옮겨도
    /// 로컬 설정이 따라온다"는 약속을 조용히 어긴다 — 사용자는 설정이 들어가 있다고 믿은
    /// 채 작업한다.
    ///
    /// 실제로 틀릴 수 있는 모양이 셋이다. 스냅샷 직후(HEAD 그대로)에 `headMoved`가 참이면
    /// 화면이 아무 일도 없었는데 적용을 권한다. 외부 커밋 뒤에도 거짓이면 그 반대로 영영
    /// 권하지 않는다. 그리고 `applied` 세트까지 실리면 이미 작업 트리에 들어가 있는 것을
    /// 다시 넣으라고 권하게 되는데, 그 길은 `apply`가 "이미 적용된 세트"로 거절하므로
    /// 사용자는 누를 수 없는 버튼을 보게 된다.
    ///
    /// 입력: 커밋된 `src/app.ts`를 고쳐 스냅샷으로 보관하고(이때 HEAD는 그대로), 그다음
    /// **앱을 거치지 않고** `untouched.ts`를 고쳐 직접 커밋해 HEAD를 움직인다. 그 커밋이
    /// 이 시험에서의 "터미널에서 한 Git 작업"이다.
    #[test]
    fn project_overlay_c19_drift_marks_external_head_moves() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let env = overlay_test_env();
        let project_path = repo.root.to_string_lossy().into_owned();

        fs::write(repo.root.join("src/app.ts"), "export const port = 8080;\n").expect("unstaged");
        let saved = save_project_overlay_set(
            &repo.app_data,
            &repo.root,
            &SaveProjectOverlaySetRequest {
                project_path: project_path.clone(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["src/app.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        let set_id = saved.set_id.clone().expect("set id");

        // 아직 patch가 없는 단계(registered)는 내밀 것이 없으므로 실리지 않는다.
        let before_snapshot =
            get_project_overlay_drift_with_env(&repo.app_data, &repo.root, env.clone())
                .expect("drift");
        assert!(
            before_snapshot.sets.is_empty(),
            "뜬 patch가 없는 세트는 재적용을 내밀 자리가 아니다: {before_snapshot:?}"
        );

        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                trigger: None,
            },
            env.clone(),
        )
        .expect("스냅샷");
        assert!(snapshot.succeeded, "{snapshot:?}");

        // 스냅샷 직후. HEAD는 움직이지 않았으니 외부 작업은 없었다.
        let settled = get_project_overlay_drift_with_env(&repo.app_data, &repo.root, env.clone())
            .expect("drift");
        let entry = settled
            .sets
            .iter()
            .find(|set| set.set_id == set_id)
            .expect("보관된 세트는 실린다");
        assert!(!entry.head_moved, "HEAD가 그대로인데 움직였다고 적었다");
        assert_eq!(entry.trigger, ProjectOverlayTrigger::App);
        assert_eq!(entry.base_head, settled.current_head);

        // 앱을 거치지 않은 Git 작업. 터미널에서 사람이 브랜치를 옮기거나 커밋한 자리다.
        fs::write(repo.root.join("untouched.ts"), "외부에서 고쳤다\n").expect("외부 변경");
        overlay_git(&repo.root, &["add", "untouched.ts"]);
        overlay_git(&repo.root, &["commit", "-m", "외부 커밋"]);

        let drifted = get_project_overlay_drift_with_env(&repo.app_data, &repo.root, env.clone())
            .expect("drift");
        let entry = drifted
            .sets
            .iter()
            .find(|set| set.set_id == set_id)
            .expect("보관된 세트");
        assert!(
            entry.head_moved,
            "외부 커밋 뒤에도 움직임을 못 봤다: {drifted:?}"
        );
        assert_eq!(
            entry.trigger,
            ProjectOverlayTrigger::External,
            "외부 작업은 자동 적용하지 않는 자리다(C19-3)"
        );
        assert_ne!(entry.base_head, drifted.current_head);

        // 적용하고 나면 내밀 것이 없다 — 이미 작업 트리에 들어가 있다.
        let applied = apply_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &ApplyProjectOverlayRequest {
                project_path,
                set_id: set_id.clone(),
            },
            env.clone(),
        )
        .expect("적용");
        assert!(applied.succeeded, "{applied:?}");
        let after_apply =
            get_project_overlay_drift_with_env(&repo.app_data, &repo.root, env).expect("drift");
        assert!(
            after_apply.sets.iter().all(|set| set.set_id != set_id),
            "적용된 세트를 다시 권하면 사용자는 누를 수 없는 버튼을 본다: {after_apply:?}"
        );
    }

    /// 2026-10-04. C19-3. **앱이 시작한** Git 작업 뒤에 보관된 overlay가 스스로 다시
    /// 들어가는지 고정한다. C19-3은 자동 검사·적용을 그 자리에만 허용하는데, 고리 자체가
    /// 없어서 사용자가 형상관리 탭에서 브랜치를 옮긴 뒤 overlay 탭으로 건너가 검사와 적용을
    /// 두 번 더 눌러야 했다 — overlay가 없애려던 수고가 그대로 남아 있었다.
    ///
    /// 실제로 틀릴 수 있는 모양이 셋이고 이 시험이 그 셋을 본다.
    /// (1) 판정을 `head_moved`로 하면 **실패한 Git 작업** 뒤의 재적용이 빠진다. 실패한
    ///     switch는 HEAD를 움직이지 않으므로, 보관된 로컬 설정이 빠진 채 작업 트리가 남는다.
    ///     그래서 기준은 "HEAD가 움직였는가"가 아니라 "patch가 보관된 채인가"다.
    /// (2) 한 세트가 충돌해 멈추면 나머지 세트의 설정까지 같이 빠진다. 세트는 서로 독립이다.
    /// (3) 이미 적용된 세트(`applied`)를 다시 넣으려 하면 `apply`가 거절해 영수증이 오류가
    ///     된다 — 자동 경로에서 그 거절은 사용자가 아무것도 하지 않았는데 뜨는 실패다.
    ///
    /// 입력: 커밋된 `src/app.ts`의 unstaged 변경을 세트 A로 보관하고(스냅샷으로 작업 트리는
    /// HEAD 원본으로 돌아간다), 그 상태에서 재적용을 부른다. HEAD는 한 번도 움직이지
    /// 않았다 — 실패한 Git 작업 뒤의 모양이다.
    #[test]
    fn project_overlay_c19_reapplies_stored_sets_after_app_git() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let env = overlay_test_env();
        let project_path = repo.root.to_string_lossy().into_owned();
        let original = fs::read_to_string(repo.root.join("src/app.ts")).expect("원본");

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
                project_path: project_path.clone(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                paths: vec!["src/app.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        let set_id = saved.set_id.clone().expect("set id");

        // 뜬 patch가 없는 단계에서는 아무것도 적용하지 않는다. 여기서 무언가 돌면 그것은
        // 사용자가 보관한 적 없는 변경이다.
        let nothing = reapply_project_overlays_with_env(
            &repo.app_data,
            &repo.root,
            &ReapplyProjectOverlaysRequest {
                project_path: project_path.clone(),
                recovery: false,
            },
            env.clone(),
        )
        .expect("재적용");
        assert!(
            nothing.receipts.is_empty() && nothing.applied == 0,
            "patch가 없는 세트를 건드렸다: {nothing:?}"
        );

        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                trigger: None,
            },
            env.clone(),
        )
        .expect("스냅샷");
        assert!(snapshot.succeeded, "{snapshot:?}");
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("되돌림"),
            original,
            "스냅샷은 작업 트리를 HEAD 원본으로 되돌린다"
        );

        // (1) HEAD는 한 번도 움직이지 않았다. 그래도 보관된 세트는 다시 들어가야 한다.
        let reapplied = reapply_project_overlays_with_env(
            &repo.app_data,
            &repo.root,
            &ReapplyProjectOverlaysRequest {
                project_path: project_path.clone(),
                recovery: false,
            },
            env.clone(),
        )
        .expect("재적용");
        assert_eq!(
            reapplied.applied, 1,
            "HEAD가 그대로라고 재적용을 건너뛰면 실패한 switch 뒤 로컬 설정이 빠진다: {reapplied:?}"
        );
        assert_eq!(reapplied.needs_resolution, 0, "{reapplied:?}");
        assert_eq!(reapplied.trigger, ProjectOverlayTrigger::App);
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("적용 뒤"),
            "export const port = 8080;
"
        );
        assert!(
            reapplied
                .receipts
                .iter()
                .all(|receipt| receipt.outcome == ProjectOverlayOutcome::Applied),
            "{reapplied:?}"
        );

        // (3) 같은 호출을 한 번 더. 이미 적용된 세트는 건너뛰므로 오류가 아니라 빈 결과다 —
        // 형상관리 탭에서 git 작업을 연달아 하면 이 경로가 매번 돈다.
        let again = reapply_project_overlays_with_env(
            &repo.app_data,
            &repo.root,
            &ReapplyProjectOverlaysRequest {
                project_path,
                recovery: false,
            },
            env,
        )
        .expect("두 번째 재적용은 오류가 아니다");
        assert!(
            again.receipts.is_empty() && again.applied == 0,
            "이미 적용된 세트를 다시 넣으려 했다: {again:?}"
        );
    }

    /// C19-3의 실행 규칙 7 — "Git 작업 자체가 실패하면 이전 브랜치에서 재적용을 시도하고,
    /// 그 재적용까지 실패해도 **patch는 보존하고** 복구 영수증을 남긴다".
    ///
    /// 2026-10-04. 고치기 전에는 두 자리가 비어 있었다. (1) 영수증에 "이것이 복구였다"는
    /// 사실이 없어, 실패한 switch 뒤에도 화면이 "브랜치를 옮긴 뒤 다시 넣었다"고 적었다 —
    /// 실패한 switch는 HEAD를 움직이지 않으므로 거짓이다. (2) 세트 하나의 적용이 오류로
    /// 끝나면 `?`가 반복문을 끊어, 나머지 세트의 복구가 통째로 사라지고 돌아가는 것은
    /// 오류뿐이었다. 남는 영수증이 아예 없으니 "복구 영수증을 남긴다"가 성립하지 않는다.
    ///
    /// 입력은 세트 둘이다. 하나는 정상이고, 다른 하나는 디스크의 patch를 손대 digest가
    /// 어긋나게 만들어 적용이 `InvalidInput`으로 끝나게 했다. 실패를 `overlayNeedsResolution`
    /// (검사 실패)이 아니라 **오류**로 만든 것이 요점이다 — 그 결말은 이미 영수증이 있고,
    /// 여기서 고정하려는 것은 영수증조차 없던 경로다.
    #[test]
    fn project_overlay_c19_recovers_overlays_after_failed_app_git() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let env = overlay_test_env();
        let project_path = repo.root.to_string_lossy().into_owned();

        let mut set_ids = Vec::new();
        for (name, file, body) in [
            (
                "로컬 포트",
                "src/app.ts",
                "export const port = 8080;
",
            ),
            (
                "디버그 플래그",
                "untouched.ts",
                "untouched + local tweak
",
            ),
        ] {
            fs::write(repo.root.join(file), body).expect("unstaged");
            let saved = save_project_overlay_set(
                &repo.app_data,
                &repo.root,
                &SaveProjectOverlaySetRequest {
                    project_path: project_path.clone(),
                    set_id: None,
                    name: name.to_owned(),
                    paths: vec![file.to_owned()],
                },
            )
            .expect("세트 저장");
            let set_id = saved.set_id.clone().expect("set id");
            let snapshot = snapshot_project_overlay_with_env(
                &repo.app_data,
                &repo.root,
                &SnapshotProjectOverlayRequest {
                    project_path: project_path.clone(),
                    set_id: set_id.clone(),
                    trigger: None,
                },
                env.clone(),
            )
            .expect("스냅샷");
            assert!(snapshot.succeeded, "{snapshot:?}");
            set_ids.push(set_id);
        }

        // 두 번째 세트의 patch를 손댄다. 적용 경로는 digest를 **먼저** 보므로 작업 트리에는
        // 한 글자도 닿지 않고 오류로 끝난다.
        let broken = set_ids[1].clone();
        let listed = list_project_overlay_sets(&repo.app_data, &repo.root).expect("목록");
        let snapshot_id = listed
            .sets
            .iter()
            .find(|set| set.set_id == broken)
            .and_then(|set| set.snapshot_id.clone())
            .expect("snapshot id");
        let patch_path =
            overlay_patch_path(&repo.app_data, &listed.repository_id, &snapshot_id).expect("patch");
        let preserved = fs::read(&patch_path).expect("patch 읽기");
        fs::write(
            &patch_path,
            b"not a patch
",
        )
        .expect("patch 손대기");

        let recovered = reapply_project_overlays_with_env(
            &repo.app_data,
            &repo.root,
            &ReapplyProjectOverlaysRequest {
                project_path: project_path.clone(),
                recovery: true,
            },
            env,
        )
        .expect("한 세트가 오류여도 복구 영수증은 돌아온다");

        // (1) 복구였다는 사실이 영수증에 실린다. 화면의 문구가 이 칸으로 갈린다.
        assert!(recovered.recovery, "복구 표시가 빠졌다: {recovered:?}");
        assert_eq!(recovered.trigger, ProjectOverlayTrigger::App);

        // (2) 깨진 세트가 나머지의 복구를 가져가지 않는다.
        assert_eq!(
            recovered.applied, 1,
            "세트 하나의 오류가 나머지 세트의 복구를 끊었다: {recovered:?}"
        );
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("복구 뒤"),
            "export const port = 8080;
"
        );

        // (3) 실패한 세트는 사유와 함께 영수증에 남는다. 조용히 사라지지 않는다.
        assert_eq!(recovered.failed.len(), 1, "{recovered:?}");
        assert_eq!(recovered.failed[0].set_id, broken);
        assert!(
            !recovered.failed[0].reason.is_empty(),
            "사유 없는 실패는 다음 사람이 읽을 것이 없다: {recovered:?}"
        );

        // (4) **patch는 보존된다.** 실패가 사용자 로컬 데이터를 지우는 길이 되면 안 된다.
        assert_eq!(
            fs::read(&patch_path).expect("patch 는 그대로 있다"),
            b"not a patch
",
            "실패한 복구가 patch 파일을 지우거나 바꿨다"
        );
        assert!(
            !preserved.is_empty(),
            "시험 전제가 깨졌다 — 원래 patch 가 비어 있었다"
        );
        // 그리고 세트는 여전히 `stored`다. 적용되지 않았으므로 다음 복구가 다시 집는다.
        let after = list_project_overlay_sets(&repo.app_data, &repo.root).expect("목록");
        assert_eq!(
            after
                .sets
                .iter()
                .find(|set| set.set_id == broken)
                .map(|set| set.state),
            Some(ProjectOverlayState::Stored),
            "실패한 세트가 보관 상태를 잃었다: {after:?}"
        );
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
    /// 그리고 이 저장소에 아예 없는 `.env`(이름이 민감해 보인다는 이유로 걸리는 단계는
    /// 없으므로 다른 추적되지 않은 파일과 똑같이 판정된다 — C19-2, 2026-10-05 결정).
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
        // 민감해 보이는 이름이라는 이유로 걸리는 단계는 없다(C19-2, 2026-10-05 결정). 이
        // 저장소에 `.env`는 아예 없으므로 다른 추적되지 않은 파일과 똑같이 판정된다.
        assert_eq!(reason(".env"), Some("untracked"));

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
    ///
    /// 2026-10-04. 그 앞 네 줄만으로는 **공유**를 고정하지 못한다는 것을 보강했다. 위의 세
    /// 단언은 `BusyGuard` 하나를 두 번 잡아 보는 것이라, overlay 쪽이 `overlay_lock_key()`를
    /// 저장소 루트가 아닌 다른 값(세트 폴더, `.git` 경로, 정규화 전 입력)으로 바꿔도 그대로
    /// 통과한다. 그러면 git 어댑터는 `runner.root`로, overlay는 다른 열쇠로 잠그게 되어 두
    /// 변경이 같은 작업 트리에서 **동시에** 돈다 — `restore --source=HEAD --worktree`가
    /// `git switch` 한가운데서 실행되는 모양이고, 그때 양쪽 영수증의 `head_before`는 둘 다
    /// 거짓이 된다. C19-3이 "저장소 단위 잠금을 git 어댑터와 공유한다"고 적은 자리가 이것이라
    /// 아래 두 단언은 열쇠가 실제로 같은 값인지를 **동작으로** 묻는다: overlay 열쇠로 잠근
    /// 채 git 변경 하나와 overlay 변경 하나를 각각 불러 둘 다 `busy`로 돌아오는지 본다.
    /// 어느 한쪽이 다른 열쇠를 쓰면 그쪽 단언이 깨진다.
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

        // 2026-10-04. 여기까지는 `BusyGuard` 하나만 본다 — 같은 경로로 두 번 잡으면 두
        // 번째가 비는 것은 자료구조의 성질이지 **두 어댑터가 같은 잠금을 쓴다**는 뜻이
        // 아니다. C19-3이 요구하는 것은 뒤쪽이고, 그것을 지키는 것은 지금까지
        // `GitRunner::overlay_lock_key`에 붙은 주석 한 줄뿐이었다. 그 함수가 저장소
        // 최상위 대신 앱 데이터의 overlay 폴더를 돌려주도록 "정리"되어도 — overlay
        // 어댑터만 보면 그쪽이 더 자연스러워 보인다 — 이 시험도, git 어댑터 쪽 짝
        // 시험(`project_git.rs`)도 그대로 녹색으로 남는다. 그 상태에서는 overlay 적용과
        // `git switch`가 한 작업 트리에서 동시에 돌고, 둘 다 자기 영수증의 `head_before`를
        // 믿을 수 없게 된다(C19-5).
        //
        // 그래서 자료구조가 아니라 **경계를 넘는 동작**을 고정한다: overlay 쪽 키로 잠금을
        // 쥔 채 git 어댑터의 변경(`stage_project_git_paths`)을 부르면 `Busy` 영수증이
        // 나와야 한다. 두 어댑터가 서로 다른 키를 쓰는 순간 이 호출은 실제로 스테이징을
        // 해 버리고 `Completed`가 돌아오므로, 한쪽만 고치는 사람에게 바로 걸린다.
        let Some(repo) = overlay_repo() else {
            return;
        };
        let runner = overlay_runner(&repo);
        let request = crate::project_git::ProjectGitPathsRequest {
            project_path: repo.root.to_string_lossy().into_owned(),
            paths: vec!["src/app.ts".to_owned()],
        };

        let held = BusyGuard::acquire(runner.overlay_lock_key()).expect("overlay 잠금을 쥔다");
        let blocked =
            crate::project_git::stage_project_git_paths(&repo.app_data, &repo.root, &request)
                .expect("영수증");
        assert!(
            matches!(blocked.outcome, crate::project_git::GitOutcome::Busy),
            "overlay가 잠금을 쥔 동안 git 변경은 busy여야 한다 — 두 어댑터가 같은 키를 쓰지              않으면 이 호출이 실제로 작업 트리를 건드린다: {blocked:?}"
        );
        assert!(
            !blocked.succeeded,
            "busy 영수증은 성공이 아니다: {blocked:?}"
        );

        // overlay 쪽도 같은 열쇠를 쓰는지 되묻는다. 위 단언만 있으면 git 어댑터가 overlay
        // 열쇠에 걸린다는 것까지만 증명되고, overlay 자신이 그 열쇠로 잠그는지는 열려 있다 —
        // `snapshot_*` 이 자기 전용 잠금으로 갈아타도 한쪽 단언은 그대로 녹색이다.
        let set_id = {
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
                    project_path: request.project_path.clone(),
                    set_id: None,
                    name: "잠금 공유".to_owned(),
                    paths: vec!["src/app.ts".to_owned()],
                },
            )
            .expect("세트 저장");
            saved.set_id.clone().expect("set id")
        };
        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: request.project_path.clone(),
                set_id,
                trigger: None,
            },
            overlay_test_env(),
        )
        .expect("스냅샷 호출");
        assert!(
            matches!(snapshot.outcome, ProjectOverlayOutcome::Busy),
            "overlay가 자기 잠금을 가로질렀다 — snapshot이 다른 열쇠를 쓴다: {snapshot:?}"
        );

        // 놓으면 같은 호출이 지나가야 한다. 그래야 위 `Busy`가 잠금 때문이지 다른 거절
        // 때문이 아님이 증명된다.
        drop(held);
        let passed =
            crate::project_git::stage_project_git_paths(&repo.app_data, &repo.root, &request)
                .expect("영수증");
        assert!(
            !matches!(passed.outcome, crate::project_git::GitOutcome::Busy),
            "잠금을 놓은 뒤에도 busy면 잠금이 새는 것이다: {passed:?}"
        );
    }

    /// 2026-10-05. C19-3. `exclude_project_overlay_paths`가 **다른 어댑터와 같은 잠금**을
    /// 잡는지를 고정한다.
    ///
    /// 무엇이 실제로 틀렸는가. overlay 명령은 전부 `remote.rs`의 `project()` 결과 — **등록
    /// 프로젝트 루트** — 를 받는다. `snapshot`과 `apply`는 그 경로로 `GitRunner`를 열고
    /// `runner.overlay_lock_key()`(= `--show-toplevel`로 찾은 **저장소 최상위**)로 잠그는데,
    /// 2026-10-04에 들어온 `exclude`만 받은 경로를 그대로 `BusyGuard::acquire`에 넘겼다.
    /// 프로젝트가 저장소의 하위 폴더로 등록돼 있으면 두 값이 다른 `PathBuf`라 잠금이 서로를
    /// 전혀 막지 못한다 — 같은 작업 트리에서 `exclude`의 patch 재작성과 `apply`가 동시에 돈다.
    ///
    /// 그 동시 실행이 왜 해로운지는 `exclude` 자신의 주석이 적어 두었다: "`apply`가 digest를
    /// 확인한 뒤 적용하기 전 사이에 patch가 바뀌면 그 확인이 무의미해진다." `apply`는 digest를
    /// 확인한 **그 파일을** 다시 읽어 작업 트리에 넣으므로, 그 사이에 `exclude`가 patch를
    /// 덜어내 다시 쓰면 사용자가 승인한 적 없는 내용이 들어가거나 승인한 변경이 빠진다(C19-5).
    ///
    /// 입력은 그래서 **하위 폴더로 등록된 프로젝트**다. 저장소 최상위를 프로젝트로 쓰면 두
    /// 경로가 우연히 같아 틀린 코드로도 통과한다 — 기존 잠금 시험
    /// (`project_overlay_c19_serializes_concurrent_requests`)이 `snapshot`과 git 어댑터는
    /// 묶어 두고도 이 결함을 놓친 이유가 그것이다.
    #[test]
    fn project_overlay_c19_exclude_shares_the_repository_lock() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        // 저장소 최상위가 아닌 하위 폴더를 등록 프로젝트로 쓴다. 이것이 결함이 드러나는
        // 유일한 모양이다.
        let project = repo.root.join("src");
        let project_path = project.to_string_lossy().into_owned();

        fs::write(repo.root.join("src/app.ts"), "export const port = 8080;\n").expect("편집");
        fs::write(repo.root.join("untouched.ts"), "untouched local\n").expect("편집");

        let saved = save_project_overlay_set(
            &repo.app_data,
            &project,
            &SaveProjectOverlaySetRequest {
                project_path: project_path.clone(),
                set_id: None,
                name: "잠금 공유 — 하위 폴더".to_owned(),
                paths: vec!["src/app.ts".to_owned(), "untouched.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        let set_id = saved.set_id.clone().expect("set id");

        // 하위 폴더로 등록해도 장부는 저장소 단위다(C19-1). 그 전제가 깨지면 아래 단언이
        // 잠금이 아니라 "세트를 찾지 못했다"로 실패하므로 여기서 먼저 못박는다.
        assert_eq!(
            overlay_repository_id(&project),
            overlay_repository_id(&repo.root),
            "하위 폴더 프로젝트도 같은 저장소 장부를 써야 한다"
        );

        let runner = overlay_runner(&repo);
        let held = BusyGuard::acquire(runner.overlay_lock_key()).expect("저장소 잠금을 쥔다");

        let blocked = exclude_project_overlay_paths(
            &repo.app_data,
            &project,
            &ExcludeProjectOverlayPathsRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                paths: vec!["untouched.ts".to_owned()],
            },
        )
        .expect("영수증");
        assert!(
            matches!(blocked.outcome, ProjectOverlayOutcome::Busy),
            "저장소 잠금을 쥔 동안 exclude는 busy여야 한다 — 다른 열쇠를 쓰면 이 호출이 실제로              보관한 patch를 다시 쓴다: {blocked:?}"
        );
        assert!(
            !blocked.succeeded,
            "busy 영수증은 성공이 아니다: {blocked:?}"
        );

        // 놓으면 같은 호출이 지나가야 한다. 그래야 위 `Busy`가 잠금 때문이지 하위 폴더
        // 경로를 거절한 것이 아님이 증명된다.
        drop(held);
        let passed = exclude_project_overlay_paths(
            &repo.app_data,
            &project,
            &ExcludeProjectOverlayPathsRequest {
                project_path,
                set_id,
                paths: vec!["untouched.ts".to_owned()],
            },
        )
        .expect("영수증");
        assert!(
            !matches!(passed.outcome, ProjectOverlayOutcome::Busy),
            "잠금을 놓은 뒤에도 busy면 잠금이 새는 것이다: {passed:?}"
        );
        assert!(
            passed.succeeded,
            "잠금을 놓으면 빼기가 성공해야 한다: {passed:?}"
        );
    }

    /// 2026-10-04. C19-3/C19-5. 계획의 충돌 해결 UX 가운데 "대상 파일 제외"를 고정한다.
    ///
    /// 무엇이 실제로 틀릴 수 있는가. `apply`가 `overlayNeedsResolution`으로 막는 것은 보통
    /// 세트 안의 **한 파일**인데, 그때까지 사용자에게 남은 길은 그 파일을 손으로 정리하거나
    /// 세트를 통째로 버리는 둘뿐이었다. 버리면 patch가 휴지통으로 가면서 **막지 않은 나머지
    /// 경로의 로컬 설정도 같이** 사라진다. 그래서 이 조작은 세 가지를 한꺼번에 지켜야 한다 —
    /// 빼 달라고 한 구역만 patch에서 빠질 것, 나머지 구역은 그대로 적용될 것, 그리고 덜어낸
    /// 이전 patch가 지워지지 않고 휴지통에 남을 것(C19-5의 "patch를 잃는 경로는 없다").
    ///
    /// 입력: 커밋된 `src/app.ts`와 `untouched.ts`를 둘 다 고쳐 한 세트로 보관한 뒤
    /// `untouched.ts`만 뺀다. 두 파일을 쓰는 이유는 한 파일짜리 세트로는 "남은 구역이
    /// 그대로 적용된다"를 물을 수 없기 때문이다 — patch 구역 가르기가 틀려 전부 날아가도
    /// 한 파일짜리 시험은 통과한다.
    #[test]
    fn project_overlay_c19_exclude_drops_only_the_named_path() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let project_path = repo.root.to_string_lossy().into_owned();
        fs::write(repo.root.join("src/app.ts"), "export const port = 8080;\n").expect("편집");
        fs::write(repo.root.join("untouched.ts"), "untouched local\n").expect("편집");

        let saved = save_project_overlay_set(
            &repo.app_data,
            &repo.root,
            &SaveProjectOverlaySetRequest {
                project_path: project_path.clone(),
                set_id: None,
                name: "로컬 설정".to_owned(),
                paths: vec!["src/app.ts".to_owned(), "untouched.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        let set_id = saved.set_id.clone().expect("set id");

        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &SnapshotProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                trigger: None,
            },
            overlay_test_env(),
        )
        .expect("스냅샷");
        assert_eq!(snapshot.outcome, ProjectOverlayOutcome::Snapshotted);
        let first_digest = snapshot.patch_digest.clone().expect("digest");

        // 세트에 없는 경로는 거절이고, 거절이 있으면 아무것도 바뀌지 않는다.
        let refused = exclude_project_overlay_paths(
            &repo.app_data,
            &repo.root,
            &ExcludeProjectOverlayPathsRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                paths: vec!["staged.ts".to_owned()],
            },
        )
        .expect("거절도 영수증");
        assert!(!refused.succeeded);
        assert_eq!(refused.outcome, ProjectOverlayOutcome::Rejected);
        assert_eq!(refused.rejected.len(), 1);
        assert_eq!(refused.patch_digest.as_deref(), Some(first_digest.as_str()));

        let receipt = exclude_project_overlay_paths(
            &repo.app_data,
            &repo.root,
            &ExcludeProjectOverlayPathsRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                paths: vec!["untouched.ts".to_owned()],
            },
        )
        .expect("제외");
        assert!(receipt.succeeded, "{}", receipt.message);
        assert_eq!(receipt.outcome, ProjectOverlayOutcome::Saved);
        assert_eq!(receipt.affected, vec!["untouched.ts".to_owned()]);
        assert_ne!(
            receipt.patch_digest.as_deref(),
            Some(first_digest.as_str()),
            "덜어낸 patch는 보관 시점과 다른 digest를 갖는다"
        );

        let listed = list_project_overlay_sets(&repo.app_data, &repo.root).expect("목록");
        let set = listed
            .sets
            .iter()
            .find(|candidate| candidate.set_id == set_id)
            .expect("세트");
        assert_eq!(set.paths, vec!["src/app.ts".to_owned()]);
        assert_eq!(set.state, ProjectOverlayState::Stored);

        // 덜어내기 전의 patch는 지워지지 않고 휴지통에 남는다(C19-5).
        let trash = repo.app_data.join("git-overlays").join(".trash");
        let mut trashed = 0usize;
        for group in fs::read_dir(&trash).expect("휴지통") {
            let group = group.expect("항목").path();
            if group.join(&set_id).join("overlay.patch").is_file() {
                trashed += 1;
            }
        }
        assert_eq!(trashed, 1, "덜어내기 전 patch가 휴지통에 한 벌 남아야 한다");

        // 남은 구역은 그대로 적용되고, 뺀 경로는 HEAD 원본 그대로다.
        let applied = apply_project_overlay_with_env(
            &repo.app_data,
            &repo.root,
            &ApplyProjectOverlayRequest {
                project_path,
                set_id,
            },
            overlay_test_env(),
        )
        .expect("적용");
        assert_eq!(
            applied.outcome,
            ProjectOverlayOutcome::Applied,
            "{}",
            applied.message
        );
        assert_eq!(
            fs::read_to_string(repo.root.join("src/app.ts")).expect("읽기"),
            "export const port = 8080;\n"
        );
        assert_eq!(
            fs::read_to_string(repo.root.join("untouched.ts")).expect("읽기"),
            "untouched\n",
            "세트에서 뺀 경로는 patch에서도 빠졌으므로 HEAD 원본 그대로여야 한다"
        );
    }

    /// 2026-10-04. 하위 폴더 프로젝트에서 **브랜치를 옮긴 뒤** 보관된 overlay가 실제로
    /// 다시 들어가는지를 끝에서 끝까지 고정한다(C19-1, C19-3).
    ///
    /// 왜 이 자리가 비어 있었나. C19의 e2e 시험들은 입구가 전부 저장소 최상위
    /// (`repo.root`)다. 하위 폴더를 다루는 시험은
    /// `overlay_ledger_is_keyed_by_the_repository_top_level_not_the_registered_subfolder_c19_1`
    /// 하나뿐인데, 그것이 보는 것은 **장부가 한 곳인가**이지 그 장부로 작업 트리가 실제로
    /// 되돌아갔다가 다시 채워지는가가 아니다. 그 둘 사이에 경로의 기준이 둘 끼어 있다 —
    /// 세트에 담기는 경로는 저장소 최상위 기준(`app/service.ts`)인데
    /// `save_project_overlay_set`이 `validate_repo_path`에 넘기는 루트는 `remote.rs`의
    /// `project()`가 돌려준 **등록 프로젝트 루트**(`<repo>/app`)이고, 정작 git은
    /// `GitRunner`가 `--show-toplevel`로 찾은 최상위에서 돈다. 둘이 어긋나 있어도
    /// `validate_repo_path`의 담김 검사는 `..` 없는 경로를 전부 통과시키므로 저장 단계에서는
    /// 아무 소리도 나지 않는다. 어긋남이 드러나는 자리는 git이 그 경로를 실제로 해석하는
    /// 스냅샷·적용뿐이고, 그 자리를 하위 폴더 입구로 밟아 본 시험이 없었다.
    ///
    /// 브랜치 이동이 입력에 들어가는 이유가 둘째다. C19-3의 자동 재적용은 "앱이 시작한 Git
    /// 작업(switch/pull/rebase/merge) 뒤"가 전제인데, **기존 e2e 중 HEAD를 움직이는 것이
    /// 하나도 없다.** 2026-10-04 실측으로 그 공백을 쟀다: `reapply_project_overlays_with_env`
    /// 의 반복문에 `.filter(|set| set.base_head.as_deref() == 현재_HEAD.as_deref())` 한 줄을
    /// 더해 "바탕이 옮겨간 세트는 낡았으니 건너뛴다"는 그럴듯한 규칙을 넣자, 이 모듈의 시험
    /// 25건 가운데 **이 시험 하나만** FAILED 했다. 그 상태의 제품은 브랜치를 옮긴 바로 그
    /// 순간 — 곧 overlay가 존재하는 유일한 이유인 그 순간 — 아무것도 재적용하지 않으면서
    /// 영수증도 오류도 남기지 않는다.
    ///
    /// 입력은 이렇다. `<repo>/app/service.ts`를 커밋해 둔 상태에서 포트를 8080으로 바꾸고,
    /// **하위 폴더 입구**(`<repo>/app`)로 세트를 저장·스냅샷한다. 그 다음 `switch -c`로
    /// 브랜치를 새로 만들어 최상위의 다른 파일(`untouched.ts`)만 바꿔 커밋해 HEAD를 움직인
    /// 뒤, 다시 **하위 폴더 입구**로 재적용한다. 넷을 못박는다. (1) 스냅샷이 작업 트리를
    /// HEAD 원본으로 되돌린다 — 되돌리지 못하면 경로 기준이 어긋난 것이다. (2) 브랜치를
    /// 옮긴 뒤 drift가 그 세트를 `head_moved`로 읽는다. (3) 재적용이 1건 적용으로 끝나고
    /// 파일 내용이 8080으로 돌아온다. (4) 최상위 입구로 물어도 같은 세트 하나가 보인다 —
    /// 두 입구가 같은 장부를 쓴다는 것을 작업 트리가 실제로 바뀐 뒤에 다시 확인한다.
    #[test]
    fn project_overlay_c19_reapplies_a_subfolder_project_set_across_a_branch_switch() {
        let Some(repo) = overlay_repo() else {
            return;
        };
        let env = overlay_test_env();
        let project = repo.root.join("app");
        fs::create_dir_all(&project).expect("app dir");
        fs::write(project.join("service.ts"), "export const port = 443;\n").expect("seed");
        overlay_git(&repo.root, &["add", "-A"]);
        overlay_git(&repo.root, &["commit", "-q", "-m", "app"]);
        let original = fs::read_to_string(project.join("service.ts")).expect("원본");

        fs::write(project.join("service.ts"), "export const port = 8080;\n").expect("unstaged");

        let project_path = project.to_string_lossy().into_owned();
        let saved = save_project_overlay_set(
            &repo.app_data,
            &project,
            &SaveProjectOverlaySetRequest {
                project_path: project_path.clone(),
                set_id: None,
                name: "로컬 포트".to_owned(),
                // 저장소 최상위 기준이다. 프로젝트 기준(`service.ts`)이 아니다.
                paths: vec!["app/service.ts".to_owned()],
            },
        )
        .expect("세트 저장");
        assert_eq!(
            saved.outcome,
            ProjectOverlayOutcome::Saved,
            "{}",
            saved.message
        );
        let set_id = saved.set_id.clone().expect("set id");

        let snapshot = snapshot_project_overlay_with_env(
            &repo.app_data,
            &project,
            &SnapshotProjectOverlayRequest {
                project_path: project_path.clone(),
                set_id: set_id.clone(),
                trigger: None,
            },
            env.clone(),
        )
        .expect("스냅샷");
        assert!(snapshot.succeeded, "{snapshot:?}");
        assert_eq!(
            fs::read_to_string(project.join("service.ts")).expect("되돌림"),
            original,
            "하위 폴더 입구의 스냅샷이 작업 트리를 HEAD 원본으로 되돌리지 못했다 — \
             세트의 경로 기준과 git이 도는 자리가 어긋났다는 뜻이다"
        );

        // 브랜치를 옮기고 HEAD를 실제로 움직인다. overlay가 담은 파일은 건드리지 않는다.
        overlay_git(&repo.root, &["switch", "-q", "-c", "feature"]);
        fs::write(repo.root.join("untouched.ts"), "untouched on feature\n").expect("feature");
        overlay_git(&repo.root, &["add", "-A"]);
        overlay_git(&repo.root, &["commit", "-q", "-m", "feature"]);

        let drift = get_project_overlay_drift_with_env(&repo.app_data, &project, env.clone())
            .expect("drift");
        let entry = drift
            .sets
            .iter()
            .find(|set| set.set_id == set_id)
            .expect("보관된 세트가 drift에 없다");
        assert!(
            entry.head_moved,
            "브랜치를 옮겼는데 base_head와 현재 HEAD가 같다고 읽었다: {drift:?}"
        );

        let reapplied = reapply_project_overlays_with_env(
            &repo.app_data,
            &project,
            &ReapplyProjectOverlaysRequest {
                project_path: project_path.clone(),
                recovery: false,
            },
            env.clone(),
        )
        .expect("재적용");
        assert_eq!(
            reapplied.applied, 1,
            "브랜치를 옮긴 뒤 하위 폴더 프로젝트의 세트가 다시 들어가지 않았다: {reapplied:?}"
        );
        assert_eq!(reapplied.needs_resolution, 0, "{reapplied:?}");
        assert_eq!(
            fs::read_to_string(project.join("service.ts")).expect("적용 뒤"),
            "export const port = 8080;\n"
        );

        // 두 입구가 같은 장부를 쓴다 — 작업 트리가 실제로 바뀐 뒤에 다시 확인한다.
        let from_root = list_project_overlay_sets(&repo.app_data, &repo.root).expect("list root");
        assert_eq!(from_root.sets.len(), 1, "{from_root:?}");
        assert_eq!(from_root.sets[0].set_id, set_id);
    }
}
