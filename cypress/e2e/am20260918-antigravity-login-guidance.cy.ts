/// <reference types="cypress" />
import { providerState } from "../support/providerAccountFixtures";

// 2026-09-18 QA(축: 계정·사용량) — fd959505가 Antigravity를 등록 계정 공급자로
// 올리면서 계정 추가 서랍에 이 공급자만의 브라우저 계정 선택 주의와 60초 인증 코드
// 제한을 넣었다(src/components/SettingsView.tsx:1512-1514,
// src/components/TerminalPanel.tsx:157-168). 기존 AM-392~394는 반복 요청 계정 선택,
// 공유 홈 연결, 계정 0건 구획을 검증했지만 로그인 서랍의 안내·입력·취소 수명주기는
// 확인하지 않았다. 실제 공급자 인증은 시작하지 않고 typed IPC 응답만 격리 주입한다.

const emptySnapshot = {
  accounts: [],
  providers: [providerState({ provider: "antigravity" })],
  autoSwitchResume: false,
  autoSwitchPolicy: "registration",
  autoSwitchUsageGapPercent: null,
  resumeAccountPolicy: "activeAccount",
};

const login = {
  id: "antigravity-login-qa",
  provider: "antigravity",
  accountId: null,
  environmentVariable: "HOME",
  profilePath: "/tmp/am-antigravity-login-qa",
  command: "antigravity",
};

function antigravityCard() {
  return cy.get(".cli-settings-provider").filter(":has(.source-antigravity)");
}

describe("Antigravity 계정 추가 로그인 안내와 취소 수명주기", () => {
  beforeEach(() => {
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        const body = res.body as { status: { providers: Array<{ provider: string; cli: { detected: boolean } }> } };
        const antigravity = body.status.providers.find((provider) => provider.provider === "antigravity");
        if (antigravity) antigravity.cli.detected = true;
      });
    });
    cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: emptySnapshot });
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: emptySnapshot });
    cy.stubInvoke("begin_provider_account_login", { statusCode: 200, body: login }).as("beginLogin");
    cy.stubInvoke("cancel_provider_account_login", { statusCode: 200, body: null }).as("cancelLogin");

    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").should("be.visible");
  });

  it("계정 추가 서랍이 60초 제한·브라우저 계정 주의·코드 입력을 한 흐름으로 안내하고 취소한다", () => {
    antigravityCard().contains("button", "계정 추가").click();

    cy.wait("@beginLogin").its("request.body").should("deep.equal", {
      source: "antigravity",
    });

    cy.get(".drawer").should("be.visible").within(() => {
      cy.get(".drawer-title").should("contain.text", "Antigravity").and("contain.text", "계정 추가");
      cy.get(".terminal-host", { timeout: 10000 })
        .should("contain.text", "등록할 구글 계정을 고르고")
        .and("contain.text", "다른 계정을 등록하려면 브라우저에서 계정을 먼저 바꾸세요")
        .and("contain.text", "60초 안에");
      cy.get('.mobile-terminal-composer input[placeholder="브라우저 인증 코드 붙여넣기"]')
        .should("be.visible")
        .and("be.disabled");
      cy.get(".account-login-completion-hint")
        .should("contain.text", "60초 안에 터미널로 전송")
        .and("contain.text", "취소하고 다시 시작");
      cy.contains("button", "로그인 완료 저장").should("be.disabled");
      cy.contains("button", "취소").click();
    });

    cy.wait("@cancelLogin").its("request.body").should("deep.equal", {
      loginId: login.id,
    });
    cy.get(".drawer").should("not.exist");
    antigravityCard().contains("button", "계정 추가").should("be.enabled");
  });
});
