import assert from "node:assert/strict";
import test from "node:test";
import { workflowDiagram } from "./workflowDiagram.ts";

const paced = {
  id: "aia-refactor-round",
  displayName: "리팩토링 회차",
  version: 8,
  paced: true,
  requiredSkills: ["agent-manager-refactor-round"],
  inputSchema: { projectPath: { type: "string", label: "대상 저장소" }, message: { type: "string" } },
  steps: [{ id: "s01", operation: "start_chat", arguments: { message: { $input: "message" } }, forEach: null, condition: null, expect: null }],
};

const sequential = {
  id: "folder-assign",
  displayName: "폴더 배정",
  version: 1,
  inputSchema: {},
  steps: [
    { id: "list", operation: "list_sessions", arguments: {}, forEach: null, condition: null, expect: null },
    {
      id: "patch",
      operation: "patch_session_meta",
      arguments: { id: { $item: "id" } },
      forEach: { step: "list", path: "sessions", maxIterations: 20 },
      condition: { left: { $step: "list", path: "count" } },
      expect: { ok: true },
    },
  ],
};

test("a paced contract draws the envelope the scheduler owns, not as contract steps", () => {
  const diagram = workflowDiagram(paced);
  assert.match(diagram, /^flowchart TD/);
  assert.match(diagram, /subgraph wf_envelope/);
  assert.match(diagram, /env_launch --> contract_entry/);
  assert.match(diagram, /step_0 --> env_done/);
  // 봉투 상자에는 단계 id가 없다. 계약이 소유하지 않은 것을 계약처럼 보이게 하지 않는다.
  assert.doesNotMatch(diagram, /env_plan\["[^"]*s01/);
});

test("a contract without pacing draws no envelope", () => {
  const diagram = workflowDiagram(sequential);
  assert.doesNotMatch(diagram, /wf_envelope/);
  assert.doesNotMatch(diagram, /env_done/);
});

test("steps keep their declared order and show the control the contract fixes", () => {
  const diagram = workflowDiagram(sequential);
  assert.match(diagram, /contract_entry --> step_0/);
  assert.match(diagram, /step_0 --> step_1/);
  assert.match(diagram, /step_1 -\. "최대 20회 반복" \.-> step_1/);
  assert.match(diagram, /step_1\["2\. patch_session_meta<br\/>patch<br\/>조건 충족 시에만 · 반복 · 사후검증"\]/);
});

test("a step that reads an earlier result gets a dashed data edge, not an order edge", () => {
  const diagram = workflowDiagram(sequential);
  assert.match(diagram, /step_0 -\. "결과 참조" \.-> step_1/);
  // 자기 자신을 참조하는 선은 긋지 않는다.
  assert.doesNotMatch(diagram, /step_1 -\. "결과 참조" \.-> step_1/);
});

test("a declared skill hangs off the chat step and clicks only when an address is given", () => {
  const plain = workflowDiagram(paced);
  assert.match(plain, /skill_0\(\["스킬<br\/>agent-manager-refactor-round"\]\)/);
  assert.match(plain, /step_0 -\. "이 절차를 따른다" \.-> skill_0/);
  assert.doesNotMatch(plain, /click skill_0/);

  const linked = workflowDiagram(paced, { skillHref: (skill) => `/repo/skills/${skill}/SKILL.md` });
  assert.match(linked, /click skill_0 href "\/repo\/skills\/agent-manager-refactor-round\/SKILL.md"/);
  // 주소를 낼 수 없는 스킬은 상자만 남고 클릭은 붙지 않는다.
  assert.doesNotMatch(workflowDiagram(paced, { skillHref: () => null }), /click skill_0/);
});

test("labels that would break the syntax are escaped instead of losing the whole diagram", () => {
  const hostile = {
    ...sequential,
    displayName: 'A "quoted" [name]',
    steps: [{ id: "a<b>", operation: "op(1)", arguments: {}, forEach: null, condition: null, expect: null }],
  };
  const diagram = workflowDiagram(hostile);
  assert.match(diagram, /#quot;quoted#quot;/);
  assert.doesNotMatch(diagram, /\[name\]/);
  assert.doesNotMatch(diagram, /a<b>/);
  assert.match(diagram, /op#40;1#41;/);
});

test("many inputs collapse instead of running off the screen", () => {
  const wide = { ...sequential, inputSchema: Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [name, { type: "string" }])) };
  assert.match(workflowDiagram(wide), /입력 a, b, c 외 2개/);
  assert.match(workflowDiagram(sequential), /입력 없음/);
});

test("box colours follow the screen theme instead of one fixed palette", () => {
  const dark = workflowDiagram(paced, { dark: true });
  const light = workflowDiagram(paced, { dark: false });
  assert.match(dark, /classDef envelope fill:#241d12/);
  assert.match(light, /classDef envelope fill:#f4f1ea/);
  // 묶음 상자도 함께 칠한다. 엔진 기본 묶음색은 어느 테마에서도 앱 화면과 다른 계열이다.
  assert.match(dark, /style wf_envelope fill:#0c141d/);
  assert.match(dark, /style wf_contract fill:#0c141d/);
});

test("a contract without steps still draws, and invents no step box", () => {
  const empty = { ...paced, steps: [] };
  const diagram = workflowDiagram(empty);
  assert.match(diagram, /contract_entry --> env_done/);
  assert.doesNotMatch(diagram, /step_-1/);
  // 봉투가 없는 계약에는 없는 묶음에 style을 걸지 않는다 — 걸면 그림이 통째로 사라진다.
  assert.doesNotMatch(workflowDiagram(sequential), /style wf_envelope/);
});
