import assert from "node:assert/strict";
import test from "node:test";

import { summarizeInstructionPublish } from "./instructionPublishSummary.ts";

function deployment(outcome, linkedResults) {
  return {
    provider: "codex", scope: "project", projectPath: "/project", filePath: "/project/AGENTS.md",
    present: true, managed: true, contentDigest: null, sourceDigest: null, divergent: false,
    outcome, linkedResults,
  };
}

function receipt(results) {
  return { key: "example", sourceDigest: "digest", projectPath: "/project", results };
}

function linked(outcome, index) {
  return { relative: `docs/${index}.md`, outcome };
}

test("V4 instruction publish summary: empty receipt has zero counts", () => {
  assert.deepEqual(summarizeInstructionPublish(receipt([])), {
    succeeded: 0, linkedWritten: 0, linkedSkipped: 0,
  });
});

test("V4 instruction publish summary: only successful deployment outcomes count", () => {
  const cases = [["published", 1], ["replaced", 1], ["unchanged", 1], ["skipped", 0], ["failed", 0], [undefined, 0]];
  for (const [outcome, succeeded] of cases) {
    assert.deepEqual(summarizeInstructionPublish(receipt([deployment(outcome)])), {
      succeeded,
      linkedWritten: 0, linkedSkipped: 0,
    }, String(outcome));
  }
});

test("V4 instruction publish summary: linked documents distinguish writes from unchanged and failures", () => {
  const outcomes = ["published", "replaced", "unchanged", "skipped", "failed"];
  assert.deepEqual(summarizeInstructionPublish(receipt([
    deployment("unchanged", outcomes.map(linked)),
  ])), { succeeded: 1, linkedWritten: 2, linkedSkipped: 1 });
});

test("V4 instruction publish summary: linked counts accumulate independently across deployments", () => {
  assert.deepEqual(summarizeInstructionPublish(receipt([
    deployment("published", [linked("published", 1), linked("skipped", 2)]),
    deployment("skipped", [linked("replaced", 1), linked("skipped", 2)]),
    deployment("failed", []),
  ])), { succeeded: 1, linkedWritten: 2, linkedSkipped: 2 });
});

test("V4 instruction publish summary: input stays intact and each call returns fresh counts", () => {
  const doc = Object.freeze(linked("published", 1));
  const result = Object.freeze(deployment("published", Object.freeze([doc])));
  const input = Object.freeze(receipt(Object.freeze([result])));
  const before = structuredClone(input);
  const first = summarizeInstructionPublish(input);
  first.succeeded = 99;
  assert.deepEqual(summarizeInstructionPublish(input), {
    succeeded: 1, linkedWritten: 1, linkedSkipped: 0,
  });
  assert.deepEqual(input, before);
});
