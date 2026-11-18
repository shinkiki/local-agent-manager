/// <reference types="cypress" />
// C20 접근 채널 로그인 게이트. 악수(`/api/access`)가 "이 채널은 비밀번호를 요구하는데 세션이
// 없다"고 답하면 앱 셸 대신 로그인 화면이 서고, `/api/login`이 토큰을 주면 그 토큰이 뒤따르는
// 모든 명령 요청의 `X-Agent-Manager-Session` 헤더에 실린 채 앱이 열린다(LoginGate.tsx·
// loginSession.ts·ipcTransport.ts).
//
// 격리 백엔드의 로그인 설정은 비어 있으므로 요구 자체를 `/api/access` 응답에서 만든다 —
// 토큰 헤더가 없으면 "비밀번호 필요·미인증", 있으면 "인증됨"으로 답한다. `/api/login`도
// 가로채 실제 비밀번호 검증 없이 토큰을 돌려준다. 백엔드 저장값 어디에도 닿지 않는다.
const TOKEN = "e2e-session-token";
const HEADER = "x-agent-manager-session";

function stubGatedAccess() {
  cy.intercept("GET", "**/api/access", (req) => {
    const signedIn = req.headers[HEADER] === TOKEN;
    req.continue((res) => {
      Object.assign(res.body as Record<string, unknown>, {
        channel: "localBrowser",
        authenticated: signedIn,
        loginRequired: { password: true, otp: false },
      });
    });
  }).as("access");
}

describe("C20 · 로그인 게이트", () => {
  beforeEach(() => {
    // 앞선 스펙이 남긴 토큰이 있으면 게이트가 열린 채로 시작하므로 지운다.
    cy.visit("/", { onBeforeLoad: (win) => win.localStorage.removeItem("agentManager.loginSession") });
  });

  it("세션이 없으면 로그인 화면만 서고, 틀린 값은 배너로 알리며, 맞으면 토큰을 헤더에 싣고 앱을 연다", () => {
    stubGatedAccess();
    const logins: Array<Record<string, unknown>> = [];
    cy.intercept("POST", "**/api/login", (req) => {
      logins.push(req.body as Record<string, unknown>);
      if ((req.body as { password?: string }).password !== "correct-horse") {
        req.reply({ statusCode: 401, body: { error: "아이디·비밀번호 또는 OTP가 맞지 않습니다", code: "LOGIN_INVALID", params: {} } });
        return;
      }
      req.reply({ statusCode: 200, body: { token: TOKEN, sessionId: "s1", expiresAt: Date.now() + 60_000 } });
    }).as("login");
    const invokeHeaders: Array<string | undefined> = [];
    cy.intercept("POST", "**/api/invoke/get_manager_snapshot", (req) => {
      invokeHeaders.push(req.headers[HEADER] as string | undefined);
      req.continue();
    }).as("snapshot");

    cy.visitApp();

    // 1) 앱 셸 대신 게이트가 선다. 비밀번호만 요구하므로 OTP 칸은 없다.
    cy.anchor("login.gate").should("be.visible");
    cy.anchor("nav.settings").should("not.exist");
    cy.get('.login-gate input[name="userId"]').should("exist");
    cy.get('.login-gate input[name="password"]').should("exist");
    cy.get('.login-gate input[name="otp"]').should("not.exist");
    cy.get(".login-gate-help").should("contain.text", "--reset-login");

    // 2) 틀린 값은 게이트 안 배너로 알리고 화면을 떠나지 않는다.
    cy.get('.login-gate input[name="userId"]').type("shin");
    cy.get('.login-gate input[name="password"]').type("wrong-wrong{enter}");
    cy.wait("@login");
    cy.get(".login-gate .error-banner").should("contain.text", "맞지 않습니다");
    cy.anchor("login.gate").should("be.visible");

    // 3) 맞는 값이면 앱이 열리고, 그 뒤의 명령 요청은 모두 토큰 헤더를 단다.
    cy.get('.login-gate input[name="password"]').clear().type("correct-horse{enter}");
    cy.wait("@login");
    cy.anchor("login.gate").should("not.exist");
    cy.anchor("nav.settings").should("exist");
    cy.wait("@snapshot");
    cy.then(() => {
      expect(logins.map((body) => body.userId), "보낸 아이디").to.deep.eq(["shin", "shin"]);
      expect(invokeHeaders.length, "명령 요청 수").to.be.greaterThan(0);
      expect(new Set(invokeHeaders), "모든 명령 요청의 세션 헤더").to.deep.eq(new Set([TOKEN]));
    });

    // 4) 새로고침해도 토큰이 남아 게이트 없이 열린다.
    cy.reload();
    cy.anchor("nav.settings").should("exist");
    cy.anchor("login.gate").should("not.exist");
  });

  it("앱이 열린 뒤 어느 요청이 401 LOGIN_REQUIRED로 거절되면 앱 위에 게이트가 다시 선다", () => {
    cy.visitApp();
    cy.anchor("nav.settings").should("exist");
    cy.stubInvoke("get_tailscale_service_status", {
      statusCode: 401,
      body: { error: "로그인이 필요합니다", code: "LOGIN_REQUIRED", params: { password: "false", otp: "true" } },
    });
    cy.openSettingsTab("service");

    // 앱은 내려가지 않고(설정 화면이 그대로) 그 위에 OTP 칸만 있는 게이트가 겹친다.
    cy.anchor("login.gate").should("be.visible").and("have.class", "overlay");
    cy.get('.login-gate input[name="otp"]').should("exist");
    cy.get('.login-gate input[name="password"]').should("not.exist");
    cy.view("settings").should("exist");
  });
});
