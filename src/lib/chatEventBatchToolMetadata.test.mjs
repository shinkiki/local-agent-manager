import assert from "node:assert/strict";
import test from "node:test";
import { createChatEventBatch } from "./chatEventBatch.ts";
import { createHandleRegistry } from "./cancelableHandleFixtures.mjs";

// V4: ChatEventStream의 도구 카드는 이름·상태와 detail/output을 함께 읽는다.
// 출력만 검사하면 병합 중 이름·상태 갱신이나 상세 내용이 유실돼도 통과한다.
test("V4: tool appends preserve the latest name and status, both text streams, and input objects", () => {
  const frame = createHandleRegistry();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), {
    request: frame.start, cancel: frame.stop,
  });
  const chunks = [
    { type: "tool", id: "exec", name: "도구", status: "pending", detail: "npm ", output: null, append: true },
    { type: "tool", id: "exec", name: "명령 실행", status: "running", detail: "test", output: "line one", append: true },
    { type: "tool", id: "exec", name: "", status: "completed", detail: null, output: "\nline two", append: true },
  ];
  const original = structuredClone(chunks);
  for (const chunk of chunks) batch.push(Object.freeze(chunk));

  assert.deepEqual(events, [], "프레임 전에는 조각을 내보내지 않는다");
  assert.equal(frame.pending, 1, "여러 조각도 한 프레임만 예약한다");
  frame.fire();

  assert.deepEqual(events, [{
    type: "tool", id: "exec", name: "명령 실행", status: "completed",
    detail: "npm test", output: "line one\nline two", append: true,
  }]);
  assert.deepEqual(chunks, original, "호출자가 넘긴 조각은 바꾸지 않는다");
  assert.equal(frame.pending, 0);
});

for (const field of ["detail", "output"]) {
  test(`V4: null and empty ${field} appends keep earlier text and initialize absent text`, () => {
    const frame = createHandleRegistry();
    const events = [];
    const batch = createChatEventBatch((event) => events.push(event), {
      request: frame.start, cancel: frame.stop,
    });
    const chunk = (id, value) => ({
      type: "tool", id, name: "명령 실행", status: "running",
      detail: null, output: null, append: true, [field]: value,
    });
    batch.push(chunk("existing", "prefix"));
    batch.push(chunk("existing", null));
    batch.push(chunk("existing", ""));
    batch.push(chunk("empty", null));
    batch.push(chunk("empty", ""));
    batch.push(chunk("empty", null));
    batch.flush();

    assert.deepEqual(events, [chunk("existing", "prefix"), chunk("empty", "")]);
    assert.equal(frame.pending, 0, "명시적으로 비우면 예약 프레임도 걷는다");
    frame.fire();
    assert.equal(events.length, 2, "걷힌 프레임은 중복 전달하지 않는다");
  });
}
