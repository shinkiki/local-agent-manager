import { DESTRUCTIVE_GIT_COMMANDS_BAN } from "./projectAiaHandoff.ts";

export interface GitConflictAiaRequest {
  projectPath: string;
  operation: string;
  conflictedFiles: readonly string[];
  /**
   * 왜 막혔는가. `conflict`는 충돌 표시가 작업 트리에 남은 것이고, `blocked`는 커밋하지 않은
   * 로컬 변경 때문에 명령이 아예 시작하지 못한 것이다. Core가 두 목록을 서로 배타적으로
   * 채우므로(`project_git.rs`의 `Conflict`·`BlockedByLocalChanges`) 요청문 첫 줄도 갈라진다.
   */
  kind?: "conflict" | "blocked";
  /**
   * 기본값은 읽기 전용이다(점검표 A6). 충돌을 대신 풀게 하려면 호출자가 그 자리에서
   * `readOnly: false`를 명시해야 하고, 그 요청도 AIA가 사용자 승인을 받은 뒤에만 바꾼다.
   * 오늘 그 값을 주는 화면 호출자는 없다 — 해결은 따로 승인받는 별도 요청이다(2026-10-10 결정 C).
   */
  readOnly?: boolean;
}

/**
 * C16 충돌을 AIA에 넘길 때 쓰는 요청문. **충돌 파일 좌표만** 싣고 명령 출력은 싣지 않는다.
 * 출력에는 원격 URL이나 도구 진단이 섞일 수 있으므로(G4, C16-8) 화면에 보인 원문을 재전송하지
 * 않고, AIA가 등록 프로젝트에서 현재 상태를 다시 읽게 한다.
 *
 * 기본이 읽기·분석인 이유는 `buildAiaCommitReviewRequest`와 같다(점검표 A6, 2026-10-10 결정 C).
 * 충돌 해결은 작업 트리를 바꾸는 일이고 C16-4가 제공조차 하지 않는 명령으로 번지기 쉬운데,
 * 화면의 버튼 하나가 그 권한까지 함께 넘기면 사용자는 "분석해줘"를 눌렀다고 믿은 자리에서
 * 파일이 바뀐 것을 나중에 본다. 그래서 기본은 읽고 적는 것이고, 바꾸는 권한은 호출자가
 * 그 자리에서 명시할 때만 열린다.
 *
 * `blockedFiles`는 더 이상 싣지 않는다. 막힌 파일은 충돌이 아니라 **사용자가 아직 커밋하지
 * 않은 자기 변경**이고, 그 목록을 해결 요청에 함께 실으면 AIA가 치워야 할 대상으로 읽는다 —
 * 폐기가 곧 복구할 수 없는 손실인 바로 그 파일들이다. 대신 `kind: "blocked"`로 상황만 알리고
 * 어떤 파일이 걸렸는지는 AIA가 직접 읽게 한다.
 *
 * 금지 목록은 적지 않고 `DESTRUCTIVE_GIT_COMMANDS_BAN` 하나를 쓴다(점검표 A7). 같은 집합을
 * 두 파일에 따로 적어 두었더니 한쪽만 넓어졌다 — 2026-10-11에 `projectAiaHandoff` 쪽이
 * `push --force-with-lease`·`branch -D`·대화형 rebase까지 이름을 적는 동안 이 파일은 옛
 * 뜻풀이에 머물러 있었다. C16-4가 제공하지 않는 명령을 요청문이 빠뜨리면, 분석 답변이 적어
 * 준 한 줄을 사용자가 그대로 붙여 넣는 자리에서 되돌릴 수 없는 손실이 난다.
 */
export function gitConflictAiaPrompt(request: GitConflictAiaRequest): string {
  const readOnly = request.readOnly !== false;
  const blocked = request.kind === "blocked";
  const conflicted = request.conflictedFiles.length > 0
    ? request.conflictedFiles.map((path) => `- ${path}`).join("\n")
    : "- 없음";
  return [
    blocked
      ? "다음 Git 작업이 커밋하지 않은 로컬 변경 때문에 막혔어. 무엇이 걸렸는지 분석해줘."
      : readOnly
        ? "다음 Git 작업 충돌을 분석해줘."
        : "다음 Git 작업 충돌을 안전하게 해결해줘.",
    `프로젝트: ${request.projectPath}`,
    `작업: ${request.operation}`,
    blocked
      ? "막힌 파일 목록은 이 요청에 없어 — 커밋하지 않은 사용자의 변경이라 싣지 않았으니 등록 프로젝트에서 git 상태를 직접 읽어줘."
      : `충돌 파일:\n${conflicted}`,
    blocked
      ? "각 변경이 이 작업과 어떻게 부딪히는지 보고, 커밋·스태시·되돌리기 중 무엇이 맞는지 근거와 함께 적어줘."
      : "먼저 git 상태와 각 충돌 내용을 읽고, 양쪽이 무엇을 바꾸려 했는지 파악해줘.",
    readOnly
      ? "파일이나 git 상태를 바꾸지는 마. 어느 쪽을 어떻게 남겨야 하는지, 그리고 이어서 무엇을 실행하면 되는지만 적어줘."
      : "기존 변경과 양쪽 의도를 보존해 충돌 표시를 제거하되, 무엇을 어떻게 고칠지 먼저 알리고 승인을 받은 뒤에만 바꿔줘. 관련 없는 변경은 건드리지 말고, 해결한 파일만 스테이지한 뒤 상태를 다시 확인해줘. 리베이스·병합 같은 진행 중 작업은 충돌이 모두 해결된 것이 확인된 뒤에만 계속해줘.",
    DESTRUCTIVE_GIT_COMMANDS_BAN,
  ].join("\n\n");
}

/**
 * 영수증 배너가 AIA 버튼을 내밀어도 되는가(점검표 A6).
 *
 * 요청문이 싣는 좌표는 충돌 파일뿐이지만, 넘길 좌표가 없다고 버튼까지 없애면 **막힌 영수증이
 * 쓰던 경로가 조용히 사라진다.** Core는 두 목록을 배타적으로 채우므로(`Conflict` ↔
 * `BlockedByLocalChanges`) 막힌 영수증의 `conflictedFiles`는 언제나 비어 있고, 좁히면 가장
 * 흔한 실패에서 버튼이 없어진다. AIA는 어차피 등록 프로젝트에서 현재 상태를 직접 읽으므로
 * 좌표가 없는 것이 요청을 못 쓰게 만들지도 않는다 — `kind: "blocked"`가 그 자리를 메운다.
 *
 * 화면 안의 조건식으로 두면 어느 층의 시험도 닿지 못해 양쪽으로 조용히 뒤집힌다. 그래서
 * 여기로 꺼내 실제 입력으로 판정을 고정한다.
 */
export function canRequestGitConflictAia(receipt: {
  succeeded: boolean;
  conflictedFiles: readonly string[];
  blockedFiles: readonly string[];
}): boolean {
  if (receipt.succeeded) return false;
  return receipt.conflictedFiles.length > 0 || receipt.blockedFiles.length > 0;
}
