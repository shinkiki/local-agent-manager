// AM-33 (임시 스펙): 워크플로 페이싱 → 사용량 예산 → '예산 기본값' 모달의 숫자 경계.
// 두 칸은 보정 시점이 다르다 — 목표 사용률(%)은 parsePercent가 입력 즉시 0~100으로 자르고,
// 기준선 회차 수는 parseCount가 그대로 두었다가 저장할 때 1~32로 자른다
// (src/components/UsageBudgetPanel.tsx:37, :60, :379). 백엔드는 범위를 자르지 않고 거절하므로
// (crates/agent-manager-core/src/usage_budget_policy.rs:793) 프런트 보정이 빠지면 저장이 실패한다.
// 기존 워크플로 시나리오는 AM-4(병렬 권장값)·AM-13(0건 빈 상태)·AM-24(스케줄 요일·시각 경계)
// ·AM-26(반복 요청 편집기 저장 차단)이고, 예산 기본값 칸의 범위 경계와 새로고침 잔존은 처음이다.
// workflows.cy.ts의 기존 예산 기본값 테스트는 같은 화면에서 다시 열어 보는 데까지만 간다.
// (AM-32는 같은 시각 돌던 다른 QA 회차가 먼저 가져가 AM-33으로 받았다.)

function targetInput() {
  return cy.get(".modal").contains("label", "목표 사용률(%)").find("input");
}

function baselineInput() {
  return cy.get(".modal").contains("label", "기준선 회차 수").find("input");
}

function save(): void {
  cy.get(".modal .modal-footer").contains("button", "저장").click();
  cy.get(".modal").should("not.exist");
}

describe("예산 기본값 모달의 숫자 경계와 저장 후 잔존", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openPacingTab();
  });

  it("목표 사용률은 입력하는 순간 0~100으로 잘리고, 저장한 값이 요약 줄과 새로고침을 건너 남는다", () => {
    cy.openBudgetDefaultsModal();

    // 1) 상한 넘김: 100을 넘겨 치면 그 자리에서 100으로 잘려 보인다. 저장 뒤에야 잘리면
    //    사용자는 150을 저장했다고 믿고 모달을 닫는다.
    targetInput().clear().type("150").should("have.value", "100");
    // 2) 하한: 0은 유효한 값이라 그대로 남는다(목표 없음과 다르다).
    targetInput().clear().type("0").should("have.value", "0");

    // 3) 구분 가능한 중간값을 저장한다. 기본값은 '목표 없음'이므로 42는 저장이 실제로
    //    반영됐는지 요약 줄에서 가려낼 수 있다.
    targetInput().clear().type("42").should("have.value", "42");
    save();

    // 4) 요약 줄은 '목표 없음'에서 '<창> 42%'로 바뀐다.
    cy.get(".workflow-limit-summary dd")
      .should("contain.text", "42%")
      .and("not.contain.text", "목표 없음");

    // 5) 새로고침을 건너서도 저장값이 남고, 모달을 다시 열어도 같은 값이 보인다.
    cy.visitApp();
    cy.openPacingTab();
    cy.get(".workflow-limit-summary dd").should("contain.text", "42%");
    cy.openBudgetDefaultsModal();
    targetInput().should("have.value", "42");
  });

  it("기준선 회차 수는 입력 중에는 범위 밖 값을 그대로 두고 저장할 때 1~32로 자르며, 빈 칸은 기본값 5로 떨어진다", () => {
    cy.openBudgetDefaultsModal();

    // 1) 이 칸은 즉시 보정하지 않는다 — 지우고 다시 채우는 도중에 값이 튀지 않아야 하므로
    //    범위 보정을 저장 한 번으로 미룬 설계다. 그래서 치는 동안에는 99가 그대로 남는다.
    baselineInput().clear().type("99").should("have.value", "99");

    // 1-1) AM-33이 남긴 결함(허용 범위가 화면 어디에도 없음)은 고쳐졌다 — 라벨이 1~32를
    //      직접 적는다. min/max 속성만으로는 저장이 form submit이 아니라 클릭 처리라
    //      브라우저 검증이 뜨지 않아 범위를 알 길이 없었다.
    cy.get(".modal").contains("label", "기준선 회차 수").should("contain.text", "1~32");
    cy.get(".modal").contains("label", "기준선 회차 수").find("input").should("have.attr", "max", "32");
    save();

    // 2) 저장에서 상한 32로 잘린다. 백엔드는 33 이상을 거절하므로 여기서 자르지 않으면
    //    저장이 오류 배너로 끝난다.
    cy.get(".modal").should("not.exist");
    cy.anchor("workflows.usage-budget").find(".error-banner").should("not.exist");

    // 2-1) 결함 증적: 잘렸다는 사실을 알리는 자리가 없다. 형제 칸인 목표 사용률(%)은 치는
    //      순간 화면에서 고쳐 주는데, 이 칸은 확인한 값과 다른 값이 저장되고도 화면이 조용하다.
    //      기준선 회차 수는 모달 밖 어디에도 나오지 않아 다시 열기 전에는 32를 볼 수 없다.
    cy.anchor("workflows.usage-budget").should("not.contain.text", "기준선 회차 수");
    cy.get('[data-view="workflows"]:not([hidden])').should("not.contain.text", "32회");

    cy.openBudgetDefaultsModal();
    baselineInput().should("have.value", "32");

    // 3) 잘린 값은 새로고침 뒤에도 남는다.
    cy.visitApp();
    cy.openPacingTab();
    cy.openBudgetDefaultsModal();
    baselineInput().should("have.value", "32");

    // 4) 하한: 0은 1로 올라간다.
    baselineInput().clear().type("0").should("have.value", "0");
    save();
    cy.openBudgetDefaultsModal();
    baselineInput().should("have.value", "1");

    // 5) 빈 칸으로 저장하면 기본값 5로 떨어진다 — 빈 칸을 그대로 보내면 백엔드가 거절한다.
    baselineInput().clear().should("have.value", "");
    save();
    cy.openBudgetDefaultsModal();
    baselineInput().should("have.value", "5");
  });
});
