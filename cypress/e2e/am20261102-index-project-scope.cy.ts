// 인덱스 애드온: 본문이 카드 안쪽 여백(18px)에 서고, 폴더마다 적용 프로젝트를 고른다. 기본은
// 전체 적용(새 프로젝트 자동 포함)이고, 프로젝트를 하나 끄면 전체 적용이 풀린다. 프로젝트 목록만 가로채고 등록·적용 범위·검색은 격리 백엔드가 실제로 처리한다.
describe("인덱스 애드온 적용 프로젝트", () => {
  const root = String(Cypress.config("projectRoot")).replace(/\/$/, "");
  const fixture = `${root}/cypress/fixtures/index-addon`;
  const invoke = (command: string, body = {}) => cy.request("POST", `/api/invoke/${command}`, body);
  const project = (dir: string, name: string) => ({
    path: `${root}/${dir}`, name, sessionCount: 1, hiddenSessionCount: 0, updatedAt: null,
    providers: ["claude"], active: true, pending: false, exists: true,
  });
  const addFolder = (name: string) => {
    cy.contains("label", "인덱스 사용").find("input").check();
    cy.contains("label", "이름").find("input").type(name);
    cy.contains("label", "폴더 절대 경로").find("input").type(fixture);
    cy.contains("button", "폴더 등록").click();
    return cy.contains(".index-addon-sources > li", name);
  };

  beforeEach(() => {
    cy.stubInvoke("get_project_registry", { statusCode: 200, body: [project("src", "frontend"), project("crates", "core"), project("scripts", "tools")] });
  });
  // 격리 백엔드는 스위트 전체가 한 개라 등록·사용 설정을 남기면 뒤 스펙과 재시도가 그 위에서 돈다.
  afterEach(() => {
    invoke("get_index_sources").then(({ body }) => {
      for (const source of body.sources) {
        if (source.name.startsWith("Index Scope E2E")) invoke("remove_index_source", { request: { id: source.id } });
      }
    });
    invoke("set_index_settings", { request: { enabled: false, autoRefresh: false } });
  });

  // 이름 칸으로만 찾는다. 경로까지 보면 저장소 경로에 프로젝트 이름이 든 실행기에서 엉뚱한 줄을 잡는다.
  const scopeRow = (row: string, label: string) => cy.get(row).contains(".project-registry-name strong", new RegExp(`^${label}$`)).closest(".project-registry-row");
  const toggleOf = (row: string, label: string) => scopeRow(row, label).find("[role=switch]");

  it("본문 여백을 맞추고, 전체 적용에서 프로젝트를 끄면 전체 적용이 풀리고 검색 대상이 좁혀진다", () => {
    cy.viewport(1280, 900);
    cy.visitApp();
    cy.openAddonsView("index");
    cy.anchor("addons.index-content").within(() => {
      cy.get(".index-addon-body").each(($body) => {
        expect($body.css("padding-left")).to.eq("18px");
        expect($body.css("padding-right")).to.eq("18px");
      });
      addFolder("Index Scope E2E desktop").as("row");
      cy.get("@row").should("contain.text", "적용: 모든 프로젝트");
      // 기본은 접혀 있고 요약만 보인다.
      cy.get("@row").find(".project-registry-collapse").should("have.attr", "aria-expanded", "false").and("contain.text", "전체 적용 · 새 프로젝트 자동 포함");
      cy.get("@row").find(".project-registry-list").should("not.exist");
      cy.get("@row").find(".project-registry-collapse").click();
      // 전체 적용이면 모든 프로젝트 칸이 켜진 채 보인다.
      toggleOf("@row", "전체 적용").should("have.attr", "aria-checked", "true");
      for (const name of ["core", "frontend", "tools"]) toggleOf("@row", name).should("have.attr", "aria-checked", "true");
    });
    cy.screenshot("index-scope-desktop-all", { capture: "viewport" });

    cy.anchor("addons.index-content").within(() => {
      cy.contains(".index-addon-sources > li", "Index Scope E2E desktop").as("row");
      // 하나를 끄면 전체 적용이 풀리고 나머지가 고른 상태로 저장된다.
      toggleOf("@row", "tools").click();
      toggleOf("@row", "전체 적용").should("have.attr", "aria-checked", "false");
      toggleOf("@row", "tools").should("have.attr", "aria-checked", "false");
      cy.get("@row").should("contain.text", "적용: core, frontend");
      cy.get("@row").find(".project-registry-collapse").should("contain.text", "2개 선택");
      toggleOf("@row", "core").click();
      cy.get("@row").should("contain.text", "적용: frontend");
      // 마지막 하나는 끌 수 없다. 전체로 되돌리기는 전체 적용에서 한다. 저장 중에는 모든 칸이 잠기므로
      // 저장이 끝났음(전체 적용이 다시 눌림)을 먼저 확인한다.
      toggleOf("@row", "전체 적용").should("be.enabled");
      toggleOf("@row", "frontend").should("have.attr", "aria-checked", "true").and("be.disabled");
      cy.get("@row").contains("label", "에이전트 사용").find("input").check();
      cy.get("@row").contains("button", "인덱스 갱신").click();
      cy.get("@row").contains("small", "파일 1").should("exist");
    });
    cy.screenshot("index-scope-desktop-projects", { capture: "viewport" });

    cy.anchor("addons.index-content").within(() => {
      cy.contains("label", "검색어").find("input").type("orchard");
      cy.contains("label", "기준 프로젝트").find("select").select("tools");
      cy.contains("button", /^검색$/).click();
      cy.contains("인덱스 검색 결과가 없습니다.").should("be.visible");
      cy.contains("label", "기준 프로젝트").find("select").select("frontend");
      cy.contains("button", /^검색$/).click();
      cy.get(".index-addon-hit").should("contain.text", "orchard scheduler");
      cy.contains("label", "기준 프로젝트").find("select").select("범위 무시 (전체)");
      cy.contains("button", /^검색$/).click();
      cy.get(".index-addon-hit").should("contain.text", "orchard scheduler");
    });
    // 에이전트 경로와 같은 계약: 프로젝트를 모르는 호출(빈 값)은 범위가 걸린 폴더를 보지 못한다.
    invoke("list_agent_index_sources", { request: { project: "" } }).its("body.sources").should("have.length", 0);
    invoke("list_agent_index_sources", { request: { project: `${root}/src/components` } }).its("body.sources").should("have.length", 1);
    invoke("search_index", { request: { query: "orchard", project: `${root}/scripts` } }).its("body.hits").should("have.length", 0);

    cy.anchor("addons.index-content").within(() => {
      cy.contains(".index-addon-sources > li", "Index Scope E2E desktop").as("row");
      toggleOf("@row", "전체 적용").click();
      cy.get("@row").should("contain.text", "적용: 모든 프로젝트");
      for (const name of ["core", "frontend", "tools"]) toggleOf("@row", name).should("have.attr", "aria-checked", "true");
      // 전체 적용을 끄면 보이는 프로젝트를 모두 고른 채로 남는다(새 프로젝트만 자동으로 들어오지 않는다).
      toggleOf("@row", "전체 적용").click();
      toggleOf("@row", "전체 적용").should("have.attr", "aria-checked", "false");
      cy.get("@row").should("contain.text", "적용: core, frontend, tools");
      toggleOf("@row", "전체 적용").click();
      cy.get("@row").should("contain.text", "적용: 모든 프로젝트");
    });
    invoke("list_agent_index_sources", { request: { project: "" } }).its("body.sources").should("have.length", 1);
  });

  it("폰 폭에서도 적용 프로젝트 목록이 카드 밖으로 넘치지 않는다", () => {
    cy.viewport(390, 844);
    cy.visitApp();
    cy.openAddonsView("index");
    cy.anchor("addons.index-content").within(() => {
      addFolder("Index Scope E2E mobile").find(".project-registry-collapse").click();
      cy.get(".index-addon-scope .project-registry-list").should("be.visible");
    });
    cy.anchor("addons.index-content").then(($card) => {
      const card = $card[0].getBoundingClientRect();
      $card.find(".index-addon-sources > li *").each((_, element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0) return;
        expect(box.right, element.className || element.tagName).to.be.at.most(card.right + 0.5);
      });
    });
    cy.window().then((win) => {
      expect(win.document.documentElement.scrollWidth).to.be.at.most(win.innerWidth + 1);
    });
    cy.anchor("addons.index-content").find(".index-addon-scope .project-registry-list").scrollIntoView();
    cy.screenshot("index-scope-mobile-projects", { capture: "viewport" });
  });
});
