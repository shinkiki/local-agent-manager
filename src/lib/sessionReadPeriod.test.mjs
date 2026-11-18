import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSessionReadPeriod,
  SESSION_READ_PERIOD_CHOICES,
  SESSION_READ_PERIOD_INVERTED_TEXT,
  sessionReadPeriodChoice,
  sessionReadPeriodFromChoice,
  sessionReadPeriodInverted,
  sessionReadPeriodKey,
  sessionReadPeriodLabel,
  sessionReadRecentDaysField,
} from "./sessionReadPeriod.ts";

test("sessionReadPeriodLabel formats labels for each period kind", () => {
  assert.equal(sessionReadPeriodLabel({ kind: "reportPeriod" }), "보고기간");
  assert.equal(sessionReadPeriodLabel({ kind: "recentDays", days: 14 }), "최근 14일");
  assert.equal(sessionReadPeriodLabel({ kind: "absoluteRange", from: 100, to: 200 }), "직접 범위");
  assert.equal(sessionReadPeriodLabel({ kind: "relative", unit: "day", count: 1 }), "어제");
  assert.equal(sessionReadPeriodLabel({ kind: "relative", unit: "day", count: 3 }), "지난 3일");
  assert.equal(sessionReadPeriodLabel({ kind: "relative", unit: "week", count: 1 }), "지난주");
  assert.equal(sessionReadPeriodLabel({ kind: "relative", unit: "week", count: 2 }), "지난 2주");
  assert.equal(sessionReadPeriodLabel({ kind: "relative", unit: "month", count: 1 }), "지난달");
  assert.equal(sessionReadPeriodLabel({ kind: "relative", unit: "month", count: 6 }), "지난 6개월");
});

test("sessionReadPeriodInverted validates range ordering", () => {
  // 0, 0 is the clean initial state and not treated as inverted
  assert.equal(sessionReadPeriodInverted({ kind: "absoluteRange", from: 0, to: 0 }), false);
  assert.equal(sessionReadPeriodInverted({ kind: "absoluteRange", from: 100, to: 200 }), false);
  assert.equal(sessionReadPeriodInverted({ kind: "absoluteRange", from: 200, to: 100 }), true);
  assert.equal(sessionReadPeriodInverted({ kind: "absoluteRange", from: 100, to: 0 }), true);
  // Non-absoluteRange kinds never report inverted
  assert.equal(sessionReadPeriodInverted({ kind: "reportPeriod" }), false);
  assert.equal(sessionReadPeriodInverted({ kind: "recentDays", days: 7 }), false);
  assert.equal(sessionReadPeriodInverted({ kind: "relative", unit: "day", count: 1 }), false);
  assert.equal(typeof SESSION_READ_PERIOD_INVERTED_TEXT, "string");
  assert.ok(SESSION_READ_PERIOD_INVERTED_TEXT.length > 0);
});

test("sessionReadPeriodKey serializes period kinds into comparative arrays", () => {
  assert.deepEqual(sessionReadPeriodKey({ kind: "reportPeriod" }), ["reportPeriod"]);
  assert.deepEqual(
    sessionReadPeriodKey({ kind: "relative", unit: "week", count: 2 }),
    ["relative", "week", 2],
  );
  assert.deepEqual(sessionReadPeriodKey({ kind: "recentDays", days: 30 }), ["recentDays", 30]);
  assert.deepEqual(
    sessionReadPeriodKey({ kind: "absoluteRange", from: 100, to: 200 }),
    ["absoluteRange", 100, 200],
  );
});

test("clampSessionReadPeriod respects limits for days and relative counts", () => {
  assert.deepEqual(
    clampSessionReadPeriod({ kind: "recentDays", days: 9999 }),
    { kind: "recentDays", days: 365 },
  );
  // value <= 0 defaults to SESSION_READ_DEFAULTS.recentDays (7)
  assert.deepEqual(
    clampSessionReadPeriod({ kind: "recentDays", days: 0 }),
    { kind: "recentDays", days: 7 },
  );
  assert.deepEqual(
    clampSessionReadPeriod({ kind: "recentDays", days: 10 }),
    { kind: "recentDays", days: 10 },
  );
  assert.deepEqual(
    clampSessionReadPeriod({ kind: "relative", unit: "month", count: 999 }),
    { kind: "relative", unit: "month", count: 24 },
  );
  // value <= 0 defaults to SESSION_READ_DEFAULTS.relativeCount (1)
  assert.deepEqual(
    clampSessionReadPeriod({ kind: "relative", unit: "day", count: 0 }),
    { kind: "relative", unit: "day", count: 1 },
  );
  assert.deepEqual(
    clampSessionReadPeriod({ kind: "relative", unit: "day", count: 5 }),
    { kind: "relative", unit: "day", count: 5 },
  );
  // Kinds without numeric bounds are preserved
  const report = { kind: "reportPeriod" };
  assert.equal(clampSessionReadPeriod(report), report);
  const range = { kind: "absoluteRange", from: 10, to: 20 };
  assert.equal(clampSessionReadPeriod(range), range);
});
