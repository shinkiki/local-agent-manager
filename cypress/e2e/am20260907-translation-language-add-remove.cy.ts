/// <reference types="cypress" />
// 설정 → 언어 탭의 번역 언어 추가/삭제 폼 및 칩 계약을 검증한다.
// 1. "언어 추가" 버튼 클릭 시 폼이 토글되고, 취소 클릭 시 닫힌다.
// 2. 언어(일본어)를 추가하면 칩 목록에 표시되고, select 옵션에도 즉시 반영된다.
// 3. 새로고침 뒤에도 추가한 언어 칩과 select 옵션이 백엔드 저장소로부터 복원된다.
// 4. 칩의 삭제 버튼 클릭 시 추가한 언어가 목록 및 select 옵션에서 제거된다.

function openLanguageTab() {
  cy.openSettingsTab("language");
  cy.get(".language-settings-section").should("be.visible");
}

describe("설정 · 번역 언어 추가 및 삭제 라이프사이클 계약", () => {
  beforeEach(() => {
    cy.visitApp();
    openLanguageTab();
  });

  after(() => {
    // 혹시라도 추가된 언어가 남아있으면 정리하고 기본 한국어로 복구
    cy.visitApp();
    openLanguageTab();
    cy.get("body").then(($body) => {
      const $deleteButtons = $body.find('.translation-language-chips button[aria-label*="삭제"]');
      if ($deleteButtons.length > 0) {
        cy.wrap($deleteButtons).each(($btn) => {
          cy.wrap($btn).click();
        });
      }
    });
    cy.restoreLanguage();
  });

  it("언어 추가 폼 토글, 프리셋 언어 추가, 새로고침 복원, 칩 삭제가 정상 동작한다", () => {
    // 0) 초기 상태: 추가 언어 칩이 없고 기본 내장 언어(ko, en)만 존재
    cy.get(".translation-language-chips").should("not.exist");
    cy.languageSelect().find('option[value="ja"]').should("not.exist");

    // 1) "언어 추가" 버튼 클릭 시 폼 열림
    cy.get(".translation-language-actions").contains("button", "언어 추가").click();
    cy.get(".translation-language-form").should("be.visible");
    cy.get('.translation-language-form select[aria-label="추가할 언어"]').should("be.visible");

    // 2) 취소 버튼 클릭 시 폼 닫힘
    cy.get(".translation-language-form").contains("button", "취소").click();
    cy.get(".translation-language-form").should("not.exist");

    // 3) 다시 폼을 열고 일본어(ja)를 선택해 추가
    cy.get(".translation-language-actions").contains("button", "언어 추가").click();
    cy.get('.translation-language-form select[aria-label="추가할 언어"]').select("ja");
    cy.get('.translation-language-form button[type="submit"]').click();

    // 추가 후 폼이 닫히고 칩 컨테이너가 나타남
    cy.get(".translation-language-form").should("not.exist");
    cy.get(".translation-language-chips").should("be.visible");
    cy.get(".translation-language-chips").should("contain.text", "일본어").and("contain.text", "ja");

    // select 옵션에도 일본어가 즉시 추가됨
    cy.languageSelect().find('option[value="ja"]').should("exist");

    // 4) 새로고침 뒤에도 백엔드 설정에서 복원됨
    cy.reload();
    openLanguageTab();
    cy.get(".translation-language-chips").should("be.visible");
    cy.get(".translation-language-chips").should("contain.text", "일본어").and("contain.text", "ja");
    cy.languageSelect().find('option[value="ja"]').should("exist");

    // 5) 삭제 버튼을 눌러 언어 제거
    cy.get('.translation-language-chips button[aria-label*="삭제"]').click();
    cy.get(".translation-language-chips").should("not.exist");
    cy.languageSelect().find('option[value="ja"]').should("not.exist");

    // 6) 새로고침 후에도 삭제된 상태 유지
    cy.reload();
    openLanguageTab();
    cy.get(".translation-language-chips").should("not.exist");
    cy.languageSelect().find('option[value="ja"]').should("not.exist");
  });
});
