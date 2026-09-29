import assert from "node:assert/strict";
import test from "node:test";
import { contractText, workflowContractChanges } from "./workflowContractDiff.ts";

const base = {
  id: "round",
  displayName: "회차",
  description: "설명",
  version: 3,
  risk: "mutating",
  paced: true,
  requiredSkills: ["qa-round"],
  inputSchema: { message: { type: "string", required: true } },
  steps: [{ id: "s01", operation: "start_chat", arguments: { message: { $input: "message" } } }],
};

test("a version bump alone is not a difference", () => {
  const changes = workflowContractChanges(base, { ...base, version: 4 });
  assert.equal(changes.identical, true);
  assert.equal(contractText(base), contractText({ ...base, version: 99 }));
});

test("key order in storage is not a difference", () => {
  const shuffled = { ...base, steps: [{ arguments: { message: { $input: "message" } }, operation: "start_chat", id: "s01" }] };
  assert.equal(workflowContractChanges(base, shuffled).identical, true);
});

test("each reason for a new version is named on its own", () => {
  const next = {
    ...base,
    version: 4,
    risk: "destructive",
    paced: false,
    requiredSkills: ["refactor-round"],
    inputSchema: { message: { type: "string", required: false }, projectPath: { type: "string" } },
    steps: [{ id: "s01", operation: "start_chat", arguments: {} }, { id: "s02", operation: "get_live_chats", arguments: {} }],
    chatRuntime: { mode: "fullAccess" },
  };
  const changes = workflowContractChanges(base, next);
  assert.deepEqual(changes.steps, { added: ["s02"], removed: [], changed: ["s01"] });
  assert.deepEqual(changes.inputs, { added: ["projectPath"], removed: [], changed: ["message"] });
  assert.deepEqual(changes.skills, { added: ["refactor-round"], removed: ["qa-round"] });
  assert.equal(changes.riskChanged, true);
  assert.equal(changes.runtimeChanged, true);
  assert.equal(changes.pacedChanged, true);
  assert.equal(changes.identical, false);
});

test("a removed step is not reported as changed", () => {
  const changes = workflowContractChanges({ ...base, steps: [...base.steps, { id: "s02", operation: "get_live_chats", arguments: {} }] }, base);
  assert.deepEqual(changes.steps, { added: [], removed: ["s02"], changed: [] });
});

test("a contract from before the skill field compares without spurious skill changes", () => {
  const { requiredSkills: _skills, ...legacy } = base;
  assert.deepEqual(workflowContractChanges(legacy, { ...legacy }).skills, { added: [], removed: [] });
  assert.deepEqual(workflowContractChanges(legacy, base).skills, { added: ["qa-round"], removed: [] });
});

test("skill changes preserve duplicate entries and relative order", () => {
  const before = { ...base, requiredSkills: ["shared", "dup", "dup", "removed"] };
  const after = { ...base, requiredSkills: ["added1", "shared", "added2"] };
  const changes = workflowContractChanges(before, after);
  assert.deepEqual(changes.skills, {
    added: ["added1", "added2"],
    removed: ["dup", "dup", "removed"],
  });
});

