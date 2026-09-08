import { stubWorkflowCatalog, workflowDetail, workflowSummary } from "../support/workflowFixtures";

// 워크플로 화면의 중메뉴(관리 ↔ 페이싱)를 오갈 때 관리 탭에서 채워 둔 실행 폼은 남아야
// 한다. 관리 패널은 탭 조건부 렌더라 탭을 옮기면 DOM에서는 내려가지만, 목록·선택·입력·실행
// 결과는 화면(WorkflowsView)의 `useWorkflowCatalog`가 들고 있어 되돌아오면 그대로 복원된다
// (QA #27 — 패널이 상태를 직접 들고 있어 페이싱 탭을 잠깐 들르면 인자가 경고 없이 사라졌다).
describe("워크플로 탭 전환 후 실행 폼 잔존", () => {
  const INPUT_SCHEMA = {
    emailPrefix: { description: "이 문자열로 시작하는 계정만", label: "대상 계정 접두사", required: true, type: "string", values: null },
    maxRuns: { description: "한 회차 최대 건수", label: "회차 상한", required: true, type: "number", values: null },
  };
  const SUMMARY = workflowSummary({ description: "탭 전환 잔존 확인용 계약", inputSchema: INPUT_SCHEMA });

  beforeEach(() => {
    stubWorkflowCatalog([SUMMARY], workflowDetail(SUMMARY));
    cy.visitApp();
    cy.openView("workflows");
  });

  it("페이싱 탭에 갔다 돌아와도 채워 둔 실행 입력이 그대로 남는다", () => {
    cy.get(".workflow-inputs input").eq(0).type("tester-");
    cy.get(".workflow-inputs input").eq(1).type("7");
    cy.get(".workflow-inputs input").eq(0).should("have.value", "tester-");

    cy.anchor("workflows.tab.recurring").click();
    cy.anchor("workflows.tab.recurring").should("have.class", "active");
    cy.get(".workflow-inputs").should("not.exist");

    cy.anchor("workflows.tab.catalog").click();
    cy.anchor("workflows.tab.catalog").should("have.class", "active");
    // 패널은 다시 마운트되지만 상태는 화면이 들고 있어 입력이 그대로다.
    cy.get(".workflow-inputs input").eq(0).should("have.value", "tester-");
    cy.get(".workflow-inputs input").eq(1).should("have.value", "7");
    // 선택도 유지된다.
    cy.get(".workflow-card.selected .workflow-card-main").should("contain.text", "테스트 워크플로");
  });

  it("돌아온 뒤에도 실행 폼은 정상 동작해 필수 입력 안내와 확인 대화상자를 낸다", () => {
    cy.anchor("workflows.tab.recurring").click();
    cy.anchor("workflows.tab.catalog").click();

    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".workflow-input-problem").should("be.visible").and("contain.text", "대상 계정 접두사");

    cy.get(".workflow-inputs input").eq(0).type("tester-");
    cy.get(".workflow-inputs input").eq(1).type("1");
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".modal-backdrop .modal").should("be.visible").and("contain.text", "테스트 워크플로 실행");
  });
});
