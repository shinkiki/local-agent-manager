/**
 * 시스템 에이전트를 고르지 않은 상태의 설정 → 연결 카드.
 * 하네스는 HOME만 격리하고 PATH는 호스트를 그대로 쓰므로 어떤 공급자가 연결로 잡힐지는
 * 기기마다 다르다. 그래서 "무엇이 잠기는가"가 아니라 "잠금과 사유 문구가 짝을 이루는가",
 * 그리고 고른 공급자가 없을 때 실행설정 카드와 번역 토글이 열리지 않는가를 본다.
 */
describe("시스템 에이전트를 고르지 않은 설정 화면", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("settings");
  });

  it("선택 안 함이 켜져 있고 공급자 항목은 잠금과 사유가 짝을 이루며, 실행설정과 번역 토글은 열리지 않는다", () => {
    cy.anchor("settings.tab.connections").click();
    cy.anchor("settings.system-agent").scrollIntoView().should("be.visible");
    cy.anchor("settings.system-agent").find('[role="radiogroup"]').should("have.attr", "aria-label", "시스템 에이전트");

    // 첫 항목이 "선택 안 함"이고, 저장된 시스템 에이전트가 없으므로 이것이 켜져 있다.
    cy.anchor("settings.system-agent").find('[role="radio"]').should("have.length.at.least", 2);
    cy.anchor("settings.system-agent").find('[role="radio"]').first()
      .should("contain.text", "선택 안 함")
      .and("have.attr", "aria-checked", "true")
      .and("not.be.disabled");

    // 공급자 항목은 잠겼으면 "CLI 연결 필요", 열렸으면 "CLI 연결됨"을 스스로 밝힌다.
    // 잠긴 이유가 항목 밖에만 있으면 왜 못 고르는지 화면에서 알 수 없다.
    cy.anchor("settings.system-agent").find('[role="radio"]').not(":first").each(($item) => {
      cy.wrap($item)
        .should("have.attr", "aria-checked", "false")
        .and("contain.text", $item.is(":disabled") ? "CLI 연결 필요" : "CLI 연결됨");
    });

    // 고른 공급자가 없으니 실행설정(모델·추론수준) 카드는 아예 그리지 않는다.
    cy.get('[data-ui-anchor="settings.system-agent-runtime"]').should("not.exist");

    // 시스템 에이전트가 없으면 번역을 돌릴 주체도 없다. 설정은 남기되 토글은 잠근다.
    cy.anchor("settings.tab.language").click();
    cy.get(".translation-toggle-list .app-toggle").should("have.length.at.least", 4).each(($toggle) => {
      cy.wrap($toggle).should("be.disabled");
    });

    // 탭을 다녀와도 선택 안 함과 실행설정 없음이 그대로다.
    cy.anchor("settings.tab.connections").click();
    cy.anchor("settings.system-agent").find('[role="radio"]').first().should("have.attr", "aria-checked", "true");
    cy.get('[data-ui-anchor="settings.system-agent-runtime"]').should("not.exist");
  });
});
