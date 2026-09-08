/**
 * "그 폴더가 없다"는 실패를 알아보고, 사용자에게 물어볼 문구를 만든다.
 *
 * 채팅 작업 경로는 WebSocket 거절 이벤트로, 문서 폴더는 HTTP 오류 본문으로 온다. 두
 * 경로가 공유하는 것은 문구뿐이라, Rust `user_path::MISSING_DIRECTORY_PREFIX`와 같은
 * 접두사를 여기서 다시 정의하고 양쪽 테스트로 묶는다. 한쪽만 바꾸면 확인 대화가 조용히
 * 사라지고 사용자는 다시 원인 없는 오류만 보게 된다.
 */
export const MISSING_DIRECTORY_PREFIX = "경로를 찾을 수 없습니다: ";

/** 실패 문구가 "그 폴더가 없다"는 뜻이면 없는 경로를, 아니면 null을 돌려준다. */
export function missingDirectoryPath(message: string): string | null {
  const at = message.indexOf(MISSING_DIRECTORY_PREFIX);
  if (at < 0) return null;
  // 호출자가 앞뒤에 자기 문장을 붙여 보내는 경우가 있어, 접두사 뒤 한 줄만 경로로 읽는다.
  const path = message.slice(at + MISSING_DIRECTORY_PREFIX.length).split("\n")[0].trim();
  return path.length > 0 ? path : null;
}

/** 폴더를 만들지 물어보는 확인 문구. 만들 대상 경로를 먼저 보여준다. */
export function missingDirectoryPrompt(path: string): string {
  return `${path}\n\n이 경로에 폴더가 없습니다. 새로운 폴더를 만드시겠습니까?`;
}
