import assert from "node:assert/strict";
import test from "node:test";
import { UNATTENDED_WORKFLOW_RUNTIME, workflowRuntimeContract, workflowRuntimeDraft } from "./workflowRuntime.ts";

const contract = { id: "ui-improvement", version: 4, paced: true, inputSchema: { model: { type: "string" } }, steps: [{ operation: "start_chat", arguments: { unchanged: true } }] };

test("common runtime keeps steps and pacing inputs and requires the next version", () => {
  const next = workflowRuntimeContract(contract, UNATTENDED_WORKFLOW_RUNTIME);
  assert.equal(next.version, 5);
  assert.equal(next.steps, contract.steps);
  assert.equal(next.inputSchema, contract.inputSchema);
  assert.deepEqual(next.chatRuntime, { mode: "fullAccess", approvalMode: "never", decisionPolicy: "recommended" });
  assert.equal(contract.chatRuntime, undefined);
});

test("inheritance removes overrides, drafts cannot mutate the saved runtime", () => {
  const saved = { ...contract, chatRuntime: { ...UNATTENDED_WORKFLOW_RUNTIME } };
  const draft = workflowRuntimeDraft(saved);
  draft.mode = "plan";
  assert.equal(saved.chatRuntime.mode, "fullAccess");
  assert.equal(workflowRuntimeContract(saved, { mode: null, approvalMode: null }).chatRuntime, undefined);
});
