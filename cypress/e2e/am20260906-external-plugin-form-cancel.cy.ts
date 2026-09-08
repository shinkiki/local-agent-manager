describe("외부 플러그인 폼", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.settings").click();
    cy.view("settings").should("exist");
    cy.anchor("settings.tab.plugins").click();
    cy.anchor("settings.plugins").click();
    cy.anchor("settings.external-plugins-content").should("be.visible");
  });

  it("플러그인 추가 폼에 값을 넣고 취소한 뒤 다시 열면 이전 입력값이 남지 않고 초기화된다", () => {
    // 폼 열기
    cy.anchor("settings.external-plugins-content").contains("button", "플러그인 추가").click();
    
    cy.get(".plugin-form").should("be.visible").within(() => {
      // 값 입력
      cy.contains("label", "식별자").parent().find("input").type("test-plugin");
      cy.contains("label", "표시 이름").parent().find("input").type("Test Plugin");
      cy.contains("label", "MCP 주소").parent().find("input").type("https://example.com");
      
      // 취소
      cy.contains("button", "취소").click();
    });

    // 폼이 닫힘을 확인
    cy.get(".plugin-form").should("not.exist");

    // 다시 폼 열기
    cy.anchor("settings.external-plugins-content").contains("button", "플러그인 추가").click();

    cy.get(".plugin-form").should("be.visible").within(() => {
      // 입력값이 모두 지워졌는지 확인 (초기값 확인)
      // 초기 프리셋이 Notion OAuth이므로 ID는 "notion"이어야 함 (우리가 입력했던 "test-plugin"이 아니어야 함)
      cy.contains("label", "식별자").parent().find("input").should("have.value", "notion");
      cy.contains("label", "표시 이름").parent().find("input").should("have.value", "Notion");
      cy.contains("label", "MCP 주소").parent().find("input").should("not.have.value", "https://example.com");
    });
  });
});
