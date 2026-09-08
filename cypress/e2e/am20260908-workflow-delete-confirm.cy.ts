/// <reference types="cypress" />
// 워크플로 계약 삭제 경로(src/components/WorkflowsView.tsx:302,363)는 화면 스펙이 없다.
// 기존 워크플로 스펙들은 카탈로그·탭 전환·입력 기본값·실행 영수증만 봤고, 되돌릴 수 없는
// 삭제의 계약 — 확인창을 취소하면 요청 자체가 나가지 않는가, 승인하면 목록에서 빠지고
// 남은 계약이 이어 선택되는가, 마지막 계약을 지우면 빈 상태로 떨어지는가, 삭제가 실패하면
// 버튼 옆(상세 패널 안)에서 오류를 알리고 선택을 지키는가 — 는 확인된 적이 없다.
import { WORKFLOW_LIMITS, workflowDetail, workflowSummary } from "../support/workflowFixtures";

const FIRST = workflowSummary({
  description: "지울 계약",
  displayName: "삭제 대상 워크플로",
  id: "wf-doomed",
});
const SECOND = workflowSummary({
  description: "남을 계약",
  displayName: "남는 워크플로",
  id: "wf-keep",
});

/** 목록 응답을 배열 변수에 매달아, 삭제가 목록을 실제로 줄인 뒤 갱신되게 한다. */
function stubMutableCatalog(state: { workflows: typeof FIRST[] }) {
  cy.stubInvoke("get_system_workflows", (req) => {
    req.reply({ statusCode: 200, body: { limits: WORKFLOW_LIMITS, workflows: state.workflows } });
  });
  cy.stubInvoke("get_system_workflow", (req) => {
    const id = (req.body as { workflowId?: string }).workflowId;
    req.reply({ statusCode: 200, body: workflowDetail(state.workflows.find((item) => item.id === id) ?? FIRST) });
  });
}

/** 삭제 아이콘을 누르고 확인 대화에서 지정한 버튼까지 누른다. */
function clickDelete(answer: "삭제" | "취소") {
  cy.get(".workflow-detail-header .icon-button.danger").click();
  cy.get(".modal-backdrop .modal").should("contain.text", "삭제");
  cy.get(".modal-backdrop .modal").contains("button", answer).click();
  cy.get(".modal-backdrop").should("not.exist");
}

describe("워크플로 계약 삭제 확인창", () => {
  let state: { workflows: typeof FIRST[] };
  let deleted: string[];

  beforeEach(() => {
    state = { workflows: [FIRST, SECOND] };
    deleted = [];
    stubMutableCatalog(state);
    cy.visitApp();
    cy.openView("workflows");
    cy.contains(".workflow-card-main", "삭제 대상 워크플로").click();
    cy.get(".workflow-detail-header h2").should("contain.text", "삭제 대상 워크플로");
  });

  it("확인창을 취소하면 삭제 요청이 나가지 않고 목록과 선택이 그대로다", () => {
    cy.stubInvoke("delete_system_workflow", (req) => {
      deleted.push((req.body as { workflowId: string }).workflowId);
      req.reply({ statusCode: 200, body: {} });
    });

    clickDelete("취소");

    cy.get(".workflow-card").should("have.length", 2);
    cy.get(".workflow-card.selected .workflow-card-main").should("contain.text", "삭제 대상 워크플로");
    cy.get(".workflow-detail-header h2").should("contain.text", "삭제 대상 워크플로");
    cy.wrap(null).should(() => {
      expect(deleted, "취소했으므로 삭제 요청 없음").to.deep.equal([]);
    });
  });

  it("승인하면 그 계약만 지우고 남은 계약을 이어 선택하며, 마지막까지 지우면 빈 상태가 된다", () => {
    cy.stubInvoke("delete_system_workflow", (req) => {
      const id = (req.body as { workflowId: string }).workflowId;
      deleted.push(id);
      state.workflows = state.workflows.filter((item) => item.id !== id);
      req.reply({ statusCode: 200, body: {} });
    });

    clickDelete("삭제");

    cy.get(".workflow-card").should("have.length", 1);
    cy.contains(".workflow-card-main", "삭제 대상 워크플로").should("not.exist");
    // 지운 계약이 선택돼 있었으므로 목록 갱신이 남은 첫 계약을 이어받는다.
    cy.get(".workflow-detail-header h2").should("contain.text", "남는 워크플로");
    cy.get(".workflow-panel-heading em").should("have.text", "1");

    clickDelete("삭제");

    cy.get(".workflow-catalog-empty").should("contain.text", "아직 워크플로가 없습니다");
    cy.get(".workflow-card").should("not.exist");
    cy.get(".workflow-detail-header").should("not.exist");
    cy.wrap(null).should(() => {
      expect(deleted, "누른 순서대로 한 건씩만").to.deep.equal([FIRST.id, SECOND.id]);
    });
  });

  it("삭제가 실패하면 상세 패널 안에서 오류를 알리고 목록·선택을 지킨다", () => {
    cy.stubInvoke("delete_system_workflow", (req) => {
      deleted.push((req.body as { workflowId: string }).workflowId);
      req.reply({ statusCode: 500, body: { error: "워크플로 저장소를 쓸 수 없습니다" } });
    });

    clickDelete("삭제");

    cy.get(".workflow-action-error").should("be.visible").and("contain.text", "워크플로 저장소를 쓸 수 없습니다");
    cy.get(".workflow-card").should("have.length", 2);
    cy.get(".workflow-card.selected .workflow-card-main").should("contain.text", "삭제 대상 워크플로");
    cy.get(".workflow-detail-header h2").should("contain.text", "삭제 대상 워크플로");
    cy.wrap(null).should(() => {
      expect(deleted).to.deep.equal([FIRST.id]);
    });
  });
});
