import assert from "node:assert/strict";
import test from "node:test";
import { attentionStateKeys, freshAttentionStates } from "./webNotificationState.ts";

test("a running item becoming completed is a fresh notification state", () => {
  const previous = attentionStateKeys([{ id: "turn-1", kind: "running" }]);

  assert.deepEqual(
    freshAttentionStates([{ id: "turn-1", kind: "completed" }], previous),
    [{ id: "turn-1", kind: "completed" }],
  );
});

test("an unchanged attention item is not fresh", () => {
  const previous = attentionStateKeys([{ id: "turn-1", kind: "completed" }]);

  assert.deepEqual(
    freshAttentionStates([{ id: "turn-1", kind: "completed" }], previous),
    [],
  );
});

test("a newly added attention ID is fresh", () => {
  const previous = attentionStateKeys([{ id: "turn-1", kind: "completed" }]);

  assert.deepEqual(
    freshAttentionStates([
      { id: "turn-1", kind: "completed" },
      { id: "turn-2", kind: "approval" },
    ], previous),
    [{ id: "turn-2", kind: "approval" }],
  );
});

test("a newly added AIA attention item is fresh", () => {
  const previous = attentionStateKeys([
    { id: "turn-standard", kind: "completed", profile: "standard" },
  ]);

  assert.deepEqual(
    freshAttentionStates([
      { id: "turn-standard", kind: "completed", profile: "standard" },
      { id: "turn-aia", kind: "approval", profile: "aia" },
    ], previous),
    [{ id: "turn-aia", kind: "approval", profile: "aia" }],
  );
});
