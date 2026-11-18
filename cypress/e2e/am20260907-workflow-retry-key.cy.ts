/// <reference types="cypress" />
// 실패한 워크플로 실행을 "같은 키로 재시도"하는 경로(src/components/WorkflowsView.tsx:369,
// src/lib/ipc.ts:1136)는 지금까지 화면 스펙이 없었다. 기존 워크플로 스펙 넷은 카탈로그·탭
// 전환·입력 기본값·빈 상태만 봤고, 실행 영수증이 돌아온 뒤의 계약 — 멱등 키를 첫 실행과
// 같게 유지하는가, 재시도 불가·성공 영수증에는 버튼을 감추는가, 계약을 갈아탄 뒤에도
// 재시도가 남는가 — 는 어디에서도 확인하지 않는다.
import { stubWorkflowCatalog, stubWorkflowDetailsById, workflowSummary } from "../support/workflowFixtures";

const TARGET = workflowSummary({
  description: "재시도 계약",
  displayName: "재시도 워크플로",
  id: "wf-retry",
});
const OTHER = workflowSummary({
  description: "다른 계약",
  displayName: "다른 워크플로",
  id: "wf-other",
});

/** `execute_system_workflow` 응답. 실패·재시도 가능 여부만 갈아 끼운다. */
function receipt(overrides: { succeeded?: boolean; retryable?: boolean } = {}) {
  const succeeded = overrides.succeeded ?? false;
  return {
    workflowId: TARGET.id,
    version: TARGET.version,
    executionId: "exec-1",
    startedAt: 1_757_000_000_000,
    finishedAt: 1_757_000_000_400,
    succeeded,
    failedStepId: succeeded ? null : "step-1",
    failure: succeeded ? null : "계정 목록을 읽지 못했습니다",
    retryable: overrides.retryable ?? !succeeded,
    steps: [{ stepId: "step-1", operation: "list_accounts", status: succeeded ? "succeeded" : "failed", iterations: 1, error: succeeded ? null : "연결 없음" }],
  };
}

/** 실행 요청 본문을 순서대로 모아 둘 배열을 세우고 응답을 고정한다. */
function stubExecute(sent: Record<string, unknown>[], body: unknown) {
  cy.stubInvoke("execute_system_workflow", (req) => {
    sent.push(req.body as Record<string, unknown>);
    req.reply(body);
  });
}

/** 실행 버튼을 누르고 확인 대화까지 승인한다. */
function runOnce(label: string) {
  cy.clickWorkflowAction(label);
  cy.get(".modal-backdrop .modal").should("be.visible");
  cy.get(".modal-backdrop .modal").contains("button", "실행").click();
  cy.get(".modal-backdrop").should("not.exist");
}

describe("실패한 워크플로 실행의 같은 키 재시도", () => {
  beforeEach(() => {
    stubWorkflowCatalog([TARGET, OTHER]);
    stubWorkflowDetailsById([TARGET, OTHER]);
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow("재시도 워크플로");
  });

  it("재시도 가능한 실패면 첫 실행과 같은 멱등 키로 다시 보낸다", () => {
    const sent: Record<string, unknown>[] = [];
    stubExecute(sent, receipt());

    runOnce("워크플로 실행");
    cy.get(".workflow-execution.failed").should("contain.text", "실행 실패").and("contain.text", "계정 목록을 읽지 못했습니다");

    runOnce("같은 키로 재시도");
    cy.wrap(null).should(() => {
      expect(sent).to.have.length(2);
      expect(sent[0].idempotencyKey, "첫 실행 키").to.be.a("string").and.not.be.empty;
      expect(sent[1].idempotencyKey, "재시도 키").to.equal(sent[0].idempotencyKey);
      expect(sent[1].expectedVersion).to.equal(TARGET.version);
    });
  });

  it("재시도 불가 실패와 성공 영수증에는 재시도 버튼이 없다", () => {
    stubExecute([], receipt({ retryable: false }));
    runOnce("워크플로 실행");
    // 영수증은 상세 화면 맨 아래라 창이 좁으면 접힌 자리에 온다. 단정은 화면을 옮기지 않으므로
    // 먼저 그 자리로 옮기고 본다 — 보이지 않는 것과 아직 스크롤하지 않은 것은 다르다.
    cy.get(".workflow-execution.failed").scrollIntoView().should("be.visible");
    cy.workflowAction("같은 키로 재시도").should("not.exist");

    // 같은 화면에서 성공 영수증으로 갈아 끼워도 버튼은 나오지 않는다.
    stubExecute([], receipt({ succeeded: true }));
    runOnce("워크플로 실행");
    cy.get(".workflow-execution.succeeded").should("contain.text", "실행 성공");
    cy.workflowAction("같은 키로 재시도").should("not.exist");
  });

  it("다른 계약을 골랐다 돌아오면 영수증과 재시도 버튼이 사라진다", () => {
    stubExecute([], receipt());
    runOnce("워크플로 실행");
    cy.workflowAction("같은 키로 재시도").should("be.visible");

    cy.selectWorkflow("다른 워크플로");
    cy.get(".workflow-execution").should("not.exist");

    cy.selectWorkflow("재시도 워크플로");
    cy.get(".workflow-execution").should("not.exist");
    cy.workflowAction("같은 키로 재시도").should("not.exist");
  });
});
