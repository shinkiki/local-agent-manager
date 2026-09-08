// 워크플로 페이싱 → 사용량 예산 → '예산 기본값' 모달의 소진 모드(drain)와
// 남겨 둘 크레딧(drainReserveCredits) 입력의 상호작용 및 저장·복원 경계.
//
// 674cc1f·c099c44·dab8da3·532fe8f 커밋에서 도입된 소진 모드는:
// 1) 기본값이 꺼짐(false)이고 남겨 둘 크레딧 입력은 disabled 상태이다.
// 2) 토글 스위치를 켜면 "몰아 쓰고 되돌림" 문구로 바뀌며 남겨 둘 크레딧 입력이 활성화된다.
// 3) 소진 모드를 켠 채 저장하면 사용량 예산 카드 상단에 소진 모드 현황 배너(.usage-budget-drain-status)가
//    나타나고, 격리 백엔드는 쓸 수 있는 크레딧이 없으므로 "지금 소진 중인 계정 없음" 안내를 표출한다.
// 4) 저장된 소진 모드 및 남겨 둘 크레딧 값은 새로고침(visitApp) 후에도 복원된다.
// 5) 소진 모드를 다시 끄고 저장하면 배너가 사라지고 남겨 둘 크레딧 입력은 다시 disabled 된다.

function drainSection() {
  return cy.get(".modal .usage-budget-modal-section").contains("strong", "소진 모드").closest(".usage-budget-modal-section");
}

function drainToggle() {
  return drainSection().find(".usage-budget-drain-toggle button[role=switch]");
}

function drainReserveInput() {
  return drainSection().contains("label", "남겨 둘 크레딧").find("input");
}

function saveModal() {
  cy.get(".modal .modal-footer").contains("button", "저장").click();
  cy.get(".modal").should("not.exist");
}

describe("예산 기본값의 소진 모드 스위치와 남겨 둘 크레딧 연동 및 배너 반영", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openPacingTab();
  });

  it("기본값은 꺼짐·입력 비활성화이며 켜면 활성화되고, 저장 시 현황 배너가 표시되며 새로고침 후에도 유지된다", () => {
    // 1) 초기 상태: 사용량 예산 카드 상단에 소진 모드 배너가 없다.
    cy.anchor("workflows.usage-budget").find(".usage-budget-drain-status").should("not.exist");

    // 2) 예산 기본값 모달을 열면 소진 모드는 기본 꺼짐이며 남겨 둘 크레딧 입력은 비활성화 상태다.
    cy.openBudgetDefaultsModal();
    drainToggle().should("have.attr", "aria-checked", "false");
    drainSection().find(".usage-budget-drain-toggle em").should("contain.text", "균등 소비");
    drainReserveInput().should("be.disabled");

    // 3) 스위치를 켜면 라벨이 '몰아 쓰고 되돌림'으로 바뀌고 크레딧 입력이 활성화된다.
    drainToggle().click();
    drainToggle().should("have.attr", "aria-checked", "true");
    drainSection().find(".usage-budget-drain-toggle em").should("contain.text", "몰아 쓰고 되돌림");
    drainReserveInput().should("not.be.disabled");

    // 남겨 둘 크레딧에 2를 입력하고 저장한다.
    drainReserveInput().clear().type("2");
    saveModal();

    // 4) 저장 후: 카드 상단에 소진 모드 현황 배너가 표시된다.
    // 격리 환경에서는 쓸 수 있는 크레딧 계정이 없으므로 "지금 소진 중인 계정 없음"이 표시된다.
    cy.anchor("workflows.usage-budget")
      .find(".usage-budget-drain-status")
      .should("be.visible")
      .and("contain.text", "소진 모드 켜짐 · 지금 소진 중인 계정 없음");

    // 5) 새로고침 후에도 저장된 소진 모드 켬과 남겨 둘 크레딧 수치(2), 현황 배너가 유지된다.
    cy.visitApp();
    cy.openPacingTab();
    cy.anchor("workflows.usage-budget").find(".usage-budget-drain-status").should("be.visible");

    cy.openBudgetDefaultsModal();
    drainToggle().should("have.attr", "aria-checked", "true");
    drainReserveInput().should("not.be.disabled").and("have.value", "2");

    // 6) 소진 모드를 다시 끄면 크레딧 입력이 disabled로 돌아가고, 저장 후 배너가 사라진다.
    drainToggle().click();
    drainToggle().should("have.attr", "aria-checked", "false");
    drainReserveInput().should("be.disabled");
    saveModal();

    cy.anchor("workflows.usage-budget").find(".usage-budget-drain-status").should("not.exist");

    // 7) 새로고침 후에도 꺼진 상태가 유지된다.
    cy.visitApp();
    cy.openPacingTab();
    cy.anchor("workflows.usage-budget").find(".usage-budget-drain-status").should("not.exist");
    cy.openBudgetDefaultsModal();
    drainToggle().should("have.attr", "aria-checked", "false");
    drainReserveInput().should("be.disabled");
    cy.get(".modal .modal-footer").contains("button", "닫기").click();
  });
});
