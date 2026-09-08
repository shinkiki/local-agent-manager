// 워크플로 → 페이싱 탭 → 계정 풀 카드의 '계정 풀 설정' 모달에서 참여 토글과 목표 override를
// 실제로 바꿔 본다. 기존 스펙은 이 카드를 읽기만 했다 — AM-41은 풀이 빈 초기 상태의 표기,
// AM-33은 옆 '예산 기본값' 모달의 숫자 경계였고, 이 모달을 열어 값을 쓰고 새로고침 뒤 복원까지
// 본 스펙은 없다. 축은 계정·사용량, 조건은 경계값 + 저장 후 복원.
//
// 계정 수와 라벨은 하네스가 띄운 격리 백엔드가 정하므로 DOM에서 읽어 쓴다.
function poolSection() {
  return cy.anchor("workflows.usage-budget.accounts");
}

function openPoolModal() {
  poolSection().scrollIntoView();
  poolSection().find("button[aria-label='계정 풀 설정']").click();
  return cy.get(".modal").should("be.visible");
}

function firstRow() {
  return cy.get(".modal .usage-budget-modal-row").first();
}

describe("계정 풀 설정 모달의 참여 토글과 목표 override 경계값", () => {
  it("참여를 켜면 카드가 즉시 따라오고, 100을 넘긴 목표는 잘려 저장되며 새로고침 뒤에도 남는다", () => {
    cy.visitApp();
    cy.openPacingTab();

    // 사전조건: 계정이 하나 이상 있고 풀은 비어 있다(AM-41이 붙잡은 초기 상태).
    poolSection().find(".usage-budget-pool-card").should("have.class", "muted");
    poolSection().find(".usage-budget-pool-bars > li").its("length").then((total) => {
      openPoolModal();

      // 1) 모달 행 수가 카드 막대 수와 같다 — 등록 계정을 빠짐없이 낸다.
      cy.get(".modal .usage-budget-modal-row").should("have.length", total);

      // 2) 참여가 꺼진 행은 muted이고 토글은 꺼져 있다.
      firstRow().should("have.class", "muted");
      firstRow().find("button[role='switch']").should("have.attr", "aria-checked", "false");

      // 3) 목표 override에 상한을 넘긴 150을 넣고 blur 하면 100으로 잘려 저장된다.
      firstRow().find("input[type='number']").clear().type("150").blur();
      cy.get(".modal .usage-budget-modal-row").should("have.length", total); // 저장 완료(재렌더) 대기

      // 4) 참여를 켠다.
      firstRow().find("button[role='switch']").click();
      firstRow().should("not.have.class", "muted");

      // 5) 모달을 닫으면 카드가 곧바로 1 / N로 따라온다.
      cy.get(".modal").within(() => cy.get("button[aria-label='닫기'], .modal-close").first().click());
      cy.get(".modal").should("not.exist");
      poolSection().find(".usage-budget-pool-card").should("not.have.class", "muted");
      poolSection().find(".usage-budget-pool-card strong").first()
        .should("have.text", `페이싱 계정 1 / ${total}`);
      poolSection().find(".usage-budget-pool-bars > li").first().should("not.have.class", "off");

      // 6) 새로고침해도 참여와 잘린 목표값이 백엔드에 남아 있다.
      cy.visitApp();
      cy.openPacingTab();
      poolSection().find(".usage-budget-pool-card strong").first()
        .should("have.text", `페이싱 계정 1 / ${total}`);
      openPoolModal();
      firstRow().should("not.have.class", "muted");
      firstRow().find("input[type='number']").should("have.value", "100");

      // 7) 원복: 목표를 비우고 참여를 끄면 카드가 다시 0 / N muted로 돌아간다.
      firstRow().find("input[type='number']").clear().blur();
      firstRow().find("button[role='switch']").click();
      cy.get(".modal").within(() => cy.get("button[aria-label='닫기'], .modal-close").first().click());
      poolSection().find(".usage-budget-pool-card").should("have.class", "muted");
      poolSection().find(".usage-budget-pool-card strong").first()
        .should("have.text", `페이싱 계정 0 / ${total}`);
    });
  });
});
