/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

const LANGUAGE_SELECT = ".translation-language-actions select";

// UI 언어를 고르는 곳은 설정 → 언어 탭의 select 하나뿐인데, 스펙마다 클래스 선택자와
// `aria-label`(한국어라 영어 화면에서는 잡히지 않는다)을 제각각 적어 왔다. 선택자를 아는 곳은
// 여기 하나로 둔다.
Cypress.Commands.add("languageSelect", () => cy.get(LANGUAGE_SELECT));

// "언어 탭을 열고 값을 고른다"는 다국어 스펙마다 되풀이되던 두 걸음이다.
Cypress.Commands.add("setLanguage", (value: string) => {
  cy.openSettingsTab("language");
  return cy.languageSelect().select(value);
});

// UI 언어는 백엔드 설정에 남아 스펙 경계를 넘는다. 하네스는 한 스위트에 백엔드 하나를 쓰므로,
// 영어로 바꾼 스펙이 되돌리지 않으면 알파벳 순서상 뒤에 오는 스펙 전부가 한국어 문구를 찾다가
// 무더기로 실패한다. 선택자는 언어를 타지 않는 클래스·앵커만 쓴다.
Cypress.Commands.add("restoreLanguage", () => {
  cy.visitApp();
  cy.anchor("nav.settings").click();
  cy.anchor("settings.tab.language").click();
  // 값을 읽은 뒤 `cy.wrap`한 참조로 고르면, 그 사이 화면이 다시 그려졌을 때 떨어져 나간
  // 노드에 change를 쏘게 되어 선택이 조용히 무시된다. 고를 때는 다시 조회해 최신 노드를 잡는다.
  cy.get(LANGUAGE_SELECT, { timeout: 20000 }).should("be.enabled").invoke("val").then((value) => {
    if (value !== "ko") cy.languageSelect().select("ko");
  });
  // 되돌림이 백엔드 설정에 실제로 닿을 때까지 기다린다. select만 바꾸고 끝내면 저장이 도는
  // 사이에 스펙이 끝나, 다음 스펙이 그대로 영어 화면을 만난다.
  return cy.anchor("nav.settings").should("contain.text", "설정");
});
