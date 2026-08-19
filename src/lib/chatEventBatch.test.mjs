import assert from "node:assert/strict";
import test from "node:test";
import { createChatEventBatch } from "./chatEventBatch.ts";

function fixture() {
  const callbacks = new Map();
  const cancelled = [];
  let nextHandle = 1;
  return {
    callbacks,
    cancelled,
    scheduler: {
      request(callback) {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancel(handle) {
        cancelled.push(handle);
        callbacks.delete(handle);
      },
    },
    runFrame(handle = callbacks.keys().next().value) {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      callback?.();
    },
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
