/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 워크플로 → 페이싱 탭은 사용량 예산 스펙 일곱이 저마다 `openPacingTab`을 손으로 적어 두던
// 자리다. 같은 세 걸음인데 탭 선택 확인만 스펙마다 달라(aria-selected·클래스·생략) 규칙이
// 흩어져 있었다. 여기 한 벌로 두고, 예산 카드가 떴는지까지 확인해 넘긴다.
Cypress.Commands.add("openPacingTab", () => {
  cy.openView("workflows");
  cy.anchor("workflows.tab.recurring").click().should("have.attr", "aria-selected", "true");
  return cy.anchor("workflows.usage-budget").should("be.visible");
});

// 페이싱 요약 카드의 사용 스위치 구획(`workflows.usage-budget.enabled`)은 스펙 다섯이 저마다
// `pacingSwitch`를 적어 두던 자리다. 네 벌은 글자 그대로 같았고, 다국어 스펙만 접근성 이름으로
// 좁혀 잡았다(영어 화면에서도 같은 스위치를 가리켜야 하므로). 앵커 이름을 아는 곳을 여기 하나로
// 줄이고, 좁히는 기준만 인자로 받는다. 구획 자체의 문구("켜짐"·"꺼짐")를 보는 스펙은
// `pacingControl`을 쓴다.
Cypress.Commands.add("pacingControl", () => cy.anchor("workflows.usage-budget.enabled"));

Cypress.Commands.add("pacingSwitch", (label?: string) =>
  cy.pacingControl().find(label ? `[role="switch"][aria-label="${label}"]` : "button[role=switch]"),
);

// 예산 기본값 모달을 여는 두 걸음도 같은 카드 안의 같은 버튼이다.
Cypress.Commands.add("openBudgetDefaultsModal", () => {
  cy.anchor("workflows.usage-budget").contains("button", "예산 기본값").click();
  return cy.get(".modal").should("be.visible");
});

// 예산 기본값 모달 안을 보는 스펙 다섯이 저마다 `targetInput`·`baselineInput`·`profileSelect`처럼
// 칸 하나에 함수 하나를 두고, 그 안에 "모달 안에서 라벨을 찾아 그 안의 입력을 집는다"를 다시
// 적어 두고 있었다(qa56과 am33은 같은 두 함수를 글자 그대로 복사한 사이였다). 칸이 input인지
// select인지는 라벨마다 다르지만 집는 절차는 하나이므로, 라벨만 받는 한 벌로 둔다.
Cypress.Commands.add("budgetField", (label: string) =>
  cy.get(".modal").contains("label", label).find("input, select"),
);

// 저장·닫기는 모달 바닥글에만 있다. 바닥글에 있다는 사실을 아는 곳을 한 곳으로 줄인다.
Cypress.Commands.add("budgetFooterButton", (label: string) =>
  cy.get(".modal .modal-footer").contains("button", label),
);

// 저장의 정상 갈래는 "바닥글 저장을 누르면 모달이 스스로 닫힌다"까지가 한 걸음이다. 저장이
// 실패해 모달이 열린 채 남는 것을 보는 스펙만 `budgetFooterButton`을 직접 쓴다.
Cypress.Commands.add("saveBudgetDefaults", () => {
  cy.budgetFooterButton("저장").click();
  return cy.get(".modal").should("not.exist");
});

// 페이싱 스케줄(멈출 시간대) 모달은 스펙 셋이 `.modal .quiet-hours-form`·
// `.modal .time-range input[type=time]`·`.modal .weekday-picker`를 스물여섯 자리에 그대로
// 적어 두던 자리다. 폼 하나를 보는 같은 선택자가 세 파일에 흩어져, 클래스 하나가 바뀌면
// 세 곳을 같이 고쳐야 했다. 모달 여는 두 걸음과 폼 안 선택자를 여기 한 벌로 모은다.
// 탭 전환은 포함하지 않는다 — 이미 페이싱 탭에 있는 스펙이 탭을 다시 누르면 보려던 것이 달라진다.
Cypress.Commands.add("openPacingScheduleModal", () => {
  cy.anchor("workflows.usage-budget.schedule").click();
  cy.get(".modal .modal-title").should("contain.text", "페이싱 스케줄");
  return cy.quietHoursForm();
});

Cypress.Commands.add("quietHoursForm", () => cy.get(".modal .quiet-hours-form"));

Cypress.Commands.add("quietHoursToggle", () => cy.quietHoursForm().find(".app-toggle"));

// 시각 칸은 언제나 시작·끝 두 개다. 하나만 보는 자리는 `.eq(0)`·`.eq(1)`로 좁힌다.
Cypress.Commands.add("quietHoursTimes", () => cy.get(".modal .time-range input[type=time]"));

// 요일 고르개는 fieldset 자체(꺼짐일 때 disabled)와 그 안의 체크박스 일곱을 따로 본다.
Cypress.Commands.add("quietHoursWeekdayPicker", () => cy.get(".modal .weekday-picker"));

Cypress.Commands.add("quietHoursWeekdays", () => cy.quietHoursWeekdayPicker().find("input[type=checkbox]"));

// 저장 버튼은 잠김 여부를 보는 자리가 많아 누르기까지 묶지 않는다.
Cypress.Commands.add("quietHoursSave", () => cy.quietHoursForm().contains("button", "저장"));
