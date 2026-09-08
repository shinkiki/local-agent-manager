describe("설정 화면", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.settings").click();
    cy.view("settings").should("exist");
  });

  it("CLI 상태 카드가 연결 탭을 연다", () => {
    cy.anchor("settings.tab.connections").should("have.class", "active");
  });

  it("저장소 탭에 공통 저장소 경로 입력이 있다", () => {
    cy.anchor("settings.tab.repository").click();
    cy.anchor("settings.repository-path").should("be.visible");
  });

  it("플러그인 탭의 중메뉴가 외부 MCP와 SSH를 구분한다", () => {
    cy.anchor("settings.tab.plugins").click();
    cy.anchor("settings.plugins").should("be.visible").and("have.class", "active");
    cy.anchor("settings.external-plugins-content")
      .should("be.visible")
      .find("img.notion-mark")
      .should("be.visible")
      .and("have.attr", "src")
      .and("match", /^data:image\/png;base64,/);
    // Claude Code 플러그인은 주 메뉴의 애드온 화면으로 옮겨 여기에는 없다.
    cy.anchor("addons.tab.claude").should("not.exist");

    cy.anchor("settings.plugins").focus().type("{rightarrow}");
    cy.anchor("settings.ssh-keys").should("have.class", "active").and("be.focused");
    cy.anchor("settings.ssh-keys-content").should("be.visible");
    cy.anchor("settings.external-plugins-content").should("not.be.visible");
  });

  it("자동화 탭에 Cypress 작업공간 카드가 있다", () => {
    // 카드 내부 구조는 별도 작업에서 바뀌므로 존재만 단언한다.
    cy.anchor("settings.tab.automation").click();
    cy.anchor("settings.cypress").should("be.visible");
  });

  it("백엔드 서비스 탭은 데스크톱 앱이 아니면 포트를 읽기 전용으로 보여주고 화면 전환 후에도 남는다", () => {
    cy.anchor("settings.tab.service").click();
    cy.anchor("settings.tab.service").should("have.class", "active").and("have.attr", "aria-selected", "true");

    // 브라우저(비 Tauri) 화면에서는 서비스 포트를 바꿀 수 없어야 한다.
    cy.get(".remote-access-card").should("be.visible").within(() => {
      cy.get(".backend-service-port input").should("be.disabled");
      cy.get(".backend-service-port small").should("contain.text", "읽기 전용");
      cy.get(".backend-service-port button").should("be.disabled");
    });

    // 다른 화면을 들렀다 돌아와도 고른 중메뉴가 초기 탭으로 되돌아가지 않는다.
    cy.anchor("nav.dashboard").click();
    cy.view("settings").should("not.exist");
    cy.openView("settings");
    cy.anchor("settings.tab.service").should("have.class", "active");
    cy.get(".remote-access-card").should("be.visible");
  });
});
