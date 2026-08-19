import assert from "node:assert/strict";
import test from "node:test";

import { accountUsageDisplayState, activeAccountId } from "./accountUsage.ts";

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

test("only the registry-active account matching the observed CLI account can refresh", () => {
  assert.equal(accountUsageDisplayState(account(), "codex-a").canRefresh, true);
  assert.equal(accountUsageDisplayState(account(), null).canRefresh, true);
  assert.equal(accountUsageDisplayState(account(), "codex-b").canRefresh, false);
  assert.equal(accountUsageDisplayState(account({ isActive: false }), "codex-a").canRefresh, false);
});

test("inactive accounts keep cached meters without exposing an old refresh error", () => {
  const state = accountUsageDisplayState(account({
    isActive: false,
    usage: {
      status: "error",
      windows: [{ label: "7일", usedPercent: 80, resetsAt: null }],
      updatedAt: 456,
      error: "inactive refresh deferred",
      retryAt: 789,
      rateLimited: false,
    },
  }), "codex-b");

  assert.equal(state.cached, true);
  assert.equal(state.error, null);
  assert.equal(state.canRefresh, false);
});

test("the shared CLI account takes precedence over the registry selection", () => {
  const snapshot = {
    accounts: [],
    providers: [{
      provider: "codex",
      activeAccountId: "codex-registry",
      observedActiveAccountId: "codex-cli",
    }],
  };

  assert.equal(activeAccountId(snapshot, "codex"), "codex-cli");
  snapshot.providers[0].observedActiveAccountId = null;
  assert.equal(activeAccountId(snapshot, "codex"), "codex-registry");
});
