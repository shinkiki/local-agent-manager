describe("대시보드 계정 소진율", () => {
  it("등록 계정이 없으면 안내를 표시하고 화면 전환·새로고침 뒤에도 빈 상태를 유지한다", () => {
    cy.visitApp();

    cy.anchor("dashboard.account-usage").should("be.visible").within(() => {
      cy.contains("h2", "계정 소진율").should("be.visible");
      cy.contains("등록된 계정이 없습니다").should("be.visible");
      cy.contains("계정 관리에서 Claude·Codex 계정을 추가하면 소진율이 여기에 나타납니다.").should("be.visible");
      cy.get(".account-usage-legend").should("not.exist");
      cy.get(".account-usage-figure").should("not.exist");
    });

    cy.anchor("nav.sessions").click();
    cy.anchor("nav.dashboard").click();
    cy.anchor("dashboard.account-usage").should("contain.text", "등록된 계정이 없습니다");

    cy.reload();
    cy.anchor("dashboard.account-usage")
      .should("be.visible")
      .and("contain.text", "등록된 계정이 없습니다");
    cy.screenshot("dashboard-account-usage-empty-state");
  });
});
