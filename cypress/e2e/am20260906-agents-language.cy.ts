/// <reference types="cypress" />
// 에이전트 정의 화면(AgentsView)을 영어로 전환했을 때의 도달 범위를 본다. AM-63이 같은 화면의
// 빈 상태·검색 좁히기·드로워 대체값을 한국어로만 확인했으므로 여기서는 다국어 축만 다룬다.
//
// 툴바 카운트는 "Claude" + text("에이전트","agents") + 숫자 + text("개","") 네 노드로 조립된다
// (src/components/AgentsView.tsx:25). 영어에서는 마지막 노드가 빈 문자열이라 "Claude agents 0"이
// 되어야 하고, 메뉴 번역 카탈로그가 가운데 노드를 덮으면 산출물 화면(AM-5·AM-6)과 같은 형태로
// 어긋난다. 격리 하네스의 HOME에는 ~/.claude/agents가 없어 목록은 0건이다.
function openAgents() {
  cy.openView("agents").should("be.visible");
}

describe("에이전트 정의 화면의 영어 전환", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  // 이 스펙은 UI 언어를 영어로 바꾼 채 끝난다. 언어는 백엔드 설정에 남아 다음 스펙까지 따라가므로
  // 스펙이 끝날 때 한국어로 되돌린다.
  after(() => {
    cy.restoreLanguage();
  });

  // 대조군. 영어 확인이 무엇과 달라지는지 기준을 남긴다.
  it("한국어 카운트는 숫자 뒤에 '개'가 붙는다", () => {
    openAgents();
    cy.get('[data-view="agents"] .toolbar-count').should("have.text", "Claude 에이전트 0개");
    cy.get('[data-view="agents"] .search-input').should("have.attr", "placeholder", "에이전트명·설명·도구 검색");
  });

  it("영어로 바꾸면 카운트·빈 상태·검색창 안내에 한글이 남지 않는다", () => {
    cy.setLanguage("en");
    openAgents();
    cy.get('[data-view="agents"] .toolbar-count').invoke("text").should("not.match", /[가-힣]/);
    cy.get('[data-view="agents"] .empty-state').invoke("text").should("not.match", /[가-힣]/);
    cy.get('[data-view="agents"] .search-input').invoke("attr", "placeholder").should("not.match", /[가-힣]/);
  });

  it("영어 카운트 문구가 AgentsView가 선언한 값과 같다", () => {
    cy.setLanguage("en");
    openAgents();
    cy.get('[data-view="agents"] .toolbar-count').should("have.text", "Claude agents 0");
  });

  it("영어 빈 상태 제목·설명이 AgentsView가 선언한 값과 같다", () => {
    cy.setLanguage("en");
    openAgents();
    cy.get('[data-view="agents"] .empty-state').should("contain.text", "No agent definitions");
    cy.get('[data-view="agents"] .empty-state')
      .should("contain.text", "Markdown definitions are discovered from ~/.claude/agents.");
  });

  it("영어 검색창 안내가 AgentsView가 선언한 값과 같다", () => {
    cy.setLanguage("en");
    openAgents();
    cy.get('[data-view="agents"] .search-input')
      .should("have.attr", "placeholder", "Search agent, description, or tool");
  });

  // 정의가 하나도 없으면 검색어가 있어도 원인은 정의 파일이 없는 것이므로 탐지 경로 안내가 그대로
  // 남는다. 정의가 있는데 검색으로 0건이 된 갈래(QA #17)는 qa17-agents-search-empty가 본다.
  it("영어에서 정의가 0건이면 검색어를 넣어도 같은 빈 상태 안내가 남는다", () => {
    cy.setLanguage("en");
    openAgents();
    cy.get('[data-view="agents"] .empty-state').invoke("text").then((before) => {
      cy.get('[data-view="agents"] .search-input').type("zzz-no-such-agent");
      cy.get('[data-view="agents"] .toolbar-count').should("have.text", "Claude agents 0");
      cy.get('[data-view="agents"] .empty-state').invoke("text").should("eq", before);
    });
  });
});
