// 인덱스 애드온 적용 프로젝트: 프로젝트 목록을 활성여부 카드처럼 보여 주고, 켠 프로젝트의 폴더를
// 백엔드가 자동 등록·색인한다. 기본은 전체 적용(새 프로젝트 포함), 하나를 끄면 전체 적용이 풀린다.
// 프로젝트 목록만 가로채고 적용 설정 저장은 격리 백엔드가 실제로 처리한다. 폴더 등록·삭제는
// 백엔드 등록부를 따르므로 Rust 시험(index_addon project_*)이 맡는다.
describe("인덱스 애드온 프로젝트 적용", () => {
  const root = String(Cypress.config("projectRoot")).replace(/\/$/, "");
  const invoke = (command: string, body = {}) => cy.request("POST", `/api/invoke/${command}`, body);
  const project = (dir: string, name: string) => ({
    path: `${root}/${dir}`, name, sessionCount: 1, hiddenSessionCount: 0, updatedAt: null,
    providers: ["claude"], active: true, pending: false, exists: true,
  });
  const section = () => cy.anchor("addons.index-content").find(".index-addon-apply");
  // 이름 칸으로만 찾는다. 경로까지 보면 저장소 경로에 프로젝트 이름이 든 실행기에서 엉뚱한 줄을 잡는다.
  const row = (label: string) => section().contains(".project-registry-name strong", new RegExp(`^${label}$`)).closest(".project-registry-row");
  const toggle = (label: string) => row(label).find("[role=switch]");
  const settled = () => toggle("전체 적용").should("be.enabled");

  beforeEach(() => {
    cy.stubInvoke("get_project_registry", { statusCode: 200, body: [project("src", "frontend"), project("crates", "core"), project("scripts", "tools")] });
  });
  afterEach(() => {
    invoke("set_index_projects", { request: { mode: "all", projects: [] } });
    invoke("set_index_settings", { request: { enabled: false, autoRefresh: false } });
  });

  it("기본은 전체 적용이고, 프로젝트를 끄면 전체 적용이 풀린 선택 적용으로 저장된다", () => {
    cy.viewport(1280, 900);
    cy.visitApp();
    cy.openAddonsView("index");
    cy.anchor("addons.index-content").contains("label", "인덱스 사용").find("input").check();
    // 폴더 경로를 넣지 않는다. 프로젝트 목록이 바로 보이고 모두 켜져 있다.
    toggle("전체 적용").should("have.attr", "aria-checked", "true");
    for (const name of ["core", "frontend", "tools"]) toggle(name).should("have.attr", "aria-checked", "true");
    row("전체 적용").should("contain.text", "3/3개 적용");
    row("frontend").should("contain.text", `${root}/src`).and("not.contain.text", "적용 안 함");
    cy.screenshot("index-apply-desktop-all", { capture: "viewport" });

    toggle("tools").click();
    settled();
    toggle("전체 적용").should("have.attr", "aria-checked", "false");
    toggle("tools").should("have.attr", "aria-checked", "false");
    row("tools").should("contain.text", "적용 안 함");
    row("전체 적용").should("contain.text", "2/3개 적용");
    invoke("get_index_sources").its("body").then((body) => {
      expect(body.projectMode).to.eq("selected");
      expect([...body.selectedProjects].sort()).to.deep.eq([`${root}/crates`, `${root}/src`]);
    });
    // 선택 적용에서는 다시 켜고, 모두 꺼도 된다(아무 프로젝트도 쓰지 않음).
    toggle("tools").click();
    settled();
    toggle("tools").should("have.attr", "aria-checked", "true");
    toggle("전체 적용").should("have.attr", "aria-checked", "false");
    for (const name of ["core", "frontend", "tools"]) { toggle(name).click(); settled(); }
    row("전체 적용").should("contain.text", "0/3개 적용");
    invoke("get_index_sources").its("body.selectedProjects").should("have.length", 0);
    cy.screenshot("index-apply-desktop-selected", { capture: "viewport" });

    // 전체 적용을 켜면 모두 켜지고 새 프로젝트도 따라온다.
    toggle("전체 적용").click();
    settled();
    for (const name of ["core", "frontend", "tools"]) toggle(name).should("have.attr", "aria-checked", "true");
    invoke("get_index_sources").its("body").then((body) => {
      expect(body.projectMode).to.eq("all");
      expect(body.selectedProjects).to.have.length(0);
    });
    // 전체 적용을 끄면 보이는 프로젝트를 모두 고른 채로 남는다.
    toggle("전체 적용").click();
    settled();
    toggle("전체 적용").should("have.attr", "aria-checked", "false");
    for (const name of ["core", "frontend", "tools"]) toggle(name).should("have.attr", "aria-checked", "true");
    invoke("get_index_sources").its("body.selectedProjects").should("have.length", 3);
    // 직접 등록한 폴더 목록에는 프로젝트 폴더가 섞이지 않는다.
    cy.anchor("addons.index-content").contains("직접 추가한 폴더가 없습니다").should("be.visible");
  });

  it("인덱스가 꺼져 있으면 설정만 저장된다고 알리고, 폰 폭에서도 넘치지 않는다", () => {
    cy.viewport(390, 844);
    cy.visitApp();
    cy.openAddonsView("index");
    section().should("contain.text", "인덱스 사용이 꺼져 있어 적용 설정만 저장됩니다");
    row("frontend").should("contain.text", "인덱스 사용을 켜면 등록됩니다");
    cy.anchor("addons.index-content").then(($card) => {
      const card = $card[0].getBoundingClientRect();
      $card.find(".index-addon-apply *").each((_, element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0) return;
        expect(box.right, element.className || element.tagName).to.be.at.most(card.right + 0.5);
      });
    });
    cy.window().then((win) => {
      expect(win.document.documentElement.scrollWidth).to.be.at.most(win.innerWidth + 1);
    });
    section().scrollIntoView();
    cy.screenshot("index-apply-mobile", { capture: "viewport" });
  });
});
