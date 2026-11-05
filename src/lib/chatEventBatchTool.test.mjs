import assert from "node:assert/strict";
import test from "node:test";
import { createChatEventBatch } from "./chatEventBatch.ts";
import { createHandleRegistry } from "./cancelableHandleFixtures.mjs";

// V4: 도구 조각을 합쳐도 소비자가 보는 이름·상태·상세·출력과 원본은 보존돼야 한다.
test("V4: tool appends preserve metadata and text across empty and null chunks", () => {
  const frame = createHandleRegistry();
  const events = [];
  const batch = createChatEventBatch((event) => events.push(event), {
    request: frame.start, cancel: frame.stop,
  });
  const chunks = [
    { type: "tool", id: "exec-1", name: "시작", status: "pending", detail: null, output: null, append: true },
    { type: "tool", id: "exec-1", name: "명령 실행", status: "running", detail: "명령 ", output: "첫 줄\n", append: true },
    { type: "tool", id: "exec-1", name: "", status: "running", detail: null, output: "", append: true },
    { type: "tool", id: "exec-1", name: "", status: "completed", detail: "완료", output: "끝", append: true },
  ].map(Object.freeze);
  const original = structuredClone(chunks);

  for (const chunk of chunks) batch.push(chunk);
  assert.deepEqual(events, []);
  assert.equal(frame.pending, 1);
  frame.fire();

  assert.deepEqual(events, [{
    type: "tool", id: "exec-1", name: "명령 실행", status: "completed",
    detail: "명령 완료", output: "첫 줄\n끝", append: true,
  }]);
  assert.deepEqual(chunks, original);
  assert.equal(frame.pending, 0);

  // 이미 전달한 항목도 다음 프레임의 조각 때문에 바뀌어서는 안 된다.
  const delivered = structuredClone(events[0]);
  batch.push(Object.freeze({ ...chunks[0], name: "후속", status: "running", detail: "다음", output: "새 출력" }));
  frame.fire();
  assert.deepEqual(events[0], delivered);
  assert.deepEqual(events[1], {
    type: "tool", id: "exec-1", name: "후속", status: "running",
    detail: "다음", output: "새 출력", append: true,
  });
});
