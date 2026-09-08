/**
 * 워크플로 관리 탭을 계약 0건 상태로 열었을 때의 빈 상태 계약.
 * 목록 자리(`.workflow-catalog-empty`)와 상세 자리(`.workflow-detail-empty`)는 서로 다른
 * 문구를 내고, 개요 통계는 0으로 떨어진다. 두 자리 모두 "AIA로 만들기"를 내미는데
 * 격리 백엔드처럼 AIA 런타임 공급자가 없는 상태에서는 App의 requestAiaPrompt가 조용히 반환하므로
 * 버튼이 그 사유를 실어 스스로 막혀야 한다(QA #29 — 눌러도 아무 반응이 없고 사유도 없었다).
 * 사유 문구는 상단바 `topbar.aia`가 공급자 없음에 쓰는 것과 같다.
 */
describe("워크플로 관리 탭 빈 계약 상태", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("workflows");
    cy.anchor("workflows.tab.catalog").should("have.class", "active");
  });

  it("목록·상세·개요가 각자의 빈 상태를 내고 화면을 다녀와도 그대로다", () => {
    cy.get(".workflow-catalog-empty")
      .should("contain.text", "아직 워크플로가 없습니다")
      .and("contain.text", "AIA에게 자동화할 작업을 설명해 보세요");
    // 목록 헤더의 개수 배지도 0이다.
    cy.get(".workflow-catalog .workflow-panel-heading em").should("have.text", "0");

    // 상세 자리는 "선택하세요"가 아니라 "만들어 보세요" — 고를 것이 없는 상태를 구분한다.
    cy.get(".workflow-detail-empty strong").should("have.text", "새 워크플로를 만들어 보세요");
    cy.get(".workflow-detail-empty p").should("contain.text", "AIA가 자동화할 작업을 확인하고");

    // 개요 통계 다섯 칸 중 앞 네 칸이 0이다.
    cy.get(".workflow-overview-stats.five > div").should("have.length", 5);
    cy.get(".workflow-overview-stats dd").eq(0).should("contain.text", "0");
    cy.get(".workflow-overview-stats dd").eq(1).should("have.text", "0개");
    cy.get(".workflow-overview-stats dd").eq(2).should("have.text", "0개");
    cy.get(".workflow-overview-stats dd").eq(3).should("have.text", "0개");

    // 다른 화면을 다녀와도 빈 상태가 그대로 복원된다(이전 데이터 잔존 없음).
    cy.revisitView("workflows");
    cy.anchor("workflows.tab.catalog").should("have.class", "active");
    cy.get(".workflow-catalog-empty").should("be.visible");
    cy.get(".workflow-detail-empty strong").should("have.text", "새 워크플로를 만들어 보세요");
  });

  it("AIA 공급자가 없으면 'AIA로 만들기'가 두 자리 모두 사유를 실은 채 막힌다", () => {
    const REASON = "시스템 에이전트가 설정되지 않았습니다. 설정에서 시스템 에이전트를 선택하세요.";
    // 상단바 AIA 버튼과 같은 사유 문구를 쓴다.
    cy.anchor("topbar.aia").should("have.attr", "title", REASON);

    // 개요 헤더와 빈 상태 안내가 같은 버튼을 둔다. 둘 다 막혀 있고 사유가 aria-label·title에 있다.
    cy.get(".workflow-overview-actions").contains("button", "AIA로 만들기")
      .should("be.visible")
      .and("be.disabled")
      .and("have.attr", "aria-disabled", "true")
      .and("have.attr", "title", REASON)
      .and("have.attr", "aria-label", REASON);
    // 상세 자리 버튼은 좁은 e2e 뷰포트에서 스크롤 영역에 잠기므로 존재와 상태만 본다.
    cy.get(".workflow-detail-empty").contains("button", "AIA로 만들기")
      .should("be.disabled")
      .and("have.attr", "aria-disabled", "true")
      .and("have.attr", "title", REASON);

    // 막힌 버튼을 억지로 눌러도 AIA 대화 자리는 열리지 않고 화면은 그대로다.
    cy.get(".workflow-detail-empty").contains("button", "AIA로 만들기").scrollIntoView().click({ force: true });
    cy.get(".manager-shell").should("not.have.class", "aia-open");
    cy.get(".error-banner, .workflow-input-problem, .modal-backdrop").should("not.exist");
    cy.view("workflows").should("exist");
  });
});
