// UI 언어 전환. 내장 영어는 시스템 에이전트 번역 없이 바로 적용되므로 계정이 비어 있는
// 격리 백엔드에서도 끝까지 확인할 수 있다.
function openLanguageTab() {
  cy.openSettingsTab("language");
  cy.get(".language-settings-section").should("be.visible");
}

describe("UI 언어 전환", () => {
  beforeEach(() => {
    cy.visitApp();
    openLanguageTab();
  });

  afterEach(() => {
    // 다음 테스트가 한국어 화면에서 시작하도록 되돌린다.
    cy.get("body").then(($body) => {
      if ($body.find(".translation-language-actions select").length === 0) return;
      cy.languageSelect().then(($select) => {
        if ($select.val() !== "ko") cy.wrap($select).select("ko");
      });
    });
  });

  it("기본은 한국어이고 목록에 내장 언어 두 개가 있다", () => {
    cy.languageSelect().should("have.value", "ko");
    cy.languageSelect().find("option").should("have.length.at.least", 2);
    cy.languageSelect().find('option[value="en"]').should("exist");
    cy.anchor("nav.sessions").should("contain.text", "세션");
  });

  it("영어로 바꾸면 주 메뉴와 정적 문구가 영어로 바뀐다", () => {
    cy.languageSelect().select("en");
    cy.anchor("nav.sessions").should("contain.text", "Sessions");
    cy.anchor("nav.dashboard").should("contain.text", "Dashboard");
    cy.get(".language-settings-section header strong").should("contain.text", "Language and translation");
    cy.anchor("nav.sessions").should("not.contain.text", "세션");
  });

  it("영어 선택은 새로고침 뒤에도 남는다", () => {
    cy.languageSelect().select("en");
    cy.anchor("nav.sessions").should("contain.text", "Sessions");
    cy.visitApp();
    cy.anchor("nav.sessions").should("contain.text", "Sessions");
    openLanguageTab();
    cy.languageSelect().should("have.value", "en");
  });

  it("다시 한국어로 되돌리면 영어 문구가 남지 않는다", () => {
    cy.languageSelect().select("en");
    cy.anchor("nav.sessions").should("contain.text", "Sessions");
    cy.languageSelect().select("ko");
    cy.anchor("nav.sessions").should("contain.text", "세션");
    cy.get(".language-settings-section header strong").should("contain.text", "언어 및 자동번역");
  });
});
