import assert from "node:assert/strict";
import test from "node:test";
import { captureAiaEventBaseline, coalesceAiaEvents, detectAiaEvents } from "./aiaEvents.ts";
import {
  NOW,
  account,
  accountSnapshot,
  automation,
  manager,
  schedulerSnapshot,
  translationStatus,
} from "./aiaSuggestionFixtures.mjs";

test("initial baseline produces no events and later operational transitions do", () => {
  const goodProvider = { provider: "claude", displayName: "Claude", cli: { detected: true, path: "/cli" }, history: { detected: true, path: "/history" } };
  const goodInput = {
    manager: manager([], [goodProvider]),
    accounts: accountSnapshot(account("primary")),
    scheduler: schedulerSnapshot(false),
    automation: automation({ providers: [goodProvider] }),
  };
  const baseline = captureAiaEventBaseline(goodInput);
  assert.deepEqual(detectAiaEvents(baseline, { ...goodInput, now: NOW }).events, []);

  const missingProvider = { ...goodProvider, cli: { detected: false, path: null } };
  const bad = {
    manager: manager([], [missingProvider]),
    accounts: accountSnapshot(account("primary", { authStatus: "missing" })),
    scheduler: schedulerSnapshot(false, [
      { id: "run", scheduleId: "schedule", status: "failed", scheduledFor: NOW, recoveryError: "restore failed" },
    ]),
    automation: automation({ providers: [missingProvider], artifacts: translationStatus({ failed: 2 }) }),
    now: NOW,
  };
  const transition = detectAiaEvents(baseline, bad);
  assert.deepEqual(new Set(transition.events.map((event) => event.kind)), new Set([
    "cliLost", "accountAuthError", "scheduleRecoveryError", "translationFailed",
  ]));
  assert.deepEqual(detectAiaEvents(transition.baseline, bad).events, []);
});

test("coalescing waits 30 seconds and selects the highest priority event", () => {
  const events = [
    { id: "low", kind: "translationFailed", targetId: "skills", priority: 10, observedAt: NOW, summary: "low" },
    { id: "high", kind: "cliLost", targetId: "claude", priority: 100, observedAt: NOW + 10_000, summary: "high" },
  ];
  assert.equal(coalesceAiaEvents(events, NOW + 29_999), null);
  const selected = coalesceAiaEvents(events, NOW + 30_000);
  assert.equal(selected.id, "high");
  assert.equal(selected.coalescedCount, 2);
});
