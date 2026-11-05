import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_READ_COUNT_KEYS,
  SESSION_READ_DEFAULTS,
  SESSION_READ_LIMITS,
  clampSessionReadCount,
  clampSessionReadCounts,
  defaultSessionReadCounts,
} from "./sessionReadLimits.ts";

test("SESSION_READ_LIMITS와 SESSION_READ_DEFAULTS의 기본값은 상한을 넘지 않는다", () => {
  for (const [key, defaultValue] of Object.entries(SESSION_READ_DEFAULTS)) {
    const limit = SESSION_READ_LIMITS[key];
    assert.ok(typeof limit === "number", `상한 목록에 ${key}가 정의되어 있어야 한다`);
    assert.ok(defaultValue > 0, `${key} 기본값은 1 이상이어야 한다`);
    assert.ok(defaultValue <= limit, `${key} 기본값(${defaultValue})은 상한(${limit}) 이하여야 한다`);
  }
});

test("defaultSessionReadCounts는 정책 기본 숫자 한 벌을 생성한다", () => {
  const defaults = defaultSessionReadCounts();
  assert.deepEqual(defaults, {
    maxSessions: SESSION_READ_DEFAULTS.maxSessions,
    maxTurnsPerSession: SESSION_READ_DEFAULTS.maxTurnsPerSession,
    pageSize: SESSION_READ_DEFAULTS.pageSize,
  });
  assert.deepEqual(Object.keys(defaults).sort(), [...SESSION_READ_COUNT_KEYS].sort());
});

test("clampSessionReadCount는 상한을 초과하는 값을 상한으로 자른다", () => {
  assert.equal(clampSessionReadCount(99999, "maxSessions"), SESSION_READ_LIMITS.maxSessions);
  assert.equal(clampSessionReadCount(5000, "maxTurnsPerSession"), SESSION_READ_LIMITS.maxTurnsPerSession);
  assert.equal(clampSessionReadCount(100, "pageSize"), SESSION_READ_LIMITS.pageSize);
  assert.equal(clampSessionReadCount(1000, "recentDays"), SESSION_READ_LIMITS.recentDays);
  assert.equal(clampSessionReadCount(100, "relativeCount"), SESSION_READ_LIMITS.relativeCount);
});

test("clampSessionReadCount는 유효하지 않은 숫자나 0 이하 값을 기본값으로 되돌린다", () => {
  assert.equal(clampSessionReadCount(0, "maxSessions"), SESSION_READ_DEFAULTS.maxSessions);
  assert.equal(clampSessionReadCount(-10, "maxTurnsPerSession"), SESSION_READ_DEFAULTS.maxTurnsPerSession);
  assert.equal(clampSessionReadCount(NaN, "pageSize"), SESSION_READ_DEFAULTS.pageSize);
  assert.equal(clampSessionReadCount(Infinity, "recentDays"), SESSION_READ_DEFAULTS.recentDays);
  assert.equal(clampSessionReadCount(-Infinity, "relativeCount"), SESSION_READ_DEFAULTS.relativeCount);
});

test("clampSessionReadCount는 소수점 입력을 정수로 내림한다", () => {
  assert.equal(clampSessionReadCount(12.7, "recentDays"), 12);
  assert.equal(clampSessionReadCount(1.9, "relativeCount"), 1);
  assert.equal(clampSessionReadCount(25.1, "maxSessions"), 25);
});

test("clampSessionReadCounts는 카운트 맵의 모든 항목을 개별 규칙으로 자른다", () => {
  const clamped = clampSessionReadCounts({
    maxSessions: 9999,
    maxTurnsPerSession: 0,
    pageSize: -5,
  });
  assert.deepEqual(clamped, {
    maxSessions: SESSION_READ_LIMITS.maxSessions,
    maxTurnsPerSession: SESSION_READ_DEFAULTS.maxTurnsPerSession,
    pageSize: SESSION_READ_DEFAULTS.pageSize,
  });
});
