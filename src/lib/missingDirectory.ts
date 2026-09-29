/**
 * "그 폴더가 없다"는 실패를 알아보고 만들 경로를 꺼낸다. 물어보는 문구는 화면이 공용 확인
 * 모달(`useConfirm`)에 경로를 항목으로 실어 직접 만든다.
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

/**
 * 확인 대화에 나열할 경로 목록(C6-4b). 폴더 만들기는 이미 있는 폴더 아래로 없는 칸을
 * 세 칸까지 함께 만들 수 있으므로, 최종 경로 한 줄만 보여 주면 사용자는 중간 칸이
 * 새로 생긴다는 것을 모른 채 승인하게 된다. 계획을 읽었으면 생길 경로를 모두 싣고,
 * 계획 조회가 실패했으면(원격·경쟁 상태) 원래대로 최종 경로 한 줄만 보여 준다.
 */
export function directoryCreationItems(
  plan: { creates: string[] } | null,
  fallback: string,
): string[] {
  const creates = plan?.creates ?? [];
  return creates.length > 0 ? creates : [fallback];
}
