/**
 * 프로젝트 형상관리 화면이 AIA에게 일을 넘길 때 쓰는 요청 생성기(계획 5-AIA).
 *
 * `gitConflictAiaPrompt`가 세운 경계를 그대로 따른다 — **내용이 아니라 좌표만 싣는다.**
 * diff 본문에는 토큰·자격증명·원격 URL이 섞일 수 있고(G4, C16-8), 커밋 20개의 diff는
 * 요청문 하나에 들어가지도 않는다. 그래서 요청에는 프로젝트 경로와 SHA·제목·사용자가 고른
 * 순서만 싣고, AIA가 등록 프로젝트에서 `get_project_git_commit_files`·`get_project_git_diff`로
 * 필요한 만큼 직접 읽게 한다.
 */

/**
 * 한 번에 넘길 수 있는 커밋 수의 상한. 20을 넘기면 요청문이 길어지는 것보다, AIA가 한 턴에
 * 다 읽지 못한 채 앞쪽 몇 개만 보고 "검토했다"고 적는 쪽이 문제다. 상한을 넘은 선택은 오류로
 * 거절하지 않고 앞에서부터 20개를 싣고 `truncated`로 알린다 — 사용자가 고른 것을 통째로
 * 버리는 것보다 잘라서 그 사실을 적는 쪽이 복구하기 쉽다.
 */
export const MAX_AIA_REVIEW_COMMITS = 20;

export interface AiaReviewCommitInput {
  sha: string;
  subject: string;
}

/** 요청에 실리는 커밋 한 줄. `order`는 화면에서 고른 순서(1부터)다. */
export interface AiaReviewCommit {
  sha: string;
  subject: string;
  order: number;
}

export interface AiaCommitReviewRequest {
  projectPath: string;
  commits: AiaReviewCommit[];
  /** 상한을 넘겨 잘렸는가. */
  truncated: boolean;
  /**
   * 분석은 기본적으로 읽기만 한다. 수정은 AIA가 별도 승인을 받아야 하는 다른 요청이므로,
   * 여기서 켜는 값이 아니라 호출자가 명시적으로 `readOnly: false`를 줄 때만 꺼진다.
   */
  readOnly: boolean;
  prompt: string;
}

export function buildAiaCommitReviewRequest(input: {
  projectPath: string;
  commits: readonly AiaReviewCommitInput[];
  /** 기본값은 읽기 전용이다. */
  readOnly?: boolean;
  /** 리뷰(기본)인지 분석인지. 요청문 첫 줄만 달라진다. */
  intent?: "review" | "analyze";
}): AiaCommitReviewRequest {
  const readOnly = input.readOnly !== false;
  const truncated = input.commits.length > MAX_AIA_REVIEW_COMMITS;
  const commits = input.commits.slice(0, MAX_AIA_REVIEW_COMMITS).map((commit, index) => ({
    sha: commit.sha,
    subject: commit.subject,
    order: index + 1,
  }));
  const lines = commits.map((commit) => `${commit.order}. ${commit.sha} ${commit.subject}`).join("\n");
  const head = input.intent === "analyze"
    ? "다음 커밋들을 분석해줘."
    : "다음 커밋들을 코드리뷰해줘.";
  const body = [
    head,
    `프로젝트: ${input.projectPath}`,
    `커밋(${commits.length}개, 고른 순서):\n${lines || "- 없음"}`,
    truncated
      ? `고른 커밋이 ${input.commits.length}개라 앞에서부터 ${MAX_AIA_REVIEW_COMMITS}개만 실었어. 나머지는 다시 요청해줘.`
      : null,
    "변경 내용은 이 요청에 없으니 등록 프로젝트에서 각 커밋의 파일 목록과 diff를 직접 읽어줘.",
    readOnly
      ? "읽기만 하고 파일을 고치거나 git 상태를 바꾸지 마. 고칠 것이 있으면 무엇을 어떻게 고칠지만 적어줘."
      : "고칠 것이 있으면 무엇을 왜 고치는지 먼저 알리고 승인을 받은 뒤에만 바꿔줘.",
  ].filter((part): part is string => part !== null).join("\n\n");
  return { projectPath: input.projectPath, commits, truncated, readOnly, prompt: body };
}

/** overlay 재적용 검사가 막혔을 때 화면이 들고 있는 좌표. */
export interface AiaOverlayConflictInput {
  projectPath: string;
  /** overlay 세트 이름. 어느 설정 묶음이 막혔는지 사람이 알아볼 유일한 이름이다. */
  setName: string;
  /** `git apply --check`가 막혔다고 지목한 파일들. */
  affectedPaths: readonly string[];
  /**
   * 왜 막혔는가. `overlayNeedsResolution`의 사유를 그대로 옮기되 명령 출력은 옮기지 않는다 —
   * 진단 문자열에는 원격 URL과 경로가 섞일 수 있다(G4, C16-8).
   */
  reason?: string;
  /** 기본값은 읽기 전용이다. */
  readOnly?: boolean;
}

export interface AiaOverlayConflictRequest {
  projectPath: string;
  setName: string;
  affectedPaths: string[];
  reason: string | null;
  readOnly: boolean;
  prompt: string;
}

/**
 * overlay 재적용 충돌을 AIA에 넘기는 요청문(계획 5-AIA, 점검표 A3).
 *
 * `gitConflictAiaPrompt`·`buildAiaCommitReviewRequest`와 **같은 경계**를 쓴다 — 좌표만 싣는다.
 * overlay patch 본문은 사용자의 로컬 설정이라 `.env`·토큰·접속 문자열이 그대로 들어 있을 수
 * 있어서, 화면이 들고 있는 patch를 요청문에 붙이는 순간 그 값이 대화 기록으로 나간다(G4).
 * 그래서 세트 이름과 막힌 경로·사유만 싣고, 현재 상태는 AIA가 등록 프로젝트에서 직접 읽는다.
 *
 * 요청문이 적는 금지 목록도 추측이 아니다. C16-4가 제공조차 하지 않는 명령(`reset --hard`,
 * `clean`, `--force*`, 변경 폐기)에 더해, overlay가 쓰려는 `restore --source=HEAD --worktree`
 * 까지 명시로 막는다. 그 명령은 C19 예외가 서기 전에는 이 저장소에서 쓸 수 없고, 화면이
 * 넘긴 요청을 받은 AIA가 자기 셸로 대신 돌려 버리면 예외를 건너뛰는 우회로가 된다.
 */
export function buildAiaOverlayConflictRequest(
  input: AiaOverlayConflictInput,
): AiaOverlayConflictRequest {
  const readOnly = input.readOnly !== false;
  const affectedPaths = [...input.affectedPaths];
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const paths = affectedPaths.length > 0
    ? affectedPaths.map((path) => `- ${path}`).join("\n")
    : "- 없음";
  const prompt = [
    "다음 로컬 설정 overlay 재적용 충돌을 안전하게 풀어줘.",
    `프로젝트: ${input.projectPath}`,
    `overlay 세트: ${input.setName}`,
    `막힌 파일:\n${paths}`,
    reason ? `검사 결과: ${reason}` : null,
    "overlay patch 본문은 이 요청에 없어. 민감한 값이 들어 있을 수 있어서 싣지 않았으니, 등록 프로젝트에서 현재 파일과 git 상태를 직접 읽고 무엇이 어긋났는지 먼저 알려줘.",
    readOnly
      ? "읽기만 하고 파일이나 git 상태를 바꾸지 마. 어떻게 맞출지만 적어줘."
      : "고칠 것이 있으면 무엇을 왜 고치는지 먼저 알리고 승인을 받은 뒤에만 바꿔줘.",
    "reset --hard, clean, 강제 푸시, 변경 폐기, restore --source=HEAD --worktree 는 어느 경우에도 쓰지 마. 되돌릴 수 없고 사용자의 로컬 설정이 그 자리에 있다.",
  ].filter((part): part is string => part !== null).join("\n\n");
  return { projectPath: input.projectPath, setName: input.setName, affectedPaths, reason, readOnly, prompt };
}
