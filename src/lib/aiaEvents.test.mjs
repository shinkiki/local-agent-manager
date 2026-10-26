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

/**
 * 규칙표(`EVENT_RULES`)가 종류마다 "언제 새 사건인가"를 다르게 판정한다. 위 시험은 네 종류가 한꺼번에
 * 처음 나타나는 전이만 보므로, 조건을 `before === undefined` 하나로 뭉개도 지나간다. 종류마다 두 번째
 * 판(상태가 바뀌었지만 키는 같은 판)을 고정한다.
 */
const provider = { provider: "claude", displayName: "Claude", cli: { detected: true, path: "/cli" }, history: { detected: true, path: "/history" } };

function input(overrides = {}) {
  return {
    manager: manager([], [provider]),
    accounts: accountSnapshot(account("primary")),
    scheduler: schedulerSnapshot(false),
    automation: automation({ providers: [provider] }),
    now: NOW,
    ...overrides,
  };
}

function run(status, recoveryError = null) {
  return { id: "run", scheduleId: "schedule", status, scheduledFor: NOW, recoveryError };
}

test("a failed run that later gains a recovery error is a new, higher-priority event", () => {
  const failed = input({ scheduler: schedulerSnapshot(false, [run("failed")]) });
  const first = detectAiaEvents(captureAiaEventBaseline(input()), failed);
  assert.deepEqual(first.events.map((event) => [event.kind, event.priority]), [["scheduleFailed", 80]]);
  assert.deepEqual(detectAiaEvents(first.baseline, failed).events, []);

  const recovery = input({ scheduler: schedulerSnapshot(false, [run("failed", "restore failed")]) });
  const second = detectAiaEvents(first.baseline, recovery);
  assert.deepEqual(second.events.map((event) => [event.kind, event.priority]), [["scheduleRecoveryError", 90]]);
  assert.deepEqual(detectAiaEvents(second.baseline, recovery).events, []);
});

test("translation failures re-fire only when the count grows or the phase turns to error", () => {
  const failing = (overrides) => input({ automation: automation({ providers: [provider], skills: translationStatus(overrides) }) });
  const two = detectAiaEvents(captureAiaEventBaseline(input()), failing({ failed: 2 }));
  assert.deepEqual(two.events.map((event) => event.kind), ["translationFailed"]);

  assert.deepEqual(detectAiaEvents(two.baseline, failing({ failed: 2 })).events, []);
  assert.deepEqual(detectAiaEvents(two.baseline, failing({ failed: 1 })).events, []);
  // 묶음 실패와 문장 실패 중 큰 쪽을 세므로 문장 실패가 자라도 사건이다.
  assert.deepEqual(detectAiaEvents(two.baseline, failing({ failed: 2, segmentFailed: 3 })).events.map((event) => event.kind), ["translationFailed"]);
  assert.deepEqual(detectAiaEvents(two.baseline, failing({ failed: 2, phase: "error" })).events.map((event) => event.kind), ["translationFailed"]);
  // 오류 단계는 실패 수와 무관하게 기준선에 들어가고, 그 상태가 이어지면 다시 알리지 않는다.
  const errored = detectAiaEvents(captureAiaEventBaseline(input()), failing({ phase: "error", failed: 0 }));
  assert.deepEqual(errored.events.map((event) => event.kind), ["translationFailed"]);
  assert.deepEqual(detectAiaEvents(errored.baseline, failing({ phase: "error", failed: 0 })).events, []);
});

test("an account auth error is announced once and not again when its status only changes", () => {
  const missing = input({ accounts: accountSnapshot(account("primary", { authStatus: "missing" })) });
  const first = detectAiaEvents(captureAiaEventBaseline(input()), missing);
  assert.deepEqual(first.events.map((event) => event.kind), ["accountAuthError"]);
  assert.match(first.events[0].summary, /missing/);
  const expired = input({ accounts: accountSnapshot(account("primary", { authStatus: "expired" })) });
  assert.deepEqual(detectAiaEvents(first.baseline, expired).events, []);
  // 사라졌다 다시 나타나면 다시 알린다.
  const recovered = detectAiaEvents(first.baseline, input());
  assert.deepEqual(recovered.events, []);
  assert.deepEqual(detectAiaEvents(recovered.baseline, missing).events.map((event) => event.kind), ["accountAuthError"]);
});

test("cli presence follows the automation snapshot over the manager snapshot and events sort by priority", () => {
  const missing = { ...provider, cli: { detected: false, path: null } };
  // 관리자 스냅샷은 아직 연결됐다고 하지만 자동화 쪽이 더 최신이다.
  const stale = input({ automation: automation({ providers: [missing] }) });
  assert.deepEqual(captureAiaEventBaseline(stale).cliMissing, ["claude"]);
  // 반대로 자동화 쪽이 연결됐다고 하면 관리자 쪽의 끊김은 덮인다.
  assert.deepEqual(captureAiaEventBaseline(input({ manager: manager([], [missing]) })).cliMissing, []);

  const baseline = captureAiaEventBaseline(input());
  // 규칙표가 이미 우선순위 순이라 종류 사이의 순서만으로는 정렬을 증명하지 못한다. 같은 우선순위
  // 안에서는 id 순이므로, 규칙이 `ui` 를 먼저 보는 번역 둘을 함께 실패시켜 `agents` 가 앞서는지 본다.
  const several = input({
    manager: manager([], [missing]),
    accounts: accountSnapshot(account("primary", { authStatus: "missing" })),
    scheduler: schedulerSnapshot(false, [run("failed")]),
    automation: automation({
      providers: [missing],
      uiTranslation: translationStatus({ failed: 1 }),
      agents: translationStatus({ failed: 1 }),
    }),
  });
  const { events } = detectAiaEvents(baseline, several);
  assert.deepEqual(events.map((event) => event.kind), ["cliLost", "accountAuthError", "scheduleFailed", "translationFailed", "translationFailed"]);
  assert.deepEqual(events.map((event) => event.targetId), ["claude", "primary", "run", "agents", "ui"]);
  assert.equal(events[0].id, `cliLost:claude:${NOW}`);
});
