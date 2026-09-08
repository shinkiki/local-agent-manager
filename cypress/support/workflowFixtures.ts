/// <reference types="cypress" />

// 워크플로 스펙 넷이 저마다 같은 계약 요약·상세·한도 리터럴을 통째로 적어 두고 있었다.
// 필드가 하나 늘 때마다 네 곳을 같이 고쳐야 했으므로, 기본 모양을 여기 한 벌만 두고
// 스펙은 달라지는 값만 덮어쓴다.

export type WorkflowInputSchemaFixture = Record<string, Record<string, unknown>>;

export interface WorkflowSummaryFixture {
  compatible: boolean;
  computedRisk: string;
  contractDigest: string;
  description: string;
  displayName: string;
  hardToRecoverEffects: string[];
  id: string;
  inputSchema: WorkflowInputSchemaFixture;
  lastExecution: null;
  pacingCapable: boolean;
  pacingEnabled: boolean;
  requiredOperations: string[];
  risk: string;
  version: number;
}

export interface WorkflowDetailFixture extends WorkflowSummaryFixture {
  contract: {
    description: string;
    displayName: string;
    id: string;
    inputSchema: WorkflowInputSchemaFixture;
    risk: string;
    steps: { id: string; operation: string }[];
    version: number;
  };
  versions: unknown[];
}

/** `get_system_workflows` 응답의 한도 블록. 스펙은 한도를 검증하지 않으므로 고정값이다. */
export const WORKFLOW_LIMITS = {
  allowedControl: ["순차 실행"],
  forbidden: ["임의 코드 평가"],
  maxForEachIterations: 100,
  maxSteps: 20,
  maxTotalOperationCalls: 200,
  maxWorkflows: 64,
};

const BASE_SUMMARY: WorkflowSummaryFixture = {
  compatible: true,
  computedRisk: "mutating",
  contractDigest: "abc123def4567890",
  description: "회귀 확인용 계약",
  displayName: "테스트 워크플로",
  hardToRecoverEffects: [],
  id: "wf-test",
  inputSchema: {},
  lastExecution: null,
  pacingCapable: false,
  pacingEnabled: false,
  requiredOperations: ["list_accounts"],
  risk: "mutating",
  version: 1,
};

/** 목록 응답에 들어가는 계약 요약. 달라지는 필드만 넘긴다. */
export function workflowSummary(overrides: Partial<WorkflowSummaryFixture> = {}): WorkflowSummaryFixture {
  return { ...BASE_SUMMARY, ...overrides };
}

// 상세는 요약에 계약 본문을 덧댄 모양이다. 단계는 따로 검증하지 않으므로 필요 조작에서 짓는다.
/** 요약과 짝이 맞는 `get_system_workflow` 응답. */
export function workflowDetail(summary: WorkflowSummaryFixture): WorkflowDetailFixture {
  return {
    ...summary,
    contract: {
      description: summary.description,
      displayName: summary.displayName,
      id: summary.id,
      inputSchema: summary.inputSchema,
      risk: summary.risk,
      steps: summary.requiredOperations.map((operation, index) => ({ id: `step-${index + 1}`, operation })),
      version: summary.version,
    },
    versions: [],
  };
}

/** 목록(그리고 상세를 주면 상세까지) 응답을 세운다. */
export function stubWorkflowCatalog(
  workflows: WorkflowSummaryFixture[],
  detail?: WorkflowDetailFixture,
): void {
  cy.stubInvoke("get_system_workflows", { limits: WORKFLOW_LIMITS, workflows });
  if (detail) {
    cy.stubInvoke("get_system_workflow", detail);
  }
}

// `get_usage_budget` 스냅샷은 계정 10필드·소비자 13필드·최상위 10필드가 맞아야 화면이 뜬다.
// 페이싱 스펙 셋이 그 세 덩어리를 통째로 적어 두어 계정 하나를 더 세우는 데만 11줄이 들었고,
// 백엔드가 필드를 하나 늘리면 세 곳을 같이 고쳐야 했다. 기본 모양을 여기 두고 스펙은
// 그 시험이 실제로 읽는 값만 덮어쓴다.

export interface PacingAccountOverviewFixture {
  inPool: boolean;
  usedPercent: number;
  resetsAt: string | null;
  targetPercent: number;
  outstandingClaimPercent: number;
  netHeadroomPercent: number;
}

export interface PacingAccountFixture {
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

export interface PacingConsumerFixture {
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

export interface UsageBudgetFixture {
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
