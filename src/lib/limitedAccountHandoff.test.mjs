import assert from "node:assert/strict";
import test from "node:test";

import { accountUsageLimited, limitedAccountHandoff } from "./limitedAccountHandoff.ts";
import { accountSnapshot, accountUsageView, usageWindow } from "./usageViewFixtures.mjs";

function account(overrides = {}) {
  return {
    id: "claude-a",
    provider: "claude",
    displayName: "A",
    email: null,
    organization: null,
    providerAccountId: "provider-a",
    label: null,
    providerDisplayName: "A",
    isActive: false,
    disabled: false,
    authStatus: "ready",
    autoSwitch: false,
    autoSwitchPriority: null,
    note: null,
    credentialIsolated: true,
    credentialIsolationNote: null,
    runtimeCount: 0,
    usage: accountUsageView([usageWindow("5시간", 30)]),
    ...overrides,
  };
}

/** 사용량 한도로 막힌 계정. 에이전트가 제한 응답을 받으면 백엔드가 이 표시를 켠다. */
function limited(overrides = {}) {
  return account({
    usage: accountUsageView([usageWindow("5시간", 100)], {
      status: "error",
      error: "HTTP 429",
      rateLimited: true,
    }),
    ...overrides,
  });
}

/** 한도에 걸린 A로 돌고 있고 기본 계정은 멀쩡한 B로 바뀐 상태. */
function snapshot(overrides = {}) {
  return accountSnapshot({
    accounts: [limited({ id: "claude-a" }), account({ id: "claude-b", displayName: "B", isActive: true })],
    providers: [{ provider: "claude", activeAccountId: "claude-b" }],
    ...overrides,
  });
}

const input = (overrides = {}) => ({
  accounts: snapshot(),
  source: "claude",
  runtimeAccountId: "claude-a",
  pinnedAccountId: null,
  ...overrides,
});

test("한도에 걸린 실행 계정은 바뀐 기본 계정으로 옮긴다", () => {
  assert.deepEqual(limitedAccountHandoff(input()), {
    fromAccountId: "claude-a",
    fromLabel: "A",
    toAccountId: "claude-b",
    toLabel: "B",
  });
});

test("한도에 걸리지 않은 실행은 그대로 둔다", () => {
  const accounts = snapshot({
    accounts: [account({ id: "claude-a" }), account({ id: "claude-b", isActive: true })],
  });
  assert.equal(limitedAccountHandoff(input({ accounts })), null);
});

test("토큰 갱신 429는 사용량 한도가 아니라 옮기지 않는다", () => {
  const accounts = snapshot({
    accounts: [
      limited({ id: "claude-a", usage: accountUsageView([], { rateLimited: true, tokenRefreshLimited: true }) }),
      account({ id: "claude-b", isActive: true }),
    ],
  });
  assert.equal(limitedAccountHandoff(input({ accounts })), null);
  assert.equal(accountUsageLimited(accountUsageView([], { rateLimited: true })), true);
});

test("계정을 고정한 세션은 한도에 걸려도 옮기지 않는다", () => {
  assert.equal(limitedAccountHandoff(input({ pinnedAccountId: "claude-a" })), null);
});

test("기본 계정이 그대로면 옮길 곳이 없다", () => {
  const accounts = snapshot({ providers: [{ provider: "claude", activeAccountId: "claude-a" }] });
  assert.equal(limitedAccountHandoff(input({ accounts })), null);
});

test("바뀐 기본 계정도 한도에 걸려 있으면 옮기지 않는다", () => {
  const accounts = snapshot({
    accounts: [limited({ id: "claude-a" }), limited({ id: "claude-b", isActive: true })],
  });
  assert.equal(limitedAccountHandoff(input({ accounts })), null);
});

test("자격증명 격리가 막힌 기본 계정으로는 옮기지 않는다", () => {
  const accounts = snapshot({
    accounts: [
      limited({ id: "claude-a" }),
      account({ id: "claude-b", isActive: true, credentialIsolated: false, credentialIsolationNote: "프로필을 만들지 못했습니다" }),
    ],
  });
  assert.equal(limitedAccountHandoff(input({ accounts })), null);
});

test("사용 중지된 기본 계정으로는 옮기지 않는다", () => {
  const accounts = snapshot({
    accounts: [limited({ id: "claude-a" }), account({ id: "claude-b", isActive: true, disabled: true })],
  });
  assert.equal(limitedAccountHandoff(input({ accounts })), null);
});

test("계정을 모르는 실행과 스냅샷이 없는 화면은 판단하지 않는다", () => {
  assert.equal(limitedAccountHandoff(input({ runtimeAccountId: null })), null);
  assert.equal(limitedAccountHandoff(input({ accounts: null })), null);
});

test("다른 공급자의 같은 id는 보지 않는다", () => {
  assert.equal(limitedAccountHandoff(input({ source: "codex" })), null);
});
