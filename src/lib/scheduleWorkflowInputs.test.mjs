import assert from "node:assert/strict";
import test from "node:test";
import {
  validateWorkflowModelInputs,
  workflowModelInputChoices,
  workflowModelInputProvider,
} from "./scheduleWorkflowInputs.ts";

const field = { type: "string", required: true, values: null, label: "입력" };

test("V2/V4: inherited object names remain ordinary workflow inputs", () => {
  const names = Object.getOwnPropertyNames(Object.prototype);
  for (const name of [...names, "message", "CodexModel", "codexModel "]) {
    assert.equal(workflowModelInputProvider(name), null, name);
    assert.equal(workflowModelInputChoices(name, {}), null, name);
    const inputs = Object.fromEntries([[name, "ordinary value"]]);
    assert.deepEqual(validateWorkflowModelInputs([[name, field]], inputs, {}), [], name);
  }
});

test("V4: declared model names retain provider catalogs and validation", () => {
  for (const [name, provider] of [
    ["claudeModel", "claude"],
    ["codexModel", "codex"],
    ["antigravityModel", "antigravity"],
    ["localModel", "local"],
    ["localModels", "local"],
  ]) {
    const catalogs = { [provider]: [{ model: "model-id", displayName: "Model" }] };
    assert.equal(workflowModelInputProvider(name), provider, name);
    assert.deepEqual(workflowModelInputChoices(name, catalogs), [
      { value: "model-id", label: "Model · model-id" },
    ], name);
    assert.deepEqual(workflowModelInputChoices(name, {}), [], name);
    assert.deepEqual(validateWorkflowModelInputs([[name, field]], { [name]: "model-id" }, catalogs), [], name);
    assert.deepEqual(validateWorkflowModelInputs([[name, field]], { [name]: "removed-id" }, catalogs), [
      "모델 목록에서 다시 선택하세요: 입력.",
    ], name);
  }
});
