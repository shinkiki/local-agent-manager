/// <reference types="cypress" />
// 워크플로 계약 삭제 확인창의 취소·승인·실패 갈래는 am20260908-workflow-delete-confirm이
// 본다. 여기서 보는 것은 그 확인창의 **언어**다. 삭제 확인창의 제목·세 줄 경고·확인 라벨은
// 정적 UI 치환기의 사전에 없는 문장이라 text(ko, en)로 영어를 함께 선언해야 한다(QA #55 —
// 버튼만 영어로 바뀌고 "복구할 수 없다"는 경고가 한국어로 남았다). 되돌릴 수 없는 조작의
// 경고라서 다른 한국어 잔존 결함과 무게가 다르다.
import { WORKFLOW_LIMITS, workflowDetail, workflowSummary } from "../support/workflowFixtures";

const TARGET = workflowSummary({
  description: "삭제 대상 계약",
  displayName: "삭제 대상 워크플로",
  id: "wf-doomed",
});

describe("영어 UI에서 워크플로 삭제 확인창의 언어", () => {
  beforeEach(() => {
    cy.stubInvoke("get_system_workflows", { limits: WORKFLOW_LIMITS, workflows: [TARGET] });
    cy.stubInvoke("get_system_workflow", workflowDetail(TARGET));
    cy.visitApp();
  });

  afterEach(() => {
    // UI 언어는 백엔드 설정에 남아 뒤에 오는 스펙까지 영어로 만든다. 반드시 되돌린다.
    cy.restoreLanguage();
  });

  it("버튼·제목·세 줄 경고가 모두 영어로 뜬다", () => {
    cy.setLanguage("en");
    cy.openView("workflows");
    cy.contains(".workflow-card-main", "삭제 대상 워크플로").click();
    // 삭제 버튼의 aria-label도 번역되므로 언어를 타지 않는 클래스로 잡는다.
    cy.get(".workflow-detail-header .icon-button.danger")
      .should("have.attr", "aria-label", "Delete workflow")
      .click();

    const modal = () => cy.get(".modal-backdrop .modal");
    modal().should("be.visible");

    modal().contains("button", "Cancel").should("exist");
    modal().contains("button", "Delete").should("exist");

    // 제목은 계약 표시 이름(사용자 데이터)만 한국어로 남고 동사는 영어다.
    modal().should("contain.text", "Delete 삭제 대상 워크플로");
    modal().should("contain.text", "Removes the registered workflow and its execution permission.");
    modal().should("contain.text", "The audit trail is kept, but the contract and its version history cannot be recovered.");
    modal().should("contain.text", "To use it again, AIA must register it anew through an approval summary.");

    // 한국어 경고 문장은 남지 않는다.
    modal().should("not.contain.text", "복구할 수 없습니다");
    modal().should("not.contain.text", "제거합니다");
  });
});
