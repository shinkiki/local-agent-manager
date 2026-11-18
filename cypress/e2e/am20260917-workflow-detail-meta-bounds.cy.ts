/// <reference types="cypress" />
import { WORKFLOW_LIMITS, workflowDetail, workflowSummary } from "../support/workflowFixtures";

// 워크플로 관리 → 계약 상세의 메타 네 칸(버전·단계·시스템 작업·계약 지문) 표기 경계.
//
// 지문은 화면에서 앞 12자만 보이고 전문은 title에 남아야 하며(`src/components/WorkflowsView.tsx:571`),
// 계약 본문·지문·버전이 비어 있는 계약에서도 칸이 사라지지 않고 대체 표기(`v?`·`0개`·`0종`·`없음`)로
// 서야 한다. 버전을 모르는 계약은 실행 버튼도 막혀야 한다(같은 파일 `:563`).
describe("워크플로 상세 메타 네 칸의 경계 표기", () => {
  const LONG_DIGEST = "0123456789abcdef".repeat(4); // 64자

  function meta(label: string) {
    return cy.get(".workflow-detail-meta").contains("dt", label).parent().find("dd");
  }

  it("지문이 길면 앞 12자만 보이고 전문은 title에 남으며, 단계·작업 수를 계약대로 센다", () => {
    const summary = workflowSummary({
      contractDigest: LONG_DIGEST,
      description: "메타 표기 확인용 계약",
      displayName: "메타 정상 워크플로",
      id: "wf-meta-full",
      requiredOperations: ["list_accounts", "get_usage_snapshot", "list_skills"],
      version: 2,
    });
    cy.stubInvoke("get_system_workflows", { limits: WORKFLOW_LIMITS, workflows: [summary] });
    cy.stubInvoke("get_system_workflow", workflowDetail(summary));
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow("메타 정상 워크플로");

    cy.get(".workflow-detail-meta").should("be.visible");
    meta("버전").should("have.text", "v2");
    meta("단계").should("have.text", "3개");
    meta("시스템 작업").should("have.text", "3종");
    meta("계약 지문")
      .should("have.text", `${LONG_DIGEST.slice(0, 12)}…`)
      .and("have.attr", "title", LONG_DIGEST);

    // 지문 전문이 화면 글자로 새어 나오지 않는다(잘림이 표시에만 적용된다).
    cy.get(".workflow-detail-meta").should("not.contain.text", LONG_DIGEST);
  });

  it("계약 본문·지문·버전이 비어 있어도 칸은 대체 표기로 서고 실행 버튼은 막힌다", () => {
    const summary = workflowSummary({
      contractDigest: null as unknown as string,
      description: "메타 빈값 확인용 계약",
      displayName: "메타 빈값 워크플로",
      id: "wf-meta-empty",
      requiredOperations: [],
      version: null as unknown as number,
    });
    cy.stubInvoke("get_system_workflows", { limits: WORKFLOW_LIMITS, workflows: [summary] });
    cy.stubInvoke("get_system_workflow", { ...summary, contract: null, versions: [] });
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow("메타 빈값 워크플로");

    cy.get(".workflow-detail-meta").should("be.visible");
    meta("버전").should("have.text", "v?");
    meta("단계").should("have.text", "0개");
    meta("시스템 작업").should("have.text", "0종");
    meta("계약 지문").should("have.text", "없음").and("not.have.attr", "title");

    cy.workflowAction("워크플로 실행").should("be.disabled");
  });
});
