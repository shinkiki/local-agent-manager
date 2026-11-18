// 예산 기본값 모달의 소진 모드 구획. "남겨 둘 크레딧" 칸은 소진 모드가 꺼져 있는 동안
// 잠겨 있어야 하고(`src/components/UsageBudgetPanel.tsx:1166`), 켠 뒤 넣은 장수는 저장 본문
// (`defaultsPayload`, 같은 파일 296줄)에 실려 재진입 때 그대로 되살아나야 한다. 칸을 비우면
// "남겨 둘 장수 없음"(null)이 저장돼야 하고, 소진 모드를 끄면 칸이 다시 잠겨야 한다.
//
// 기존 예산 스펙은 목표·가드·기준선(qa56·am33)과 페이싱 스케줄만 봤고, 소진 모드 구획의
// 잠김 게이트와 저장 후 복원은 아무도 보지 않았다.

describe("예산 기본값의 소진 모드와 남겨 둘 크레딧", () => {
  const drainToggle = () => cy.get(".modal .usage-budget-drain-toggle button[role=switch]");
  const drainState = () => cy.get(".modal .usage-budget-drain-toggle em");
  const reserveField = () => cy.budgetField("남겨 둘 크레딧");

  // 같은 격리 백엔드를 뒤따르는 스펙이 이어 쓰므로 소진 모드를 꺼 둔 기본 상태로 되돌린다.
  after(() => {
    cy.visitApp();
    cy.openPacingTab();
    cy.openBudgetDefaultsModal();
    drainToggle().then(($toggle) => {
      if ($toggle.attr("aria-checked") === "true") cy.wrap($toggle).click();
    });
    cy.saveBudgetDefaults();
  });

  it("소진 모드가 꺼져 있으면 크레딧 칸이 잠기고, 켜서 넣은 장수는 저장 후 되살아나며, 비우면 없음으로 돌아간다", () => {
    cy.visitApp();
    cy.openPacingTab();
    cy.openBudgetDefaultsModal();

    // 1) 기본 상태: 소진 모드는 꺼져 있고 균등 소비라 말하며, 크레딧 칸은 잠겨 있다.
    drainToggle().should("have.attr", "aria-checked", "false");
    drainState().should("contain.text", "균등 소비");
    reserveField().should("be.disabled").and("have.value", "");

    // 2) 켜면 문구가 바뀌고 칸이 풀린다. 아직 장수는 비어 있어 안내값 0을 비춘다.
    drainToggle().click().should("have.attr", "aria-checked", "true");
    drainState().should("contain.text", "몰아 쓰고 되돌림");
    reserveField().should("be.enabled").and("have.value", "").and("have.attr", "placeholder", "0");

    // 3) 장수 2를 넣고 저장하면 모달이 닫힌다.
    reserveField().clear().type("2");
    cy.saveBudgetDefaults();
    cy.anchor("workflows.usage-budget").find(".error-banner").should("not.exist");

    // 4) 다시 열면 소진 모드와 장수가 둘 다 저장돼 있다.
    cy.openBudgetDefaultsModal();
    drainToggle().should("have.attr", "aria-checked", "true");
    reserveField().should("be.enabled").and("have.value", "2");

    // 5) 칸을 비우고 저장하면 "남겨 둘 장수 없음"으로 돌아간다. 소진 모드는 그대로 켜져 있다.
    reserveField().clear();
    cy.saveBudgetDefaults();
    cy.openBudgetDefaultsModal();
    drainToggle().should("have.attr", "aria-checked", "true");
    reserveField().should("have.value", "");

    // 6) 소진 모드를 끄면 칸이 다시 잠긴다.
    drainToggle().click().should("have.attr", "aria-checked", "false");
    reserveField().should("be.disabled");
    cy.saveBudgetDefaults();
  });
});
