//! 등록 프로젝트의 git 저장소를 사용자의 `git` 바이너리로 읽고 바꾸는 한 곳(C16).
//!
//! 브랜치 이름 하나를 읽는 `git_refs`는 `.git` 파일을 직접 읽지만, 상태·diff·log·커밋·
//! 리베이스·원격 작업은 git 자체가 아니면 같은 답을 낼 수 없다. 그래서 여기서는 PATH의
//! `git`을 찾아(G9) 구조화된 인자로만 띄운다 — 셸 문자열은 없고, 사용자 입력은 검증을 거친
//! 뒤 `--end-of-options` 뒤나 stdin으로만 들어간다.
//!
//! 대상은 **활성 등록 프로젝트를 품은 저장소**다(C16-1). 프로젝트가 저장소의 하위 폴더여도
//! 그 저장소를 대상으로 삼되 최상위가 사용자 홈이나 보호 루트면 거절한다 — 홈 dotfiles
//! 저장소가 프로젝트 화면으로 새는 길이다. 모든 명령은 최상위를 작업 폴더로 삼아 porcelain
//! 출력의 경로(저장소 루트 기준)와 요청 경로가 같은 기준을 갖는다.
//!
//! 되돌릴 수 없는 명령은 **제공하지 않는다**(C16-4). `reset --hard`·`clean`·워크트리 변경
//! 버리기·`branch -D`·`--force*`·`--amend`·대화형 rebase는 이 모듈 어디에도 없고, 제공하는
//! 변경은 모두 reflog·`ORIG_HEAD`·stash 앵커를 영수증에 남긴다(C16-6).
//!
//! 실행은 비대화식이다(C16-3). 자격증명 프롬프트는 즉시 실패해 `authFailed` 영수증이 되고,
//! 편집기는 `true`로 대체되며, 제한 시간이 지나면 프로세스 그룹째 죽인다.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cli_interface::{run_capped_with, CappedOptions, CommandOutcome};
use crate::doc_roots::is_restricted_doc_root;
use crate::git_refs::read_small;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::path_guard::{self, CurDirPolicy, RootLabels};
use crate::process_output::MAX_CAPTURED_OUTPUT_BYTES;
use crate::providers::resolve_named_executable;
use crate::user_home::home_dir;
use crate::CoreError;

/// `--pathspec-from-file`·`--end-of-options`가 함께 있는 첫 버전.
const MIN_GIT_VERSION: (u32, u32) = (2, 25);

const READ_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const LOCAL_MUTATION_TIMEOUT: Duration = Duration::from_secs(60);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

const MAX_STATUS_ENTRIES: usize = 5_000;
const MAX_BRANCHES: usize = 1_000;
const MAX_STASHES: usize = 100;
const MAX_LOG_LIMIT: usize = 200;
const DEFAULT_LOG_LIMIT: usize = 50;
const MAX_LOG_SKIP: usize = 100_000;
const MAX_PATHS_PER_REQUEST: usize = 1_000;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_REF_BYTES: usize = 256;
const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_STASH_MESSAGE_CHARS: usize = 1_000;
const MAX_STASH_INDEX: u32 = 10_000;
const MAX_COMMIT_BODY_CHARS: usize = 2_000;
/// C16-11. 토큰이 실리는 호출이 `core.hooksPath`로 가리키는 앱 데이터 안의 빈 폴더.
const EMPTY_HOOKS_DIR: &str = "project-git-no-hooks";

/// C16-11. 개요가 `remote get-url --push`로 실제 주소를 묻는 원격 수.
const MAX_AUTH_PROBED_REMOTES: usize = 16;

/// 모든 호출에 앞세우는 전역 옵션. 색·페이저·인용을 끄고 pathspec을 글자 그대로 본다 —
/// 검증한 경로가 glob으로 풀리면 검증이 무의미해진다.
const GIT_BASE_ARGS: &[&str] = &[
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "color.ui=never",
    "-c",
    "core.quotePath=false",
    "-c",
    "advice.detachedHead=false",
];

/// 자식에게 물려주지 않는 리디렉션 변수(C16-2). 백엔드가 물려받은 `GIT_DIR`가 사용자가 고른
/// 저장소를 다른 곳으로 옮기게 두지 않는다. 설정 파일 변수(`GIT_CONFIG_*`)는 사용자의 선택이라
/// 남긴다.
const REMOVED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "DISPLAY",
    // C16-10. 물려받은 신원 설정은 어느 호출에도 닿지 않는다. 네트워크 작업이 쓸 신원은
    // 사용자가 애드온에서 켠 키 하나뿐이고, 그 값만 `env`로 다시 얹는다(제거가 먼저 돈다).
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    // 이 값은 git이 우리 명령에 포트·사용자 인수를 **어떤 모양으로** 덧붙일지를 바꾼다.
    // 물려받은 값 하나가 사용자가 고른 연결을 조용히 다른 모양으로 만든다.
    "GIT_SSH_VARIANT",
];

const LABELS: RootLabels = RootLabels {
    subject: "저장소 경로",
    escaped: "저장소 밖을 가리키는 경로입니다",
};

// ---------------------------------------------------------------------------
// 요청
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitTarget {
    pub project_path: String,
}

/// 작업 트리 상태 읽기. `worktree_path` 를 주면 프로젝트 저장소에 연결된 그 워크트리를 읽는다
/// (회차가 `git worktree` 로 따로 고치는 파일을 보려고). 읽기 전용이라 변경 명령에는 이 자리가
/// 없다 — 스테이지·커밋은 언제나 등록 프로젝트 자신에만 간다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitStatusRequest {
    pub project_path: String,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitDiffRequest {
    pub project_path: String,
    /// `ProjectGitStatusRequest::worktree_path` 와 같다. diff 도 읽기라 같은 워크트리를 연다.
    #[serde(default)]
    pub worktree_path: Option<String>,
    pub path: String,
    #[serde(default)]
    pub original_path: Option<String>,
    #[serde(default)]
    pub staged: bool,
    /// 지정하면 작업 트리·인덱스가 아니라 그 커밋이 부모 대비 바꾼 내용을 본다.
    #[serde(default)]
    pub commit: Option<String>,
    /// B9. 둘을 함께 주면 `<from>...<to>` 범위의 변경을 본다. 수신·송신 요약이 집은 파일을
    /// 그 요약과 **같은 범위**로 열기 위한 자리다. `staged`·`commit`과는 상호배타다.
    #[serde(default)]
    pub range_from: Option<String>,
    #[serde(default)]
    pub range_to: Option<String>,
    /// 전체 보기에서는 hunk 사이의 바뀌지 않은 줄도 생략하지 않는다.
    #[serde(default)]
    pub full_context: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitCommitFilesRequest {
    pub project_path: String,
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: GitChangeKind,
}

/// 커밋 하나가 부모 대비 바꾼 파일 목록. 병합 커밋은 모든 부모와 다른 파일만 나온다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFiles {
    pub project_path: String,
    pub sha: String,
    pub files: Vec<GitCommitFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitLogRequest {
    pub project_path: String,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub skip: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitPathsRequest {
    pub project_path: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitCommitRequest {
    pub project_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitSwitchRequest {
    pub project_path: String,
    pub branch: String,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitStashAction {
    Push,
    Pop,
    Apply,
    Drop,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitStashRequest {
    pub project_path: String,
    pub action: GitStashAction,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub include_untracked: bool,
    #[serde(default)]
    pub index: Option<u32>,
    #[serde(default)]
    pub expected_sha: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRebaseAction {
    Start,
    Continue,
    Skip,
    Abort,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitRebaseRequest {
    pub project_path: String,
    pub action: GitRebaseAction,
    #[serde(default)]
    pub onto: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitFetchRequest {
    pub project_path: String,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub prune: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitPullMode {
    #[default]
    FfOnly,
    Rebase,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitPullRequest {
    pub project_path: String,
    #[serde(default)]
    pub mode: GitPullMode,
    #[serde(default)]
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitPushRequest {
    pub project_path: String,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub set_upstream: bool,
}

// ---------------------------------------------------------------------------
// 조회 결과
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitUnavailableReason {
    GitMissing,
    GitTooOld,
    NotRepository,
    BareRepository,
    RestrictedRepository,
}

impl GitUnavailableReason {
    fn message(self) -> &'static str {
        match self {
            Self::GitMissing => "git 실행 파일을 찾을 수 없습니다. git을 설치한 뒤 다시 시도하세요",
            Self::GitTooOld => "git 2.25 이상이 필요합니다",
            Self::NotRepository => "이 프로젝트는 git 저장소가 아닙니다",
            Self::BareRepository => "bare 저장소는 형상관리 화면에서 다루지 않습니다",
            Self::RestrictedRepository => {
                "저장소 최상위가 사용자 홈이나 보호된 폴더라 형상관리 화면에서 다루지 않습니다"
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOverview {
    pub project_path: String,
    pub repository: Option<GitRepositoryInfo>,
    pub unavailable_reason: Option<GitUnavailableReason>,
    pub unavailable_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryInfo {
    pub repository_root: String,
    pub git_dir: String,
    pub is_linked_worktree: bool,
    pub head: GitHead,
    pub upstream: Option<GitUpstream>,
    pub local_branches: Vec<GitBranch>,
    pub remote_branches: Vec<GitBranch>,
    pub branches_truncated: bool,
    pub remotes: Vec<GitRemote>,
    pub worktrees: Vec<GitWorktree>,
    pub in_progress: Option<GitInProgress>,
    pub stashes: Vec<GitStash>,
    pub stashes_truncated: bool,
    pub git_version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHead {
    pub branch: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub sha: Option<String>,
    pub short_sha: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUpstream {
    pub name: String,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub sha: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    pub committed_at: i64,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub url: Option<String>,
    /// C16-11. 이 원격에 push할 때 쓸 수 있는 인증 수단을 네트워크 없이 매긴 판정.
    pub auth: GitRemoteAuth,
}

/// C16-11. 원격 URL의 전송 방식.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRemoteTransport {
    Https,
    Http,
    Ssh,
    Local,
    Other,
}

/// C16-11. 그 원격에 붙을 때 이 어댑터가 쓸 수 있는 인증 수단.
///
/// 판정은 백엔드가 이미 아는 것(URL 모양·앱 설정·git 설정)으로만 내린다. 실제로 통과하는지는
/// 원격에 붙어 봐야 알 수 있으므로, 화면은 `none`일 때만 push를 막고 나머지는 안내로 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRemoteAuthMethod {
    /// 저장된 비밀값 하나가 이 호스트의 git 원격용 토큰으로 지정돼 있다.
    Token,
    /// 애드온의 SSH 키 하나가 "git 원격용"으로 켜져 있다(C16-10).
    SshKey,
    /// git 설정에 이 URL에 맞는 credential helper가 있다(맥 키체인 등).
    CredentialHelper,
    /// URL 자체에 `user:password@`가 들어 있다.
    UrlCredential,
    /// SSH인데 켜 둔 키가 없다. ssh-agent나 `~/.ssh` 기본 키로 붙을 수도 있어 막지 않는다.
    SshDefault,
    /// 로컬 경로라 인증이 없다.
    NotNeeded,
    /// 이 어댑터가 쓸 수 있는 수단이 하나도 없다. HTTPS 원격이면 push는 반드시 실패한다.
    None,
    /// 판정할 수 없는 전송(`git://` 등).
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteAuth {
    pub transport: GitRemoteTransport,
    /// HTTPS·HTTP·SSH 원격의 호스트(`github.com`, 필요하면 `:포트`).
    pub host: Option<String>,
    pub method: GitRemoteAuthMethod,
    /// `method`가 `token`일 때 프로젝트 설정이 고른 저장된 비밀값의 이름. 값은 어디에도
    /// 실리지 않는다.
    pub token_secret: Option<String>,
    /// 가져오기·끌어오기가 쓰는 주소가 HTTPS일 때 그 호스트. push 주소(`pushurl`)와 다를 수
    /// 있고, 토큰은 호출마다 그 호출의 주소로 고르므로 설정 화면이 이 호스트도 보여야 한다.
    pub fetch_host: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
    pub is_current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitInProgressKind {
    Rebase,
    RebaseInteractive,
    Am,
    Merge,
    CherryPick,
    Revert,
    Bisect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInProgress {
    pub kind: GitInProgressKind,
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub index: u32,
    pub sha: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeKind {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Unmerged,
}

impl GitChangeKind {
    fn from_porcelain(code: char) -> Self {
        match code {
            'M' => Self::Modified,
            'T' => Self::TypeChanged,
            'A' => Self::Added,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'C' => Self::Copied,
            'U' => Self::Unmerged,
            '?' => Self::Untracked,
            '!' => Self::Ignored,
            _ => Self::Unmodified,
        }
    }

    fn is_change(self) -> bool {
        !matches!(
            self,
            Self::Unmodified | Self::Untracked | Self::Ignored | Self::Unmerged
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: GitChangeKind,
    pub worktree_status: GitChangeKind,
    pub is_submodule: bool,
    pub unmerged: Option<String>,
    pub rename_score: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub project_path: String,
    pub head: GitHead,
    pub upstream: Option<GitUpstream>,
    pub entries: Vec<GitStatusEntry>,
    pub truncated: bool,
    pub conflicted_count: usize,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitDiffKind {
    Text,
    Binary,
    Untracked,
    Empty,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub project_path: String,
    pub path: String,
    pub staged: bool,
    pub kind: GitDiffKind,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: i64,
    pub committer_name: String,
    pub committed_at: i64,
    pub refs: Vec<String>,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLog {
    pub project_path: String,
    pub reference: String,
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
}

/// 팔로우 카드가 묻는 한 가지: 이 브랜치와 그 upstream 사이에 무엇이 오고 무엇이 나가는가.
/// `branch`를 비우면 현재 HEAD 브랜치, `upstream`을 비우면 그 브랜치에 설정된 upstream이다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitComparisonRequest {
    pub project_path: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub upstream: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// 브랜치와 upstream의 차이를 **방향으로 갈라** 돌려준다(B6). 한 숫자로 합치면 "3 커밋 차이"가
/// 받아야 할 것인지 보내야 할 것인지 화면이 말할 수 없고, 사용자는 pull과 push 중 무엇을
/// 눌러야 하는지 알 수 없다.
///
/// 이 수치는 **마지막 fetch 기준**이다. 원격을 새로 묻지 않으므로(읽기 조회이고 네트워크를
/// 쓰지 않는다) `last_fetched_at`을 같이 실어 화면이 그 사실을 말하게 한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchComparison {
    pub project_path: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    /// upstream이 설정되지 않았거나 사라졌다. 이때 양쪽 목록은 비어 있다.
    pub no_upstream: bool,
    /// `branch..upstream` — 받아야 할 커밋(최신 먼저).
    pub incoming: Vec<GitCommit>,
    /// `upstream..branch` — 보내야 할 커밋(최신 먼저).
    pub outgoing: Vec<GitCommit>,
    pub incoming_count: u32,
    pub outgoing_count: u32,
    pub incoming_truncated: bool,
    pub outgoing_truncated: bool,
    /// B8. 수신 커밋들이 합쳐서 바꾸는 파일(merge-base..upstream). 커밋 목록만으로는
    /// "pull하면 내 작업 파일이 건드려지는가"를 답할 수 없어, 방향마다 따로 싣는다.
    pub incoming_files: Vec<GitCommitFile>,
    /// B8. 송신 커밋들이 합쳐서 바꾸는 파일(merge-base..branch).
    pub outgoing_files: Vec<GitCommitFile>,
    pub incoming_files_truncated: bool,
    pub outgoing_files_truncated: bool,
    /// 양쪽 모두 0이 아니다 — fast-forward로 정리되지 않는다.
    pub diverged: bool,
    /// `FETCH_HEAD`의 수정 시각(unix 초). 한 번도 fetch하지 않았으면 null이다.
    pub last_fetched_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// 영수증
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitOutcome {
    Completed,
    NothingToCommit,
    Conflict,
    BlockedByLocalChanges,
    NotFastForward,
    NoUpstream,
    RejectedNonFastForward,
    AuthFailed,
    IdentityMissing,
    RepositoryLocked,
    Busy,
    TimedOut,
    Failed,
}

/// 변경 한 건의 결과. 충돌·non-fast-forward·자격증명 실패처럼 사용자가 다음 행동을 골라야
/// 하는 결말은 오류가 아니라 여기 실려 화면이 안내한다(C16-6). `head_before`·`head_after`와
/// `dropped_stash_sha`는 되돌릴 때 붙잡을 앵커다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActionReceipt {
    pub action: String,
    pub succeeded: bool,
    pub outcome: GitOutcome,
    pub message: String,
    pub head_before: Option<String>,
    pub head_after: Option<String>,
    pub conflicted_files: Vec<String>,
    pub blocked_files: Vec<String>,
    pub dropped_stash_sha: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
}

// ---------------------------------------------------------------------------
// 실행기
// ---------------------------------------------------------------------------

/// 저장소를 열지 못한 이유. 화면 조회는 `Unavailable`을 빈 저장소 카드로 그리고, 변경은
/// 같은 이유를 오류로 돌려준다.
pub(crate) enum GitOpenFailure {
    Unavailable(GitUnavailableReason, String),
    Error(CoreError),
}

impl From<CoreError> for GitOpenFailure {
    fn from(error: CoreError) -> Self {
        Self::Error(error)
    }
}

impl From<GitOpenFailure> for CoreError {
    fn from(failure: GitOpenFailure) -> Self {
        match failure {
            GitOpenFailure::Unavailable(reason, detail) if detail.is_empty() => {
                CoreError::InvalidInput(reason.message().to_owned())
            }
            GitOpenFailure::Unavailable(reason, detail) => {
                CoreError::InvalidInput(format!("{} ({detail})", reason.message()))
            }
            GitOpenFailure::Error(error) => error,
        }
    }
}

// C16-4가 "제공하지 않는다"고 이름으로 적어 둔 인수들이 실제로 자식에게 가는 argv에
// 오르지 않는지를 재기 위한 **시험 전용** 기록기. 제품 빌드에는 존재하지 않는다.
//
// 이 자리에 두는 이유: C16-4는 "어떤 인수를 만들지 않는다"는 약속이고, 그 약속이 깨지는
// 지점은 인수 벡터가 완성되는 `GitRunner::run` 한 곳뿐이다. 빌더를 따로 읽는 시험은
// 사용자 입력과 git 출력에서 흘러들어온 값(해석된 원격, refspec, 시작점)을 보지 못한다.
// 스레드 지역이라 `cargo test`의 병렬 실행에서 시험끼리 섞이지 않는다.
#[cfg(test)]
#[derive(Clone)]
struct RecordedCall {
    argv: Vec<String>,
    /// 자식의 stdin으로 넘어간 바이트. C16-5는 "경로와 커밋 메시지는 argv가 아니라
    /// stdin으로 간다"고 적어 두었는데, argv만 기록하면 "argv에 없다"까지만 물을 수
    /// 있고 "그래서 stdin으로 갔다"는 물을 수 없다. 둘을 함께 재야 인수를 지운 것과
    /// 경로를 옮긴 것이 갈린다.
    input: Option<Vec<u8>>,
    /// 자식에게 **설정한** 환경변수. C16-3은 비대화 실행을 여섯 가지 변수로 걸어
    /// 두었는데(`GIT_TERMINAL_PROMPT`·`GIT_ASKPASS`·`GIT_EDITOR`·`GIT_SEQUENCE_EDITOR`·
    /// `LC_ALL`·읽기의 `GIT_OPTIONAL_LOCKS`), argv만 기록하면 그 여섯이 실제로
    /// 자식에게 갔는지 물을 수 없다.
    env: Vec<(String, String)>,
    /// 자식에게서 **지운** 변수(C16-2의 상속 리디렉션과 askpass 계열). 설정한 것과
    /// 지운 것은 같은 자리에서 결정되므로 함께 기록해야 "지우고 다시 설정했다"는
    /// 자기모순을 잴 수 있다.
    env_remove: Vec<String>,
}

#[cfg(test)]
thread_local! {
    static RECORDED_CALLS: std::cell::RefCell<Option<Vec<RecordedCall>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
thread_local! {
    static TEST_NETWORK_IDENTITY: std::cell::RefCell<
        Option<crate::ssh_endpoints::ProjectGitIdentity>,
    > = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_network_identity() -> Option<crate::ssh_endpoints::ProjectGitIdentity> {
    TEST_NETWORK_IDENTITY.with(|cell| cell.borrow().clone())
}

// C16-11 시험용 (호스트, 사용자 이름, 값). 시험은 OS 보안 저장소를 열 수 없으므로 여기서
// 덮어쓴다. 비어 있으면 제품 경로(저장된 비밀값)가 그대로 돈다.
#[cfg(test)]
thread_local! {
    static TEST_GIT_TOKEN: std::cell::RefCell<Option<(String, String, String)>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_git_token(host: &str) -> Option<Option<GitRemoteToken>> {
    TEST_GIT_TOKEN.with(|cell| {
        cell.borrow().as_ref().map(|(bound, username, value)| {
            (bound == host).then(|| GitRemoteToken {
                secret_name: "TEST_GIT_TOKEN".to_owned(),
                username: username.clone(),
                value: zeroize::Zeroizing::new(value.clone()),
            })
        })
    })
}

#[cfg(test)]
fn record_call(argv: &[&str], input: Option<&[u8]>, env: &[(String, String)], env_remove: &[&str]) {
    RECORDED_CALLS.with(|cell| {
        if let Some(log) = cell.borrow_mut().as_mut() {
            log.push(RecordedCall {
                argv: argv.iter().map(|arg| (*arg).to_owned()).collect(),
                input: input.map(<[u8]>::to_vec),
                env: env.to_vec(),
                env_remove: env_remove.iter().map(|key| (*key).to_owned()).collect(),
            });
        }
    });
}

/// 검증을 마친 저장소 하나에 붙은 git 실행기. `root`는 저장소 최상위(자식에게 넘길 모양),
/// `git_dir`는 이 워크트리의 git 디렉터리다.
pub(crate) struct GitRunner {
    executable: PathBuf,
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    version: String,
    ceiling: Option<String>,
    extra_env: Vec<(String, String)>,
    /// C16-10. 네트워크 작업 직전에 "git 원격용" 키를 찾아보기 위한 앱 데이터 경로.
    app_data_dir: PathBuf,
    /// C16-11. 사용자가 고른 프로젝트 경로(저장소 최상위가 아닐 수 있다). 프로젝트 설정의
    /// git 원격용 토큰 지정을 찾는 열쇠라 팔로우와 같은 모양([`follow_key`])이다.
    project_key: String,
}

impl GitRunner {
    /// 프로젝트 폴더에서 저장소를 찾아 연다. 실행 파일·버전·저장소 여부·bare·보호 루트를
    /// 차례로 본다(C16-1).
    pub(crate) fn open(app_data_dir: &Path, project_root: &Path) -> Result<Self, GitOpenFailure> {
        Self::open_with_env(app_data_dir, project_root, Vec::new())
    }

    pub(crate) fn open_with_env(
        app_data_dir: &Path,
        project_root: &Path,
        extra_env: Vec<(String, String)>,
    ) -> Result<Self, GitOpenFailure> {
        let executable = resolve_named_executable(&["git"]).map_err(|error| {
            GitOpenFailure::Unavailable(GitUnavailableReason::GitMissing, error.to_string())
        })?;
        let home = home_dir().ok();
        let mut runner = Self {
            executable,
            root: path_guard::child_facing(project_root),
            git_dir: PathBuf::new(),
            common_dir: PathBuf::new(),
            version: String::new(),
            // 발견 단계의 천장은 사용자 홈이다. 홈 자체가 저장소면 아래에서 거절하므로
            // 그 위로 올라가 볼 이유가 없다.
            ceiling: home.as_ref().map(|home| {
                path_guard::child_facing(home)
                    .to_string_lossy()
                    .into_owned()
            }),
            extra_env,
            app_data_dir: app_data_dir.to_path_buf(),
            project_key: follow_key(project_root),
        };
        runner.version = git_version_for(&runner)?;
        // 흔한 경우(작업 트리 안)는 한 번의 rev-parse로 끝난다. `--show-toplevel`은 bare
        // 저장소와 저장소 밖에서 실패하므로 그때만 짧은 두 플래그로 이유를 가른다.
        let layout = runner.read(
            &[
                "rev-parse",
                "--show-toplevel",
                "--absolute-git-dir",
                "--git-common-dir",
            ],
            READ_TIMEOUT,
        )?;
        if !layout.success {
            let probe = runner.read(
                &["rev-parse", "--is-inside-work-tree", "--is-bare-repository"],
                READ_TIMEOUT,
            )?;
            if !probe.success {
                return Err(GitOpenFailure::Unavailable(
                    GitUnavailableReason::NotRepository,
                    first_line(&probe.stderr),
                ));
            }
            let bare = probe.stdout.lines().nth(1).map(str::trim) == Some("true");
            return Err(GitOpenFailure::Unavailable(
                if bare {
                    GitUnavailableReason::BareRepository
                } else {
                    GitUnavailableReason::NotRepository
                },
                first_line(&layout.stderr),
            ));
        }
        let mut lines = layout.stdout.lines().map(str::trim);
        let toplevel = lines.next().unwrap_or_default();
        let git_dir = lines.next().unwrap_or_default();
        let common_dir = lines.next().unwrap_or_default();
        let toplevel = std::fs::canonicalize(toplevel).map_err(CoreError::Io)?;
        if home
            .as_deref()
            .is_some_and(|home| std::fs::canonicalize(home).is_ok_and(|home| home == toplevel))
            || is_restricted_doc_root(app_data_dir, &toplevel)
        {
            return Err(GitOpenFailure::Unavailable(
                GitUnavailableReason::RestrictedRepository,
                path_guard::child_facing(&toplevel)
                    .to_string_lossy()
                    .into_owned(),
            ));
        }
        runner.root = path_guard::child_facing(&toplevel);
        runner.git_dir = PathBuf::from(git_dir);
        runner.common_dir = {
            let common = PathBuf::from(common_dir);
            if common.is_absolute() {
                common
            } else {
                runner.root.join(common)
            }
        };
        // 저장소가 정해진 뒤에는 그 부모가 천장이다. 이후 명령은 최상위에서 돌므로
        // 위로 올라갈 일 자체가 없지만, 한 번 더 못박아 둔다.
        runner.ceiling = runner
            .root
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned());
        Ok(runner)
    }

    /// overlay 어댑터가 저장소 단위 잠금을 git 어댑터와 **공유**하기 위해 보는 키(C19-3).
    pub(crate) fn overlay_lock_key(&self) -> &Path {
        &self.root
    }

    fn root_string(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn env(&self, write: bool, extra: &[(String, String)]) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = vec![
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            // 빈 값은 askpass 프로그램을 쓰지 않는다는 뜻이다. 그러면 git은 꺼진 터미널
            // 프롬프트로 물러나 즉시 실패한다 — `false` 바이너리에 기대지 않아도 된다.
            ("GIT_ASKPASS".into(), String::new()),
            ("LC_ALL".into(), "C".into()),
            ("LANG".into(), "C".into()),
            ("GIT_PAGER".into(), "cat".into()),
        ];
        if let Some(ceiling) = &self.ceiling {
            env.push(("GIT_CEILING_DIRECTORIES".into(), ceiling.clone()));
        }
        if write {
            env.push(("GIT_EDITOR".into(), "true".into()));
            env.push(("GIT_SEQUENCE_EDITOR".into(), "true".into()));
        } else {
            env.push(("GIT_OPTIONAL_LOCKS".into(), "0".into()));
        }
        env.extend(self.extra_env.iter().cloned());
        env.extend(extra.iter().cloned());
        env
    }

    fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
        write: bool,
    ) -> Result<CommandOutcome, CoreError> {
        self.run_with(args, input, timeout, write, &[])
    }

    fn run_with(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
        write: bool,
        extra: &[(String, String)],
    ) -> Result<CommandOutcome, CoreError> {
        let mut argv: Vec<&str> = GIT_BASE_ARGS.to_vec();
        argv.extend_from_slice(args);
        let mut env = self.env(write, extra);
        #[cfg(test)]
        record_call(&argv, input, &env, REMOVED_ENV);
        let outcome = run_capped_with(
            &self.executable,
            &argv,
            timeout,
            &CappedOptions {
                env: &env,
                env_remove: REMOVED_ENV,
                input,
                current_dir: Some(&self.root),
                strip_credential_env: true,
                own_process_group: true,
            },
        );
        // C16-11. 합친 사본에도 토큰 헤더가 있다. 호출부가 자기 목록을 지우는 것과 같이 지운다.
        if !extra.is_empty() {
            for (_, value) in env.iter_mut() {
                zeroize::Zeroize::zeroize(value);
            }
        }
        outcome
    }

    fn read(&self, args: &[&str], timeout: Duration) -> Result<CommandOutcome, CoreError> {
        self.run(args, None, timeout, false)
    }

    fn write(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<CommandOutcome, CoreError> {
        self.run(args, input, timeout, true)
    }

    /// C19 overlay 어댑터가 쓰는 읽기. 경로를 stdin으로 넘기므로 입력을 함께 받는다.
    pub(crate) fn overlay_read_with_input(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<CommandOutcome, CoreError> {
        self.run(args, input, timeout, false)
    }

    /// C19 overlay 어댑터가 쓰는 변경. `restore --source=HEAD --worktree` 한 갈래뿐이고,
    /// 부를 수 있는 자리는 patch 저장이 끝난 뒤의 `snapshot_patch_then_restore` 하나다.
    pub(crate) fn overlay_write_with_input(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<CommandOutcome, CoreError> {
        self.run(args, input, timeout, true)
    }

    /// overlay 영수증의 `head_before`/`head_after`(C19-5).
    pub(crate) fn overlay_head_sha(&self) -> Result<Option<String>, CoreError> {
        self.head_sha()
    }

    /// `HEAD`가 가리키는 커밋. 아직 커밋이 없으면 `None`.
    fn head_sha(&self) -> Result<Option<String>, CoreError> {
        let outcome = self.read(
            &["rev-parse", "-q", "--verify", "--end-of-options", "HEAD"],
            READ_TIMEOUT,
        )?;
        Ok(outcome
            .success
            .then(|| outcome.stdout.trim().to_owned())
            .filter(|sha| !sha.is_empty()))
    }

    fn head(&self) -> Result<GitHead, CoreError> {
        let symbolic = self.read(&["symbolic-ref", "-q", "--short", "HEAD"], READ_TIMEOUT)?;
        let branch = symbolic
            .success
            .then(|| symbolic.stdout.trim().to_owned())
            .filter(|name| !name.is_empty());
        let sha = self.head_sha()?;
        Ok(GitHead {
            detached: branch.is_none(),
            unborn: sha.is_none(),
            short_sha: sha.as_ref().map(|sha| sha.chars().take(7).collect()),
            sha,
            branch,
        })
    }

    fn remotes(&self) -> Result<Vec<GitRemote>, CoreError> {
        let names = self.remote_names()?;
        let urls = self.read(
            &["config", "--get-regexp", r"^remote\..*\.url$"],
            READ_TIMEOUT,
        )?;
        // 판정에 드는 앱 설정은 원격마다가 아니라 한 번만 읽는다. 읽지 못하면 그 수단이
        // 없는 것으로 보고 화면은 안내를 띄운다 — 개요 자체를 실패시킬 일은 아니다.
        let identity = self.has_network_identity();
        let token_hosts = self.token_hosts();
        names
            .into_iter()
            .enumerate()
            .map(|(index, name)| {
                let url = urls.stdout.lines().find_map(|line| {
                    let (key, value) = line.split_once(' ')?;
                    (key == format!("remote.{name}.url")).then(|| value.trim().to_owned())
                });
                // push가 실제로 쓸 주소(`pushurl`·`insteadOf` 반영). 원격이 아주 많으면 앞쪽만
                // 묻고 나머지는 설정의 url로 매긴다 — 판정은 안내이고 실행 경로는 따로 묻는다.
                let push_url = if index < MAX_AUTH_PROBED_REMOTES {
                    self.remote_url(&name, true)?.or_else(|| url.clone())
                } else {
                    url.clone()
                };
                let mut auth = self.remote_auth(push_url.as_deref(), identity, &token_hosts)?;
                let fetch_url = if index < MAX_AUTH_PROBED_REMOTES {
                    self.remote_url(&name, false)?.or_else(|| url.clone())
                } else {
                    url.clone()
                };
                auth.fetch_host = fetch_url
                    .as_deref()
                    .map(parse_remote_url)
                    .filter(|parsed| parsed.transport == GitRemoteTransport::Https)
                    .and_then(|parsed| parsed.host);
                Ok(GitRemote {
                    url: url.as_deref().map(redact_git_text),
                    name,
                    auth,
                })
            })
            .collect()
    }

    fn remote_names(&self) -> Result<Vec<String>, CoreError> {
        let names = self.read(&["remote"], READ_TIMEOUT)?;
        Ok(names
            .stdout
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// git이 그 원격에 실제로 쓸 주소. `insteadOf`·`pushurl`까지 git이 풀어 준다. 이름은
    /// `resolve_remote`·`git remote`에서 온 것만 받는다.
    fn remote_url(&self, remote: &str, push: bool) -> Result<Option<String>, CoreError> {
        let mut args = vec!["remote", "get-url"];
        if push {
            args.push("--push");
        }
        args.push(remote);
        let outcome = self.read(&args, READ_TIMEOUT)?;
        Ok(outcome
            .success
            .then(|| {
                outcome
                    .stdout
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_owned()
            })
            .filter(|url| !url.is_empty()))
    }

    /// C16-11. 이 프로젝트의 설정이 git 원격용으로 고른 (호스트, 저장된 비밀값 이름). 고른 값이
    /// 그새 지워졌으면 뺀다 — 쓸 수 없는 지정을 `token`으로 매기면 push가 열린 채 실패한다.
    /// 값은 읽지 않는다.
    fn token_hosts(&self) -> Vec<(String, String)> {
        #[cfg(test)]
        if let Some((host, _, _)) = TEST_GIT_TOKEN.with(|cell| cell.borrow().clone()) {
            return vec![(host, "TEST_GIT_TOKEN".to_owned())];
        }
        let Ok(names) = crate::saved_secrets::saved_secret_names(&self.app_data_dir) else {
            return Vec::new();
        };
        project_git_remote_bindings(&self.app_data_dir, &self.project_key)
            .unwrap_or_default()
            .into_iter()
            .filter(|binding| names.contains(&binding.secret_name))
            .map(|binding| (binding.host, binding.secret_name))
            .collect()
    }

    /// C16-11. 원격 하나의 인증 판정. 네트워크에 나가지 않는다.
    fn remote_auth(
        &self,
        url: Option<&str>,
        identity: bool,
        token_hosts: &[(String, String)],
    ) -> Result<GitRemoteAuth, CoreError> {
        let Some(url) = url else {
            return Ok(GitRemoteAuth {
                transport: GitRemoteTransport::Other,
                host: None,
                method: GitRemoteAuthMethod::Unknown,
                token_secret: None,
                fetch_host: None,
            });
        };
        let parsed = parse_remote_url(url);
        let mut auth = GitRemoteAuth {
            transport: parsed.transport,
            host: parsed.host.clone(),
            method: GitRemoteAuthMethod::Unknown,
            token_secret: None,
            fetch_host: None,
        };
        auth.method = match parsed.transport {
            GitRemoteTransport::Local => GitRemoteAuthMethod::NotNeeded,
            GitRemoteTransport::Other => GitRemoteAuthMethod::Unknown,
            GitRemoteTransport::Ssh if identity => GitRemoteAuthMethod::SshKey,
            GitRemoteTransport::Ssh => GitRemoteAuthMethod::SshDefault,
            GitRemoteTransport::Https | GitRemoteTransport::Http => {
                // 토큰은 HTTPS에만 싣는다. 평문 HTTP에 지정된 호스트가 있어도 쓰지 않는다.
                let token = (parsed.transport == GitRemoteTransport::Https)
                    .then(|| {
                        token_hosts
                            .iter()
                            .find(|(host, _)| Some(host) == parsed.host.as_ref())
                    })
                    .flatten();
                if let Some((_, name)) = token {
                    auth.token_secret = Some(name.clone());
                    GitRemoteAuthMethod::Token
                } else if parsed.has_password {
                    GitRemoteAuthMethod::UrlCredential
                } else if self.has_git_credentials(&parsed)? {
                    GitRemoteAuthMethod::CredentialHelper
                } else if parsed.transport == GitRemoteTransport::Http {
                    // 평문 HTTP는 인증 없이 받는 서버도 있어 "반드시 실패"라 할 수 없다.
                    GitRemoteAuthMethod::Unknown
                } else {
                    GitRemoteAuthMethod::None
                }
            }
        };
        Ok(auth)
    }

    /// git이 앱 없이도 스스로 쓰는 자격증명이 이 URL에 있는가 — `credential.helper`,
    /// 이미 설정된 `http.extraHeader`(CI 체크아웃이 남기는 것), curl이 늘 읽는 `~/.netrc`.
    /// 비밀번호는 argv에 싣지 않는다 — 사용자 이름만 남긴 주소와 사용자 정보를 뗀 주소로 묻는다
    /// (`credential.https://user@host.helper`처럼 사용자별로 적힌 helper도 맞추려고).
    fn has_git_credentials(&self, parsed: &ParsedRemoteUrl) -> Result<bool, CoreError> {
        let mut urls = vec![parsed.without_userinfo.as_str()];
        if let Some(with_user) = parsed.with_username.as_deref() {
            urls.push(with_user);
        }
        for url in urls {
            for key in ["credential.helper", "http.extraHeader"] {
                let outcome = self.read(&["config", "--get-urlmatch", key, url], READ_TIMEOUT)?;
                if outcome.success && !outcome.stdout.trim().is_empty() {
                    return Ok(true);
                }
            }
        }
        Ok(home_dir()
            .is_ok_and(|home| home.join(".netrc").is_file() || home.join("_netrc").is_file()))
    }

    /// 사용자가 준 ref가 이 저장소의 커밋을 가리키는지 git에게 묻는다.
    fn verify_commit_ref(&self, reference: &str) -> Result<(), CoreError> {
        validate_ref_text(reference)?;
        let spec = format!("{reference}^{{commit}}");
        let outcome = self.read(
            &["rev-parse", "-q", "--verify", "--end-of-options", &spec],
            READ_TIMEOUT,
        )?;
        if !outcome.success {
            return Err(CoreError::NotFound(format!(
                "저장소에서 '{reference}'를 찾을 수 없습니다"
            )));
        }
        Ok(())
    }

    /// 현재 브랜치의 업스트림(`origin/dev` 꼴). 없으면 `None`.
    fn upstream_short(&self) -> Result<Option<String>, CoreError> {
        let upstream = self.read(
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "--end-of-options",
                "@{upstream}",
            ],
            READ_TIMEOUT,
        )?;
        // `rev-parse`는 `--verify` 없이 부르면 **자기가 받은 플래그를 그대로 한 줄 찍는다.**
        // 그래서 여기 stdout은 "--end-of-options\norigin/main"이고, 통째로 trim하면 업스트림
        // 이름이 "--end-of-options\norigin/main"이 되어 어떤 원격 접두사와도 맞지 않는다
        // (2026-10-04 실측). 그 결과 push의 refspec이 `HEAD`로 떨어져 업스트림이 아니라
        // **로컬 브랜치 이름의 새 원격 브랜치**로 나갔다. `--end-of-options`는 C16-5대로
        // 남기고, 답은 마지막 줄에서 읽는다.
        Ok(upstream
            .success
            .then(|| {
                upstream
                    .stdout
                    .lines()
                    .map(str::trim)
                    .rfind(|line| !line.is_empty() && !line.starts_with('-'))
                    .unwrap_or_default()
                    .to_owned()
            })
            .filter(|name| !name.is_empty()))
    }

    /// 업스트림이 `remote`에 있을 때 그 원격 쪽 브랜치 이름. 다른 원격이거나 없으면 `None`.
    fn upstream_branch_on(&self, remote: &str) -> Result<Option<String>, CoreError> {
        Ok(self.upstream_short()?.and_then(|upstream| {
            upstream
                .strip_prefix(remote)
                .and_then(|rest| rest.strip_prefix('/'))
                .filter(|branch| !branch.is_empty())
                .map(str::to_owned)
        }))
    }

    fn resolve_remote(&self, requested: Option<&str>) -> Result<String, CoreError> {
        let names = self.remote_names()?;
        match requested.map(str::trim).filter(|name| !name.is_empty()) {
            Some(name) => {
                if names.iter().any(|known| known == name) {
                    Ok(name.to_owned())
                } else {
                    Err(CoreError::NotFound(format!(
                        "등록되지 않은 원격 이름입니다: {name}"
                    )))
                }
            }
            None => {
                // 현재 브랜치의 업스트림 원격이 첫째, 원격이 하나뿐이면 그것, 아니면 묻는다.
                if let Some(upstream) = self.upstream_short()? {
                    if let Some(remote) = names
                        .iter()
                        .find(|known| upstream.starts_with(&format!("{known}/")))
                    {
                        return Ok(remote.clone());
                    }
                }
                match names.as_slice() {
                    [only] => Ok(only.clone()),
                    [] => Err(CoreError::InvalidInput(
                        "이 저장소에는 등록된 원격이 없습니다".to_owned(),
                    )),
                    _ => Err(CoreError::InvalidInput(
                        "원격이 여러 개라 이름을 지정해야 합니다".to_owned(),
                    )),
                }
            }
        }
    }

    fn in_progress(&self) -> Option<GitInProgress> {
        in_progress_from_git_dir(&self.git_dir)
    }

    fn conflicted_files(&self) -> Result<Vec<String>, CoreError> {
        let outcome = self.read(
            &["diff", "--name-only", "--diff-filter=U", "-z"],
            READ_TIMEOUT,
        )?;
        Ok(outcome
            .stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// 변경 한 건을 돌리고 영수증으로 만든다. 전후 HEAD를 기록하고 결말을 분류한다.
    fn mutate(
        &self,
        action: &str,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<GitActionReceipt, CoreError> {
        let head_before = self.head_sha()?;
        let outcome = self.write(args, input, timeout)?;
        let head_after = self.head_sha()?;
        self.receipt(action, outcome, head_before, head_after)
    }

    /// 네트워크 작업이 쓸 신원. 시험은 홈을 갈아 끼울 수 없으므로 여기 한 자리만 덮어쓴다 —
    /// 덮어쓰지 않으면 제품 경로가 그대로 돈다.
    fn network_identity(
        &self,
    ) -> Result<Option<crate::ssh_endpoints::ProjectGitIdentity>, CoreError> {
        #[cfg(test)]
        if let Some(identity) = test_network_identity() {
            return Ok(Some(identity));
        }
        // 신원을 만들지 못한 이유는 대개 "켜 둔 키가 없다·실행 파일이 없다"라 git 기본값으로
        // 붙으면 된다. 저장된 키 암호를 꺼내지 못한 것(Conflict)만은 조용히 넘기지 않는다 —
        // 그대로 붙으면 엉뚱한 신원의 인증 실패만 남으므로 이유를 오류로 올린다.
        match crate::ssh_endpoints::project_git_identity(&self.app_data_dir) {
            Ok(identity) => Ok(identity),
            Err(error @ CoreError::Conflict(_)) => Err(error),
            Err(_) => Ok(None),
        }
    }

    /// C16-11. 개요의 판정용. "git 원격용" 키가 켜져 있는지만 본다 — 신원을 실제로 만들면 키
    /// 암호를 OS 보안 저장소에서 꺼내게 되는데, 개요는 화면을 새로 고칠 때마다 불린다.
    fn has_network_identity(&self) -> bool {
        #[cfg(test)]
        if test_network_identity().is_some() {
            return true;
        }
        crate::ssh_endpoints::project_git_key_enabled(&self.app_data_dir)
    }

    /// C16-10. 원격과 말을 주고받는 변경(fetch·pull·push) 하나. `mutate`와 다른 것은 둘뿐이다
    /// — 사용자가 "git 원격용"으로 켠 SSH 키가 있으면 그 신원을 `GIT_SSH_COMMAND`로 **이
    /// 호출에만** 얹고, 그 키 경로가 `ssh`의 경고를 타고 영수증에 묻어 나오지 않도록 지운다.
    /// 읽기와 로컬 변경은 이 경로를 지나지 않으므로 신원도 받지 않는다.
    ///
    /// C16-11. 그 원격이 HTTPS이고 호스트에 git 원격용 토큰이 지정돼 있으면 그 값을
    /// `http.<url>.extraHeader`로 **이 호출의 환경에만** 싣는다(`GIT_CONFIG_COUNT`·
    /// `GIT_CONFIG_KEY_n`·`GIT_CONFIG_VALUE_n`). argv·디스크·셸 어디에도 값이 없다.
    fn network_mutate(
        &self,
        action: &str,
        args: &[&str],
        timeout: Duration,
        remote: &str,
        push: bool,
    ) -> Result<GitActionReceipt, CoreError> {
        // 신원을 못 만들면 인증을 더하지 못할 뿐이므로 변경 자체를 막지 않는다. git은
        // 지금까지처럼 자기 기본값으로 붙고, 자격증명이 없으면 `authFailed`로 끝난다.
        // 켜 둔 키의 암호를 꺼내지 못한 경우만 예외다(`network_identity`).
        let identity = self.network_identity()?;
        let mut extra = identity
            .as_ref()
            .map(crate::ssh_endpoints::ProjectGitIdentity::env)
            .unwrap_or_default();
        let target = self
            .remote_url(remote, push)?
            .map(|url| parse_remote_url(&url));
        let https_host = target
            .as_ref()
            .filter(|target| target.transport == GitRemoteTransport::Https)
            .and_then(|target| target.host.clone());
        let token = https_host
            .as_deref()
            .and_then(|host| self.network_token(host));
        let header = match (&token, https_host.as_deref()) {
            (Some(token), Some(host)) => {
                if let Some(key) = self.local_tls_override(host)? {
                    return Err(CoreError::Conflict(format!(
                        "이 저장소의 설정(.git/config)이 {host}의 인증서 검증을 바꿔 두어({key}) git 원격용 토큰 {}을(를) 싣지 않았습니다. 그 설정을 지우거나 터미널에서 직접 인증하세요",
                        token.secret_name
                    )));
                }
                let hooks_dir = self.app_data_dir.join(EMPTY_HOOKS_DIR);
                std::fs::create_dir_all(&hooks_dir)?;
                Some(token_header_env(host, token, &hooks_dir, &mut extra))
            }
            _ => None,
        };
        let head_before = self.head_sha()?;
        let run = self.run_with(args, None, timeout, true, &extra);
        for (_, value) in extra.iter_mut() {
            zeroize::Zeroize::zeroize(value);
        }
        let mut outcome = run?;
        if let Some(identity) = &identity {
            redact_identity_path(&mut outcome, &identity.identity_path);
        }
        if let (Some(token), Some(header)) = (&token, &header) {
            redact_token(&mut outcome, token.value.as_str(), header.as_str());
        }
        let head_after = self.head_sha()?;
        let mut receipt = self.receipt(action, outcome, head_before, head_after)?;
        if receipt.outcome == GitOutcome::AuthFailed {
            receipt.message = auth_failed_message(
                target.as_ref().map(|target| target.transport),
                target.as_ref().and_then(|target| target.host.as_deref()),
                token.as_ref().map(|token| token.secret_name.as_str()),
                identity.is_some(),
            );
        }
        Ok(receipt)
    }

    /// C16-11. 저장소(또는 워크트리) 설정이 그 호스트의 인증서 묶음을 바꿔 두었으면 그 키.
    /// 명령 수준에서 "기본값으로 되돌리기"를 적을 수 없는 설정이라, 토큰을 싣기 전에 묻는다 —
    /// 저장소가 고른 CA로 가로채는 수신자에게 헤더가 풀린 채 가지 않게.
    fn local_tls_override(&self, host: &str) -> Result<Option<&'static str>, CoreError> {
        let url = format!("https://{host}/");
        for scope in ["--local", "--worktree"] {
            for key in ["http.sslCAInfo", "http.sslCAPath"] {
                let outcome = self.read(
                    &["config", scope, "--includes", "--get-urlmatch", key, &url],
                    READ_TIMEOUT,
                )?;
                if outcome.success && !outcome.stdout.trim().is_empty() {
                    return Ok(Some(key));
                }
            }
        }
        Ok(None)
    }

    /// C16-11. 이 프로젝트가 그 호스트에 쓰도록 고른 토큰. 꺼내지 못하면 인증을 더하지 못할
    /// 뿐 작업은 막지 않는다.
    fn network_token(&self, host: &str) -> Option<GitRemoteToken> {
        #[cfg(test)]
        if let Some(token) = test_git_token(host) {
            return token;
        }
        let binding = project_git_remote_bindings(&self.app_data_dir, &self.project_key)
            .ok()?
            .into_iter()
            .find(|binding| binding.host == host)?;
        let value =
            crate::saved_secrets::take_for_git_remote(&self.app_data_dir, &binding.secret_name)
                .ok()
                .flatten()?;
        Some(GitRemoteToken {
            secret_name: binding.secret_name,
            username: binding.username,
            value,
        })
    }

    fn receipt(
        &self,
        action: &str,
        outcome: CommandOutcome,
        head_before: Option<String>,
        head_after: Option<String>,
    ) -> Result<GitActionReceipt, CoreError> {
        let combined = format!("{}\n{}", outcome.stdout, outcome.stderr);
        let classified = if outcome.timed_out {
            GitOutcome::TimedOut
        } else if outcome.success {
            GitOutcome::Completed
        } else {
            classify_failure(&combined)
        };
        let conflicted_files = if classified == GitOutcome::Conflict {
            self.conflicted_files()?
        } else {
            Vec::new()
        };
        let blocked_files = if classified == GitOutcome::BlockedByLocalChanges {
            blocked_files_from_output(&combined)
        } else {
            Vec::new()
        };
        let truncated = outcome.stdout.len() >= MAX_CAPTURED_OUTPUT_BYTES
            || outcome.stderr.len() >= MAX_CAPTURED_OUTPUT_BYTES;
        Ok(GitActionReceipt {
            action: action.to_owned(),
            succeeded: classified == GitOutcome::Completed,
            message: outcome_message(classified, action, &outcome),
            outcome: classified,
            head_before,
            head_after,
            conflicted_files,
            blocked_files,
            dropped_stash_sha: None,
            stdout: redact_git_text(&outcome.stdout),
            stderr: redact_git_text(&outcome.stderr),
            truncated,
            timed_out: outcome.timed_out,
        })
    }
}

/// 실행 파일 경로별 git 버전. 화면 새로 고침 한 번이 조회 넷을 띄우는데 매번 `--version`을
/// 따로 묻던 것을, 같은 실행 파일이면 한 번만 묻고 재사용한다. 경로가 바뀌면(설치·교체)
/// 다시 묻는다.
fn git_version_for(runner: &GitRunner) -> Result<String, GitOpenFailure> {
    static VERSIONS: OnceLock<Mutex<Option<(PathBuf, String)>>> = OnceLock::new();
    let cache = VERSIONS.get_or_init(|| Mutex::new(None));
    if let Ok(cached) = cache.lock() {
        if let Some((path, version)) = cached.as_ref() {
            if *path == runner.executable {
                return Ok(version.clone());
            }
        }
    }
    let outcome = runner.read(&["--version"], READ_TIMEOUT)?;
    let Some((major, minor)) = parse_git_version(&outcome.stdout) else {
        return Err(GitOpenFailure::Unavailable(
            GitUnavailableReason::GitMissing,
            outcome.stderr.trim().to_owned(),
        ));
    };
    let version = outcome.stdout.trim().to_owned();
    if (major, minor) < MIN_GIT_VERSION {
        return Err(GitOpenFailure::Unavailable(
            GitUnavailableReason::GitTooOld,
            version,
        ));
    }
    if let Ok(mut cached) = cache.lock() {
        *cached = Some((runner.executable.clone(), version.clone()));
    }
    Ok(version)
}

/// 같은 저장소에 변경이 겹치지 않게 하는 표. 120초짜리 push 뒤에 커밋이 줄 서는 대신
/// `busy` 영수증으로 곧바로 돌아온다.
fn busy_repositories() -> &'static Mutex<BTreeSet<PathBuf>> {
    static BUSY: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
    BUSY.get_or_init(|| Mutex::new(BTreeSet::new()))
}

pub(crate) struct BusyGuard(PathBuf);

impl BusyGuard {
    pub(crate) fn acquire(root: &Path) -> Option<Self> {
        let mut busy = busy_repositories()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        busy.insert(root.to_path_buf())
            .then(|| Self(root.to_path_buf()))
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut busy) = busy_repositories().lock() {
            busy.remove(&self.0);
        }
    }
}

fn busy_receipt(action: &str, root: &GitRunner) -> GitActionReceipt {
    GitActionReceipt {
        action: action.to_owned(),
        succeeded: false,
        outcome: GitOutcome::Busy,
        message: format!(
            "{}에서 다른 git 변경이 진행 중입니다. 끝난 뒤 다시 시도하세요",
            root.root_string()
        ),
        head_before: None,
        head_after: None,
        conflicted_files: Vec::new(),
        blocked_files: Vec::new(),
        dropped_stash_sha: None,
        stdout: String::new(),
        stderr: String::new(),
        truncated: false,
        timed_out: false,
    }
}

// ---------------------------------------------------------------------------
// 공개 조회
// ---------------------------------------------------------------------------

/// 저장소 개요. 저장소를 열 수 없으면 오류 대신 이유를 실어 화면이 빈 카드를 그린다.
pub fn project_git_overview(
    app_data_dir: &Path,
    project_root: &Path,
) -> Result<GitOverview, CoreError> {
    let project_path = path_guard::child_facing(project_root)
        .to_string_lossy()
        .into_owned();
    let runner = match GitRunner::open(app_data_dir, project_root) {
        Ok(runner) => runner,
        Err(GitOpenFailure::Unavailable(reason, detail)) => {
            return Ok(GitOverview {
                project_path,
                repository: None,
                unavailable_reason: Some(reason),
                unavailable_detail: (!detail.is_empty()).then_some(detail),
            })
        }
        Err(GitOpenFailure::Error(error)) => return Err(error),
    };
    Ok(GitOverview {
        project_path,
        repository: Some(overview_with(&runner)?),
        unavailable_reason: None,
        unavailable_detail: None,
    })
}

fn overview_with(runner: &GitRunner) -> Result<GitRepositoryInfo, CoreError> {
    let head = runner.head()?;
    let count = format!("--count={MAX_BRANCHES}");
    let refs = runner.read(
        &[
            "for-each-ref",
            &count,
            "--sort=-committerdate",
            "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
        READ_TIMEOUT,
    )?;
    let (local_branches, remote_branches, branch_count) = parse_for_each_ref(&refs.stdout);
    let upstream = local_branches
        .iter()
        .find(|branch| branch.is_head)
        .and_then(|branch| {
            branch.upstream.as_ref().map(|name| GitUpstream {
                name: name.clone(),
                ahead: branch.ahead,
                behind: branch.behind,
                gone: branch.gone,
            })
        });
    let worktrees = runner.read(&["worktree", "list", "--porcelain"], READ_TIMEOUT)?;
    let stash_count = format!("-n{MAX_STASHES}");
    let stashes = runner.read(
        &[
            "stash",
            "list",
            "-z",
            &stash_count,
            "--format=%gd%x1f%H%x1f%ct%x1f%gs",
        ],
        READ_TIMEOUT,
    )?;
    let stashes = parse_stash_list(&stashes.stdout);
    Ok(GitRepositoryInfo {
        repository_root: runner.root_string(),
        git_dir: runner.git_dir.to_string_lossy().into_owned(),
        is_linked_worktree: std::fs::canonicalize(&runner.git_dir).ok()
            != std::fs::canonicalize(&runner.common_dir).ok(),
        head,
        upstream,
        local_branches,
        remote_branches,
        branches_truncated: branch_count >= MAX_BRANCHES,
        remotes: runner.remotes()?,
        worktrees: parse_worktree_list(&worktrees.stdout, &runner.root),
        in_progress: runner.in_progress(),
        stashes_truncated: stashes.len() >= MAX_STASHES,
        stashes,
        git_version: runner.version.clone(),
    })
}

pub fn project_git_status(
    app_data_dir: &Path,
    project_root: &Path,
    worktree_path: Option<&str>,
) -> Result<GitStatus, CoreError> {
    let runner = open_read_target(app_data_dir, project_root, worktree_path)?;
    status_with(&runner)
}

/// 읽기 대상 저장소를 연다. 워크트리를 고르면 그 경로가 프로젝트 저장소의 `git worktree list`
/// 에 있는 (bare 가 아닌) 워크트리일 때만 연다 — 등록하지 않은 임의 경로를 읽는 통로가 되면
/// 안 된다(G10).
fn open_read_target(
    app_data_dir: &Path,
    project_root: &Path,
    worktree_path: Option<&str>,
) -> Result<GitRunner, CoreError> {
    let runner = GitRunner::open(app_data_dir, project_root)?;
    let Some(requested) = worktree_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(runner);
    };
    let not_listed = || {
        CoreError::InvalidInput(format!(
            "이 프로젝트 저장소의 워크트리가 아닙니다: {requested}"
        ))
    };
    let requested_path = std::fs::canonicalize(requested).map_err(|_| not_listed())?;
    let listed = runner.read(&["worktree", "list", "--porcelain"], READ_TIMEOUT)?;
    let worktree = parse_worktree_list(&listed.stdout, &runner.root)
        .into_iter()
        .find(|worktree| {
            !worktree.bare
                && std::fs::canonicalize(&worktree.path).ok().as_ref() == Some(&requested_path)
        })
        .ok_or_else(not_listed)?;
    if worktree.is_current {
        return Ok(runner);
    }
    // 목록은 `.git/worktrees/*/gitdir` 에서 오므로 저장소에 쓸 수 있는 쪽이 다른 저장소를
    // 가리키게 바꿀 수 있다. 또 워크트리의 `.git` 파일이 지워지면 발견이 위로 올라가 프로젝트
    // 저장소를 워크트리라는 이름으로 연다. 연 결과가 요청한 그 폴더이고 같은 저장소를
    // 공유하는지까지 본다.
    let opened = GitRunner::open(app_data_dir, &requested_path)?;
    let same_root = std::fs::canonicalize(&opened.root).ok().as_ref() == Some(&requested_path);
    let same_repository = std::fs::canonicalize(&opened.common_dir).ok()
        == std::fs::canonicalize(&runner.common_dir).ok();
    if !same_root || !same_repository {
        return Err(not_listed());
    }
    Ok(opened)
}

fn status_with(runner: &GitRunner) -> Result<GitStatus, CoreError> {
    let outcome = runner.read(
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=normal",
        ],
        READ_TIMEOUT,
    )?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "git status 실패: {}",
            first_line(&outcome.stderr)
        )));
    }
    let parsed = parse_status_porcelain_v2(&outcome.stdout);
    let mut head = parsed.head;
    if head.sha.is_none() {
        head.unborn = true;
    }
    Ok(GitStatus {
        project_path: runner.root_string(),
        conflicted_count: parsed
            .entries
            .iter()
            .filter(|entry| entry.unmerged.is_some())
            .count(),
        staged_count: parsed
            .entries
            .iter()
            .filter(|entry| entry.index_status.is_change())
            .count(),
        unstaged_count: parsed
            .entries
            .iter()
            .filter(|entry| entry.worktree_status.is_change())
            .count(),
        untracked_count: parsed
            .entries
            .iter()
            .filter(|entry| entry.index_status == GitChangeKind::Untracked)
            .count(),
        head,
        upstream: parsed.upstream,
        entries: parsed.entries,
        truncated: parsed.truncated,
    })
}

pub fn project_git_diff(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitDiffRequest,
) -> Result<GitDiff, CoreError> {
    let runner = open_read_target(app_data_dir, project_root, request.worktree_path.as_deref())?;
    diff_with(&runner, request)
}

fn diff_with(runner: &GitRunner, request: &ProjectGitDiffRequest) -> Result<GitDiff, CoreError> {
    let path = validate_repo_path(&runner.root, &request.path)?;
    let original = request
        .original_path
        .as_deref()
        .map(|original| validate_repo_path(&runner.root, original))
        .transpose()?;
    let commit = request
        .commit
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let trimmed = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let range = match (trimmed(&request.range_from), trimmed(&request.range_to)) {
        (Some(from), Some(to)) => {
            // 한쪽만 온 요청을 반대쪽 기본값으로 메우지 않는다. 어느 끝점을 가정해도 호출자가
            // 믿는 범위와 다른 diff 가 열리고, 그것이 B9 가 없애려는 바로 그 거짓말이다.
            if commit.is_some() || request.staged {
                return Err(CoreError::InvalidInput(
                    "범위 비교는 staged·commit 과 함께 쓸 수 없습니다.".into(),
                ));
            }
            runner.verify_commit_ref(&from)?;
            runner.verify_commit_ref(&to)?;
            // 세 점이다. `range_files`(B8)가 세 점으로 목록을 뽑으므로 두 점으로 본문을 열면
            // 목록에 있는 파일과 본문이 어긋난다 — 수신 쪽에서는 내 커밋이 만든 파일이
            // '삭제'로 보인다.
            Some(format!("{from}...{to}"))
        }
        (None, None) => None,
        _ => {
            return Err(CoreError::InvalidInput(
                "범위 비교에는 rangeFrom 과 rangeTo 가 둘 다 필요합니다.".into(),
            ))
        }
    };
    let mut args: Vec<&str> = if range.is_some() {
        vec!["diff"]
    } else if let Some(commit) = commit {
        // `show`는 첫 커밋(부모 없음)과 병합 커밋(combined diff)을 모두 알아서 다룬다.
        runner.verify_commit_ref(commit)?;
        vec!["show", "--format="]
    } else if request.staged {
        vec!["diff", "--cached"]
    } else {
        vec!["diff"]
    };
    args.extend(["--no-ext-diff", "--no-color", "--no-textconv", "-M"]);
    if request.full_context {
        // 파일 본문을 별도로 이어 붙이면 줄 번호와 추가·삭제 위치를 다시 맞춰야 한다. Git이
        // 만든 unified diff의 문맥을 파일 전체로 넓혀 한 행 모델 안에서 원문과 변경을 함께
        // 보여 준다. 실제 응답 크기는 아래 MAX_CAPTURED_OUTPUT_BYTES가 계속 제한한다.
        args.push("--unified=2147483647");
    }
    args.push("--end-of-options");
    if let Some(range) = range.as_deref() {
        args.push(range);
    } else if let Some(commit) = commit {
        args.push(commit);
    }
    args.push("--");
    args.push(&path);
    if let Some(original) = original.as_deref() {
        args.push(original);
    }
    let outcome = runner.read(&args, READ_TIMEOUT)?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "git diff 실패: {}",
            first_line(&outcome.stderr)
        )));
    }
    let untracked =
        if request.staged || commit.is_some() || range.is_some() || !outcome.stdout.is_empty() {
            false
        } else {
            // 추적되지 않는 파일은 diff에 안 나온다. 본문은 프로젝트 파일 화면이 보여 준다.
            let listed = runner.read(
                &[
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    &path,
                ],
                READ_TIMEOUT,
            )?;
            // `status`는 추적되지 않는 폴더를 `docs/` 한 항목으로 내므로, 그 아래 파일이 하나라도
            // 나오면 폴더 자체가 추적되지 않는 것이다.
            let prefix = format!("{}/", path.trim_end_matches('/'));
            listed
                .stdout
                .split('\0')
                .any(|listed| listed == path || listed.starts_with(&prefix))
        };
    let kind = if untracked {
        GitDiffKind::Untracked
    } else if outcome.stdout.is_empty() {
        GitDiffKind::Empty
    } else if outcome
        .stdout
        .lines()
        .any(|line| line.starts_with("Binary files ") && line.ends_with(" differ"))
    {
        GitDiffKind::Binary
    } else {
        GitDiffKind::Text
    };
    let truncated = outcome.stdout.len() >= MAX_CAPTURED_OUTPUT_BYTES;
    let patch = if truncated {
        let cut = outcome.stdout.rfind('\n').unwrap_or(outcome.stdout.len());
        outcome.stdout[..cut].to_owned()
    } else {
        outcome.stdout
    };
    Ok(GitDiff {
        project_path: runner.root_string(),
        path,
        staged: request.staged,
        kind,
        patch,
        truncated,
    })
}

pub fn project_git_commit_files(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitCommitFilesRequest,
) -> Result<GitCommitFiles, CoreError> {
    let runner = GitRunner::open(app_data_dir, project_root)?;
    commit_files_with(&runner, &request.sha)
}

fn commit_files_with(runner: &GitRunner, sha: &str) -> Result<GitCommitFiles, CoreError> {
    let sha = sha.trim();
    runner.verify_commit_ref(sha)?;
    let outcome = runner.read(
        &[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "-M",
            "--end-of-options",
            sha,
            "--",
        ],
        READ_TIMEOUT,
    )?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "git show 실패: {}",
            first_line(&outcome.stderr)
        )));
    }
    let (files, truncated) = parse_name_status(&outcome.stdout);
    Ok(GitCommitFiles {
        project_path: runner.root_string(),
        sha: sha.to_owned(),
        files,
        truncated: truncated || outcome.stdout.len() >= MAX_CAPTURED_OUTPUT_BYTES,
    })
}

pub fn project_git_log(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitLogRequest,
) -> Result<GitLog, CoreError> {
    let runner = GitRunner::open(app_data_dir, project_root)?;
    log_with(&runner, request)
}

fn log_with(runner: &GitRunner, request: &ProjectGitLogRequest) -> Result<GitLog, CoreError> {
    let reference = request
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("HEAD")
        .to_owned();
    validate_ref_text(&reference)?;
    // 첫 커밋 전에는 `HEAD`가 어떤 커밋도 아니라 git이 "bad revision"으로 답한다. 빈 이력이
    // 맞는 답이다.
    if reference == "HEAD" && runner.head_sha()?.is_none() {
        return Ok(GitLog {
            project_path: runner.root_string(),
            reference,
            commits: Vec::new(),
            has_more: false,
        });
    }
    let limit = request
        .limit
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, MAX_LOG_LIMIT);
    let skip = request.skip.unwrap_or(0).min(MAX_LOG_SKIP);
    let count = (limit + 1).to_string();
    let skip_text = skip.to_string();
    let outcome = runner.read(
        &[
            "log",
            "-z",
            "--no-color",
            "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%D%x1f%s%x1f%b",
            "-n",
            &count,
            "--skip",
            &skip_text,
            "--end-of-options",
            &reference,
            "--",
        ],
        READ_TIMEOUT,
    )?;
    if !outcome.success {
        let stderr = outcome.stderr.to_lowercase();
        if stderr.contains("does not have any commits yet") {
            return Ok(GitLog {
                project_path: runner.root_string(),
                reference,
                commits: Vec::new(),
                has_more: false,
            });
        }
        if stderr.contains("unknown revision") || stderr.contains("bad revision") {
            return Err(CoreError::NotFound(format!(
                "저장소에서 '{reference}'를 찾을 수 없습니다"
            )));
        }
        return Err(CoreError::Runtime(format!(
            "git log 실패: {}",
            first_line(&outcome.stderr)
        )));
    }
    let mut commits = parse_log_records(&outcome.stdout);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(GitLog {
        project_path: runner.root_string(),
        reference,
        commits,
        has_more,
    })
}

/// 브랜치와 upstream의 차이를 방향으로 갈라 읽는다(B6, C16-7 읽기이므로 게이트 없음).
/// 네트워크를 쓰지 않는다 — 마지막 fetch가 가져다 놓은 원격 추적 ref만 본다.
pub fn get_project_branch_comparison(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitComparisonRequest,
) -> Result<GitBranchComparison, CoreError> {
    let runner = GitRunner::open(app_data_dir, project_root)?;
    branch_comparison_with(&runner, request)
}

fn branch_comparison_with(
    runner: &GitRunner,
    request: &ProjectGitComparisonRequest,
) -> Result<GitBranchComparison, CoreError> {
    let limit = request
        .limit
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, MAX_LOG_LIMIT);
    let last_fetched_at = last_fetch_time(runner);
    let empty = |branch: Option<String>, upstream: Option<String>| GitBranchComparison {
        project_path: runner.root_string(),
        branch,
        upstream,
        no_upstream: true,
        incoming: Vec::new(),
        outgoing: Vec::new(),
        incoming_count: 0,
        outgoing_count: 0,
        incoming_truncated: false,
        outgoing_truncated: false,
        incoming_files: Vec::new(),
        outgoing_files: Vec::new(),
        incoming_files_truncated: false,
        outgoing_files_truncated: false,
        diverged: false,
        last_fetched_at,
    };

    let branch = match request
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(name) => {
            validate_branch_name(name)?;
            name.to_owned()
        }
        // detached HEAD나 첫 커밋 전에는 비교할 브랜치가 없다. 오류가 아니라 빈 비교다.
        None => match runner.head()?.branch {
            Some(name) => name,
            None => return Ok(empty(None, None)),
        },
    };

    let upstream = match request
        .upstream
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(name) => {
            validate_ref_text(name)?;
            name.to_owned()
        }
        None => match configured_upstream(runner, &branch)? {
            Some(name) => name,
            None => return Ok(empty(Some(branch), None)),
        },
    };

    // 양쪽 모두 커밋을 가리켜야 범위를 물을 수 있다. upstream이 gone이면 여기서 걸린다(C16-5).
    if !ref_is_commit(runner, &branch)? {
        return Ok(empty(Some(branch), Some(upstream)));
    }
    if !ref_is_commit(runner, &upstream)? {
        return Ok(empty(Some(branch), Some(upstream)));
    }

    let (incoming_count, outgoing_count) = left_right_counts(runner, &branch, &upstream)?;
    let incoming = range_commits(runner, &branch, &upstream, limit)?;
    let outgoing = range_commits(runner, &upstream, &branch, limit)?;
    let (incoming_files, incoming_files_truncated) = range_files(runner, &branch, &upstream)?;
    let (outgoing_files, outgoing_files_truncated) = range_files(runner, &upstream, &branch)?;
    Ok(GitBranchComparison {
        project_path: runner.root_string(),
        branch: Some(branch),
        upstream: Some(upstream),
        no_upstream: false,
        incoming_truncated: incoming_count as usize > incoming.len(),
        outgoing_truncated: outgoing_count as usize > outgoing.len(),
        diverged: incoming_count > 0 && outgoing_count > 0,
        incoming,
        outgoing,
        incoming_count,
        outgoing_count,
        incoming_files,
        outgoing_files,
        incoming_files_truncated,
        outgoing_files_truncated,
        last_fetched_at,
    })
}

/// B8. 한 방향이 합쳐서 바꾸는 파일 목록. 커밋 목록을 뽑는 `range_commits`가 `from..to`를 쓰는
/// 것과 달리 여기서는 **세 점**(`from...to`)을 쓴다. `git diff from..to`는 두 끝점을 그냥 비교해
/// 반대편에만 있는 변경까지 뒤집어 싣는데, 수신 요약이 답해야 하는 것은 "받으면 무엇이 바뀌는가"
/// 즉 merge-base부터 `to`까지이고 그것이 커밋 목록과 같은 범위다.
///
/// 상태 해석은 커밋 파일 목록과 같은 `parse_name_status`를 그대로 쓴다. 두 자리가 따로 파싱하면
/// rename(`R100` + 경로 둘) 한 자리만 고쳐져 한쪽 화면에서만 경로가 밀린다.
fn range_files(
    runner: &GitRunner,
    from: &str,
    to: &str,
) -> Result<(Vec<GitCommitFile>, bool), CoreError> {
    let range = format!("{from}...{to}");
    let outcome = runner.read(
        &[
            "diff",
            "--name-status",
            "-z",
            "-M",
            "--end-of-options",
            &range,
            "--",
        ],
        READ_TIMEOUT,
    )?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "git diff 실패: {}",
            first_line(&outcome.stderr)
        )));
    }
    let (files, truncated) = parse_name_status(&outcome.stdout);
    Ok((
        files,
        truncated || outcome.stdout.len() >= MAX_CAPTURED_OUTPUT_BYTES,
    ))
}

/// `branch.<name>.remote` + `merge`가 아니라 `for-each-ref`에 묻는다. 두 설정을 손으로 합치면
/// `remote = .`(로컬 추적)와 refspec 변형에서 어긋난다.
fn configured_upstream(runner: &GitRunner, branch: &str) -> Result<Option<String>, CoreError> {
    let reference = format!("refs/heads/{branch}");
    let outcome = runner.read(
        &[
            "for-each-ref",
            "--format=%(upstream:short)",
            "--end-of-options",
            &reference,
        ],
        READ_TIMEOUT,
    )?;
    if !outcome.success {
        return Ok(None);
    }
    Ok(outcome
        .stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned))
}

fn ref_is_commit(runner: &GitRunner, reference: &str) -> Result<bool, CoreError> {
    let spec = format!("{reference}^{{commit}}");
    let outcome = runner.read(
        &["rev-parse", "-q", "--verify", "--end-of-options", &spec],
        READ_TIMEOUT,
    )?;
    Ok(outcome.success)
}

/// `rev-list --count --left-right A...B`는 한 번의 호출로 양쪽 수를 준다. 두 번 세면 그 사이에
/// 다른 명령이 ref를 옮겨 둘이 다른 시점을 말할 수 있다.
fn left_right_counts(
    runner: &GitRunner,
    branch: &str,
    upstream: &str,
) -> Result<(u32, u32), CoreError> {
    let range = format!("{branch}...{upstream}");
    let outcome = runner.read(
        &[
            "rev-list",
            "--count",
            "--left-right",
            "--end-of-options",
            &range,
            "--",
        ],
        READ_TIMEOUT,
    )?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "git rev-list 실패: {}",
            first_line(&outcome.stderr)
        )));
    }
    let mut fields = outcome.stdout.split_whitespace();
    // 왼쪽이 branch에만 있는 수(= 보낼 것), 오른쪽이 upstream에만 있는 수(= 받을 것)다.
    let outgoing = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let incoming = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok((incoming, outgoing))
}

/// `from..to` — `to`에는 있고 `from`에는 없는 커밋. `..`은 여기서만 만들어지고, 양쪽은 이미
/// 검증을 지난 값이라 사용자 입력이 범위 문법으로 새지 않는다(C16-5).
fn range_commits(
    runner: &GitRunner,
    from: &str,
    to: &str,
    limit: usize,
) -> Result<Vec<GitCommit>, CoreError> {
    let range = format!("{from}..{to}");
    let count = limit.to_string();
    let outcome = runner.read(
        &[
            "log",
            "-z",
            "--no-color",
            "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%D%x1f%s%x1f%b",
            "-n",
            &count,
            "--end-of-options",
            &range,
            "--",
        ],
        READ_TIMEOUT,
    )?;
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "git log 실패: {}",
            first_line(&outcome.stderr)
        )));
    }
    Ok(parse_log_records(&outcome.stdout))
}

/// 마지막 fetch 시각. `FETCH_HEAD`는 fetch가 매번 다시 쓰는 파일이라 그 mtime이 가장 가까운
/// 답이다. 없으면(한 번도 fetch하지 않았으면) null이다.
fn last_fetch_time(runner: &GitRunner) -> Option<i64> {
    let candidates = [
        runner.common_dir.join("FETCH_HEAD"),
        runner.git_dir.join("FETCH_HEAD"),
    ];
    candidates
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .filter_map(|meta| meta.modified().ok())
        .filter_map(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs() as i64)
        .max()
}

// ---------------------------------------------------------------------------
// 브랜치 팔로우(B3)
// ---------------------------------------------------------------------------

const BRANCH_FOLLOWS_VERSION: u32 = 1;

/// 팔로우는 저장소가 아니라 **이 기기의 선택**이므로 앱 데이터에만 둔다(G7). git config나
/// `.git` 안에 적으면 저장소를 공유하는 모든 사람·모든 워크트리가 같은 목록을 보게 되고,
/// 그것은 C16이 읽기 전용으로 두기로 한 사용자 소유 상태를 쓰는 일이기도 하다.
///
/// 즐겨찾기(세션 메타의 `favorite`)와 **다른 파일**에 둔다. 둘은 수명도 주체도 다르다 —
/// 즐겨찾기는 사용자가 목록에서 위로 올리려는 표시이고, 팔로우는 "이 브랜치의 수신/송신을
/// 계속 재라"는 지시라 프로젝트와 브랜치 이름에 매여 있다. 한 파일에 섞으면 브랜치가
/// 사라졌을 때 어느 쪽을 지워야 하는지가 한 자리에서 갈라지지 않는다.
const BRANCH_FOLLOWS_STORE: JsonStore = JsonStore {
    file: "project-branch-follows-v1.json",
    lock_file: "project-branch-follows-v1.lock",
    label: "프로젝트 브랜치 팔로우 저장소",
    version: BRANCH_FOLLOWS_VERSION,
};

/// 저장할 수 있는 팔로우 수 상한. 레인 워크트리를 많이 쓰는 저장소 여럿을 담고도 남으면서,
/// 조회마다 읽는 파일이 무한정 자라지 않게 한다.
const MAX_BRANCH_FOLLOWS: usize = 500;

/// 사용자가 계속 지켜보겠다고 표시한 브랜치 하나. 저장본과 화면 표시가 같은 모양이다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBranchFollow {
    /// 등록 프로젝트 경로. 저장소 최상위가 아니라 사용자가 고른 프로젝트 기준이다 —
    /// 화면이 프로젝트 단위로 묻기 때문이다.
    pub project_path: String,
    pub branch: String,
    /// 표시한 시각(epoch 초). 목록 정렬과 "언제부터 보고 있었나"에만 쓰는 비밀 아닌 값이다.
    pub followed_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBranchFollows {
    pub schema_version: u32,
    pub project_path: String,
    /// 이 프로젝트의 팔로우만. 다른 프로젝트의 선택은 화면에 실리지 않는다.
    pub follows: Vec<ProjectBranchFollow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectBranchFollowRequest {
    pub project_path: String,
    pub branch: String,
    /// 참이면 추가(이미 있으면 그대로), 거짓이면 제거. 토글이 아니라 상태를 보내게 해서
    /// 두 화면이 같은 순간에 눌러도 결과가 뒤집히지 않는다.
    pub follow: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchFollowStore {
    schema_version: u32,
    #[serde(default)]
    follows: Vec<ProjectBranchFollow>,
}

impl Default for BranchFollowStore {
    fn default() -> Self {
        Self {
            schema_version: BRANCH_FOLLOWS_VERSION,
            follows: Vec::new(),
        }
    }
}

impl SchemaVersioned for BranchFollowStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

fn follow_key(project_root: &Path) -> String {
    project_root.to_string_lossy().into_owned()
}

fn project_follows(store: BranchFollowStore, key: &str) -> Vec<ProjectBranchFollow> {
    let mut follows: Vec<ProjectBranchFollow> = store
        .follows
        .into_iter()
        .filter(|entry| entry.project_path == key)
        .collect();
    follows.sort_by(|a, b| a.branch.cmp(&b.branch));
    follows
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// 이 프로젝트에서 팔로우 중인 브랜치. 조회라 git을 띄우지 않는다 — 저장본만 읽으므로
/// 저장소가 잠겨 있거나 git이 없어도 화면이 표시를 잃지 않는다.
pub fn list_project_branch_follows(
    app_data_dir: &Path,
    project_root: &Path,
) -> Result<ProjectBranchFollows, CoreError> {
    let key = follow_key(project_root);
    let store: BranchFollowStore = BRANCH_FOLLOWS_STORE.read(app_data_dir)?;
    Ok(ProjectBranchFollows {
        schema_version: BRANCH_FOLLOWS_VERSION,
        follows: project_follows(store, &key),
        project_path: key,
    })
}

/// 팔로우를 켜거나 끈다. 브랜치 이름은 git에 넘기지 않더라도 저장 전에 검증한다 —
/// 저장본에 들어간 이름은 다음 조회에서 `get_project_branch_comparison`의 인자가 되고,
/// 그때 거절하면 화면에 지울 수 없는 줄이 남는다(C16-5와 같은 이유).
pub fn set_project_branch_follow(
    app_data_dir: &Path,
    project_root: &Path,
    request: &SetProjectBranchFollowRequest,
) -> Result<ProjectBranchFollows, CoreError> {
    let branch = request.branch.trim().to_owned();
    validate_branch_name(&branch)?;
    let key = follow_key(project_root);
    let store: BranchFollowStore =
        BRANCH_FOLLOWS_STORE.update(app_data_dir, |store: &mut BranchFollowStore| {
            let existing = store
                .follows
                .iter()
                .position(|entry| entry.project_path == key && entry.branch == branch);
            match (request.follow, existing) {
                (true, Some(_)) | (false, None) => Ok(false),
                (true, None) => {
                    if store.follows.len() >= MAX_BRANCH_FOLLOWS {
                        return Err(CoreError::InvalidInput(format!(
                            "팔로우는 최대 {MAX_BRANCH_FOLLOWS}개까지 저장할 수 있습니다"
                        )));
                    }
                    store.follows.push(ProjectBranchFollow {
                        project_path: key.clone(),
                        branch: branch.clone(),
                        followed_at: now_seconds(),
                    });
                    Ok(true)
                }
                (false, Some(index)) => {
                    store.follows.remove(index);
                    Ok(true)
                }
            }
        })?;
    Ok(ProjectBranchFollows {
        schema_version: BRANCH_FOLLOWS_VERSION,
        follows: project_follows(store, &key),
        project_path: key,
    })
}

// ---------------------------------------------------------------------------
// git 원격 인증 — 프로젝트별 토큰 지정(C16-11)
// ---------------------------------------------------------------------------

const GIT_REMOTE_TOKENS_VERSION: u32 = 1;

/// 프로젝트마다 "이 호스트의 HTTPS 원격에는 저장된 비밀값 X를 쓴다"는 선택. 값은 저장소 →
/// 비밀정보(C17)에 있고 여기에는 **이름만** 남는다(G7). 팔로우와 같은 이유로 git config가
/// 아니라 앱 데이터에 둔다 — 저장소를 공유하는 사람·워크트리가 이 기기의 선택을 보지 않게.
///
/// 지정을 저장된 비밀값 쪽이 아니라 프로젝트 쪽에 두는 것은 사용자 결정이다(2026-10-20). 값
/// 하나를 여러 프로젝트가 쓰거나, 같은 `github.com`이라도 프로젝트마다 다른 토큰(조직별 PAT,
/// 배포용 fine-grained 토큰)을 쓰는 것이 흔하고, 그 선택은 프로젝트를 보는 자리에서 내린다.
const GIT_REMOTE_TOKENS_STORE: JsonStore = JsonStore {
    file: "project-git-remote-tokens-v1.json",
    lock_file: "project-git-remote-tokens-v1.lock",
    label: "프로젝트 git 원격 인증 저장소",
    version: GIT_REMOTE_TOKENS_VERSION,
};

/// 저장할 수 있는 지정 수 상한. 프로젝트 수백 개에 원격 호스트 몇 개씩을 담고도 남는다.
const MAX_GIT_REMOTE_TOKENS: usize = 500;

/// 사용자 이름을 비워 두면 쓰는 값. GitHub·Gitea 토큰은 이름을 보지 않는다.
pub const DEFAULT_GIT_REMOTE_USERNAME: &str = "x-access-token";

/// 호스트 이름 상한(DNS 이름 253자 + `:65535`).
const MAX_GIT_HOST_LEN: usize = 259;
const MAX_GIT_USERNAME_LEN: usize = 128;

/// C16-11. git 원격 하나에 실을 토큰. `Debug`는 값을 가린다.
pub(crate) struct GitRemoteToken {
    pub(crate) secret_name: String,
    pub(crate) username: String,
    pub(crate) value: zeroize::Zeroizing<String>,
}

impl std::fmt::Debug for GitRemoteToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitRemoteToken")
            .field("secret_name", &self.secret_name)
            .field("username", &self.username)
            .field("value", &"<redacted>")
            .finish()
    }
}

/// 저장본 한 줄. 한 프로젝트·한 호스트에 값 하나다 — 둘이면 어느 값으로 인증했는지 영수증이
/// 말할 수 없다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProjectGitRemoteBinding {
    project_path: String,
    /// 소문자 호스트, 필요하면 `:포트`까지([`normalize_git_host`]). 원격 URL의 호스트와 글자
    /// 그대로 비교한다. 호스트까지 묶는 것은 원격 주소가 다른 호스트로 바뀌었을 때 토큰이
    /// 따라가지 않게 하기 위해서다.
    host: String,
    secret_name: String,
    /// HTTP Basic 인증의 사용자 이름.
    username: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitRemoteTokenStore {
    schema_version: u32,
    #[serde(default)]
    bindings: Vec<ProjectGitRemoteBinding>,
}

impl Default for GitRemoteTokenStore {
    fn default() -> Self {
        Self {
            schema_version: GIT_REMOTE_TOKENS_VERSION,
            bindings: Vec::new(),
        }
    }
}

impl SchemaVersioned for GitRemoteTokenStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

/// 화면에 실리는 지정 한 줄. 값은 없다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitRemoteTokenView {
    pub host: String,
    pub secret_name: String,
    pub username: String,
    pub updated_at: i64,
    /// 고른 값이 저장소 → 비밀정보에 아직 있는가. 지워졌으면 이 지정은 쓰이지 않는다.
    pub secret_exists: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitRemoteTokens {
    pub schema_version: u32,
    pub project_path: String,
    /// 이 프로젝트의 지정만. 다른 프로젝트의 선택은 실리지 않는다.
    pub tokens: Vec<ProjectGitRemoteTokenView>,
    /// 고를 수 있는 저장된 비밀값 이름. 값은 실리지 않는다.
    pub secret_names: Vec<String>,
    pub default_username: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectGitRemoteTokenRequest {
    pub project_path: String,
    pub host: String,
    /// 비우거나 빼면 그 호스트의 지정을 해제한다.
    #[serde(default)]
    pub secret_name: Option<String>,
    /// 비우면 [`DEFAULT_GIT_REMOTE_USERNAME`].
    #[serde(default)]
    pub username: Option<String>,
}

/// C16-11. 호스트 표기를 원격 URL과 비교할 모양으로 다듬는다. 스킴·경로·사용자 정보가 붙은
/// 값은 URL을 통째로 붙여 넣은 것이므로 고쳐 쓰지 않고 거절한다 — 조용히 잘라 내면 사용자가
/// 고른 것과 다른 호스트에 토큰이 묶인다.
fn normalize_git_host(raw: &str) -> Result<String, CoreError> {
    let host = raw.trim().to_ascii_lowercase();
    let host = host.strip_suffix(":443").unwrap_or(&host).to_owned();
    let refuse = |why: &str| {
        Err(CoreError::InvalidInput(format!(
            "git 원격 호스트는 github.com 같은 호스트 이름만 적습니다({why})"
        )))
    };
    if host.is_empty() {
        return refuse("비어 있음");
    }
    if host.len() > MAX_GIT_HOST_LEN {
        return refuse("너무 김");
    }
    if host.contains("://") || host.contains('/') || host.contains('@') {
        return refuse("주소 전체가 아니라 호스트만");
    }
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host.as_str(), None),
    };
    if let Some(port) = port {
        if !port.parse::<u16>().is_ok_and(|port| port > 0) {
            return refuse("포트는 1~65535");
        }
    }
    let label_ok = |label: &str| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    };
    if !name.split('.').all(label_ok) {
        return refuse("영문·숫자·하이픈·점만");
    }
    Ok(host)
}

/// Basic 인증은 첫 `:`에서 이름과 값을 가르므로 이름에 `:`이 있으면 값이 잘린다.
fn normalize_git_username(raw: Option<&str>) -> Result<String, CoreError> {
    let username = raw.map(str::trim).unwrap_or_default();
    if username.is_empty() {
        return Ok(DEFAULT_GIT_REMOTE_USERNAME.to_owned());
    }
    if username.len() > MAX_GIT_USERNAME_LEN
        || username
            .chars()
            .any(|ch| ch == ':' || ch.is_whitespace() || ch.is_control())
    {
        return Err(CoreError::InvalidInput(format!(
            "git 사용자 이름은 공백·콜론 없이 {MAX_GIT_USERNAME_LEN}자까지입니다"
        )));
    }
    Ok(username.to_owned())
}

/// 이 프로젝트의 지정. 값도 저장된 비밀값 목록도 읽지 않는다.
fn project_git_remote_bindings(
    app_data_dir: &Path,
    key: &str,
) -> Result<Vec<ProjectGitRemoteBinding>, CoreError> {
    let store: GitRemoteTokenStore = GIT_REMOTE_TOKENS_STORE.read(app_data_dir)?;
    Ok(store
        .bindings
        .into_iter()
        .filter(|binding| binding.project_path == key)
        .collect())
}

fn project_git_remote_tokens(
    app_data_dir: &Path,
    key: String,
    store: GitRemoteTokenStore,
) -> Result<ProjectGitRemoteTokens, CoreError> {
    let mut secret_names = crate::saved_secrets::saved_secret_names(app_data_dir)?;
    secret_names.sort();
    let mut tokens: Vec<ProjectGitRemoteTokenView> = store
        .bindings
        .into_iter()
        .filter(|binding| binding.project_path == key)
        .map(|binding| ProjectGitRemoteTokenView {
            secret_exists: secret_names.contains(&binding.secret_name),
            host: binding.host,
            secret_name: binding.secret_name,
            username: binding.username,
            updated_at: binding.updated_at,
        })
        .collect();
    tokens.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(ProjectGitRemoteTokens {
        schema_version: GIT_REMOTE_TOKENS_VERSION,
        project_path: key,
        tokens,
        secret_names,
        default_username: DEFAULT_GIT_REMOTE_USERNAME.to_owned(),
    })
}

/// C16-11. 이 프로젝트가 호스트마다 고른 git 원격용 토큰과, 고를 수 있는 저장된 비밀값 이름.
/// git을 띄우지 않고 값도 읽지 않는다.
pub fn list_project_git_remote_tokens(
    app_data_dir: &Path,
    project_root: &Path,
) -> Result<ProjectGitRemoteTokens, CoreError> {
    let store: GitRemoteTokenStore = GIT_REMOTE_TOKENS_STORE.read(app_data_dir)?;
    project_git_remote_tokens(app_data_dir, follow_key(project_root), store)
}

/// C16-11. 이 프로젝트의 한 호스트에 저장된 비밀값 하나를 고르거나(`secretName`) 해제한다.
/// 값에는 손대지 않는다. 고르는 이름은 저장소 → 비밀정보에 지금 있는 것만 받는다 — 없는
/// 이름을 받아 두면 push가 열린 채 인증 없이 나간다.
pub fn set_project_git_remote_token(
    app_data_dir: &Path,
    project_root: &Path,
    request: &SetProjectGitRemoteTokenRequest,
) -> Result<ProjectGitRemoteTokens, CoreError> {
    let host = normalize_git_host(&request.host)?;
    let secret_name = request
        .secret_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    let username = normalize_git_username(request.username.as_deref())?;
    if let Some(name) = &secret_name {
        if !crate::saved_secrets::saved_secret_names(app_data_dir)?.contains(name) {
            return Err(CoreError::NotFound(format!(
                "저장된 비밀값 {name}이(가) 없습니다. 저장소 → 비밀정보에서 먼저 저장하세요"
            )));
        }
    }
    let key = follow_key(project_root);
    let store: GitRemoteTokenStore =
        GIT_REMOTE_TOKENS_STORE.update(app_data_dir, |store: &mut GitRemoteTokenStore| {
            let existing = store
                .bindings
                .iter()
                .position(|binding| binding.project_path == key && binding.host == host);
            match (secret_name.as_ref(), existing) {
                (None, None) => Ok(false),
                (None, Some(index)) => {
                    store.bindings.remove(index);
                    Ok(true)
                }
                (Some(name), Some(index)) => {
                    let binding = &mut store.bindings[index];
                    if binding.secret_name == *name && binding.username == username {
                        return Ok(false);
                    }
                    binding.secret_name = name.clone();
                    binding.username = username.clone();
                    binding.updated_at = now_seconds();
                    Ok(true)
                }
                (Some(name), None) => {
                    if store.bindings.len() >= MAX_GIT_REMOTE_TOKENS {
                        return Err(CoreError::InvalidInput(format!(
                            "git 원격 인증 지정은 최대 {MAX_GIT_REMOTE_TOKENS}개까지 저장할 수 있습니다"
                        )));
                    }
                    store.bindings.push(ProjectGitRemoteBinding {
                        project_path: key.clone(),
                        host: host.clone(),
                        secret_name: name.clone(),
                        username: username.clone(),
                        updated_at: now_seconds(),
                    });
                    Ok(true)
                }
            }
        })?;
    project_git_remote_tokens(app_data_dir, key, store)
}

// ---------------------------------------------------------------------------
// 공개 변경
// ---------------------------------------------------------------------------

/// 변경 공개 함수가 공유하는 뼈대: 저장소를 열고, 겹침을 막고, 본체를 돌린다.
fn mutate_project(
    app_data_dir: &Path,
    project_root: &Path,
    action: &str,
    body: impl FnOnce(&GitRunner) -> Result<GitActionReceipt, CoreError>,
) -> Result<GitActionReceipt, CoreError> {
    let runner = GitRunner::open(app_data_dir, project_root)?;
    let Some(_guard) = BusyGuard::acquire(&runner.root) else {
        return Ok(busy_receipt(action, &runner));
    };
    body(&runner)
}

pub fn stage_project_git_paths(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitPathsRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "stage", |runner| {
        stage_with(runner, &request.paths)
    })
}

fn stage_with(runner: &GitRunner, paths: &[String]) -> Result<GitActionReceipt, CoreError> {
    let payload = pathspec_payload(&runner.root, paths)?;
    runner.mutate(
        "stage",
        &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
        Some(&payload),
        LOCAL_MUTATION_TIMEOUT,
    )
}

pub fn unstage_project_git_paths(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitPathsRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "unstage", |runner| {
        unstage_with(runner, &request.paths)
    })
}

fn unstage_with(runner: &GitRunner, paths: &[String]) -> Result<GitActionReceipt, CoreError> {
    let payload = pathspec_payload(&runner.root, paths)?;
    // `restore --staged`는 HEAD를 원본으로 삼는다. 첫 커밋 전에는 HEAD가 없어 인덱스에서
    // 빼는 것으로 같은 뜻을 낸다.
    let args: &[&str] = if runner.head_sha()?.is_some() {
        &[
            "restore",
            "--staged",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]
    } else {
        &[
            "rm",
            "-r",
            "-q",
            "--cached",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]
    };
    runner.mutate("unstage", args, Some(&payload), LOCAL_MUTATION_TIMEOUT)
}

pub fn commit_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitCommitRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "commit", |runner| {
        commit_with(runner, &request.message)
    })
}

fn commit_with(runner: &GitRunner, message: &str) -> Result<GitActionReceipt, CoreError> {
    let message = validate_commit_message(message)?;
    runner.mutate(
        "commit",
        &["commit", "-F", "-", "--no-edit", "--no-status"],
        Some(message.as_bytes()),
        LOCAL_MUTATION_TIMEOUT,
    )
}

pub fn switch_project_git_branch(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitSwitchRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "switch", |runner| {
        switch_with(runner, request)
    })
}

fn switch_with(
    runner: &GitRunner,
    request: &ProjectGitSwitchRequest,
) -> Result<GitActionReceipt, CoreError> {
    let branch = request.branch.trim();
    validate_branch_name(branch)?;
    let check = runner.read(&["check-ref-format", "--branch", branch], READ_TIMEOUT)?;
    if !check.success {
        return Err(CoreError::InvalidInput(format!(
            "브랜치 이름으로 쓸 수 없습니다: {branch}"
        )));
    }
    if runner.in_progress().is_some() {
        return Err(CoreError::Conflict(
            "리베이스나 병합이 진행 중이라 브랜치를 바꿀 수 없습니다. 먼저 끝내거나 중단하세요"
                .to_owned(),
        ));
    }
    let start_point = request
        .start_point
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut args: Vec<&str> = vec!["switch", "--no-guess"];
    if request.create {
        args.push("-c");
        args.push(branch);
        if let Some(start) = start_point {
            runner.verify_commit_ref(start)?;
            args.push(start);
        }
    } else {
        if start_point.is_some() {
            return Err(CoreError::InvalidInput(
                "시작점은 새 브랜치를 만들 때만 지정합니다".to_owned(),
            ));
        }
        args.push(branch);
    }
    runner.mutate("switch", &args, None, LOCAL_MUTATION_TIMEOUT)
}

pub fn stash_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitStashRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "stash", |runner| {
        stash_with(runner, request)
    })
}

fn stash_with(
    runner: &GitRunner,
    request: &ProjectGitStashRequest,
) -> Result<GitActionReceipt, CoreError> {
    match request.action {
        GitStashAction::Push => {
            let message = request
                .message
                .as_deref()
                .map(validate_stash_message)
                .transpose()?;
            let mut args: Vec<&str> = vec!["stash", "push"];
            if request.include_untracked {
                args.push("--include-untracked");
            }
            if let Some(message) = message.as_deref() {
                args.push("-m");
                args.push(message);
            }
            let mut receipt = runner.mutate("stash push", &args, None, LOCAL_MUTATION_TIMEOUT)?;
            if receipt.succeeded && receipt.stdout.contains("No local changes to save") {
                receipt.outcome = GitOutcome::NothingToCommit;
                receipt.succeeded = false;
                receipt.message = "보관할 로컬 변경이 없습니다".to_owned();
            }
            Ok(receipt)
        }
        GitStashAction::Pop | GitStashAction::Apply | GitStashAction::Drop => {
            let index = request.index.ok_or_else(|| {
                CoreError::InvalidInput("어느 스태시인지 index를 지정하세요".to_owned())
            })?;
            let reference = stash_reference(index)?;
            let sha = runner.read(
                &[
                    "rev-parse",
                    "-q",
                    "--verify",
                    "--end-of-options",
                    &reference,
                ],
                READ_TIMEOUT,
            )?;
            let sha = sha
                .success
                .then(|| sha.stdout.trim().to_owned())
                .filter(|sha| !sha.is_empty())
                .ok_or_else(|| CoreError::NotFound(format!("{reference}가 없습니다")))?;
            if let Some(expected) = request.expected_sha.as_deref().map(str::trim) {
                if !expected.eq_ignore_ascii_case(&sha) {
                    return Err(CoreError::Conflict(
                        "스태시 목록이 바뀌어 지정한 항목이 다른 것을 가리킵니다. 목록을 새로 고친 뒤 다시 고르세요"
                            .to_owned(),
                    ));
                }
            }
            let (verb, label) = match request.action {
                GitStashAction::Pop => ("pop", "stash pop"),
                GitStashAction::Apply => ("apply", "stash apply"),
                _ => ("drop", "stash drop"),
            };
            let mut receipt = runner.mutate(
                label,
                &["stash", verb, "--end-of-options", &reference],
                None,
                LOCAL_MUTATION_TIMEOUT,
            )?;
            if request.action == GitStashAction::Drop && receipt.succeeded {
                receipt.dropped_stash_sha = Some(sha.clone());
                receipt.message = format!(
                    "스태시를 목록에서 뺐습니다. 되돌리려면 `git stash apply {sha}`를 실행하세요"
                );
            }
            if request.action == GitStashAction::Pop && receipt.outcome == GitOutcome::Conflict {
                receipt.message =
                    format!("{} 스태시가 목록에 그대로 남아 있습니다", receipt.message);
            }
            Ok(receipt)
        }
    }
}

pub fn rebase_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitRebaseRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "rebase", |runner| {
        rebase_with(runner, request)
    })
}

fn rebase_with(
    runner: &GitRunner,
    request: &ProjectGitRebaseRequest,
) -> Result<GitActionReceipt, CoreError> {
    let in_progress = runner.in_progress();
    match request.action {
        GitRebaseAction::Start => {
            if let Some(progress) = in_progress {
                return Err(CoreError::Conflict(format!(
                    "{:?} 작업이 진행 중이라 새 리베이스를 시작할 수 없습니다",
                    progress.kind
                )));
            }
            let onto = request
                .onto
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    CoreError::InvalidInput("리베이스할 대상(onto)을 지정하세요".to_owned())
                })?;
            runner.verify_commit_ref(onto)?;
            runner.mutate(
                "rebase",
                &["rebase", "--no-autostash", "--end-of-options", onto],
                None,
                LOCAL_MUTATION_TIMEOUT,
            )
        }
        GitRebaseAction::Continue | GitRebaseAction::Skip | GitRebaseAction::Abort => {
            if !matches!(
                in_progress.as_ref().map(|progress| progress.kind),
                Some(GitInProgressKind::Rebase | GitInProgressKind::RebaseInteractive)
            ) {
                return Err(CoreError::Conflict(
                    "진행 중인 리베이스가 없습니다".to_owned(),
                ));
            }
            let (flag, label) = match request.action {
                GitRebaseAction::Continue => ("--continue", "rebase continue"),
                GitRebaseAction::Skip => ("--skip", "rebase skip"),
                _ => ("--abort", "rebase abort"),
            };
            runner.mutate(label, &["rebase", flag], None, LOCAL_MUTATION_TIMEOUT)
        }
    }
}

pub fn fetch_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitFetchRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "fetch", |runner| {
        fetch_with(runner, request)
    })
}

fn fetch_with(
    runner: &GitRunner,
    request: &ProjectGitFetchRequest,
) -> Result<GitActionReceipt, CoreError> {
    let remote = runner.resolve_remote(request.remote.as_deref())?;
    let mut args: Vec<&str> = vec!["fetch"];
    if request.prune {
        args.push("--prune");
    }
    args.push("--end-of-options");
    args.push(&remote);
    runner.network_mutate("fetch", &args, NETWORK_TIMEOUT, &remote, false)
}

pub fn pull_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitPullRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "pull", |runner| {
        pull_with(runner, request)
    })
}

fn pull_with(
    runner: &GitRunner,
    request: &ProjectGitPullRequest,
) -> Result<GitActionReceipt, CoreError> {
    require_branch_head(runner)?;
    let remote = runner.resolve_remote(request.remote.as_deref())?;
    let mut args: Vec<&str> = vec!["pull"];
    match request.mode {
        GitPullMode::FfOnly => args.extend(["--ff-only", "--no-rebase"]),
        GitPullMode::Rebase => args.extend(["--rebase", "--no-autostash"]),
    }
    args.push("--end-of-options");
    args.push(&remote);
    runner.network_mutate("pull", &args, NETWORK_TIMEOUT, &remote, false)
}

pub fn push_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitPushRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "push", |runner| {
        push_with(runner, request)
    })
}

fn push_with(
    runner: &GitRunner,
    request: &ProjectGitPushRequest,
) -> Result<GitActionReceipt, CoreError> {
    require_branch_head(runner)?;
    let remote = runner.resolve_remote(request.remote.as_deref())?;
    // 업스트림이 같은 원격에 있으면 그 브랜치로 보낸다. `HEAD`만 주면 같은 이름의 원격
    // 브랜치로 가서, 확인창이 보여 준 업스트림(`feature → origin/dev`)과 실제 대상이
    // 갈린다. 업스트림이 없거나 다른 원격이면 같은 이름으로 올린다.
    let refspec = match runner.upstream_branch_on(&remote)? {
        Some(branch) => format!("HEAD:refs/heads/{branch}"),
        None => "HEAD".to_owned(),
    };
    let mut args: Vec<&str> = vec!["push"];
    if request.set_upstream {
        args.push("--set-upstream");
    }
    args.push("--end-of-options");
    args.push(&remote);
    args.push(&refspec);
    runner.network_mutate("push", &args, NETWORK_TIMEOUT, &remote, true)
}

/// C16-10. 영수증에서 개인키 경로를 가린다. `ssh`는 읽지 못하는 신원 파일을 경고하면서
/// 경로를 그대로 적고, 그 영수증은 원격 화면까지 간다. 경로는 비밀값이 아니지만 사용자의
/// 홈 구조와 키 이름을 드러내므로, 수용 기준대로 자리표시자로 바꾼다.
fn redact_identity_path(outcome: &mut CommandOutcome, identity_path: &str) {
    const PLACEHOLDER: &str = "<git 원격용 SSH 키>";
    if identity_path.is_empty() {
        return;
    }
    outcome.stdout = outcome.stdout.replace(identity_path, PLACEHOLDER);
    outcome.stderr = outcome.stderr.replace(identity_path, PLACEHOLDER);
}

/// C16-11. 원격 URL을 판정에 쓸 모양으로 가른다. 값은 어디에도 남기지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedRemoteUrl {
    transport: GitRemoteTransport,
    /// 소문자 호스트(기본 포트 443은 뗀다). [`normalize_git_host`]와 같은 모양.
    host: Option<String>,
    /// `user:password@`처럼 비밀번호까지 박혀 있는가.
    has_password: bool,
    /// 사용자 정보를 뗀 주소. `credential.helper`를 물을 때 argv에 싣는다.
    without_userinfo: String,
    /// 비밀번호만 떼고 사용자 이름은 남긴 주소(`https://user@host/…`). 사용자 이름이 없으면 없다.
    with_username: Option<String>,
}

fn parse_remote_url(url: &str) -> ParsedRemoteUrl {
    let url = url.trim();
    let other = |transport| ParsedRemoteUrl {
        transport,
        host: None,
        has_password: false,
        without_userinfo: url.to_owned(),
        with_username: None,
    };
    if let Some((scheme, rest)) = url.split_once("://") {
        let transport = match scheme.to_ascii_lowercase().as_str() {
            "https" => GitRemoteTransport::Https,
            "http" => GitRemoteTransport::Http,
            "ssh" | "git+ssh" | "ssh+git" => GitRemoteTransport::Ssh,
            "file" => return other(GitRemoteTransport::Local),
            _ => return other(GitRemoteTransport::Other),
        };
        let (authority, path) = match rest.find('/') {
            Some(index) => rest.split_at(index),
            None => (rest, ""),
        };
        let (userinfo, hostport) = match authority.rsplit_once('@') {
            Some((userinfo, hostport)) => (Some(userinfo), hostport),
            None => (None, authority),
        };
        let mut host = hostport.to_ascii_lowercase();
        if transport == GitRemoteTransport::Https {
            if let Some(stripped) = host.strip_suffix(":443") {
                host = stripped.to_owned();
            }
        }
        return ParsedRemoteUrl {
            transport,
            host: (!host.is_empty()).then_some(host),
            has_password: userinfo.is_some_and(|userinfo| userinfo.contains(':')),
            without_userinfo: format!("{scheme}://{hostport}{path}"),
            with_username: userinfo
                .map(|userinfo| userinfo.split(':').next().unwrap_or_default())
                .filter(|user| !user.is_empty())
                .map(|user| format!("{scheme}://{user}@{hostport}{path}")),
        };
    }
    // 스킴이 없으면 로컬 경로이거나 scp 꼴(`[user@]host:path`)이다. git과 같은 규칙으로 가른다
    // — 첫 `:`보다 앞에 `/`가 있으면 경로다. Windows 드라이브(`C:\`)도 경로다.
    let colon = url.find(':');
    let slash = url.find('/');
    let is_drive = url.len() >= 2
        && url.as_bytes()[1] == b':'
        && url.as_bytes()[0].is_ascii_alphabetic()
        && url
            .as_bytes()
            .get(2)
            .is_none_or(|byte| *byte == b'\\' || *byte == b'/');
    match colon {
        Some(colon) if !is_drive && slash.is_none_or(|slash| colon < slash) => {
            let authority = &url[..colon];
            let host = authority
                .rsplit_once('@')
                .map_or(authority, |(_, host)| host)
                .to_ascii_lowercase();
            ParsedRemoteUrl {
                transport: GitRemoteTransport::Ssh,
                host: (!host.is_empty()).then_some(host),
                has_password: false,
                without_userinfo: url.to_owned(),
                with_username: None,
            }
        }
        _ => other(GitRemoteTransport::Local),
    }
}

/// C16-11. 토큰을 `http.https://<호스트>/.extraHeader` 한 줄로 만들어 환경 목록에 더한다.
///
/// git은 `GIT_CONFIG_COUNT`·`GIT_CONFIG_KEY_n`·`GIT_CONFIG_VALUE_n`을 명령줄 `-c`와 같은
/// 무게로 읽는다(2.31+). 백엔드가 이미 물려받은 묶음이 있으면 덮지 않고 그 뒤에 잇는다 —
/// C16-2가 `GIT_CONFIG_*`를 사용자의 선택으로 남겨 두었기 때문이다. 키를 호스트 URL로
/// 한정하므로 같은 git 호출이 다른 호스트(서브모듈 등)에 붙어도 이 헤더는 따라가지 않는다.
/// 돌려주는 값은 영수증에서 가릴 base64 덩어리다.
///
/// 토큰이 실리는 호출은 **저장소가 고를 수 있는 실행 지점과 전송 설정을 함께 닫는다**. git은
/// 자기 환경을 훅(`pre-push`·`post-merge`·`reference-transaction`…)과 `core.fsmonitor`에 그대로
/// 물려주므로, 저장소 안의 훅이 있으면 그 환경의 헤더를 읽을 수 있다 — 에이전트가 `.git/hooks`를
/// 쓰는 것만으로. 그래서 이 호출만은 훅을 빈 폴더로 돌리고(`core.hooksPath`) fsmonitor를 끄며,
/// 그 호스트의 인증서 검증을 켜고(`sslVerify`) `curloptResolve`를 비운다. 명령 수준 설정이라
/// 저장소 설정보다 이긴다. 인증서 묶음(`sslCAInfo`·`sslCAPath`)을 저장소가 바꿔 둔 경우는
/// 되돌릴 값이 없으므로 호출부가 토큰을 싣지 않고 거절한다([`GitRunner::local_tls_override`]).
fn token_header_env(
    host: &str,
    token: &GitRemoteToken,
    hooks_dir: &Path,
    env: &mut Vec<(String, String)>,
) -> zeroize::Zeroizing<String> {
    use base64::Engine as _;
    let credentials =
        zeroize::Zeroizing::new(format!("{}:{}", token.username, token.value.as_str()));
    let encoded = zeroize::Zeroizing::new(
        base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes()),
    );
    let inherited = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|count| count.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let entries = [
        (
            "core.hooksPath".to_owned(),
            hooks_dir.to_string_lossy().into_owned(),
        ),
        ("core.fsmonitor".to_owned(), "false".to_owned()),
        (format!("http.https://{host}/.sslVerify"), "true".to_owned()),
        ("http.curloptResolve".to_owned(), String::new()),
        (
            format!("http.https://{host}/.extraHeader"),
            format!("Authorization: Basic {}", encoded.as_str()),
        ),
    ];
    let count = entries.len();
    for (offset, (key, value)) in entries.into_iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{}", inherited + offset), key));
        env.push((format!("GIT_CONFIG_VALUE_{}", inherited + offset), value));
    }
    env.push((
        "GIT_CONFIG_COUNT".to_owned(),
        (inherited + count).to_string(),
    ));
    encoded
}

/// C16-11. 영수증에서 토큰을 가린다. git은 헤더를 찍지 않지만, 물려받은 `GIT_TRACE_CURL`
/// 같은 것이 있으면 stderr에 나올 수 있고 그 영수증은 원격 화면까지 간다(G4).
fn redact_token(outcome: &mut CommandOutcome, value: &str, encoded: &str) {
    const PLACEHOLDER: &str = "<git 원격용 토큰>";
    for needle in [value, encoded] {
        if needle.is_empty() {
            continue;
        }
        outcome.stdout = outcome.stdout.replace(needle, PLACEHOLDER);
        outcome.stderr = outcome.stderr.replace(needle, PLACEHOLDER);
    }
}

/// C16-11. 인증 실패 안내. 이 화면은 자격증명을 묻지 않으므로, 원격 종류에 맞는 연결
/// 자리를 알려 주는 것이 사용자가 빠져나갈 유일한 길이다.
fn auth_failed_message(
    transport: Option<GitRemoteTransport>,
    host: Option<&str>,
    token: Option<&str>,
    identity: bool,
) -> String {
    let host = host.unwrap_or("원격");
    match (transport, token) {
        (_, Some(name)) => format!(
            "원격 인증에 실패했습니다. {host}에 저장된 비밀값 {name}으로 인증했지만 거절됐습니다. 토큰의 만료·권한(저장소 쓰기)을 확인하고 저장소 → 비밀정보에서 값을 다시 저장하거나 형상관리 탭의 프로젝트 목록 옆 톱니바퀴(git 원격 인증)에서 다른 값을 고르세요"
        ),
        (Some(GitRemoteTransport::Https), None) => format!(
            "원격 인증에 실패했습니다. 이 화면은 자격증명을 묻지 않습니다. 저장소 → 비밀정보에 토큰을 저장하고 형상관리 탭의 프로젝트 목록 옆 톱니바퀴(git 원격 인증)에서 {host}에 그 값을 고른 뒤 다시 시도하세요"
        ),
        (Some(GitRemoteTransport::Http), None) => format!(
            "원격 인증에 실패했습니다. 이 화면은 자격증명을 묻지 않고, 평문 HTTP 원격({host})에는 저장된 토큰을 싣지 않습니다. HTTPS 주소로 바꾸거나 git credential helper를 설정하세요"
        ),
        (Some(GitRemoteTransport::Ssh), None) if identity => format!(
            "원격 인증에 실패했습니다. 애드온 → SSH 키의 'git 원격용' 키가 {host}에서 거절됐습니다. 그 공개키가 원격 계정(또는 배포 키)에 등록돼 있는지 확인하세요"
        ),
        (Some(GitRemoteTransport::Ssh), None) => format!(
            "원격 인증에 실패했습니다. 이 화면은 자격증명을 묻지 않습니다. 애드온 → SSH 키에서 {host}에 등록한 키의 'git 원격용'을 켠 뒤 다시 시도하세요"
        ),
        _ => "원격 인증에 실패했습니다. 이 화면은 자격증명을 묻지 않습니다. HTTPS 원격은 형상관리 탭 톱니바퀴의 git 원격 인증(저장소 → 비밀정보의 값)으로, SSH 원격은 애드온 → SSH 키의 'git 원격용'으로 인증을 연결한 뒤 다시 시도하세요".to_owned(),
    }
}

/// pull·push는 브랜치 위에서만 뜻이 있다. detached HEAD와 첫 커밋 전 저장소는 거절한다.
fn require_branch_head(runner: &GitRunner) -> Result<(), CoreError> {
    if runner.in_progress().is_some() {
        return Err(CoreError::Conflict(
            "리베이스나 병합이 진행 중이라 원격 작업을 할 수 없습니다".to_owned(),
        ));
    }
    let head = runner.head()?;
    if head.unborn {
        return Err(CoreError::InvalidInput(
            "아직 커밋이 없는 저장소입니다".to_owned(),
        ));
    }
    if head.detached {
        return Err(CoreError::InvalidInput(
            "detached HEAD 상태에서는 pull·push를 할 수 없습니다. 브랜치로 전환하세요".to_owned(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 입력 검증(C16-5)
// ---------------------------------------------------------------------------

fn has_control_or_whitespace(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
}

/// 옵션처럼 보이는 값은 어디에도 들어가지 않는다. `--end-of-options`가 있어도 한 번 더 막는다.
fn refuse_option_like(value: &str, what: &str) -> Result<(), CoreError> {
    if value.starts_with('-') {
        return Err(CoreError::InvalidInput(format!(
            "{what}이(가) 옵션처럼 보이는 값이라 거절합니다: {value}"
        )));
    }
    Ok(())
}

fn validate_branch_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.len() > MAX_REF_BYTES {
        return Err(CoreError::InvalidInput(
            "브랜치 이름이 비었거나 너무 깁니다".to_owned(),
        ));
    }
    refuse_option_like(name, "브랜치 이름")?;
    if has_control_or_whitespace(name)
        || name.contains("..")
        || name.contains("@{")
        || name.contains(['~', '^', ':', '?', '*', '[', '\\'])
        || name.ends_with('/')
        || name.ends_with(".lock")
    {
        return Err(CoreError::InvalidInput(format!(
            "브랜치 이름으로 쓸 수 없습니다: {name}"
        )));
    }
    Ok(())
}

/// 커밋을 가리키는 ref(`onto`, 시작점, log 기준). 브랜치 이름보다 `~`·`^`·`@{u}`를 더 허용하되
/// 공백·제어문자·옵션 꼴은 같은 규칙으로 거절한다. 실제 존재 여부는 git이 확인한다.
fn validate_ref_text(reference: &str) -> Result<(), CoreError> {
    if reference.is_empty() || reference.len() > MAX_REF_BYTES {
        return Err(CoreError::InvalidInput(
            "ref가 비었거나 너무 깁니다".to_owned(),
        ));
    }
    refuse_option_like(reference, "ref")?;
    if has_control_or_whitespace(reference)
        || reference.contains("..")
        || reference.contains([':', '?', '*', '[', '\\'])
    {
        return Err(CoreError::InvalidInput(format!(
            "ref로 쓸 수 없는 값입니다: {reference}"
        )));
    }
    Ok(())
}

/// 저장소 루트 기준 상대 경로 하나를 검증한다. 존재하지 않아도 된다(지운 파일을 스테이지할 수
/// 있어야 한다) — 그래서 존재하는 가장 가까운 조상까지 정규화해 루트 안인지 본다.
pub(crate) fn validate_repo_path(root: &Path, raw: &str) -> Result<String, CoreError> {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_PATH_BYTES {
        return Err(CoreError::InvalidInput(
            "경로가 비었거나 너무 깁니다".to_owned(),
        ));
    }
    refuse_option_like(value, "경로")?;
    if value.starts_with(':') || value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(format!(
            "경로로 쓸 수 없는 값입니다: {value}"
        )));
    }
    let relative = Path::new(value);
    if path_guard::classify_relative_path(relative, CurDirPolicy::Reject).is_some() {
        return Err(CoreError::InvalidInput(format!(
            "저장소 루트 기준 상대 경로만 받습니다: {value}"
        )));
    }
    if relative
        .components()
        .any(|component| component.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(CoreError::InvalidInput(
            ".git 내부 경로는 다루지 않습니다".to_owned(),
        ));
    }
    path_guard::assert_within_root(root, &root.join(relative), LABELS)?;
    Ok(value.replace('\\', "/"))
}

/// stage·unstage에 넘길 NUL 구분 pathspec. 개수 상한과 중복 제거를 여기서 한다.
pub(crate) fn pathspec_payload(root: &Path, paths: &[String]) -> Result<Vec<u8>, CoreError> {
    if paths.is_empty() {
        return Err(CoreError::InvalidInput(
            "경로를 하나 이상 지정하세요".to_owned(),
        ));
    }
    if paths.len() > MAX_PATHS_PER_REQUEST {
        return Err(CoreError::InvalidInput(format!(
            "한 번에 {MAX_PATHS_PER_REQUEST}개까지만 지정할 수 있습니다"
        )));
    }
    let mut seen = BTreeSet::new();
    let mut payload = Vec::new();
    for raw in paths {
        let path = validate_repo_path(root, raw)?;
        if seen.insert(path.clone()) {
            payload.extend_from_slice(path.as_bytes());
            payload.push(0);
        }
    }
    Ok(payload)
}

fn validate_commit_message(message: &str) -> Result<String, CoreError> {
    let trimmed = message.trim_end();
    if trimmed.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "커밋 메시지가 비어 있습니다".to_owned(),
        ));
    }
    if trimmed.len() > MAX_COMMIT_MESSAGE_BYTES {
        return Err(CoreError::InvalidInput(
            "커밋 메시지가 너무 깁니다(64KB 상한)".to_owned(),
        ));
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t' | '\r'))
    {
        return Err(CoreError::InvalidInput(
            "커밋 메시지에 제어 문자가 있습니다".to_owned(),
        ));
    }
    Ok(format!("{trimmed}\n"))
}

fn validate_stash_message(message: &str) -> Result<String, CoreError> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(
            "스태시 메시지가 비어 있습니다".to_owned(),
        ));
    }
    if trimmed.chars().count() > MAX_STASH_MESSAGE_CHARS || trimmed.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "스태시 메시지는 한 줄 1000자까지입니다".to_owned(),
        ));
    }
    refuse_option_like(trimmed, "스태시 메시지")?;
    Ok(trimmed.to_owned())
}

fn stash_reference(index: u32) -> Result<String, CoreError> {
    if index > MAX_STASH_INDEX {
        return Err(CoreError::InvalidInput(
            "스태시 index가 너무 큽니다".to_owned(),
        ));
    }
    Ok(format!("stash@{{{index}}}"))
}

// ---------------------------------------------------------------------------
// 파서
// ---------------------------------------------------------------------------

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_owned()
}

fn parse_git_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let mut parts = rest.split(|ch: char| !ch.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    let mut gone = false;
    for part in track.split(',').map(str::trim) {
        if part == "gone" {
            gone = true;
        } else if let Some(value) = part.strip_prefix("ahead ") {
            ahead = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = part.strip_prefix("behind ") {
            behind = value.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, gone)
}

/// `for-each-ref` 출력. (로컬, 원격, 읽은 줄 수)를 돌려주고 원격의 `HEAD` 심볼릭 항목은 뺀다.
fn parse_for_each_ref(text: &str) -> (Vec<GitBranch>, Vec<GitBranch>, usize) {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let mut count = 0;
    for line in text.lines() {
        let fields: Vec<&str> = line.splitn(7, '\0').collect();
        if fields.len() < 7 {
            continue;
        }
        count += 1;
        let refname = fields[0];
        let (ahead, behind, gone) = parse_track(fields[4]);
        let branch = |name: &str| GitBranch {
            name: name.to_owned(),
            sha: fields[1].to_owned(),
            is_head: fields[2] == "*",
            upstream: (!fields[3].is_empty()).then(|| fields[3].to_owned()),
            ahead,
            behind,
            gone,
            committed_at: fields[5].trim().parse().unwrap_or(0),
            subject: fields[6].to_owned(),
        };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            local.push(branch(name));
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") {
                continue;
            }
            remote.push(branch(name));
        }
    }
    (local, remote, count)
}

struct ParsedStatus {
    head: GitHead,
    upstream: Option<GitUpstream>,
    entries: Vec<GitStatusEntry>,
    truncated: bool,
}

/// `status --porcelain=v2 -z --branch`. 항목은 NUL로 나뉘고 rename(`2`) 항목은 바로 다음
/// 토큰이 원래 경로다.
fn parse_status_porcelain_v2(text: &str) -> ParsedStatus {
    let mut head = GitHead::default();
    let mut upstream: Option<GitUpstream> = None;
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut tokens = text.split('\0').peekable();
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(header) = token.strip_prefix("# ") {
            if let Some(value) = header.strip_prefix("branch.oid ") {
                if value != "(initial)" {
                    head.sha = Some(value.to_owned());
                    head.short_sha = Some(value.chars().take(7).collect());
                } else {
                    head.unborn = true;
                }
            } else if let Some(value) = header.strip_prefix("branch.head ") {
                if value == "(detached)" {
                    head.detached = true;
                } else {
                    head.branch = Some(value.to_owned());
                }
            } else if let Some(value) = header.strip_prefix("branch.upstream ") {
                upstream = Some(GitUpstream {
                    name: value.to_owned(),
                    ..GitUpstream::default()
                });
            } else if let Some(value) = header.strip_prefix("branch.ab ") {
                if let Some(target) = upstream.as_mut() {
                    for part in value.split_whitespace() {
                        if let Some(ahead) = part.strip_prefix('+') {
                            target.ahead = ahead.parse().unwrap_or(0);
                        } else if let Some(behind) = part.strip_prefix('-') {
                            target.behind = behind.parse().unwrap_or(0);
                        }
                    }
                }
            }
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES {
            truncated = true;
            break;
        }
        let entry = match token.chars().next() {
            Some('1') => {
                let fields: Vec<&str> = token.splitn(9, ' ').collect();
                if fields.len() < 9 {
                    continue;
                }
                let mut xy = fields[1].chars();
                GitStatusEntry {
                    path: fields[8].to_owned(),
                    original_path: None,
                    index_status: GitChangeKind::from_porcelain(xy.next().unwrap_or('.')),
                    worktree_status: GitChangeKind::from_porcelain(xy.next().unwrap_or('.')),
                    is_submodule: fields[2].starts_with('S'),
                    unmerged: None,
                    rename_score: None,
                }
            }
            Some('2') => {
                let fields: Vec<&str> = token.splitn(10, ' ').collect();
                if fields.len() < 10 {
                    continue;
                }
                let original = tokens.next().unwrap_or_default().to_owned();
                let mut xy = fields[1].chars();
                GitStatusEntry {
                    path: fields[9].to_owned(),
                    original_path: Some(original),
                    index_status: GitChangeKind::from_porcelain(xy.next().unwrap_or('.')),
                    worktree_status: GitChangeKind::from_porcelain(xy.next().unwrap_or('.')),
                    is_submodule: fields[2].starts_with('S'),
                    unmerged: None,
                    rename_score: fields[8].get(1..).and_then(|score| score.parse().ok()),
                }
            }
            Some('u') => {
                let fields: Vec<&str> = token.splitn(11, ' ').collect();
                if fields.len() < 11 {
                    continue;
                }
                GitStatusEntry {
                    path: fields[10].to_owned(),
                    original_path: None,
                    index_status: GitChangeKind::Unmerged,
                    worktree_status: GitChangeKind::Unmerged,
                    is_submodule: fields[2].starts_with('S'),
                    unmerged: Some(fields[1].to_owned()),
                    rename_score: None,
                }
            }
            // 출력이 상한에서 잘리면 마지막 토큰이 `?`처럼 짧게 끝날 수 있다. 다른 깨진 꼴과
            // 같이 건너뛴다 — 여기서 패닉하면 상태 조회 전체가 죽는다.
            Some(kind @ ('?' | '!')) => {
                let Some(path) = token.get(2..).filter(|path| !path.is_empty()) else {
                    continue;
                };
                let status = if kind == '?' {
                    GitChangeKind::Untracked
                } else {
                    GitChangeKind::Ignored
                };
                GitStatusEntry {
                    path: path.to_owned(),
                    original_path: None,
                    index_status: status,
                    worktree_status: status,
                    is_submodule: false,
                    unmerged: None,
                    rename_score: None,
                }
            }
            _ => continue,
        };
        entries.push(entry);
    }
    ParsedStatus {
        head,
        upstream,
        entries,
        truncated,
    }
}

/// `--name-status -z` 출력. 상태 토큰(`M`, `R100`…) 뒤에 경로가 오고, rename·copy는 원래 경로가
/// 먼저 온다. 상태 항목 상한을 넘으면 잘랐다고 알린다.
fn parse_name_status(text: &str) -> (Vec<GitCommitFile>, bool) {
    let mut files = Vec::new();
    let mut tokens = text.split('\0');
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        if files.len() >= MAX_STATUS_ENTRIES {
            return (files, true);
        }
        let kind = GitChangeKind::from_porcelain(status.chars().next().unwrap_or('.'));
        let Some(first) = tokens.next().filter(|path| !path.is_empty()) else {
            break;
        };
        let (path, original_path) =
            if matches!(kind, GitChangeKind::Renamed | GitChangeKind::Copied) {
                let Some(second) = tokens.next().filter(|path| !path.is_empty()) else {
                    break;
                };
                (second.to_owned(), Some(first.to_owned()))
            } else {
                (first.to_owned(), None)
            };
        files.push(GitCommitFile {
            path,
            original_path,
            status: kind,
        });
    }
    (files, false)
}

/// `log -z --format=…` 레코드. 본문(`%b`)이 마지막이라 그 안의 구분 문자가 앞 칸을 밀지 못한다.
fn parse_log_records(text: &str) -> Vec<GitCommit> {
    text.split('\0')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let fields: Vec<&str> = record.splitn(11, '\x1f').collect();
            if fields.len() < 10 {
                return None;
            }
            let body = fields.get(10).copied().unwrap_or_default();
            let body: String = body
                .trim_end()
                .chars()
                .take(MAX_COMMIT_BODY_CHARS)
                .collect();
            Some(GitCommit {
                sha: fields[0].trim().to_owned(),
                short_sha: fields[1].to_owned(),
                parents: fields[2].split_whitespace().map(str::to_owned).collect(),
                author_name: fields[3].to_owned(),
                author_email: fields[4].to_owned(),
                authored_at: fields[5].trim().parse().unwrap_or(0),
                committer_name: fields[6].to_owned(),
                committed_at: fields[7].trim().parse().unwrap_or(0),
                refs: fields[8]
                    .split(", ")
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
                subject: fields[9].to_owned(),
                body,
            })
        })
        .collect()
}

fn parse_stash_list(text: &str) -> Vec<GitStash> {
    text.split('\0')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let fields: Vec<&str> = record.splitn(4, '\x1f').collect();
            if fields.len() < 4 {
                return None;
            }
            let index = fields[0]
                .trim()
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(GitStash {
                index,
                sha: fields[1].to_owned(),
                created_at: fields[2].trim().parse().unwrap_or(0),
                message: fields[3].trim().to_owned(),
            })
        })
        .collect()
}

fn parse_worktree_list(text: &str, current_root: &Path) -> Vec<GitWorktree> {
    let current = std::fs::canonicalize(current_root).ok();
    let mut worktrees = Vec::new();
    for block in text.split("\n\n") {
        let mut worktree = GitWorktree::default();
        let mut seen = false;
        for line in block.lines() {
            seen = true;
            if let Some(path) = line.strip_prefix("worktree ") {
                worktree.path = path.to_owned();
                worktree.is_current = current.as_ref().is_some_and(|current| {
                    std::fs::canonicalize(path).ok().as_ref() == Some(current)
                });
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                worktree.head = Some(head.to_owned());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                worktree.branch = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_owned(),
                );
            } else if line == "detached" {
                worktree.detached = true;
            } else if line == "bare" {
                worktree.bare = true;
            } else if line.starts_with("locked") {
                worktree.locked = true;
            } else if line.starts_with("prunable") {
                worktree.prunable = true;
            }
        }
        if seen && !worktree.path.is_empty() {
            worktrees.push(worktree);
        }
    }
    worktrees
}

fn read_git_state(git_dir: &Path, name: &str) -> Option<String> {
    read_small(&git_dir.join(name)).map(|value| value.trim().to_owned())
}

fn read_git_number(git_dir: &Path, name: &str) -> Option<u32> {
    read_git_state(git_dir, name)?.parse().ok()
}

/// 진행 중인 여러 단계 작업. git 자신이 두는 상태 파일로 판정한다 — 이것이 `git status`가
/// "You are currently rebasing"을 내는 근거와 같다.
fn in_progress_from_git_dir(git_dir: &Path) -> Option<GitInProgress> {
    let rebase_merge = git_dir.join("rebase-merge");
    if rebase_merge.is_dir() {
        return Some(GitInProgress {
            kind: if rebase_merge.join("interactive").exists() {
                GitInProgressKind::RebaseInteractive
            } else {
                GitInProgressKind::Rebase
            },
            head_name: read_git_state(&rebase_merge, "head-name")
                .map(|name| name.trim_start_matches("refs/heads/").to_owned()),
            onto: read_git_state(&rebase_merge, "onto"),
            step: read_git_number(&rebase_merge, "msgnum"),
            total: read_git_number(&rebase_merge, "end"),
        });
    }
    let rebase_apply = git_dir.join("rebase-apply");
    if rebase_apply.is_dir() {
        return Some(GitInProgress {
            kind: if rebase_apply.join("rebasing").exists() {
                GitInProgressKind::Rebase
            } else {
                GitInProgressKind::Am
            },
            head_name: read_git_state(&rebase_apply, "head-name")
                .map(|name| name.trim_start_matches("refs/heads/").to_owned()),
            onto: read_git_state(&rebase_apply, "onto"),
            step: read_git_number(&rebase_apply, "next"),
            total: read_git_number(&rebase_apply, "last"),
        });
    }
    let simple = |file: &str, kind: GitInProgressKind| {
        git_dir.join(file).exists().then(|| GitInProgress {
            kind,
            head_name: None,
            onto: read_git_state(git_dir, file),
            step: None,
            total: None,
        })
    };
    simple("MERGE_HEAD", GitInProgressKind::Merge)
        .or_else(|| simple("CHERRY_PICK_HEAD", GitInProgressKind::CherryPick))
        .or_else(|| simple("REVERT_HEAD", GitInProgressKind::Revert))
        .or_else(|| simple("BISECT_LOG", GitInProgressKind::Bisect))
}

/// git이 실패했을 때 stderr·stdout 문구로 결말을 고른다. 문구는 `LC_ALL=C`라 영어로 고정된다.
fn classify_failure(text: &str) -> GitOutcome {
    let lower = text.to_lowercase();
    let has = |needle: &str| lower.contains(needle);
    if has("terminal prompts disabled")
        || has("could not read username")
        || has("could not read password")
        || has("authentication failed")
        || has("permission denied (publickey")
        || has("permission denied (password")
        || has("host key verification failed")
        || has("could not read from remote repository")
    {
        GitOutcome::AuthFailed
    } else if has("please tell me who you are") || has("author identity unknown") {
        GitOutcome::IdentityMissing
    } else if has("index.lock") && (has("file exists") || has("unable to create")) {
        GitOutcome::RepositoryLocked
    } else if has("would be overwritten by")
        || has("cannot rebase: you have unstaged changes")
        || has("cannot rebase: your index contains uncommitted changes")
        || has("cannot pull with rebase: you have unstaged changes")
        || has("please commit or stash them")
    {
        GitOutcome::BlockedByLocalChanges
    } else if has("nothing to commit")
        || has("nothing added to commit")
        || has("no changes added to commit")
    {
        GitOutcome::NothingToCommit
    } else if has("conflict")
        || has("could not apply")
        || has("needs merge")
        || has("unmerged files")
        || has("resolve all conflicts")
    {
        GitOutcome::Conflict
    } else if has("not possible to fast-forward") || has("fatal: not possible to fast-forward") {
        GitOutcome::NotFastForward
    } else if has("no tracking information")
        || has("no upstream")
        || has("has no upstream branch")
        // 원격을 지정해 pull하면 git은 업스트림 부재를 이 문장으로 말한다.
        || has("but did not specify")
    {
        GitOutcome::NoUpstream
    } else if has("[rejected]")
        && (has("non-fast-forward") || has("fetch first") || has("stale info"))
    {
        GitOutcome::RejectedNonFastForward
    } else {
        GitOutcome::Failed
    }
}

/// `error: Your local changes … would be overwritten` 뒤에 탭으로 들여 쓴 파일 목록.
fn blocked_files_from_output(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.strip_prefix('\t'))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn outcome_message(outcome: GitOutcome, action: &str, raw: &CommandOutcome) -> String {
    match outcome {
        GitOutcome::Completed => {
            let line = first_line(&raw.stdout);
            let line = if line.is_empty() { first_line(&raw.stderr) } else { line };
            if line.is_empty() {
                format!("{action} 완료")
            } else {
                redact_git_text(&line)
            }
        }
        GitOutcome::NothingToCommit => "커밋할 변경이 없습니다. 먼저 파일을 스테이지하세요".to_owned(),
        GitOutcome::Conflict => "충돌이 났습니다. 파일을 고쳐 스테이지한 뒤 계속하거나, 중단하세요".to_owned(),
        GitOutcome::BlockedByLocalChanges => {
            "로컬 변경이 덮어써질 수 있어 git이 거절했습니다. 먼저 커밋하거나 스태시하세요".to_owned()
        }
        GitOutcome::NotFastForward => {
            "fast-forward할 수 없습니다. 리베이스 모드로 끌어오거나 먼저 리베이스하세요".to_owned()
        }
        GitOutcome::NoUpstream => "업스트림 브랜치가 없습니다. 원격을 지정하거나 업스트림을 설정하며 push하세요".to_owned(),
        GitOutcome::RejectedNonFastForward => {
            "원격에 새 커밋이 있어 push가 거절됐습니다. 먼저 가져와 리베이스하세요".to_owned()
        }
        GitOutcome::AuthFailed => {
            auth_failed_message(None, None, None, false)
        }
        GitOutcome::IdentityMissing => {
            "커밋 작성자 정보가 없습니다. 터미널에서 git config user.name·user.email을 설정하세요".to_owned()
        }
        GitOutcome::RepositoryLocked => {
            "다른 git 프로세스가 저장소를 잠그고 있습니다(index.lock). 끝나길 기다린 뒤 다시 시도하세요".to_owned()
        }
        GitOutcome::Busy => "다른 변경이 진행 중입니다".to_owned(),
        GitOutcome::TimedOut => format!("{action}이(가) 제한 시간을 넘겨 중단됐습니다"),
        GitOutcome::Failed => {
            let line = first_line(&raw.stderr);
            if line.is_empty() {
                format!("{action} 실패")
            } else {
                redact_git_text(&line)
            }
        }
    }
}

/// `scheme://user:token@host` 꼴의 사용자 정보를 지운다(C16-8). SHA를 지우지 않으려고
/// 이 한 모양만 본다 — `ssh_output::redact`의 긴 토큰 마스킹은 커밋 해시를 삼킨다.
fn redact_git_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("://") {
        let (before, after) = rest.split_at(start + 3);
        output.push_str(before);
        let authority_end = after
            .find(|ch: char| ch == '/' || ch.is_whitespace())
            .unwrap_or(after.len());
        let authority = &after[..authority_end];
        match authority.rfind('@') {
            Some(at) => {
                output.push_str("***@");
                output.push_str(&authority[at + 1..]);
            }
            None => output.push_str(authority),
        }
        rest = &after[authority_end..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B3. 팔로우는 프로젝트와 브랜치에 매인 기기 단위 저장본이다(G7). 2026-10-02 측정:
    /// 저장 자리가 없어 화면이 "계속 볼 브랜치"를 기억하지 못했다. 토글이 아니라 상태를
    /// 보내므로 같은 요청을 두 번 보내도 결과가 뒤집히지 않아야 하고, 끈 뒤에는 줄 자체가
    /// 사라져야 한다 — 꺼진 줄을 남겨 두면 상한 500에 꺼진 것들이 쌓인다.
    #[test]
    fn branch_follow_is_stored_per_project_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("임시 앱 데이터");
        let app_data = dir.path();
        let one = Path::new("/tmp/project-one");
        let two = Path::new("/tmp/project-two");

        assert!(list_project_branch_follows(app_data, one)
            .expect("빈 목록")
            .follows
            .is_empty());

        let request = SetProjectBranchFollowRequest {
            project_path: "/tmp/project-one".to_owned(),
            branch: "feature/a".to_owned(),
            follow: true,
        };
        let saved = set_project_branch_follow(app_data, one, &request).expect("저장");
        assert_eq!(saved.follows.len(), 1);
        assert_eq!(saved.follows[0].branch, "feature/a");
        // 같은 상태를 다시 보내도 한 줄이다.
        let again = set_project_branch_follow(app_data, one, &request).expect("재저장");
        assert_eq!(again.follows.len(), 1);
        assert_eq!(again.follows[0].followed_at, saved.follows[0].followed_at);

        // 다른 프로젝트의 선택은 섞이지 않는다.
        set_project_branch_follow(
            app_data,
            two,
            &SetProjectBranchFollowRequest {
                project_path: "/tmp/project-two".to_owned(),
                branch: "feature/a".to_owned(),
                follow: true,
            },
        )
        .expect("다른 프로젝트 저장");
        assert_eq!(
            list_project_branch_follows(app_data, one)
                .unwrap()
                .follows
                .len(),
            1
        );
        assert_eq!(
            list_project_branch_follows(app_data, two)
                .unwrap()
                .follows
                .len(),
            1
        );

        let cleared = set_project_branch_follow(
            app_data,
            one,
            &SetProjectBranchFollowRequest {
                project_path: "/tmp/project-one".to_owned(),
                branch: "feature/a".to_owned(),
                follow: false,
            },
        )
        .expect("해제");
        assert!(cleared.follows.is_empty());
        // 해제는 그 프로젝트만 지운다.
        assert_eq!(
            list_project_branch_follows(app_data, two)
                .unwrap()
                .follows
                .len(),
            1
        );
    }

    /// B3. 저장본에 들어간 브랜치 이름은 다음 조회에서 비교 요청의 인자가 되므로, 저장
    /// 시점에 C16-5와 같은 검증을 통과해야 한다. `-`로 시작하는 이름이나 제어문자가
    /// 저장되면 지울 수 없는 줄이 화면에 남는다.
    #[test]
    fn branch_follow_refuses_names_git_would_refuse() {
        let dir = tempfile::tempdir().expect("임시 앱 데이터");
        let app_data = dir.path();
        let root = Path::new("/tmp/project-one");
        for bad in ["--upload-pack=x", "with space", "tab\there", ""] {
            let request = SetProjectBranchFollowRequest {
                project_path: "/tmp/project-one".to_owned(),
                branch: bad.to_owned(),
                follow: true,
            };
            assert!(
                set_project_branch_follow(app_data, root, &request).is_err(),
                "{bad}"
            );
        }
        assert!(list_project_branch_follows(app_data, root)
            .unwrap()
            .follows
            .is_empty());
    }

    #[test]
    fn version_is_parsed_from_the_banner() {
        assert_eq!(
            parse_git_version("git version 2.50.1 (Apple Git-155)\n"),
            Some((2, 50))
        );
        assert_eq!(parse_git_version("git version 2.24.0"), Some((2, 24)));
        assert_eq!(parse_git_version("not git"), None);
    }

    #[test]
    fn for_each_ref_splits_local_and_remote_and_reads_tracking() {
        let text =
            "refs/heads/main\0abc\0*\0origin/main\0ahead 1, behind 2\x001700000000\0subject one\n\
refs/heads/gone\0def\0 \0origin/gone\0gone\x001699999999\0lost\n\
refs/remotes/origin/HEAD\0abc\0 \0\0\x001700000000\0subject one\n\
refs/remotes/origin/main\0abc\0 \0\0\x001700000000\0subject one\n";
        let (local, remote, count) = parse_for_each_ref(text);
        assert_eq!(count, 4);
        assert_eq!(local.len(), 2);
        assert!(local[0].is_head);
        assert_eq!((local[0].ahead, local[0].behind), (1, 2));
        assert_eq!(local[0].upstream.as_deref(), Some("origin/main"));
        assert!(local[1].gone);
        assert_eq!(remote.len(), 1, "origin/HEAD는 뺀다");
        assert_eq!(remote[0].name, "origin/main");
    }

    #[test]
    fn status_porcelain_v2_reads_headers_renames_conflicts_and_untracked() {
        let text = "# branch.oid 1234567890abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -1\0\
1 M. N... 100644 100644 100644 aaaa bbbb src/a.rs\0\
1 .M N... 100644 100644 100644 aaaa aaaa src/b c.rs\0\
2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.rs\0old name.rs\0\
u UU N... 100644 100644 100644 100644 a b c d.rs\0\
1 M. S.M. 160000 160000 160000 aaaa bbbb vendor/sub\0\
? notes.txt\0";
        let parsed = parse_status_porcelain_v2(text);
        assert_eq!(parsed.head.branch.as_deref(), Some("main"));
        assert_eq!(parsed.head.short_sha.as_deref(), Some("1234567"));
        let upstream = parsed.upstream.expect("upstream");
        assert_eq!((upstream.ahead, upstream.behind), (3, 1));
        assert_eq!(parsed.entries.len(), 6);
        assert_eq!(parsed.entries[0].index_status, GitChangeKind::Modified);
        assert_eq!(parsed.entries[0].worktree_status, GitChangeKind::Unmodified);
        assert_eq!(parsed.entries[1].path, "src/b c.rs");
        assert_eq!(parsed.entries[1].worktree_status, GitChangeKind::Modified);
        assert_eq!(parsed.entries[2].path, "new name.rs");
        assert_eq!(
            parsed.entries[2].original_path.as_deref(),
            Some("old name.rs")
        );
        assert_eq!(parsed.entries[2].rename_score, Some(100));
        assert_eq!(parsed.entries[3].unmerged.as_deref(), Some("UU"));
        assert_eq!(parsed.entries[3].path, "d.rs");
        assert!(parsed.entries[4].is_submodule);
        assert_eq!(parsed.entries[5].index_status, GitChangeKind::Untracked);
        assert!(!parsed.truncated);
    }

    #[test]
    fn status_porcelain_v2_marks_initial_and_detached() {
        let parsed =
            parse_status_porcelain_v2("# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(parsed.head.unborn);
        assert!(parsed.head.detached);
        assert!(parsed.head.branch.is_none());
    }

    /// 상한에서 잘린 출력의 짧은 토큰과 빈 점수 칸은 건너뛰지 패닉하지 않는다.
    #[test]
    fn status_porcelain_v2_skips_malformed_tokens() {
        let parsed = parse_status_porcelain_v2(
            "? ok.txt\0?\0!\0? \x002 R. N... 100644 100644 100644 aaaa aaaa  new\0old\0",
        );
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].path, "ok.txt");
        assert_eq!(parsed.entries[1].path, "new");
        assert_eq!(parsed.entries[1].rename_score, None);
    }

    #[test]
    fn status_porcelain_v2_caps_entries() {
        let mut text = String::new();
        for index in 0..(MAX_STATUS_ENTRIES + 5) {
            text.push_str(&format!("? file-{index}\0"));
        }
        let parsed = parse_status_porcelain_v2(&text);
        assert_eq!(parsed.entries.len(), MAX_STATUS_ENTRIES);
        assert!(parsed.truncated);
    }

    #[test]
    fn log_records_keep_body_intact_when_it_contains_the_separator() {
        let text = "abc123\x1fabc\x1fp1 p2\x1fAn\x1fan@x\x1f1700000000\x1fCn\x1f1700000001\x1fHEAD -> main, tag: v1\x1fSubject\x1fbody with \x1f inside\n\n\0\
def456\x1fdef\x1f\x1fAn\x1fan@x\x1f1699999999\x1fCn\x1f1699999999\x1f\x1fRoot\x1f\0";
        let commits = parse_log_records(text);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["p1", "p2"]);
        assert_eq!(commits[0].refs, vec!["HEAD -> main", "tag: v1"]);
        assert_eq!(commits[0].body, "body with \x1f inside");
        assert!(commits[1].parents.is_empty());
        assert!(commits[1].refs.is_empty());
    }

    #[test]
    fn name_status_reads_renames_with_the_original_first() {
        let (files, truncated) =
            parse_name_status("M\0src/a.rs\0R100\0old.rs\0new.rs\0A\0docs/x.md\0D\0gone\0");
        assert!(!truncated);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, GitChangeKind::Modified);
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[1].original_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].status, GitChangeKind::Renamed);
        assert_eq!(files[3].status, GitChangeKind::Deleted);
        assert!(parse_name_status("M\0").0.is_empty());
    }

    #[test]
    fn stash_and_worktree_lists_are_parsed() {
        let stashes = parse_stash_list("stash@{0}\x1fabc\x1f1700000000\x1fWIP on main: 1234 msg\0stash@{1}\x1fdef\x1f1699999999\x1fOn feat: saved\0");
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[1].index, 1);
        assert_eq!(stashes[1].message, "On feat: saved");

        let worktrees = parse_worktree_list(
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD def\ndetached\nlocked reason\nprunable gitdir missing\n\nworktree /bare\nbare\n",
            Path::new("/nonexistent"),
        );
        assert_eq!(worktrees.len(), 3);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(worktrees[1].detached && worktrees[1].locked && worktrees[1].prunable);
        assert!(worktrees[2].bare);
    }

    #[test]
    fn in_progress_is_read_from_git_state_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let git_dir = dir.path();
        assert!(in_progress_from_git_dir(git_dir).is_none());
        let rebase = git_dir.join("rebase-merge");
        std::fs::create_dir_all(&rebase).expect("rebase dir");
        std::fs::write(rebase.join("head-name"), "refs/heads/feature\n").expect("head");
        std::fs::write(rebase.join("onto"), "abc123\n").expect("onto");
        std::fs::write(rebase.join("msgnum"), "2\n").expect("msgnum");
        std::fs::write(rebase.join("end"), "5\n").expect("end");
        let progress = in_progress_from_git_dir(git_dir).expect("progress");
        assert_eq!(progress.kind, GitInProgressKind::Rebase);
        assert_eq!(progress.head_name.as_deref(), Some("feature"));
        assert_eq!((progress.step, progress.total), (Some(2), Some(5)));
        std::fs::write(rebase.join("interactive"), "").expect("interactive");
        assert_eq!(
            in_progress_from_git_dir(git_dir).expect("progress").kind,
            GitInProgressKind::RebaseInteractive
        );
        std::fs::remove_dir_all(&rebase).expect("cleanup");
        std::fs::write(git_dir.join("MERGE_HEAD"), "def456\n").expect("merge");
        let merge = in_progress_from_git_dir(git_dir).expect("merge");
        assert_eq!(merge.kind, GitInProgressKind::Merge);
        assert_eq!(merge.onto.as_deref(), Some("def456"));
    }

    #[test]
    fn failures_are_classified_from_git_wording() {
        assert_eq!(
            classify_failure(
                "fatal: could not read Username for 'https://x': terminal prompts disabled"
            ),
            GitOutcome::AuthFailed
        );
        assert_eq!(
            classify_failure("git@github.com: Permission denied (publickey)."),
            GitOutcome::AuthFailed
        );
        assert_eq!(
            classify_failure("Author identity unknown\n*** Please tell me who you are."),
            GitOutcome::IdentityMissing
        );
        assert_eq!(
            classify_failure("fatal: Unable to create '/r/.git/index.lock': File exists."),
            GitOutcome::RepositoryLocked
        );
        assert_eq!(classify_failure("error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.rs\nPlease commit your changes or stash them before you switch branches."), GitOutcome::BlockedByLocalChanges);
        assert_eq!(
            classify_failure(
                "CONFLICT (content): Merge conflict in a.txt\nerror: could not apply 1234... x"
            ),
            GitOutcome::Conflict
        );
        assert_eq!(
            classify_failure("fatal: Not possible to fast-forward, aborting."),
            GitOutcome::NotFastForward
        );
        assert_eq!(
            classify_failure(
                "You asked to pull from the remote 'origin', but did not specify\na branch."
            ),
            GitOutcome::NoUpstream
        );
        assert_eq!(
            classify_failure("There is no tracking information for the current branch."),
            GitOutcome::NoUpstream
        );
        assert_eq!(
            classify_failure(" ! [rejected]        main -> main (non-fast-forward)"),
            GitOutcome::RejectedNonFastForward
        );
        assert_eq!(
            classify_failure("On branch main\nnothing to commit, working tree clean"),
            GitOutcome::NothingToCommit
        );
        assert_eq!(
            classify_failure("fatal: something else"),
            GitOutcome::Failed
        );
        assert_eq!(
            blocked_files_from_output("error: Your local changes would be overwritten:\n\tsrc/a.rs\n\tdocs/b.md\nPlease commit"),
            vec!["src/a.rs", "docs/b.md"]
        );
    }

    #[test]
    fn userinfo_is_redacted_but_shas_survive() {
        assert_eq!(
            redact_git_text("https://user:ghp_secret@github.com/org/repo.git"),
            "https://***@github.com/org/repo.git"
        );
        assert_eq!(
            redact_git_text("git@github.com:org/repo.git"),
            "git@github.com:org/repo.git"
        );
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            redact_git_text(&format!("moved to {sha} ok")),
            format!("moved to {sha} ok")
        );
        assert_eq!(
            redact_git_text("fetch https://token@host/a and https://b@host2/c"),
            "fetch https://***@host/a and https://***@host2/c"
        );
    }

    #[test]
    fn c16_5_refuses_option_like_and_unsafe_inputs() {
        assert!(validate_branch_name("-x").is_err());
        assert!(validate_branch_name("--force").is_err());
        assert!(validate_branch_name("a..b").is_err());
        assert!(validate_branch_name("a b").is_err());
        assert!(validate_branch_name("a\u{7}b").is_err());
        assert!(validate_branch_name("@{-1}").is_err());
        assert!(validate_branch_name("feature/x.lock").is_err());
        assert!(validate_branch_name("feature/기능-1").is_ok());
        assert!(validate_ref_text("HEAD~3").is_ok());
        assert!(validate_ref_text("@{upstream}").is_ok());
        assert!(validate_ref_text("origin/main").is_ok());
        assert!(validate_ref_text("-x").is_err());
        assert!(validate_ref_text("a..b").is_err());
        assert!(validate_commit_message("   \n").is_err());
        assert!(validate_commit_message("a\u{0}b").is_err());
        assert_eq!(
            validate_commit_message("제목\n\n본문  \n").expect("message"),
            "제목\n\n본문\n"
        );
        assert!(validate_stash_message("-m x").is_err());
        assert!(stash_reference(MAX_STASH_INDEX + 1).is_err());
        assert_eq!(stash_reference(3).expect("ref"), "stash@{3}");
    }

    #[test]
    fn c16_5_repo_paths_stay_inside_the_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("root");
        std::fs::create_dir_all(root.join("src")).expect("src");
        assert_eq!(
            validate_repo_path(&root, "src/main.rs").expect("path"),
            "src/main.rs"
        );
        assert_eq!(
            validate_repo_path(&root, "gone/deleted.rs").expect("missing ok"),
            "gone/deleted.rs"
        );
        for bad in [
            "../x",
            "/etc/passwd",
            ".git/config",
            "src/../.git/HEAD",
            "-rf",
            ":(top)x",
            "./src",
            "",
        ] {
            assert!(validate_repo_path(&root, bad).is_err(), "{bad}");
        }
        let many: Vec<String> = (0..=MAX_PATHS_PER_REQUEST)
            .map(|i| format!("f{i}"))
            .collect();
        assert!(pathspec_payload(&root, &many).is_err());
        let payload =
            pathspec_payload(&root, &["a".into(), "a".into(), "b".into()]).expect("payload");
        assert_eq!(payload, b"a\0b\0");
        assert!(pathspec_payload(&root, &[]).is_err());
    }

    // -----------------------------------------------------------------------
    // 실제 git 왕복
    // -----------------------------------------------------------------------

    struct Repo {
        _dir: tempfile::TempDir,
        root: PathBuf,
        app_data: PathBuf,
    }

    /// 사용자 설정과 무관한 저장소를 만든다. git이 없으면 `None`이라 호출부가 시험을 건너뛴다.
    fn init_repo() -> Option<Repo> {
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return None;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path())
            .expect("root")
            .join("repo");
        let app_data = std::fs::canonicalize(dir.path())
            .expect("root")
            .join("app-data");
        std::fs::create_dir_all(&root).expect("repo");
        std::fs::create_dir_all(&app_data).expect("app data");
        let outcome = run_capped_with(
            &executable,
            &["init", "-q", "-b", "main"],
            READ_TIMEOUT,
            &CappedOptions {
                current_dir: Some(&root),
                env: &test_env(),
                ..CappedOptions::default()
            },
        )
        .expect("git init");
        assert!(outcome.success, "{}", outcome.stderr);
        Some(Repo {
            _dir: dir,
            root,
            app_data,
        })
    }

    fn test_env() -> Vec<(String, String)> {
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

    fn runner(repo: &Repo) -> GitRunner {
        match GitRunner::open_with_env(&repo.app_data, &repo.root, test_env()) {
            Ok(runner) => runner,
            Err(failure) => panic!("{}", CoreError::from(failure)),
        }
    }

    #[test]
    fn read_target_opens_only_worktrees_listed_by_the_project_repository() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        std::fs::write(repo.root.join("a.txt"), "one\n").expect("a");
        stage_with(&git, &["a.txt".into()]).expect("stage");
        assert!(commit_with(&git, "first").expect("commit").succeeded);
        let parent = repo.root.parent().expect("parent").to_path_buf();
        let linked = parent.join("linked");
        let added = git
            .read(
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    "side",
                    &linked.to_string_lossy(),
                ],
                READ_TIMEOUT,
            )
            .expect("worktree add");
        assert!(added.success, "{}", added.stderr);
        std::fs::write(linked.join("a.txt"), "two\n").expect("edit in worktree");

        // 프로젝트 자신은 변경이 없고, 워크트리를 고르면 그쪽 변경이 보인다.
        let own = project_git_status(&repo.app_data, &repo.root, None).expect("own status");
        assert_eq!(own.unstaged_count, 0);
        let linked_text = linked.to_string_lossy().into_owned();
        let status = project_git_status(&repo.app_data, &repo.root, Some(&linked_text))
            .expect("worktree status");
        assert_eq!(status.unstaged_count, 1);
        assert_eq!(status.head.branch.as_deref(), Some("side"));
        let diff = project_git_diff(
            &repo.app_data,
            &repo.root,
            &ProjectGitDiffRequest {
                project_path: String::new(),
                worktree_path: Some(linked_text),
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: None,
                range_from: None,
                range_to: None,
                full_context: false,
            },
        )
        .expect("worktree diff");
        assert!(diff.patch.contains("+two"), "{}", diff.patch);

        // 목록에 없는 저장소·폴더는 열지 않는다(G10).
        let other = parent.join("other");
        std::fs::create_dir_all(&other).expect("other");
        let other_git = run_capped_with(
            &git.executable,
            &["init", "-q"],
            READ_TIMEOUT,
            &CappedOptions {
                current_dir: Some(&other),
                env: &test_env(),
                ..CappedOptions::default()
            },
        )
        .expect("git init other");
        assert!(other_git.success, "{}", other_git.stderr);
        for bad in [
            other.to_string_lossy().into_owned(),
            parent.join("missing").to_string_lossy().into_owned(),
        ] {
            let error = project_git_status(&repo.app_data, &repo.root, Some(&bad))
                .expect_err("unlisted path must be refused");
            assert!(error.to_string().contains("워크트리가 아닙니다"), "{error}");
        }

        // 목록 항목을 다른 저장소로 돌려놓아도(관리 파일 변조) 그 저장소는 열지 않는다.
        let admin = repo.root.join(".git/worktrees/linked/gitdir");
        let original_admin = std::fs::read_to_string(&admin).expect("gitdir");
        std::fs::write(&admin, format!("{}\n", other.join(".git").display())).expect("forge");
        let other_text = other.to_string_lossy().into_owned();
        assert!(project_git_status(&repo.app_data, &repo.root, Some(&other_text)).is_err());
        std::fs::write(&admin, original_admin).expect("restore");

        // 프로젝트 안의 워크트리가 `.git` 파일을 잃으면 발견이 프로젝트 저장소로 올라간다 —
        // 그걸 워크트리라고 보여 주지 않는다.
        let inner = repo.root.join(".rounds").join("wt");
        let added = git
            .read(
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    "inner",
                    &inner.to_string_lossy(),
                ],
                READ_TIMEOUT,
            )
            .expect("inner worktree add");
        assert!(added.success, "{}", added.stderr);
        let inner_text = inner.to_string_lossy().into_owned();
        assert!(project_git_status(&repo.app_data, &repo.root, Some(&inner_text)).is_ok());
        std::fs::remove_file(inner.join(".git")).expect("drop .git file");
        assert!(project_git_status(&repo.app_data, &repo.root, Some(&inner_text)).is_err());
    }

    #[test]
    fn c16_real_git_round_trip() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        // 첫 커밋 전: unborn, 빈 log.
        let overview = overview_with(&git).expect("overview");
        assert!(overview.head.unborn);
        assert!(overview.local_branches.is_empty());
        let log = log_with(
            &git,
            &ProjectGitLogRequest {
                project_path: String::new(),
                reference: None,
                limit: None,
                skip: None,
            },
        )
        .expect("log");
        assert!(log.commits.is_empty());

        // 파일 → untracked → stage → commit.
        std::fs::write(repo.root.join("a.txt"), "one\n").expect("a");
        let status = status_with(&git).expect("status");
        assert_eq!(status.untracked_count, 1);
        let diff = diff_with(
            &git,
            &ProjectGitDiffRequest {
                project_path: String::new(),
                worktree_path: None,
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: None,
                range_from: None,
                range_to: None,
                full_context: false,
            },
        )
        .expect("diff");
        assert_eq!(diff.kind, GitDiffKind::Untracked);
        let staged = stage_with(&git, &["a.txt".into()]).expect("stage");
        assert!(staged.succeeded, "{}", staged.stderr);
        assert_eq!(status_with(&git).expect("status").staged_count, 1);
        let unstaged = unstage_with(&git, &["a.txt".into()]).expect("unstage before first commit");
        assert!(unstaged.succeeded, "{}", unstaged.stderr);
        assert_eq!(status_with(&git).expect("status").untracked_count, 1);
        stage_with(&git, &["a.txt".into()]).expect("stage again");
        let empty = commit_with(&git, "   ");
        assert!(empty.is_err());
        let commit = commit_with(&git, "첫 커밋\n\n본문").expect("commit");
        assert!(commit.succeeded, "{}", commit.stderr);
        assert!(commit.head_before.is_none());
        let first_sha = commit.head_after.clone().expect("head after");
        let nothing = commit_with(&git, "again").expect("nothing to commit");
        assert_eq!(nothing.outcome, GitOutcome::NothingToCommit);

        let log = log_with(
            &git,
            &ProjectGitLogRequest {
                project_path: String::new(),
                reference: None,
                limit: Some(1),
                skip: None,
            },
        )
        .expect("log");
        assert_eq!(log.commits.len(), 1);
        assert_eq!(log.commits[0].sha, first_sha);
        assert_eq!(log.commits[0].subject, "첫 커밋");
        assert_eq!(log.commits[0].body, "본문");
        assert!(!log.has_more);
        let files = commit_files_with(&git, &first_sha).expect("commit files");
        assert_eq!(files.files.len(), 1);
        assert_eq!(files.files[0].path, "a.txt");
        assert_eq!(files.files[0].status, GitChangeKind::Added);
        let shown = diff_with(
            &git,
            &ProjectGitDiffRequest {
                project_path: String::new(),
                worktree_path: None,
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: Some(first_sha.clone()),
                range_from: None,
                range_to: None,
                full_context: false,
            },
        )
        .expect("commit diff");
        assert_eq!(shown.kind, GitDiffKind::Text);
        assert!(shown.patch.contains("+one"));
        assert!(commit_files_with(&git, "nope").is_err());

        // 스테이지된 diff.
        std::fs::write(repo.root.join("a.txt"), "one\ntwo\n").expect("a2");
        let diff = diff_with(
            &git,
            &ProjectGitDiffRequest {
                project_path: String::new(),
                worktree_path: None,
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: None,
                range_from: None,
                range_to: None,
                full_context: false,
            },
        )
        .expect("diff");
        assert_eq!(diff.kind, GitDiffKind::Text);
        assert!(diff.patch.contains("+two"));

        // 브랜치 만들기·전환. 더러운 트리에서 전환은 git이 허용(변경이 겹치지 않음).
        let created = switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "feature".into(),
                create: true,
                start_point: Some("HEAD".into()),
            },
        )
        .expect("switch -c");
        assert!(created.succeeded, "{}", created.stderr);
        assert_eq!(
            overview_with(&git)
                .expect("overview")
                .head
                .branch
                .as_deref(),
            Some("feature")
        );
        assert!(switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "--orphan".into(),
                create: false,
                start_point: None
            }
        )
        .is_err());

        // 스태시 push/pop.
        let stashed = stash_with(
            &git,
            &ProjectGitStashRequest {
                project_path: String::new(),
                action: GitStashAction::Push,
                message: Some("보관".into()),
                include_untracked: false,
                index: None,
                expected_sha: None,
            },
        )
        .expect("stash push");
        assert!(stashed.succeeded, "{}", stashed.stderr);
        let overview = overview_with(&git).expect("overview");
        assert_eq!(overview.stashes.len(), 1);
        assert!(overview.stashes[0].message.contains("보관"));
        let stale = stash_with(
            &git,
            &ProjectGitStashRequest {
                project_path: String::new(),
                action: GitStashAction::Pop,
                message: None,
                include_untracked: false,
                index: Some(0),
                expected_sha: Some("0000000000000000000000000000000000000000".into()),
            },
        );
        assert!(stale.is_err(), "expectedSha 불일치는 거절");
        let popped = stash_with(
            &git,
            &ProjectGitStashRequest {
                project_path: String::new(),
                action: GitStashAction::Pop,
                message: None,
                include_untracked: false,
                index: Some(0),
                expected_sha: Some(overview.stashes[0].sha.clone()),
            },
        )
        .expect("stash pop");
        assert!(popped.succeeded, "{}", popped.stderr);
        assert_eq!(status_with(&git).expect("status").unstaged_count, 1);
        let none = stash_with(
            &git,
            &ProjectGitStashRequest {
                project_path: String::new(),
                action: GitStashAction::Push,
                message: None,
                include_untracked: false,
                index: None,
                expected_sha: None,
            },
        )
        .expect("push again");
        assert!(none.succeeded);
        let drop = stash_with(
            &git,
            &ProjectGitStashRequest {
                project_path: String::new(),
                action: GitStashAction::Drop,
                message: None,
                include_untracked: false,
                index: Some(0),
                expected_sha: None,
            },
        )
        .expect("drop");
        assert!(drop.succeeded, "{}", drop.stderr);
        assert!(drop.dropped_stash_sha.is_some());

        // 두 브랜치가 같은 줄을 고쳐 충돌하는 리베이스 → conflict → abort → HEAD 복원.
        std::fs::write(repo.root.join("a.txt"), "one\nfeature\n").expect("feature edit");
        stage_with(&git, &["a.txt".into()]).expect("stage feature");
        let feature_commit = commit_with(&git, "feature 변경").expect("feature commit");
        assert!(feature_commit.succeeded);
        let feature_sha = feature_commit.head_after.clone().expect("feature sha");
        assert!(
            switch_with(
                &git,
                &ProjectGitSwitchRequest {
                    project_path: String::new(),
                    branch: "main".into(),
                    create: false,
                    start_point: None
                }
            )
            .expect("switch main")
            .succeeded
        );
        std::fs::write(repo.root.join("a.txt"), "one\nmain\n").expect("main edit");
        stage_with(&git, &["a.txt".into()]).expect("stage main");
        assert!(
            commit_with(&git, "main 변경")
                .expect("main commit")
                .succeeded
        );
        assert!(
            switch_with(
                &git,
                &ProjectGitSwitchRequest {
                    project_path: String::new(),
                    branch: "feature".into(),
                    create: false,
                    start_point: None
                }
            )
            .expect("switch feature")
            .succeeded
        );
        let rebase = rebase_with(
            &git,
            &ProjectGitRebaseRequest {
                project_path: String::new(),
                action: GitRebaseAction::Start,
                onto: Some("main".into()),
            },
        )
        .expect("rebase");
        assert_eq!(rebase.outcome, GitOutcome::Conflict, "{}", rebase.stderr);
        assert_eq!(rebase.conflicted_files, vec!["a.txt"]);
        let progress = overview_with(&git)
            .expect("overview")
            .in_progress
            .expect("in progress");
        assert!(matches!(
            progress.kind,
            GitInProgressKind::Rebase | GitInProgressKind::RebaseInteractive
        ));
        assert_eq!(status_with(&git).expect("status").conflicted_count, 1);
        assert!(rebase_with(
            &git,
            &ProjectGitRebaseRequest {
                project_path: String::new(),
                action: GitRebaseAction::Start,
                onto: Some("main".into())
            }
        )
        .is_err());
        let aborted = rebase_with(
            &git,
            &ProjectGitRebaseRequest {
                project_path: String::new(),
                action: GitRebaseAction::Abort,
                onto: None,
            },
        )
        .expect("abort");
        assert!(aborted.succeeded, "{}", aborted.stderr);
        assert_eq!(aborted.head_after.as_deref(), Some(feature_sha.as_str()));
        assert!(overview_with(&git).expect("overview").in_progress.is_none());

        // 원격이 없으니 fetch는 remote 해석에서 실패하고, push 검증도 같은 자리에서 멈춘다.
        assert!(git.resolve_remote(None).is_err());
        assert!(git.resolve_remote(Some("origin")).is_err());

        // 존재하지 않는 ref.
        assert!(git.verify_commit_ref("nope").is_err());
    }

    /// B8. 비교는 커밋만이 아니라 **방향마다 바뀌는 파일 요약**도 갈라 싣는다.
    ///
    /// 2026-10-04에 이 시험이 붙은 이유: B6이 커밋 목록을 갈라 주고 나서도 화면이 답하지 못하는
    /// 질문이 하나 남아 있었다 — "지금 pull하면 내가 건드리고 있는 파일이 바뀌는가". 커밋 제목
    /// 세 줄로는 알 수 없고, 사용자는 pull을 누른 뒤에야 충돌로 그 사실을 알게 된다.
    ///
    /// 고정하는 것은 문구가 아니라 **범위**다. 구현은 `git diff from...to`(세 점)를 쓴다.
    /// 두 점(`from..to`)으로 쓰면 git은 두 끝점을 그냥 비교하므로, 수신 요약에 **내 쪽에만 있는
    /// 커밋이 만든 파일이 반대 상태로 섞여 들어온다** — 여기서는 c.txt·d.txt가 수신 쪽에 삭제로
    /// 찍힌다. 그래서 이 시험은 양쪽이 분기한 상태를 실제 git으로 만들어 두고, 수신 요약이
    /// 정확히 그쪽 커밋이 만든 파일 하나뿐임을 본다. 한 글자(`.`)만 빠져도 여기서 걸린다.
    #[test]
    fn project_branch_comparison_summarizes_files_per_direction() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        let write = |name: &str, body: &str| {
            std::fs::write(repo.root.join(name), body).expect("write");
            stage_with(&git, &[name.to_owned()]).expect("stage");
        };
        write(
            "a.txt", "one
",
        );
        commit_with(&git, "base").expect("base");

        let branched = git
            .read(
                &["branch", "upstream-side", "--end-of-options"],
                READ_TIMEOUT,
            )
            .expect("branch");
        assert!(branched.success, "{}", branched.stderr);

        // upstream 쪽: 파일 하나를 새로 만든다 — 받으면 생기는 파일.
        let switched = switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "upstream-side".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("switch");
        assert!(switched.succeeded, "{}", switched.stderr);
        write(
            "theirs.txt",
            "theirs
",
        );
        commit_with(&git, "그쪽 커밋").expect("theirs");

        // 내 쪽: 기존 파일을 고치고 새 파일 하나를 만든다 — 보내면 반영되는 파일 둘.
        switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "main".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("switch back");
        write(
            "a.txt",
            "one
mine
",
        );
        write(
            "mine.txt", "mine
",
        );
        commit_with(&git, "내 커밋").expect("mine");

        let split = branch_comparison_with(
            &git,
            &ProjectGitComparisonRequest {
                project_path: String::new(),
                branch: None,
                upstream: Some("upstream-side".into()),
                limit: None,
            },
        )
        .expect("comparison");
        assert!(split.diverged, "양쪽 다 커밋이 있어야 범위가 갈라진다");

        let incoming: Vec<&str> = split
            .incoming_files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            incoming,
            vec!["theirs.txt"],
            "수신 요약은 merge-base..upstream이다 — 내 쪽 커밋이 만든 파일이 섞이면 두 점 범위를 쓴 것이다"
        );
        assert_eq!(split.incoming_files[0].status, GitChangeKind::Added);

        let mut outgoing: Vec<&str> = split
            .outgoing_files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        outgoing.sort_unstable();
        assert_eq!(
            outgoing,
            vec!["a.txt", "mine.txt"],
            "송신 요약은 merge-base..branch다"
        );
        assert!(!split.incoming_files_truncated && !split.outgoing_files_truncated);

        // 방향을 바꿔 물으면 파일 요약도 커밋 목록과 같이 자리를 맞바꾼다.
        let mirrored = branch_comparison_with(
            &git,
            &ProjectGitComparisonRequest {
                project_path: String::new(),
                branch: Some("upstream-side".into()),
                upstream: Some("main".into()),
                limit: None,
            },
        )
        .expect("mirrored");
        let mirrored_incoming: Vec<&str> = mirrored
            .incoming_files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert!(
            mirrored_incoming.contains(&"mine.txt"),
            "기준을 바꾸면 내 파일이 수신 쪽으로 간다"
        );

        // upstream이 없는 빈 비교에는 요약도 비어 있다 — 오류가 아니다.
        let none = branch_comparison_with(
            &git,
            &ProjectGitComparisonRequest {
                project_path: String::new(),
                branch: None,
                upstream: None,
                limit: None,
            },
        )
        .expect("no upstream");
        assert!(none.no_upstream);
        assert!(none.incoming_files.is_empty() && none.outgoing_files.is_empty());
    }

    #[test]
    fn full_context_diff_keeps_the_whole_file_around_changes() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        let before = (1..=12)
            .map(|line| format!("original line {line}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(repo.root.join("whole.txt"), before).expect("write original");
        stage_with(&git, &["whole.txt".into()]).expect("stage original");
        commit_with(&git, "whole file base").expect("commit original");
        let after = (1..=12)
            .map(|line| {
                if line == 6 {
                    "changed line 6".to_owned()
                } else {
                    format!("original line {line}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(repo.root.join("whole.txt"), after).expect("change middle");
        let request = |full_context| ProjectGitDiffRequest {
            project_path: String::new(),
            worktree_path: None,
            path: "whole.txt".into(),
            original_path: None,
            staged: false,
            commit: None,
            range_from: None,
            range_to: None,
            full_context,
        };

        let compact = diff_with(&git, &request(false)).expect("compact diff");
        assert!(!compact.patch.contains("original line 1\n"));
        assert!(!compact.patch.contains("original line 12\n"));

        let full = diff_with(&git, &request(true)).expect("full-context diff");
        assert!(full.patch.contains(" original line 1\n"), "{}", full.patch);
        assert!(full.patch.contains(" original line 12\n"), "{}", full.patch);
        assert!(full.patch.contains("-original line 6\n"), "{}", full.patch);
        assert!(full.patch.contains("+changed line 6\n"), "{}", full.patch);
    }

    /// B9. 비교 요약이 집은 파일을 **그 요약과 같은 범위로** 연다.
    ///
    /// 2026-10-04에 이 시험이 붙은 이유: B8이 방향별 파일 목록을 실었지만 화면은 그것을
    /// `<span>`으로만 그렸고, 바로 위 주석이 왜 버튼이 아닌지 적어 두었다 — "요약은 merge-base
    /// 부터 끝점까지 한 범위라 커밋 하나의 diff를 여는 버튼으로 만들면 그 커밋이 건드리지 않은
    /// 파일에도 빈 diff가 열려 거짓말이 된다". 진단은 맞았고, 답은 버튼을 포기하는 것이 아니라
    /// 범위를 여는 길을 내는 것이었다. `ProjectGitDiffRequest`는 작업 트리·인덱스·커밋 하나까지만
    /// 볼 수 있었다.
    ///
    /// 고정하는 것은 셋이고, 전부 **틀렸을 때 조용한** 자리다.
    ///
    /// 1. **세 점이어야 한다.** `range_files`(B8)가 `from...to`로 목록을 뽑으므로 본문을 두 점
    ///    (`from..to`)으로 열면 목록과 본문이 어긋난다. 수신 쪽에서 특히 나쁘다 — 두 점은 내
    ///    커밋이 만든 파일을 반대 방향으로 뒤집어 싣기 때문에, "받으면 생긴다"고 요약이 말한
    ///    파일을 눌렀을 때 "삭제된다"는 diff가 열린다. 여기서는 내 쪽에만 있는 `mine.txt`를
    ///    수신 범위로 열어 **빈 diff**가 나오는지 본다. 두 점으로 바꾸면 이 단언이 삭제
    ///    패치를 받아 실패한다.
    /// 2. **반쪽 요청은 거절한다.** 한쪽 끝점만 온 요청을 반대쪽 기본값(HEAD 등)으로 메우면
    ///    호출자가 믿는 범위와 다른 diff가 열리는데, 그것이 1번이 막으려는 거짓말과 같은
    ///    모양이다. 오류가 아니라 가정으로 때우는 쪽이 더 나쁘다.
    /// 3. **`staged`·`commit`과 섞이지 않는다.** 셋 다 argv의 같은 자리를 다투므로 조용히
    ///    한쪽이 이기면 어느 범위가 열렸는지 아무도 모른다.
    #[test]
    fn project_branch_comparison_opens_range_diff_for_each_file() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        let write = |name: &str, body: &str| {
            std::fs::write(repo.root.join(name), body).expect("write");
            stage_with(&git, &[name.to_owned()]).expect("stage");
        };
        write(
            "a.txt", "one
",
        );
        commit_with(&git, "base").expect("base");
        let branched = git
            .read(
                &["branch", "upstream-side", "--end-of-options"],
                READ_TIMEOUT,
            )
            .expect("branch");
        assert!(branched.success, "{}", branched.stderr);

        // upstream 쪽에만 있는 파일.
        switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "upstream-side".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("switch");
        write(
            "theirs.txt",
            "theirs
",
        );
        commit_with(&git, "그쪽 커밋").expect("theirs");

        // 내 쪽에만 있는 파일.
        switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "main".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("switch back");
        write(
            "mine.txt", "mine
",
        );
        commit_with(&git, "내 커밋").expect("mine");

        let range = |path: &str, from: &str, to: &str| {
            diff_with(
                &git,
                &ProjectGitDiffRequest {
                    project_path: String::new(),
                    worktree_path: None,
                    path: path.into(),
                    original_path: None,
                    staged: false,
                    commit: None,
                    range_from: Some(from.into()),
                    range_to: Some(to.into()),
                    full_context: false,
                },
            )
        };

        // 수신 범위(main...upstream-side)에서 그쪽 파일은 추가로 열린다.
        let theirs = range("theirs.txt", "main", "upstream-side").expect("incoming diff");
        assert_eq!(theirs.kind, GitDiffKind::Text);
        assert!(
            theirs.patch.contains("+theirs"),
            "수신 요약이 '추가'라고 한 파일은 추가 패치로 열려야 한다: {}",
            theirs.patch
        );

        // 같은 범위에서 **내 쪽에만 있는** 파일은 비어 있다. 두 점으로 열면 여기에 삭제
        // 패치가 실려 요약과 반대되는 화면이 된다.
        let mine_in_incoming = range("mine.txt", "main", "upstream-side").expect("three-dot");
        assert_eq!(
            mine_in_incoming.kind,
            GitDiffKind::Empty,
            "세 점이 아니면 내 커밋이 만든 파일이 수신 범위에서 '삭제'로 열린다: {}",
            mine_in_incoming.patch
        );

        // 방향을 바꾸면 그 파일이 송신 범위에서 추가로 열린다.
        let mine_out = range("mine.txt", "upstream-side", "main").expect("outgoing diff");
        assert!(mine_out.patch.contains("+mine"), "{}", mine_out.patch);

        // 반쪽 요청은 거절한다 — 반대쪽을 가정해 메우지 않는다.
        let half = diff_with(
            &git,
            &ProjectGitDiffRequest {
                project_path: String::new(),
                worktree_path: None,
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: None,
                range_from: Some("main".into()),
                range_to: None,
                full_context: false,
            },
        );
        assert!(
            matches!(half, Err(CoreError::InvalidInput(_))),
            "끝점 하나만 온 요청은 거절해야 한다"
        );

        // staged·commit 과는 상호배타다.
        let mixed = diff_with(
            &git,
            &ProjectGitDiffRequest {
                project_path: String::new(),
                worktree_path: None,
                path: "a.txt".into(),
                original_path: None,
                staged: true,
                commit: None,
                range_from: Some("main".into()),
                range_to: Some("upstream-side".into()),
                full_context: false,
            },
        );
        assert!(
            matches!(mixed, Err(CoreError::InvalidInput(_))),
            "staged 와 범위를 함께 받으면 어느 범위가 열렸는지 알 수 없다"
        );

        // 끝점은 C16-5 대로 검증된다 — 없는 ref 는 거절한다.
        assert!(range("a.txt", "main", "없는가지").is_err());
    }

    /// B6/B7. 비교는 수신(`HEAD..upstream`)과 송신(`upstream..HEAD`)으로 갈려 나온다.
    ///
    /// 2026-10-02에 이 시험이 붙은 이유: 그때까지 화면이 쓸 수 있는 수치는 `GitUpstream`의
    /// `ahead`/`behind` 두 숫자뿐이었고, 어떤 커밋이 오고 어떤 커밋이 나가는지는 어디서도
    /// 답하지 않았다. 한 숫자로 합친 "3 커밋 차이"는 사용자가 pull을 눌러야 하는지 push를
    /// 눌러야 하는지 말해 주지 못한다.
    ///
    /// 그래서 문구가 아니라 **방향이 뒤집히지 않는 것**을 고정한다. 여기서는 upstream에만 있는
    /// 커밋 하나와 로컬에만 있는 커밋 둘을 실제 git으로 만들어 두고, 각 목록에 들어온 SHA가
    /// 정확히 그 커밋인지 본다. 수를 세는 자리(`rev-list --left-right`)와 목록을 뽑는
    /// 자리(`log from..to`)가 따로라 한쪽만 뒤집히는 실수가 실제로 가능하고, 그때 개수는
    /// 맞는데 내용이 반대인 화면이 된다.
    #[test]
    fn project_branch_comparison_splits_incoming_and_outgoing() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        let ask = |branch: Option<&str>, upstream: Option<&str>| {
            branch_comparison_with(
                &git,
                &ProjectGitComparisonRequest {
                    project_path: String::new(),
                    branch: branch.map(str::to_owned),
                    upstream: upstream.map(str::to_owned),
                    limit: None,
                },
            )
        };

        // 첫 커밋 전에는 비교할 브랜치가 없다 — 오류가 아니라 빈 비교다.
        let unborn = ask(None, None).expect("unborn");
        assert!(unborn.no_upstream);
        assert!(unborn.incoming.is_empty() && unborn.outgoing.is_empty());

        let write = |name: &str, body: &str| {
            std::fs::write(repo.root.join(name), body).expect("write");
            stage_with(&git, &[name.to_owned()]).expect("stage");
        };
        write("a.txt", "one\n");
        commit_with(&git, "base").expect("base");

        // 원격 대신 같은 저장소의 다른 브랜치를 upstream으로 쓴다. 비교가 묻는 것은 두 ref의
        // 관계뿐이라 네트워크가 필요 없고, 시험이 원격 상태에 의존하지 않는다.
        let branched = git
            .read(
                &["branch", "upstream-side", "--end-of-options"],
                READ_TIMEOUT,
            )
            .expect("branch");
        assert!(branched.success, "{}", branched.stderr);

        // upstream 쪽에 커밋 하나 — 받아야 할 것.
        let switched = switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "upstream-side".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("switch");
        assert!(switched.succeeded, "{}", switched.stderr);
        write("b.txt", "theirs\n");
        let theirs = commit_with(&git, "그쪽 커밋").expect("theirs");
        let theirs_sha = theirs.head_after.clone().expect("theirs sha");

        // main으로 돌아와 커밋 둘 — 보내야 할 것.
        switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "main".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("switch back");
        write("c.txt", "mine one\n");
        let mine_one = commit_with(&git, "내 커밋 1").expect("mine one");
        let mine_one_sha = mine_one.head_after.clone().expect("mine one sha");
        write("d.txt", "mine two\n");
        let mine_two = commit_with(&git, "내 커밋 2").expect("mine two");
        let mine_two_sha = mine_two.head_after.clone().expect("mine two sha");

        let split = ask(None, Some("upstream-side")).expect("comparison");
        assert!(!split.no_upstream);
        assert_eq!(split.branch.as_deref(), Some("main"));
        assert_eq!(split.upstream.as_deref(), Some("upstream-side"));
        assert_eq!(
            (split.incoming_count, split.outgoing_count),
            (1, 2),
            "수신은 upstream에만, 송신은 branch에만 있는 커밋 수다"
        );
        assert!(split.diverged, "양쪽 다 0이 아니면 fast-forward가 아니다");
        let incoming: Vec<&str> = split.incoming.iter().map(|c| c.sha.as_str()).collect();
        let outgoing: Vec<&str> = split.outgoing.iter().map(|c| c.sha.as_str()).collect();
        assert_eq!(
            incoming,
            vec![theirs_sha.as_str()],
            "수신은 그쪽 커밋뿐이다"
        );
        assert_eq!(
            outgoing,
            vec![mine_two_sha.as_str(), mine_one_sha.as_str()],
            "송신은 내 커밋 둘, 최신이 먼저다"
        );
        assert!(!split.incoming_truncated && !split.outgoing_truncated);

        // 방향을 바꿔 물으면 두 목록도 그대로 뒤집힌다 — 어느 쪽이 기준인지가 수치의 의미다.
        let mirrored = ask(Some("upstream-side"), Some("main")).expect("mirrored");
        assert_eq!(
            (mirrored.incoming_count, mirrored.outgoing_count),
            (2, 1),
            "기준을 바꾸면 수신과 송신이 자리를 맞바꾼다"
        );

        // limit은 목록만 자르고 수치는 전체를 말한다 — 화면이 "2건 중 1건"을 그릴 수 있어야 한다.
        let capped = branch_comparison_with(
            &git,
            &ProjectGitComparisonRequest {
                project_path: String::new(),
                branch: None,
                upstream: Some("upstream-side".into()),
                limit: Some(1),
            },
        )
        .expect("capped");
        assert_eq!(capped.outgoing.len(), 1);
        assert_eq!(capped.outgoing_count, 2);
        assert!(capped.outgoing_truncated);
        assert!(!capped.incoming_truncated);

        // upstream이 설정되지 않은 브랜치는 빈 비교다. 없는 ref도 오류가 아니라 같은 모양이다.
        let none = ask(None, None).expect("no upstream");
        assert!(none.no_upstream);
        assert_eq!(none.branch.as_deref(), Some("main"));
        assert!(none.upstream.is_none());
        let missing = ask(None, Some("no-such-branch")).expect("missing upstream");
        assert!(missing.no_upstream);
        assert!(missing.incoming.is_empty() && missing.outgoing.is_empty());

        // 범위 문법은 이쪽에서만 만든다 — 입력으로 들어온 `..`은 거절한다(C16-5).
        assert!(ask(None, Some("main..upstream-side")).is_err());
        assert!(ask(Some("-x"), None).is_err());
    }

    #[test]
    fn c16_1_subfolder_targets_the_enclosing_repository_and_bare_is_refused() {
        let Some(repo) = init_repo() else {
            return;
        };
        let nested = repo.root.join("apps/web");
        std::fs::create_dir_all(&nested).expect("nested");
        let git = match GitRunner::open_with_env(&repo.app_data, &nested, test_env()) {
            Ok(runner) => runner,
            Err(failure) => panic!("{}", CoreError::from(failure)),
        };
        assert_eq!(git.root, path_guard::child_facing(&repo.root));

        let plain = repo.root.parent().expect("parent").join("plain");
        std::fs::create_dir_all(&plain).expect("plain");
        match GitRunner::open_with_env(&repo.app_data, &plain, test_env()) {
            Err(GitOpenFailure::Unavailable(GitUnavailableReason::NotRepository, _)) => {}
            Err(GitOpenFailure::Unavailable(reason, detail)) => panic!("{reason:?} {detail}"),
            Err(GitOpenFailure::Error(error)) => panic!("{error}"),
            Ok(_) => panic!("저장소가 아닌 폴더가 열렸다"),
        }
        let overview = project_git_overview(&repo.app_data, &plain).expect("overview");
        assert!(overview.repository.is_none());
        assert_eq!(
            overview.unavailable_reason,
            Some(GitUnavailableReason::NotRepository)
        );

        let bare = repo.root.parent().expect("parent").join("bare.git");
        std::fs::create_dir_all(&bare).expect("bare");
        let executable = resolve_named_executable(&["git"]).expect("git");
        let outcome = run_capped_with(
            &executable,
            &["init", "-q", "--bare"],
            READ_TIMEOUT,
            &CappedOptions {
                current_dir: Some(&bare),
                env: &test_env(),
                ..CappedOptions::default()
            },
        )
        .expect("bare init");
        assert!(outcome.success);
        match GitRunner::open_with_env(&repo.app_data, &bare, test_env()) {
            Err(GitOpenFailure::Unavailable(GitUnavailableReason::BareRepository, _)) => {}
            _ => panic!("bare 저장소는 거절해야 한다"),
        }
    }

    #[test]
    fn c16_1_restricted_roots_are_refused() {
        let Some(repo) = init_repo() else {
            return;
        };
        // 앱 데이터 폴더 자체가 저장소면 보호 루트다.
        let app_repo = repo.app_data.clone();
        let executable = resolve_named_executable(&["git"]).expect("git");
        run_capped_with(
            &executable,
            &["init", "-q"],
            READ_TIMEOUT,
            &CappedOptions {
                current_dir: Some(&app_repo),
                env: &test_env(),
                ..CappedOptions::default()
            },
        )
        .expect("init");
        match GitRunner::open_with_env(&repo.app_data, &app_repo, test_env()) {
            Err(GitOpenFailure::Unavailable(GitUnavailableReason::RestrictedRepository, _)) => {}
            Err(GitOpenFailure::Unavailable(reason, detail)) => panic!("{reason:?} {detail}"),
            Err(GitOpenFailure::Error(error)) => panic!("{error}"),
            Ok(_) => panic!("보호 루트 저장소가 열렸다"),
        }
    }

    #[test]
    fn busy_guard_refuses_overlapping_mutations() {
        let root = PathBuf::from("/tmp/agent-manager-busy-test-root");
        let first = BusyGuard::acquire(&root).expect("first");
        assert!(BusyGuard::acquire(&root).is_none());
        drop(first);
        assert!(BusyGuard::acquire(&root).is_some());
    }

    /// C16-4/C16-6. `pull`은 실제 원격을 상대로 한 번도 돌아 본 적이 없었다.
    ///
    /// 2026-10-04 실측으로 확인한 공백: 이 모듈의 실제 git 왕복 시험들은 **원격을 만들지
    /// 않는다.** `c16_real_git_round_trip`은 "원격이 없으니 fetch는 remote 해석에서 실패한다"로
    /// 끝나고, 비교 시험 셋은 원격 대신 같은 저장소의 다른 브랜치를 upstream 자리에 세운다.
    /// 그래서 `fetch_project_git`·`pull_project_git`의 인수 벡터는 `resolve_remote`가 거절하는
    /// 지점 너머로 단 한 번도 실행된 적이 없었다.
    ///
    /// 그 공백이 가리는 것이 둘이다.
    ///
    /// 첫째, **C16-4의 pull 모드**다. 기본은 `--ff-only --no-rebase`이고 요청이 있을 때만
    /// `--rebase --no-autostash`인데, 어느 쪽도 실행된 적이 없으니 두 인수가 실제로 그 효과를
    /// 내는지는 아무도 확인하지 않았다. `--ff-only`가 빠지면 분기한 상태에서 pull이 **병합
    /// 커밋을 만들며 성공한다** — 사용자가 고르지 않은 병합이 조용히 생기는 것이고, 영수증은
    /// 그것을 성공으로 적는다.
    ///
    /// 둘째, **C16-6의 결말 분류**다. `failures_are_classified_from_git_wording`은
    /// `classify_failure`에 손으로 적은 문자열을 먹인다. 그 문자열이 **지금 이 git이 실제로
    /// 뱉는 말**과 같은지는 그 시험이 답할 수 없다. 여기서는 진짜로 분기시킨 저장소에
    /// `pull --ff-only`를 걸어, git이 내는 출력 그대로가 `NotFastForward`로 읽히는지 본다.
    /// 어긋나면 `Failed`로 떨어지고, 화면은 "리베이스로 당겨 보라"는 안내 대신 일반 오류를
    /// 띄운다.
    ///
    /// 고정하는 것은 문구가 아니라 **결말과 앵커**다: 분기한 pull은 오류가 아니라 영수증이고
    /// (C16-6), 실패한 pull은 `head_before == head_after`로 HEAD를 움직이지 않으며, 성공한
    /// pull만 HEAD를 옮긴다.
    #[test]
    fn c16_pull_against_a_real_remote_fast_forwards_and_reports_divergence() {
        let Some(repo) = init_repo() else {
            return;
        };
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };
        let git = runner(&repo);
        let workspace = repo.root.parent().expect("workspace").to_path_buf();
        // 원격은 네트워크가 아니라 같은 디스크의 bare 저장소다. git에게 경로 원격과 URL
        // 원격은 같은 자리를 지나므로, 이 시험은 오프라인에서도 pull 경로를 끝까지 민다.
        let remote_path = workspace.join("remote.git");
        let other_path = workspace.join("other");
        let raw = |dir: &Path, args: &[&str]| {
            let outcome = run_capped_with(
                &executable,
                args,
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(dir),
                    env: &test_env(),
                    ..CappedOptions::default()
                },
            )
            .expect("git");
            assert!(outcome.success, "{args:?}: {}", outcome.stderr);
        };
        // 캐노니컬 경로는 Windows에서 \\?\ 접두사를 달고 나오는데, 그대로 슬래시로
        // 바꾸면 git이 //?/C:/... 를 원격으로 읽지 못한다. 자식에게 넘기는 경로는 이미
        // path_guard가 그 접두사를 떼는 자리를 갖고 있으므로 같은 것을 쓴다.
        let remote_arg = path_guard::child_facing(&remote_path)
            .to_string_lossy()
            .replace('\\', "/");

        // 내 쪽 첫 커밋 → bare 원격을 만들고 밀어 둔다.
        std::fs::write(
            repo.root.join("a.txt"),
            "one
",
        )
        .expect("a");
        stage_with(&git, &["a.txt".into()]).expect("stage");
        let first = commit_with(&git, "첫 커밋").expect("commit");
        assert!(first.succeeded, "{}", first.stderr);
        raw(
            &workspace,
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        raw(&repo.root, &["remote", "add", "origin", &remote_arg]);
        let pushed = git
            .read(&["push", "-u", "origin", "main"], NETWORK_TIMEOUT)
            .expect("push");
        assert!(pushed.success, "{}", pushed.stderr);

        // 다른 사람 쪽 작업장. 같은 bare를 복제해 커밋 하나를 올린다.
        raw(&workspace, &["clone", "-q", &remote_arg, "other"]);
        let push_from_other = |name: &str, body: &str, message: &str| {
            std::fs::write(other_path.join(name), body).expect("other write");
            raw(&other_path, &["add", "-A"]);
            raw(&other_path, &["commit", "-q", "-m", message]);
            raw(&other_path, &["push", "-q", "origin", "main"]);
        };
        push_from_other(
            "b.txt",
            "theirs
",
            "그쪽 커밋",
        );

        // fetch는 resolve_remote 너머까지 실제로 간다.
        let fetched = fetch_with(
            &git,
            &ProjectGitFetchRequest {
                project_path: String::new(),
                remote: None,
                prune: false,
            },
        )
        .expect("fetch");
        assert!(fetched.succeeded, "{}", fetched.stderr);
        assert_eq!(fetched.outcome, GitOutcome::Completed);

        // 앞서 있기만 한 상태의 pull은 fast-forward로 끝나고 HEAD가 움직인다.
        let pulled = pull_with(
            &git,
            &ProjectGitPullRequest {
                project_path: String::new(),
                mode: GitPullMode::FfOnly,
                remote: None,
            },
        )
        .expect("ff pull");
        assert!(pulled.succeeded, "{}", pulled.stderr);
        assert_eq!(pulled.outcome, GitOutcome::Completed);
        assert_ne!(
            pulled.head_before, pulled.head_after,
            "fast-forward는 HEAD를 옮긴다"
        );
        assert!(repo.root.join("b.txt").exists(), "받은 파일이 트리에 있다");

        // 양쪽이 갈라진다 — 내 쪽 커밋 하나, 그쪽 커밋 하나.
        std::fs::write(
            repo.root.join("c.txt"),
            "mine
",
        )
        .expect("c");
        stage_with(&git, &["c.txt".into()]).expect("stage mine");
        let mine = commit_with(&git, "내 커밋").expect("mine");
        assert!(mine.succeeded, "{}", mine.stderr);
        let diverged_head = mine.head_after.clone().expect("mine sha");
        push_from_other(
            "d.txt",
            "theirs two
",
            "그쪽 두 번째 커밋",
        );

        // C16-6: 분기한 --ff-only pull은 Err가 아니라 영수증이고, HEAD를 건드리지 않는다.
        // 이 단언이 `classify_failure`의 문구를 실제 git 출력에 묶는 자리다.
        let blocked = pull_with(
            &git,
            &ProjectGitPullRequest {
                project_path: String::new(),
                mode: GitPullMode::FfOnly,
                remote: None,
            },
        )
        .expect("분기한 pull은 오류가 아니라 영수증이다");
        assert!(!blocked.succeeded);
        assert_eq!(
            blocked.outcome,
            GitOutcome::NotFastForward,
            "실제 git 출력이 NotFastForward로 읽혀야 한다: {}",
            blocked.stderr
        );
        assert_eq!(
            blocked.head_before, blocked.head_after,
            "실패한 pull은 HEAD를 옮기지 않는다"
        );
        assert_eq!(blocked.head_after.as_deref(), Some(diverged_head.as_str()));
        assert!(
            !repo.root.join("d.txt").exists(),
            "거절된 pull은 작업 트리에 아무것도 남기지 않는다"
        );

        // --rebase는 같은 분기를 통과시키고, 양쪽 파일이 모두 남는다.
        let rebased = pull_with(
            &git,
            &ProjectGitPullRequest {
                project_path: String::new(),
                mode: GitPullMode::Rebase,
                remote: None,
            },
        )
        .expect("rebase pull");
        assert!(rebased.succeeded, "{}", rebased.stderr);
        assert_eq!(rebased.outcome, GitOutcome::Completed);
        assert_ne!(rebased.head_before, rebased.head_after);
        assert!(repo.root.join("c.txt").exists(), "내 변경이 살아 있다");
        assert!(repo.root.join("d.txt").exists(), "그쪽 변경을 받았다");
        // 리베이스로 당겼으므로 병합 커밋이 아니다 — 부모가 하나다.
        let parents = git
            .read(&["rev-list", "--parents", "-n", "1", "HEAD"], READ_TIMEOUT)
            .expect("parents");
        assert_eq!(
            parents.stdout.split_whitespace().count(),
            2,
            "--rebase는 병합 커밋을 만들지 않는다: {}",
            parents.stdout
        );
    }

    /// C16-4/C16-6. `push`의 refspec 선택은 한 번도 실행된 적이 없었다.
    ///
    /// 2026-10-04 실측. 직전 회차가 `pull`을 실제 bare 원격에 걸면서 "push는 자격증명이
    /// 없어 잴 수 없다"고 적고 `push_with`를 떼지 않았다. 그 판단이 틀렸다 — 경로 원격은
    /// 자격증명을 묻지 않으므로 push 경로도 같은 설비로 끝까지 민다. 그래서 이 모듈에서
    /// `push_project_git`의 본문은 `resolve_remote` 너머로 **단 한 번도 돌아 본 적이 없었다.**
    ///
    /// 그 분기가 무엇을 막고 있는지는 제품 주석이 이미 구체적으로 적어 두었다. 업스트림이
    /// 같은 원격에 있으면 refspec은 `HEAD:refs/heads/<업스트림 브랜치>`이고, 없으면 `HEAD`다.
    /// 이 선택이 중요한 이유는 **로컬 브랜치 이름과 업스트림 브랜치 이름이 다를 때**다.
    /// `HEAD`만 넘기면 git은 같은 이름의 원격 브랜치로 보내므로, 확인창이 "feature →
    /// origin/main"이라고 보여 준 뒤 실제로는 `origin/feature`라는 **새 브랜치를 만든다.**
    /// 사용자가 보낸 적 없는 브랜치가 원격에 생기고, 보내려던 곳은 그대로 뒤처진다.
    /// push는 호스트 전용이고(C16-7) 바깥으로 나가는 유일한 명령이라, 그 대상이 갈리는 것은
    /// 이 어댑터가 낼 수 있는 결과 중 가장 되돌리기 어려운 쪽이다.
    ///
    /// 여기서 고정하는 것은 문구가 아니라 **원격에 실제로 생긴 ref**다. 이름이 다른 업스트림
    /// 위에서 push한 뒤 bare 원격의 ref 목록을 직접 읽어, 업스트림 브랜치만 움직였고
    /// 로컬 이름의 브랜치는 생기지 않았음을 본다. refspec 계산을 `HEAD`로 되돌리면 그 순간
    /// `refs/heads/feature`가 나타나므로 이 시험만 깨진다.
    ///
    /// 두 번째 단언은 C16-6의 `RejectedNonFastForward`를 **실제 git 출력**에 묶는다.
    /// `failures_are_classified_from_git_wording`은 `classify_failure`에 손으로 적은 문자열을
    /// 먹이므로, 그 문구가 지금 이 git이 뱉는 말과 같은지 답할 수 없다. 어긋나면 `Failed`로
    /// 떨어지고 화면은 "먼저 가져와 리베이스하세요" 대신 일반 오류를 띄운다.
    #[test]
    fn c16_push_targets_the_upstream_branch_and_reports_rejection() {
        let Some(repo) = init_repo() else {
            return;
        };
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };
        let git = runner(&repo);
        let workspace = repo.root.parent().expect("workspace").to_path_buf();
        let remote_path = workspace.join("remote.git");
        let other_path = workspace.join("other");
        let raw = |dir: &Path, args: &[&str]| {
            let outcome = run_capped_with(
                &executable,
                args,
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(dir),
                    env: &test_env(),
                    ..CappedOptions::default()
                },
            )
            .expect("git");
            assert!(outcome.success, "{args:?}: {}", outcome.stderr);
        };
        // 캐노니컬 경로의 접두사를 그대로 슬래시로 바꾸면 git이 //?/C:/... 를 원격으로
        // 읽지 못한다(직전 회차의 실측). 자식에게 넘기는 경로를 다듬는 자리를 그대로 쓴다.
        let remote_arg = path_guard::child_facing(&remote_path)
            .to_string_lossy()
            .replace('\\', "/");
        let remote_refs = || {
            let outcome = run_capped_with(
                &executable,
                &["for-each-ref", "--format=%(refname)", "refs/heads"],
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(remote_path.as_path()),
                    env: &test_env(),
                    ..CappedOptions::default()
                },
            )
            .expect("for-each-ref");
            assert!(outcome.success, "{}", outcome.stderr);
            outcome
                .stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };

        std::fs::write(repo.root.join("a.txt"), "one\n").expect("a");
        stage_with(&git, &["a.txt".into()]).expect("stage");
        let first = commit_with(&git, "첫 커밋").expect("commit");
        assert!(first.succeeded, "{}", first.stderr);
        raw(
            &workspace,
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        raw(&repo.root, &["remote", "add", "origin", &remote_arg]);
        let pushed = git
            .read(&["push", "-u", "origin", "main"], NETWORK_TIMEOUT)
            .expect("push");
        assert!(pushed.success, "{}", pushed.stderr);

        // 이름이 다른 로컬 브랜치를 만들고 업스트림은 origin/main 으로 둔다. 화면의 확인창이
        // "feature → origin/main"이라고 말하게 되는 바로 그 상태다.
        let switched = switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "feature".to_owned(),
                create: true,
                start_point: None,
            },
        )
        .expect("switch");
        assert!(switched.succeeded, "{}", switched.stderr);
        raw(&repo.root, &["branch", "--set-upstream-to=origin/main"]);
        std::fs::write(repo.root.join("b.txt"), "mine\n").expect("b");
        stage_with(&git, &["b.txt".into()]).expect("stage mine");
        let mine = commit_with(&git, "내 커밋").expect("mine");
        assert!(mine.succeeded, "{}", mine.stderr);
        let mine_sha = mine.head_after.clone().expect("mine sha");

        let sent = push_with(
            &git,
            &ProjectGitPushRequest {
                project_path: String::new(),
                remote: None,
                set_upstream: false,
            },
        )
        .expect("push");
        assert!(sent.succeeded, "{}", sent.stderr);
        assert_eq!(sent.outcome, GitOutcome::Completed);

        // 원격에 실제로 생긴 ref 가 판정이다. 로컬 이름으로 새 브랜치가 생기면 안 된다.
        assert_eq!(
            remote_refs(),
            vec!["refs/heads/main".to_owned()],
            "업스트림 브랜치만 움직여야 한다 — 로컬 이름의 브랜치가 생기면 사용자가 보낸 적 없는 브랜치가 원격에 남는다"
        );
        let landed = run_capped_with(
            &executable,
            &["rev-parse", "refs/heads/main"],
            READ_TIMEOUT,
            &CappedOptions {
                current_dir: Some(remote_path.as_path()),
                env: &test_env(),
                ..CappedOptions::default()
            },
        )
        .expect("rev-parse");
        assert_eq!(
            landed.stdout.trim(),
            mine_sha,
            "업스트림 브랜치가 내 커밋을 가리켜야 한다"
        );

        // C16-6: 원격이 앞서면 push 는 Err 가 아니라 RejectedNonFastForward 영수증이다.
        raw(&workspace, &["clone", "-q", &remote_arg, "other"]);
        std::fs::write(other_path.join("c.txt"), "theirs\n").expect("other write");
        raw(&other_path, &["add", "-A"]);
        raw(&other_path, &["commit", "-q", "-m", "그쪽 커밋"]);
        raw(&other_path, &["push", "-q", "origin", "main"]);
        std::fs::write(repo.root.join("d.txt"), "mine two\n").expect("d");
        stage_with(&git, &["d.txt".into()]).expect("stage d");
        let second = commit_with(&git, "내 두 번째 커밋").expect("second");
        assert!(second.succeeded, "{}", second.stderr);

        let rejected = push_with(
            &git,
            &ProjectGitPushRequest {
                project_path: String::new(),
                remote: None,
                set_upstream: false,
            },
        )
        .expect("거절된 push 는 오류가 아니라 영수증이다");
        assert!(!rejected.succeeded);
        assert_eq!(
            rejected.outcome,
            GitOutcome::RejectedNonFastForward,
            "실제 git 출력이 RejectedNonFastForward 로 읽혀야 한다: {}",
            rejected.stderr
        );
        assert_eq!(
            rejected.head_before, rejected.head_after,
            "거절된 push 는 로컬 HEAD 를 움직이지 않는다"
        );
        // 거절은 원격도 그대로 둔다 — C16-4 가 어떤 --force* 도 내밀지 않는 이유가 이것이다.
        assert_eq!(
            remote_refs(),
            vec!["refs/heads/main".to_owned()],
            "거절된 push 가 원격에 브랜치를 남기지 않는다"
        );

        // 같은 `upstream_short` 를 쓰는 두 번째 자리. 원격이 둘이면 `resolve_remote` 는
        // 업스트림이 가리키는 원격을 골라야 하고, 고르지 못하면 "원격을 지정하세요" 로
        // 거절한다. 업스트림 이름이 깨져 있던 동안에는 원격이 하나일 때만 우연히 돌았다.
        raw(
            &workspace,
            &["init", "-q", "--bare", "-b", "main", "spare.git"],
        );
        let spare_arg = path_guard::child_facing(&workspace.join("spare.git"))
            .to_string_lossy()
            .replace('\\', "/");
        raw(&repo.root, &["remote", "add", "spare", &spare_arg]);
        let fetched = fetch_with(
            &git,
            &ProjectGitFetchRequest {
                project_path: String::new(),
                remote: None,
                prune: false,
            },
        )
        .expect("원격이 둘이어도 업스트림의 원격을 고른다");
        assert!(fetched.succeeded, "{}", fetched.stderr);
    }

    /// C16-10 — "git 원격용" SSH 키가 닿는 범위를 자식이 실제로 받은 환경으로 잰다.
    ///
    /// 수용 기준의 핵심은 "**프로젝트 git의 네트워크 작업에만**"이다. 그 문장은 소스를
    /// 읽어서는 확인되지 않는다 — `env()` 한 자리를 고치면 읽기와 로컬 변경까지 같은 변수를
    /// 받게 되고, 그래도 어떤 시험도 깨지지 않았다. 그래서 여기서는 한 번의 왕복에서 읽기
    /// (`status`), 로컬 변경(`stage`·`commit`), 네트워크 변경(`fetch`)을 모두 돌리고, 기록된
    /// 호출마다 `GIT_SSH_COMMAND`가 있는지를 argv의 앞머리로 가른다.
    ///
    /// 상속분도 함께 본다. 백엔드가 `GIT_SSH_COMMAND`를 물려받고 있으면 그것이 모든 호출에
    /// 적용되어 사용자가 고른 키와 다른 신원으로 붙는다. 그래서 그 이름이 `REMOVED_ENV`에
    /// 있는지도 같은 자리에서 못박는다 — 제거가 설정보다 먼저 도므로 우리 값은 살아남는다.
    #[test]
    fn c16_10_git_identity_reaches_only_network_calls_and_inherited_ones_are_removed() {
        let Some(repo) = init_repo() else {
            return;
        };
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };
        let git = runner(&repo);
        let workspace = repo.root.parent().expect("workspace").to_path_buf();
        let remote_path = workspace.join("remote.git");
        let outcome = run_capped_with(
            &executable,
            &[
                "init",
                "-q",
                "--bare",
                remote_path.to_string_lossy().as_ref(),
            ],
            READ_TIMEOUT,
            &CappedOptions {
                current_dir: Some(&workspace),
                env: &test_env(),
                ..CappedOptions::default()
            },
        )
        .expect("git init --bare");
        assert!(outcome.success, "{}", outcome.stderr);
        let remote_arg = path_guard::child_facing(&remote_path)
            .to_string_lossy()
            .replace('\\', "/");
        let added = git
            .write(
                &["remote", "add", "origin", &remote_arg],
                None,
                READ_TIMEOUT,
            )
            .expect("remote add");
        assert!(added.success, "{}", added.stderr);

        let identity_path = "/tmp/am-test/.ssh/id_project_git".to_owned();
        let ssh_command = format!("'/usr/bin/ssh' -i '{identity_path}' -o IdentitiesOnly=yes");
        TEST_NETWORK_IDENTITY.with(|cell| {
            *cell.borrow_mut() = Some(crate::ssh_endpoints::ProjectGitIdentity {
                askpass: None,
                identity_path: identity_path.clone(),
                ssh_command: ssh_command.clone(),
            });
        });
        struct ClearIdentity;
        impl Drop for ClearIdentity {
            fn drop(&mut self) {
                TEST_NETWORK_IDENTITY.with(|cell| *cell.borrow_mut() = None);
            }
        }
        let _reset = ClearIdentity;

        std::fs::write(repo.root.join("a.txt"), "a\n").expect("a.txt");
        let recorder = ArgvRecorder::start();
        status_with(&git).expect("status");
        stage_with(&git, &["a.txt".to_owned()]).expect("stage");
        assert!(
            commit_with(&git, "신원 범위 시험")
                .expect("commit")
                .succeeded
        );
        fetch_with(
            &git,
            &ProjectGitFetchRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                remote: Some("origin".to_owned()),
                prune: false,
            },
        )
        .expect("fetch");
        let calls = recorder.taken_calls();
        assert!(!calls.is_empty(), "기록된 호출이 없다 — 설비가 깨졌다");

        let mut carried = Vec::new();
        for call in &calls {
            let value = call
                .env
                .iter()
                .find(|(name, _)| name == "GIT_SSH_COMMAND")
                .map(|(_, value)| value.clone());
            // argv는 언제나 `GIT_BASE_ARGS` 다음에 하위 명령이 온다. 앞머리를 글자 모양으로
            // 찾으면 `-c`의 값(`color.ui=never`)을 하위 명령으로 읽는다.
            let head = call.argv[GIT_BASE_ARGS.len()].clone();
            // 어느 호출에서도 제거 목록은 같다 — 상속분은 전부 끊는다. 제거와 설정의
            // 순서는 `cli_interface::run_capped_with`가 쥐고 있고, 그 순서는 아래의
            // `c16_10_our_identity_survives_the_removal_of_the_inherited_one`이 실제
            // 자식으로 잰다. 여기서 재는 것은 "무엇을 끊어 달라고 했는가"까지다.
            assert!(
                call.env_remove.iter().any(|key| key == "GIT_SSH_COMMAND")
                    && call.env_remove.iter().any(|key| key == "GIT_SSH"),
                "상속된 신원 변수를 끊지 않았다: {:?}",
                call.argv
            );
            match value {
                Some(value) => {
                    assert_eq!(value, ssh_command, "우리가 만든 값이 아니다");
                    carried.push(head);
                }
                None => assert_ne!(head, "fetch", "fetch에 신원이 가지 않았다"),
            }
        }
        // 네트워크 작업 하나만 신원을 받는다. 읽기(`status`·`rev-parse`)도 로컬 변경
        // (`add`·`commit`)도 받지 않는다.
        assert_eq!(
            carried,
            vec!["fetch".to_owned()],
            "신원이 닿은 호출: {carried:?}"
        );
    }

    #[test]
    fn c16_11_remote_urls_are_classified_like_git_does() {
        let cases: &[(&str, GitRemoteTransport, Option<&str>, bool)] = &[
            (
                "https://github.com/o/r.git",
                GitRemoteTransport::Https,
                Some("github.com"),
                false,
            ),
            (
                "HTTPS://GitHub.com:443/o/r.git",
                GitRemoteTransport::Https,
                Some("github.com"),
                false,
            ),
            (
                "https://u:p@git.example.com:8443/r",
                GitRemoteTransport::Https,
                Some("git.example.com:8443"),
                true,
            ),
            (
                "https://u@github.com/o/r.git",
                GitRemoteTransport::Https,
                Some("github.com"),
                false,
            ),
            (
                "http://intranet/r.git",
                GitRemoteTransport::Http,
                Some("intranet"),
                false,
            ),
            (
                "ssh://git@github.com:22/o/r.git",
                GitRemoteTransport::Ssh,
                Some("github.com:22"),
                false,
            ),
            (
                "git@github.com:o/r.git",
                GitRemoteTransport::Ssh,
                Some("github.com"),
                false,
            ),
            (
                "nas:repos/r.git",
                GitRemoteTransport::Ssh,
                Some("nas"),
                false,
            ),
            ("/srv/git/r.git", GitRemoteTransport::Local, None, false),
            ("../r.git", GitRemoteTransport::Local, None, false),
            ("./a:b", GitRemoteTransport::Local, None, false),
            ("C:\\repos\\r.git", GitRemoteTransport::Local, None, false),
            ("C:/repos/r.git", GitRemoteTransport::Local, None, false),
            ("file:///srv/r.git", GitRemoteTransport::Local, None, false),
            (
                "git://example.com/r.git",
                GitRemoteTransport::Other,
                None,
                false,
            ),
        ];
        for (url, transport, host, password) in cases {
            let parsed = parse_remote_url(url);
            assert_eq!(parsed.transport, *transport, "{url}");
            assert_eq!(parsed.host.as_deref(), *host, "{url}");
            assert_eq!(parsed.has_password, *password, "{url}");
        }
        // credential helper를 물을 때 argv에 실리는 주소에는 사용자 정보가 없다.
        assert_eq!(
            parse_remote_url("https://u:secret@github.com/o/r.git").without_userinfo,
            "https://github.com/o/r.git"
        );
    }

    #[test]
    fn c16_11_auth_failure_message_names_the_place_to_connect() {
        let https = auth_failed_message(
            Some(GitRemoteTransport::Https),
            Some("github.com"),
            None,
            false,
        );
        assert!(
            https.contains("비밀정보") && https.contains("github.com"),
            "{https}"
        );
        let token = auth_failed_message(
            Some(GitRemoteTransport::Https),
            Some("github.com"),
            Some("GITHUB_TOKEN"),
            false,
        );
        assert!(
            token.contains("GITHUB_TOKEN") && token.contains("만료"),
            "{token}"
        );
        let http = auth_failed_message(
            Some(GitRemoteTransport::Http),
            Some("intranet"),
            None,
            false,
        );
        assert!(http.contains("평문 HTTP"), "{http}");
        let ssh = auth_failed_message(
            Some(GitRemoteTransport::Ssh),
            Some("github.com"),
            None,
            false,
        );
        assert!(
            ssh.contains("SSH 키") && ssh.contains("git 원격용"),
            "{ssh}"
        );
        let ssh_key = auth_failed_message(
            Some(GitRemoteTransport::Ssh),
            Some("github.com"),
            None,
            true,
        );
        assert!(ssh_key.contains("공개키"), "{ssh_key}");
        // 어느 안내도 터미널 로그인을 권하지 않는다 — 헤드리스 NAS에는 그 자리가 없다.
        for message in [
            https,
            token,
            ssh,
            ssh_key,
            auth_failed_message(None, None, None, false),
        ] {
            assert!(!message.contains("터미널에서 같은 명령"), "{message}");
        }
    }

    struct ClearGitToken;
    impl Drop for ClearGitToken {
        fn drop(&mut self) {
            TEST_GIT_TOKEN.with(|cell| *cell.borrow_mut() = None);
        }
    }

    fn set_test_git_token(host: &str, username: &str, value: &str) -> ClearGitToken {
        TEST_GIT_TOKEN.with(|cell| {
            *cell.borrow_mut() = Some((host.to_owned(), username.to_owned(), value.to_owned()));
        });
        ClearGitToken
    }

    /// 아무도 듣지 않는 루프백 포트. 묶었다 놓으면 연결은 즉시 거절된다.
    fn refused_loopback_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    }

    /// C16-11 — 토큰은 **그 호스트의 HTTPS 원격으로 가는 네트워크 호출 하나에만**, 환경으로만
    /// 간다. 읽기·로컬 변경·평문 HTTP 원격·다른 호스트는 받지 않고, argv에는 어디에도 없다.
    /// 실은 환경을 그대로 git에 다시 먹여 `http.extraHeader`로 읽히는지까지 본다 — 키 이름의
    /// 철자 하나가 틀려도 git은 조용히 무시하고 `authFailed`로 끝나기 때문이다.
    #[test]
    fn c16_11_token_reaches_only_https_network_calls_of_the_bound_host_as_env() {
        let Some(repo) = init_repo() else {
            return;
        };
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };
        let git = runner(&repo);
        let port = refused_loopback_port();
        let host = format!("127.0.0.1:{port}");
        let token = "amTokenValue7Q";
        for (name, url) in [
            ("origin", format!("https://{host}/o/r.git")),
            ("plain", format!("http://{host}/o/r.git")),
            ("elsewhere", "https://127.0.0.2:1/o/r.git".to_owned()),
        ] {
            let added = git
                .write(&["remote", "add", name, &url], None, READ_TIMEOUT)
                .expect("remote add");
            assert!(added.success, "{}", added.stderr);
        }
        let _token = set_test_git_token(&host, "me", token);
        std::fs::write(repo.root.join("a.txt"), "a\n").expect("a.txt");

        let recorder = ArgvRecorder::start();
        status_with(&git).expect("status");
        stage_with(&git, &["a.txt".to_owned()]).expect("stage");
        assert!(
            commit_with(&git, "토큰 범위 시험")
                .expect("commit")
                .succeeded
        );
        for remote in ["origin", "plain", "elsewhere"] {
            let receipt = fetch_with(
                &git,
                &ProjectGitFetchRequest {
                    project_path: repo.root.to_string_lossy().into_owned(),
                    remote: Some(remote.to_owned()),
                    prune: false,
                },
            )
            .expect("fetch");
            assert!(
                !receipt.succeeded,
                "{remote}: 아무도 듣지 않는 포트인데 성공했다"
            );
        }
        let calls = recorder.taken_calls();
        assert!(!calls.is_empty(), "기록된 호출이 없다 — 설비가 깨졌다");

        use base64::Engine as _;
        let expected_header = format!(
            "Authorization: Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("me:{token}"))
        );
        let mut carried = Vec::new();
        for call in &calls {
            assert!(
                call.argv
                    .iter()
                    .all(|arg| !arg.contains(token) && !arg.contains("Authorization")),
                "토큰이 argv에 실렸다: {:?}",
                call.argv
            );
            let keys: Vec<&(String, String)> = call
                .env
                .iter()
                .filter(|(name, _)| {
                    name.starts_with("GIT_CONFIG_KEY_") || name.starts_with("GIT_CONFIG_VALUE_")
                })
                .collect();
            if keys.is_empty() {
                continue;
            }
            let head = call.argv[GIT_BASE_ARGS.len()..].join(" ");
            carried.push(head);
            // 키 이름이 n번이면 값도 n번이다. 헤더 키는 그 호스트로만 한정된다.
            let config: Vec<(String, String)> = call
                .env
                .iter()
                .filter_map(|(name, key)| {
                    let index = name.strip_prefix("GIT_CONFIG_KEY_")?;
                    let value = call
                        .env
                        .iter()
                        .find(|(other, _)| *other == format!("GIT_CONFIG_VALUE_{index}"))?;
                    Some((key.clone(), value.1.clone()))
                })
                .collect();
            let lookup = |wanted: &str| {
                config
                    .iter()
                    .find(|(key, _)| key == wanted)
                    .map(|(_, value)| value.clone())
            };
            assert_eq!(
                lookup(&format!("http.https://{host}/.extraHeader")).as_deref(),
                Some(expected_header.as_str())
            );
            // 토큰이 실리는 호출은 저장소 훅·fsmonitor에 그 환경을 넘기지 않고 인증서 검증을 켠다.
            let hooks = lookup("core.hooksPath").expect("hooksPath");
            assert!(hooks.ends_with(EMPTY_HOOKS_DIR), "{hooks}");
            assert_eq!(lookup("core.fsmonitor").as_deref(), Some("false"));
            assert_eq!(
                lookup(&format!("http.https://{host}/.sslVerify")).as_deref(),
                Some("true")
            );
            assert_eq!(lookup("http.curloptResolve").as_deref(), Some(""));

            // git이 이 환경을 실제로 `http.<url>.extraheader`로 읽는가.
            let mut env = test_env();
            env.extend(
                call.env
                    .iter()
                    .filter(|(name, _)| name.starts_with("GIT_CONFIG_"))
                    .cloned(),
            );
            let probe_url = format!("https://{host}/o/r.git");
            let probe = run_capped_with(
                &executable,
                &["config", "--get-urlmatch", "http.extraheader", &probe_url],
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(&repo.root),
                    env: &env,
                    ..CappedOptions::default()
                },
            )
            .expect("git config --get-urlmatch");
            assert!(
                probe.success,
                "git이 환경 설정을 읽지 못했다: {}",
                probe.stderr
            );
            assert_eq!(probe.stdout.trim(), expected_header);
        }
        assert_eq!(
            carried,
            vec!["fetch --end-of-options origin".to_owned()],
            "토큰이 닿은 호출: {carried:?}"
        );
    }

    /// C16-11 — 가림이 `network_mutate`에 배선돼 있는지를 진짜 영수증으로 잰다. git은 연결에
    /// 실패하면 원격 URL을 stderr에 그대로 적으므로, 토큰과 같은 글자를 URL 경로에 넣으면
    /// 출력에 토큰이 나타나는 상황을 네트워크 없이 만들 수 있다.
    #[test]
    fn c16_11_token_is_redacted_from_the_receipt_of_a_real_fetch() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        let port = refused_loopback_port();
        let host = format!("127.0.0.1:{port}");
        let token = "amEchoedToken42";
        let added = git
            .write(
                &[
                    "remote",
                    "add",
                    "origin",
                    &format!("https://{host}/{token}.git"),
                ],
                None,
                READ_TIMEOUT,
            )
            .expect("remote add");
        assert!(added.success, "{}", added.stderr);
        let _token = set_test_git_token(&host, "x-access-token", token);
        let receipt = fetch_with(
            &git,
            &ProjectGitFetchRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                remote: Some("origin".to_owned()),
                prune: false,
            },
        )
        .expect("fetch");
        assert!(!receipt.succeeded);
        let combined = format!(
            "{}\n{}\n{}",
            receipt.stdout, receipt.stderr, receipt.message
        );
        assert!(
            !combined.contains(token),
            "영수증에 토큰이 남았다: {combined}"
        );
        assert!(
            combined.contains("<git 원격용 토큰>"),
            "git이 URL을 적지 않아 가림을 잴 수 없다(설비 확인): {combined}"
        );
    }

    /// C16-11 — 개요의 원격 판정. 네트워크 없이 URL·앱 설정·git 설정만으로 매긴다.
    #[test]
    fn c16_11_overview_rates_each_remote_without_the_network() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        for (name, url) in [
            ("origin", "https://github.com/o/r.git"),
            ("gitlab", "https://gitlab.com/o/r.git"),
            ("plain", "http://intranet/r.git"),
            ("helped", "https://helped.example.com/r.git"),
            ("embedded", "https://u:p@embedded.example.com/r.git"),
            ("ssh", "git@github.com:o/r.git"),
            ("local", "/srv/git/r.git"),
        ] {
            let added = git
                .write(&["remote", "add", name, url], None, READ_TIMEOUT)
                .expect("remote add");
            assert!(added.success, "{}", added.stderr);
        }
        let configured = git
            .write(
                &[
                    "config",
                    "credential.https://helped.example.com.helper",
                    "store",
                ],
                None,
                READ_TIMEOUT,
            )
            .expect("config");
        assert!(configured.success, "{}", configured.stderr);
        // push 주소가 따로 있으면 push 판정은 그 주소로 한다.
        let pushurl = git
            .write(
                &["config", "remote.gitlab.pushurl", "git@gitlab.com:o/r.git"],
                None,
                READ_TIMEOUT,
            )
            .expect("pushurl");
        assert!(pushurl.success, "{}", pushurl.stderr);
        let _token = set_test_git_token("github.com", "x-access-token", "unused");

        let remotes = git.remotes().expect("remotes");
        let method = |name: &str| {
            remotes
                .iter()
                .find(|remote| remote.name == name)
                .map(|remote| remote.auth.clone())
                .expect(name)
        };
        let origin = method("origin");
        assert_eq!(origin.method, GitRemoteAuthMethod::Token);
        assert_eq!(origin.token_secret.as_deref(), Some("TEST_GIT_TOKEN"));
        assert_eq!(origin.host.as_deref(), Some("github.com"));
        assert_eq!(method("gitlab").method, GitRemoteAuthMethod::SshDefault);
        // 평문 HTTP는 인증 없이 받는 서버도 있어 막지 않는다.
        assert_eq!(method("plain").method, GitRemoteAuthMethod::Unknown);
        assert_eq!(
            method("helped").method,
            GitRemoteAuthMethod::CredentialHelper
        );
        assert_eq!(
            method("embedded").method,
            GitRemoteAuthMethod::UrlCredential
        );
        assert_eq!(method("ssh").method, GitRemoteAuthMethod::SshDefault);
        assert_eq!(method("local").method, GitRemoteAuthMethod::NotNeeded);
        // 토큰이 묶이지 않은 HTTPS 호스트는 수단이 없다.
        drop(_token);
        let remotes = git.remotes().expect("remotes");
        let origin = remotes
            .iter()
            .find(|remote| remote.name == "origin")
            .expect("origin");
        assert_eq!(origin.auth.method, GitRemoteAuthMethod::None);
        assert!(origin.auth.token_secret.is_none());
        // 비밀번호가 박힌 URL도 화면으로는 가려져 나간다(C16-8).
        let embedded = remotes
            .iter()
            .find(|remote| remote.name == "embedded")
            .expect("embedded");
        assert!(!embedded.url.as_deref().unwrap_or_default().contains("u:p@"));
    }

    /// C16-11 — 리뷰 지적. (1) 저장소가 그 호스트의 인증서 묶음을 바꿔 두었으면 토큰을 싣지
    /// 않고 거절한다. (2) 이미 설정된 `http.extraHeader`나 사용자별 helper가 있으면 `none`이
    /// 아니다 — 예전처럼 push가 열려 있어야 한다. (3) 가져오기 주소의 호스트도 개요에 실린다.
    #[test]
    fn c16_11_tls_override_refuses_and_existing_git_credentials_keep_push_open() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        for args in [
            vec!["remote", "add", "origin", "https://github.com/o/r.git"],
            vec!["remote", "add", "ci", "https://ci.example.com/o/r.git"],
            vec![
                "remote",
                "add",
                "mine",
                "https://me@user.example.com/o/r.git",
            ],
            vec!["remote", "add", "split", "https://gitlab.com/o/r.git"],
            vec!["config", "remote.split.pushurl", "git@gitlab.com:o/r.git"],
            vec![
                "config",
                "http.https://ci.example.com/.extraHeader",
                "AUTHORIZATION: basic x",
            ],
            vec![
                "config",
                "credential.https://me@user.example.com.helper",
                "store",
            ],
        ] {
            let outcome = git.write(&args, None, READ_TIMEOUT).expect("git");
            assert!(outcome.success, "{}", outcome.stderr);
        }
        let remotes = git.remotes().expect("remotes");
        let auth = |name: &str| {
            remotes
                .iter()
                .find(|remote| remote.name == name)
                .map(|remote| remote.auth.clone())
                .expect(name)
        };
        let netrc = home_dir()
            .is_ok_and(|home| home.join(".netrc").is_file() || home.join("_netrc").is_file());
        if !netrc {
            assert_eq!(auth("origin").method, GitRemoteAuthMethod::None);
        }
        assert_eq!(auth("ci").method, GitRemoteAuthMethod::CredentialHelper);
        assert_eq!(auth("mine").method, GitRemoteAuthMethod::CredentialHelper);
        let split = auth("split");
        assert_eq!(split.transport, GitRemoteTransport::Ssh);
        assert_eq!(split.fetch_host.as_deref(), Some("gitlab.com"));
        assert_eq!(auth("origin").fetch_host.as_deref(), Some("github.com"));

        let _token = set_test_git_token("github.com", "x-access-token", "amTokenTls");
        let ca = git
            .write(
                &["config", "http.sslCAInfo", "/tmp/evil-ca.pem"],
                None,
                READ_TIMEOUT,
            )
            .expect("config");
        assert!(ca.success, "{}", ca.stderr);
        let recorder = ArgvRecorder::start();
        let refused = fetch_with(
            &git,
            &ProjectGitFetchRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                remote: Some("origin".to_owned()),
                prune: false,
            },
        );
        assert!(
            matches!(&refused, Err(CoreError::Conflict(message)) if message.contains("http.sslCAInfo")),
            "{refused:?}"
        );
        // 거절은 fetch를 띄우기 전이다.
        assert!(recorder.taken_calls().iter().all(|call| call
            .argv
            .get(GIT_BASE_ARGS.len())
            .map(String::as_str)
            != Some("fetch")));
    }

    /// 시험용 저장된 비밀값 목록(이름만). OS 보안 저장소는 열지 않는다.
    fn save_secret_names(app_data: &Path, names: &[&str]) {
        let secrets: Vec<serde_json::Value> = names
            .iter()
            .map(|name| {
                serde_json::json!({
                    "name": name, "purpose": "시험", "createdAt": 1, "updatedAt": 1,
                    "lastUsedAt": null, "agentEnabled": true,
                })
            })
            .collect();
        crate::app_data_file::write_private_json(
            &app_data.join("saved-secrets-v1.json"),
            &serde_json::json!({ "schemaVersion": 1, "secrets": secrets }),
        )
        .expect("saved secrets");
    }

    /// C16-11 — 토큰 지정은 프로젝트마다 한다(사용자 결정, 2026-10-20). 같은 호스트라도
    /// 다른 프로젝트의 선택은 보이지도 쓰이지도 않고, 지워진 값은 판정에서 빠진다.
    #[test]
    fn c16_11_token_binding_is_per_project_and_follows_saved_secrets() {
        let Some(repo) = init_repo() else {
            return;
        };
        let other = repo.root.parent().expect("parent").join("other");
        std::fs::create_dir_all(&other).expect("other");
        save_secret_names(&repo.app_data, &["GH_ORG", "GH_ME"]);
        let request = |path: &Path, host: &str, secret: Option<&str>, username: Option<&str>| {
            SetProjectGitRemoteTokenRequest {
                project_path: path.to_string_lossy().into_owned(),
                host: host.to_owned(),
                secret_name: secret.map(str::to_owned),
                username: username.map(str::to_owned),
            }
        };

        let listed = set_project_git_remote_token(
            &repo.app_data,
            &repo.root,
            &request(&repo.root, " GitHub.com:443 ", Some("GH_ORG"), None),
        )
        .expect("bind");
        assert_eq!(listed.secret_names, vec!["GH_ME", "GH_ORG"]);
        assert_eq!(listed.tokens.len(), 1);
        assert_eq!(listed.tokens[0].host, "github.com");
        assert_eq!(listed.tokens[0].username, DEFAULT_GIT_REMOTE_USERNAME);
        assert!(listed.tokens[0].secret_exists);
        // 다른 프로젝트는 같은 호스트에 다른 값을 고를 수 있고, 서로의 선택을 보지 않는다.
        let theirs = set_project_git_remote_token(
            &repo.app_data,
            &other,
            &request(&other, "github.com", Some("GH_ME"), Some("me")),
        )
        .expect("bind other");
        assert_eq!(theirs.tokens.len(), 1);
        assert_eq!(theirs.tokens[0].secret_name, "GH_ME");
        let mine = list_project_git_remote_tokens(&repo.app_data, &repo.root).expect("list");
        assert_eq!(mine.tokens[0].secret_name, "GH_ORG");
        // 없는 이름과 URL 통째는 저장하지 않는다.
        assert!(matches!(
            set_project_git_remote_token(
                &repo.app_data,
                &repo.root,
                &request(&repo.root, "github.com", Some("MISSING"), None),
            ),
            Err(CoreError::NotFound(_))
        ));
        assert!(set_project_git_remote_token(
            &repo.app_data,
            &repo.root,
            &request(&repo.root, "https://github.com/o/r", Some("GH_ORG"), None),
        )
        .is_err());
        assert!(set_project_git_remote_token(
            &repo.app_data,
            &repo.root,
            &request(&repo.root, "github.com", Some("GH_ORG"), Some("a:b")),
        )
        .is_err());

        // 개요의 판정은 이 프로젝트의 선택으로 매긴다.
        let git = runner(&repo);
        let added = git
            .write(
                &["remote", "add", "origin", "https://github.com/o/r.git"],
                None,
                READ_TIMEOUT,
            )
            .expect("remote add");
        assert!(added.success, "{}", added.stderr);
        let origin = |git: &GitRunner| {
            git.remotes()
                .expect("remotes")
                .into_iter()
                .find(|remote| remote.name == "origin")
                .expect("origin")
                .auth
        };
        let auth = origin(&git);
        assert_eq!(auth.method, GitRemoteAuthMethod::Token);
        assert_eq!(auth.token_secret.as_deref(), Some("GH_ORG"));
        // 고른 값이 저장소에서 지워지면 지정은 남아도(화면이 알려 준다) 판정에서는 빠진다.
        save_secret_names(&repo.app_data, &["GH_ME"]);
        assert_eq!(origin(&git).method, GitRemoteAuthMethod::None);
        let stale = list_project_git_remote_tokens(&repo.app_data, &repo.root).expect("list");
        assert!(!stale.tokens[0].secret_exists);
        // 해제하면 그 줄이 사라지고 다른 프로젝트의 선택은 그대로다.
        let cleared = set_project_git_remote_token(
            &repo.app_data,
            &repo.root,
            &request(&repo.root, "github.com", None, None),
        )
        .expect("clear");
        assert!(cleared.tokens.is_empty());
        let theirs = list_project_git_remote_tokens(&repo.app_data, &other).expect("other");
        assert_eq!(theirs.tokens.len(), 1);
    }

    /// C16-10 — 가림이 `network_mutate`에 **배선되어 있는지**를 진짜 영수증으로 잰다.
    ///
    /// 함수를 직접 불러 재는 시험은 함수가 맞다는 것만 말한다. 호출부에서 그 한 줄을 지워도
    /// 그런 시험은 통과하고, 경로는 그대로 원격 화면까지 간다. 그래서 여기서는 신원이 실제로
    /// 자기 경로를 출력에 적게 만들고(`GIT_SSH_COMMAND`는 셸이 해석하므로 `echo` 한 줄이면
    /// 된다) `ssh://` 원격으로 fetch를 돌린 **영수증**에서 그 경로가 사라졌는지 본다.
    #[test]
    fn c16_10_identity_path_is_redacted_from_the_receipt_of_a_real_fetch() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        let identity_path = "/tmp/am-test/.ssh/id_redaction_probe".to_owned();
        TEST_NETWORK_IDENTITY.with(|cell| {
            *cell.borrow_mut() = Some(crate::ssh_endpoints::ProjectGitIdentity {
                askpass: None,
                identity_path: identity_path.clone(),
                // git은 이 값을 셸에 넘긴다. `ssh` 자리에 `echo`를 두면 `ssh`가 읽지 못하는
                // 신원 파일을 경고할 때와 같은 자리에 같은 경로가 찍힌다.
                ssh_command: format!("echo '{identity_path}' >&2; false"),
            });
        });
        struct ClearIdentity;
        impl Drop for ClearIdentity {
            fn drop(&mut self) {
                TEST_NETWORK_IDENTITY.with(|cell| *cell.borrow_mut() = None);
            }
        }
        let _reset = ClearIdentity;

        let added = git
            .write(
                &["remote", "add", "origin", "ssh://invalid.invalid/repo.git"],
                None,
                READ_TIMEOUT,
            )
            .expect("remote add");
        assert!(added.success, "{}", added.stderr);
        let receipt = fetch_with(
            &git,
            &ProjectGitFetchRequest {
                project_path: repo.root.to_string_lossy().into_owned(),
                remote: Some("origin".to_owned()),
                prune: false,
            },
        )
        .expect("fetch");
        assert!(!receipt.succeeded, "실패해야 신원 경고가 나온다");
        let seen = format!("{} {} {}", receipt.stdout, receipt.stderr, receipt.message);
        assert!(
            seen.contains("<git 원격용 SSH 키>"),
            "신원이 출력에 나오지도 않았다 — 설비가 깨졌다: {seen}"
        );
        assert!(
            !seen.contains(&identity_path),
            "개인키 경로가 영수증에 남았다: {seen}"
        );
    }

    /// C16-10 — 같은 이름이 `env_remove`와 `env`에 함께 있을 때 **우리 값이 살아남는지**를
    /// 진짜 자식으로 잰다. 이 순서는 `cli_interface::run_capped_with`가 쥐고 있어, 설정이
    /// 먼저 돌도록 뒤집히면 사용자가 고른 키 대신 백엔드가 물려받은 신원으로 붙는다.
    #[test]
    fn c16_10_our_identity_survives_the_removal_of_the_inherited_one() {
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };
        let outcome = run_capped_with(
            &executable,
            &["var", "GIT_EDITOR"],
            READ_TIMEOUT,
            &CappedOptions {
                env: &[("GIT_EDITOR".to_owned(), "am-sentinel".to_owned())],
                env_remove: &["GIT_EDITOR"],
                ..CappedOptions::default()
            },
        )
        .expect("git var");
        assert!(outcome.success, "{}", outcome.stderr);
        assert_eq!(outcome.stdout.trim(), "am-sentinel");
    }

    /// C16-10. 가림 자체가 두 스트림을 모두 지나는지.
    #[test]
    fn c16_10_identity_path_is_redacted_from_both_streams() {
        let identity = "/Users/someone/.ssh/id_project_git";
        let mut outcome = CommandOutcome {
            success: false,
            timed_out: false,
            stdout: format!("ok {identity}\n"),
            stderr: format!(
                "Warning: Identity file {identity} not accessible: No such file or directory.\n"
            ),
        };
        redact_identity_path(&mut outcome, identity);
        assert!(!outcome.stdout.contains(identity) && !outcome.stderr.contains(identity));
        assert!(outcome.stderr.contains("<git 원격용 SSH 키>"));
    }

    /// C16-4 — `fetch`의 `--prune`은 인수 벡터에만 있었고 실행된 적이 없었다.
    ///
    /// 2026-10-04 실측. 이 모듈이 실제 bare 원격을 상대로 `fetch`를 미는 자리는 둘이지만
    /// (`c16_pull_against_a_real_remote_...`, `c16_push_targets_the_upstream_...`) 둘 다
    /// `prune: false`로만 민다. 그래서 `ProjectGitFetchRequest::prune`이 `--prune`을 붙이는
    /// 분기는 한 번도 돌아 본 적이 없었고, 붙인 인수가 **실제로 그 효과를 내는지**는 아무도
    /// 확인하지 않았다. 직전 두 회차가 같은 모양에서 진짜 제품 결함을 하나씩 찾았다 —
    /// 약속이 산문과 인수 벡터에만 있으면 실측되지 않는다.
    ///
    /// 여기서 고정하는 것은 인수가 아니라 **원격 추적 ref 목록**이다. 원격에서 사라진
    /// 브랜치를 만들어 두고 양쪽을 갈라 잰다.
    ///
    /// - `prune: false`의 fetch는 `origin/gone`을 **남긴다.** 이 단언이 없으면 뒤의 단언은
    ///   "원래 없었다"로도 통과한다 — prune을 실제로 재려면 prune하지 않는 쪽이 남긴다는
    ///   사실이 먼저 서야 한다.
    /// - `prune: true`의 fetch만 `origin/gone`을 걷어 내고, `origin/main`은 그대로 둔다.
    ///
    /// `--prune`을 떼면 두 번째 단언만 깨진다. 그 상태의 제품은 사용자가 "정리"를 골랐는데
    /// 아무것도 정리하지 않으면서 영수증은 성공으로 적는다 — 화면의 브랜치 목록에 서버에서
    /// 지워진 지 오래인 이름이 계속 남고, 사용자는 그것이 아직 있는 줄 안다.
    #[test]
    fn c16_fetch_prune_removes_only_branches_gone_from_the_remote() {
        let Some(repo) = init_repo() else {
            return;
        };
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };
        let git = runner(&repo);
        let workspace = repo.root.parent().expect("workspace").to_path_buf();
        let remote_path = workspace.join("remote.git");
        let other_path = workspace.join("other");
        let raw = |dir: &Path, args: &[&str]| {
            let outcome = run_capped_with(
                &executable,
                args,
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(dir),
                    env: &test_env(),
                    ..CappedOptions::default()
                },
            )
            .expect("git");
            assert!(outcome.success, "{args:?}: {}", outcome.stderr);
        };
        // 캐노니컬 경로의 접두사를 그대로 슬래시로 바꾸면 git이 //?/C:/... 를 원격으로
        // 읽지 못한다(앞선 회차의 실측). 자식에게 넘기는 경로를 다듬는 자리를 그대로 쓴다.
        let remote_arg = path_guard::child_facing(&remote_path)
            .to_string_lossy()
            .replace('\\', "/");
        // 판정은 제품의 영수증이 아니라 내 저장소에 실제로 남은 원격 추적 ref다.
        let tracking = || {
            let outcome = git
                .read(
                    &["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
                    READ_TIMEOUT,
                )
                .expect("for-each-ref");
            assert!(outcome.success, "{}", outcome.stderr);
            let mut refs = outcome
                .stdout
                .lines()
                .map(str::trim)
                // git 2.48부터 fetch가 원격 HEAD 심볼릭 ref를 스스로 만든다
                // (`fetch.followRemoteHEAD`). git 버전마다 있다 없다 하는 이 ref는 prune
                // 대상도 아니므로 견주지 않는다.
                .filter(|line| !line.is_empty() && *line != "refs/remotes/origin/HEAD")
                .map(str::to_owned)
                .collect::<Vec<_>>();
            refs.sort();
            refs
        };

        std::fs::write(repo.root.join("a.txt"), "one\n").expect("a");
        stage_with(&git, &["a.txt".into()]).expect("stage");
        let first = commit_with(&git, "첫 커밋").expect("commit");
        assert!(first.succeeded, "{}", first.stderr);
        raw(
            &workspace,
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        raw(&repo.root, &["remote", "add", "origin", &remote_arg]);
        let pushed = git
            .read(&["push", "-u", "origin", "main"], NETWORK_TIMEOUT)
            .expect("push");
        assert!(pushed.success, "{}", pushed.stderr);

        // 다른 사람이 브랜치를 하나 올렸다가 다시 지운다. 원격에서 사라지는 ref를 만드는
        // 유일한 방법이고, 이것이 `--prune`이 존재하는 이유 그 자체다.
        raw(&workspace, &["clone", "-q", &remote_arg, "other"]);
        raw(&other_path, &["switch", "-q", "-c", "gone"]);
        std::fs::write(other_path.join("b.txt"), "theirs\n").expect("other write");
        raw(&other_path, &["add", "-A"]);
        raw(&other_path, &["commit", "-q", "-m", "그쪽 브랜치"]);
        raw(&other_path, &["push", "-q", "origin", "gone"]);

        let fetch = |prune: bool| {
            fetch_with(
                &git,
                &ProjectGitFetchRequest {
                    project_path: String::new(),
                    remote: None,
                    prune,
                },
            )
            .expect("fetch")
        };

        let picked_up = fetch(false);
        assert!(picked_up.succeeded, "{}", picked_up.stderr);
        assert_eq!(
            tracking(),
            vec![
                "refs/remotes/origin/gone".to_owned(),
                "refs/remotes/origin/main".to_owned(),
            ],
            "fetch가 새 원격 브랜치를 받아 온다"
        );

        raw(&other_path, &["push", "-q", "origin", "--delete", "gone"]);

        // prune하지 않는 fetch는 사라진 ref를 **그대로 둔다.** 이 단언이 뒤의 단언에
        // 의미를 준다 — 이것이 없으면 "원래 없었다"로도 통과한다.
        let kept = fetch(false);
        assert!(kept.succeeded, "{}", kept.stderr);
        assert!(
            tracking().contains(&"refs/remotes/origin/gone".to_owned()),
            "prune 없는 fetch는 사라진 브랜치를 걷어 내지 않는다: {:?}",
            tracking()
        );

        // prune을 고른 fetch만 걷어 내고, 살아 있는 브랜치는 건드리지 않는다.
        let pruned = fetch(true);
        assert!(pruned.succeeded, "{}", pruned.stderr);
        assert_eq!(pruned.outcome, GitOutcome::Completed);
        assert_eq!(
            tracking(),
            vec!["refs/remotes/origin/main".to_owned()],
            "prune은 사라진 브랜치만 걷어 낸다: {}",
            pruned.stderr
        );
    }

    /// C16-6 — `BlockedByLocalChanges`는 손으로 적은 문구였지 실제 git 출력에 묶인 적이 없었다.
    ///
    /// 2026-10-04 실측. `failures_are_classified_from_git_wording`은 `classify_failure`에
    /// 사람이 적은 문자열을 먹이므로, 그 문구가 **지금 이 git이 실제로 뱉는 말**과 같은지는
    /// 답할 수 없다. 원격이 필요한 `AuthFailed`와 달리 이 결말은 오프라인에서 그대로 만들 수
    /// 있어서 먼저 닫는다. 입력은 둘이다 — 덮어써질 추적 파일을 둔 채 `switch`, 그리고 같은
    /// 상태에서 `rebase --no-autostash`. 앞은 `would be overwritten by`, 뒤는
    /// `cannot rebase: You have unstaged changes.`라서 분류 가지가 서로 다르다.
    ///
    /// 문구만 보지 않고 **영수증과 작업 트리**를 같이 본다. 이 결말에서 중요한 것은 git이
    /// 거절했다는 사실이 아니라 거절이 아무것도 바꾸지 않았다는 것이다 — 분류가 어긋나면
    /// 화면은 "커밋하거나 스태시하세요" 대신 일반 오류를 띄우고, 사용자는 자기 변경이 아직
    /// 거기 있는지를 영수증에서 읽지 못한다. 그래서 `head_before == head_after`, 브랜치 그대로,
    /// 그리고 파일 내용이 손대지 않은 그대로임을 함께 못박는다.
    ///
    /// `blocked_files`는 git이 탭으로 들여 쓴 목록에서 온다(`blocked_files_from_output`).
    /// 그 줄의 모양이 바뀌면 화면의 "어느 파일이 막았는지"가 조용히 빈 목록이 되므로
    /// 여기서 실제 출력으로 잰다.
    #[test]
    fn c16_local_changes_block_switch_and_rebase_with_a_receipt() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        std::fs::write(
            repo.root.join("a.txt"),
            "one
",
        )
        .expect("a1");
        stage_with(&git, &["a.txt".into()]).expect("stage");
        commit_with(&git, "첫 커밋").expect("commit");

        // 같은 파일을 다르게 바꾼 두 번째 브랜치. 전환이 반드시 이 파일을 덮어쓰게 된다.
        switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "other".into(),
                create: true,
                start_point: Some("HEAD".into()),
            },
        )
        .expect("switch -c other");
        std::fs::write(
            repo.root.join("a.txt"),
            "other
",
        )
        .expect("a-other");
        stage_with(&git, &["a.txt".into()]).expect("stage other");
        commit_with(&git, "다른 브랜치").expect("commit other");
        switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "main".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("switch main");

        // 커밋하지 않은 로컬 변경을 둔다.
        std::fs::write(
            repo.root.join("a.txt"),
            "dirty
",
        )
        .expect("dirty");
        let before = overview_with(&git).expect("overview").head.sha;

        let blocked = switch_with(
            &git,
            &ProjectGitSwitchRequest {
                project_path: String::new(),
                branch: "other".into(),
                create: false,
                start_point: None,
            },
        )
        .expect("막힌 전환도 Err가 아니라 영수증이다");
        assert!(!blocked.succeeded);
        assert_eq!(
            blocked.outcome,
            GitOutcome::BlockedByLocalChanges,
            "실제 git 출력: {}",
            blocked.stderr
        );
        assert_eq!(
            blocked.blocked_files,
            vec!["a.txt".to_owned()],
            "실제 git 출력: {}",
            blocked.stderr
        );
        assert_eq!(blocked.head_before, blocked.head_after);
        assert_eq!(blocked.head_before, before);

        // 같은 상태에서 리베이스는 다른 문구로 막힌다 — 분류 가지가 하나 더 있다.
        let rebase_blocked = rebase_with(
            &git,
            &ProjectGitRebaseRequest {
                project_path: String::new(),
                action: GitRebaseAction::Start,
                onto: Some("other".into()),
            },
        )
        .expect("막힌 리베이스도 영수증이다");
        assert!(!rebase_blocked.succeeded);
        assert_eq!(
            rebase_blocked.outcome,
            GitOutcome::BlockedByLocalChanges,
            "실제 git 출력: {}",
            rebase_blocked.stderr
        );
        assert_eq!(rebase_blocked.head_before, rebase_blocked.head_after);
        assert!(
            git.in_progress().is_none(),
            "리베이스가 진행 중으로 남지 않는다"
        );

        // 거절은 아무것도 바꾸지 않는다.
        let after = overview_with(&git).expect("overview");
        assert_eq!(after.head.branch.as_deref(), Some("main"));
        assert_eq!(after.head.sha, before);
        assert_eq!(
            std::fs::read_to_string(repo.root.join("a.txt")).expect("read"),
            "dirty
"
        );
    }

    /// C16-6 — `AuthFailed`는 `classify_failure`의 결말 중 **마지막으로** 실제 git 출력에
    /// 묶이지 않고 남아 있던 하나다.
    ///
    /// 2026-10-04 실측. 앞선 두 회차가 `BlockedByLocalChanges`와 `RejectedNonFastForward`를
    /// 실제 git 출력에 묶으면서 `AuthFailed`만은 "원격 인증 실패를 오프라인에서 만들 수
    /// 없다"는 이유로 남겨 두었다. 그 전제가 틀렸다. 인증 실패는 **네트워크가 아니라 401
    /// 응답 하나**로 만들어진다 — `WWW-Authenticate` 헤더를 돌려주는 순간 git은 자격증명을
    /// 채우려 하고, C16-3이 `GIT_TERMINAL_PROMPT=0`을 걸어 두었으므로 물을 곳이 없어
    /// 그 자리에서 실패한다. 그래서 루프백에 401만 돌려주는 가장 작은 TCP 응답기를 세운다.
    /// 실제 출력(git 2.x, `LC_ALL=C`)은 이렇다:
    ///
    /// ```text
    /// fatal: could not read Username for 'http://127.0.0.1:<포트>': terminal prompts disabled
    /// ```
    ///
    /// `classify_failure`가 보는 `could not read username`·`terminal prompts disabled`
    /// 두 바늘이 모두 이 한 줄에 들어 있다. 어느 쪽이 사라져도 결말은 `Failed`로 떨어지고,
    /// 그때 화면은 인증을 연결할 자리(C16-11)를 알려 주는 **유일하게 쓸모 있는 안내** 대신
    /// git stderr 첫 줄을 그대로 띄운다. 자격증명을 묻지 않는 것은
    /// 이 어댑터의 설계(C16-3)이므로, 사용자가 빠져나갈 길을 아는 자리는 이 분류뿐이다.
    ///
    /// 세 명령을 모두 민다. fetch·pull·push는 각각 다른 인수 벡터를 지나지만 결말 분류는
    /// 한 자리를 공유하므로, 셋이 같은 결말로 모이는지가 이 분류가 "네트워크 명령의 결말"
    /// 인지 "fetch의 결말"인지를 가른다. push는 바깥으로 나가는 유일한 명령이고 호스트
    /// 전용이라(C16-7) 인증 안내가 가장 필요한 자리다.
    ///
    /// 문구만 보지 않고 **영수증과 저장소 상태**를 같이 본다. 인증 실패는 아무것도 바꾸지
    /// 않아야 하므로 `head_before == head_after`이고, 원격 추적 ref가 하나도 생기지 않는다.
    ///
    /// 검출력 실측(2026-10-04, project_git 28건 기준). 주입 셋을 넣어 봤다.
    ///
    /// - 두 바늘을 `classify_failure`에서 빼면 이 시험과 `failures_are_classified_from_git_wording`
    ///   **둘 다** 잡는다. 그 가지는 이미 지켜지고 있었다.
    /// - `GIT_TERMINAL_PROMPT=0`을 지워도 28건이 모두 통과한다. 제품이 그만큼 튼튼했다 —
    ///   `GIT_ASKPASS`가 비어 있고 자식에 tty가 없어 git은 그래도 같은 말로 실패한다.
    ///   그러니 이 시험이 지키는 것은 그 변수 하나가 아니라 **비대화 실행 전체의 결과**다.
    /// - 바늘을 "그럴듯하지만 git이 쓰지 않는 말"(`could not read the username` /
    ///   `terminal prompts are disabled`)로 바꾸고 **기존 문구 시험의 고정값도 같이** 맞추면
    ///   — 문구를 고치는 사람이 실제로 하는 일이다 — 28건 중 **이 시험 하나만** FAILED 한다.
    ///   그것이 이 시험이 닫는 공백이다. 손으로 적은 문자열을 자기가 다시 먹이는 시험은
    ///   "둘이 서로 맞는가"만 답할 수 있고 "그 말을 git이 하는가"는 답할 수 없다.
    #[test]
    fn c16_auth_failure_against_a_real_remote_keeps_head_and_reports_auth_failed() {
        let Some(repo) = init_repo() else {
            return;
        };
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };

        // 401 + `WWW-Authenticate`만 돌려주는 응답기. git의 http 전송은 이 응답을 받고서야
        // 자격증명을 채우려 하므로, 이것이 오프라인에서 인증 실패를 만드는 최소 설비다.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        listener.set_nonblocking(true).expect("nonblocking");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let serving = std::sync::Arc::clone(&stop);
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            while !serving.load(std::sync::atomic::Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
                        // 요청 헤더를 **끝까지** 읽은 뒤에 답한다. 한 번만 읽고 바로 쓰고
                        // 닫으면 아직 보내는 중이던 쪽이 `Recv failure: Connection was
                        // reset`을 받고, 그러면 결말이 인증이 아니라 전송 오류로 떨어진다.
                        // push에서 네 번에 한 번꼴로 실제로 그랬다(2026-10-04 실측) — 요청이
                        // 가장 길어서 한 번의 read에 다 담기지 않을 때가 있기 때문이다.
                        let mut request = Vec::new();
                        let mut scratch = [0u8; 1024];
                        while let Ok(read) = stream.read(&mut scratch) {
                            if read == 0 {
                                break;
                            }
                            request.extend_from_slice(&scratch[..read]);
                            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                                break;
                            }
                        }
                        // `Connection: close`로 keep-alive 재사용을 막는다. 응답마다 소켓을
                        // 닫을 것이므로, 재사용하겠다고 믿게 두면 다음 요청이 닫힌 소켓으로
                        // 가서 같은 reset이 난다.
                        let _ = stream.write_all(
                            b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"am\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        let _ = stream.flush();
                        // 답한 뒤에도 **읽기를 멈추지 않는다.** 받은 쪽이 아직 보내지 않은
                        // 바이트(push의 요청 본문)를 남긴 채 소켓을 닫으면 Windows는 FIN이
                        // 아니라 RST를 보내고, 그러면 응답을 읽고 있던 git이 그것을
                        // `Recv failure: Connection was reset`으로 본다. 끝까지 비우고
                        // 상대가 먼저 닫게 둔 뒤에 쓰기 쪽만 닫는다.
                        while let Ok(read) = stream.read(&mut scratch) {
                            if read == 0 {
                                break;
                            }
                        }
                        let _ = stream.shutdown(std::net::Shutdown::Write);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        // 이 시험만 프록시를 끈다. 사용자 환경에 `http_proxy`가 걸려 있으면 루프백 요청이
        // 그쪽으로 새어 나가 401이 아닌 다른 실패가 되고, 그러면 이 시험은 분류가 아니라
        // 그 사람의 네트워크 설정을 재게 된다. 공용 `test_env`는 건드리지 않는다.
        let mut env = test_env();
        env.push(("NO_PROXY".into(), "*".into()));
        env.push(("no_proxy".into(), "*".into()));
        let git = match GitRunner::open_with_env(&repo.app_data, &repo.root, env) {
            Ok(runner) => runner,
            Err(failure) => panic!("{}", CoreError::from(failure)),
        };
        let raw = |dir: &Path, args: &[&str]| {
            let outcome = run_capped_with(
                &executable,
                args,
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(dir),
                    env: &test_env(),
                    ..CappedOptions::default()
                },
            )
            .expect("git");
            assert!(outcome.success, "{args:?}: {}", outcome.stderr);
        };

        std::fs::write(repo.root.join("a.txt"), "one\n").expect("a");
        stage_with(&git, &["a.txt".into()]).expect("stage");
        let first = commit_with(&git, "첫 커밋").expect("commit");
        assert!(first.succeeded, "{}", first.stderr);
        let head = first.head_after.clone().expect("head");
        raw(
            &repo.root,
            &[
                "remote",
                "add",
                "origin",
                &format!("http://127.0.0.1:{port}/am.git"),
            ],
        );

        let tracking = || {
            let outcome = git
                .read(
                    &["for-each-ref", "--format=%(refname)", "refs/remotes"],
                    READ_TIMEOUT,
                )
                .expect("for-each-ref");
            assert!(outcome.success, "{}", outcome.stderr);
            outcome.stdout.trim().to_owned()
        };

        let expect_auth_failure = |receipt: &GitActionReceipt, label: &str| {
            assert!(
                !receipt.succeeded,
                "{label}: 인증 실패가 성공으로 적혔다: {}",
                receipt.stderr
            );
            assert_eq!(
                receipt.outcome,
                GitOutcome::AuthFailed,
                "{label}: 실제 git 출력이 AuthFailed로 분류되지 않는다: {}",
                receipt.stderr
            );
            // 분류가 맞아야만 나오는 안내다. `Failed`로 떨어지면 git stderr 첫 줄이 대신 온다.
            // C16-11: 응답기가 평문 HTTP이므로 토큰을 싣지 않는다는 안내까지 와야 한다.
            assert!(
                receipt.message.contains("자격증명을 묻지 않")
                    && receipt.message.contains("평문 HTTP"),
                "{label}: 인증 안내가 영수증에 없다: {}",
                receipt.message
            );
            assert_eq!(
                receipt.head_before, receipt.head_after,
                "{label}: 인증 실패가 HEAD를 움직였다"
            );
            assert_eq!(
                receipt.head_after.as_deref(),
                Some(head.as_str()),
                "{label}: HEAD가 첫 커밋 그대로여야 한다"
            );
            assert!(
                !receipt.timed_out,
                "{label}: 자격증명을 물으며 멈춰 섰다 — C16-3의 비대화 실행이 깨졌다"
            );
        };

        let fetched = fetch_with(
            &git,
            &ProjectGitFetchRequest {
                project_path: String::new(),
                remote: None,
                prune: false,
            },
        )
        .expect("fetch");
        expect_auth_failure(&fetched, "fetch");

        let pulled = pull_with(
            &git,
            &ProjectGitPullRequest {
                project_path: String::new(),
                mode: GitPullMode::FfOnly,
                remote: None,
            },
        )
        .expect("pull");
        expect_auth_failure(&pulled, "pull");

        let pushed = push_with(
            &git,
            &ProjectGitPushRequest {
                project_path: String::new(),
                remote: None,
                set_upstream: false,
            },
        )
        .expect("push");
        expect_auth_failure(&pushed, "push");

        // 인증 앞에서 멈췄으므로 원격 추적 ref는 하나도 생기지 않는다.
        assert_eq!(tracking(), "", "인증 실패가 원격 추적 ref를 남겼다");

        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        server.join().expect("server");
    }
    // -----------------------------------------------------------------------
    // C16-4 — 제공하지 않는 인수
    // -----------------------------------------------------------------------

    /// 기록된 argv 하나가 C16-4의 금지 목록에 걸리면 그 사유를 돌려준다.
    ///
    /// `--end-of-options` 뒤는 인수가 아니라 값이다(C16-5). git이 그 뒤의 낱말을 플래그로
    /// 읽지 않으므로 플래그 검사는 그 앞에서만 하고, 값 자리로 흘러든 플래그 모양의 입력은
    /// 시험 본문이 따로 본다.
    fn c16_4_forbidden_reason(argv: &[String]) -> Option<String> {
        let args: Vec<&str> = argv.iter().map(String::as_str).collect();
        let rest = &args[GIT_BASE_ARGS.len()..];
        let subcommand = rest.first().copied().unwrap_or_default();
        let flag_zone = rest
            .iter()
            .position(|arg| *arg == "--end-of-options")
            .unwrap_or(rest.len());
        for arg in &rest[..flag_zone] {
            // `--no-autostash`는 금지가 아니라 금지를 **지키는** 인수다. 접두사로 보면
            // 둘을 가르지 못하므로 `--autostash`만 정확히 일치로 본다.
            if arg.starts_with("--force")
                || *arg == "-f"
                || *arg == "--hard"
                || *arg == "--amend"
                || *arg == "--autostash"
                || *arg == "--discard-changes"
            {
                return Some(format!("{subcommand}: {arg}"));
            }
            if subcommand == "rebase" && (*arg == "-i" || *arg == "--interactive") {
                return Some(format!("{subcommand}: {arg}"));
            }
            if subcommand == "branch" && *arg == "-D" {
                return Some(format!("{subcommand}: {arg}"));
            }
        }
        match subcommand {
            "reset" | "clean" | "checkout" => Some(format!("{subcommand} 자체가 금지다")),
            // C16-4가 막는 것은 **작업 트리** 파일의 되돌림이다. 인덱스만 되돌리는
            // `restore --staged`는 unstage가 쓰는 허용된 갈래이고, 작업 트리를 되돌리는
            // `restore --source=HEAD --worktree`는 이 어댑터가 아니라 C19 overlay
            // 어댑터만 지나간다(`overlay_write_with_input`).
            "restore" if !rest.contains(&"--staged") => {
                Some("restore 가 --staged 없이 작업 트리를 되돌린다".to_owned())
            }
            _ => None,
        }
    }

    /// 기록을 켜고, 떨어질 때 반드시 끈다. 끄지 않으면 같은 스레드에서 뒤에 도는 시험이
    /// 남의 argv를 자기 것으로 본다.
    struct ArgvRecorder;

    impl ArgvRecorder {
        fn start() -> Self {
            RECORDED_CALLS.with(|cell| *cell.borrow_mut() = Some(Vec::new()));
            Self
        }

        fn taken_calls(&self) -> Vec<RecordedCall> {
            RECORDED_CALLS.with(|cell| {
                cell.borrow_mut()
                    .as_mut()
                    .map(std::mem::take)
                    .unwrap_or_default()
            })
        }

        fn taken(&self) -> Vec<Vec<String>> {
            self.taken_calls()
                .into_iter()
                .map(|call| call.argv)
                .collect()
        }
    }

    impl Drop for ArgvRecorder {
        fn drop(&mut self) {
            RECORDED_CALLS.with(|cell| *cell.borrow_mut() = None);
        }
    }

    /// C16-4는 "되돌릴 수 없는 명령은 **제공하지 않는다**"고 이름으로 적어 두었다 —
    /// 어떤 `--force*`도, `reset --hard`도, `clean`도, 작업 트리 `restore`/`checkout`도,
    /// `branch -D`도, `--amend`도, 대화형 rebase도, `--autostash`도.
    ///
    /// **2026-10-04까지 그 목록 가운데 실제로 실행된 적이 있는 것은 `--autostash` 하나뿐이었다**
    /// (두 회차 전의 `c16_local_changes_block_switch_and_rebase_with_a_receipt`). 나머지는
    /// AGENTS.md 산문과 인수 벡터 리터럴에만 있었고, 아무 시험도 "이 어댑터가 그 인수를
    /// 만들지 않는다"를 묻지 않았다. 리터럴을 다시 읽는 시험으로는 답할 수 없는데, 인수
    /// 벡터에는 사용자 입력과 git 출력에서 흘러들어온 값(해석된 원격, push refspec,
    /// 전환 시작점)도 함께 들어가기 때문이다 — 직전 회차가 고친 push refspec 결함이
    /// 정확히 그 자리에서 나왔다.
    ///
    /// 그래서 이 시험은 **제공되는 변경을 전부 실제로 밀고**, 자식에게 넘어간 argv를
    /// `GitRunner::run`에서 그대로 받아 금지 목록에 건다. 두 방향을 같이 본다.
    ///
    /// 1. 금지된 인수가 **없다** — 어떤 변경도 그것을 만들지 않는다.
    /// 2. 금지를 지키는 인수가 **있다** — `rebase --no-autostash`, `pull --rebase
    ///    --no-autostash`, `restore --staged`. 1번만 두면 그 인수를 통째로 지워도 조용히
    ///    통과한다. 없음을 재는 시험은 언제나 그 짝이 필요하다.
    ///
    /// 그리고 플래그 모양의 사용자 입력(`--force`를 브랜치 이름으로, `--hard`를 시작점으로,
    /// `-rf`를 경로로, `--upload-pack=…`을 원격으로)이 거절되어 **argv의 어느 자리에도
    /// 낱말로 나타나지 않는지**를 본다. C16-5의 "`-`로 시작하면 거절"과 C16-4의 금지 목록이
    /// 서로 맞물리는 자리가 여기다.
    ///
    /// 이 시험이 없는 제품은 이렇게 된다: 누군가 "리베이스가 자꾸 막혀서 불편하다"는 보고를
    /// 받고 `--no-autostash`를 `--autostash`로 바꾸거나, "push가 거절된다"는 보고에
    /// `--force-with-lease`를 더한다. 둘 다 한 낱말이고, 둘 다 사용자가 고르지 않은
    /// 되돌릴 수 없는 일을 하며, 영수증은 성공으로 적힌다.
    #[test]
    fn c16_4_no_offered_mutation_ever_builds_a_forbidden_argument() {
        let Some(repo) = init_repo() else {
            return;
        };
        let Ok(executable) = resolve_named_executable(&["git"]) else {
            return;
        };
        let git = runner(&repo);
        let workspace = repo.root.parent().expect("workspace").to_path_buf();
        let remote_path = workspace.join("remote.git");
        let raw = |dir: &Path, args: &[&str]| {
            let outcome = run_capped_with(
                &executable,
                args,
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(dir),
                    env: &test_env(),
                    ..CappedOptions::default()
                },
            )
            .expect("git");
            assert!(outcome.success, "{args:?}: {}", outcome.stderr);
        };
        // 원격은 네트워크가 아니라 같은 디스크의 bare 저장소다(앞선 세 시험과 같은 설비).
        let remote_arg = path_guard::child_facing(&remote_path)
            .to_string_lossy()
            .replace('\\', "/");

        // --- 설비: 커밋 하나, bare 원격, 업스트림. 여기까지는 기록하지 않는다. ---
        std::fs::write(repo.root.join("a.txt"), "one\n").expect("a");
        stage_with(&git, &["a.txt".into()]).expect("stage");
        assert!(commit_with(&git, "첫 커밋").expect("commit").succeeded);
        raw(
            &workspace,
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        raw(&repo.root, &["remote", "add", "origin", &remote_arg]);
        raw(&repo.root, &["push", "-q", "-u", "origin", "main"]);
        // 리베이스가 반드시 충돌하도록 같은 파일을 다르게 바꾼 브랜치를 하나 둔다.
        raw(&repo.root, &["switch", "-q", "-c", "other"]);
        std::fs::write(repo.root.join("a.txt"), "other\n").expect("a-other");
        raw(&repo.root, &["commit", "-q", "-a", "-m", "다른 쪽"]);
        raw(&repo.root, &["switch", "-q", "main"]);
        std::fs::write(repo.root.join("a.txt"), "mine\n").expect("a-mine");
        raw(&repo.root, &["commit", "-q", "-a", "-m", "내 쪽"]);

        let recorder = ArgvRecorder::start();

        // --- 제공되는 변경을 전부 민다. 성공·실패는 여기서 묻지 않는다 — 이 시험이 재는
        // 것은 결말이 아니라 자식에게 넘어간 인수다. 다른 시험들이 결말을 맡는다. ---
        std::fs::write(repo.root.join("b.txt"), "b\n").expect("b");
        stage_with(&git, &["b.txt".to_owned()]).expect("stage b");
        unstage_with(&git, &["b.txt".to_owned()]).expect("unstage b");
        stage_with(&git, &["b.txt".to_owned()]).expect("stage b again");
        commit_with(&git, "두 번째 커밋").expect("commit b");

        for (branch, create) in [("feature", true), ("main", false)] {
            switch_with(
                &git,
                &ProjectGitSwitchRequest {
                    project_path: String::new(),
                    branch: branch.to_owned(),
                    create,
                    start_point: create.then(|| "HEAD".to_owned()),
                },
            )
            .expect("switch");
        }

        std::fs::write(repo.root.join("a.txt"), "dirty\n").expect("dirty");
        let stash = |action, index, message: Option<&str>| ProjectGitStashRequest {
            project_path: String::new(),
            action,
            message: message.map(str::to_owned),
            include_untracked: true,
            index,
            expected_sha: None,
        };
        stash_with(&git, &stash(GitStashAction::Push, None, Some("보관"))).expect("stash push");
        stash_with(&git, &stash(GitStashAction::Apply, Some(0), None)).expect("stash apply");
        // apply는 스태시를 남기므로, 작업 트리를 비우고 같은 항목을 pop으로 한 번 더 민다.
        raw(&repo.root, &["checkout", "--", "a.txt"]);
        stash_with(&git, &stash(GitStashAction::Pop, Some(0), None)).expect("stash pop");
        stash_with(&git, &stash(GitStashAction::Push, None, None)).expect("stash push 2");
        stash_with(&git, &stash(GitStashAction::Drop, Some(0), None)).expect("stash drop");

        for prune in [false, true] {
            fetch_with(
                &git,
                &ProjectGitFetchRequest {
                    project_path: String::new(),
                    remote: None,
                    prune,
                },
            )
            .expect("fetch");
        }
        for mode in [GitPullMode::FfOnly, GitPullMode::Rebase] {
            pull_with(
                &git,
                &ProjectGitPullRequest {
                    project_path: String::new(),
                    mode,
                    remote: None,
                },
            )
            .expect("pull");
        }
        for set_upstream in [false, true] {
            push_with(
                &git,
                &ProjectGitPushRequest {
                    project_path: String::new(),
                    remote: None,
                    set_upstream,
                },
            )
            .expect("push");
        }

        // 리베이스 네 갈래. 충돌을 만들어 두었으므로 start 뒤에도 진행 중이라
        // continue·skip·abort가 모두 제 조건에서 돈다.
        let rebase = |action| ProjectGitRebaseRequest {
            project_path: String::new(),
            action,
            onto: Some("other".to_owned()),
        };
        rebase_with(&git, &rebase(GitRebaseAction::Start)).expect("rebase start");
        assert!(
            git.in_progress().is_some(),
            "설비가 충돌을 만들지 못했다 — 나머지 세 갈래가 돌지 않는다"
        );
        rebase_with(&git, &rebase(GitRebaseAction::Continue)).expect("rebase continue");
        if git.in_progress().is_some() {
            rebase_with(&git, &rebase(GitRebaseAction::Skip)).expect("rebase skip");
        }
        if git.in_progress().is_some() {
            rebase_with(&git, &rebase(GitRebaseAction::Abort)).expect("rebase abort");
        }

        let recorded = recorder.taken();

        // --- 1. 금지된 인수가 하나도 없다 ---
        let offending: Vec<String> = recorded
            .iter()
            .filter_map(|argv| {
                c16_4_forbidden_reason(argv).map(|reason| format!("{reason} — argv: {argv:?}"))
            })
            .collect();
        assert!(
            offending.is_empty(),
            "C16-4가 제공하지 않는다고 적은 인수가 argv에 올랐다:\n{}",
            offending.join("\n")
        );

        // --- 2. 금지를 지키는 인수가 실제로 있다 (1번이 공허하게 통과하지 않도록) ---
        let has = |needle: &str| {
            recorded
                .iter()
                .any(|argv| argv.iter().any(|arg| arg == needle))
        };
        assert!(
            has("--no-autostash"),
            "rebase·pull의 autostash 금지가 사라졌다"
        );
        assert!(
            has("--staged"),
            "unstage가 인덱스만 되돌리는 갈래가 사라졌다"
        );
        assert!(has("--ff-only"), "pull의 기본 갈래가 사라졌다");
        let subcommands: Vec<&str> = recorded
            .iter()
            .filter_map(|argv| argv.get(GIT_BASE_ARGS.len()).map(String::as_str))
            .collect();
        for expected in [
            "add", "restore", "commit", "switch", "stash", "rebase", "fetch", "pull", "push",
        ] {
            assert!(
                subcommands.contains(&expected),
                "{expected} 가 한 번도 돌지 않았다 — 이 시험이 그 갈래를 재지 못한다"
            );
        }

        // --- 3. 플래그 모양의 입력은 argv의 어느 자리에도 낱말로 나타나지 않는다 ---
        assert!(
            recorder.taken().is_empty(),
            "기록이 비워지지 않아 앞 단계의 argv가 뒤 단계로 샌다"
        );
        assert!(
            switch_with(
                &git,
                &ProjectGitSwitchRequest {
                    project_path: String::new(),
                    branch: "--force".to_owned(),
                    create: false,
                    start_point: None,
                },
            )
            .is_err(),
            "브랜치 이름 자리의 --force 가 거절되지 않았다"
        );
        assert!(
            switch_with(
                &git,
                &ProjectGitSwitchRequest {
                    project_path: String::new(),
                    branch: "ok-name".to_owned(),
                    create: true,
                    start_point: Some("--hard".to_owned()),
                },
            )
            .is_err(),
            "시작점 자리의 --hard 가 거절되지 않았다"
        );
        assert!(
            stage_with(&git, &["-rf".to_owned()]).is_err(),
            "경로 자리의 -rf 가 거절되지 않았다"
        );
        assert!(
            fetch_with(
                &git,
                &ProjectGitFetchRequest {
                    project_path: String::new(),
                    remote: Some("--upload-pack=echo".to_owned()),
                    prune: false,
                },
            )
            .is_err(),
            "원격 자리의 --upload-pack= 이 거절되지 않았다"
        );
        let refused = recorder.taken();
        for needle in ["--force", "--hard", "-rf", "--upload-pack=echo"] {
            assert!(
                !refused
                    .iter()
                    .any(|argv| argv.iter().any(|arg| arg == needle)),
                "거절했어야 할 {needle} 가 argv에 실려 나갔다: {refused:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // C16-2 / C16-5 — 전역 옵션과 stdin 계약
    // -----------------------------------------------------------------------

    /// C16-3은 "실행은 비대화다"라고 적고 그 뜻을 변수 여섯 가지로 못박아 두었다 —
    /// `GIT_TERMINAL_PROMPT=0`, 빈 `GIT_ASKPASS`, `GIT_EDITOR=true`,
    /// `GIT_SEQUENCE_EDITOR=true`, `LC_ALL=C`, 읽기의 `GIT_OPTIONAL_LOCKS=0`. C16-2는
    /// 그 짝으로 상속된 리디렉션(`GIT_DIR`·`GIT_WORK_TREE`·`GIT_INDEX_FILE`·
    /// `GIT_OBJECT_DIRECTORY`·`GIT_COMMON_DIR`·`GIT_NAMESPACE`·`GIT_PREFIX`)과 askpass
    /// 계열을 자식에서 **지운다**고 적는다.
    ///
    /// **2026-10-05까지 그 전부가 `GitRunner::env`의 리터럴과 `REMOVED_ENV` 상수에만
    /// 있었다.** 직전 회차가 argv와 stdin을 실행된 호출에서 재도록 설비를 넓혔지만
    /// 환경은 기록되지 않았고, 그래서 "자식이 실제로 그것을 받았는가"를 묻는 시험이
    /// 하나도 없었다. 같은 모양의 공백이 직전 다섯 회차에서 다섯 번 나왔고 그중 셋은
    /// 진짜 제품 결함이었다.
    ///
    /// **이 시험이 무엇이고 무엇이 아닌지.** 이것은 실행 시점의 **계약** 측정이지
    /// 효과 측정이 아니다. `env_remove`는 부모가 그 변수를 **들고 있을 때만** 효과가
    /// 있는데, 그것을 실제로 재려면 시험이 자기 프로세스의 환경을 바꿔야 한다 —
    /// `cargo test`는 시험을 같은 프로세스의 여러 스레드로 돌리므로 그 변경은 옆
    /// 시험에 새어 나간다. 흔들리는 시험을 반영하지 않기로 한 자리라(2026-10-04,
    /// 401 응답기 회차) 여기서는 인수 벡터가 완성되는 **한 곳**에서 환경을 함께
    /// 기록하는 데까지만 간다. 상수 선언을 다시 읽는 것보다는 엄격하다 — 읽기와
    /// 변경이 서로 다른 집합을 받는지, 지운 변수를 같은 자리에서 되살리지 않는지는
    /// 선언만 보아서는 갈리지 않는다.
    ///
    /// 네 가지를 **실행된 호출에서** 잰다.
    ///
    /// 1. **비대화 네 가지는 예외가 없다.** `GIT_TERMINAL_PROMPT=0`·빈 `GIT_ASKPASS`·
    ///    `LC_ALL=C`·`GIT_PAGER=cat`이 읽기든 변경이든 모든 호출에 붙는다. 한 호출만
    ///    빠지면 그 호출이 자격증명을 물으려다 멈추거나(C16-3이 "즉시 실패하고 결코
    ///    멈추지 않는다"고 적은 바로 그 반대), 번역된 문구를 뱉어 `classify_failure`의
    ///    영어 바늘이 전부 빗나간다.
    /// 2. **편집기 차단과 읽기 전용 잠금 해제는 배타적이다.** 변경에는
    ///    `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR`가 붙고 `GIT_OPTIONAL_LOCKS`는 붙지 않으며,
    ///    읽기는 그 반대다. 둘을 `^`로 묶는 이유는 한쪽만 세면 "둘 다 붙었다"가 통과해
    ///    읽기가 인덱스 잠금을 잡는 상태를 놓치기 때문이다.
    /// 3. **지운 변수를 같은 호출에서 되살리지 않는다.** `run_capped_with`는
    ///    `env_remove`를 **먼저** 적용하고 `env`를 나중에 설정한다
    ///    (`cli_interface.rs`). 그래서 `REMOVED_ENV`에 있는 이름을 `env`에 한 줄
    ///    더하면 지움이 조용히 무효가 되고, 사용자의 `GIT_DIR`이 아니라 그 한 줄이
    ///    대상을 옮긴다. 목록 포함과 부재를 한 쌍으로 둔다.
    /// 4. **천장이 저장소 부모다.** `GIT_CEILING_DIRECTORIES`가 비어 있으면 git이
    ///    위로 올라가 다른 저장소를 집을 수 있다.
    ///
    /// 그리고 읽기와 변경이 **둘 다** 한 번은 돌았는지 본다. 한쪽만 돌면 2번은
    /// 공집합을 검사하면서 통과한다 — 없음을 재는 단언에는 언제나 그 짝이 필요하다.
    ///
    /// **검출력 실측(2026-10-05, `project_git` 31건).**
    ///
    /// - 주입 A(`env`에서 `GIT_TERMINAL_PROMPT=0` 한 줄 제거): 31건 중 **이 시험 하나만**
    ///   FAILED. 두 회차 전 같은 자리를 주입했을 때 28건이 전부 통과했던 바로 그 공백이다.
    ///   그 상태의 제품은 자격증명을 묻는 원격 앞에서 빈 `GIT_ASKPASS`와 tty 부재에만
    ///   기대게 된다 — 그 둘 중 하나라도 어긋나면 120초 제한까지 프롬프트를 띄운 채 멈추고,
    ///   사용자는 응답 없는 화면만 본다.
    /// - 주입 B(`GIT_PAGER` 아래에 `GIT_DIR=.git` 한 줄 추가): 2건 탐지(이 시험 +
    ///   `c16_1_subfolder_targets_the_enclosing_repository_and_bare_is_refused`). 하위 폴더
    ///   대상 시험이 함께 잡으므로 그 자리는 공백이 아니었다 — 없는 결함을 찾은 것처럼
    ///   적지 않는다.
    /// - 주입 C(`GIT_OPTIONAL_LOCKS=0`을 읽기 분기 밖으로 빼 무조건 설정): 31건 중 **이
    ///   시험 하나만** FAILED. 그 상태의 제품은 커밋·스테이지 같은 변경도 선택적 잠금 없이
    ///   돌아 인덱스 갱신이 조용히 생략된다. 2번 단언을 `^`로 묶은 이유가 이것이다.
    ///
    /// 세 주입 모두 측정 직후 `/tmp` 사본으로 복원하고 `diff -q`로 바이트 일치를 확인했다
    /// (주입과 산출물이 같은 파일이라 파일 단위 `git checkout`은 쓰지 않는다).
    #[test]
    fn c16_3_non_interactive_env_reaches_every_child_and_redirections_are_removed() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);
        std::fs::write(repo.root.join("a.txt"), "a\n").expect("a.txt");

        let recorder = ArgvRecorder::start();
        status_with(&git).expect("status");
        stage_with(&git, &["a.txt".to_owned()]).expect("stage");
        assert!(
            commit_with(&git, "비대화 환경 시험")
                .expect("commit")
                .succeeded
        );
        let calls = recorder.taken_calls();
        assert!(!calls.is_empty(), "기록된 호출이 없다 — 설비가 깨졌다");

        let value = |call: &RecordedCall, key: &str| -> Option<String> {
            call.env
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };
        let ceiling = git
            .root
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned());

        for call in &calls {
            let argv = call.argv.clone();

            // --- 1. 비대화 네 가지는 예외가 없다 ---
            for (key, expected) in [
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GIT_ASKPASS", ""),
                ("LC_ALL", "C"),
                ("GIT_PAGER", "cat"),
            ] {
                assert_eq!(
                    value(call, key).as_deref(),
                    Some(expected),
                    "{key} 가 자식에게 가지 않았다: {argv:?}"
                );
            }

            // --- 2. 편집기 차단과 읽기 전용 잠금 해제는 배타적이다 ---
            let is_write = value(call, "GIT_EDITOR").is_some();
            let is_read = value(call, "GIT_OPTIONAL_LOCKS").is_some();
            assert!(
                is_write ^ is_read,
                "읽기/변경 환경이 갈리지 않았다 (편집기={is_write}, 잠금해제={is_read}): {argv:?}"
            );
            if is_write {
                assert_eq!(
                    value(call, "GIT_EDITOR").as_deref(),
                    Some("true"),
                    "{argv:?}"
                );
                assert_eq!(
                    value(call, "GIT_SEQUENCE_EDITOR").as_deref(),
                    Some("true"),
                    "대화형 rebase 를 막는 변수가 변경 호출에 없다: {argv:?}"
                );
            } else {
                assert_eq!(
                    value(call, "GIT_OPTIONAL_LOCKS").as_deref(),
                    Some("0"),
                    "{argv:?}"
                );
                assert!(
                    value(call, "GIT_SEQUENCE_EDITOR").is_none(),
                    "읽기에 편집기 변수가 붙었다: {argv:?}"
                );
            }

            // --- 3. 지운 변수를 같은 호출에서 되살리지 않는다 ---
            for key in [
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                "GIT_COMMON_DIR",
                "GIT_NAMESPACE",
                "GIT_PREFIX",
                "SSH_ASKPASS",
                "SSH_ASKPASS_REQUIRE",
                "DISPLAY",
            ] {
                assert!(
                    call.env_remove.iter().any(|name| name == key),
                    "{key} 가 자식에서 지워지지 않는다: {argv:?}"
                );
                assert!(
                    value(call, key).is_none(),
                    "{key} 를 지우고 같은 호출에서 다시 설정한다 — 지움이 무효다: {argv:?}"
                );
            }

            // --- 4. 천장이 저장소 부모다 ---
            assert_eq!(
                value(call, "GIT_CEILING_DIRECTORIES"),
                ceiling,
                "천장이 저장소 부모가 아니다: {argv:?}"
            );
        }

        // --- 짝: 읽기와 변경이 둘 다 한 번은 돌았다 ---
        assert!(
            calls
                .iter()
                .any(|call| value(call, "GIT_OPTIONAL_LOCKS").is_some()),
            "읽기 호출이 하나도 기록되지 않아 2번 단언이 공집합이다"
        );
        assert!(
            calls.iter().any(|call| value(call, "GIT_EDITOR").is_some()),
            "변경 호출이 하나도 기록되지 않아 2번 단언이 공집합이다"
        );
    }

    /// C16-2는 "모든 호출에 `GIT_BASE_ARGS`를 앞세운다 — 그 안에 `--literal-pathspecs`가
    /// 있다"고, C16-5는 "경로와 커밋 메시지는 argv가 아니라 stdin으로 간다"고 적어 두었다.
    ///
    /// **2026-10-04까지 둘 다 리터럴로만 있었다.** `GIT_BASE_ARGS`는 상수 선언에,
    /// `--pathspec-from-file=-`은 `stage_with`·`unstage_with`의 인수 배열에 있었고, 어느
    /// 시험도 "자식이 실제로 그것을 받았는가"를 묻지 않았다. 같은 모양의 공백이 직전 네
    /// 회차에서 네 번 나왔고 그중 둘은 진짜 제품 결함이었다.
    ///
    /// 세 가지를 **실행된 git 호출에서** 잰다.
    ///
    /// 1. **접두사(C16-2).** 기록된 모든 argv가 `GIT_BASE_ARGS`로 시작한다. 읽기든
    ///    변경이든 예외가 없어야 한다 — 한 호출만 빠져도 그 호출의 pathspec은 glob으로
    ///    풀리고 색·페이저가 붙어 파서가 깨진다.
    /// 2. **`--literal-pathspecs`가 실제로 듣는다.** 글자 그대로 `a[1].txt`라는 파일과
    ///    `a1.txt`를 함께 두고 `a[1].txt` 하나만 스테이지한다. 이 옵션이 없으면 git은 그
    ///    낱말을 glob으로 읽어 `a1.txt`까지 스테이지한다 — 사용자가 고르지 않은 파일이
    ///    커밋에 들어간다. 접두사 단언만으로는 이 결과를 물을 수 없다.
    /// 3. **경로와 메시지는 stdin으로 간다(C16-5).** 그 두 낱말이 argv의 어느 자리에도
    ///    나타나지 않고, 같은 호출의 stdin에는 NUL로 끊긴 경로와 메시지 본문이 그대로
    ///    들어 있다. 한쪽만 보면 갈리지 않는다 — "argv에 없다"는 인수를 통째로 지워도
    ///    참이고, "stdin에 있다"는 argv에도 함께 실어도 참이다.
    ///
    /// 이 시험이 없는 제품은 이렇게 된다: 누군가 `--pathspec-from-file=-`이 낯설어
    /// 경로를 argv 끝에 붙이는 평범한 모양으로 바꾼다. 로컬 저장소에서는 똑같이 돌고,
    /// 공백·따옴표·대시로 시작하는 이름에서만 깨지며, 그 이름을 만드는 것은 사용자다.
    ///
    /// **검출력 실측(2026-10-04, `project_git` 30건).**
    ///
    /// - 주입 A(`GIT_BASE_ARGS`에서 `--literal-pathspecs` 제거): 30건 중 **이 시험 하나만**
    ///   FAILED. 그 상태의 제품은 사용자가 고른 파일 하나를 스테이지할 때 이름이 glob으로
    ///   읽혀 다른 파일까지 끌고 들어가고, 영수증은 성공으로 적힌다.
    /// - 주입 B(`commit -F -` → `commit -m <message>`): 2건 탐지(이 시험 + 인증 실패 시험).
    ///   그 상태의 제품은 커밋 메시지를 `ps` 에 그대로 노출한다.
    /// - 주입 C(stage 의 경로를 stdin 대신 `--end-of-options` 뒤 argv 로): 30건 중 **이 시험
    ///   하나만** FAILED — C16-5 의 stdin 계약은 여기가 공백이었다.
    ///
    /// 세 주입 모두 측정 직후 `/tmp` 사본으로 복원하고 `diff -q` 로 바이트 일치를 확인했다
    /// (주입과 산출물이 같은 파일이라 파일 단위 `git checkout` 은 쓰지 않는다).
    #[test]
    fn c16_global_options_and_stdin_payloads_reach_the_child() {
        let Some(repo) = init_repo() else {
            return;
        };
        let git = runner(&repo);

        // `a[1].txt`는 Windows에서도 쓸 수 있는 이름이고, git의 기본 pathspec 문법에서는
        // `a1.txt`에 걸리는 glob이다. 둘을 함께 두는 것이 2번 단언의 전부다.
        let glob_like = "a[1].txt";
        let decoy = "a1.txt";
        std::fs::write(repo.root.join(glob_like), "glob\n").expect("glob-like");
        std::fs::write(repo.root.join(decoy), "decoy\n").expect("decoy");

        let message = "메시지는 argv에 실리지 않는다";
        let recorder = ArgvRecorder::start();
        stage_with(&git, &[glob_like.to_owned()]).expect("stage");
        let staged: Vec<String> = status_with(&git)
            .expect("status")
            .entries
            .iter()
            // 인덱스에 **올라간** 것만 센다. `Untracked`까지 세면 스테이지하지 않은
            // 미끼 파일이 함께 잡혀 이 단언이 glob 이 아니라 상태 표시를 재게 된다
            // (2026-10-04 실측: 첫 판이 그래서 거짓 실패했다).
            .filter(|entry| entry.index_status == GitChangeKind::Added)
            .map(|entry| entry.path.clone())
            .collect();
        assert!(commit_with(&git, message).expect("commit").succeeded);
        let calls = recorder.taken_calls();

        // --- 1. 모든 호출이 전역 옵션을 앞세운다 ---
        assert!(!calls.is_empty(), "기록된 호출이 없다 — 설비가 깨졌다");
        for call in &calls {
            assert!(
                call.argv.len() > GIT_BASE_ARGS.len()
                    && call.argv[..GIT_BASE_ARGS.len()] == *GIT_BASE_ARGS,
                "전역 옵션 없이 돈 호출이 있다: {:?}",
                call.argv
            );
        }

        // --- 2. --literal-pathspecs 가 실제로 듣는다 ---
        assert_eq!(
            staged,
            vec![glob_like.to_owned()],
            "--literal-pathspecs 가 듣지 않아 고르지 않은 파일까지 스테이지됐다"
        );

        // --- 3. 경로와 메시지는 argv가 아니라 stdin으로 간다 ---
        let mentions = |needle: &str| {
            calls
                .iter()
                .any(|call| call.argv.iter().any(|arg| arg.contains(needle)))
        };
        assert!(
            !mentions(glob_like),
            "경로가 argv에 실렸다: {calls:?}",
            calls = calls
                .iter()
                .map(|call| call.argv.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            !mentions(message),
            "커밋 메시지가 argv에 실렸다 — ps 에 그대로 보인다"
        );
        let stdin_of = |subcommand: &str| -> Vec<u8> {
            calls
                .iter()
                .find(|call| {
                    call.argv.get(GIT_BASE_ARGS.len()).map(String::as_str) == Some(subcommand)
                })
                .unwrap_or_else(|| panic!("{subcommand} 호출이 기록되지 않았다"))
                .input
                .clone()
                .unwrap_or_else(|| panic!("{subcommand} 가 stdin 없이 돌았다"))
        };
        assert_eq!(
            stdin_of("add"),
            {
                let mut expected = glob_like.as_bytes().to_vec();
                expected.push(0);
                expected
            },
            "stage 의 stdin 이 NUL 로 끊긴 경로가 아니다"
        );
        // `validate_commit_message`가 끝에 줄바꿈 하나를 붙인다(git 이 커밋 메시지에
        // 요구하는 모양). 본문이 그대로 갔는지를 묻는 자리이므로 그 한 글자는 벗긴다.
        assert_eq!(
            String::from_utf8(stdin_of("commit"))
                .expect("utf-8")
                .trim_end_matches('\n'),
            message,
            "commit 의 stdin 이 메시지 본문이 아니다"
        );
    }
    /// 이 시험이 자식 역할로 다시 실행되고 있음을 알리는 변수. 값은 실제 저장소의 경로다.
    const C16_2_CHILD_ROOT: &str = "AM_C16_2_CHILD_ROOT";
    const C16_2_CHILD_APP_DATA: &str = "AM_C16_2_CHILD_APP_DATA";
    /// 자식이 끝까지 갔을 때만 찍는 표식. `--exact` 가 아무 시험도 고르지 못하면 시험
    /// 바이너리는 "0 passed" 로 **성공 종료**하므로, 종료 코드만 보는 부모는 아무것도
    /// 돌지 않은 것을 통과로 읽는다. 표식이 그 구멍을 막는다.
    const C16_2_CHILD_SENTINEL: &str = "AM-C16-2-CHILD-OK";

    /// C16-2가 적어 둔 나머지 절반 — "상속된 리디렉션(`GIT_DIR`, `GIT_WORK_TREE`,
    /// `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`,
    /// `GIT_PREFIX`)과 askpass 변수는 자식에서 제거한다".
    ///
    /// **공백(2026-10-05 실측).** `REMOVED_ENV`는 제품 코드 전체에서 단 한 번,
    /// `GitRunner::run`의 `CappedOptions { env_remove: REMOVED_ENV, .. }` 에만 나타나고
    /// 어떤 시험도 그 배열을 읽거나 효과를 재지 않았다. 직전 회차가 닫은 것은 C16-2의
    /// 앞 절반(전역 인수 접두사와 `--literal-pathspecs`)이고, 뒤 절반인 이 자리는
    /// 배열 리터럴로만 있었다. 리터럴을 다시 읽는 시험으로는 물을 수 없다 — 제거가
    /// 실제로 듣는지는 **부모 프로세스에 그 변수가 실제로 설정되어 있을 때만** 갈린다.
    ///
    /// **그래서 시험 프로세스를 하나 더 띄운다.** `std::env::set_var` 로 이 프로세스의
    /// 환경을 바꾸면 `cargo test` 가 같은 프로세스의 다른 스레드에서 돌리는 2천여 건이
    /// 그 `GIT_DIR` 를 함께 물려받아 흔들린다(project_git 시험 대부분이 실제 git 을
    /// 띄운다). 대신 `current_exe()` 를 `--exact` 로 다시 실행하고 리디렉션 변수를
    /// **그 자식 프로세스에만** 건다. 그러면 자식 안에서는 상속이 진짜로 일어나고,
    /// 다른 시험은 그 변수를 한 번도 보지 않는다.
    ///
    /// 판정은 영수증이 아니라 **디스크**다. 제거가 듣지 않는 제품은 사용자가 프로젝트
    /// 화면에서 고른 저장소가 아니라 백엔드가 물려받은 `GIT_DIR` 가 가리키는 저장소를
    /// 스테이지하고 커밋한다 — 그러고도 영수증은 성공으로 적힌다. 그래서 "진짜 저장소에
    /// 커밋 하나가 생겼다" 와 "미끼 저장소는 한 글자도 바뀌지 않았다" 를 한 쌍으로 둔다.
    /// 앞만 보면 양쪽에 썼을 때도 통과하고, 뒤만 보면 아무 데도 쓰지 않았을 때도 통과한다.
    ///
    /// **검출력(2026-10-05, project_git 31건).**
    /// - 주입 A — `env_remove: REMOVED_ENV` 를 `&[]` 로: **이 시험 하나만** FAILED(오탐 0).
    ///   그 상태의 제품은 `GitRunner::open` 에서 이미 넘어져 사용자에게 "이 프로젝트는 git
    ///   저장소가 아닙니다" 라고 말한다 — 멀쩡한 저장소를 연 프로젝트 화면이 git 탭을
    ///   통째로 잃는다.
    /// - 주입 B — 목록에서 `GIT_INDEX_FILE` **한 줄만** 뺌: 이 시험 하나만 FAILED(오탐 0).
    ///   스테이지가 사용자의 인덱스가 아니라 물려받은 인덱스 파일에 떨어진다.
    /// - 주입 C — 목록에서 `GIT_OBJECT_DIRECTORY` **한 줄만** 뺌: 이 시험이 FAILED.
    ///   같은 판에서 `c16_auth_failure_...` 도 한 번 떨어졌는데, 그 변수는 이 시험의 **자식
    ///   프로세스에만** 걸리므로 인과가 없다. 깨끗한 상태에서 4판 연속 31건 통과를 확인했고,
    ///   그 시험은 전부터 루프백 응답기 쪽으로 간헐적으로 흔들린 자리라 검출이 아니라
    ///   무관한 간헐 실패로 적는다.
    ///
    /// 한 줄씩 빼는 주입이 전부 갈린다는 것이 이 시험의 모양이다 — 목록 전체를 한 덩어리로
    /// 재면 한 이름이 빠진 것은 잡히지 않는다.
    #[test]
    fn c16_2_inherited_git_redirections_never_reach_the_child() {
        // --- 자식 역할 ---
        if let Ok(real_root) = std::env::var(C16_2_CHILD_ROOT) {
            let real_root = PathBuf::from(real_root);
            let app_data = PathBuf::from(
                std::env::var(C16_2_CHILD_APP_DATA).expect("자식에게 app data 경로가 없다"),
            );
            // 여기까지 왔다는 것은 리디렉션 변수가 이 프로세스에 실제로 걸려 있다는 뜻이다.
            assert!(
                std::env::var_os("GIT_DIR").is_some(),
                "자식에 GIT_DIR 가 없다 — 설비가 깨졌다"
            );

            let git = GitRunner::open_with_env(&app_data, &real_root, test_env())
                .unwrap_or_else(|failure| panic!("{}", CoreError::from(failure)));

            // 1. 연 저장소가 사용자가 고른 그곳이다.
            let overview = overview_with(&git).expect("overview");
            assert_eq!(
                std::fs::canonicalize(&overview.repository_root).expect("canonical"),
                std::fs::canonicalize(&real_root).expect("canonical"),
                "GIT_DIR 가 가리키는 곳을 저장소로 열었다"
            );
            assert!(
                overview.head.unborn,
                "진짜 저장소는 아직 커밋이 없어야 한다"
            );

            // 2. 상태가 진짜 저장소의 파일을 본다.
            let seen: Vec<String> = status_with(&git)
                .expect("status")
                .entries
                .iter()
                .map(|entry| entry.path.clone())
                .collect();
            assert_eq!(
                seen,
                vec!["only-in-real.txt".to_owned()],
                "상태가 진짜 저장소의 작업 트리를 보지 않았다"
            );

            // 3. 쓰기가 진짜 저장소에 떨어진다.
            assert!(
                stage_with(&git, &["only-in-real.txt".to_owned()])
                    .expect("stage")
                    .succeeded
            );
            let receipt = commit_with(&git, "C16-2 자식 커밋").expect("commit");
            assert!(receipt.succeeded, "{}", receipt.message);
            assert!(receipt.head_after.is_some(), "커밋 뒤 HEAD 가 없다");

            println!("{C16_2_CHILD_SENTINEL}");
            return;
        }

        // --- 부모 역할 ---
        let Some(real) = init_repo() else {
            return;
        };
        let Some(decoy) = init_repo() else {
            return;
        };
        std::fs::write(real.root.join("only-in-real.txt"), "real\n").expect("real file");
        std::fs::write(decoy.root.join("only-in-decoy.txt"), "decoy\n").expect("decoy file");

        let decoy_git_dir = decoy.root.join(".git");
        let decoy_index = decoy_git_dir.join("am-c16-2-index");
        assert!(!decoy_index.exists());

        let mut child =
            std::process::Command::new(std::env::current_exe().expect("시험 바이너리 경로"));
        child
            .arg("--exact")
            .arg("project_git::tests::c16_2_inherited_git_redirections_never_reach_the_child")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env(C16_2_CHILD_ROOT, &real.root)
            .env(C16_2_CHILD_APP_DATA, &real.app_data)
            // C16-2가 이름으로 적은 리디렉션을 전부 미끼로 돌려 둔다. 제거가 한 자리라도
            // 빠지면 아래 자식 단언 가운데 하나가 그 자리에서 갈린다.
            .env("GIT_DIR", &decoy_git_dir)
            .env("GIT_WORK_TREE", &decoy.root)
            .env("GIT_INDEX_FILE", &decoy_index)
            .env("GIT_OBJECT_DIRECTORY", decoy_git_dir.join("objects"))
            .env("GIT_COMMON_DIR", &decoy_git_dir)
            .env("GIT_NAMESPACE", "am-c16-2-decoy")
            .env("GIT_PREFIX", "am-c16-2-prefix/");
        let output = child.output().expect("자식 시험 프로세스");
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(
            output.status.success(),
            "자식 시험이 실패했다\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}"
        );
        assert!(
            stdout.contains(C16_2_CHILD_SENTINEL),
            "자식이 이 시험을 고르지 못했다(이름이 바뀌었는가). --exact 는 0건을 성공으로 \
             끝내므로 표식이 없으면 아무것도 재지 않은 것이다\n--- stdout ---\n{stdout}"
        );

        // --- 디스크로 판정한다 ---
        let count = |root: &PathBuf| -> String {
            let executable = resolve_named_executable(&["git"]).expect("git");
            let outcome = run_capped_with(
                &executable,
                &["rev-list", "--count", "--all"],
                READ_TIMEOUT,
                &CappedOptions {
                    current_dir: Some(root),
                    env: &test_env(),
                    ..CappedOptions::default()
                },
            )
            .expect("rev-list");
            assert!(outcome.success, "{}", outcome.stderr);
            outcome.stdout.trim().to_owned()
        };
        assert_eq!(count(&real.root), "1", "진짜 저장소에 커밋이 생기지 않았다");
        assert_eq!(
            count(&decoy.root),
            "0",
            "미끼 저장소에 커밋이 생겼다 — 상속된 GIT_DIR 가 자식에 그대로 갔다"
        );
        assert!(
            !decoy_index.exists(),
            "상속된 GIT_INDEX_FILE 이 자식에 그대로 가 미끼 인덱스가 만들어졌다"
        );
        assert!(
            !decoy_git_dir.join("refs/namespaces").exists(),
            "상속된 GIT_NAMESPACE 가 자식에 그대로 갔다"
        );
    }
}
