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

for (const [field, value] of [["role", "user"], ["kind", "thinking"]]) {
  test(`V4: same-id message deltas keep different ${field} streams separate`, () => {
    const frame = fixture();
    const events = [];
    const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);
    const first = { type: "messageDelta", id: "shared", role: "assistant", kind: "text", delta: "A" };
    const second = { ...first, [field]: value, delta: "B" };

    batch.push(first);
    batch.push(second);
    assert.equal(events.length, 0);
    frame.runFrame();

    assert.deepEqual(events, [first, second]);
    assert.equal(frame.callbacks.size, 0);
  });
}

test("V4: returning to an earlier message stream keeps intervening deltas in order", () => {
  const frame = fixture();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);
  const chunks = [
    { type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "A" },
    { type: "messageDelta", id: "reasoning", role: "assistant", kind: "thinking", delta: "B" },
    { type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "C" },
  ];

  for (const chunk of chunks) batch.push(chunk);
  assert.equal(frame.callbacks.size, 1);
  frame.runFrame();

  assert.deepEqual(events, chunks);
  assert.equal(frame.callbacks.size, 0);
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

test("adjacent tool output appends are merged into one event per frame", () => {
  const frame = fixture();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);

  const chunk = (output) => ({ type: "tool", id: "exec-1", name: "명령 실행", status: "running", detail: null, output, append: true });
  batch.push(chunk("line one\n"));
  batch.push(chunk("line two\n"));

  assert.equal(events.length, 0);
  assert.equal(frame.callbacks.size, 1);
  frame.runFrame();
  assert.deepEqual(events, [
    { type: "tool", id: "exec-1", name: "명령 실행", status: "running", detail: null, output: "line one\nline two\n", append: true },
  ]);
});

test("appends of different tool cards and a final snapshot keep their order", () => {
  const frame = fixture();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);

  batch.push({ type: "tool", id: "exec-1", name: "명령 실행", status: "running", detail: null, output: "a", append: true });
  batch.push({ type: "tool", id: "exec-2", name: "명령 실행", status: "running", detail: null, output: "b", append: true });
  batch.push({ type: "tool", id: "exec-1", name: "명령 실행", status: "running", detail: null, output: "c", append: true });
  // 완료 스냅숏은 이어 붙는 조각이 아니다. 앞선 조각을 비운 뒤 그 자리에서 전달된다.
  batch.push({ type: "tool", id: "exec-1", name: "명령 실행", status: "completed", detail: "ls", output: "abc", append: false });

  assert.deepEqual(events.map((event) => [event.id, event.output, event.append]), [
    ["exec-1", "a", true],
    ["exec-2", "b", true],
    ["exec-1", "c", true],
    ["exec-1", "abc", false],
  ]);
  assert.equal(frame.callbacks.size, 0);
});

for (const delivery of ["frame", "flush"]) {
  test(`V4: ${delivery} preserves tool descriptions and the latest name and status`, () => {
    const frame = fixture();
    const events = [];
    const batch = createChatEventBatch((event) => events.push(event), frame.scheduler);
    const chunks = [
      { type: "tool", id: "exec-1", name: "명령", status: "pending", detail: null, output: null, append: true },
      { type: "tool", id: "exec-1", name: "명령 실행", status: "running", detail: "npm ", output: "첫 줄\n", append: true },
      { type: "tool", id: "exec-1", name: "", status: "completed", detail: "test", output: "둘째 줄", append: true },
      { type: "tool", id: "exec-1", name: "", status: "completed", detail: null, output: null, append: true },
    ];
    const originalChunks = structuredClone(chunks);

    for (const chunk of chunks) batch.push(chunk);
    assert.deepEqual(events, [], "도구 조각은 전달 경계까지 모아 둔다");
    const turn = { type: "turn", id: "turn-1", status: "completed" };
    if (delivery === "frame") frame.runFrame();
    else batch.push(turn);

    const merged = {
      type: "tool", id: "exec-1", name: "명령 실행", status: "completed",
      detail: "npm test", output: "첫 줄\n둘째 줄", append: true,
    };
    assert.deepEqual(events, delivery === "frame" ? [merged] : [merged, turn]);
    assert.deepEqual(chunks, originalChunks, "병합이 호출자의 원본 조각을 고치지 않는다");
    assert.equal(frame.callbacks.size, 0, "전달 뒤에는 프레임 예약을 남기지 않는다");
  });
}
