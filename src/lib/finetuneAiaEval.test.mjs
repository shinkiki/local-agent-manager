import assert from "node:assert/strict";
import { test } from "node:test";

import { readCall, readRoute, score } from "../../local-llm-dev/finetune/eval-aia.mjs";

const tools = [{
  type: "function",
  function: { name: "system_read", parameters: { properties: { operation: { enum: ["list_sessions", "get_session_detail"] } } } },
}];

const callSample = {
  messages: [
    { role: "system", content: "색인" },
    { role: "user", content: "요청: 세션 목록" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "system_read", arguments: JSON.stringify({ operation: "list_sessions", arguments: { limit: 20 } }) } }] },
  ],
  tools,
  meta: { task: "toolcall", operation: "list_sessions" },
};
const answer = (operation, args, tool = "system_read") => ({ tool_calls: [{ function: { name: tool, arguments: JSON.stringify({ operation, arguments: args }) } }] });

test("도구 호출을 편다", () => {
  assert.deepEqual(readCall(answer("list_sessions", { limit: 20 })), { tool: "system_read", operation: "list_sessions", arguments: { limit: 20 } });
  assert.equal(readCall({ content: "글만 썼다" }), null);
  // 인자가 깨진 JSON 이어도 멈추지 않는다.
  assert.deepEqual(readCall({ tool_calls: [{ function: { name: "system_read", arguments: "{깨짐" } }] }), { tool: "system_read", operation: "", arguments: {} });
});

test("라우팅 한 줄에서 갈래를 읽는다", () => {
  assert.equal(readRoute("직접"), "direct");
  assert.equal(readRoute("위임: 코드 고치기를 넘긴다\n두 번째 줄"), "delegate");
  assert.equal(readRoute("사람: 어느 쪽인지 정한다"), "human");
  assert.equal(readRoute("음, 글쎄요"), null);
});

test("맞는 호출은 실패 종류가 없다", () => {
  assert.deepEqual(score(callSample, answer("list_sessions", { limit: 20 })), []);
});

test("실패 종류를 가른다", () => {
  assert.deepEqual(score(callSample, { content: "목록을 보겠습니다" }), ["호출없음"]);
  assert.deepEqual(score(callSample, answer("get_all_sessions", {})), ["이름틀림"], "색인에 없는 이름은 지어낸 것");
  assert.deepEqual(score(callSample, answer("get_session_detail", {})), ["이름다름"], "색인에 있지만 다른 작업");
  assert.deepEqual(score(callSample, answer("list_sessions", {})), ["인자빠짐"]);
  assert.deepEqual(score(callSample, answer("list_sessions", { limit: 20, cursor: "c" })), ["인자더함"]);
  assert.ok(score(callSample, answer("list_sessions", { limit: 20 }, "system_execute")).includes("도구다름"));
});

test("라우팅 채점은 갈래만 본다", () => {
  const sample = { messages: [{}, { content: "요청: 고쳐줘" }, { role: "assistant", content: "위임: 넘긴다" }], meta: { task: "routing" } };
  assert.deepEqual(score(sample, { content: "위임: 1티어에 넘긴다" }), []);
  assert.deepEqual(score(sample, { content: "직접" }), ["판단다름"]);
  assert.deepEqual(score(sample, { content: "글쎄요" }), ["형식벗어남"]);
});

test("이름 풀이는 작업 이름과 조회·변경을 본다", () => {
  const sample = { messages: [{}, {}, { role: "assistant", content: "list_sessions 은 조회 작업이다. 세션 목록." }], meta: { task: "feature-name", operation: "list_sessions" } };
  assert.deepEqual(score(sample, { content: "list_sessions 은 조회 작업입니다." }), []);
  assert.deepEqual(score(sample, { content: "list_sessions 은 변경 작업입니다." }), ["갈래다름"]);
  assert.deepEqual(score(sample, { content: "그런 작업은 변경입니다." }), ["이름다름", "갈래다름"], "둘 다 틀리면 둘 다 센다");
  assert.deepEqual(score(sample, { content: "그 작업은 조회입니다." }), ["이름다름"]);
});

test("없는 기능에서 도구를 부르면 지어낸 것이다", () => {
  const sample = { messages: [{}, {}, { role: "assistant", content: "그런 기능은 없다." }], meta: { task: "feature-absent", operation: null } };
  assert.deepEqual(score(sample, { content: "그 일은 설정 화면에서 합니다." }), []);
  assert.deepEqual(score(sample, answer("list_sessions", {})), ["지어냄"]);
});
