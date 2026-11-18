// 로고 "데이터 새로고침"은 열려 있던 화면을 새로 마운트해 마운트 때 한 번 읽는 값까지 다시 읽게 한다.
// 화면마다 신호를 따로 꽂던 동안은 꽂은 곳(회차 목표)만 갱신돼 나머지는 앱을 껐다 켜야 맞았다.
// 채팅은 진행 중인 대화와 작성 중인 입력을 들고 있어 그대로 남아야 한다.
// DOM 노드에 표식을 달아 두고, 새로고침 뒤 표식이 사라졌는지(새 노드)·남았는지(같은 노드)로 가른다.
type MarkedElement = HTMLElement & { __refreshMark?: string };

function markFirstChild(view: string, mark: string) {
  cy.get(`[data-view="${view}"]`).children().first().then(($el) => {
    ($el[0] as MarkedElement).__refreshMark = mark;
  });
}

function firstChildMark(view: string) {
  // then이 undefined를 돌려주면 Cypress는 원래 요소를 넘기므로 표식이 없을 때는 null로 바꾼다.
  return cy.get(`[data-view="${view}"]`).children().first().then(($el) => ($el[0] as MarkedElement).__refreshMark ?? null);
}

describe("로고 새로고침의 화면 다시 마운트", () => {
  it("채팅 밖 화면은 숨겨져 있어도 새로 마운트되고, 채팅은 그대로 남는다", () => {
    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.openView("chat");
    cy.openView("settings");
    cy.openView("addons");

    markFirstChild("chat", "chat");
    markFirstChild("settings", "settings");
    markFirstChild("addons", "addons");

    cy.get(".brand-logo").click();
    cy.get(".brand-logo", { timeout: 20000 }).should("not.be.disabled");

    firstChildMark("addons").should("be.null");
    firstChildMark("settings").should("be.null");
    firstChildMark("chat").should("equal", "chat");
    // 다시 마운트돼도 보고 있던 화면과 메뉴 선택은 그대로다.
    cy.view("addons").should("exist");
    cy.anchor("nav.addons").should("have.attr", "aria-current", "page");
  });
});
