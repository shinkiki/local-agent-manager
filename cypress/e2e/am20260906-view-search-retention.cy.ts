// 임시 스펙: 주 메뉴 화면들은 한 번 열면 마운트된 채 남는다(App.tsx의 mountedViews).
// 그래서 화면을 옮겼다 돌아와도 각 화면이 들고 있던 검색어가 살아 있어야 하고, 서로
// 다른 화면의 검색어가 섞이지 않아야 하며, 새로고침하면 모두 초기화되어야 한다.
// 개별 화면 스펙(AM-63 에이전트, AM-40 스킬)은 한 화면 안에서만 봤고, 화면 사이를
// 오가는 잔존과 새로고침 초기화는 이 스펙이 처음 본다.
describe("주 메뉴 화면의 검색어가 화면 전환에는 남고 새로고침에는 사라진다", () => {
  const search = (view: string) => cy.get(`[data-view="${view}"]:not([hidden]) .search-input`);

  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
  });

  it("열지 않은 화면은 아직 DOM에 없다", () => {
    cy.get('[data-view="agents"]').should("not.exist");
    cy.get('[data-view="artifacts"]').should("not.exist");
    cy.anchor("nav.agents").click();
    cy.view("agents").should("be.visible");
    // 다른 화면으로 떠나도 마운트는 남고 숨겨지기만 한다.
    cy.anchor("nav.dashboard").click();
    cy.get('[data-view="agents"]').should("exist").and("have.attr", "hidden");
  });

  it("세 화면의 검색어가 서로 섞이지 않고 각자 남는다", () => {
    cy.anchor("nav.agents").click();
    search("agents").type("reviewer");
    cy.anchor("nav.artifacts").click();
    search("artifacts").type("summary-doc");
    cy.anchor("nav.skills").click();
    search("skills").type("release");

    cy.anchor("nav.agents").click();
    search("agents").should("have.value", "reviewer");
    cy.anchor("nav.artifacts").click();
    search("artifacts").should("have.value", "summary-doc");
    cy.anchor("nav.skills").click();
    search("skills").should("have.value", "release");
  });

  it("새로고침하면 검색어가 남지 않는다", () => {
    cy.anchor("nav.agents").click();
    search("agents").type("reviewer").should("have.value", "reviewer");
    cy.reload();
    cy.anchor("nav.agents").should("be.visible").click();
    search("agents").should("have.value", "");
  });
});
