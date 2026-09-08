// 워크플로 페이싱 전체 스위치는 정책 한 벌을 저장한다. 응답 전에 연속 입력을 허용하면
// 같은 스냅샷을 바탕으로 한 요청이 겹쳐 마지막 의도와 저장값이 어긋날 수 있으므로,
// 저장 중에는 스위치를 잠그고 완료 뒤 다시 조작할 수 있어야 한다.

function pacingSwitch() {
  return cy.anchor("workflows.usage-budget.enabled").find("button[role=switch]");
}

describe("워크플로 페이싱 전체 스위치의 빠른 연속 조작 차단", () => {
  it("저장 응답을 기다리는 동안 추가 클릭을 막고 완료 뒤 다음 변경은 정상 저장한다", () => {
    let saveCount = 0;
    cy.intercept("POST", "**/api/invoke/set_usage_budget_policy", (req) => {
      saveCount += 1;
      req.on("response", (res) => { res.setDelay(1200); });
    }).as("savePolicy");

    cy.visitApp();
    cy.openPacingTab();
    pacingSwitch().should("have.attr", "aria-checked", "true").and("not.be.disabled");

    pacingSwitch().click();
    pacingSwitch().should("be.disabled");
    pacingSwitch().click({ force: true });
    cy.wrap(null).then(() => {
      expect(saveCount, "저장 중 추가 정책 요청").to.equal(1);
    });

    cy.wait("@savePolicy");
    pacingSwitch().should("have.attr", "aria-checked", "false").and("not.be.disabled");

    pacingSwitch().click();
    cy.wait("@savePolicy");
    cy.wrap(null).then(() => {
      expect(saveCount, "완료 뒤 두 번째 정책 요청").to.equal(2);
    });
    pacingSwitch().should("have.attr", "aria-checked", "true").and("not.be.disabled");
    cy.get(".error-banner").should("not.exist");
    cy.screenshot("pacing-switch-rapid-click-complete");
  });
});
