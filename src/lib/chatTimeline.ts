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
    // 시작 이벤트를 못 받은 턴(리플레이 절단 등)은 항목이 오면서 "running"으로 만들어진다.
    // 그 턴을 닫는 종료 이벤트는 실제 턴 id를 달고 오므로 id로는 만나지 못한다. 빈 턴을
    // 하나 더 만드는 대신 그 주인 없는 턴을 마감해, 화면이 영영 '응답 중'에 남지 않게 한다.
    const orphan = event.status !== "started" ? lastOrphanRunningTurn(current) : null;
    if (orphan) {
      return current.map((turn) => turn === orphan
        ? { ...turn, status: event.status, finishedAt: event.timestamp }
        : turn);
    }
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

/** 시작 이벤트 없이 항목만으로 생긴 진행 중 턴. 시작 이벤트로 만든 턴은 "started"로 시작한다. */
function lastOrphanRunningTurn<Entry>(current: ChatTimelineTurn<Entry>[]): ChatTimelineTurn<Entry> | null {
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current[index].status === "running") return current[index];
  }
  return null;
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
