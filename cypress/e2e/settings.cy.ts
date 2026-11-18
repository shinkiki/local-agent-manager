describe("설정 화면", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("settings");
  });

  it("CLI 상태 카드가 연결 탭을 연다", () => {
    cy.anchor("settings.tab.connections").should("have.class", "active");
  });

  it("설정에는 더 이상 플러그인·자동화·라이브러리 탭이 없다", () => {
    // 외부 MCP·SSH·Cypress·Mermaid는 애드온 화면의 도구 탭으로, 공통 저장소 경로(라이브러리)는
    // 저장소 화면의 라이브러리 탭으로 옮겼다.
    cy.anchor("settings.tab.plugins").should("not.exist");
    cy.anchor("settings.tab.automation").should("not.exist");
    cy.anchor("settings.tab.repository").should("not.exist");
    cy.view("settings").should("not.contain.text", "스킬·프로젝트 지침 저장 위치");
  });

  it("저장소 화면의 라이브러리 탭에 공통 저장소 경로 입력이 있고 프로젝트 활성여부 카드는 없다", () => {
    // '세션에서 확인한 프로젝트' 카드는 프로젝트 화면의 설정 탭으로 옮겼다.
    cy.openStorageTab("library");
    cy.anchor("storage.repository-path").should("be.visible");
    cy.view("storage").should("not.contain.text", "세션에서 확인한 프로젝트");
  });

  it("Cypress 화면 안내는 애드온의 Cypress 탭을 연다", () => {
    cy.e2e().then((hooks) => hooks.showUiGuide({ target: "addons.cypress", element: null, note: "Cypress" })).should("eq", true);
    cy.view("addons").should("exist");
    cy.anchor("addons.tab.cypress").should("have.class", "active");
    cy.anchor("addons.cypress-content").should("be.visible");
    cy.get("body").type("{esc}");
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
