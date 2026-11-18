describe("외부 플러그인 추가 폼 프리셋 전환", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openAddonsView("mcp");
    cy.anchor("addons.mcp-content").should("be.visible");
    cy.anchor("addons.mcp-content").contains("button", "플러그인 추가").click();
    cy.get(".plugin-form").should("be.visible");
  });

  // 표식은 서비스(프리셋 id)를 먼저 찾고 없으면 브랜드로 떨어진다. 그래서 Jira는 아틀라시안
  // 공용 로고가 아니라 Jira 로고를 쓴다 — 브랜드만 보던 때는 한 브랜드의 서비스 여럿이 모두
  // 같은 로고였다.
  it("프리셋 표식은 서비스 로고를 쓰고, 없으면 브랜드 로고로 떨어진다", () => {
    const marks = () => cy.get(".plugin-presets .plugin-preset img.brand-mark");
    marks().should("have.length.at.least", 1);
    marks().each(($img) => {
      expect($img.attr("src") ?? "", "표식은 팩에서 뽑은 SVG여야 한다").to.match(/^data:image\/svg\+xml,/);
    });
    // Jira 프리셋은 서비스 로고(logos:jira)를 쓴다.
    cy.contains(".plugin-presets .plugin-preset", "Jira").find("img.jira-mark").should("exist");
    cy.contains(".plugin-presets .plugin-preset", "Jira").find("img.atlassian-mark").should("not.exist");
    // 서비스 id와 브랜드가 같은 자리는 그대로 하나다.
    cy.contains(".plugin-presets .plugin-preset", "GitHub").find("img.github-mark").should("exist");
  });

  it("프리셋을 바꾸면 사용자가 고친 값이 버려지고 인증 방식에 따라 주소·토큰 칸이 바뀐다", () => {
    // 폼을 열면 Notion OAuth 프리셋이 눌린 상태로 시작한다
    cy.get(".plugin-presets .plugin-preset").eq(0).should("have.attr", "aria-pressed", "true");
    cy.get("#plugin-id").should("have.value", "notion");
    cy.get("#plugin-url").should("exist").invoke("val").should("not.be.empty");
    cy.get("#plugin-token").should("not.exist");

    // 사용자가 표시 이름과 식별자를 고친다
    cy.get("#plugin-name").clear().type("내가 고친 이름");
    cy.get("#plugin-id").clear().type("my-notion");

    // 내부 통합 토큰 프리셋으로 전환하면 고친 값이 프리셋 기본값으로 되돌아간다
    cy.get(".plugin-presets .plugin-preset").eq(1).click();
    cy.get(".plugin-presets .plugin-preset").eq(1).should("have.attr", "aria-pressed", "true");
    cy.get(".plugin-presets .plugin-preset").eq(0).should("have.attr", "aria-pressed", "false");
    cy.get("#plugin-id").should("have.value", "notion");
    cy.get("#plugin-name").should("have.value", "Notion");
    // 토큰 인증이므로 MCP 주소 칸은 사라지고 토큰 칸이 나타난다
    cy.get("#plugin-url").should("not.exist");
    cy.get("#plugin-token").should("be.visible").should("have.value", "");
    cy.get("#plugin-token").should("have.attr", "type", "password");
    cy.get("#plugin-token").should("have.attr", "placeholder", "ntn_…");

    // 토큰을 입력한 뒤 직접 입력 프리셋으로 넘어가면 식별자·이름이 비고 주소 칸이 돌아온다
    cy.get("#plugin-token").type("ntn_secret_value");
    cy.get(".plugin-presets .plugin-preset").last().click();
    cy.get(".plugin-presets .plugin-preset").last().should("have.attr", "aria-pressed", "true");
    cy.get(".plugin-presets .plugin-preset").eq(1).should("have.attr", "aria-pressed", "false");
    cy.get("#plugin-id").should("have.value", "");
    cy.get("#plugin-name").should("have.value", "");
    cy.get("#plugin-url").should("be.visible").should("have.value", "");
    cy.get("#plugin-token").should("not.exist");

    // 다시 Notion OAuth로 돌아와도 앞서 입력한 토큰이 되살아나지 않는다
    cy.get(".plugin-presets .plugin-preset").eq(0).click();
    cy.get("#plugin-id").should("have.value", "notion");
    cy.get("#plugin-token").should("not.exist");
    cy.get(".plugin-presets .plugin-preset").eq(1).click();
    cy.get("#plugin-token").should("have.value", "");
  });
});
