import assert from "node:assert/strict";
import test from "node:test";

import {
  accountUsageDisplayState,
  displayUsageWindows,
  elapsedResetSignature,
  usageRefreshDeferred,
  usageRefreshInterval,
  usageResetElapsedSinceUpdate,
  usageRetryBlockedUntil,
  nextUsageReset,
  usageWindowValueUnavailable,
  remainingUsagePercent,
  usageLevel,
  BUSY_USAGE_REFRESH_INTERVAL_MS,
  IDLE_USAGE_REFRESH_INTERVAL_MS,
} from "./accountUsage.ts";

const NOW = 1_000_000;

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

function rateLimited(retryAt, overrides = {}) {
  return account({
    usage: {
      status: "error",
      windows: [{ label: "5시간", usedPercent: 100, resetsAt: null }],
      updatedAt: NOW - 10_000,
      error: "HTTP 429",
      retryAt,
      rateLimited: true,
      ...overrides,
    },
  });
}

test("every usable account can refresh, active or not", () => {
  // 자격증명이 계정별로 갈려 있어 활성 여부는 조회 조건이 아니다.
  assert.equal(accountUsageDisplayState(account(), NOW).canRefresh, true);
  assert.equal(accountUsageDisplayState(account({ isActive: false }), NOW).canRefresh, true);
  // 쓸 수 없는 계정만 조회 대상에서 빠진다.
  assert.equal(accountUsageDisplayState(account({ disabled: true }), NOW).canRefresh, false);
  assert.equal(accountUsageDisplayState(account({ authStatus: "needsReauthentication" }), NOW).canRefresh, false);
});

test("a rate limit with a future retry time blocks the manual refresh and reports the retry time", () => {
  const state = accountUsageDisplayState(rateLimited(NOW + 60_000), NOW);
  assert.equal(state.canRefresh, false);
  assert.equal(state.retryBlockedUntil, NOW + 60_000);
  // 보관된 마지막 수치가 있으므로 오류 문구로 갈아치우지 않고 사유만 도움말로 남긴다.
  assert.equal(state.error, null);
  assert.equal(state.staleError, "HTTP 429");
});

test("a failed refresh keeps the last usage instead of replacing it with the error", () => {
  const kept = accountUsageDisplayState(account({
    usage: {
      status: "error",
      windows: [{ label: "5시간", usedPercent: 62, resetsAt: null }],
      updatedAt: NOW - 600_000,
      error: "Codex 사용량을 조회하지 못했습니다: error sending request",
      retryAt: NOW + 300_000,
      rateLimited: false,
    },
  }), NOW);
  assert.equal(kept.error, null);
  assert.equal(kept.staleError, "Codex 사용량을 조회하지 못했습니다: error sending request");

  // 보여줄 마지막 값이 없으면 오류 문구가 유일한 정보라 그대로 띄운다.
  const nothingToKeep = accountUsageDisplayState(account({
    usage: {
      status: "error",
      windows: [],
      updatedAt: null,
      error: "Codex 사용량을 조회하지 못했습니다: error sending request",
      retryAt: NOW + 300_000,
      rateLimited: false,
    },
  }), NOW);
  assert.equal(nothingToKeep.error, "Codex 사용량을 조회하지 못했습니다: error sending request");
  assert.equal(nothingToKeep.staleError, null);
});

test("the manual refresh reopens once the retry time is reached or passed", () => {
  for (const retryAt of [NOW, NOW - 1, NOW - 60_000]) {
    const state = accountUsageDisplayState(rateLimited(retryAt), NOW);
    assert.equal(state.canRefresh, true, `retryAt=${retryAt}`);
    assert.equal(state.retryBlockedUntil, null, `retryAt=${retryAt}`);
  }
});

test("accounts that cannot refresh anyway do not advertise a retry time", () => {
  // 중지·재인증 필요 계정은 한도가 아니라 그 상태 자체가 갱신을 막는 이유다.
  const disabled = { ...rateLimited(NOW + 60_000), disabled: true };
  assert.equal(accountUsageDisplayState(disabled, NOW).retryBlockedUntil, null);
  const needsAuth = { ...rateLimited(NOW + 60_000), authStatus: "needsReauthentication" };
  assert.equal(accountUsageDisplayState(needsAuth, NOW).retryBlockedUntil, null);
});

test("a rate limit without a retry time does not block the manual refresh", () => {
  for (const usage of [{ retryAt: null }, { retryAt: undefined }]) {
    const state = accountUsageDisplayState(rateLimited(usage.retryAt), NOW);
    assert.equal(state.canRefresh, true);
    assert.equal(state.retryBlockedUntil, null);
  }
});

test("other error states with a future retry time still allow a user-initiated refresh", () => {
  const state = accountUsageDisplayState(account({
    usage: {
      status: "error",
      windows: [],
      updatedAt: NOW - 10_000,
      error: "usage endpoint unavailable",
      retryAt: NOW + 60_000,
      rateLimited: false,
    },
  }), NOW);

  assert.equal(state.canRefresh, true);
  assert.equal(state.retryBlockedUntil, null);
  // 다만 폴링은 백엔드가 정한 재시도 시각까지 자동 조회를 미룬다.
  assert.equal(usageRefreshDeferred({ retryAt: NOW + 60_000, rateLimited: false }, NOW), true);
});

test("manual refresh protection never outlives the automatic refresh protection", () => {
  const cases = [
    { rateLimited: true, retryAt: NOW + 1 },
    { rateLimited: true, retryAt: NOW },
    { rateLimited: true, retryAt: null },
    { rateLimited: false, retryAt: NOW + 1 },
    { rateLimited: false, retryAt: null },
  ];

  for (const usage of cases) {
    const blocked = usageRetryBlockedUntil(usage, NOW) !== null;
    // 수동 차단은 자동 보류의 부분집합이어야 두 경로가 어긋나지 않는다.
    assert.ok(!blocked || usageRefreshDeferred(usage, NOW), JSON.stringify(usage));
  }

  assert.equal(usageRetryBlockedUntil({ rateLimited: true, retryAt: NOW + 1 }, NOW), NOW + 1);
  assert.equal(usageRefreshDeferred({ rateLimited: false, retryAt: NOW + 1 }, NOW), true);
  assert.equal(usageRefreshDeferred({ rateLimited: false, retryAt: NOW }, NOW), false);
  assert.equal(usageRefreshDeferred({ retryAt: null }, NOW), false);
});

test("accounts that cannot refresh keep cached meters without exposing an old refresh error", () => {
  const state = accountUsageDisplayState(account({
    disabled: true,
    usage: {
      status: "error",
      windows: [{ label: "7일", usedPercent: 80, resetsAt: null }],
      updatedAt: 456,
      error: "inactive refresh deferred",
      retryAt: 789,
      rateLimited: false,
    },
  }), NOW);

  assert.equal(state.cached, true);
  assert.equal(state.error, null);
  assert.equal(state.staleError, null);
  assert.equal(state.canRefresh, false);
});

test("windows whose stored reset time has passed display as 0% without a refetch", () => {
  const now = 1_000_000;
  const windows = displayUsageWindows([
    { label: "5시간", usedPercent: 100, resetsAt: now - 1 },
    { label: "7일", usedPercent: 23, resetsAt: now + 1 },
    { label: "무제한", usedPercent: 140, resetsAt: null },
  ], now);

  assert.deepEqual(windows, [
    { label: "5시간", usedPercent: 0, resetsAt: now - 1, resetElapsed: true, modelScoped: false },
    { label: "7일", usedPercent: 23, resetsAt: now + 1, resetElapsed: false, modelScoped: false },
    { label: "무제한", usedPercent: 100, resetsAt: null, resetElapsed: false, modelScoped: false },
  ]);
});

test("a reset window is unknown when the real refresh failed", () => {
  const [elapsed, current] = displayUsageWindows([
    { label: "5시간", usedPercent: 75, resetsAt: NOW - 1 },
    { label: "7일", usedPercent: 20, resetsAt: NOW + 1 },
  ], NOW);
  const failed = { status: "error" };

  assert.equal(usageWindowValueUnavailable(failed, elapsed), true);
  assert.equal(usageWindowValueUnavailable(failed, current), false);
  assert.equal(usageWindowValueUnavailable({ status: "ok" }, elapsed), false);
});

test("a reset elapsed after the last successful fetch requires a real usage recheck", () => {
  const usage = (updatedAt, resetsAt) => ({
    status: "ok",
    windows: [{ label: "5시간", usedPercent: 100, resetsAt }],
    updatedAt,
    error: null,
    retryAt: null,
    rateLimited: false,
  });

  assert.equal(usageResetElapsedSinceUpdate(usage(100, 200), 300), true);
  // 조회 이후 초기화 시각이 아직 오지 않았으면 재조회를 강제하지 않는다.
  assert.equal(usageResetElapsedSinceUpdate(usage(100, 400), 300), false);
  // 초기화 시각이 지난 뒤 이미 다시 조회했다면 반복 재조회하지 않는다.
  assert.equal(usageResetElapsedSinceUpdate(usage(250, 200), 300), false);
  assert.equal(usageResetElapsedSinceUpdate(usage(100, null), 300), false);
});

test("the elapsed-reset signature changes exactly when a stored reset time passes", () => {
  const snapshot = {
    providers: [],
    accounts: [account({
      usage: {
        status: "ok",
        windows: [{ label: "5시간", usedPercent: 100, resetsAt: 500 }],
        updatedAt: 100,
        error: null,
        retryAt: null,
        rateLimited: false,
      },
    })],
  };

  assert.equal(elapsedResetSignature(snapshot, 499), "");
  assert.equal(elapsedResetSignature(snapshot, 500), "codex-a:5시간");
});

test("the signature also changes when a retry time passes so the refresh button reopens", () => {
  const snapshot = {
    providers: [],
    accounts: [rateLimited(600)],
  };

  assert.equal(elapsedResetSignature(snapshot, 599), "");
  assert.equal(elapsedResetSignature(snapshot, 600), "codex-a:retryAt");
});

test("usageRefreshInterval은 실제로 사용량이 오를 수 있는 계정만 짧은 주기로 본다", () => {
  // 활성 계정은 새 채팅이 바로 붙으므로 런타임이 없어도 짧은 주기다.
  assert.equal(
    usageRefreshInterval(account({ isActive: true, runtimeCount: 0 })),
    BUSY_USAGE_REFRESH_INTERVAL_MS,
  );
  // 활성이 아니어도 자기 자격증명으로 돌고 있는 세션이 있으면 사용량이 오른다.
  assert.equal(
    usageRefreshInterval(account({ isActive: false, runtimeCount: 1 })),
    BUSY_USAGE_REFRESH_INTERVAL_MS,
  );
  // 아무것도 돌지 않는 계정의 사용량은 오를 수 없다. 리셋으로 내려갈 뿐이고,
  // 그건 usageResetElapsedSinceUpdate가 주기와 무관하게 잡는다.
  assert.equal(
    usageRefreshInterval(account({ isActive: false, runtimeCount: 0 })),
    IDLE_USAGE_REFRESH_INTERVAL_MS,
  );
  assert.ok(IDLE_USAGE_REFRESH_INTERVAL_MS > BUSY_USAGE_REFRESH_INTERVAL_MS);
});

test("usage level thresholds match the settings meters", () => {
  assert.equal(usageLevel(69.9), "normal");
  assert.equal(usageLevel(70), "warning");
  assert.equal(usageLevel(90), "critical");
});

test("remaining usage ignores model-scoped windows and is unknown without a governing one", () => {
  const windows = (list) => account({ usage: { status: "ok", windows: list, updatedAt: NOW, error: null } });
  assert.equal(remainingUsagePercent(windows([
    { label: "5시간", usedPercent: 30, resetsAt: null },
    { label: "Fable 7일", usedPercent: 100, resetsAt: null, modelScoped: true },
  ]), NOW), 70);
  // 대표할 창이 모델별 창뿐이면 여유를 알 수 없다 — 100%로 단정하면 안 된다.
  assert.equal(remainingUsagePercent(windows([
    { label: "Fable 7일", usedPercent: 10, resetsAt: null, modelScoped: true },
  ]), NOW), null);
  assert.equal(remainingUsagePercent(windows([]), NOW), null);
  assert.equal(remainingUsagePercent(null, NOW), null);
});

test("다음 초기화 시각은 아직 오지 않은 것 중 가장 이른 하나다", () => {
  const windows = [
    { label: "7일", usedPercent: 10, resetsAt: 3_000, resetElapsed: false, modelScoped: false },
    { label: "5시간", usedPercent: 10, resetsAt: 2_000, resetElapsed: false, modelScoped: false },
    // 이미 지난 시각과 시각을 모르는 창은 다음 초기화가 아니다.
    { label: "지남", usedPercent: 10, resetsAt: 900, resetElapsed: true, modelScoped: false },
    { label: "미상", usedPercent: 10, resetsAt: null, resetElapsed: false, modelScoped: false },
  ];

  assert.equal(nextUsageReset(windows, 1_000), 2_000);
  assert.equal(nextUsageReset(windows, 5_000), null);
  assert.equal(nextUsageReset([], 1_000), null);
});
