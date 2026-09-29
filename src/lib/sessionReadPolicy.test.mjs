import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clampSessionReadPolicy,
  defaultSessionReadPolicy,
  describeSessionReadPolicy,
  sameSessionReadPolicy,
  SESSION_READ_LIMITS,
  SESSION_READ_PERIOD_CHOICES,
  sessionReadOriginFor,
  sessionReadPeriodChoice,
  sessionReadPeriodFromChoice,
  sessionReadRecentDaysField,
  sessionReadSettingsOrDefault,
} from "./sessionReadPolicy.ts";

const { cases } = JSON.parse(
  readFileSync(new URL("./sessionReadSummaryCases.json", import.meta.url), "utf8"),
);

/**
 * 기본값 위에 이번 테스트가 실제로 보려는 항목만 얹은 정책. 정책은 12개 항목이 모두
 * 채워져 있어야 비교·자르기가 성립하므로 테스트마다 기본값을 펼쳐 적고 있었는데, 그러면
 * 어느 항목이 이 테스트의 관심사인지가 기본값 펼치기에 묻혔다.
 */
function policy(overrides = {}) {
  return { ...defaultSessionReadPolicy(), ...overrides };
}

test("요약 문구는 Rust 쪽과 같은 케이스 파일을 만족한다", () => {
  assert.ok(cases.length >= 8);
  for (const item of cases) {
    assert.equal(describeSessionReadPolicy(policy(item.policy)), item.summary, item.name);
  }
});

test("세션 참조를 모르던 저장본은 비활성 기본값으로 열린다", () => {
  const settings = sessionReadSettingsOrDefault(null);
  assert.equal(settings.policy.enabled, false);
  assert.equal(settings.origin, "manual");
  assert.equal(settings.aiaRecommendation, null);
  assert.equal(describeSessionReadPolicy(settings.policy), "세션 참조 사용 안 함");
});

test("저장본에 없는 항목만 기본값으로 채우고 있는 값은 보존한다", () => {
  const settings = sessionReadSettingsOrDefault({
    policy: { enabled: true, detail: "limitedTranscript" },
    origin: "aia",
  });
  assert.equal(settings.policy.enabled, true);
  assert.equal(settings.policy.detail, "limitedTranscript");
  assert.equal(settings.policy.maxSessions, 50);
  assert.equal(settings.origin, "aia");
});

test("수동 편집은 manual, AIA 추천값을 되돌리면 다시 aia가 된다", () => {
  const recommendation = policy({
    enabled: true,
    projectScope: "allRegistered",
    providers: ["codex", "claude"],
    detail: "workRationale",
    maxSessions: 100,
  });
  assert.equal(sessionReadOriginFor(recommendation, recommendation), "aia");
  const edited = { ...recommendation, maxSessions: 7 };
  assert.equal(sessionReadOriginFor(edited, recommendation), "manual");
  // 되돌리면 출처도 함께 돌아온다.
  assert.equal(sessionReadOriginFor({ ...edited, maxSessions: 100 }, recommendation), "aia");
  // 추천값이 없으면 어떤 값이든 수동이다.
  assert.equal(sessionReadOriginFor(recommendation, null), "manual");
});

test("정책 비교는 배열·객체 키 순서에 흔들리지 않는다", () => {
  const left = policy({ enabled: true, providers: ["codex"] });
  const right = { enabled: true, providers: ["codex"], ...policy(), providers: ["codex"] };
  right.enabled = true;
  assert.equal(sameSessionReadPolicy(left, right), true);
  assert.equal(sameSessionReadPolicy(left, { ...left, providers: ["claude"] }), false);
});

test("상한을 넘는 값과 0은 저장 전에 눌린다", () => {
  const clamped = clampSessionReadPolicy(policy({
    enabled: true,
    maxSessions: 100000,
    maxTurnsPerSession: 0,
    pageSize: 999,
    period: { kind: "recentDays", days: 10000 },
  }));
  assert.equal(clamped.maxSessions, SESSION_READ_LIMITS.maxSessions);
  assert.equal(clamped.maxTurnsPerSession, 40);
  assert.equal(clamped.pageSize, SESSION_READ_LIMITS.pageSize);
  assert.deepEqual(clamped.period, { kind: "recentDays", days: SESSION_READ_LIMITS.recentDays });
});

test("범위를 바꾸면 남아 있던 프로젝트 선택은 지워진다", () => {
  const clamped = clampSessionReadPolicy(policy({
    enabled: true,
    projectScope: "allRegistered",
    projects: ["/tmp/leftover"],
  }));
  assert.deepEqual(clamped.projects, []);
});

test("중복 공급자와 상태는 순서를 지키며 한 번만 남는다", () => {
  const clamped = clampSessionReadPolicy(policy({
    enabled: true,
    providers: ["codex", "claude", "codex"],
    statuses: ["completed", "completed", "failed"],
  }));
  assert.deepEqual(clamped.providers, ["codex", "claude"]);
  assert.deepEqual(clamped.statuses, ["completed", "failed"]);
});

test("기간 선택지와 정책 값은 서로 왕복한다", () => {
  const cases = [
    ["reportPeriod", { kind: "reportPeriod" }],
    ["lastDay", { kind: "relative", unit: "day", count: 1 }],
    ["lastWeek", { kind: "relative", unit: "week", count: 1 }],
    ["lastMonth", { kind: "relative", unit: "month", count: 1 }],
  ];
  for (const [choice, period] of cases) {
    assert.deepEqual(sessionReadPeriodFromChoice(choice, { kind: "reportPeriod" }), period);
    assert.equal(sessionReadPeriodChoice(period), choice);
  }
  assert.deepEqual(sessionReadPeriodFromChoice("recentDays", { kind: "reportPeriod" }), {
    kind: "recentDays",
    days: 7,
  });
  // 이미 최근 N일이면 숫자를 물려받는다.
  assert.deepEqual(sessionReadPeriodFromChoice("recentDays", { kind: "recentDays", days: 30 }), {
    kind: "recentDays",
    days: 30,
  });
});

// 편집기가 내놓는 선택지는 모두 제 규칙을 가져야 한다. 규칙이 없는 선택지가 조용히 다른
// 기간으로 떨어지면 고른 값과 다른 값이 저장되는데 화면에는 아무 표시가 남지 않는다.
test("편집기 선택지는 하나도 빠짐없이 제 기간으로 되돌아간다", () => {
  for (const { value } of SESSION_READ_PERIOD_CHOICES) {
    const period = sessionReadPeriodFromChoice(value, { kind: "reportPeriod" });
    assert.equal(sessionReadPeriodChoice(period), value, value);
  }
});

test("복수 단위 상대 기간은 최근 N일 선택지로 접힌다", () => {
  assert.equal(sessionReadPeriodChoice({ kind: "relative", unit: "week", count: 3 }), "recentDays");
});

// 편집기는 기간 선택지를 `sessionReadPeriodChoice`로 고르면서 곁들인 숫자 칸만 기간 종류로
// 갈랐다. 둘이 갈리는 자리가 바로 여기다 — `{relative, week, 3}`은 선택지가 "최근 N일"인데
// 종류는 `relative`라, 화면에는 숫자 칸이 아예 서지 않아 저장된 3주를 보지도 고치지도
// 못했다. 선택지가 숫자를 요구하면 그 값도 함께 나와야 한다.
test("최근 N일 선택지로 접힌 기간은 곁들인 일수도 함께 내놓는다", () => {
  const days = (period) => sessionReadRecentDaysField(period)?.days ?? null;
  assert.equal(days({ kind: "recentDays", days: 30 }), 30);
  assert.equal(days({ kind: "relative", unit: "week", count: 3 }), 21);
  assert.equal(days({ kind: "relative", unit: "day", count: 5 }), 5);
  assert.equal(days({ kind: "relative", unit: "month", count: 2 }), 60);
  // 상한을 넘는 환산값은 저장 가능한 값으로 자른다(상대 24개월 = 720일 > 365일). 칸은
  // `max`가 걸린 입력이고 접힌 고급 옵션 안에 있어, 상한을 넘겨 세우면 브라우저가 폼을
  // 못 내보내게 막으면서 초점도 줄 수 없다.
  assert.equal(days({ kind: "relative", unit: "month", count: 24 }), 365);
  // 제 선택지를 가진 기간은 숫자 칸을 부르지 않는다.
  assert.equal(sessionReadRecentDaysField({ kind: "relative", unit: "week", count: 1 }), null);
  assert.equal(sessionReadRecentDaysField({ kind: "reportPeriod" }), null);
  assert.equal(sessionReadRecentDaysField({ kind: "absoluteRange", from: 0, to: 0 }), null);
});

// 상대 기간은 24개월(약 720일)까지 저장되는데 "최근 N일"은 365일까지만 담는다. 환산값을
// 조용히 자르면 저장된 18개월이 "최근 365일"로 떠 화면이 실제 참조 창의 절반만 적고,
// 그 칸을 고치지 않고 나가면 정책은 그대로 18개월이다. 칸은 저장 가능한 값으로 세우되
// 잘렸다는 사실은 함께 나와야 편집기가 그것을 알릴 수 있다.
test("저장 상한에 걸려 접힌 값은 접기 전 일수를 함께 내놓는다", () => {
  // 경계 — 12개월(360일)까지는 잘리지 않고, 13개월(390일)부터 칸이 짧아진다.
  assert.deepEqual(
    sessionReadRecentDaysField({ kind: "relative", unit: "month", count: 12 }),
    { days: 360, foldedFromDays: 360 },
  );
  assert.deepEqual(
    sessionReadRecentDaysField({ kind: "relative", unit: "month", count: 13 }),
    { days: SESSION_READ_LIMITS.recentDays, foldedFromDays: 390 },
  );
  assert.deepEqual(
    sessionReadRecentDaysField({ kind: "relative", unit: "month", count: 24 }),
    { days: SESSION_READ_LIMITS.recentDays, foldedFromDays: 720 },
  );
  // 상한 안에서 접힌 값은 알릴 것이 없다 — 두 수가 같으면 편집기가 안내를 세우지 않는다.
  for (const period of [
    { kind: "recentDays", days: 30 },
    { kind: "relative", unit: "day", count: 24 },
    { kind: "relative", unit: "week", count: 24 },
  ]) {
    const field = sessionReadRecentDaysField(period);
    assert.equal(field.days, field.foldedFromDays, JSON.stringify(period));
  }
});

// 선택지가 "최근 N일"인 기간은 하나도 빠짐없이 숫자를 내놓아야 한다. 어느 하나가 null이면
// 그 기간을 연 화면은 값 없는 선택지만 보여 준다.
test("최근 N일 선택지면 언제나 숫자 칸이 선다", () => {
  const periods = [
    { kind: "recentDays", days: 7 },
    { kind: "relative", unit: "day", count: 2 },
    { kind: "relative", unit: "week", count: 2 },
    { kind: "relative", unit: "month", count: 2 },
  ];
  for (const period of periods) {
    if (sessionReadPeriodChoice(period) !== "recentDays") continue;
    assert.equal(typeof sessionReadRecentDaysField(period)?.days, "number", JSON.stringify(period));
  }
});
