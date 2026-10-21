import type { ProviderId, ViewId } from "../types";

/** Window-local navigation only: no conversation bodies or provider state (G1, G2, G7). */
export type ConversationLocation =
  | { view: "chat"; chatId: string; source: ProviderId; sessionId: string | null }
  | { view: "sessions"; source: ProviderId; sessionId: string }
  | { view: ViewId };

export interface ConversationHistory {
  entries: ConversationLocation[];
  cursor: number;
}

export const HISTORY_LIMIT = 80;

export function sameConversationLocation(a: ConversationLocation, b: ConversationLocation): boolean {
  if (a.view !== b.view) return false;
  if ("chatId" in a || "chatId" in b) return "chatId" in a && "chatId" in b && a.chatId === b.chatId;
  if ("sessionId" in a || "sessionId" in b) {
    return "sessionId" in a && "sessionId" in b && a.source === b.source && a.sessionId === b.sessionId;
  }
  return true;
}

export function visitConversation(history: ConversationHistory, location: ConversationLocation): ConversationHistory {
  const current = history.entries[history.cursor];
  if (current && sameConversationLocation(current, location)) {
    // A newly started chat learns its provider session ID later; keep its fallback current.
    if (JSON.stringify(current) === JSON.stringify(location)) return history;
    const entries = [...history.entries];
    entries[history.cursor] = location;
    return { ...history, entries };
  }
  const entries = [...history.entries.slice(0, history.cursor + 1), location].slice(-HISTORY_LIMIT);
  return { entries, cursor: entries.length - 1 };
}

/** Commit only after opening succeeds. A failed attach must leave the cursor unchanged. */
export function restoreConversation(history: ConversationHistory, cursor: number, location: ConversationLocation): ConversationHistory {
  if (cursor < 0 || cursor >= history.entries.length) return history;
  const entries = [...history.entries];
  entries[cursor] = location;
  return { entries, cursor };
}
