import assert from "node:assert/strict";
import test from "node:test";

import { clampBaselineRuns, clampPercent, parseCount, parseNumberField, parsePercent } from "./usageBudgetFields.ts";

test("parseNumberField: 빈 칸은 호출부가 정한 값, 숫자가 아니면 null", () => {
  assert.equal(parseNumberField("  ", null), null);
  assert.equal(parseNumberField("", 0), 0);
  assert.equal(parseNumberField("   ", 0), 0);
  assert.equal(parseNumberField(" 12.5 ", null), 12.5);
  assert.equal(parseNumberField("abc", 0), null);
  assert.equal(parseNumberField("Infinity", 0), null);
});

test("clampPercent: 0~100 밖으로 나가지 않는다", () => {
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(42), 42);
  assert.equal(clampPercent(140), 100);
});

test("parsePercent: 빈 입력은 캡 없음, 숫자는 0~100으로 자른다", () => {
  assert.equal(parsePercent(""), null);
  assert.equal(parsePercent("x"), null);
  assert.equal(parsePercent("150"), 100);
  assert.equal(parsePercent("-1"), 0);
  assert.equal(parsePercent("33.3"), 33.3);
});

test("parseCount: 입력 중에는 범위를 자르지 않는다", () => {
  assert.equal(parseCount(""), null);
  assert.equal(parseCount("40"), 40);
  assert.equal(parseCount("0"), 0);
});

test("clampBaselineRuns: 백엔드 허용 범위 1~32의 정수로 맞춘다", () => {
  assert.equal(clampBaselineRuns(0), 1);
  assert.equal(clampBaselineRuns(2.6), 3);
  assert.equal(clampBaselineRuns(99), 32);
  assert.equal(clampBaselineRuns(5), 5);
  assert.equal(clampBaselineRuns(0.4), 1);
  assert.equal(clampBaselineRuns(-7), 1);
});
