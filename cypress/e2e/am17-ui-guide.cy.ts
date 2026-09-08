// AM-17 (임시 스펙): AIA 화면 안내를 연달아 호출했을 때 오버레이가 겹치지 않고 마지막 요청만
// 남는지, note가 없을 때 대상 설명이 말풍선을 대신 채우는지, 사용자가 화면을 바꾸면 거둬지는지.
describe("AIA 화면 안내 연속 호출과 화면 전환 후 거둠", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
  });

  it("두 번째 요청이 첫 안내를 대체하고 화면 전환으로 거둬진다", () => {
    cy.get(".ui-guide").should("not.exist");

    // 1) note 없이 호출하면 말풍선이 대상 설명으로 채워진다.
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "nav.storage", element: null, note: null }))
      .should("eq", true);
    cy.get(".ui-guide").should("have.length", 1);
    cy.get(".ui-guide-note").should("contain.text", "좌측 주 메뉴의 저장소 항목");
    cy.view("storage").should("exist");

    // 2) 거두지 않은 채 다른 대상으로 다시 호출한다.
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.repository-path", element: null, note: "여기" }))
      .should("eq", true);
    cy.get(".ui-guide").should("have.length", 1);
    cy.get(".ui-guide-note").should("contain.text", "여기");
    cy.get(".ui-guide-note").should("not.contain.text", "좌측 주 메뉴의 저장소 항목");
    cy.view("settings").should("exist");

    // 3) 사용자가 다른 화면으로 옮기면 안내가 남지 않는다.
    cy.openView("dashboard");
    cy.get(".ui-guide").should("not.exist");
  });
});
