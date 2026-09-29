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
use crate::path_guard::{self, CurDirPolicy, RootLabels};
use crate::process_output::MAX_CAPTURED_OUTPUT_BYTES;
use crate::providers::resolve_named_executable;
use crate::user_home::home_dir;
use crate::CoreError;

/// `--pathspec-from-file`·`--end-of-options`가 함께 있는 첫 버전.
const MIN_GIT_VERSION: (u32, u32) = (2, 25);

const READ_TIMEOUT: Duration = Duration::from_secs(20);
const LOCAL_MUTATION_TIMEOUT: Duration = Duration::from_secs(60);
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitDiffRequest {
    pub project_path: String,
    pub path: String,
    #[serde(default)]
    pub original_path: Option<String>,
    #[serde(default)]
    pub staged: bool,
    /// 지정하면 작업 트리·인덱스가 아니라 그 커밋이 부모 대비 바꾼 내용을 본다.
    #[serde(default)]
    pub commit: Option<String>,
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
}

impl GitRunner {
    /// 프로젝트 폴더에서 저장소를 찾아 연다. 실행 파일·버전·저장소 여부·bare·보호 루트를
    /// 차례로 본다(C16-1).
    pub(crate) fn open(app_data_dir: &Path, project_root: &Path) -> Result<Self, GitOpenFailure> {
        Self::open_with_env(app_data_dir, project_root, Vec::new())
    }

    fn open_with_env(
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

    fn root_string(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn env(&self, write: bool) -> Vec<(String, String)> {
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
        env
    }

    fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
        write: bool,
    ) -> Result<CommandOutcome, CoreError> {
        let mut argv: Vec<&str> = GIT_BASE_ARGS.to_vec();
        argv.extend_from_slice(args);
        let env = self.env(write);
        run_capped_with(
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
        )
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
        let names = self.read(&["remote"], READ_TIMEOUT)?;
        let urls = self.read(
            &["config", "--get-regexp", r"^remote\..*\.url$"],
            READ_TIMEOUT,
        )?;
        Ok(names
            .stdout
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| GitRemote {
                name: name.to_owned(),
                url: urls.stdout.lines().find_map(|line| {
                    let (key, value) = line.split_once(' ')?;
                    (key == format!("remote.{name}.url")).then(|| redact_git_url(value.trim()))
                }),
            })
            .collect())
    }

    fn remote_names(&self) -> Result<Vec<String>, CoreError> {
        Ok(self
            .remotes()?
            .into_iter()
            .map(|remote| remote.name)
            .collect())
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
        Ok(upstream
            .success
            .then(|| upstream.stdout.trim().to_owned())
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

struct BusyGuard(PathBuf);

impl BusyGuard {
    fn acquire(root: &Path) -> Option<Self> {
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
) -> Result<GitStatus, CoreError> {
    let runner = GitRunner::open(app_data_dir, project_root)?;
    status_with(&runner)
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
    let runner = GitRunner::open(app_data_dir, project_root)?;
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
    let mut args: Vec<&str> = if let Some(commit) = commit {
        // `show`는 첫 커밋(부모 없음)과 병합 커밋(combined diff)을 모두 알아서 다룬다.
        runner.verify_commit_ref(commit)?;
        vec!["show", "--format="]
    } else if request.staged {
        vec!["diff", "--cached"]
    } else {
        vec!["diff"]
    };
    args.extend(["--no-ext-diff", "--no-color", "--no-textconv", "-M"]);
    args.push("--end-of-options");
    if let Some(commit) = commit {
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
    let untracked = if request.staged || commit.is_some() || !outcome.stdout.is_empty() {
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
        let remote = runner.resolve_remote(request.remote.as_deref())?;
        let mut args: Vec<&str> = vec!["fetch"];
        if request.prune {
            args.push("--prune");
        }
        args.push("--end-of-options");
        args.push(&remote);
        runner.mutate("fetch", &args, None, NETWORK_TIMEOUT)
    })
}

pub fn pull_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitPullRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "pull", |runner| {
        require_branch_head(runner)?;
        let remote = runner.resolve_remote(request.remote.as_deref())?;
        let mut args: Vec<&str> = vec!["pull"];
        match request.mode {
            GitPullMode::FfOnly => args.extend(["--ff-only", "--no-rebase"]),
            GitPullMode::Rebase => args.extend(["--rebase", "--no-autostash"]),
        }
        args.push("--end-of-options");
        args.push(&remote);
        runner.mutate("pull", &args, None, NETWORK_TIMEOUT)
    })
}

pub fn push_project_git(
    app_data_dir: &Path,
    project_root: &Path,
    request: &ProjectGitPushRequest,
) -> Result<GitActionReceipt, CoreError> {
    mutate_project(app_data_dir, project_root, "push", |runner| {
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
        runner.mutate("push", &args, None, NETWORK_TIMEOUT)
    })
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
fn validate_repo_path(root: &Path, raw: &str) -> Result<String, CoreError> {
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
fn pathspec_payload(root: &Path, paths: &[String]) -> Result<Vec<u8>, CoreError> {
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
            "원격 인증에 실패했습니다. 이 화면은 자격증명을 묻지 않으므로 터미널에서 같은 명령을 한 번 실행해 인증을 마친 뒤 다시 시도하세요"
                .to_owned()
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
fn redact_git_url(value: &str) -> String {
    redact_git_text(value)
}

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
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: None,
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
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: Some(first_sha.clone()),
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
                path: "a.txt".into(),
                original_path: None,
                staged: false,
                commit: None,
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
}
