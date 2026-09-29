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

/**
 * 찾은 턴 하나만 새 값으로 갈아 끼우고, 대상이 없으면 새 턴을 끝에 덧붙인다. 턴 이벤트
 * 반영과 항목 갱신이 같은 두 걸음을 각자 들고 있어, 한쪽만 고치면 나머지가 조용히
 * 어긋났다(대상 판정은 늘렸는데 새 턴을 붙이는 쪽은 그대로인 식으로). 대상은 id가 아니라
 * 참조로 가린다 — 주인 없는 턴은 이벤트의 id와 다른 원소를 가리켜야 하기 때문이다.
 */
function withTurn<Entry>(
  current: ChatTimelineTurn<Entry>[],
  target: ChatTimelineTurn<Entry> | null,
  update: (turn: ChatTimelineTurn<Entry>) => ChatTimelineTurn<Entry>,
  create: () => ChatTimelineTurn<Entry>,
): ChatTimelineTurn<Entry>[] {
  if (!target) return [...current, create()];
  return current.map((turn) => (turn === target ? update(turn) : turn));
}

export function upsertChatTurnState<Entry>(
  current: ChatTimelineTurn<Entry>[],
  event: Extract<ChatEvent, { type: "turn" }>,
): ChatTimelineTurn<Entry>[] {
  const existing = current.find((turn) => turn.id === event.id);
  // 시작 이벤트를 못 받은 턴(리플레이 절단 등)은 항목이 오면서 "running"으로 만들어진다.
  // 그 턴을 닫는 종료 이벤트는 실제 턴 id를 달고 오므로 id로는 만나지 못한다. 빈 턴을
  // 하나 더 만드는 대신 그 주인 없는 턴을 마감해, 화면이 영영 '응답 중'에 남지 않게 한다.
  const target = existing ?? (event.status !== "started" ? lastOrphanRunningTurn(current) : null);
  return withTurn(
    current,
    target,
    (turn) => applyTurnEvent(turn, event),
    () => createTurnFromEvent(event),
  );
}

/**
 * 턴 이벤트가 함께 바꾸는 상태 두 칸. 생성과 갱신이 각각 같은 짝을 손으로 적으면 한쪽에
 * 상태가 늘었을 때 종료 시각 규칙만 빠질 수 있으므로 한곳에서 만든다.
 */
function turnState(event: Extract<ChatEvent, { type: "turn" }>): Pick<
  ChatTimelineTurn<unknown>,
  "status" | "finishedAt"
> {
  return {
    status: event.status,
    finishedAt: event.status === "started" ? null : event.timestamp,
  };
}

function createTurnFromEvent<Entry>(
  event: Extract<ChatEvent, { type: "turn" }>,
): ChatTimelineTurn<Entry> {
  return {
    id: event.id,
    ...turnState(event),
    startedAt: event.timestamp,
    entries: [],
  };
}

function applyTurnEvent<Entry>(
  turn: ChatTimelineTurn<Entry>,
  event: Extract<ChatEvent, { type: "turn" }>,
): ChatTimelineTurn<Entry> {
  return {
    ...turn,
    ...turnState(event),
  };
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
  return withTurn(
    current,
    current.find((turn) => turn.id === turnId) ?? null,
    (turn) => ({ ...turn, entries: update(turn.entries) }),
    // 시작 이벤트 없이 항목만으로 생긴 턴. 아직 끝나지 않았으므로 종료 시각은 비워 둔다.
    () => ({
      id: turnId,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      entries: update([]),
    }),
  );
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
