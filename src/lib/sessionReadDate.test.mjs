import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { dateInputValue, dayBoundaryMs } from "./sessionReadDate.ts";

test("V4 date fields preserve empty and unavailable values", () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(dateInputValue(value), "");
  }
  assert.equal(dayBoundaryMs("", "start"), 0);
  assert.equal(dayBoundaryMs("", "end"), 0);
});

// Each child has only its synthetic timezone, keeping the parent and sibling tests untouched.
function readInTimezone(timezone, days) {
  const moduleUrl = new URL("./sessionReadDate.ts", import.meta.url).href;
  const script = `
    import { dateInputValue, dayBoundaryMs } from ${JSON.stringify(moduleUrl)};
    const days = ${JSON.stringify(days)};
    console.log(JSON.stringify({
      dates: days.map(day => {
        const start = dayBoundaryMs(day, "start"), end = dayBoundaryMs(day, "end");
        return {start, end, displayed: [dateInputValue(start), dateInputValue(end)]};
      }),
      nearMidnight: dateInputValue(Date.parse("2026-03-08T01:30:00.000Z")),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8", env: { TZ: timezone } }));
}

for (const [timezone, midnight, first, last] of [
  ["UTC", "2026-03-08", "2026-03-08T00:00:00.000Z", "2026-03-08T23:59:59.999Z"],
  ["Asia/Seoul", "2026-03-08", "2026-03-07T15:00:00.000Z", "2026-03-08T14:59:59.999Z"],
  ["America/New_York", "2026-03-07", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z"],
]) {
  test(`V4 date fields use local calendar boundaries in ${timezone}`, () => {
    const result = readInTimezone(timezone, ["2026-03-08"]);
    assert.deepEqual(result, {
      dates: [{
        start: Date.parse(first), end: Date.parse(last),
        displayed: ["2026-03-08", "2026-03-08"],
      }],
      nearMidnight: midnight,
    });
  });
}

test("V4 date fields preserve leap day and a 25-hour daylight-saving day", () => {
  const { dates } = readInTimezone("America/New_York", ["2024-02-29", "2026-11-01"]);
  assert.deepEqual(dates, [
    {
      start: Date.parse("2024-02-29T05:00:00.000Z"),
      end: Date.parse("2024-03-01T04:59:59.999Z"),
      displayed: ["2024-02-29", "2024-02-29"],
    },
    {
      start: Date.parse("2026-11-01T04:00:00.000Z"),
      end: Date.parse("2026-11-02T04:59:59.999Z"),
      displayed: ["2026-11-01", "2026-11-01"],
    },
  ]);
});
