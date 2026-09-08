import assert from "node:assert/strict";
import test from "node:test";
import { attentionStateKey, freshItems, snapshotKeys } from "./webNotificationState.ts";

const attentionKeys = (items) => snapshotKeys(items, attentionStateKey);
const freshAttention = (items, previous) => freshItems(items, previous, attentionStateKey);

test("a running item becoming completed is a fresh notification state", () => {
  const previous = attentionKeys([{ id: "turn-1", kind: "running" }]);

  assert.deepEqual(
    freshAttention([{ id: "turn-1", kind: "completed" }], previous),
    [{ id: "turn-1", kind: "completed" }],
  );
});

test("an unchanged attention item is not fresh", () => {
  const previous = attentionKeys([{ id: "turn-1", kind: "completed" }]);

  assert.deepEqual(
    freshAttention([{ id: "turn-1", kind: "completed" }], previous),
    [],
  );
});

test("a newly added attention ID is fresh", () => {
  const previous = attentionKeys([{ id: "turn-1", kind: "completed" }]);

  assert.deepEqual(
    freshAttention([
      { id: "turn-1", kind: "completed" },
      { id: "turn-2", kind: "approval" },
    ], previous),
    [{ id: "turn-2", kind: "approval" }],
  );
});

test("a newly added AIA attention item is fresh", () => {
  const previous = attentionKeys([
    { id: "turn-standard", kind: "completed", profile: "standard" },
  ]);

  assert.deepEqual(
    freshAttention([
      { id: "turn-standard", kind: "completed", profile: "standard" },
      { id: "turn-aia", kind: "approval", profile: "aia" },
    ], previous),
    [{ id: "turn-aia", kind: "approval", profile: "aia" }],
  );
});

test("attention keys separate ID from kind so neighbouring values cannot collide", () => {
  const previous = attentionKeys([{ id: "turn", kind: "1completed" }]);

  assert.deepEqual(
    freshAttention([{ id: "turn1", kind: "completed" }], previous),
    [{ id: "turn1", kind: "completed" }],
  );
});

test("a pending project is fresh only until its path is in the baseline", () => {
  const path = (project) => project.path;
  const previous = snapshotKeys([{ path: "/a" }], path);

  assert.deepEqual(
    freshItems([{ path: "/a" }, { path: "/b" }], previous, path),
    [{ path: "/b" }],
  );
});
