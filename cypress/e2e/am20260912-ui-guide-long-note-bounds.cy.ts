/// <reference types="cypress" />

/**
 * 긴 화면 안내 말풍선의 세로 경계.
 *
 * QA #66. 말풍선은 화살표 위에 `bottom` 고정으로 매달리므로 내용이 길수록 위로 자란다.
 * 자라는 높이에 한계가 없던 시절에는 뷰포트 위로 통째로 넘어가, 잘려 나가는 쪽이 문장의
 * **앞부분**이라 무슨 안내인지조차 읽을 수 없었다(관측 252px 이탈). 이제 남은 공간까지만
 * 자라고 넘치는 만큼은 말풍선 안에서 스크롤한다.
 */
const LONG_NOTE = Array.from(
  { length: 40 },
  (_, index) => `${index === 0 ? "안내 시작" : `문장 ${index}`}: 이 말풍선은 화면 위로 넘칠 만큼 깁니다.`,
).join(" ");

describe("긴 화면 안내 말풍선의 뷰포트 경계", () => {
  it("화면 아래쪽 대상을 가리켜도 말풍선이 위로 이탈하지 않는다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");

    // 주 메뉴 맨 아래 항목을 가리키면 말풍선은 그 위로 자란다.
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "nav.settings", element: null, note: LONG_NOTE }))
      .should("eq", true);

    cy.get(".ui-guide-note").should("be.visible").then(($note) => {
      const rect = $note[0].getBoundingClientRect();
      expect(rect.top, "말풍선 윗변이 뷰포트 안에 있다").to.be.at.least(0);
      expect(rect.bottom, "말풍선 아랫변도 뷰포트 안에 있다").to.be.at.most(Cypress.config("viewportHeight"));
      // 앞부분이 잘리지 않았으므로 첫 문장을 읽을 수 있다.
      expect($note[0].scrollTop, "처음에는 맨 위를 보여 준다").to.equal(0);
    });
    cy.get(".ui-guide-note").should("contain.text", "안내 시작");
  });
});
