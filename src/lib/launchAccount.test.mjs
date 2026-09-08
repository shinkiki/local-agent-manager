import assert from "node:assert/strict";
import test from "node:test";

import { accountName, activeAccountId, launchAccountChoices, resolveLaunchAccountId } from "./launchAccount.ts";

function account(overrides = {}) {
  return {
    id: "codex-a",
    provider: "codex",
    displayName: "A",
    email: null,
    organization: null,
    providerAccountId: "provider-a",
    isActive: true,
    isDefault: true,
    isPendingDefault: false,
    disabled: false,
    authStatus: "ready",
    autoSwitch: false,
    autoSwitchPriority: null,
    note: null,
    credentialIsolated: true,
    credentialIsolationNote: null,
    runtimeCount: 0,
    usage: {
      status: "ok",
      windows: [{ label: "7일", usedPercent: 25, resetsAt: null }],
      updatedAt: 123,
      error: null,
      retryAt: null,
      rateLimited: false,
    },
    ...overrides,
  };
}

test("계정 이름은 표시 이름 · 이메일 · id 순으로 고르고, 스냅샷 도착 전과 후를 구분한다", () => {
  const snapshot = {
    accounts: [
      account({ id: "codex-a", displayName: "A", email: "a@example.com" }),
      account({ id: "codex-b", displayName: "", email: "b@example.com" }),
      account({ id: "codex-c", displayName: "", email: null }),
    ],
    providers: [{ provider: "codex", activeAccountId: "codex-a", observedActiveAccountId: null }],
  };

  assert.equal(accountName(snapshot, "codex", "codex-a"), "A");
  assert.equal(accountName(snapshot, "codex", "codex-b"), "b@example.com");
  assert.equal(accountName(snapshot, "codex", "codex-c"), "codex-c");
  assert.equal(accountName(snapshot, "codex", null), "계정 확인 불가");
  // 다른 공급자의 계정 id는 이 공급자에서 찾지 않는다.
  assert.equal(accountName(snapshot, "claude", "codex-a"), "알 수 없는 계정");
  // 스냅샷이 아직 없으면 없는 계정이라고 단정하지 않는다.
  assert.equal(accountName(null, "codex", "codex-a"), "계정 확인 중");
});

test("the default account is the registry selection, not the shared CLI home", () => {
  // 공유 홈에 든 로그인은 홈 계정 카드에만 보인다. 새 채팅과 헤더 사용량은 기본 계정을 따른다.
  const snapshot = {
    accounts: [],
    providers: [{
      provider: "codex",
      activeAccountId: "codex-registry",
      observedActiveAccountId: "codex-cli",
    }],
  };

  assert.equal(activeAccountId(snapshot, "codex"), "codex-registry");
  snapshot.providers[0].activeAccountId = null;
  assert.equal(activeAccountId(snapshot, "codex"), null);
});

test("the new chat account picker offers usable accounts and blocks the ones isolation rejected", () => {
  const snapshot = {
    accounts: [
      account({ id: "codex-a", displayName: "A" }),
      account({ id: "codex-b", displayName: "B", isActive: false, credentialIsolated: true }),
      // 격리 프로브가 실패로 확정된 비활성 계정: 목록에는 두되 고를 수 없다.
      account({ id: "codex-c", displayName: "C", isActive: false, credentialIsolated: false, credentialIsolationNote: "프로필을 읽지 못했습니다" }),
      // 아직 실행한 적이 없어 판정 전인 계정은 막지 않는다.
      account({ id: "codex-d", displayName: "D", isActive: false, credentialIsolated: false }),
      account({ id: "codex-off", displayName: "OFF", isActive: false, disabled: true }),
      account({ id: "codex-auth", displayName: "AUTH", isActive: false, authStatus: "needsReauthentication" }),
      account({ id: "claude-a", displayName: "CL", provider: "claude", isActive: false }),
    ],
    providers: [{ provider: "codex", activeAccountId: "codex-a", observedActiveAccountId: null }],
  };

  const choices = launchAccountChoices(snapshot, "codex");
  assert.deepEqual(choices.map((choice) => choice.id), ["codex-a", "codex-b", "codex-c", "codex-d"]);
  assert.equal(choices[0].label, "A · 기본");
  assert.deepEqual(choices.map((choice) => choice.blocked), [false, false, true, false]);
  assert.equal(choices[2].blockedReason, "프로필을 읽지 못했습니다");
  assert.deepEqual(launchAccountChoices(null, "codex"), []);
});

test("a launch account that disappeared or became unusable falls back to the active account", () => {
  const choices = [
    { id: "codex-b", label: "B", blocked: false, blockedReason: null },
    { id: "codex-c", label: "C", blocked: true, blockedReason: "격리 불가" },
  ];

  // 빈 값이 기본값(실행 시점 활성 계정)이다.
  assert.equal(resolveLaunchAccountId("", choices), "");
  assert.equal(resolveLaunchAccountId("codex-b", choices), "codex-b");
  assert.equal(resolveLaunchAccountId("codex-c", choices), "");
  assert.equal(resolveLaunchAccountId("codex-gone", choices), "");
  assert.equal(resolveLaunchAccountId("codex-b", []), "");
});
