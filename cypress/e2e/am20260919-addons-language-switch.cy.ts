/// <reference types="cypress" />
/**
 * QA #82. UI 언어를 바꾸면 **애드온 화면도 그 언어를 따라오는지** 본다.
 *
 * 접수 당시 증상은 한 방향이 아니었다 — 영어로 바꿔 애드온을 열어 두고 한국어로 되돌리면
 * 좌측 메뉴만 한글로 바뀌고 애드온 화면은 통째로 영어로 남았고, 반대 방향도 같았다.
 * 새로고침하면 맞게 서므로 저장된 설정은 옳고 화면만 이전 언어에 눌러앉는 경우다.
 *
 * 언어 전환은 스펙 경계를 넘는 백엔드 설정이므로 끝에서 반드시 한국어로 되돌린다
 * (`cypress/support/languageCommands.ts`).
 */
describe("언어를 바꾸면 애드온 화면도 따라온다", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("영어로 바꾼 뒤 한국어로 되돌리면 데이터베이스 카드도 한국어로 돌아온다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");

    cy.setLanguage("en");
    cy.openAddonsView("db");
    cy.anchor("addons.db-content").should("be.visible").and("contain.text", "Connections");

    // 되돌리기. 새로고침 없이 같은 세션 안에서 바꾼다 — 새로고침하면 증상이 가려진다.
    cy.openSettingsTab("language");
    cy.languageSelect().select("ko");
    cy.anchor("nav.settings").should("contain.text", "설정");

    cy.openAddonsView("db");
    cy.anchor("addons.tab.db").should("contain.text", "DB");
    cy.anchor("addons.db-content").should("be.visible")
      .and("contain.text", "연결 관리")
      .and("not.contain.text", "No connections yet");
  });
});
