import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clampSessionReadPolicy,
  defaultSessionReadPolicy,
  describeSessionReadPolicy,
  sameSessionReadPolicy,
  SESSION_READ_LIMITS,
  sessionReadOriginFor,
  sessionReadPeriodChoice,
  sessionReadPeriodFromChoice,
  sessionReadSettingsOrDefault,
} from "./sessionReadPolicy.ts";

const { cases } = JSON.parse(
  readFileSync(new URL("./sessionReadSummaryCases.json", import.meta.url), "utf8"),
);

test("요약 문구는 Rust 쪽과 같은 케이스 파일을 만족한다", () => {
  assert.ok(cases.length >= 8);
  for (const item of cases) {
    const policy = { ...defaultSessionReadPolicy(), ...item.policy };
    assert.equal(describeSessionReadPolicy(policy), item.summary, item.name);
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
  const recommendation = {
    ...defaultSessionReadPolicy(),
    enabled: true,
    projectScope: "allRegistered",
    providers: ["codex", "claude"],
    detail: "workRationale",
    maxSessions: 100,
  };
  assert.equal(sessionReadOriginFor(recommendation, recommendation), "aia");
  const edited = { ...recommendation, maxSessions: 7 };
  assert.equal(sessionReadOriginFor(edited, recommendation), "manual");
  // 되돌리면 출처도 함께 돌아온다.
  assert.equal(sessionReadOriginFor({ ...edited, maxSessions: 100 }, recommendation), "aia");
  // 추천값이 없으면 어떤 값이든 수동이다.
  assert.equal(sessionReadOriginFor(recommendation, null), "manual");
});

test("정책 비교는 배열·객체 키 순서에 흔들리지 않는다", () => {
  const left = { ...defaultSessionReadPolicy(), enabled: true, providers: ["codex"] };
  const right = { enabled: true, providers: ["codex"], ...defaultSessionReadPolicy(), providers: ["codex"] };
  right.enabled = true;
  assert.equal(sameSessionReadPolicy(left, right), true);
  assert.equal(sameSessionReadPolicy(left, { ...left, providers: ["claude"] }), false);
});

test("상한을 넘는 값과 0은 저장 전에 눌린다", () => {
  const clamped = clampSessionReadPolicy({
    ...defaultSessionReadPolicy(),
    enabled: true,
    maxSessions: 100000,
    maxTurnsPerSession: 0,
    pageSize: 999,
    period: { kind: "recentDays", days: 10000 },
  });
  assert.equal(clamped.maxSessions, SESSION_READ_LIMITS.maxSessions);
  assert.equal(clamped.maxTurnsPerSession, 40);
  assert.equal(clamped.pageSize, SESSION_READ_LIMITS.pageSize);
  assert.deepEqual(clamped.period, { kind: "recentDays", days: SESSION_READ_LIMITS.recentDays });
});

test("범위를 바꾸면 남아 있던 프로젝트 선택은 지워진다", () => {
  const clamped = clampSessionReadPolicy({
    ...defaultSessionReadPolicy(),
    enabled: true,
    projectScope: "allRegistered",
    projects: ["/tmp/leftover"],
  });
  assert.deepEqual(clamped.projects, []);
});

test("중복 공급자와 상태는 순서를 지키며 한 번만 남는다", () => {
  const clamped = clampSessionReadPolicy({
    ...defaultSessionReadPolicy(),
    enabled: true,
    providers: ["codex", "claude", "codex"],
    statuses: ["completed", "completed", "failed"],
  });
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

test("복수 단위 상대 기간은 최근 N일 선택지로 접힌다", () => {
  assert.equal(sessionReadPeriodChoice({ kind: "relative", unit: "week", count: 3 }), "recentDays");
});

test("입력창 칩은 지금 유효한 범위와 재발급 필요를 그대로 말한다", () => {
  const grant = {
    id: "grant-1",
    origin: "aia",
    scope: "turn",
    turnOrdinal: 3,
    issuedAt: 0,
    expiresAt: 0,
    windowFrom: 0,
    windowTo: 0,
    sessionsReturned: 0,
    detailCalls: 0,
    summary: "전체 등록 프로젝트 · Codex/Claude · 지난주 · 작업 근거 · 최대 100개",
    partialReportReasons: [],
  };
});

test("실행 단위 MCP 설정이 없는 공급자에는 도구를 붙일 수 없다", () => {
});
