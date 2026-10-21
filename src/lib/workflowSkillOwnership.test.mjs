import assert from "node:assert/strict";
import test from "node:test";
import { relatedSkillKeys } from "./workflowSkillOwnership.ts";

const wf = (id, requiredSkills, missingSkills) => ({ id, requiredSkills, missingSkills });

test("a skill another registered workflow still requires is never offered for deletion", () => {
  const target = wf("a", ["proc-a", "lanes"]);
  const result = relatedSkillKeys(target, [target, wf("b", ["lanes"])]);
  assert.deepEqual(result, { exclusive: ["proc-a"], shared: ["lanes"] });
});

test("the workflow being deleted does not count as another owner of its own skills", () => {
  const target = wf("a", ["proc-a"]);
  assert.deepEqual(relatedSkillKeys(target, [target]), { exclusive: ["proc-a"], shared: [] });
});

test("skills missing on this device and duplicate keys are dropped", () => {
  const target = wf("a", ["proc-a", "proc-a", "gone"], ["gone"]);
  assert.deepEqual(relatedSkillKeys(target, [target]), { exclusive: ["proc-a"], shared: [] });
});

test("absent skill lists are treated as empty", () => {
  assert.deepEqual(relatedSkillKeys(wf("a"), [wf("b")]), { exclusive: [], shared: [] });
});
