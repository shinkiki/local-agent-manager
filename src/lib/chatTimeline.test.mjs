import assert from "node:assert/strict";
import test from "node:test";

import { updateChatTurnEntries, upsertChatTurnState } from "./chatTimeline.ts";

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
