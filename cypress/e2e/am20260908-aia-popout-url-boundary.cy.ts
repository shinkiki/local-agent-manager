/// <reference types="cypress" />

describe("AIA 독립 팝업 주소 경계", () => {
  it("유효하지 않은 창 ID는 독립창으로 열지 않고 일반 앱 셸로 안전하게 돌아간다", () => {
    const invalidSearches = [
      "?popout=aia",
      "?popout=aia&window=..%2F..%2Finvalid",
      `?popout=aia&window=${"a".repeat(81)}`,
    ];

    cy.wrap(invalidSearches).each((search) => {
      cy.visit(String(search));
      cy.get(".manager-shell")
        .should("not.have.class", "popout")
        .and("not.have.class", "aia-popout");
      cy.get(".app-sidebar").should("be.visible");
      cy.get(".topbar").should("be.visible");
      cy.anchor("topbar.aia").should("be.visible").and("have.attr", "aria-pressed", "false");
      cy.get(".aia-chat-popup.standalone").should("not.exist");
    });
    cy.screenshot("aia-invalid-popout-falls-back-main-shell");
  });
});
