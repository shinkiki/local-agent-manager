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
  ApplyProjectOverlayRequest,
  CheckProjectOverlayApplyRequest,
  DeleteProjectOverlaySetRequest,
  DocumentEntryPage,
  GitActionReceipt,
  GitBranchComparison,
  GitCommitFiles,
  GitDiff,
  GitLog,
  GitOverview,
  GitStatus,
  ListProjectEntriesRequest,
  ProjectFileView,
  ProjectFileSearchPage,
  ProjectBranchFollows,
  ProjectFileSearchRequest,
  ProjectOverlayReceipt,
  ProjectOverlaySets,
  ProjectGitCommitFilesRequest,
  ProjectGitComparisonRequest,
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
  SaveProjectOverlaySetRequest,
  SnapshotProjectOverlayRequest,
  SetProjectBranchFollowRequest,
} from "../types";
import { call } from "./ipcTransport";

/** 등록 프로젝트 폴더의 한 폴더를 페이지 단위로 읽는다. `.git`과 심볼릭 링크는 오지 않는다. */
export function listProjectEntries(request: ListProjectEntriesRequest): Promise<DocumentEntryPage> {
  return call<DocumentEntryPage>("list_project_entries", { request });
}

/**
 * 이름·상대경로로 프로젝트 파일을 찾는다. `.git`과 심볼릭 링크는 오지 않는다.
 * `searchContents`를 켜면 본문에 질의가 든 파일도 걸리지만(F3), 걸리는 대상이 넓어질 뿐
 * 응답에 본문이 실리지는 않는다. 제외 폴더·1MB 초과·바이너리는 열지 않고 `excluded`로 센다.
 */
export function searchProjectFiles(request: ProjectFileSearchRequest): Promise<ProjectFileSearchPage> {
  return call<ProjectFileSearchPage>("search_project_files", { request });
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

/**
 * 브랜치와 upstream의 차이를 수신(`branch..upstream`)과 송신(`upstream..branch`)으로 갈라 읽는다.
 * 네트워크를 쓰지 않으므로 수치는 마지막 fetch 기준이고, 그 시각이 `lastFetchedAt`이다.
 */
export function getProjectBranchComparison(
  request: ProjectGitComparisonRequest,
): Promise<GitBranchComparison> {
  return call<GitBranchComparison>("get_project_branch_comparison", { request });
}

/**
 * 이 기기에서 팔로우 중인 브랜치. 저장소가 아니라 앱 데이터에서 오므로 git이 없거나
 * 저장소가 잠겨 있어도 표시는 남는다. 즐겨찾기와는 다른 저장본이다.
 */
export function listProjectBranchFollows(projectPath: string): Promise<ProjectBranchFollows> {
  return call<ProjectBranchFollows>("list_project_branch_follows", { request: { projectPath } });
}

/** 팔로우를 켜거나 끈다. `follow`는 토글이 아니라 원하는 상태다. */
export function setProjectBranchFollow(
  request: SetProjectBranchFollowRequest,
): Promise<ProjectBranchFollows> {
  return call<ProjectBranchFollows>("set_project_branch_follow", { request });
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

/**
 * 이 저장소의 브랜치 독립 overlay 세트(C19). 장부는 앱 데이터에만 쌓이므로 git을 띄우지
 * 않고, 저장소가 잠겨 있거나 git이 없어도 표시는 남는다.
 */
export function listProjectOverlaySets(projectPath: string): Promise<ProjectOverlaySets> {
  return call<ProjectOverlaySets>("list_project_overlay_sets", { request: { projectPath } });
}

/**
 * overlay 세트를 만들거나 고친다. `setId`를 비우면 새 세트다. 민감 경로가 하나라도 걸리면
 * 영수증의 `outcome`이 `rejected`이고 **아무것도 저장되지 않는다** — 일부만 담으면 사용자가
 * 고른 파일이 전부 들어갔다고 믿은 채 브랜치를 옮기게 된다(C19-2).
 */
export function saveProjectOverlaySet(
  request: SaveProjectOverlaySetRequest,
): Promise<ProjectOverlayReceipt> {
  return call<ProjectOverlayReceipt>("save_project_overlay_set", { request });
}

/** 세트를 앱 소유 휴지통으로 옮긴다. 지우지 않으므로 되돌릴 자리가 남는다(C19-5). */
/**
 * 저장해 둔 overlay patch를 작업 트리에 되돌려 넣는다(C19-3). `git apply --check`가 먼저
 * 돌고, 통과하지 못하면 아무것도 적용하지 않은 채 `outcome: "overlayNeedsResolution"`과
 * 막은 경로(`affected`)만 돌아온다.
 */
export function applyProjectOverlay(
  request: ApplyProjectOverlayRequest,
): Promise<ProjectOverlayReceipt> {
  return call<ProjectOverlayReceipt>("apply_project_overlay", { request });
}

export function deleteProjectOverlaySet(
  request: DeleteProjectOverlaySetRequest,
): Promise<ProjectOverlayReceipt> {
  return call<ProjectOverlayReceipt>("delete_project_overlay_set", { request });
}

/**
 * C19. 세트의 unstaged 변경을 patch로 떠 앱 데이터에 보관하고, **그 저장이 끝난 뒤에만**
 * 작업 트리를 HEAD 원본으로 되돌린다. 저장이 실패하면 작업 트리는 한 글자도 바뀌지 않으므로,
 * 호출부는 영수증의 `outcome`만 보면 된다 — `busy`와 `rejected`는 아무것도 바꾸지 않았다는
 * 뜻이고, `snapshotted`일 때의 `headBefore`·`snapshotId`·`patchDigest`가 복구 앵커다.
 */
export function snapshotProjectOverlay(
  request: SnapshotProjectOverlayRequest,
): Promise<ProjectOverlayReceipt> {
  return call<ProjectOverlayReceipt>("snapshot_project_overlay", { request });
}

/**
 * 보관한 patch가 지금 작업 트리에 다시 적용될 수 있는지 묻는다(C19-3).
 * 작업 트리는 바뀌지 않는다 — `git apply --check`만 돌고, 실패하면 아무것도 적용하지 않은 채
 * `overlayNeedsResolution`과 충돌 경로(`affected`)가 영수증에 실려 온다.
 */
export function checkProjectOverlayApply(
  request: CheckProjectOverlayApplyRequest,
): Promise<ProjectOverlayReceipt> {
  return call<ProjectOverlayReceipt>("check_project_overlay_apply", { request });
}
