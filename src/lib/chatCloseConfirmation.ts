import { readStoredText, writeStoredText, type StoredTextStorage } from "./storedText.ts";

/**
 * 채팅 닫기 확인창을 다시 보일지에 대한 저장 규칙.
 *
 * 저장소 접근은 `storedText.ts`에 맡긴다. 쿠키를 전면 차단한 브라우저는
 * `window.localStorage`를 읽는 것만으로 던지고 사파리 프라이빗 모드는 쓰기에서 던지는데,
 * 이 파일이 그 예외를 자기 try/catch 한 벌로 따로 삼키고 있었다. 삼키는 자리가 늘어나면
 * "읽기는 저장값 없음, 쓰기는 무동작"이라는 규칙이 파일마다 조금씩 달라진다 — 실제로
 * 여기는 읽기와 쓰기가 서로 다른 저장소 모양(`getItem`만 / `setItem`만)을 받고 실패
 * 기본값을 호출부마다 넘기는 방식이라, 저장소가 없는 실행과 막힌 저장소를 가르는 판정도
 * 자기 몫으로 안고 있었다.
 *
 * 이 파일에 남는 것은 저장 키와 저장 문자열이 뜻하는 화면 상태뿐이다.
 */

export const CHAT_CLOSE_CONFIRMATION_KEY = "agent-manager.chat-close-confirmation";

/** 확인창을 다시 보이지 않기로 했을 때 저장하는 값. 그 밖의 값과 저장 없음은 모두 "보임"이다. */
const HIDDEN_VALUE = "hidden";

/** 채팅을 닫기 전에 확인창을 띄워야 하는지. 저장소를 읽을 수 없으면 계속 확인한다. */
export function shouldConfirmChatClose(storage?: StoredTextStorage | null): boolean {
  return readStoredText(CHAT_CLOSE_CONFIRMATION_KEY, storage) !== HIDDEN_VALUE;
}

/** 다음부터 확인창을 띄우지 않는다. 저장에 실패해도 현재 실행 중에는 고른 값이 그대로 쓰인다. */
export function hideChatCloseConfirmation(storage?: StoredTextStorage | null): void {
  writeStoredText(CHAT_CLOSE_CONFIRMATION_KEY, HIDDEN_VALUE, storage);
}
