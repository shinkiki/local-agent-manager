import assert from "node:assert/strict";
import test from "node:test";

import { clampScheduleNumber, INTERVAL_HOURS, RUN_HOUR, RUN_MINUTE } from "./scheduleNumber.ts";

test("빈 칸과 숫자가 아닌 초안은 하한으로 떨어진다", () => {
  assert.equal(clampScheduleNumber("", INTERVAL_HOURS), 1);
  assert.equal(clampScheduleNumber("  ", RUN_HOUR), 0);
  assert.equal(clampScheduleNumber("abc", RUN_MINUTE), 0);
});

test("범위 밖 값은 경계로 잘리고 소수는 반올림된다", () => {
  assert.equal(clampScheduleNumber("25", RUN_HOUR), 23);
  assert.equal(clampScheduleNumber("-3", RUN_MINUTE), 0);
  assert.equal(clampScheduleNumber("500", INTERVAL_HOURS), 168);
  assert.equal(clampScheduleNumber("0", INTERVAL_HOURS), 1);
  assert.equal(clampScheduleNumber(" 7.6 ", RUN_HOUR), 8);
  assert.equal(clampScheduleNumber("05", RUN_MINUTE), 5);
});

test("경계값은 그대로 두고 지수 표기와 무한대도 범위 안으로 접힌다", () => {
  assert.equal(clampScheduleNumber("23", RUN_HOUR), 23);
  assert.equal(clampScheduleNumber("168", INTERVAL_HOURS), 168);
  assert.equal(clampScheduleNumber("1e3", INTERVAL_HOURS), 168);
  assert.equal(clampScheduleNumber("Infinity", RUN_MINUTE), 0);
});
