/**
 * 페이싱 스케줄 모달의 "멈출 시간대" 경계값과 저장 후 복원.
 * 기존 workflows 스펙은 모달이 열리고 저장하면 닫히는 것까지만 본다. 여기서는 저장을
 * 막아야 하는 두 경계(요일 0개, 시작=끝)와 자정 넘김 안내, 그리고 저장한 값이 모달을
 * 다시 열었을 때 남는지를 본다.
 */
describe("페이싱 스케줄 제한 시간대", () => {
  const openScheduleModal = () => {
    cy.anchor("workflows.tab.recurring").click();
    cy.anchor("workflows.usage-budget.schedule").click();
    cy.get(".modal .modal-title").should("contain.text", "페이싱 스케줄");
  };

  beforeEach(() => {
    cy.visitApp();
    cy.openView("workflows");
  });

  it("요일을 다 지우거나 시작과 끝이 같으면 저장이 잠기고, 켠 뒤 저장한 값은 다시 열어도 남는다", () => {
    openScheduleModal();

    // 제한 시간대는 기본이 꺼짐이고, 꺼져 있으면 시간·요일 칸을 만질 수 없다.
    cy.get(".modal .quiet-hours-form .app-toggle").should("have.attr", "aria-checked", "false");
    cy.get(".modal .time-range input[type=time]").each(($input) => cy.wrap($input).should("be.disabled"));
    cy.get(".modal .weekday-picker").should("be.disabled");
    cy.get(".modal .quiet-hours-form").contains("button", "저장").should("not.be.disabled");

    cy.get(".modal .quiet-hours-form .app-toggle").click();
    cy.get(".modal .time-range input[type=time]").each(($input) => cy.wrap($input).should("not.be.disabled"));
    // 기본 요일은 월~금 다섯이다.
    cy.get(".modal .weekday-picker input[type=checkbox]:checked").should("have.length", 5);

    // 경계 1 — 요일을 하나도 안 고르면 멈출 시각이 없다. 안내가 뜨고 저장이 잠긴다.
    cy.get(".modal .weekday-picker input[type=checkbox]:checked").each(($box) => cy.wrap($box).click());
    cy.get(".modal .quiet-hours-form").should("contain.text", "적용할 요일을 하나 이상 고르세요.");
    cy.get(".modal .quiet-hours-form").contains("button", "저장").should("be.disabled");

    // 월~일 순으로 그리므로 여섯 번째가 토요일이다.
    cy.get(".modal .weekday-picker input[type=checkbox]").eq(5).click();
    cy.get(".modal .quiet-hours-form").should("not.contain.text", "적용할 요일을 하나 이상");
    cy.get(".modal .quiet-hours-form").contains("button", "저장").should("not.be.disabled");

    // 경계 2 — 시작과 끝이 같으면 폭이 0인 시간대다. 종일 돌리라는 안내와 함께 저장이 잠긴다.
    cy.get(".modal .time-range input[type=time]").eq(1).clear().type("09:00");
    cy.get(".modal .quiet-hours-form").should("contain.text", "시작과 끝이 같으면 시간대가 없습니다.");
    cy.get(".modal .quiet-hours-form").contains("button", "저장").should("be.disabled");

    // 경계 3 — 끝이 시작보다 이르면 막지 않고 자정 넘김으로 안내한다.
    cy.get(".modal .time-range input[type=time]").eq(0).clear().type("22:00");
    cy.get(".modal .time-range input[type=time]").eq(1).clear().type("06:00");
    cy.get(".modal .quiet-hours-form").should("contain.text", "다음 날 06:00까지 이어지는 제한입니다");
    cy.get(".modal .quiet-hours-form").contains("button", "저장").should("not.be.disabled").click();
    cy.get(".modal").should("not.exist");
    cy.get(".error-banner").should("not.exist");

    // 저장 후 복원 — 다시 열면 켠 스위치와 22:00~06:00, 토요일 하나가 그대로 있다.
    cy.anchor("workflows.usage-budget.schedule").click();
    cy.get(".modal .modal-title").should("contain.text", "페이싱 스케줄");
    cy.get(".modal .quiet-hours-form .app-toggle").should("have.attr", "aria-checked", "true");
    cy.get(".modal .time-range input[type=time]").eq(0).should("have.value", "22:00");
    cy.get(".modal .time-range input[type=time]").eq(1).should("have.value", "06:00");
    cy.get(".modal .weekday-picker input[type=checkbox]:checked").should("have.length", 1);
    cy.get(".modal .weekday-picker input[type=checkbox]").eq(5).should("be.checked");
  });
});
