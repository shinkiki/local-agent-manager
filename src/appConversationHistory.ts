import { useCallback, useEffect, useRef, useState } from "react";
import { restoreConversation, visitConversation, type ConversationHistory, type ConversationLocation } from "./lib/conversationHistory";

export type ChatHistoryNavigator = (chatId: string | null) => Promise<boolean>;

export function useConversationHistory(
  location: ConversationLocation,
  open: (location: ConversationLocation) => Promise<ConversationLocation | false>,
  onError: (error: unknown) => void,
) {
  const [history, setHistory] = useState<ConversationHistory>({ entries: [location], cursor: 0 });
  const historyRef = useRef(history);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const commit = useCallback((next: ConversationHistory) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  useEffect(() => {
    if (!pending.current) commit(visitConversation(historyRef.current, location));
  }, [location, commit, busy]);

  const go = useCallback(async (direction: -1 | 1) => {
    if (pending.current) return;
    const before = historyRef.current;
    const cursor = before.cursor + direction;
    const target = before.entries[cursor];
    if (!target) return;
    pending.current = true;
    setBusy(true);
    try {
      const opened = await open(target);
      if (opened) {
        commit(restoreConversation(before, cursor, opened));
      }
    } catch (error) {
      onError(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [commit, open, onError]);

  return {
    busy,
    canBack: !busy && history.cursor > 0,
    canForward: !busy && history.cursor + 1 < history.entries.length,
    back: () => void go(-1),
    forward: () => void go(1),
  };
}
