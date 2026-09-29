import assert from "node:assert/strict";
import test from "node:test";

import {
  canRunSystemAgent,
  harnessOf,
  hasUsageQuota,
  isProviderId,
  managesAccounts,
  PROVIDER_IDS,
} from "./providerIds.ts";

test("the provider list keeps the order the screens list them in", () => {
  assert.deepEqual([...PROVIDER_IDS], ["claude", "codex", "antigravity", "local"]);
});

test("only the canonical provider identifiers pass the guard", () => {
  for (const provider of PROVIDER_IDS) {
    assert.ok(isProviderId(provider), provider);
  }
  for (const value of ["", "Codex", "gpt", "local ", null, undefined, 3]) {
    assert.equal(isProviderId(value), false, JSON.stringify(value));
  }
});

/**
 * 능력 표는 공급자를 늘릴 때 한 칸만 고치고 나머지를 잊기 쉬운 자리다. 네 술어를 한 줄로
 * 세워, 새 공급자가 어느 칸을 물려받는지 이 테스트에서 먼저 결정하게 한다. 백엔드
 * `domain.rs`의 `provider_capability_table_is_pinned`와 같은 표여야 한다.
 */
test("the provider capability table is pinned and matches the backend", () => {
  const table = [
    // [공급자, 시스템 에이전트, 계정 관리, 사용량 한도, 하네스]
    ["claude", true, true, true, "claude"],
    ["codex", true, true, true, "codex"],
    ["antigravity", false, true, true, "antigravity"],
    ["local", false, false, false, "opencode"],
  ];
  assert.equal(table.length, PROVIDER_IDS.length);
  for (const [provider, systemAgent, accounts, usageQuota, harness] of table) {
    assert.ok(PROVIDER_IDS.includes(provider), provider);
    assert.equal(canRunSystemAgent(provider), systemAgent, provider);
    assert.equal(managesAccounts(provider), accounts, provider);
    assert.equal(hasUsageQuota(provider), usageQuota, provider);
    assert.equal(harnessOf(provider), harness, provider);
  }
});
