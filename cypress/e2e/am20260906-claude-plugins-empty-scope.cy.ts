// 적용 범위를 카드 하나의 전역 드롭다운으로 고르던 것이 플러그인별 토글(전역/프로젝트별/브랜치별)로
// 바뀌었다. 격리 환경에는 설치된 Claude 플러그인이 없으므로 이 시나리오가 보는 것은 빈 상태와
// 카드 머리의 범위 안내이고, 사라진 드롭다운이 되살아나지 않는지까지 함께 못박는다.
describe("애드온 클로드 플러그인 카드", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("addons").should("be.visible");
    cy.openAddonsTab("claude");
  });

  it("플러그인이 없는 환경에서 빈 상태와 적용 범위 안내를 보여준다", () => {
    cy.anchor("addons.claude-plugins-content").should("be.visible").within(() => {
      // 확인이 끝나기 전에는 로딩 안내가 자리를 잡고, 끝나면 빈 상태로 바뀐다.
      cy.contains("설치된 플러그인이 없습니다", { timeout: 20000 }).should("be.visible");
      cy.get(".plugin-loading-state").should("not.exist");
      cy.get(".plugin-list").should("not.exist");

      // 범위 안내는 플러그인 유무와 무관하게 카드 머리에 선다.
      cy.get(".claude-plugin-scopebar strong").should("have.text", "전역·프로젝트·브랜치별 적용");
      cy.get(".claude-plugin-scopebar small").should("contain.text", "전역 토글은 사용자 설정에 저장");

      // 범위는 이제 플러그인 줄마다 고르므로 카드 단위 드롭다운은 없다. 플러그인이 없으면
      // 그 줄 토글도 없다.
      cy.get(".claude-plugin-scopebar select").should("not.exist");
      cy.get(".claude-plugin-scope-toggle").should("not.exist");
    });
  });

  it("코덱스 탭을 다녀와도 빈 상태와 범위 안내가 그대로 남는다", () => {
    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.contains("설치된 플러그인이 없습니다", { timeout: 20000 }).should("be.visible");
    });

    cy.openAddonsTab("mermaid");

    cy.openAddonsTab("claude").within(() => {
      cy.contains("설치된 플러그인이 없습니다").should("be.visible");
      cy.get(".claude-plugin-scopebar strong").should("have.text", "전역·프로젝트·브랜치별 적용");
      cy.get(".error-banner").should("not.exist");
    });
  });
});
