// 외부 플러그인(MCP) 등록 폼에서 OAuth 보조 입력의 짝 조건이 등록 버튼을 잠그는 자리.
// 프리셋 전환(am20260907-external-plugin-preset-switch)과 취소 초기화
// (am20260906-external-plugin-form-cancel)는 이미 있고, client_secret·디바이스 인가의
// 게이트는 어느 스펙도 건드리지 않았다. 게이트가 풀리면 client_id 없는 secret이나
// client_id 없는 디바이스 인가가 그대로 등록돼 인증이 시작조차 못 한다.
describe("외부 플러그인 등록 폼 OAuth 보조 입력 게이트", () => {
  const registerButton = () => cy.get(".plugin-form .form-actions").contains("button", "등록");

  beforeEach(() => {
    cy.visitApp();
    cy.openAddonsView("mcp");
    cy.anchor("addons.mcp-content").should("be.visible");
    cy.anchor("addons.mcp-content").contains("button", "플러그인 추가").click();
    cy.get(".plugin-form").should("be.visible");
    // 직접 입력 프리셋에서 시작해 최소 입력(식별자·표시 이름·주소)만 채운다.
    cy.get(".plugin-presets .plugin-preset").last().click();
    cy.get("#plugin-id").clear().type("gate-check");
    cy.get("#plugin-name").clear().type("게이트 확인");
    cy.get("#plugin-url").clear().type("https://mcp.example.com/mcp");
    registerButton().should("not.be.disabled");
  });

  it("client_secret만 있으면 등록이 잠기고 client_id를 채워야 풀린다", () => {
    cy.get("#plugin-auth").select("oauth");
    // OAuth 계열에서만 보조 입력이 나타난다.
    cy.get("#plugin-client").should("be.visible");
    cy.get("#plugin-client-secret").should("be.visible").should("have.attr", "type", "password");
    registerButton().should("not.be.disabled");

    cy.get("#plugin-client-secret").type("secret-without-id");
    cy.contains(".plugin-field-note", "client_secret은 client_id와 함께 입력해야 합니다.").should("be.visible");
    registerButton().should("be.disabled");

    // 공백만 넣은 client_id는 채운 것으로 치지 않는다(경계).
    cy.get("#plugin-client").type("   ");
    registerButton().should("be.disabled");

    cy.get("#plugin-client").clear().type("client-1234");
    cy.contains(".plugin-field-note", "client_secret은 client_id와 함께 입력해야 합니다.").should("not.exist");
    registerButton().should("not.be.disabled");

    // secret을 다시 비우면 client_id만 남아도 등록은 열린 채로 있다.
    cy.get("#plugin-client-secret").clear();
    registerButton().should("not.be.disabled");
  });

  it("디바이스 인가는 client_id 없이는 등록이 잠기고 client_secret 칸이 사라진다", () => {
    cy.get("#plugin-auth").select("oauthDevice");
    cy.get("#plugin-client-secret").should("not.exist");
    cy.contains(".plugin-field-note", "디바이스 인가는 자동 등록이 없어 client_id가 반드시 필요합니다.").should("be.visible");
    registerButton().should("be.disabled");

    cy.get("#plugin-client").type("   ");
    registerButton().should("be.disabled");

    cy.get("#plugin-client").clear().type("device-client");
    cy.contains(".plugin-field-note", "디바이스 인가는 자동 등록이 없어 client_id가 반드시 필요합니다.").should("not.exist");
    registerButton().should("not.be.disabled");

    // 인증 없음으로 되돌리면 보조 입력이 통째로 사라지고 등록은 열려 있다.
    cy.get("#plugin-auth").select("none");
    cy.get("#plugin-client").should("not.exist");
    registerButton().should("not.be.disabled");
  });
});
