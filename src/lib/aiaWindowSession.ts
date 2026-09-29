import { selectAiaChat } from "./aiaChatSelection.ts";
import type { ChatSessionInfo } from "../types";

const SCOPED_KEY = "agent-manager.aia-window-sessions.v1";
const CHAT_KEY = "agent-manager.aia-chat.v1";

/** 새 창은 다른 창의 최근 대화를 자동으로 가져오지 않는다. 저장소 장애 때도 새 대화만 연다. */
export function enableAiaWindowSessions(shared: Storage): void {
  shared.setItem(SCOPED_KEY, "1");
}

/**
 * 이 창의 대화 id를 남기는 자리 — 어느 저장소의 어느 키인가. 창 ID를 가진 팝아웃은 자기
 * 세션 저장소에 창별 키로 남기고, 메인 창은 창을 여러 개 쓰기 전부터 있던 공유 저장소의
 * 단일 키를 그대로 쓴다.
 *
 * 저장소와 키를 고르는 판정이 남길 때와 읽을 때 두 벌로 펼쳐져 있었다. 두 곳이 같은 자리를
 * 가리켜야만 복원이 성립하는데, 한쪽만 고치면 남긴 대화를 아무도 읽지 않아 팝아웃이 늘 새
 * 대화로 열린다 — 오류 없이 조용히 어긋나는 갈래라 여기 한 벌만 둔다.
 */
function windowChatSlot(
  shared: Storage,
  local: Storage,
  windowId: string | null,
): { storage: Storage; key: string } {
  return windowId
    ? { storage: local, key: `${CHAT_KEY}.${windowId}` }
    : { storage: shared, key: CHAT_KEY };
}

export function rememberAiaWindowSession(shared: Storage, local: Storage, windowId: string | null, chatId: string): void {
  const { storage, key } = windowChatSlot(shared, local, windowId);
  storage.setItem(key, chatId);
}

export function selectAiaWindowSession(
  chats: ChatSessionInfo[], shared: Storage, local: Storage, windowId: string | null,
): ChatSessionInfo | null {
  try {
    const { storage, key } = windowChatSlot(shared, local, windowId);
    const chatId = storage.getItem(key);
    if (chatId) return chats.find((chat) => chat.chatId === chatId) ?? null;
    // 첫 업그레이드 때만 기존 모달의 복원 규칙을 따른다. 다중 창 사용 뒤에는 각 창의 ID만 복원한다.
    return !windowId && !shared.getItem(SCOPED_KEY) ? selectAiaChat(chats) : null;
  } catch {
    return null;
  }
}
