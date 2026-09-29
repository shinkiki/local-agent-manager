import assert from "node:assert/strict";
import { test } from "node:test";

import { answerSample, callSample, capByLabel, indexCatalog, indexText, pickIndex, routingSample, sampleChars, splitHoldout, toolsFor, trimValue } from "../../local-llm-dev/finetune/build-aia-sft.mjs";

const catalog = {
  read: [
    { operation: "get_session_detail", description: "세션 내용", arguments: { id: "ses_x" } },
    { operation: "get_session_meta", description: "세션 메타", arguments: { id: "ses_x" } },
    { operation: "list_sessions", description: "세션 목록", arguments: { limit: 20 } },
    { operation: "get_app_status", description: "앱 상태", arguments: {} },
    { operation: "get_doc_tree", description: "문서 나무", arguments: { rootId: "r" } },
  ],
  execute: [
    { operation: "patch_session_meta", description: "세션 메타 수정", arguments: { sessionId: "ses_x", patch: {} } },
    { operation: "put_doc", description: "문서 저장", arguments: { id: "d", body: "" } },
  ],
};
const entries = indexCatalog(catalog);

test("색인은 정답을 담고 상한을 넘지 않는다", () => {
  const picked = pickIndex(entries, "get_session_detail", 4);
  assert.equal(picked.length, 4);
  assert.ok(picked.some((e) => e.operation === "get_session_detail"));
  // 헷갈리는 이웃(session 이 든 이름)이 먼저 들어온다.
  assert.ok(picked.filter((e) => e.operation.includes("session")).length >= 3);
});

test("색인 자리는 이름으로 정해져 정답이 늘 첫 줄이 아니다", () => {
  const positions = new Set();
  for (const operation of entries.map((e) => e.operation)) {
    const picked = pickIndex(entries, operation, 4);
    positions.add(picked.findIndex((e) => e.operation === operation));
  }
  assert.ok(positions.size > 1, `정답 자리가 한 곳뿐이다: ${[...positions]}`);
});

test("도구는 색인에 오른 작업만 열어 준다", () => {
  const picked = pickIndex(entries, "put_doc", 4);
  const tools = toolsFor(picked);
  const names = Object.fromEntries(tools.map((t) => [t.function.name, t.function.parameters.properties.operation.enum]));
  for (const [tool, operations] of Object.entries(names)) {
    for (const operation of operations) {
      assert.equal(picked.find((e) => e.operation === operation).tool, tool);
    }
  }
  assert.ok(names.system_execute.includes("put_doc"));
});

test("색인 글은 작업마다 도구·설명·인자를 적는다", () => {
  const text = indexText([entries.find((e) => e.operation === "list_sessions")]);
  assert.equal(text, '- list_sessions (system_read): 세션 목록. 인자: {"limit":20}');
});

test("라우팅 표본은 한 줄 판단으로 끝난다", () => {
  const direct = routingSample({ request: "세션 목록 보여줘", prior: "", label: "direct", source: "a" });
  assert.equal(direct.messages.at(-1).content, "직접");
  assert.equal(direct.messages[1].content, "요청: 세션 목록 보여줘");
  const delegate = routingSample({ request: "고쳐줘", prior: "무엇을 고칠까요?", label: "delegate", source: "a" });
  assert.match(delegate.messages[1].content, /^직전에 내가 한 말: 무엇을 고칠까요\?/);
  assert.match(delegate.messages.at(-1).content, /^위임:/);
  assert.match(routingSample({ request: "뭐가 나아?", label: "human", source: "a" }).messages.at(-1).content, /^사람:/);
});

test("도구 호출 표본은 색인·요청·호출 한 벌이다", () => {
  const sample = callSample({ request: "이 세션 내용 보여줘", tool: "system_read", operation: "get_session_detail", arguments: { id: "ses_x" }, source: "a" }, entries);
  assert.match(sample.messages[0].content, /색인:/);
  assert.match(sample.messages[0].content, /- get_session_detail \(system_read\)/);
  const call = sample.messages.at(-1).tool_calls[0].function;
  assert.equal(call.name, "system_read");
  assert.deepEqual(JSON.parse(call.arguments), { operation: "get_session_detail", arguments: { id: "ses_x" } });
  assert.equal(sample.meta.task, "toolcall");
});

test("카탈로그에 없는 작업은 표본을 만들지 않는다", () => {
  assert.equal(callSample({ request: "부르기", tool: "system_read", operation: "get_removed_thing", arguments: {} }, entries), null);
});

test("없는 기능 표본은 글로 답한다", () => {
  const sample = answerSample({ kind: "absent", request: "API 키 바꿔줘", answer: "키는 설정 화면에서 넣는다.", operation: null });
  assert.equal(sample.messages.at(-1).content, "키는 설정 화면에서 넣는다.");
  assert.equal(sample.meta.task, "feature-absent");
  assert.equal(sample.tools, undefined, "글로 답하는 표본은 도구를 열지 않는다");
});

test("라벨 상한은 많은 쪽만 순서대로 자른다", () => {
  const items = [{ l: "a" }, { l: "b" }, { l: "a" }, { l: "a" }, { l: "b" }];
  assert.deepEqual(capByLabel(items, (i) => i.l, 2), [{ l: "a" }, { l: "b" }, { l: "a" }, { l: "b" }]);
  assert.equal(capByLabel(items, (i) => i.l, 0).length, 5, "0 이면 자르지 않는다");
});

test("긴 인자 값은 줄이고 모양은 남긴다", () => {
  const trimmed = trimValue({ body: "가".repeat(500), id: "d", tags: ["a", "b"], nested: { text: "나".repeat(300) } });
  assert.ok(trimmed.body.length < 210 && trimmed.body.endsWith("…(줄임)"));
  assert.equal(trimmed.id, "d");
  assert.deepEqual(trimmed.tags, ["a", "b"]);
  assert.ok(trimmed.nested.text.endsWith("…(줄임)"), "중첩된 값도 따라 들어간다");
});

test("표본 글자 수는 시스템 글·요청·호출·도구를 모두 센다", () => {
  const sample = callSample({ request: "부르기", tool: "system_read", operation: "list_sessions", arguments: {} }, entries);
  assert.ok(sampleChars(sample) > sample.messages[0].content.length);
});

test("시험 몫은 과제 종류마다 고르게 뺀다", () => {
  const samples = [];
  for (let i = 0; i < 12; i += 1) samples.push({ meta: { task: i % 2 ? "routing" : "toolcall" } });
  const { train, holdout } = splitHoldout(samples, 3);
  assert.equal(holdout.length, 4, "종류마다 여섯 건 중 두 건");
  assert.equal(holdout.filter((s) => s.meta.task === "routing").length, 2);
  assert.equal(train.length, 8);
  // 같은 입력이면 같은 갈래다.
  assert.deepEqual(splitHoldout(samples, 3).holdout, holdout);
  assert.equal(splitHoldout(samples, 0).holdout.length, 0, "0 이면 가르지 않는다");
});

test("도구 스키마는 인자 칸도 필수로 둔다", () => {
  const tools = toolsFor(pickIndex(entries, "list_sessions", 4));
  for (const tool of tools) {
    assert.deepEqual(tool.function.parameters.required, ["operation", "arguments"],
      "선택으로 두면 서빙 층이 덜 강조해 모델이 인자를 건너뛴다");
  }
});

// 6회차에서 "반드시 도구를 부른다" 한 줄을 넣고 재 봤더니 값이 없었다(있음 88/93, 없음 92/94).
// 그 줄을 넣게 만든 진단 자체가 틀렸다 — 설명을 읊던 것은 모드 혼동이 아니라 변환기 손상이었다.
test("호출 표본의 시스템 글은 색인에서 고르라고만 말한다", () => {
  const sample = callSample({ request: "부르기", tool: "system_read", operation: "list_sessions", arguments: {} }, entries);
  assert.doesNotMatch(sample.messages[0].content, /반드시 도구를 부른다/);
  assert.match(sample.messages[0].content, /색인에 있는 작업만 부를 수 있다/);
});
