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
