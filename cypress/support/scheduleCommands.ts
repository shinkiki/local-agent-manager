/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 반복 요청 편집기를 여는 절차는 스펙 셋의 beforeEach가 통째로 같았다. 목록 헤더의 버튼을
// 누르고 편집기가 떴는지 보는 뒷걸음은 취소 후 다시 여는 자리에서도 쓰이므로 따로 둔다.
Cypress.Commands.add("newScheduleEditor", () => {
  cy.contains(".schedules-panel header .button", "새 반복 요청").click();
  return cy.get(".schedule-editor").should("be.visible");
});

Cypress.Commands.add("openScheduleEditor", () => {
  cy.openView("chat");
  cy.anchor("chat.tab.schedules").click().should("have.class", "active");
  return cy.newScheduleEditor();
});
