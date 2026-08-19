import type { ChatEvent } from "../types";

export interface ChatTimelineTurn<Entry> {
  id: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  entries: Entry[];
}

export type ChatTimelineSegment<Entry> =
  | { type: "activity"; key: string; entries: Entry[] }
  | { type: "entry"; key: string; entry: Entry };

export function upsertChatTurnState<Entry>(
  current: ChatTimelineTurn<Entry>[],
  event: Extract<ChatEvent, { type: "turn" }>,
): ChatTimelineTurn<Entry>[] {
  const existing = current.find((turn) => turn.id === event.id);
  if (!existing) {
    return [...current, {
      id: event.id,
      status: event.status,
      startedAt: event.timestamp,
      finishedAt: event.status === "started" ? null : event.timestamp,
      entries: [],
    }];
  }
  return current.map((turn) => turn.id === event.id
    ? { ...turn, status: event.status, finishedAt: event.status === "started" ? null : event.timestamp }
    : turn);
}

export function updateChatTurnEntries<Entry>(
  current: ChatTimelineTurn<Entry>[],
  turnId: string,
  update: (entries: Entry[]) => Entry[],
): ChatTimelineTurn<Entry>[] {
  if (!current.some((turn) => turn.id === turnId)) {
    return [...current, {
      id: turnId,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      entries: update([]),
    }];
  }
  return current.map((turn) => turn.id === turnId
    ? { ...turn, entries: update(turn.entries) }
    : turn);
}

export function segmentChatTimeline<Entry>(
  entries: Entry[],
  isActivity: (entry: Entry) => boolean,
  isVisible: (entry: Entry) => boolean,
  entryKey: (entry: Entry) => string,
): ChatTimelineSegment<Entry>[] {
  const segments: ChatTimelineSegment<Entry>[] = [];
  let activityEntries: Entry[] = [];

  const flushActivities = () => {
    const first = activityEntries[0];
    if (!first) return;
    segments.push({
      type: "activity",
      key: `activity-${entryKey(first)}`,
      entries: activityEntries,
    });
    activityEntries = [];
  };

  entries.forEach((entry, index) => {
    if (isActivity(entry)) {
      activityEntries.push(entry);
      return;
    }
    flushActivities();
    if (isVisible(entry)) {
      segments.push({
        type: "entry",
        key: `entry-${entryKey(entry)}-${index}`,
        entry,
      });
    }
  });
  flushActivities();
  return segments;
}

export function isRunningTurn(status: string): boolean {
  return status === "started" || status === "running";
}
