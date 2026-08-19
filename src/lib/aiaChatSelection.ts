import type { ChatSessionInfo } from "../types";

export function selectAiaChat(
  liveChats: ChatSessionInfo[],
  preferredChatId: string | null = null,
): ChatSessionInfo | null {
  if (preferredChatId) {
    const preferred = liveChats.find((chat) => chat.chatId === preferredChatId);
    if (preferred) return preferred;
  }
  for (let index = liveChats.length - 1; index >= 0; index -= 1) {
    if (liveChats[index].state === "waitingApproval") return liveChats[index];
  }
  return liveChats[liveChats.length - 1] ?? null;
}
