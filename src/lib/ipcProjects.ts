/**
 * 프로젝트 화면(C16)의 명령. 파일 탭의 읽기 전용 목록·본문과 형상관리 탭의 git 조회·변경.
 *
 * 모든 요청은 `projectPath`를 들고 가고, 백엔드는 그 경로가 활성·존재하는 등록 프로젝트로
 * 정규화될 때만 답한다. git 변경은 오류 대신 영수증(`GitActionReceipt`)으로 결말을 돌려주므로,
 * 호출부는 `succeeded`와 `outcome`을 읽어 안내를 그린다 — 던져지는 오류는 전송·인가·입력
 * 검증 실패뿐이다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다.
 */
import type {
  DocumentEntryPage,
  GitActionReceipt,
  GitCommitFiles,
  GitDiff,
  GitLog,
  GitOverview,
  GitStatus,
  ListProjectEntriesRequest,
  ProjectFileView,
  ProjectGitCommitFilesRequest,
  ProjectGitCommitRequest,
  ProjectGitDiffRequest,
  ProjectGitFetchRequest,
  ProjectGitLogRequest,
  ProjectGitPathsRequest,
  ProjectGitPullRequest,
  ProjectGitPushRequest,
  ProjectGitRebaseRequest,
  ProjectGitStashRequest,
  ProjectGitSwitchRequest,
  ReadProjectFileRequest,
} from "../types";
import { call } from "./ipcTransport";

/** 등록 프로젝트 폴더의 한 폴더를 페이지 단위로 읽는다. `.git`과 심볼릭 링크는 오지 않는다. */
export function listProjectEntries(request: ListProjectEntriesRequest): Promise<DocumentEntryPage> {
  return call<DocumentEntryPage>("list_project_entries", { request });
}

/** 프로젝트 파일 하나의 본문. binary·tooLarge면 `content`가 null이다. */
export function readProjectFile(request: ReadProjectFileRequest): Promise<ProjectFileView> {
  return call<ProjectFileView>("read_project_file", { request });
}

/** 브랜치·워크트리·스태시·진행 중 작업. 저장소가 아니면 `repository`가 null이다. */
export function getProjectGitOverview(projectPath: string): Promise<GitOverview> {
  return call<GitOverview>("get_project_git_overview", { request: { projectPath } });
}

export function getProjectGitStatus(projectPath: string): Promise<GitStatus> {
  return call<GitStatus>("get_project_git_status", { request: { projectPath } });
}

export function getProjectGitDiff(request: ProjectGitDiffRequest): Promise<GitDiff> {
  return call<GitDiff>("get_project_git_diff", { request });
}

export function getProjectGitLog(request: ProjectGitLogRequest): Promise<GitLog> {
  return call<GitLog>("get_project_git_log", { request });
}

/** 커밋 하나가 바꾼 파일 목록. 파일별 내용은 `getProjectGitDiff`에 `commit`을 주어 읽는다. */
export function getProjectGitCommitFiles(request: ProjectGitCommitFilesRequest): Promise<GitCommitFiles> {
  return call<GitCommitFiles>("get_project_git_commit_files", { request });
}

export function stageProjectGitPaths(request: ProjectGitPathsRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("stage_project_git_paths", { request });
}

export function unstageProjectGitPaths(request: ProjectGitPathsRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("unstage_project_git_paths", { request });
}

export function commitProjectGit(request: ProjectGitCommitRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("commit_project_git", { request });
}

export function switchProjectGitBranch(request: ProjectGitSwitchRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("switch_project_git_branch", { request });
}

export function stashProjectGit(request: ProjectGitStashRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("stash_project_git", { request });
}

export function rebaseProjectGit(request: ProjectGitRebaseRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("rebase_project_git", { request });
}

export function fetchProjectGit(request: ProjectGitFetchRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("fetch_project_git", { request });
}

export function pullProjectGit(request: ProjectGitPullRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("pull_project_git", { request });
}

/** 호스트 화면 전용. 원격 UI에서는 백엔드가 거절한다. */
export function pushProjectGit(request: ProjectGitPushRequest): Promise<GitActionReceipt> {
  return call<GitActionReceipt>("push_project_git", { request });
}
