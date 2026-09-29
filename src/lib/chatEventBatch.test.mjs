import assert from "node:assert/strict";
import test from "node:test";
import { createChatEventBatch } from "./chatEventBatch.ts";
import { createHandleRegistry } from "./cancelableHandleFixtures.mjs";

function fixture() {
  const registry = createHandleRegistry();
  return {
    callbacks: registry.handles,
    cancelled: registry.stopped,
    // 프레임 예약도 손잡이 하나를 잡고 놓는 일이라 대장을 이름만 바꿔 쓴다.
    scheduler: { request: registry.start, cancel: registry.stop },
    runFrame: registry.fire,
  };
}

test("adjacent message deltas are delivered once per frame", () => {
  const frame = fixture();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);

  batch.push({ type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "안" });
  batch.push({ type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "녕" });

  assert.equal(events.length, 0);
  assert.equal(frame.callbacks.size, 1);
  frame.runFrame();
  assert.deepEqual(events, [
    { type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "안녕" },
  ]);
});

test("different streams preserve their arrival order", () => {
  const frame = fixture();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);

  batch.push({ type: "messageDelta", id: "reasoning", role: "assistant", kind: "thinking", delta: "A" });
  batch.push({ type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "B" });
  frame.runFrame();

  assert.deepEqual(events.map((event) => event.id), ["reasoning", "answer"]);
});

test("non-delta events synchronously flush earlier text", () => {
  const frame = fixture();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);

  batch.push({ type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "done" });
  batch.push({ type: "turn", id: "turn", status: "completed" });

  assert.deepEqual(events.map((event) => event.type), ["messageDelta", "turn"]);
  assert.equal(frame.callbacks.size, 0);
  assert.deepEqual(frame.cancelled, [1]);
});

test("dispose delivers pending text and ignores late socket events", () => {
  const frame = fixture();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);

  batch.push({ type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "last" });
  batch.dispose();
  batch.push({ type: "error", message: "late" });

  assert.deepEqual(events.map((event) => event.type), ["messageDelta"]);
  assert.equal(frame.callbacks.size, 0);
});
