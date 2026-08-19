import type { ChatAttentionItem, ChatAttentionSnapshot } from "../types";

export function withoutAiaAttention(snapshot: ChatAttentionSnapshot): ChatAttentionSnapshot {
  const items = snapshot.items.filter((item) => item.profile !== "aia");
  return {
    items,
    unreadCount: items.filter((item) => !item.read || item.kind === "approval").length,
    pendingCount: items.filter((item) => item.kind === "approval").length,
  };
}

export function selectAiaAttention(items: ChatAttentionItem[]): ChatAttentionItem | null {
  const aiaItems = items.filter((item) => item.profile === "aia");
  return aiaItems.find((item) => item.kind === "approval")
    ?? aiaItems.find((item) => !item.read && (item.kind === "completed" || item.kind === "failed"))
    ?? null;
}
