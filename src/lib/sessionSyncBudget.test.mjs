import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_SYNC_DELAYS_MS, SESSION_SYNC_GRACE_MS, sessionSyncKey, unindexedRunTargets, waitWithSyncGrace } from "./sessionSyncBudget.ts";

const schedules = new Map([["s1", "codex"], ["s2", "claude"]]);
const never = () => false;

test("the retry budget is finite so an unindexable session cannot loop forever", () => {
  assert.ok(SESSION_SYNC_DELAYS_MS.length > 1);
  assert.ok(SESSION_SYNC_DELAYS_MS.every((delay) => Number.isFinite(delay)));
});

test("keys separate the same session id across providers", () => {
  assert.notEqual(sessionSyncKey("codex", "abc"), sessionSyncKey("claude", "abc"));
});

test("completed runs missing from the list become sync targets once each", () => {
  const targets = unindexedRunTargets(
    [
      { scheduleId: "s1", providerSessionId: "abc" },
      { scheduleId: "s1", providerSessionId: "abc" },
      { scheduleId: "s2", providerSessionId: "def" },
    ],
    schedules,
    never,
    new Set(),
  );
  assert.deepEqual(targets, [{ source: "codex", id: "abc" }, { source: "claude", id: "def" }]);
});

test("runs without a session id or a known schedule are skipped", () => {
  const targets = unindexedRunTargets(
    [
      { scheduleId: "s1", providerSessionId: null },
      { scheduleId: "gone", providerSessionId: "abc" },
    ],
    schedules,
    never,
    new Set(),
  );
  assert.deepEqual(targets, []);
});

test("already indexed and abandoned targets are excluded", () => {
  const runs = [
    { scheduleId: "s1", providerSessionId: "indexed" },
    { scheduleId: "s2", providerSessionId: "abandoned" },
    { scheduleId: "s2", providerSessionId: "pending" },
  ];
  const targets = unindexedRunTargets(
    runs,
    schedules,
    (source, id) => source === "codex" && id === "indexed",
    new Set([sessionSyncKey("claude", "abandoned")]),
  );
  assert.deepEqual(targets, [{ source: "claude", id: "pending" }]);
});

test("the open grace is shorter than waiting out the whole retry budget", () => {
  const budget = SESSION_SYNC_DELAYS_MS.reduce((total, delay) => total + delay, 0);
  assert.ok(SESSION_SYNC_GRACE_MS < budget);
});

test("waiting stops at the grace even while the sync keeps running", async () => {
  let settled = false;
  const sync = new Promise((resolve) => setTimeout(() => { settled = true; resolve(); }, 200));
  await waitWithSyncGrace(sync, 10);
  assert.equal(settled, false);
  await sync;
});

test("waiting returns as soon as the sync finishes inside the grace", async () => {
  const started = Date.now();
  await waitWithSyncGrace(Promise.resolve(), 10_000);
  assert.ok(Date.now() - started < 1_000);
});

test("a failed sync ends the wait instead of holding the screen", async () => {
  const started = Date.now();
  await waitWithSyncGrace(Promise.reject(new Error("busy")), 10_000);
  assert.ok(Date.now() - started < 1_000);
});
