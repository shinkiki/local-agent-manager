// AM-32 (임시 스펙): 아이아 커서가 누르면 안 되는 요소를 요청받았을 때 거절 이유를 그대로
// 답하고 화면에는 아무 자국도 남기지 않는지. uiClickRefusal의 세 갈래(비활성·모달 안·여는
// 동작 아님)와 locateUiElement가 되찾지 못한 갈래를 실제 화면에서 한 번에 본다.
// 격리 백엔드는 지침이 0건이라 '지침 가져오기'가 확실히 막혀 있고 '새 지침'은 확실히 열려 있다.
const TOOLBAR = ".skill-library-toolbar-row button";

function openInstructionManage() {
  cy.openView("instructions");
  cy.get('.skill-mode-tabs[role="group"][aria-label="지침 화면 모드"]').find("button").eq(1)
    .click().should("have.attr", "aria-pressed", "true");
}

describe("아이아 커서 클릭 거절 계약", () => {
  it("비활성·모달 안·여는 동작 아님·사라진 요소를 사유와 함께 거절하고 화면을 바꾸지 않는다", () => {
    cy.visitApp();
    cy.intercept("POST", "/api/invoke/answer_ui_query").as("answer");
    openInstructionManage();
    cy.get(TOOLBAR).contains("지침 가져오기").should("be.disabled");
    cy.get(TOOLBAR).contains("새 지침").should("not.be.disabled");

    // 1) 요소 조회(find_ui_elements)가 막힌 버튼도 후보로 답하고 ref를 붙여 준다.
    //    누를 수 있는지는 조회가 아니라 클릭 단계에서 가린다.
    cy.e2e().then((hooks) => {
      hooks.answerAiaUiQuery({ type: "uiQuery", id: "am32-q", query: "지침 가져오기", view: null, tab: null });
    });
    cy.wait("@answer").its("request.body.answer").then((elements) => {
      const found = (elements as { ref: string; text: string }[]).find((item) => item.text === "지침 가져오기");
      expect(found, "막힌 버튼도 조회 결과에 든다").to.not.equal(undefined);
      cy.wrap(found!.ref).as("importRef");
    });

    // 2) 비활성 요소는 승인 모드(click)로 요청해도 거절한다. 커서도 뜨지 않는다.
    cy.e2e().then((hooks) => {
      hooks.performAiaUiClick({ type: "uiClick", id: "am32-1", element: { text: "지침 가져오기", role: "button" }, mode: "click", note: null });
    });
    cy.wait("@answer").its("request.body.answer")
      .should("deep.equal", { clicked: false, reason: "비활성화된 요소입니다" });
    cy.get(".ui-cursor").should("not.exist");

    // 3) 여는 동작이 아닌 버튼은 open 모드에서 거절하고, 대신 쓸 수단을 사유에 적어 준다.
    cy.e2e().then((hooks) => {
      hooks.performAiaUiClick({ type: "uiClick", id: "am32-2", element: { text: "새 지침", role: "button" }, mode: "open", note: null });
    });
    cy.wait("@answer").its("request.body.answer").then((answer) => {
      expect((answer as { clicked: boolean }).clicked).to.equal(false);
      expect((answer as { reason: string }).reason).to.contain("화면을 여는 동작이 아닌 버튼입니다");
      expect((answer as { reason: string }).reason).to.contain("click_ui_element");
    });
    cy.get(".ui-cursor").should("not.exist");
    cy.get(".modal-backdrop").should("not.exist"); // 거절이면 대화상자도 열리지 않는다.

    // 4) 사용자가 직접 열어 둔 모달 안의 버튼은 승인 모드로도 누르지 않는다.
    cy.get(TOOLBAR).contains("새 지침").click();
    cy.get(".modal-backdrop").should("exist");
    cy.get('[role="dialog"]').contains("button", "취소").should("be.visible");
    cy.e2e().then((hooks) => {
      hooks.performAiaUiClick({ type: "uiClick", id: "am32-3", element: { text: "취소", role: "button" }, mode: "click", note: null });
    });
    cy.wait("@answer").its("request.body.answer").then((answer) => {
      expect((answer as { clicked: boolean }).clicked).to.equal(false);
      expect((answer as { reason: string }).reason).to.contain("확인 모달 안의 버튼은 아이아가 누르지 않습니다");
    });
    cy.get(".modal-backdrop").should("exist"); // 거절했으니 모달은 사용자 손에 남는다.
    cy.get('[role="dialog"]').contains("button", "취소").click();
    cy.get(".modal-backdrop").should("not.exist");

    // 5) 화면이 바뀌어 ref가 죽으면 되찍으라는 사유로 거절한다(text 단서 없이 ref만 준 경우).
    cy.openView("dashboard");
    cy.get("@importRef").then((ref) => {
      cy.e2e().then((hooks) => {
        hooks.performAiaUiClick({ type: "uiClick", id: "am32-4", element: { ref: ref as unknown as string, text: null, role: null }, mode: "click", note: null });
      });
    });
    cy.wait("@answer").its("request.body.answer").then((answer) => {
      expect((answer as { clicked: boolean }).clicked).to.equal(false);
      expect((answer as { reason: string }).reason).to.contain("요소를 화면에서 찾지 못했습니다");
      expect((answer as { reason: string }).reason).to.contain("find_ui_elements");
    });
    cy.get(".ui-cursor").should("not.exist");
    cy.view("dashboard").should("exist"); // 거절이 화면을 되돌리지도 않는다.
  });
});
