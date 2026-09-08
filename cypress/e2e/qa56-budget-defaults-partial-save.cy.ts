// QA #56 (AM-203) 회귀: 예산 기본값 모달의 저장은 목표·가드(set_usage_budget_policy)와 회당 소비
// 추이(set_usage_budget_savings) 두 커맨드를 잇달아 보낸다. 백엔드에 둘을 한 번에 받는 커맨드가
// 없어 둘째가 실패하면 첫째는 이미 저장된 상태다. 예전에는 화면이 저장 전 스냅샷을 비추고 오류도
// 보통 실패처럼 말해 사용자는 아무것도 저장되지 않은 줄로 알았다. 이제 저장된 목표·가드가 화면에
// 반영되고 오류가 '일부만 저장됨'을 구분해 말하며, 다시 저장하면 남은 절반이 이어서 저장된다.
//
// 목표·가드 저장은 격리 백엔드가 실제로 받고, 둘째 커맨드만 한 번 실패시킨다.

function targetInput() {
  return cy.get(".modal").contains("label", "목표 사용률(%)").find("input");
}

function baselineInput() {
  return cy.get(".modal").contains("label", "기준선 회차 수").find("input");
}

function saveButton() {
  return cy.get(".modal .modal-footer").contains("button", "저장");
}

describe("예산 기본값 저장의 부분 실패", () => {
  // 같은 격리 백엔드를 뒤따르는 스펙이 이어 쓰므로, 여기서 저장한 목표 37%·기준선 7을 기본값으로 되돌린다.
  after(() => {
    cy.visitApp();
    cy.openPacingTab();
    cy.openBudgetDefaultsModal();
    targetInput().clear();
    baselineInput().clear().type("5");
    saveButton().click();
    cy.get(".modal").should("not.exist");
  });

  it("둘째 커맨드가 실패하면 저장된 목표·가드를 화면에 비추고 일부만 저장됨을 알린 뒤, 재시도로 마무리한다", () => {
    cy.visitApp();
    cy.openPacingTab();
    // 같은 격리 백엔드를 다른 스펙이 먼저 썼을 수 있어 기본값을 못 박지 않고, 이 시험의 값만 없음을 본다.
    cy.get(".workflow-limit-summary dd").should("be.visible").and("not.contain.text", "37%");

    cy.openBudgetDefaultsModal();
    targetInput().clear().type("37");
    baselineInput().clear().type("7");

    cy.intercept("POST", "**/api/invoke/set_usage_budget_policy").as("policySave");
    cy.intercept(
      { method: "POST", url: "**/api/invoke/set_usage_budget_savings", times: 1 },
      { statusCode: 500, body: { error: "QA forced savings save failure" } },
    ).as("failedSavings");

    saveButton().click();
    cy.wait("@policySave");
    cy.wait("@failedSavings");

    // 1) 모달은 입력을 든 채 열려 있고, 오류는 절반만 저장됐음을 구분해 말한다.
    cy.get(".modal").should("be.visible");
    cy.get(".modal .error-banner")
      .should("contain.text", "일부만 저장됨")
      .and("contain.text", "QA forced savings save failure");

    // 2) 화면은 저장 전 값(목표 없음)이 아니라 실제 저장된 목표 37%를 비춘다.
    cy.get(".workflow-limit-summary dd").should("contain.text", "37%");

    // 3) 초안: 목표는 저장값 그대로, 기준선은 다시 저장할 수 있게 친 값이 남는다.
    targetInput().should("have.value", "37");
    baselineInput().should("have.value", "7");

    // 4) 다시 저장하면 남은 절반이 실제 백엔드에 들어가 모달이 닫히고 오류가 걷힌다.
    saveButton().click();
    cy.get(".modal").should("not.exist");
    cy.anchor("workflows.usage-budget").find(".error-banner").should("not.exist");

    // 5) 다시 열면 두 값이 모두 저장돼 있다.
    cy.openBudgetDefaultsModal();
    targetInput().should("have.value", "37");
    baselineInput().should("have.value", "7");
  });
});
