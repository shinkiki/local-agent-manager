import assert from "node:assert/strict";
import test from "node:test";

import { accountLabel, consumerSummary, PACING_PROVIDER_IDS, poolSummary } from "./pacingSummary.ts";

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

/**
 * 한 공급자의 절감 관측 한 줄. 요약이 읽는 칸은 `currentTokens` 하나뿐인데 백엔드 응답은
 * 여덟 칸을 함께 싣는다. 나머지 일곱을 시험이 손으로 적으면 어느 칸이 결과를 가르는지가
 * 문장에서 사라지고, 응답에 칸이 하나 더 늘 때 고칠 자리가 시험마다 따로 생긴다.
 */
function savings(currentTokens) {
  return {
    observations: 1,
    baselineCostPercent: null,
    currentCostPercent: null,
    baselineTokens: null,
    currentTokens,
    achievedReductionPercent: null,
    metric: "tokens",
    overCeiling: null,
  };
}

/**
 * 회당 소비 관측 봉투. 공급자별 실측(%p)과, 있으면 그 공급자의 최근 토큰만 적는다.
 *
 * 네 시험이 `perProvider`·`recordedRuns`·`savings` 세 칸을 각자 다시 조립하고 있었는데,
 * 그중 요약이 실제로 보는 것은 `percentPerRun`과 `currentTokens` 둘뿐이라 나머지는 어느
 * 시험에서도 결과를 바꾸지 않는 채움말이었다. 봉투 모양을 한 자리에 두면 시험의 본문이
 * "이 공급자는 회당 몇 %p인가"만 말하게 되고, 봉투가 달라질 때 고칠 자리도 하나다.
 */
function costs(percentPerRun, currentTokens = {}) {
  return {
    perProvider: Object.fromEntries(
      Object.entries(percentPerRun).map(([provider, percent]) => [provider, { percentPerRun: percent, observationWeight: 1 }]),
    ),
    recordedRuns: 1,
    savings: Object.fromEntries(
      Object.entries(currentTokens).map(([provider, tokens]) => [provider, savings(tokens)]),
    ),
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

test("순여유 평균도 소진율 평균과 같은 계정만 본다 — 못 읽은 계정을 0으로 섞지 않는다", () => {
  // QA #57. 잰 계정 60%/40%p·비활성 20%/80%p·못 읽은 계정 하나. 소진율 평균은 못 읽은
  // 계정을 빼고 (60+20)/2인데 순여유는 (40+80+0)/3으로 셈해 한 카드 안에서 기준이 갈렸다.
  const summary = poolSummary([
    account("measured", { overview: { usedPercent: 60, netHeadroomPercent: 40 } }),
    account("disabled", { disabled: true, overview: { usedPercent: 20, netHeadroomPercent: 80 } }),
    account("unmeasured", { overview: null }),
    account("excluded", { pacingEnabled: false, overview: { usedPercent: 90, netHeadroomPercent: 10 } }),
  ]);
  assert.equal(summary.averageUsedPercent, 40);
  assert.equal(summary.averageHeadroomPercent, 60);
  assert.equal(summary.unmeasuredCount, 1);
  assert.equal(summary.disabledCount, 1);
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
  ], 1_000);
  assert.equal(summary.earliestResetAt, 2_000);
});

// QA #75. 이미 지나간 창 초기화 시각은 후보가 아니다 — 고르면 카드가 '1시간 전'을 낸다.
test("이미 지난 초기화 시각은 건너뛰고 앞으로 올 시각만 고른다", () => {
  const summary = poolSummary([
    account("a", { overview: { resetsAt: 2_000 } }),
    account("b", { overview: { resetsAt: 9_000 } }),
  ], 5_000);
  assert.equal(summary.earliestResetAt, 9_000);
});

test("초기화 시각이 모두 지났으면 가장 이른 초기화가 없다", () => {
  const summary = poolSummary([
    account("a", { overview: { resetsAt: 2_000 } }),
    account("b", { overview: { resetsAt: 3_000 } }),
  ], 5_000);
  assert.equal(summary.earliestResetAt, null);
});

test("비활성 계정이 풀에 있으면 따로 센다", () => {
  const summary = poolSummary([account("a", { disabled: true }), account("b")]);
  assert.equal(summary.disabledCount, 1);
});

// 회차 대상 계정을 고르는 규칙은 요약의 계정 수와 소진율 평균으로 짚는다. 계정마다 다른
// 소진율을 주면 평균이 어느 계정이 들어왔는지까지 가리므로, 고른 목록을 따로 내보내지 않아도
// 셋(제한 없음·풀이 빔·워크플로별 제한)이 서로 구분된다.
test("참여 계정이 비어 있으면 풀 전체가 대상이다", () => {
  const accounts = [
    account("a", { overview: { usedPercent: 10 } }),
    account("b", { pacingEnabled: false, overview: { usedPercent: 90 } }),
  ];
  const summary = consumerSummary(consumer(), accounts);
  assert.equal(summary.accountCount, 1);
  assert.equal(summary.averageUsedPercent, 10);
});

test("풀이 비어 있으면 전 계정이 후보다", () => {
  const accounts = [
    account("a", { pacingEnabled: false, overview: { usedPercent: 10 } }),
    account("b", { pacingEnabled: false, overview: { usedPercent: 30 } }),
  ];
  const summary = consumerSummary(consumer(), accounts);
  assert.equal(summary.accountCount, 2);
  assert.equal(summary.averageUsedPercent, 20);
});

test("워크플로별 참여 계정은 풀 안에서만 좁힌다", () => {
  const accounts = [
    account("a", { overview: { usedPercent: 10 } }),
    account("b", { overview: { usedPercent: 30 } }),
    account("c", { pacingEnabled: false, overview: { usedPercent: 90 } }),
  ];
  const summary = consumerSummary(consumer({ workflowAccounts: ["b", "c"] }), accounts);
  assert.equal(summary.accountCount, 1);
  assert.equal(summary.averageUsedPercent, 30);
});

test("회차 요약은 참여 계정의 소진율 평균과 공급자별 회당 소비를 낸다", () => {
  const accounts = [
    account("a", { overview: { usedPercent: 10, netHeadroomPercent: 90 } }),
    account("b", { overview: { usedPercent: 30, netHeadroomPercent: 70 } }),
  ];
  const summary = consumerSummary(consumer({ costs: costs({ claude: 4 }, { claude: 120_000 }) }), accounts);
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
  const summary = consumerSummary(
    consumer({ costs: costs({ claude: 10, codex: 20, antigravity: 10 }) }),
    accounts,
  );
  // claude 50/10 = 5회, codex 60/20 = 3회, Antigravity 40/10 = 4회.
  assert.equal(summary.remainingRuns, 12);
});

test("실측 회당 소비가 없거나 0이면 남은 회차를 내지 않는다", () => {
  const accounts = [account("a")];
  assert.equal(consumerSummary(consumer(), accounts).remainingRuns, null);
  const zero = consumerSummary(consumer({ costs: costs({ claude: 0 }) }), accounts);
  assert.equal(zero.remainingRuns, null);
  assert.deepEqual(zero.costs, [{ provider: "claude", tokens: null, percentPerRun: 0 }]);
});

/**
 * 사용량 한도가 없는 공급자는 창도 리셋도 없어 소진율을 잴 수 없다. 목록에 남으면 0%로
 * 읽혀 "여유가 가장 많은 계정"으로 뽑히고, 레인 폴백에서는 고를 수도 없는 칸이 생긴다.
 */
test("페이싱은 사용량 한도가 있는 공급자만 다룬다", () => {
  assert.deepEqual([...PACING_PROVIDER_IDS], ["claude", "codex", "antigravity"]);
  assert.equal(PACING_PROVIDER_IDS.includes("local"), false);
});

