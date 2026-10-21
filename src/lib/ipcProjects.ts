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
  ExcludeProjectOverlayPathsRequest,
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
  ProjectGitRemoteTokens,
  SetProjectGitRemoteTokenRequest,
  ProjectFileSearchRequest,
  ProjectOverlayReapply,
  ProjectOverlayReceipt,
  ProjectOverlayDrift,
  ProjectOverlayPatch,
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
  ReadProjectOverlayPatchRequest,
  ReapplyProjectOverlaysRequest,
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

/** `worktreePath`를 주면 프로젝트 저장소에 연결된 그 워크트리를 읽는다(읽기 전용). */
export function getProjectGitStatus(projectPath: string, worktreePath: string | null = null): Promise<GitStatus> {
  return call<GitStatus>("get_project_git_status", { request: { projectPath, worktreePath } });
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

/**
 * C16-11. 이 프로젝트가 HTTPS 원격 호스트마다 고른 git 원격용 토큰(저장된 비밀값 이름)과
 * 고를 수 있는 이름 목록. 값은 실리지 않는다.
 */
export function listProjectGitRemoteTokens(projectPath: string): Promise<ProjectGitRemoteTokens> {
  return call<ProjectGitRemoteTokens>("list_project_git_remote_tokens", { request: { projectPath } });
}

/** C16-11. 한 호스트에 저장된 비밀값 하나를 고르거나, `secretName`을 null로 보내 해제한다. */
export function setProjectGitRemoteToken(
  request: SetProjectGitRemoteTokenRequest,
): Promise<ProjectGitRemoteTokens> {
  return call<ProjectGitRemoteTokens>("set_project_git_remote_token", { request });
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

/**
 * `push <remote> HEAD`. 로그인을 통과한 모든 채널에서 열린다(C16-7 2026-10-10, G11).
 * 실행은 비대화형이라 호스트가 이미 가진 자격증명만 쓰고, 없으면 `authFailed` 영수증으로 끝난다.
 */
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
 * 보관된 overlay 세트의 patch 본문을 읽는다(C19-5).
 *
 * 스냅샷이 끝나면 작업 트리는 HEAD 원본으로 돌아가므로, 사용자가 하던 변경의 **유일한
 * 사본**은 앱 데이터 안의 patch 파일이 된다. 그래서 `checkProjectOverlayApply`가
 * `overlayNeedsResolution`을 돌려준 자리에서 이 읽기가 필요하다 — 충돌한 경로 이름만으로는
 * 무엇을 손으로 다시 적어야 하는지 알 수 없다.
 *
 * git을 띄우지 않으므로 저장소가 잠겨 있어도 답한다. `digestMatches`가 거짓이면 장부와
 * 디스크의 patch가 어긋나 적용도 거절되는 상태이고, `reason`은 본문을 싣지 못했거나 상한에서
 * 끊은 사유다.
 */
export function readProjectOverlayPatch(
  request: ReadProjectOverlayPatchRequest,
): Promise<ProjectOverlayPatch> {
  return call<ProjectOverlayPatch>("read_project_overlay_patch", { request });
}

/**
 * 터미널 같은 **외부** Git 작업이 있었는지 묻는다(C19-3). 보관된 patch의 기준 HEAD와 지금
 * HEAD가 다른 세트가 `headMoved: true`·`trigger: "external"`로 실려 온다.
 *
 * 답을 받아도 화면은 **자동으로 적용하지 않는다.** C19-3이 외부 작업 뒤의 자동 적용을
 * 금지했기 때문이다 — 사람이 터미널에서 무엇을 하던 중인지 앱은 모른다. 화면이 하는 일은
 * `checkProjectOverlayApply` 결과와 적용 버튼을 내미는 데까지다.
 */
export function getProjectOverlayDrift(projectPath: string): Promise<ProjectOverlayDrift> {
  return call<ProjectOverlayDrift>("get_project_overlay_drift", { request: { projectPath } });
}

/**
 * 앱이 시작한 Git 작업(switch·pull·rebase) **직후에** 보관된 overlay 세트를 모두 작업
 * 트리에 다시 넣는다(C19-3). 자동 적용이 허용되는 유일한 자리다 — 터미널에서 사람이 옮긴
 * 경우는 `getProjectOverlayDrift`가 버튼만 내미는 것으로 끝난다.
 *
 * Git 작업이 **실패했을 때도** 부른다. 실패한 switch는 HEAD를 움직이지 않지만 스냅샷으로
 * 빠져 있던 로컬 변경은 그대로 빠져 있고, 그 상태를 그냥 두면 사용자는 자기 설정이 사라진
 * 작업 트리에서 계속 일하게 된다(C19-3의 "이전 브랜치에서 재적용").
 */
export function reapplyProjectOverlays(
  request: ReapplyProjectOverlaysRequest,
): Promise<ProjectOverlayReapply> {
  return call<ProjectOverlayReapply>("reapply_project_overlays", { request });
}

/**
 * overlay 세트를 만들거나 고친다. `setId`를 비우면 새 세트다. 담을 수 없는 경로(C16-5 검증 — `.git` 성분·
 * pathspec 매직·저장소 밖 탈출 등)가 하나라도 있으면 영수증의 `outcome`이 `rejected`이고
 * **아무것도 저장되지 않는다** — 일부만 담으면 사용자가 고른 파일이 전부 들어갔다고 믿은 채
 * 브랜치를 옮기게 된다. `.env` 같은 민감 경로는 거절하지 않는다(C19-2).
 */
export function saveProjectOverlaySet(
  request: SaveProjectOverlaySetRequest,
): Promise<ProjectOverlayReceipt> {
  return call<ProjectOverlayReceipt>("save_project_overlay_set", { request });
}

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

/**
 * 세트에서 경로 몇 개를 빼고 보관한 patch에서도 그 구역을 덜어낸다(C19-3).
 *
 * 적용이 `overlayNeedsResolution`으로 막았을 때, 막은 것이 세트 안의 한 파일뿐이면 세트를
 * 통째로 버릴 이유가 없다 — 버리면 막지 않은 경로의 로컬 설정까지 같이 사라진다. 덜어내기
 * 전의 patch는 지워지지 않고 앱 소유 휴지통으로 옮겨지고(C19-5), 빠진 경로는 영수증의
 * `affected`에 실린다. 작업 트리는 한 글자도 바뀌지 않는다.
 */
export function excludeProjectOverlayPaths(
  request: ExcludeProjectOverlayPathsRequest,
): Promise<ProjectOverlayReceipt> {
  return call<ProjectOverlayReceipt>("exclude_project_overlay_paths", { request });
}

/** 세트를 앱 소유 휴지통으로 옮긴다. 지우지 않으므로 되돌릴 자리가 남는다(C19-5). */
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
