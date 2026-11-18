import { accountUsage, providerAccount, providerState } from "../support/providerAccountFixtures";

// 공유 CLI 홈의 로그인은 실행 대상인 등록 계정과 별도로 관측된다. 2026-09-18 변경은 홈에서
// 확인한 신원이 등록 계정과 같을 때 그 계정의 표시 이름을 카드에 연결한다. 기존 계정 시나리오는
// 등록 계정 행·도구 배지·페일오버 설정을 다뤘지만, 홈 카드가 accountId를 따라 같은 계정과
// 미등록 계정을 서로 다른 상태로 그리는 화면 계약은 검증하지 않았다.
const matchedAccount = providerAccount({
  id: "codex-registered-home-match",
  provider: "codex",
  displayName: "등록 Codex",
  label: "등록 Codex",
  email: "matched@example.test",
  providerAccountId: "matched@example.test",
  providerDisplayName: "Codex",
  authStatus: "ready",
});
const otherAccount = providerAccount({
  id: "claude-other-account",
  provider: "claude",
  displayName: "다른 Claude",
  label: "다른 Claude",
  email: "registered-claude@example.test",
  providerAccountId: "registered-claude@example.test",
  providerDisplayName: "Claude",
  authStatus: "ready",
});
const homeUsage = accountUsage({
  windows: [{ label: "7일", usedPercent: 42, resetsAt: Date.now() + 7 * 24 * 60 * 60 * 1000 }],
});
const snapshot = {
  accounts: [matchedAccount, otherAccount],
  providers: [
    providerState({
      provider: "codex",
      activeAccountId: matchedAccount.id,
      observedActiveAccountId: matchedAccount.id,
      home: {
        state: "verified",
        email: "matched@example.test",
        displayName: null,
        providerAccountId: "matched@example.test",
        accountId: matchedAccount.id,
        accessTokenExpiresAt: null,
        checkedAt: Date.now(),
        retryAt: null,
        error: null,
        usage: homeUsage,
      },
    }),
    providerState({
      provider: "claude",
      activeAccountId: otherAccount.id,
      observedActiveAccountId: otherAccount.id,
      home: {
        state: "verified",
        email: "unregistered@example.test",
        displayName: null,
        providerAccountId: "unregistered@example.test",
        accountId: null,
        accessTokenExpiresAt: null,
        checkedAt: Date.now(),
        retryAt: null,
        error: null,
        usage: homeUsage,
      },
    }),
  ],
  autoSwitchResume: false,
  autoSwitchPolicy: "registration",
  autoSwitchUsageGapPercent: null,
  resumeAccountPolicy: "activeAccount",
};

function providerCard(source: "codex" | "claude") {
  return cy.get(".cli-settings-provider").filter(`:has(.source-${source})`);
}

describe("공유 CLI 홈 신원과 등록 계정의 화면 연결", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("일치하는 홈만 등록 표시 이름과 연결하고 미등록 홈은 분리해 언어 전환 뒤에도 유지한다", () => {
    cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: snapshot });
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: snapshot });
    cy.visitApp();
    cy.openSettingsTab("connections");

    providerCard("codex").find(".provider-home-card")
      .should("have.class", "ready")
      .and("contain.text", "matched@example.test")
      .and("contain.text", "등록 계정 ‘등록 Codex’과 같은 계정")
      .find(".account-usage-meters").should("exist");

    providerCard("claude").find(".provider-home-card")
      .should("have.class", "muted")
      .and("contain.text", "unregistered@example.test")
      .and("contain.text", "등록되지 않은 계정")
      .and("not.contain.text", "다른 Claude와 같은 계정");

    cy.setLanguage("en");
    cy.openSettingsTab("connections");
    providerCard("codex").find(".provider-home-card")
      .should("contain.text", "Same account as registered ‘등록 Codex’");
    providerCard("claude").find(".provider-home-card")
      .should("contain.text", "Not a registered account");
  });
});
