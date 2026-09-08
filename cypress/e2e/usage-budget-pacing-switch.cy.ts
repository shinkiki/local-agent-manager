// 워크플로 페이싱 요약 카드의 페이싱 사용 스위치(기능 전체 ON/OFF).
//
// 시간대(페이싱 스케줄)·계정·회차는 저마다 자기 자리에서 끌 수 있었지만 "지금은 아무것도
// 자동으로 돌리지 마라"를 한 번에 말할 곳이 없었다. 스위치는 예산 기본값과 같은 저장 경로를
// 쓰는데, 백엔드가 기본값 한 벌을 통째로 교체하므로(usage_budget_policy.rs의 set_defaults)
// 다른 모달의 저장이 이 칸을 함께 실어 보내지 않으면 껐던 페이싱이 그때 되살아난다 —
// 이 스펙의 마지막 두 걸음이 그 회귀를 잡는다.

function pacingSwitch() {
  return cy.anchor("workflows.usage-budget.enabled").find("button[role=switch]");
}

describe("워크플로 페이싱 기능 스위치", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openPacingTab();
  });

  it("기본값은 켜짐이고, 끄면 알림이 뜨며 새로고침을 건너서도 꺼진 채로 남는다", () => {
    // 1) 정책을 한 번도 저장하지 않은 격리 백엔드는 켜짐으로 읽힌다. 저장본에 칸이 없다고
    //    꺼짐으로 읽으면 업데이트만으로 모든 회차가 조용히 멈춘다.
    pacingSwitch().should("have.attr", "aria-checked", "true");
    cy.anchor("workflows.usage-budget").find(".usage-budget-pacing-off").should("not.exist");

    // 2) 끄면 요약 카드의 상태 글자와 사용량 예산 카드의 알림이 함께 바뀐다. 카드가 평소와
    //    똑같아 보이면 "회차가 왜 안 뜨지"의 답이 화면 어디에도 없다.
    pacingSwitch().click();
    pacingSwitch().should("have.attr", "aria-checked", "false");
    cy.anchor("workflows.usage-budget.enabled").should("contain.text", "꺼짐");
    cy.anchor("workflows.usage-budget")
      .find(".usage-budget-pacing-off")
      .should("be.visible")
      .and("contain.text", "예약 시각이 되어도 뜨지 않습니다");
    cy.get(".error-banner").should("not.exist");

    // 3) 화면 상태가 아니라 저장된 정책이어야 한다.
    cy.visitApp();
    cy.openPacingTab();
    pacingSwitch().should("have.attr", "aria-checked", "false");
    cy.anchor("workflows.usage-budget").find(".usage-budget-pacing-off").should("be.visible");

    // 4) 다시 켜면 알림도 함께 사라진다.
    pacingSwitch().click();
    pacingSwitch().should("have.attr", "aria-checked", "true");
    cy.anchor("workflows.usage-budget").find(".usage-budget-pacing-off").should("not.exist");
  });

  it("스케줄·예산 기본값 모달을 저장해도 꺼 둔 페이싱이 되살아나지 않는다", () => {
    pacingSwitch().click();
    pacingSwitch().should("have.attr", "aria-checked", "false");

    // 1) 페이싱 스케줄 모달은 기본값 한 벌을 다시 실어 보낸다. 스위치 칸을 빠뜨리면 여기서
    //    켜짐으로 되돌아간다.
    cy.anchor("workflows.usage-budget.schedule").click();
    cy.get(".modal .quiet-hours-form").contains("button", "저장").click();
    cy.get(".modal").should("not.exist");
    pacingSwitch().should("have.attr", "aria-checked", "false");

    // 2) 예산 기본값 모달도 같은 커맨드로 저장한다.
    cy.openBudgetDefaultsModal();
    cy.get(".modal .modal-footer").contains("button", "저장").click();
    cy.get(".modal").should("not.exist");
    pacingSwitch().should("have.attr", "aria-checked", "false");
    cy.get(".error-banner").should("not.exist");

    // 3) 저장된 값도 그대로다.
    cy.visitApp();
    cy.openPacingTab();
    pacingSwitch().should("have.attr", "aria-checked", "false");
  });
});
