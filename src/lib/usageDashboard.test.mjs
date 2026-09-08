import assert from "node:assert/strict";
import test from "node:test";

import {
  cumulativeUsage,
  isWeeklyUsageWindow,
  recentMonthPeriods,
  usageWindowLengthMs,
  weeklyUsageOverview,
} from "./usageDashboard.ts";

const NOW = 1_000_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** 창 하나. 초기화 시각이 없는 창이 대부분이라 기본값을 둔다. */
function win(label, usedPercent, resetsAt = null, extra = {}) {
  return { label, usedPercent, resetsAt, ...extra };
}

/** 계정 사용량 뷰. 시험마다 실제로 다른 것은 창 목록과 조회 상태뿐이다. */
function usage(windows, overrides = {}) {
  return { status: "ok", windows, updatedAt: 123, error: null, retryAt: null, rateLimited: false, ...overrides };
}

/** 이력의 주기 레코드 하나. 관측 시각은 이 모듈이 보지 않아 0으로 둔다. */
function cycle(label, windowLengthMs, resetsAt, peakUsedPercent) {
  return { windowLabel: label, windowLengthMs, resetsAt, peakUsedPercent, firstObservedAt: 0, lastObservedAt: 0 };
}

function history(observedSince, cycles) {
  return { accountId: "a", observedSince, cycles };
}

function account(overrides = {}) {
  return {
    id: "codex-a",
    provider: "codex",
    displayName: "A",
    email: null,
    organization: null,
    providerAccountId: "provider-a",
    isActive: true,
    isDefault: true,
    isPendingDefault: false,
    disabled: false,
    authStatus: "ready",
    autoSwitch: false,
    autoSwitchPriority: null,
    note: null,
    credentialIsolated: true,
    credentialIsolationNote: null,
    runtimeCount: 0,
    usage: usage([win("7일", 25)]),
    ...overrides,
  };
}

test("weekly windows are recognised by their day-length label, not a fixed string", () => {
  assert.equal(isWeeklyUsageWindow("7일"), true);
  assert.equal(isWeeklyUsageWindow("Fable 7일"), true);
  assert.equal(isWeeklyUsageWindow("14일"), true);
  assert.equal(isWeeklyUsageWindow("5시간"), false);
  assert.equal(isWeeklyUsageWindow("30분"), false);
  assert.equal(isWeeklyUsageWindow("weekly"), false);
});

function weeklySnapshot(accounts) {
  return { accounts, providers: [], autoSwitchResume: false, autoSwitchPolicy: "roundRobin", autoSwitchUsageGapPercent: null, resumeAccountPolicy: "lastUsed" };
}

test("weekly overview keeps only day-length windows and takes the max as the headline", () => {
  const snapshot = weeklySnapshot([account({
    id: "claude-a",
    provider: "claude",
    usage: usage([
      win("5시간", 95, NOW + 1_000),
      win("7일", 40, NOW + DAY),
      win("14일", 62, NOW + DAY * 2),
    ], { updatedAt: NOW - 1_000 }),
  })]);
  const [row] = weeklyUsageOverview(snapshot, ["claude", "codex"], NOW);
  assert.deepEqual(row.windows.map((window) => window.label), ["7일", "14일"]);
  // 5시간 창의 95%는 주간 소진율이 아니다.
  assert.equal(row.usedPercent, 62);
  assert.equal(row.nextResetAt, NOW + 86_400_000);
  assert.equal(row.state, "ok");
  assert.equal(row.error, null);
});

test("weekly overview shows model-scoped windows but keeps them out of the headline", () => {
  // Fable 주간 한도가 다 차도 그 계정으로 다른 모델을 돌릴 여지는 남아 있다. 행에는
  // 보여 주되 대표 소진율·다음 초기화는 계정 전체에 걸리는 창으로만 정한다.
  const snapshot = weeklySnapshot([account({
    id: "claude-a",
    provider: "claude",
    usage: usage([
      win("7일", 40, NOW + DAY),
      win("Fable 7일", 100, NOW + 1_000, { modelScoped: true }),
    ], { updatedAt: NOW - 1_000 }),
  })]);
  const [row] = weeklyUsageOverview(snapshot, ["claude", "codex"], NOW);
  assert.deepEqual(row.windows.map((window) => window.label), ["7일", "Fable 7일"]);
  assert.equal(row.usedPercent, 40);
  assert.equal(row.nextResetAt, NOW + 86_400_000);
  assert.equal(row.state, "ok");
});

test("weekly overview orders by provider, then usable accounts, then highest usage", () => {
  const rows = weeklyUsageOverview(weeklySnapshot([
    account({ id: "codex-low", displayName: "low", usage: usage([win("7일", 10)], { updatedAt: NOW }) }),
    account({ id: "claude-b", provider: "claude", displayName: "b", usage: usage([win("7일", 30)], { updatedAt: NOW }) }),
    account({ id: "codex-off", displayName: "off", disabled: true, usage: usage([win("7일", 99)], { updatedAt: NOW }) }),
    account({ id: "codex-high", displayName: "high", usage: usage([win("7일", 80)], { updatedAt: NOW }) }),
  ]), ["claude", "codex"], NOW);
  assert.deepEqual(rows.map((row) => row.account.id), ["claude-b", "codex-high", "codex-low", "codex-off"]);
  assert.equal(rows[3].state, "disabled");
  // 중지 계정도 마지막 수치는 그대로 보여 준다.
  assert.equal(rows[3].usedPercent, 99);
});

test("weekly overview reports why a value cannot be trusted", () => {
  const rows = weeklyUsageOverview(weeklySnapshot([
    // 조회 실패지만 이전 수치가 남아 있다 → stale, 값 유지.
    account({ id: "stale", usage: usage([win("7일", 55, NOW + 1_000)], { status: "error", updatedAt: NOW - 5_000, error: "HTTP 503" }) }),
    // 초기화가 지났는데 재조회까지 실패 → 0%라고 단정하지 않는다.
    account({ id: "unavailable", usage: usage([win("7일", 55, NOW - 1_000)], { status: "error", updatedAt: NOW - 5_000, error: "HTTP 503" }) }),
    // 보여 줄 수치가 없는 실패 → error.
    account({ id: "error", usage: usage([], { status: "error", updatedAt: null, error: "HTTP 401" }) }),
    // 아직 조회 전 → pending.
    account({ id: "pending", usage: usage([], { updatedAt: null }) }),
    account({ id: "reauth", authStatus: "needsReauthentication" }),
    // 초기화가 지났고 조회도 성공 상태면 0%로 표시한다.
    account({ id: "reset", usage: usage([win("7일", 55, NOW - 1_000)], { updatedAt: NOW - 5_000 }) }),
  ]), ["codex"], NOW);
  const byId = new Map(rows.map((row) => [row.account.id, row]));
  assert.equal(byId.get("stale").state, "stale");
  assert.equal(byId.get("stale").usedPercent, 55);
  assert.equal(byId.get("stale").error, "HTTP 503");
  assert.equal(byId.get("unavailable").state, "unavailable");
  assert.equal(byId.get("unavailable").usedPercent, null);
  assert.equal(byId.get("error").state, "error");
  assert.equal(byId.get("error").usedPercent, null);
  assert.equal(byId.get("error").error, "HTTP 401");
  assert.equal(byId.get("pending").state, "pending");
  assert.equal(byId.get("pending").usedPercent, null);
  assert.equal(byId.get("reauth").state, "reauth");
  assert.equal(byId.get("reset").state, "ok");
  assert.equal(byId.get("reset").usedPercent, 0);
  assert.equal(byId.get("reset").nextResetAt, null);
});

test("weekly overview is empty before the account snapshot arrives", () => {
  assert.deepEqual(weeklyUsageOverview(null, ["claude"], NOW), []);
});

test("window length follows the label unit like the backend", () => {
  assert.equal(usageWindowLengthMs("7일"), WEEK);
  assert.equal(usageWindowLengthMs("Fable 7일"), WEEK);
  assert.equal(usageWindowLengthMs("5시간"), 5 * 3_600_000);
  assert.equal(usageWindowLengthMs("30분"), 30 * 60_000);
  assert.equal(usageWindowLengthMs("weekly"), null);
  assert.equal(usageWindowLengthMs("0일"), null);
});

test("recent month periods run oldest to newest, clamp the current month to now and label months only", () => {
  const now = new Date(2026, 1, 15, 12).getTime();
  const months = recentMonthPeriods(now, 6);
  assert.deepEqual(months.map((month) => month.key), ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(months.map((month) => month.label), ["9월", "10월", "11월", "12월", "1월", "2월"]);
  assert.deepEqual([months[0].from, months[0].to], [new Date(2025, 8, 1).getTime(), new Date(2025, 9, 1).getTime()]);
  assert.deepEqual([months[5].from, months[5].to], [new Date(2026, 1, 1).getTime(), now]);
});

test("cumulative usage divides consumed budget by the provider cycles in the period", () => {
  const to = 100 * WEEK;
  const observed = history(0, [
    // 기간 밖(끝난 지 오래): 제외.
    cycle("7일", WEEK, to - 10 * WEEK, 100),
    // 기간 안에 온전히 든 두 주기.
    cycle("7일", WEEK, to - 3 * WEEK, 80),
    cycle("7일", WEEK, to - 2 * WEEK, 40),
    // 진행 중인 주기: 절반 지났고 60% 소진 → 0.5주기 예산 중 0.3주기 소비.
    cycle("7일", WEEK, to + WEEK / 2, 60),
  ]);
  // 기간 = 4주. 예산 4주기; 소비 = 0.8 + 0.4 + 0 (3주 전 주기는 쓰지 않아 레코드 없음) + 0.3 = 1.5 → 37.5%.
  const result = cumulativeUsage(observed, ["5시간", "7일"], { from: to - 4 * WEEK, to });
  assert.equal(result.truncated, false);
  assert.equal(result.windows.length, 1, "5시간 창은 누적 지표에 넣지 않는다");
  const [window] = result.windows;
  assert.equal(window.label, "7일");
  assert.equal(window.budgetCycles, 4);
  assert.ok(Math.abs(window.consumedCycles - 1.5) < 1e-9);
  assert.ok(Math.abs(window.consumedPercent - 37.5) < 1e-9);
  assert.equal(window.cycleCount, 3);
  assert.ok(Math.abs(result.consumedPercent - 37.5) < 1e-9);
});

test("cumulative usage starts at the first observation and says so", () => {
  const to = 100 * WEEK;
  const observed = history(to - 2 * WEEK, [
    cycle("7일", WEEK, to - WEEK, 100),
    cycle("7일", WEEK, to, 100),
  ]);
  const result = cumulativeUsage(observed, ["7일"], { from: to - 8 * WEEK, to });
  assert.equal(result.truncated, true);
  assert.equal(result.from, to - 2 * WEEK);
  // 관측한 2주 동안 매주 100% → 100%. 관측 전 6주를 0으로 깔지 않는다.
  assert.ok(Math.abs(result.consumedPercent - 100) < 1e-9);
});

test("cumulative usage follows the cycle length the provider actually gave", () => {
  const to = 100 * WEEK;
  const observed = history(0, [cycle("14일", 2 * WEEK, to, 50)]);
  // 기간 2주 = 14일 주기 1개. 50% 소비.
  const result = cumulativeUsage(observed, [], { from: to - 2 * WEEK, to });
  assert.equal(result.windows[0].budgetCycles, 1);
  assert.ok(Math.abs(result.consumedPercent - 50) < 1e-9);
});

test("cumulative usage without history or without observed span is explicit", () => {
  assert.equal(cumulativeUsage(null, ["7일"], { from: 0, to: WEEK }), null);
  const future = cumulativeUsage(history(2 * WEEK, []), ["7일"], { from: 0, to: WEEK });
  assert.equal(future.consumedPercent, null);
  assert.equal(future.truncated, true);
  // 관측은 됐지만 한 번도 쓰지 않은 계정은 현재 창 라벨로 0%가 나온다.
  const idle = cumulativeUsage(history(0, []), ["7일"], { from: 0, to: 2 * WEEK });
  assert.equal(idle.consumedPercent, 0);
  assert.equal(idle.windows[0].budgetCycles, 2);
});
