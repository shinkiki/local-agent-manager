/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 지침 화면의 모드 탭은 "지침 화면을 열고 모드 버튼을 눌러 눌린 상태를 확인한다"의 세 걸음인데,
// 스펙 셋이 저마다 openManage를 손으로 적어 두고 선택자마저 갈렸다(한국어 aria-label을 박은 것과
// role=group만 쓴 것). 한국어 이름을 선택자에 넣으면 영어 화면에서 잡히지 않으므로, 언어를 타지
// 않는 role=group과 버튼 순서만 아는 한 벌을 여기 둔다.
const INSTRUCTION_MODES = ["info", "manage"] as const;

Cypress.Commands.add("openInstructionMode", (mode: "info" | "manage") => {
  cy.openView("instructions");
  return cy
    .get(".skill-mode-tabs[role=group] button")
    .eq(INSTRUCTION_MODES.indexOf(mode))
    .click()
    .should("have.attr", "aria-pressed", "true");
});
