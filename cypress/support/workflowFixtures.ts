/// <reference types="cypress" />

// 워크플로 스펙 넷이 저마다 같은 계약 요약·상세·한도 리터럴을 통째로 적어 두고 있었다.
// 필드가 하나 늘 때마다 네 곳을 같이 고쳐야 했으므로, 기본 모양을 여기 한 벌만 두고
// 스펙은 달라지는 값만 덮어쓴다. 응답의 모양을 적는 타입은 이 모듈 안에서만 쓰이므로 내보내지
// 않는다 — 밖에서 보이는 것은 세우기 함수와 한도 상수뿐이다.

type WorkflowInputSchemaFixture = Record<string, Record<string, unknown>>;

interface WorkflowSummaryFixture {
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

interface WorkflowDetailFixture extends WorkflowSummaryFixture {
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

// 계약을 갈아타는 스펙은 상세가 고른 계약을 따라야 해서 "요청 본문의 workflowId로 갈라
// 응답한다"를 저마다 손으로 적어 두고 있었다(기본값 프리필·재시도 키 스펙이 글자 그대로
// 같았다). 요약 목록만 받아 그 짝을 세우는 한 벌로 둔다.
/** 여러 요약의 상세를 요청 본문의 `workflowId`로 갈라 응답한다. 모르는 id는 첫 요약을 준다. */
export function stubWorkflowDetailsById(workflows: WorkflowSummaryFixture[]): void {
  cy.stubInvoke("get_system_workflow", (req) => {
    const id = (req.body as { workflowId?: string }).workflowId;
    const summary = workflows.find((workflow) => workflow.id === id) ?? workflows[0];
    req.reply(workflowDetail(summary));
  });
}
