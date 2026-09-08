export const CHAT_CLOSE_CONFIRMATION_KEY = "agent-manager.chat-close-confirmation";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function shouldConfirmChatClose(storage?: ReadableStorage): boolean {
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    return target?.getItem(CHAT_CLOSE_CONFIRMATION_KEY) !== "hidden";
  } catch {
    // 저장소를 읽지 못하면 안전하게 확인을 계속 표시한다.
    return true;
  }
}

export function hideChatCloseConfirmation(storage?: WritableStorage): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    target?.setItem(CHAT_CLOSE_CONFIRMATION_KEY, "hidden");
  } catch {
    // UI 선호 저장 실패가 채팅 종료 자체를 막지는 않는다.
  }
}
