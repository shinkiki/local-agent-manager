export interface GitConflictAiaRequest {
  projectPath: string;
  operation: string;
  conflictedFiles: readonly string[];
  blockedFiles?: readonly string[];
}

/**
 * C16 충돌을 AIA에 넘길 때 쓰는 요청문. 파일명과 작업 종류만 싣고 명령 출력은 싣지 않는다.
 * 출력에는 원격 URL이나 도구 진단이 섞일 수 있으므로(G4, C16-8) 화면에 보인 원문을 재전송하지
 * 않고, AIA가 등록 프로젝트에서 현재 상태를 다시 읽게 한다.
 */
export function gitConflictAiaPrompt(request: GitConflictAiaRequest): string {
  const conflicted = request.conflictedFiles.length > 0
    ? request.conflictedFiles.map((path) => `- ${path}`).join("\n")
    : "- 없음";
  const blocked = request.blockedFiles && request.blockedFiles.length > 0
    ? `\n로컬 변경 때문에 막힌 파일:\n${request.blockedFiles.map((path) => `- ${path}`).join("\n")}`
    : "";
  return [
    "다음 Git 작업 충돌을 안전하게 해결해줘.",
    `프로젝트: ${request.projectPath}`,
    `작업: ${request.operation}`,
    `충돌 파일:\n${conflicted}${blocked}`,
    "먼저 git 상태와 각 충돌 내용을 읽고, 기존 변경과 양쪽 의도를 보존해 충돌 표시를 제거해줘.",
    "관련 없는 변경은 건드리지 말고, 해결한 파일만 스테이지한 뒤 상태를 다시 확인해줘.",
    "리베이스·병합 같은 진행 중 작업은 충돌이 모두 해결된 것이 확인된 뒤에만 계속하고 결과를 알려줘.",
    "reset --hard, clean, 강제 푸시, 변경 폐기는 사용하지 마.",
  ].join("\n\n");
}
