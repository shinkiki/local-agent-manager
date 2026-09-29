import assert from "node:assert/strict";
import test from "node:test";

import {
  isRunningTurn,
  segmentChatTimeline,
  updateChatTurnEntries,
  upsertChatTurnState,
} from "./chatTimeline.ts";

test("시작 이벤트 없이 생긴 진행 중 턴은 실제 턴의 종료 이벤트로 마감된다", () => {
  const orphaned = updateChatTurnEntries([], "system", () => ["tool"]);
  assert.equal(orphaned[0].status, "running");

  const closed = upsertChatTurnState(orphaned, { type: "turn", id: "turn-1", status: "completed", timestamp: 42 });
  assert.equal(closed.length, 1, "빈 턴을 하나 더 만들지 않는다");
  assert.equal(closed[0].status, "completed");
  assert.equal(closed[0].finishedAt, 42);
  assert.deepEqual(closed[0].entries, ["tool"]);
});

test("시작 이벤트로 만든 턴은 다른 id의 종료 이벤트에 휘말리지 않는다", () => {
  const started = upsertChatTurnState([], { type: "turn", id: "turn-1", status: "started", timestamp: 1 });
  const next = upsertChatTurnState(started, { type: "turn", id: "turn-0", status: "completed", timestamp: 2 });
  assert.equal(next.length, 2);
  assert.equal(next.find((turn) => turn.id === "turn-1")?.status, "started");
});

test("주인 없는 턴이 있어도 새 시작 이벤트는 새 턴을 만든다", () => {
  const orphaned = updateChatTurnEntries([], "system", () => ["tool"]);
  const next = upsertChatTurnState(orphaned, { type: "turn", id: "turn-2", status: "started", timestamp: 3 });
  assert.equal(next.length, 2);
  assert.equal(next[0].status, "running");
  assert.equal(next[1].status, "started");
});

test("동일한 턴 ID의 종료 이벤트는 해당 턴의 상태와 완료 시각을 갱신한다", () => {
  const started = upsertChatTurnState([], { type: "turn", id: "turn-1", status: "started", timestamp: 10 });
  assert.equal(started[0].finishedAt, null);

  const completed = upsertChatTurnState(started, { type: "turn", id: "turn-1", status: "completed", timestamp: 50 });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, "completed");
  assert.equal(completed[0].finishedAt, 50);
});

test("존재하는 턴의 항목을 갱신할 때 해당 턴의 항목만 변경한다", () => {
  const initial = [
    { id: "turn-1", status: "completed", startedAt: 1, finishedAt: 2, entries: ["a"] },
    { id: "turn-2", status: "running", startedAt: 3, finishedAt: null, entries: ["b"] },
  ];
  const updated = updateChatTurnEntries(initial, "turn-2", (entries) => [...entries, "c"]);
  assert.deepEqual(updated[0].entries, ["a"]);
  assert.deepEqual(updated[1].entries, ["b", "c"]);
});

test("타임라인 항목을 활동 묶음과 개별 표시 항목으로 분할한다", () => {
  const entries = [
    { id: "act-1", kind: "tool_call" },
    { id: "act-2", kind: "tool_result" },
    { id: "msg-1", kind: "text" },
    { id: "hidden-1", kind: "internal" },
    { id: "act-3", kind: "tool_call" },
  ];

  const segments = segmentChatTimeline(
    entries,
    (e) => e.kind.startsWith("tool_"),
    (e) => e.kind !== "internal",
    (e) => e.id,
  );

  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], {
    type: "activity",
    key: "activity-act-1",
    entries: [entries[0], entries[1]],
  });
  assert.deepEqual(segments[1], {
    type: "entry",
    key: "entry-msg-1-2",
    entry: entries[2],
  });
  assert.deepEqual(segments[2], {
    type: "activity",
    key: "activity-act-3",
    entries: [entries[4]],
  });
});

test("진행 중 턴 상태 판정", () => {
  assert.equal(isRunningTurn("started"), true);
  assert.equal(isRunningTurn("running"), true);
  assert.equal(isRunningTurn("completed"), false);
  assert.equal(isRunningTurn("failed"), false);
});
