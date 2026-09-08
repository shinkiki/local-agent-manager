describe("다국어 빠른 연속 전환", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openSettingsTab("language");
    cy.get(".language-settings-section").should("be.visible");
  });

  afterEach(() => {
    cy.get("body").then(($body) => {
      if ($body.find(".translation-language-actions select").length === 0) return;
      cy.languageSelect().then(($select) => {
        if ($select.val() !== "ko") cy.wrap($select).select("ko");
      });
    });
  });

  it("언어를 빠르게 여러 번 바꾸어도 마지막 선택으로 안정화된다", () => {
    // b47537f 변경(setLanguage와 languageSelect 일원화) 후
    // 연속 change 이벤트가 발생했을 때 누락이나 무한 렌더 루프 없이 안정적으로 반영되는지 확인한다.
    
    cy.languageSelect().select("en");
    cy.languageSelect().select("ko");
    cy.languageSelect().select("en");
    cy.languageSelect().select("ko");
    cy.languageSelect().select("en");

    // 최종적으로 en이어야 함
    cy.languageSelect().should("have.value", "en");
    cy.anchor("nav.sessions").should("contain.text", "Sessions");
    cy.anchor("nav.sessions").should("not.contain.text", "세션");

    // 다시 ko로 복귀
    cy.languageSelect().select("ko");
    cy.languageSelect().should("have.value", "ko");
    cy.anchor("nav.sessions").should("contain.text", "세션");
  });
});
