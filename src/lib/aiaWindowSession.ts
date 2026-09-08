import { selectAiaChat } from "./aiaChatSelection.ts";
import type { ChatSessionInfo } from "../types";

const SCOPED_KEY = "agent-manager.aia-window-sessions.v1";
const CHAT_KEY = "agent-manager.aia-chat.v1";

/** 새 창은 다른 창의 최근 대화를 자동으로 가져오지 않는다. 저장소 장애 때도 새 대화만 연다. */
export function enableAiaWindowSessions(shared: Storage): void {
  shared.setItem(SCOPED_KEY, "1");
}

export function rememberAiaWindowSession(shared: Storage, local: Storage, windowId: string | null, chatId: string): void {
  const storage = windowId ? local : shared;
  storage.setItem(windowId ? `${CHAT_KEY}.${windowId}` : CHAT_KEY, chatId);
}

export function selectAiaWindowSession(
  chats: ChatSessionInfo[], shared: Storage, local: Storage, windowId: string | null,
): ChatSessionInfo | null {
  try {
    const storage = windowId ? local : shared;
    const chatId = storage.getItem(windowId ? `${CHAT_KEY}.${windowId}` : CHAT_KEY);
    if (chatId) return chats.find((chat) => chat.chatId === chatId) ?? null;
    // 첫 업그레이드 때만 기존 모달의 복원 규칙을 따른다. 다중 창 사용 뒤에는 각 창의 ID만 복원한다.
    return !windowId && !shared.getItem(SCOPED_KEY) ? selectAiaChat(chats) : null;
  } catch {
    return null;
  }
}
