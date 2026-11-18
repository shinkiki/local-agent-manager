/**
 * 외부 MCP 플러그인 OAuth(콜백 흐름) 시작 뒤 인가 주소 안내 모달.
 *
 * 브라우저 열기는 OS 셸에 맡기는 자리라 실패해도 앱은 알 수 없다(Windows ShellExecute는
 * https 핸들러가 비어 있어도 성공을 돌려준다). 디바이스 인가에만 있던 "다시 열기" 모달이
 * 콜백 흐름에는 없어, Windows에서 브라우저가 안 뜨면 사용자는 취소밖에 못 했다. 이 스펙은
 * 인증 시작 직후 주소가 화면에 남고, 열기가 예외로 죽어도 주소는 남으며, 승인이 끝나
 * 대기가 풀리면 모달이 스스로 닫히는 것을 본다. 격리 백엔드에는 플러그인이 없으므로 목록과
 * 시작 응답을 세운다.
 *
 * 2026-10-11부터 콜백 흐름은 브라우저가 다른 기기에 있어도 끝난다 — 승인 뒤 멈춘 콜백 주소를
 * 모달에 붙여 넣는다. 거절된 붙여넣기는 모달 안에 사유를 남기고 다시 받는 것도 여기서 본다.
 */

const AUTH_URL = "https://mcp.notion.so/authorize?client_id=am-e2e&state=s-1&code_challenge=c-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A48999%2Fcallback";
let pending = false;

function pluginView() {
  return {
    id: "notion",
    displayName: "Notion",
    url: "https://mcp.notion.so",
    auth: "oauth",
    enabled: true,
    toolPolicies: {},
    credentialReady: false,
    oauthPending: pending,
    attachable: true,
    serverName: "notion",
    tools: [],
    lastVerifiedAt: null,
    lastError: null,
    authorizedAt: null,
    accessExpiresAt: null,
    createdAt: 1_757_000_000_000,
    updatedAt: 1_757_000_000_000,
  };
}

function pluginsSnapshot() {
  return {
    plugins: [pluginView()],
    proxyReady: true,
    nodeAvailable: true,
    maxPlugins: 5,
    notionHostedUrl: "https://mcp.notion.so",
    notionLocalPackage: "@notionhq/notion-mcp-server",
    hostedPresets: [],
  };
}

function signInButton() {
  return cy.get(".plugin-row").contains("button", "인증");
}

describe("외부 MCP OAuth 시작 뒤 인가 주소 안내 모달", () => {
  beforeEach(() => {
    pending = false;
    cy.stubInvoke("get_external_plugins", (req) => { req.reply(pluginsSnapshot()); });
    cy.stubInvoke("begin_external_plugin_oauth", (req) => {
      pending = true;
      req.reply({ id: "notion", authorizationUrl: AUTH_URL, expiresAt: Date.now() + 600_000, userCode: null });
    }).as("begin");
    cy.stubInvoke("cancel_external_plugin_oauth", (req) => {
      pending = false;
      req.reply(pluginView());
    }).as("cancel");

    cy.visitApp();
    cy.openAddonsView("mcp");
    cy.anchor("addons.mcp-content").should("be.visible");
    signInButton().should("be.visible");
  });

  it("인증을 시작하면 브라우저를 열기와 별개로 인가 주소가 모달에 남고 복사·다시 열기가 된다", () => {
    cy.window().then((win) => { cy.stub(win, "open").as("open").returns(null); });
    signInButton().click();
    cy.wait("@begin");

    cy.contains(".modal-title", "브라우저 승인 · Notion").should("be.visible");
    cy.get("[data-testid='plugin-oauth-url'] code").should("have.text", AUTH_URL);
    cy.get("@open").should("have.been.calledOnceWith", AUTH_URL, "_blank", "noopener,noreferrer");

    // 콜백 흐름에는 사용자 코드가 없다.
    cy.get(".plugin-device-code").should("not.exist");

    cy.contains("button", "승인 화면 다시 열기").click();
    cy.get("@open").should("have.been.calledTwice");

    cy.get("[data-testid='plugin-oauth-url'] .copy-action").should("have.attr", "aria-label", "주소 복사");
  });

  it("브라우저 열기가 예외로 끝나도 오류가 보이고 주소 모달은 그대로 남는다", () => {
    cy.window().then((win) => { cy.stub(win, "open").throws(new Error("shell refused")); });
    signInButton().click();
    cy.wait("@begin");

    cy.get("[data-testid='plugin-oauth-url'] code").should("have.text", AUTH_URL);
    cy.contains(".error-banner", "shell refused").should("exist");
  });

  it("승인이 끝나 대기가 풀리면 모달이 닫히고, 취소는 대기를 거둔다", () => {
    cy.window().then((win) => { cy.stub(win, "open").returns(null); });
    signInButton().click();
    cy.wait("@begin");
    cy.get("[data-testid='plugin-oauth-url']").should("be.visible");
    cy.get(".plugin-row").contains("button", "취소").should("be.visible");

    // 승인 완료: 다음 조회부터 대기가 풀린다. 취소 버튼 없는 상태 갱신은 목록 재조회로 본다.
    cy.contains("button", "인증 취소").click();
    cy.wait("@cancel");
    cy.get("[data-testid='plugin-oauth-url']").should("not.exist");
    signInButton().should("be.visible");
  });

  it("콜백 흐름은 승인 뒤 멈춘 주소를 붙여 넣어 끝내고, 거절되면 모달 안에서 다시 받는다", () => {
    const callback = "http://127.0.0.1:48999/callback?code=c-1&state=s-1";
    const sent: string[] = [];
    cy.window().then((win) => { cy.stub(win, "open").returns(null); });
    cy.stubInvoke("begin_external_plugin_oauth", (req) => {
      pending = true;
      req.reply({ id: "notion", authorizationUrl: AUTH_URL, expiresAt: Date.now() + 600_000, userCode: null, acceptsCallbackPaste: true });
    }).as("beginPaste");
    cy.stubInvoke("submit_external_plugin_oauth_callback", (req) => {
      sent.push(String(req.body?.params?.callbackUrl ?? req.body?.callbackUrl ?? ""));
      if (sent.length === 1) {
        req.reply({ statusCode: 409, body: { error: "state가 이 인증과 맞지 않습니다" } });
        return;
      }
      // 백엔드 대기 스레드가 code를 교환해 대기를 푼 상태로 본다.
      pending = false;
      req.reply(pluginView());
    }).as("submit");

    signInButton().click();
    cy.wait("@beginPaste");
    cy.get("[data-testid='plugin-oauth-paste']").should("be.visible");
    cy.get("[data-testid='plugin-oauth-paste']").contains("button", "승인 완료").should("be.disabled");

    cy.get("#plugin-oauth-callback").type("http://127.0.0.1:48999/callback?code=old&state=other");
    cy.get("[data-testid='plugin-oauth-paste']").contains("button", "승인 완료").click();
    cy.wait("@submit");
    cy.contains(".plugin-oauth-paste-error", "state가 이 인증과 맞지 않습니다").should("be.visible");
    cy.get("[data-testid='plugin-oauth-url']").should("be.visible");

    cy.get("#plugin-oauth-callback").clear().type(`${callback}{enter}`);
    cy.wait("@submit").then(() => { expect(sent[1]).to.contain("code=c-1"); });
    cy.get(".plugin-oauth-paste-error").should("not.exist");
    cy.get("[data-testid='plugin-oauth-url']").should("not.exist");
  });
});
