describe("인덱스 애드온 G7/G10", () => {
  const invoke = (command: string, body = {}) => cy.request("POST", `/api/invoke/${command}`, body);
  afterEach(() => {
    invoke("get_index_sources").then(({ body }) => {
      for (const source of body.sources) {
        if (source.name.startsWith("Index E2E")) invoke("remove_index_source", { request: { id: source.id } });
      }
    });
    invoke("set_index_settings", { request: { enabled: false, autoRefresh: false } });
  });

  for (const [width, height] of [[1280, 900], [390, 844]]) {
    it(`폴더 등록·검색·즉시 차단과 설정 유지 (${width}px)`, () => {
      cy.viewport(width, height);
      cy.visitApp();
      cy.openAddonsView("index");
      cy.anchor("addons.index-content").within(() => {
        cy.contains("label", "인덱스 사용").find("input").check();
        cy.contains("label", "자동 갱신").find("input").check();
        cy.contains("label", "자동 갱신").find("input").uncheck();
        cy.contains("label", "이름").find("input").type(`Index E2E ${width}`);
        cy.contains("label", "폴더 절대 경로").find("input").type(`${Cypress.config("projectRoot")}/cypress/fixtures/index-addon`);
        cy.contains("button", "폴더 등록").click();
        cy.contains(".index-addon-sources li", `Index E2E ${width}`).within(() => {
          cy.contains("button", "인덱스 갱신").click();
          cy.contains("small", "파일 1").should("exist");
          cy.contains("label", "에이전트 사용").find("input").check();
        });
        cy.contains("label", "검색어").find("input").type("orchard");
        cy.contains("button", /^검색$/).click();
        cy.get(".index-addon-hit").should("contain.text", "guide.md").and("contain.text", "orchard scheduler");
      });
      invoke("search_index", { request: { query: "orchard" } }).then(({ body }) => {
        expect(body.untrusted).to.eq(true);
        const hit = body.hits[0];
        invoke("read_index_excerpt", { request: { sourceId: hit.sourceId, relativePath: hit.relativePath, digest: hit.digest, startLine: 3, endLine: 3 } })
          .its("body.excerpt").should("contain", "orchard scheduler");
      });
      cy.anchor("addons.index-content").within(() => {
        cy.contains("label", "인덱스 사용").find("input").uncheck();
        cy.contains("저장된 색인은 유지").should("exist");
        cy.contains("button", /^검색$/).should("be.disabled");
      });
      cy.request({ method: "POST", url: "/api/invoke/search_index", body: { request: { query: "orchard" } }, failOnStatusCode: false })
        .its("status").should("eq", 400);
      cy.reload();
      cy.openAddonsView("index");
      cy.anchor("addons.index-content").within(() => {
        cy.contains("label", "인덱스 사용").find("input").should("not.be.checked");
        cy.contains(".index-addon-sources li", `Index E2E ${width}`).should("contain.text", "파일 1");
      });
      cy.window().then((win) => {
        expect(win.document.documentElement.scrollWidth).to.be.at.most(win.innerWidth + 1);
      });
      cy.screenshot(`index-addon-${width}`);
      cy.saveResult(`index-addon-${width}.json`, { width, registration: true, search: true, boundedRead: true, disabledGate: true, persistedSettings: true });
    });
  }

  it("AIA 화면 안내가 인덱스 탭을 연다", () => {
    cy.visitApp();
    cy.e2e().then((hooks) => hooks.showUiGuide({ target: "addons.index", element: null, note: "Index" })).should("eq", true);
    cy.anchor("addons.tab.index").should("have.class", "active");
    cy.anchor("addons.index-content").should("exist");
  });
});
