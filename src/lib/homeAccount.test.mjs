import assert from "node:assert/strict";
import test from "node:test";

import { homeAccountSummary, homeUsageNote, homeUsageRefreshDue } from "./homeAccount.ts";

const text = (ko) => ko;
const now = 1_700_000_000_000;

function home(overrides) {
  return {
    state: "verified",
    email: null,
    displayName: null,
    providerAccountId: null,
    accountId: null,
    accessTokenExpiresAt: null,
    checkedAt: now,
    retryAt: null,
    error: null,
    usage: usage(),
    ...overrides,
  };
}

function usage(overrides) {
  return { status: "idle", windows: [], updatedAt: null, error: null, retryAt: null, rateLimited: false, tokenRefreshLimited: false, tokenRefreshThrottleStreak: 0, ...overrides };
}

const window = { label: "5시간", usedPercent: 42, resetsAt: null };

const registered = [{ id: "claude-1", displayName: "개인 계정" }];

test("첫 관측 전과 저장소 없음은 행동을 요구하지 않는 회색 상태다", () => {
  assert.equal(homeAccountSummary("claude", undefined, [], now, text).tone, "muted");
  assert.equal(homeAccountSummary("claude", home({ state: "unchecked" }), [], now, text).title, "확인 중");
  const absent = homeAccountSummary("claude", home({ state: "absent" }), [], now, text);
  assert.equal(absent.title, "로그인 없음");
  assert.equal(absent.tone, "muted");
});

test("확인된 신원은 이메일을 제목으로 쓰고 등록 계정과 이어졌는지 적는다", () => {
  const matched = homeAccountSummary("claude", home({ email: "owner@example.com", accountId: "claude-1" }), registered, now, text);
  assert.equal(matched.title, "owner@example.com");
  assert.match(matched.detail, /등록 계정 ‘개인 계정’과 같은 계정/);
  assert.equal(matched.tone, "ready");

  const unregistered = homeAccountSummary("claude", home({ email: "other@example.com" }), registered, now, text);
  assert.equal(unregistered.detail, "등록되지 않은 계정");
  assert.equal(unregistered.tone, "muted");
});

test("확인된 신원의 토큰이 만료돼도 신원은 남고 만료 사실만 덧붙인다", () => {
  const summary = homeAccountSummary(
    "claude",
    home({ email: "owner@example.com", accountId: "claude-1", accessTokenExpiresAt: now - 1 }),
    registered,
    now,
    text,
  );
  assert.equal(summary.title, "owner@example.com");
  assert.match(summary.detail, /토큰 만료/);
  assert.equal(summary.tone, "ready");
});

test("만료·신원 미확인은 공급자별로 실제 갱신되는 로그인 경로를 안내한다", () => {
  const claude = homeAccountSummary("claude", home({ state: "expired", accessTokenExpiresAt: now - 1 }), registered, now, text);
  assert.equal(claude.title, "만료된 로그인 · 신원 미확인");
  assert.match(claude.detail, /갱신하지 않습니다/);
  // Claude 데스크탑 앱은 별도 웹 세션이라 공유 홈을 갱신하지 못한다. 터미널 CLI만 안내한다.
  assert.match(claude.detail, /터미널에서 claude를 열어 \/login/);
  assert.match(claude.detail, /데스크탑 앱 로그인은 공유 홈과 별개/);
  assert.equal(claude.tone, "warning");

  const codex = homeAccountSummary("codex", home({ state: "expired" }), registered, now, text);
  assert.match(codex.detail, /갱신하지 않습니다/);
  // ChatGPT 데스크탑 앱은 공유 홈 auth.json을 되쓰므로 데스크탑 경로가 유효하다.
  assert.match(codex.detail, /ChatGPT 데스크탑 앱/);
  assert.equal(codex.tone, "warning");
});

test("조회 실패는 원인과 다음 확인 시점을 함께 적는다", () => {
  const summary = homeAccountSummary(
    "claude",
    home({ state: "error", error: "HTTP 401", retryAt: Date.now() + 30 * 60_000 }),
    registered,
    now,
    text,
  );
  assert.equal(summary.title, "신원 확인 실패");
  assert.match(summary.detail, /^HTTP 401 · 다음 확인 /);
  assert.equal(summary.tone, "warning");
});

test("신원을 확인하지 못한 홈에는 사용량 줄을 붙이지 않는다", () => {
  assert.equal(homeUsageNote(undefined, text), null);
  assert.equal(homeUsageNote(home({ state: "expired" }), text), null);
  assert.equal(homeUsageNote(home({ state: "absent" }), text), null);
});

test("조회하지 못한 이유는 지우지 않고 그대로 읽는다", () => {
  const note = homeUsageNote(home({ usage: usage({ status: "unavailable", error: "공유 홈의 액세스 토큰이 만료돼 조회할 수 없습니다", updatedAt: now }) }), text);
  assert.equal(note.tone, "error");
  assert.match(note.note, /만료돼 조회할 수 없습니다/);
});

test("마지막 성공 수치가 남아 있으면 오류로 갈아치우지 않고 낡음만 알린다", () => {
  const note = homeUsageNote(home({ usage: usage({ status: "error", error: "HTTP 429", updatedAt: now, windows: [window] }) }), text);
  assert.equal(note.tone, "muted");
  assert.match(note.note, /마지막 조회 값을 유지합니다$/);
  assert.doesNotMatch(note.note, /HTTP 429/);
});

test("성공한 조회는 기준 시각만, 한 번도 못 읽었으면 그 사실을 적는다", () => {
  assert.match(homeUsageNote(home({ usage: usage({ status: "ok", updatedAt: now, windows: [window] }) }), text).note, / 기준$/);
  assert.equal(homeUsageNote(home({}), text).note, "아직 조회하지 않았습니다.");
});

test("등록 계정과 겹치는 홈은 사용량 조회 대상이 아니다", () => {
  // 그 계정이 자기 주기로 이미 같은 공급자 계정을 조회한다. 여기서 또 부르면 429 압력만 두 배가 된다.
  assert.equal(homeUsageRefreshDue(home({ accountId: "claude-1" }), now), false);
  assert.equal(homeUsageRefreshDue(home({ state: "expired" }), now), false);
  assert.equal(homeUsageRefreshDue(undefined, now), false);
});

test("미등록 홈은 느린 주기로 읽고 재시도 대기는 지킨다", () => {
  assert.equal(homeUsageRefreshDue(home({}), now), true);
  assert.equal(homeUsageRefreshDue(home({ usage: usage({ updatedAt: now - 60_000 }) }), now), false);
  assert.equal(homeUsageRefreshDue(home({ usage: usage({ updatedAt: now - 31 * 60_000 }) }), now), true);
  assert.equal(
    homeUsageRefreshDue(home({ usage: usage({ updatedAt: now - 31 * 60_000, retryAt: now + 60_000 }) }), now),
    false,
  );
});

test("창 초기화 시각이 지났으면 주기와 무관하게 다시 읽는다", () => {
  const reset = { label: "5시간", usedPercent: 90, resetsAt: now - 1_000 };
  assert.equal(homeUsageRefreshDue(home({ usage: usage({ updatedAt: now - 60_000, windows: [reset] }) }), now), true);
});
