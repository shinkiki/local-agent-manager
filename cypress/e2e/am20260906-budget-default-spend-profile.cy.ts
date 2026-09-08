// 워크플로 페이싱 → 사용량 예산 → '예산 기본값' 모달의 '기본 소비 성향' 셀렉트 왕복.
// 이 값은 성향을 따로 정하지 않은 회차가 물려받는 값이라, 저장이 남지 않거나 '없음'으로
// 되돌아가지 않으면 사용자는 회차마다 상한을 손으로 거는 자리로 되돌아간다.
//
// 기존 예산 기본값 시나리오(AM-33)는 목표 사용률·기준선 회차 수의 숫자 경계까지만 가고,
// 페이싱 스케줄(am20260906-pacing-quiet-hours-bounds)도 이 셀렉트를 건드리지 않는다.
// 소비자 쪽 '성향' 셀렉트는 등록된 소비자가 있어야 보이므로 격리 하네스에서는 닿지 않는다.
//
// AM-111. 되돌리기까지 확인하는 이유: 기본값 저장은 기본값 한 벌을 통째로 교체하므로 '없음'이
// 그대로 남아야 하고(usage_budget_policy.rs의 set_defaults), 소비자 쪽 저장은 칸이 없으면
// 기존 값을 지키는 병합이라(set_consumer) 같은 해제를 null로 실어 보낸다. 규칙이 다른 두
// 경로라 기본값 쪽 해제를 여기서 붙잡아 둔다.

function profileSelect() {
  return cy.get(".modal").contains("label", "기본 소비 성향").find("select");
}

function save(): void {
  cy.get(".modal .modal-footer").contains("button", "저장").click();
  cy.get(".modal").should("not.exist");
}

describe("예산 기본값의 기본 소비 성향 선택과 해제", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openPacingTab();
    cy.openBudgetDefaultsModal();
  });

  it("성향 셀렉트는 '없음'으로 시작하고 네 갈래를 준다", () => {
    // 정책 시드는 성향을 비워 두므로 '없음'이다 — 여기가 곧 '자동·경계 없음'이다.
    profileSelect().should("have.value", "");
    profileSelect().find("option").should("have.length", 4);
    profileSelect().should("contain.text", "없음 (자동·경계 없음)")
      .and("contain.text", "아껴쓰기")
      .and("contain.text", "균형")
      .and("contain.text", "품질 우선");
  });

  it("고른 성향은 저장한 뒤 다시 열어도, 새로고침을 건너서도 남는다", () => {
    // 'saver'는 성향 없음이 쓰는 사다리 기준칸(high)과 반대 끝이라 반영 여부를 가려낼 수 있다.
    profileSelect().select("saver").should("have.value", "saver");
    save();

    cy.openBudgetDefaultsModal();
    profileSelect().should("have.value", "saver");
    cy.get(".modal .modal-footer").contains("button", "닫기").click();
    cy.get(".modal").should("not.exist");

    cy.visitApp();
    cy.openPacingTab();
    cy.openBudgetDefaultsModal();
    profileSelect().should("have.value", "saver");
  });

  it("성향을 '없음'으로 되돌려 저장하면 해제가 남는다", () => {
    profileSelect().select("saver");
    save();
    cy.openBudgetDefaultsModal();
    profileSelect().should("have.value", "saver");

    // 기본값 저장은 통째 교체이므로(set_defaults) 해제가 그대로 남아야 한다.
    profileSelect().select("").should("have.value", "");
    save();

    cy.visitApp();
    cy.openPacingTab();
    cy.openBudgetDefaultsModal();
    profileSelect().should("have.value", "");
  });
});
