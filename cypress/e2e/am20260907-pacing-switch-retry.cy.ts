// 워크플로 페이싱 전체 스위치의 실패 복구 경로. 정상 저장·새로고침 복원은
// usage-budget-pacing-switch.cy.ts가 다루지만, 첫 저장이 실패한 뒤 화면과 저장값이 켜짐으로
// 남고 같은 자리에서 다시 시도할 수 있는지는 별도 계약이다.

function pacingSwitch() {
  return cy.anchor("workflows.usage-budget.enabled").find("button[role=switch]");
}

describe("워크플로 페이싱 전체 스위치의 저장 실패 복구", () => {
  it("끄기 저장 실패는 켜짐을 보존하고 오류를 알리며, 재시도 성공값은 새로고침 뒤에도 남는다", () => {
    let attempts = 0;
    cy.intercept("POST", "**/api/invoke/set_usage_budget_policy", (request) => {
      attempts += 1;
      if (attempts === 1) {
        request.reply({ statusCode: 500, body: { error: "페이싱 정책을 저장하지 못했습니다." } });
        return;
      }
      request.continue();
    }).as("savePacing");

    cy.visitApp();
    cy.openPacingTab();
    pacingSwitch().should("have.attr", "aria-checked", "true").click();

    cy.wait("@savePacing");
    pacingSwitch().should("have.attr", "aria-checked", "true").and("be.enabled");
    cy.anchor("workflows.usage-budget.enabled").should("contain.text", "켜짐");
    cy.anchor("workflows.usage-budget")
      .find(".error-banner")
      .should("be.visible")
      .and("contain.text", "페이싱 정책을 저장하지 못했습니다.");

    pacingSwitch().click();
    cy.wait("@savePacing");
    pacingSwitch().should("have.attr", "aria-checked", "false");
    cy.anchor("workflows.usage-budget").find(".error-banner").should("not.exist");

    cy.visitApp();
    cy.openPacingTab();
    pacingSwitch().should("have.attr", "aria-checked", "false");
    cy.anchor("workflows.usage-budget").find(".usage-budget-pacing-off").should("be.visible");

    // 하네스는 한 실행의 스펙들이 백엔드를 공유한다. 다음 회귀 스펙이 정책 기본값을 보는
    // 계약을 독립적으로 확인할 수 있게 이 스펙이 바꾼 값을 원래 켜짐으로 돌려놓는다.
    pacingSwitch().click();
    cy.wait("@savePacing");
    pacingSwitch().should("have.attr", "aria-checked", "true");
  });
});
