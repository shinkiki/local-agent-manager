/// <reference types="cypress" />

// `get_usage_budget` 스냅샷은 계정 10필드·소비자 13필드·최상위 10필드가 맞아야 화면이 뜬다.
// 페이싱 스펙 셋이 그 세 덩어리를 통째로 적어 두어 계정 하나를 더 세우는 데만 11줄이 들었고,
// 백엔드가 필드를 하나 늘리면 세 곳을 같이 고쳐야 했다. 기본 모양을 여기 두고 스펙은
// 그 시험이 실제로 읽는 값만 덮어쓴다. 응답의 모양을 적는 타입은 이 모듈 안에서만 쓰이므로
// 내보내지 않는다 — 밖에서 보이는 것은 세우기 함수뿐이다.

interface PacingAccountOverviewFixture {
  inPool: boolean;
  usedPercent: number;
  // 백엔드가 담는 값은 epoch ms다(src/types.ts:2459). 창 초기화 카운트다운을 보는 스펙이
  // 숫자를 넘기므로 화면 타입과 같게 둔다.
  resetsAt: number | null;
  targetPercent: number;
  outstandingClaimPercent: number;
  netHeadroomPercent: number;
}

interface PacingAccountFixture {
  accountId: string;
  email: string;
  provider: string;
  displayName: string;
  disabled: boolean;
  pacingEnabled: boolean;
  targetPercent: number | null;
  guardPercent: number | null;
  windows: unknown[];
  overview: PacingAccountOverviewFixture | null;
}

interface PacingConsumerFixture {
  scheduleId: string;
  name: string;
  workflowId: string;
  scheduleEnabled: boolean | null;
  scheduleExists: boolean;
  cadenceMinutes: number | null;
  enabled: boolean;
  priority: number;
  label: string;
  paced: boolean;
  workflowAccounts: unknown[];
  enforceCeiling: boolean;
  costs: Record<string, unknown>;
  [extra: string]: unknown;
}

interface UsageBudgetFixture {
  defaults: { windowLabel: string; targetPercent: number; guardWindowLabel: string; guardPercent: number };
  savings: { targetReductionPercent: number; baselineRuns: number };
  selectionConfigured: boolean;
  poolConfigured: boolean;
  windowLabel: string;
  cadenceMinutes: number;
  activeConsumers: string[];
  accounts: PacingAccountFixture[];
  pacingWorkflowIds: string[];
  consumers: PacingConsumerFixture[];
}

// 계정은 대개 "풀 밖에 있어 개요가 없는 계정"이라 overview는 기본이 null이다. 소진율 막대를
// 보는 시험만 pacingAccountOverview로 개요를 붙인다.
/** 계정 풀 항목. 표시 이름을 따로 주지 않으면 이메일을 그대로 쓴다(화면과 같은 규칙). */
export function pacingAccount(
  overrides: Partial<PacingAccountFixture> & Pick<PacingAccountFixture, "accountId" | "email" | "provider">,
): PacingAccountFixture {
  return {
    displayName: overrides.email,
    disabled: false,
    pacingEnabled: false,
    targetPercent: null,
    guardPercent: null,
    windows: [],
    overview: null,
    ...overrides,
  };
}

/** 풀에 든 계정의 사용량 개요. 남은 여유는 목표에서 사용률을 뺀 값이다. */
export function pacingAccountOverview(
  overrides: Partial<PacingAccountOverviewFixture> & Pick<PacingAccountOverviewFixture, "usedPercent" | "targetPercent">,
): PacingAccountOverviewFixture {
  return {
    inPool: true,
    resetsAt: null,
    outstandingClaimPercent: 0,
    netHeadroomPercent: overrides.targetPercent - overrides.usedPercent,
    ...overrides,
  };
}

/** 예산 소비자(= 페이싱 회차) 항목. 이름을 주면 라벨도 같은 값으로 선다. */
export function pacingConsumer(
  overrides: Partial<PacingConsumerFixture> & Pick<PacingConsumerFixture, "scheduleId" | "name" | "workflowId">,
): PacingConsumerFixture {
  return {
    scheduleEnabled: true,
    scheduleExists: true,
    cadenceMinutes: 300,
    enabled: true,
    priority: 50,
    label: overrides.name,
    paced: true,
    workflowAccounts: [],
    enforceCeiling: false,
    costs: { perProvider: {}, recordedRuns: 0, savings: {} },
    ...overrides,
  };
}

/** `get_usage_budget` 응답 전체. 계정·소비자·페이싱 대상은 시험이 필요한 만큼만 넘긴다. */
export function usageBudget(overrides: Partial<UsageBudgetFixture> = {}): UsageBudgetFixture {
  return {
    defaults: { windowLabel: "7일", targetPercent: 95, guardWindowLabel: "5시간", guardPercent: 90 },
    savings: { targetReductionPercent: 20, baselineRuns: 5 },
    selectionConfigured: true,
    poolConfigured: true,
    windowLabel: "7일",
    cadenceMinutes: 300,
    activeConsumers: [],
    accounts: [],
    pacingWorkflowIds: [],
    consumers: [],
    ...overrides,
  };
}
