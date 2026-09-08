describe("외부 플러그인 추가 폼 프리셋 전환", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.settings").click();
    cy.view("settings").should("exist");
    cy.anchor("settings.tab.plugins").click();
    cy.anchor("settings.plugins").click();
    cy.anchor("settings.external-plugins-content").should("be.visible");
    cy.anchor("settings.external-plugins-content").contains("button", "플러그인 추가").click();
    cy.get(".plugin-form").should("be.visible");
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
