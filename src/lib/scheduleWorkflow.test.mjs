import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowArguments,
  describeScheduleWorkflow,
  validateScheduleWorkflowDraft,
  validateWorkflowModelInputs,
  workflowInputDefaults,
  workflowInputEntries,
  workflowInputsFromArguments,
  workflowModelInputChoices,
  workflowModelInputProvider,
} from "./scheduleWorkflow.ts";

const field = (type, required = true, values = null) => ({ type, required, values, description: null });

const workflow = (overrides = {}) => ({
  id: "wf-usage",
  displayName: "사용량 점검",
  description: null,
  version: 3,
  risk: "readOnly",
  computedRisk: "readOnly",
  requiredOperations: [],
  inputSchema: { provider: field("enum", true, ["codex", "claude"]), days: field("number", false) },
  compatible: true,
  contractDigest: null,
  hardToRecoverEffects: [],
  lastExecution: null,
  ...overrides,
});

test("form strings become the declared types and optional blanks are left out", () => {
  const schema = workflowInputEntries(workflow());
  assert.deepEqual(buildWorkflowArguments(schema, { provider: "codex", days: "" }), {
    provider: "codex",
  });
  assert.deepEqual(buildWorkflowArguments(schema, { provider: "codex", days: "7" }), {
    provider: "codex",
    days: 7,
  });
});

test("an optional boolean stays out until the form carries a value", () => {
  const schema = workflowInputEntries(workflow({ inputSchema: { dryRun: field("boolean", false) } }));
  assert.deepEqual(buildWorkflowArguments(schema, {}), {});
  assert.deepEqual(buildWorkflowArguments(schema, { dryRun: "false" }), { dryRun: false });
});

test("saved arguments come back as form strings and names off the contract are dropped", () => {
  const schema = workflowInputEntries(workflow({
    inputSchema: { provider: field("enum"), dryRun: field("boolean", false) },
  }));
  assert.deepEqual(
    workflowInputsFromArguments(schema, { provider: "codex", dryRun: true, removed: "old" }),
    { provider: "codex", dryRun: "true" },
  );
});

test("a draft is refused without a workflow, with missing required inputs, or when incompatible", () => {
  assert.deepEqual(validateScheduleWorkflowDraft({ workflow: null, inputs: {} }), [
    "실행할 워크플로를 선택하세요.",
  ]);
  assert.deepEqual(validateScheduleWorkflowDraft({ workflow: workflow(), inputs: {} }), [
    "필수 입력이 비어 있습니다: provider",
  ]);
  const problems = validateScheduleWorkflowDraft({
    workflow: workflow({ compatible: false, version: null }),
    inputs: { provider: "codex" },
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /승인 버전/);
  assert.match(problems[1], /호환되지 않는/);
});

test("a required boolean needs no typed value because the checkbox always sends one", () => {
  const draft = { workflow: workflow({ inputSchema: { dryRun: field("boolean", true) } }), inputs: {} };
  assert.deepEqual(validateScheduleWorkflowDraft(draft), []);
});

test("the card marks a workflow whose registered version moved past the approved one", () => {
  const binding = { workflowId: "wf-usage", approvedVersion: 3, arguments: {} };
  assert.equal(describeScheduleWorkflow(binding, [workflow()]), "워크플로 사용량 점검 v3");
  assert.match(describeScheduleWorkflow(binding, [workflow({ version: 4 })]), /재승인 필요\(현재 v4\)/);
  assert.match(describeScheduleWorkflow(binding, [workflow({ compatible: false })]), /카탈로그 비호환/);
  assert.match(describeScheduleWorkflow(binding, []), /목록에 없음/);
});

test("declared defaults become form values so the run form opens filled", () => {
  const schema = workflowInputEntries(workflow({
    inputSchema: {
      provider: { ...field("enum", true, ["codex", "claude"]), defaultValue: "claude" },
      days: { ...field("number", false), defaultValue: 7 },
      dryRun: { ...field("boolean", false), defaultValue: false },
      note: field("string", false),
    },
  }));
  assert.deepEqual(workflowInputDefaults(schema), {
    provider: "claude",
    days: "7",
    dryRun: "false",
  });
  // 채운 값 그대로 실행을 눌렀을 때 계약이 선언한 형으로 되돌아가야 한다.
  assert.deepEqual(buildWorkflowArguments(schema, workflowInputDefaults(schema)), {
    provider: "claude",
    days: 7,
    dryRun: false,
  });
  assert.deepEqual(validateScheduleWorkflowDraft({
    workflow: workflow({
      inputSchema: { provider: { ...field("enum", true, ["codex", "claude"]), defaultValue: "claude" } },
    }),
    inputs: workflowInputDefaults(schema),
  }), []);
});

test("paced model inputs use provider catalogs and store model IDs instead of display labels", () => {
  const catalogs = {
    antigravity: [{
      model: "gemini-3.8-flash-high",
      displayName: "Gemini 3.8 Flash (High)",
    }],
  };
  assert.deepEqual([
    workflowModelInputProvider("claudeModel"),
    workflowModelInputProvider("codexModel"),
    workflowModelInputProvider("antigravityModel"),
  ], ["claude", "codex", "antigravity"]);
  assert.equal(workflowModelInputProvider("message"), null);
  assert.deepEqual(workflowModelInputChoices("antigravityModel", catalogs), [{
    value: "gemini-3.8-flash-high",
    label: "Gemini 3.8 Flash (High) · gemini-3.8-flash-high",
  }]);
  assert.equal(workflowModelInputChoices("message", catalogs), null);

  const schema = [["antigravityModel", {
    ...field("string", false),
    label: "Antigravity 모델",
  }]];
  assert.deepEqual(validateWorkflowModelInputs(schema, {
    antigravityModel: " Gemini 3.8 Flash (High)",
  }, catalogs), ["모델 목록에서 다시 선택하세요: Antigravity 모델."]);
  assert.deepEqual(validateWorkflowModelInputs(schema, {
    antigravityModel: "gemini-3.8-flash-high",
  }, catalogs), []);
  assert.deepEqual(buildWorkflowArguments(schema, {
    antigravityModel: "gemini-3.8-flash-high",
  }), { antigravityModel: "gemini-3.8-flash-high" });
});
