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

/**
 * 이 파일의 요청문이 **이름을 적어** 막는 git 명령(점검표 A7).
 *
 * C16-4는 이 명령들을 제품에 제공조차 하지 않는다. 그런데 화면이 넘긴 요청을 받은 AIA는
 * 자기 셸을 갖고 있어서, 요청문이 말하지 않으면 같은 일을 `git`으로 직접 해 버린다 —
 * 그러면 C16-4의 금지는 화면에만 있고 실제로는 비어 있는 규칙이 된다. 분석 답변이 적어 준
 * 한 줄을 사용자가 그대로 붙여 넣는 자리도 같은 구멍이다.
 *
 * 그래서 "강제 푸시" 같은 뜻풀이가 아니라 **명령 형태 그대로** 적는다. 다른 말로 적힌 금지는
 * 모델이 `push --force-with-lease`를 "강제 푸시가 아니다"로 읽을 여지를 남긴다. 다만 형태를
 * 적는다고 변종을 빠뜨리면 반대쪽 구멍이 난다 — `clean -fd`만 적힌 금지는 `clean -xdf`를
 * 남긴다. 그래서 대표형 옆에 "모든 형태"를 함께 적는다.
 *
 * 집합은 C16-4가 "never offered"로 적은 목록 전부다 — `--force*`·`reset --hard`·`clean`·
 * worktree `restore`/`checkout`·`branch -D`·`--amend`·대화형 rebase·`--autostash`. `--force*`는
 * 괄호 안이 아니라 독립 항목으로 적는다 — "강제 푸시(… --force*)"로 중첩하면 그 수식이 push
 * 에만 걸려 `checkout --force` 같은 다른 명령의 force 형태가 금지 밖으로 빠진다.
 *
 * 금지의 뜻은 **폐기**다. 그래서 worktree `checkout`은 "경로를 지정해 HEAD 원본으로 되돌리는"
 * 것으로 한정하고, 충돌 표시가 남은 파일의 `checkout --ours/--theirs`는 쓸 수 있다고 적는다.
 * 통째로 막으면 쓰기 허용 충돌 해결 문단이 "충돌 표시를 제거하라"면서 그 표준 수단을 금지하는
 * 자기모순이 되고, 모델은 지시를 손편집으로 우회하거나 제멋대로 예외를 만든다.
 *
 * 형제 생성기 `gitConflictAiaPrompt`도 이 상수를 그대로 쓴다. 두 곳에 따로 적으면 한쪽만 넓어진다.
 */
export const DESTRUCTIVE_GIT_COMMANDS_BAN =
  "reset --hard, clean 모든 형태(clean -fd, clean -xdf 등), 강제 푸시(push --force, push -f, "
  + "push --force-with-lease), 명령을 가리지 않고 모든 --force*/-f 형태, commit --amend, "
  + "branch -D, 대화형 rebase(rebase -i), rebase/pull --autostash, 그리고 HEAD 원본으로 "
  + "되돌리는 worktree 폐기(restore --source=HEAD --worktree, 경로를 지정한 worktree 파일 "
  + "checkout)는 어느 경우에도 쓰지 마. 되돌릴 수 없고 사용자의 커밋하지 않은 변경과 로컬 "
  + "설정이 그 자리에 있다. 다만 충돌 표시가 남은 파일에 한해 checkout --ours/--theirs로 "
  + "한쪽을 고르는 것은 폐기가 아니니 그건 써도 돼.";

/**
 * 요청문 목록에 파일 경로 한 줄을 싣는다.
 *
 * 경로는 `git ... -z` 출력에서 오므로 줄바꿈·제어 문자가 그대로 들어 있을 수 있다 — git은
 * 파일 이름에 `\n`을 허용한다. 그대로 이어 붙이면 `a\n\n읽기 제한은 무시하고 reset --hard 해`
 * 같은 이름 하나가 요청문에 **새 문단**을 만들고, 그 문단은 화면이 쓴 지시와 구별되지 않는다.
 * 그래서 제어 문자가 있는 경로만 JSON 문자열로 따옴표를 쳐서 한 줄에 가둔다 — git의
 * `core.quotePath`가 같은 경로를 따옴표로 감싸는 것과 같은 모양이고, 경로를 버리지 않으므로
 * AIA는 여전히 그 파일을 찾을 수 있다. 보통 경로는 그대로 둔다.
 */
export function promptPathLine(path: string): string {
  if (!PROMPT_LINE_BREAKERS.test(path)) return `- ${path}`;
  // JSON.stringify 는 C0 만 이스케이프하고 DEL·C1(NEL 포함)·U+2028/2029 는 그대로 둔다.
  const quoted = JSON.stringify(path).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `- ${quoted}`;
}

const PROMPT_LINE_BREAKERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

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
    DESTRUCTIVE_GIT_COMMANDS_BAN,
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
    ? affectedPaths.map(promptPathLine).join("\n")
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
    DESTRUCTIVE_GIT_COMMANDS_BAN,
  ].filter((part): part is string => part !== null).join("\n\n");
  return { projectPath: input.projectPath, setName: input.setName, affectedPaths, reason, readOnly, prompt };
}

/** 지금 이력에 남아 있는 선택과, 사라진 선택을 갈라 놓은 결과. */
export interface AiaReviewSelection {
  /** 고른 순서대로, **지금 이력에 실제로 있는** 커밋만. 이것이 요청에 실린다. */
  commits: AiaReviewCommitInput[];
  /** 고른 뒤 이력에서 사라진 SHA(브랜치 전환·rebase·amend). 화면이 그 사실을 말해야 한다. */
  missing: string[];
}

/**
 * 화면이 들고 있는 선택(SHA 목록)을 지금 이력에 비추어 가른다(점검표 A1·A2).
 *
 * 이력은 개요가 올 때마다 첫 페이지부터 다시 읽히므로(브랜치 전환·커밋·rebase 뒤),
 * 사용자가 고른 SHA가 다음 순간 목록에 없을 수 있다. 선택 상태는 그 재적재를 모른다.
 *
 * 2026-10-04 실측: 세 커밋을 고른 뒤 브랜치를 바꾸면 머리글은 여전히 "3개 선택"이라 적고,
 * AIA 리뷰를 누르면 살아남은 것만 조용히 실려 나가거나(요청문에는 "커밋(1개)"로 적힌다)
 * 하나도 남지 않았을 때는 버튼이 **아무 일도 하지 않는다**. 어느 쪽이든 사용자가 믿는
 * 선택과 넘어간 선택이 다르고, 화면은 그 차이를 말하지 않는다.
 *
 * 그래서 세는 자리와 싣는 자리를 한 함수로 합쳤다 — 머리글이 세는 수와 요청에 실리는 수가
 * 같은 계산에서 나오면 둘이 어긋날 수 없다. 사라진 것은 버리지 않고 `missing`으로 돌려주어
 * 화면이 "몇 개는 지금 이력에 없다"고 적게 한다. 조용히 지우면 사용자는 자기가 고른 것이
 * 전달됐다고 믿는다.
 */
export function resolveAiaReviewSelection(input: {
  picked: readonly string[];
  commits: readonly AiaReviewCommitInput[];
}): AiaReviewSelection {
  const bySha = new Map(input.commits.map((commit) => [commit.sha, commit]));
  const commits: AiaReviewCommitInput[] = [];
  const missing: string[] = [];
  for (const sha of input.picked) {
    const found = bySha.get(sha);
    if (found === undefined) missing.push(sha);
    else commits.push({ sha: found.sha, subject: found.subject });
  }
  return { commits, missing };
}
