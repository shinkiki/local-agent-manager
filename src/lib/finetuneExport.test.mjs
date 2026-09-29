import assert from "node:assert/strict";
import { test } from "node:test";

import { balance, isClean, planningTools, toConversation } from "../../local-llm-dev/finetune/export-sft.mjs";

// 계약의 필요한 칸만 흉내 낸다. 영수증은 단계 수마다 다르다.
const contract = {
  index: "- read: Reads one file.\n- notion-create-pages (notion-team · 노션): Creates pages.",
  systemPrompt: "PLAN <INDEX>",
  prompt: "<REQUEST>",
  draftSchemas: [{ name: "add_step", description: "", parameters: {} }, { name: "finish_plan", description: "", parameters: {} }],
  continuations: [{ receipt: { step: 0 } }, { receipt: { step: 1 } }, { receipt: { step: 2 } }],
};
const call = (name, args) => ({ role: "assistant", content: "", reasoning: "생각", tool_calls: [{ id: `c${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const record = (overrides = {}) => ({
  ok: true, variant: "guard", nudges: 0, badNames: 0, mismatches: 0, repairs: 0, model: "m", task: "t", marker: "k1", prompt: "요청",
  trace: [call("plan_add_step", { title: "읽기", tools: ["read"] }), call("plan_finish_plan", {})],
  ...overrides,
});

test("깨끗한 궤적만 학습에 쓴다", () => {
  assert.equal(isClean(record()), true);
  assert.equal(isClean(record({ ok: false })), false);
  assert.equal(isClean(record({ nudges: 1 })), false);
  assert.equal(isClean(record({ badNames: 1 })), false);
  assert.equal(isClean(record({ mismatches: 1 })), false);
  assert.equal(isClean(record({ variant: "baseline" })), false);
  assert.equal(isClean(record({ trace: [] })), false);
});

test("궤적은 시스템 글·요청·도구 호출·영수증 순의 대화로 복원된다", () => {
  const conversation = toConversation(record(), contract);
  const roles = conversation.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant"]);
  assert.equal(conversation.messages[0].content, "PLAN " + contract.index);
  assert.equal(conversation.messages[1].content, "요청");
  // 첫 add_step 뒤에는 1단계 영수증이 도구 결과로 붙는다.
  assert.equal(JSON.parse(conversation.messages[3].content).step, 1);
  assert.equal(conversation.messages[3].tool_call_id, "cplan_add_step");
  // 사고 기록은 기본으로 빠진다.
  assert.equal(conversation.messages[2].reasoning_content, undefined);
  assert.equal(toConversation(record(), contract, { includeReasoning: true }).messages[2].reasoning_content, "생각");
  assert.deepEqual(conversation.meta, { model: "m", task: "t", marker: "k1", ended: "plan_finish_plan", steps: 1 });
  assert.equal(planningTools(contract).map((t) => t.function.name).join(","), "invalid,plan_add_step,plan_finish_plan");
});

test("프로토콜 밖 궤적은 버린다", () => {
  // 종료 도구 없이 끝남
  assert.equal(toConversation(record({ trace: [call("plan_add_step", { title: "읽기", tools: ["read"] })] }), contract), null);
  // 단계 없이 finish
  assert.equal(toConversation(record({ trace: [call("plan_finish_plan", {})] }), contract), null);
  // 한 턴에 호출 둘
  const two = call("plan_add_step", { title: "a", tools: ["read"] });
  two.tool_calls.push(two.tool_calls[0]);
  assert.equal(toConversation(record({ trace: [two, call("plan_finish_plan", {})] }), contract), null);
  // 인자가 JSON 이 아님
  const broken = call("plan_add_step", {});
  broken.tool_calls[0].function.arguments = "{oops";
  assert.equal(toConversation(record({ trace: [broken, call("plan_finish_plan", {})] }), contract), null);
  // cannot_do 로 끝나는 거절도 궤적이다.
  const refusal = toConversation(record({ trace: [call("plan_cannot_do", { reason: "없다" })] }), contract);
  assert.equal(refusal.meta.ended, "plan_cannot_do");
});

test("과제별 상한과 표식 중복 제거로 균형을 맞춘다", () => {
  const items = ["a", "a", "b", "c", "d"].map((task, i) => ({ meta: { task, marker: `m${i}` } }));
  items.push({ meta: { task: "b", marker: "m2" } }); // 같은 표식은 한 번만
  const kept = balance(items, 1);
  assert.deepEqual(kept.map((i) => i.meta.task), ["a", "b", "c", "d"]);
});
