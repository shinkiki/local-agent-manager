describe("애드온 화면", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("addons").should("be.visible");
  });

  it("아이아·클로드·코덱스 탭을 구분하고 온보딩 목업은 단계만 넘어간다", () => {
    cy.anchor("addons.tab.aia").should("have.class", "active");
    cy.anchor("addons.aia-content").should("be.visible").within(() => {
      // 온보딩 단계는 시작 버튼을 눌러야 열린다.
      cy.get('[aria-current="step"]').should("not.exist");
      cy.contains("button", "온보딩 시작").click();
      cy.get('[aria-current="step"]').should("contain.text", "대상 시스템");
      cy.contains("button", "다음").click();
      cy.get('[aria-current="step"]').should("contain.text", "테스트 환경");
      // 마지막 단계의 생성 버튼은 백엔드가 붙기 전까지 잠겨 있다.
      cy.contains("button", "회차 운영·생성").click();
      cy.contains("button", "워크플로 생성").should("be.disabled");
    });

    cy.anchor("addons.tab.aia").focus().type("{rightarrow}");
    cy.anchor("addons.tab.claude").should("have.class", "active").and("be.focused");
    cy.anchor("addons.claude-plugins-content").should("be.visible");
    cy.anchor("addons.aia-content").should("not.be.visible");

    cy.openAddonsTab("codex");
    cy.anchor("addons.claude-plugins-content").should("not.be.visible");
  });

  it("AIA 화면 안내가 클로드 탭을 연다", () => {
    cy.anchor("nav.dashboard").click();
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "addons.claude", element: null, note: "여기" }))
      .should("eq", true);
    cy.view("addons").should("exist");
    cy.anchor("addons.tab.claude").should("have.class", "active");
    cy.get(".ui-guide-note").should("contain.text", "여기");
  });

  it("클로드 탭 선택 후 화면을 새로고침해도 클로드 탭이 유지된다", () => {
    cy.openAddonsTab("claude");

    cy.reload();

    cy.view("addons").should("be.visible");
    cy.anchor("addons.tab.claude").should("have.class", "active");
    cy.anchor("addons.claude-plugins-content").should("be.visible");
  });
});
