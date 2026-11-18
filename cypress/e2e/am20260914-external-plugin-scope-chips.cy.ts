// 외부 플러그인(MCP) 추가 폼의 권한 범위(scope) 칩. 프리셋 전환(am20260907-…-preset-switch)과
// 인증 방식별 등록 경계(am20260914-…-oauth-field-gates)는 scope 칸을 건드리지 않는다.
// 칩은 사용자가 실제로 요청할 권한을 정하는 자리라, 토글이 문자열을 잘못 깎으면 과도한
// 권한을 요청하거나 필요한 권한이 빠진 채 인증이 시작된다.
describe("외부 플러그인 폼 권한 범위 칩", () => {
  const DEFAULT_SCOPE = "repo read:org read:user";
  const chips = () => cy.get(".plugin-scope-chips");
  const chip = (label: string) => chips().contains("button", new RegExp(`^${label}$`));

  beforeEach(() => {
    cy.visitApp();
    cy.openAddonsView("mcp");
    cy.anchor("addons.mcp-content").should("be.visible");
    cy.anchor("addons.mcp-content").contains("button", "플러그인 추가").click();
    cy.get(".plugin-form").should("be.visible");
    // GitHub 프리셋은 scope 목록과 기본값을 함께 들고 오는 자리다(디바이스 인가).
    cy.contains(".plugin-presets .plugin-preset", "GitHub").click();
    cy.get("#plugin-scope").should("have.value", DEFAULT_SCOPE);
  });

  it("기본값과 같은 동안에는 되돌리기 칩이 없고, 켜진 칩은 기본값과 정확히 일치한다", () => {
    chips().should("be.visible");
    chip("repo").should("have.attr", "aria-pressed", "true");
    chip("read:org").should("have.attr", "aria-pressed", "true");
    chip("read:user").should("have.attr", "aria-pressed", "true");
    chip("delete_repo").should("have.attr", "aria-pressed", "false");
    chips().contains("button", "기본값으로").should("not.exist");
  });

  it("칩을 켜고 끄면 scope 문자열이 그대로 따라오고 되돌리기가 기본값을 복원한다", () => {
    // 켜면 끝에 붙는다.
    chip("delete_repo").click();
    cy.get("#plugin-scope").should("have.value", `${DEFAULT_SCOPE} delete_repo`);
    chip("delete_repo").should("have.attr", "aria-pressed", "true");
    chips().contains("button", "기본값으로").should("be.visible");

    // 끄면 가운데 것만 빠지고 나머지 순서는 유지된다.
    chip("read:org").click();
    cy.get("#plugin-scope").should("have.value", "repo read:user delete_repo");
    chip("read:org").should("have.attr", "aria-pressed", "false");

    // 되돌리기는 기본값 문자열을 그대로 되돌려 놓는다.
    chips().contains("button", "기본값으로").click();
    cy.get("#plugin-scope").should("have.value", DEFAULT_SCOPE);
    chip("delete_repo").should("have.attr", "aria-pressed", "false");
    chip("read:org").should("have.attr", "aria-pressed", "true");
    chips().contains("button", "기본값으로").should("not.exist");
  });

  it("직접 비우거나 공백만 남기면 칩이 모두 꺼지고, 공백 차이는 기본값과 같은 것으로 본다", () => {
    // 빈 scope는 "서버가 광고한 범위 그대로"를 뜻한다 — 칩은 하나도 켜지지 않는다.
    cy.get("#plugin-scope").clear();
    chip("repo").should("have.attr", "aria-pressed", "false");
    chip("read:user").should("have.attr", "aria-pressed", "false");
    chips().contains("button", "기본값으로").should("be.visible");

    // 앞뒤 공백만 다른 기본값은 되돌릴 것이 없으므로 되돌리기 칩이 사라진다(trim 경계).
    cy.get("#plugin-scope").type(`  ${DEFAULT_SCOPE}  `);
    chip("repo").should("have.attr", "aria-pressed", "true");
    chips().contains("button", "기본값으로").should("not.exist");

    // 그 상태에서 칩을 켜면 사이 공백이 한 칸으로 정리된 문자열이 된다.
    chip("gist").click();
    cy.get("#plugin-scope").should("have.value", `${DEFAULT_SCOPE} gist`);
  });

  it("프리셋을 바꾸면 그 프리셋의 기본 scope와 칩 목록으로 갈아끼워진다", () => {
    chip("delete_repo").click();
    cy.contains(".plugin-presets .plugin-preset", "Jira").click();
    cy.get("#plugin-scope").invoke("val").should("contain", "read:jira:agent-interface");
    cy.get("#plugin-scope").invoke("val").should("not.contain", "delete_repo");
    chips().contains("button", "delete_repo").should("not.exist");
    chip("read:jira:agent-interface").should("have.attr", "aria-pressed", "true");
    chips().contains("button", "기본값으로").should("not.exist");
  });
});
