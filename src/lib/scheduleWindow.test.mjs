import assert from "node:assert/strict";
import test from "node:test";
import {
  activeWindowEnded,
  describeActiveWindow,
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
} from "./scheduleWindow.ts";

test("datetime-local 왕복은 로컬 시각을 그대로 되돌린다", () => {
  const value = "2026-09-01T23:30";
  const timestamp = fromDatetimeLocalValue(value);
  assert.equal(typeof timestamp, "number");
  assert.equal(toDatetimeLocalValue(timestamp), value);
});

test("빈 입력은 제한 없음이다", () => {
  assert.equal(fromDatetimeLocalValue(""), null);
  assert.equal(fromDatetimeLocalValue("   "), null);
  assert.equal(toDatetimeLocalValue(null), "");
  assert.equal(toDatetimeLocalValue(undefined), "");
});

test("활성 창이 없으면 요약도 없다", () => {
  assert.equal(describeActiveWindow({}), null);
  assert.equal(describeActiveWindow({ activeFrom: null, activeUntil: null }), null);
});

test("한쪽만 있는 창은 그 끝만 요약한다", () => {
  const from = Date.parse("2026-09-01T09:00:00Z");
  const until = Date.parse("2026-09-01T23:00:00Z");
  assert.match(describeActiveWindow({ activeFrom: from }), /부터$/);
  assert.match(describeActiveWindow({ activeUntil: until }), /까지$/);
  assert.match(describeActiveWindow({ activeFrom: from, activeUntil: until }), / ~ /);
});

test("종료가 지난 창만 기간 종료로 본다", () => {
  const until = 1_000_000;
  assert.equal(activeWindowEnded({ activeUntil: until }, until), false);
  assert.equal(activeWindowEnded({ activeUntil: until }, until + 1), true);
  assert.equal(activeWindowEnded({}, until + 1), false);
});
