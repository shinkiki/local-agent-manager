/// <reference types="cypress" />
// QA #20: 아이아 커서 클릭(click_ui_element / open)에 실은 note는 누른 요소 옆에 말풍선으로 남아야
// 한다. 클릭이 화면을 바꾸는 주 메뉴 버튼이어도 마찬가지다 — 막 데려간 화면을 설명하는 말이다.
// 결함은 안내에 기록되는 화면이 콜백이 만들어질 때의 값이라, 화면이 바뀐 뒤 "안내한 화면을
// 떠났다"고 판정되어 말풍선이 그 자리에서 닫히던 것(간헐). 화면이 바뀌는 클릭을 연달아 세 번
// 해서 매번 말풍선이 뜨고 잠시 뒤에도 남아 있는지 본다.
const STEPS: Array<{ label: string; view: string }> = [
  { label: "지침", view: "instructions" },
  { label: "대시보드", view: "dashboard" },
  { label: "세션", view: "sessions" },
];

describe("아이아 커서 클릭의 note 말풍선", () => {
  it("화면을 바꾸는 클릭에도 note 말풍선이 뜨고 잠시 뒤에도 남는다", () => {
    cy.visitApp();
    cy.stubInvoke("answer_ui_query").as("answer");
    cy.anchor("nav.instructions").should("be.visible");
    cy.view("dashboard").should("exist");

    STEPS.forEach(({ label, view }, index) => {
      const note = `여기가 ${label} 화면입니다`;
      cy.e2e().then((hooks) => {
        hooks.performAiaUiClick({
          type: "uiClick",
          id: `qa20-${index}`,
          element: { text: label, role: "button" },
          mode: "open",
          note,
        });
      });
      cy.view(view).should("exist");
      cy.wait("@answer").its("request.body.answer.clicked").should("eq", true);
      cy.get(".ui-guide-note", { timeout: 6000 }).should("contain.text", note);
      // 화면 전환이 그려진 뒤에도 말풍선이 그대로 남아 읽을 시간을 준다.
      cy.wait(1500);
      cy.get(".ui-guide-note").should("contain.text", note);
      cy.anchor(`nav.${view}`).should("have.attr", "aria-current", "page");
    });
    cy.screenshot("qa20-note-survives-view-change");
  });
});
