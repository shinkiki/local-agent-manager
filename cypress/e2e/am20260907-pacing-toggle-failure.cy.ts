function pacingSwitch() {
  return cy.anchor("workflows.usage-budget.enabled").find("button[role=switch]");
}

describe("워크플로 페이싱 전체 스위치 저장 실패", () => {
  it("저장 실패 때 기존 상태를 유지하고 안내한 뒤 다시 시도할 수 있다", () => {
    cy.visitApp();
    cy.openPacingTab();
    pacingSwitch().should("have.attr", "aria-checked", "true");

    cy.intercept(
      { method: "POST", url: "**/api/invoke/set_usage_budget_policy", times: 1 },
      { statusCode: 500, body: { error: "QA forced pacing save failure" } },
    ).as("failedPacingSave");

    pacingSwitch().click();
    cy.wait("@failedPacingSave");
    pacingSwitch().should("have.attr", "aria-checked", "true").and("not.be.disabled");
    cy.anchor("workflows.usage-budget.enabled").should("contain.text", "켜짐");
    cy.anchor("workflows.usage-budget").find(".usage-budget-pacing-off").should("not.exist");
    cy.get(".error-banner").should("be.visible").and("contain.text", "QA forced pacing save failure");

    pacingSwitch().click();
    pacingSwitch().should("have.attr", "aria-checked", "false");
    cy.anchor("workflows.usage-budget.enabled").should("contain.text", "꺼짐");
    cy.get(".error-banner").should("not.exist");
  });
});
