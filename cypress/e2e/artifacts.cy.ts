/// <reference types="cypress" />
// 산출물 화면의 빈 상태·검색 카운트와 영어 전환 시 번역 도달 범위를 본다.
function openArtifacts() {
  cy.openView("artifacts").should("be.visible");
}

describe("산출물 화면 빈 상태와 다국어", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  // 이 스펙은 UI 언어를 영어로 바꾼 채 끝난다. 언어는 백엔드 설정에 남아 다음 스펙까지 따라가므로
  // 스펙이 끝날 때 한국어로 되돌린다(테스트가 중간에 실패해도 도는 `after`에서).
  after(() => {
    cy.restoreLanguage();
  });

  it("한국어 빈 상태에서 카운트와 안내 문구가 한국어로 나온다", () => {
    openArtifacts();
    cy.get('[data-view="artifacts"] .toolbar-count').should("have.text", "Antigravity 대화 0개");
    cy.get('[data-view="artifacts"] .empty-state').should("contain.text", "아티팩트가 없습니다");
    cy.get('[data-view="artifacts"] .empty-state').should("contain.text", "Antigravity brain 폴더");
    cy.get('[data-view="artifacts"] .search-input').should("have.attr", "placeholder", "대화 제목·아티팩트·요약 검색");
  });

  it("검색어를 넣어도 빈 목록이면 카운트가 0개로 남고 같은 안내가 보인다", () => {
    openArtifacts();
    cy.get('[data-view="artifacts"] .search-input').type("존재하지-않는-아티팩트");
    cy.get('[data-view="artifacts"] .toolbar-count').should("have.text", "Antigravity 대화 0개");
    cy.get('[data-view="artifacts"] .empty-state').should("contain.text", "아티팩트가 없습니다");
  });

  it("영어로 바꾸면 카운트·빈 상태·검색창 안내에 한글이 남지 않는다", () => {
    cy.setLanguage("en");
    openArtifacts();
    cy.get('[data-view="artifacts"] .toolbar-count').invoke("text").should("not.match", /[가-힣]/);
    cy.get('[data-view="artifacts"] .empty-state').invoke("text").should("not.match", /[가-힣]/);
    cy.get('[data-view="artifacts"] .search-input')
      .invoke("attr", "placeholder")
      .should("not.match", /[가-힣]/);
  });

  // 세는 문구는 "Antigravity" + text("대화","conversations") + 숫자가 별개 노드다. 카탈로그의
  // "대화" → "Conversation"이 가운데 노드를 덮으면 단수·대문자로 문법이 깨진다(QA #5·#6).
  it("영어 카운트 문구가 ArtifactsView가 선언한 값과 같다", () => {
    cy.setLanguage("en");
    openArtifacts();
    cy.get('[data-view="artifacts"] .toolbar-count').should("have.text", "Antigravity conversations 0");
  });

  it("영어 빈 상태 제목이 ArtifactsView가 선언한 값과 같다", () => {
    cy.setLanguage("en");
    openArtifacts();
    cy.get('[data-view="artifacts"] .empty-state').should("contain.text", "No artifacts");
  });

  it("영어 빈 상태 설명이 ArtifactsView가 선언한 값과 같다", () => {
    cy.setLanguage("en");
    openArtifacts();
    cy.get('[data-view="artifacts"] .empty-state')
      .should("contain.text", "Tasks, plans, and walkthroughs are discovered from Antigravity brain folders.");
  });

  it("영어 검색창 안내가 ArtifactsView가 선언한 값과 같다", () => {
    cy.setLanguage("en");
    openArtifacts();
    cy.get('[data-view="artifacts"] .search-input')
      .should("have.attr", "placeholder", "Search conversation, artifact, or summary");
  });

});
