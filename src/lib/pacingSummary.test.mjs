import assert from "node:assert/strict";
import test from "node:test";

import { accountLabel, consumerAccounts, consumerSummary, poolSummary } from "./pacingSummary.ts";

const DEFAULT_OVERVIEW = {
  inPool: true,
  usedPercent: 20,
  resetsAt: 1_000,
  targetPercent: 100,
  outstandingClaimPercent: 0,
  netHeadroomPercent: 80,
};

/**
 * overview는 기본값 위에 얹는다. 통째로 덮게 두면 한 칸만 바꾸는 시험이
 * `{ ...account(id).overview, ... }`로 계정을 한 벌 더 만들어 읽어야 한다.
 * 사용량을 못 읽은 계정은 overview 자체가 없는 상태라 명시적 null은 그대로 둔다.
 */
function account(id, { overview, ...overrides } = {}) {
  return {
    accountId: id,
    email: `${id}@example.com`,
    provider: "claude",
    displayName: id,
    disabled: false,
    pacingEnabled: true,
    targetPercent: null,
    guardPercent: null,
    windows: [],
    overview: overview === null ? null : { ...DEFAULT_OVERVIEW, ...overview },
    ...overrides,
  };
}

function consumer(overrides = {}) {
  return {
    scheduleId: "s1",
    name: "회차",
    workflowId: "wf",
    scheduleEnabled: true,
    scheduleExists: true,
    cadenceMinutes: 300,
    enabled: true,
    priority: 50,
    label: null,
    paced: true,
    workflowAccounts: [],
    maxTokensPerRun: null,
    maxCostPercentPerRun: null,
    enforceCeiling: false,
    costs: null,
    ...overrides,
  };
}

test("풀 요약은 참여 계정만 평균에 넣는다", () => {
  const summary = poolSummary([
    account("a", { overview: { usedPercent: 10, netHeadroomPercent: 90 } }),
    account("b", { overview: { usedPercent: 30, netHeadroomPercent: 70 } }),
    account("c", { pacingEnabled: false, overview: { usedPercent: 99, netHeadroomPercent: 1 } }),
  ]);
  assert.equal(summary.pooled, 2);
  assert.equal(summary.total, 3);
  assert.equal(summary.averageUsedPercent, 20);
  assert.equal(summary.averageHeadroomPercent, 80);
  assert.equal(summary.busiest.label, "b");
  assert.equal(summary.busiest.usedPercent, 30);
});

test("계정 이름은 표시 이름을 쓰고 비어 있을 때만 이메일로 떨어진다", () => {
  assert.equal(accountLabel(account("a", { displayName: "업무 계정" })), "업무 계정");
  assert.equal(accountLabel(account("a", { displayName: "" })), "a@example.com");
  assert.equal(accountLabel(account("a", { displayName: "", email: null })), "a");
});

test("사용량을 못 읽은 계정은 평균에서 빠지고 별도로 센다", () => {
  const summary = poolSummary([
    account("a", { overview: { usedPercent: 40 } }),
    account("b", { overview: { usedPercent: null } }),
    account("c", { overview: null }),
  ]);
  assert.equal(summary.averageUsedPercent, 40);
  assert.equal(summary.unmeasuredCount, 2);
});

test("참여 계정이 없으면 평균도 최다 소진 계정도 없다", () => {
  const summary = poolSummary([account("a", { pacingEnabled: false })]);
  assert.equal(summary.pooled, 0);
  assert.equal(summary.averageUsedPercent, null);
  assert.equal(summary.averageHeadroomPercent, null);
  assert.equal(summary.busiest, null);
  assert.equal(summary.earliestResetAt, null);
});

test("가장 이른 초기화 시각만 고르고 비어 있는 값은 무시한다", () => {
  const summary = poolSummary([
    account("a", { overview: { resetsAt: 5_000 } }),
    account("b", { overview: { resetsAt: 2_000 } }),
    account("c", { overview: { resetsAt: null } }),
  ]);
  assert.equal(summary.earliestResetAt, 2_000);
});

test("비활성 계정이 풀에 있으면 따로 센다", () => {
  const summary = poolSummary([account("a", { disabled: true }), account("b")]);
  assert.equal(summary.disabledCount, 1);
});

test("참여 계정이 비어 있으면 풀 전체가 대상이다", () => {
  const accounts = [account("a"), account("b", { pacingEnabled: false })];
  assert.deepEqual(consumerAccounts(consumer(), accounts).map((item) => item.accountId), ["a"]);
});

test("풀이 비어 있으면 전 계정이 후보다", () => {
  const accounts = [account("a", { pacingEnabled: false }), account("b", { pacingEnabled: false })];
  assert.deepEqual(consumerAccounts(consumer(), accounts).map((item) => item.accountId), ["a", "b"]);
});

test("워크플로별 참여 계정은 풀 안에서만 좁힌다", () => {
  const accounts = [account("a"), account("b"), account("c", { pacingEnabled: false })];
  const picked = consumerAccounts(consumer({ workflowAccounts: ["b", "c"] }), accounts);
  assert.deepEqual(picked.map((item) => item.accountId), ["b"]);
});

test("회차 요약은 참여 계정의 소진율 평균과 공급자별 회당 소비를 낸다", () => {
  const accounts = [
    account("a", { overview: { usedPercent: 10, netHeadroomPercent: 90 } }),
    account("b", { overview: { usedPercent: 30, netHeadroomPercent: 70 } }),
  ];
  const summary = consumerSummary(consumer({
    costs: {
      perProvider: { claude: { percentPerRun: 4, observationWeight: 1 } },
      recordedRuns: 8,
      savings: { claude: { observations: 8, baselineCostPercent: null, currentCostPercent: null, baselineTokens: 150_000, currentTokens: 120_000, achievedReductionPercent: 20, metric: "tokens", overCeiling: null } },
    },
  }), accounts);
  assert.equal(summary.accountCount, 2);
  assert.equal(summary.averageUsedPercent, 20);
  assert.deepEqual(summary.costs, [{ provider: "claude", tokens: 120_000, percentPerRun: 4 }]);
  // 순여유 160%p를 회당 4%p로 나눠 40회.
  assert.equal(summary.remainingRuns, 40);
});

test("남은 회차는 공급자별로 나눠 계산해 더한다", () => {
  const accounts = [
    account("a", { provider: "claude", overview: { netHeadroomPercent: 50 } }),
    account("b", { provider: "codex", overview: { netHeadroomPercent: 60 } }),
    account("c", { provider: "antigravity", overview: { netHeadroomPercent: 40 } }),
  ];
  const summary = consumerSummary(consumer({
    costs: {
      perProvider: {
        claude: { percentPerRun: 10, observationWeight: 1 },
        codex: { percentPerRun: 20, observationWeight: 1 },
        antigravity: { percentPerRun: 10, observationWeight: 1 },
      },
      recordedRuns: 4,
      savings: {},
    },
  }), accounts);
  // claude 50/10 = 5회, codex 60/20 = 3회, Antigravity 40/10 = 4회.
  assert.equal(summary.remainingRuns, 12);
});

test("실측 회당 소비가 없거나 0이면 남은 회차를 내지 않는다", () => {
  const accounts = [account("a")];
  assert.equal(consumerSummary(consumer(), accounts).remainingRuns, null);
  const zero = consumerSummary(consumer({
    costs: { perProvider: { claude: { percentPerRun: 0, observationWeight: 1 } }, recordedRuns: 1, savings: {} },
  }), accounts);
  assert.equal(zero.remainingRuns, null);
  assert.deepEqual(zero.costs, [{ provider: "claude", tokens: null, percentPerRun: 0 }]);
});
