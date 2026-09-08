import { stubWorkflowCatalog, workflowDetail, workflowSummary } from "../support/workflowFixtures";

// 계약이 선언한 기본값(defaultValue)을 실행 폼에 미리 채우는 경로
// (src/components/WorkflowsView.tsx:179, src/lib/scheduleWorkflow.ts:130)는 지금까지 화면
// 스펙이 없었다. 단위 시험은 workflowInputDefaults의 반환값만 보고, 탭 전환 스펙은
// 기본값 없는 계약만 쓴다. 여기서 확인하는 것은 화면 계약 셋이다 — 기본값이 실제 입력칸에
// 들어가는가, 안내 문구가 그 개수를 말하는가, 그리고 다른 계약을 고른 뒤 돌아왔을 때
// 손으로 지운 값이 기본값으로 되돌아오는가(상세를 다시 읽으므로 되돌아와야 한다).
describe("워크플로 실행 입력 기본값 프리필", () => {
  const WITH_DEFAULTS = workflowSummary({
    description: "기본값을 선언한 계약",
    displayName: "기본값 계약",
    id: "wf-defaults",
    inputSchema: {
      // 기본값이 있는 필수 입력. 손대지 않고 실행해도 필수 안내가 뜨면 안 된다.
      branch: { defaultValue: "dev-history", description: null, label: "대상 브랜치", required: true, type: "string", values: null },
      maxRuns: { defaultValue: 3, description: null, label: "회차 상한", required: false, type: "number", values: null },
      // 기본값이 없는 필수 입력. 이 칸만 실행을 막아야 한다.
      note: { defaultValue: null, description: null, label: "메모", required: true, type: "string", values: null },
    },
  });
  const WITHOUT_DEFAULTS = workflowSummary({
    description: "기본값이 없는 계약",
    displayName: "빈 계약",
    id: "wf-plain",
    inputSchema: {
      target: { defaultValue: null, description: null, label: "대상", required: true, type: "string", values: null },
    },
  });

  beforeEach(() => {
    stubWorkflowCatalog([WITH_DEFAULTS, WITHOUT_DEFAULTS]);
    // 상세는 고른 계약에 따라 달라야 하므로 요청 본문의 workflowId로 갈라 준다.
    cy.stubInvoke("get_system_workflow", (req) => {
      const id = (req.body as { workflowId?: string }).workflowId;
      req.reply(workflowDetail(id === WITHOUT_DEFAULTS.id ? WITHOUT_DEFAULTS : WITH_DEFAULTS));
    });
    cy.visitApp();
    cy.openView("workflows");
  });

  it("기본값이 있는 입력만 미리 채우고 안내에 그 개수를 적는다", () => {
    cy.get(".workflow-inputs input").should("have.length", 3);
    cy.get(".workflow-inputs input").eq(0).should("have.value", "dev-history");
    cy.get(".workflow-inputs input").eq(1).should("have.value", "3");
    cy.get(".workflow-inputs input").eq(2).should("have.value", "");
    cy.get(".workflow-run-section header small")
      .should("contain.text", "3개 값을 확인한 뒤 실행합니다.")
      .and("contain.text", "기본값 2개를 미리 채웠습니다");
  });

  it("기본값이 채운 필수 입력은 실행을 막지 않고 빈 필수 입력만 짚는다", () => {
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".workflow-input-problem")
      .should("be.visible")
      .and("contain.text", "필수 입력 1개")
      .and("contain.text", "메모")
      .and("not.contain.text", "대상 브랜치");

    cy.get(".workflow-inputs input").eq(2).type("확인");
    cy.get(".workflow-input-problem").should("not.exist");
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".modal-backdrop .modal").should("be.visible").and("contain.text", "기본값 계약 실행");
  });

  it("다른 계약을 골랐다 돌아오면 지운 기본값이 다시 채워진다", () => {
    cy.get(".workflow-inputs input").eq(0).clear().type("main");
    cy.get(".workflow-inputs input").eq(0).should("have.value", "main");

    cy.contains(".workflow-card-main", "빈 계약").click();
    cy.get(".workflow-inputs input").should("have.length", 1).and("have.value", "");
    cy.get(".workflow-run-section header small").should("not.contain.text", "기본값");

    cy.contains(".workflow-card-main", "기본값 계약").click();
    cy.get(".workflow-inputs input").eq(0).should("have.value", "dev-history");
    cy.get(".workflow-inputs input").eq(1).should("have.value", "3");
  });
});
