/// <reference types="cypress" />
// QA #19 — UI 언어를 영어로 바꿔도 세션 폴더 패널의 숨기기·보기 버튼 접근성 라벨이 한국어로
// 남았다. '세션 폴더 숨기기'와 '세션 폴더 보기 · 현재 {폴더}'는 정적 번역 카탈로그에 없고,
// 특히 복원 버튼은 현재 폴더 이름을 끼워 넣은 문장이라 카탈로그로는 통째로 대응할 수 없다.
// 이제 SessionsView가 text(ko, en)으로 언어별 문장을 완성해 넘긴다
// (src/components/SessionsView.tsx: collapsedFolderRestoreLabel, 세션 폴더 숨기기 버튼).
// 한국어 계약은 am20260907-session-folder-pane-collapse가 그대로 지킨다.
// UI 언어는 백엔드에 남아 뒤따르는 스펙으로 새므로 끝에서 한국어로 되돌린다.

function hideButton() {
  return cy.get(".session-folders button.secondary-pane-toggle");
}

function restoreButton() {
  return cy.get(".session-list-pane button.secondary-pane-restore");
}

describe("세션 폴더 패널 숨기기·보기 버튼의 영어 접근성 라벨", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("영어 UI에서 숨기기 버튼과 복원 버튼의 aria-label·title이 현재 폴더까지 영어 문장으로 나온다", () => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.anchor("nav.settings").should("contain.text", "Settings");

    cy.openView("sessions");
    cy.get("aside.session-folders").should("be.visible");
    hideButton()
      .should("have.attr", "aria-label", "Hide session folders")
      .and("have.attr", "title", "Hide session folders");

    // 기본값(전체 세션)에서 접으면 현재 폴더는 'Folders'다.
    hideButton().click();
    cy.get("aside.session-folders").should("not.exist");
    restoreButton()
      .should("be.visible")
      .and("have.attr", "aria-label", "Show session folders · current: Folders")
      .and("have.attr", "title", "Show session folders · current: Folders")
      .and("contain.text", "Folders");
    restoreButton().click();

    // 미분류를 고르고 접으면 그 이름도 영어로 끼워진다.
    cy.get(".folder-list button.folder-filter").contains("Unfiled").click();
    cy.get(".folder-list button.folder-filter.active").should("contain.text", "Unfiled");
    hideButton().click();
    restoreButton()
      .should("have.attr", "aria-label", "Show session folders · current: Unfiled")
      .and("have.attr", "title", "Show session folders · current: Unfiled")
      .and("contain.text", "Unfiled");
    restoreButton().click();
    cy.get("aside.session-folders").should("be.visible");
  });
});
