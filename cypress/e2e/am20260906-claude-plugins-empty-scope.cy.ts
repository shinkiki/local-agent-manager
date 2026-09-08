describe("애드온 클로드 플러그인 카드", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("addons").should("be.visible");
    cy.openAddonsTab("claude");
  });

  it("플러그인이 없는 환경에서 빈 상태와 전역 범위 안내를 보여준다", () => {
    cy.anchor("addons.claude-plugins-content").should("be.visible").within(() => {
      // 확인이 끝나기 전에는 로딩 안내가 자리를 잡고, 끝나면 빈 상태로 바뀐다.
      cy.contains("설치된 플러그인이 없습니다", { timeout: 20000 }).should("be.visible");
      cy.get(".plugin-loading-state").should("not.exist");
      cy.get(".plugin-list").should("not.exist");

      // 프로젝트가 등록되지 않은 격리 환경에서는 범위 선택에 전역만 있다.
      cy.get(".claude-plugin-scopebar select")
        .should("have.value", "")
        .find("option").should("have.length", 1).and("have.text", "전역");
      cy.get(".claude-plugin-scopebar small").should("contain.text", "사용자 전역 settings.json");
    });
  });

  it("코덱스 탭을 다녀와도 빈 상태와 범위 선택이 그대로 남는다", () => {
    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.contains("설치된 플러그인이 없습니다", { timeout: 20000 }).should("be.visible");
    });

    cy.openAddonsTab("codex");

    cy.openAddonsTab("claude").within(() => {
      cy.contains("설치된 플러그인이 없습니다").should("be.visible");
      cy.get(".claude-plugin-scopebar select").should("have.value", "");
      cy.get(".error-banner").should("not.exist");
    });
  });
});
