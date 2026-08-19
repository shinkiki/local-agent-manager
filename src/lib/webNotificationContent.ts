import type { ChatAttentionItem, SessionSummary } from "../types";

type NotificationAttention = Pick<
  ChatAttentionItem,
  "source" | "providerSessionId" | "cwd" | "title"
>;

type NotificationSession = Pick<SessionSummary, "source" | "id" | "title">;

export function attentionNotificationDetail(
  item: NotificationAttention,
  sessions: NotificationSession[],
): string {
  const session = item.providerSessionId
    ? sessions.find((candidate) => (
      candidate.source === item.source && candidate.id === item.providerSessionId
    ))
    : null;
  const sessionTitle = session?.title.trim() || item.title;
  const folder = item.cwd.split(/[\\/]/).filter(Boolean).pop() ?? item.source;
  return `${sessionTitle} · ${folder}`;
}
