describe("AIA 화면 안내 E2E 훅", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  it("등록된 대상을 가리키고 Esc로 거둔다", () => {
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.repository-path", element: null, note: "여기" }))
      .should("eq", true);
    cy.get(".ui-guide-note").should("contain.text", "여기");
    cy.view("settings").should("exist");
    cy.get("body").type("{esc}");
    cy.get(".ui-guide").should("not.exist");
  });

  it("모르는 대상은 false를 돌려준다", () => {
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.nowhere", element: null, note: null }))
      .should("eq", false);
  });

  it("아이아 커서가 주 메뉴를 눌러 세션 화면을 열고 결과를 답한다", () => {
    cy.stubInvoke("answer_ui_query").as("answer");
    // 훅은 스냅샷 로딩 중에도 설치되므로, 커서가 찾을 주 메뉴가 그려진 뒤에 호출한다.
    cy.anchor("nav.sessions").should("be.visible");
    cy.e2e().then((hooks) => {
      hooks.performAiaUiClick({ type: "uiClick", id: "e2e-1", element: { text: "세션", role: "button" }, mode: "open", note: null });
    });
    cy.get(".ui-cursor").should("exist");
    cy.view("sessions").should("exist");
    cy.wait("@answer").its("request.body.answer.clicked").should("eq", true);
  });
});
