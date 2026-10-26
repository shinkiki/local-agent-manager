import assert from "node:assert/strict";
import test from "node:test";

test("누적 소진율 축의 달 이름은 영어 화면에서 영어 약어다", async () => {
  const { setRuntimeLocale } = await import("./i18nRuntime.ts");
  const { recentMonthPeriods } = await import("./usageCumulative.ts");
  const now = new Date(2026, 8, 30).getTime();
  setRuntimeLocale("en", {});
  try {
    assert.deepEqual(recentMonthPeriods(now, 2).map((period) => period.label), ["Aug", "Sep"]);
  } finally {
    setRuntimeLocale("ko", {});
  }
  assert.deepEqual(recentMonthPeriods(now, 2).map((period) => period.label), ["8월", "9월"]);
});

const DAY = 86_400_000;
const WEEK = 7 * DAY;

function cycle(windowLabel, resetsAt, peakUsedPercent, windowLengthMs = WEEK) {
  return { windowLabel, windowLengthMs, resetsAt, peakUsedPercent, firstObservedAt: resetsAt - windowLengthMs };
}

test("누적 소비율은 기간과 겹친 만큼만 주기 소진율을 더하고 실제 주기 길이로 나눈다", async () => {
  const { cumulativeUsage } = await import("./usageCumulative.ts");
  const from = 100 * WEEK;
  const period = { from, to: from + 2 * WEEK };
  const history = {
    accountId: "a",
    observedSince: 0,
    cycles: [
      // 기간 시작에 절반 걸친 주기: 80% × 0.5 = 0.4 주기
      cycle("7일", from + WEEK / 2, 80),
      // 기간 안에 온전히 든 주기: 0.6 주기
      cycle("7일", from + WEEK + WEEK / 2, 60),
      // 기간 뒤 주기는 세지 않는다
      cycle("7일", from + 4 * WEEK, 100),
    ],
  };
  const usage = cumulativeUsage(history, ["7일"], period);
  assert.equal(usage.truncated, false);
  assert.equal(usage.windows.length, 1);
  const [window] = usage.windows;
  assert.equal(window.budgetCycles, 2);
  assert.equal(window.cycleCount, 2);
  assert.ok(Math.abs(window.consumedCycles - 1.0) < 1e-9);
  assert.ok(Math.abs(window.consumedPercent - 50) < 1e-9);
  assert.equal(usage.consumedPercent, window.consumedPercent);
});

test("관측 시작 전 구간은 잘라 알리고, 관측이 기간 뒤면 창 없이 null이다", async () => {
  const { cumulativeUsage } = await import("./usageCumulative.ts");
  const period = { from: 0, to: 4 * WEEK };
  const late = cumulativeUsage({ accountId: "a", observedSince: 2 * WEEK, cycles: [] }, ["7일"], period);
  assert.equal(late.from, 2 * WEEK);
  assert.equal(late.truncated, true);
  assert.equal(late.windows[0].budgetCycles, 2);
  const after = cumulativeUsage({ accountId: "a", observedSince: 5 * WEEK, cycles: [] }, ["7일"], period);
  assert.deepEqual(after.windows, []);
  assert.equal(after.consumedPercent, null);
  assert.equal(cumulativeUsage(null, ["7일"], period), null);
});

test("이력 없는 현재 창은 0%로 서고, 하루보다 짧은 현재 창은 빠지며, 이력의 주기 길이가 라벨보다 앞선다", async () => {
  const { cumulativeUsage } = await import("./usageCumulative.ts");
  const period = { from: 0, to: 4 * WEEK };
  const usage = cumulativeUsage(
    { accountId: "a", observedSince: 0, cycles: [cycle("30일", 4 * WEEK, 50, 14 * DAY)] },
    ["5시간", "7일", "30일"],
    period,
  );
  assert.deepEqual(usage.windows.map((window) => window.label), ["7일", "30일"]);
  const [weekly, monthly] = usage.windows;
  assert.equal(weekly.consumedPercent, 0);
  assert.equal(weekly.cycleCount, 0);
  assert.equal(monthly.windowLengthMs, 14 * DAY);
  assert.equal(monthly.budgetCycles, 2);
  assert.ok(Math.abs(monthly.consumedPercent - 25) < 1e-9);
  assert.ok(Math.abs(usage.consumedPercent - 25) < 1e-9);
});
