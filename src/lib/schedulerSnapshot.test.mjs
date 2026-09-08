import assert from "node:assert/strict";
import test from "node:test";
import {
  initialScheduleEditorModelSelection,
  withSchedule,
  withScheduleEnabled,
} from "./schedulerSnapshot.ts";

const snapshot = (schedules) => ({ paused: false, runnerActive: true, schedules, runs: [] });
const schedule = (id, enabled, nextRunAt = 100) => ({ id, enabled, nextRunAt, name: id });

test("replacing a schedule keeps the rest and the surrounding snapshot fields", () => {
  const current = snapshot([schedule("a", true), schedule("b", false)]);
  const next = withSchedule(current, schedule("b", true, 500));
  assert.deepEqual(next.schedules.map((item) => [item.id, item.enabled, item.nextRunAt]), [
    ["a", true, 100],
    ["b", true, 500],
  ]);
  assert.equal(next.runnerActive, true);
  assert.equal(current.schedules[1].enabled, false);
});

test("an unknown id leaves the snapshot untouched", () => {
  const current = snapshot([schedule("a", true)]);
  assert.equal(withSchedule(current, schedule("missing", false)), current);
  assert.equal(withScheduleEnabled(current, "missing", false), current);
});

test("toggling enabled flips only that flag and keeps the stale next run time", () => {
  const current = snapshot([schedule("a", true, 700)]);
  const next = withScheduleEnabled(current, "a", false);
  assert.equal(next.schedules[0].enabled, false);
  assert.equal(next.schedules[0].nextRunAt, 700);
});

test("toggling to the value already held returns the same snapshot", () => {
  const current = snapshot([schedule("a", true)]);
  assert.equal(withScheduleEnabled(current, "a", true), current);
});

test("a null Codex schedule model stays paired with Codex instead of inheriting the current Claude chat", () => {
  const codexSchedule = { source: "codex", model: null };
  const currentClaudeChat = { source: "claude", model: "claude-opus-4-1" };

  assert.deepEqual(
    initialScheduleEditorModelSelection(codexSchedule, currentClaudeChat, "claude"),
    { source: "codex", model: "" },
  );
});

test("existing Claude and Codex schedule model selections remain independent", () => {
  const currentCodexChat = { source: "codex", model: "gpt-5.6-sol" };

  assert.deepEqual(
    initialScheduleEditorModelSelection(
      { source: "claude", model: "claude-sonnet-4-6" },
      currentCodexChat,
      "codex",
    ),
    { source: "claude", model: "claude-sonnet-4-6" },
  );
  assert.deepEqual(
    initialScheduleEditorModelSelection(
      { source: "codex", model: "gpt-5.6-sol" },
      { source: "claude", model: "claude-sonnet-4-6" },
      "claude",
    ),
    { source: "codex", model: "gpt-5.6-sol" },
  );
});

test("a new schedule inherits the current chat model context", () => {
  assert.deepEqual(
    initialScheduleEditorModelSelection(undefined, { source: "claude", model: "claude-sonnet-4-6" }, "codex"),
    { source: "claude", model: "claude-sonnet-4-6" },
  );
});
