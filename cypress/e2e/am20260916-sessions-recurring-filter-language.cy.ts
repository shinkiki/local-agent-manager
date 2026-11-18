/// <reference types="cypress" />

describe("세션 반복 요청 필터의 언어 전환 상태 계약", () => {
  it("반복 요청 포함 선택은 영어 전환 뒤에도 유지되고 새 라벨과 도움말이 번역된다", () => {
    cy.visitApp();
    cy.openView("sessions").should("be.visible");

    cy.get(".more-filter-trigger")
      .should("have.attr", "title", "보관·서브에이전트·AIA 대화·반복 요청 포함 여부")
      .click();

    cy.get("#session-more-filter-panel")
      .should("have.attr", "aria-label", "추가 필터")
      .contains("label", "반복 요청 포함")
      .find('input[type="checkbox"]')
      .should("not.be.checked")
      .check();

    cy.get(".more-filter-trigger").find("em").should("have.text", "1");
    cy.get("body").type("{esc}");

    cy.openSettingsTab("language").should("be.visible");
    cy.languageSelect().select("en");
    cy.anchor("nav.sessions").should("contain.text", "Sessions").click();
    cy.view("sessions").should("be.visible");

    cy.get(".more-filter-trigger")
      .should("have.attr", "title", "Whether to include archived sessions, subagents, AIA conversations, and recurring requests")
      .find("em")
      .should("have.text", "1");

    cy.get(".more-filter-trigger").click();
    cy.get("#session-more-filter-panel")
      .should("have.attr", "aria-label", "More filters")
      .and("not.contain.text", "반복 요청 포함")
      .contains("label", "Include recurring requests")
      .find('input[type="checkbox"]')
      .should("be.checked");

    cy.screenshot("sessions-recurring-filter-english");
  });
});
