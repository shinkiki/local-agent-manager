/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 애드온 → 데이터베이스 탭은 비동기 초기 연결 조회가 끝날 때까지 "연결을 확인하는 중…"
// 문구가 머물러 있다. 스펙 넷이 저마다 openDbTab을 적고 이 카드가 준비될 때까지 기다리는
// 세 걸음을 손으로 적어 두고 있었다. 한 벌로 둔다.
Cypress.Commands.add("openDbConnectionsTab", () => {
  cy.openAddonsView("db");
  cy.anchor("addons.db-content").should("be.visible");
  return cy.get(".db-connections-card").should("not.contain.text", "연결을 확인하는 중…");
});

// 데이터베이스 새 연결 편집기를 여는 절차. 추가 버튼을 누르고 편집기 폼이 떴는지 확인한다.
Cypress.Commands.add("openDbConnectionEditor", () => {
  cy.anchor("addons.db.add").should("be.enabled").click();
  return cy.get(".db-connection-editor").should("be.visible");
});

// 데이터베이스 연결 편집기의 라벨을 찾는다. 안내 문구 안에도 "이름" 등 라벨 단어가 섞여
// 있으므로 span 전문 일치로 직접 자식 라벨만 고른다.
Cypress.Commands.add("dbConnectionField", (label: string) =>
  cy.get(".db-connection-editor").find("> label").filter((_index, element) => {
    const span = element.querySelector(":scope > span");
    return span?.textContent?.trim() === label;
  }),
);

// 데이터베이스 연결 편집기의 하단 동작 버튼(저장·취소)을 찾는다.
Cypress.Commands.add("dbConnectionAction", (label: string) =>
  cy.contains(".db-connection-editor-actions button", label),
);
