const VIEW_IDS = [
  "dashboard", "chat", "sessions", "docs", "instructions", "skills", "agents", "artifacts", "workflows", "addons", "storage", "settings",
] as const;

describe("앱 셸", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  it("셸과 하단 상태바를 그린다", () => {
    cy.get(".manager-shell").should("exist");
    cy.get(".app-statusbar").should("exist");
  });

  it("주 메뉴 항목이 각 화면을 연다", () => {
    for (const id of VIEW_IDS) {
      cy.anchor(`nav.${id}`).click();
      cy.view(id).should("be.visible");
    }
  });

  it("시스템 에이전트가 없으면 AIA 트리거가 설정 안내로 이동한다", () => {
    // 하네스는 빈 HOME으로 백엔드를 띄우므로 시스템 에이전트 공급자가 선택되지 않는다.
    // 값 없는 have.attr 단언은 주체를 요소가 아니라 속성값으로 바꾼다. 클릭을 이어
    // 붙이면 undefined를 누르게 되므로 단언과 동작을 나눠 둔다.
    cy.anchor("topbar.aia").should("not.have.attr", "aria-disabled");
    cy.anchor("topbar.aia").click();
    cy.view("settings").should("be.visible");
    cy.anchor("settings.system-agent").should("be.visible").within(() => {
      cy.get(".system-agent-settings-notice").should("contain.text", "AIA");
    });
  });
});
