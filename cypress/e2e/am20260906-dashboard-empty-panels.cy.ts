/// <reference types="cypress" />
// 대시보드가 완전히 빈 격리 하네스에서, 각 패널의 빈 상태 안내가 서로 구분되는지와
// 그 안내·카드가 가리킨 수단이 실제로 목적 화면에 데려가는지를 본다.
// '반복 일정 → 관리' 딥링크는 AM-77이 이미 다뤘으므로 여기서는 다시 보지 않는다.
// 기존 dashboard.cy.ts는 '계정 소진율' 패널의 빈 상태 잔존만 봤고, 나머지 네 패널의
// 안내와 도달 경로(반복 일정 → 관리, 공급자 카드 → CLI 연결 드로어)는 다루지 않았다.
describe("대시보드 빈 상태 패널 안내와 도달 경로", () => {
  const panel = (title: string) =>
    cy.view("dashboard").find(".dashboard-grid .panel").filter(`:contains("${title}")`).first();

  beforeEach(() => {
    cy.visitApp();
    cy.openView("dashboard");
  });

  it("네 패널이 각각 자기 빈 상태 안내를 낸다", () => {
    panel("최근 세션").find(".empty-state").should("contain.text", "세션이 없습니다");
    panel("반복 일정").find(".empty-state")
      .should("contain.text", "등록된 반복 일정이 없습니다")
      .and("contain.text", "관리를 눌러 첫 반복 요청을 만드세요.");
    panel("프로젝트 Top 10").find(".empty-state").should("contain.text", "프로젝트 기록이 없습니다");
    panel("모델 분포").find(".empty-state").should("contain.text", "모델 기록이 없습니다");
  });

  it("빈 상태여도 반복 일정 패널 머리말이 활성 0 / 전체 0을 알린다", () => {
    panel("반복 일정").find(".panel-heading p").first()
      .should("contain.text", "활성 0 / 전체 0");
  });

  it("공급자 카드를 누르면 그 공급자의 CLI 연결 드로어가 열리고 닫힌다", () => {
    cy.view("dashboard").find(".provider-status-action").first()
      .invoke("attr", "aria-label")
      .should("match", / CLI 연결 관리 열기$/);
    cy.view("dashboard").find(".provider-status-action").first().click();

    cy.get(".drawer").should("be.visible").within(() => {
      cy.contains("CLI 연결").should("be.visible");
      cy.get(".cli-connect-summary .health").should("exist");
    });

    cy.get("body").type("{esc}");
    cy.get(".cli-connect-summary").should("not.exist");
    cy.view("dashboard").should("be.visible");
  });

  it("주간 세션 추이는 기록이 없어도 12주 뼈대와 범례를 유지한다", () => {
    panel("주간 세션 추이").within(() => {
      cy.get(".legend").should("contain.text", "Claude").and("contain.text", "Codex");
      cy.get(".weekly-chart .week-column").should("have.length", 12);
      cy.get(".weekly-chart .bar-claude").should("not.exist");
    });
  });
});
