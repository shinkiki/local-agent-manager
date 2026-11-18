/// <reference types="cypress" />

import { accountUsage, providerAccount, providerState, stubLocalLlmDisconnected } from "../support/providerAccountFixtures";

// V2: 최초 조회 실패와 달리 재조회 실패는 이미 그린 소비 막대를 지우면 안 된다.
// 실제 새로고침으로 성공 → 실패 → 복구를 만들고 안내와 수치를 함께 검증한다.
describe("대시보드 사용량 이력 재조회", () => {
  for (const [label, width, height] of [["PC", 1440, 900], ["모바일", 390, 844]] as const) {
    it(`V2 ${label}: 재조회 실패 때 막대를 보존하고 재시도 성공 때 새 수치로 복구한다`, { retries: 0 }, () => {
      cy.viewport(width, height);
      const now = Date.UTC(2026, 5, 18, 12);
      const day = 86_400_000;
      let phase: "initial" | "failed" | "recovered" = "initial";
      let originalLabel = "";
      const failure = "시험용 이력 재조회 실패";
      const account = providerAccount({
        displayName: "이력 재조회 계정",
        usage: accountUsage({ updatedAt: now, windows: [{ label: "7일", usedPercent: 42, resetsAt: null }] }),
      });
      const snapshot = () => ({
        accounts: [{ ...account, note: phase }],
        providers: [providerState({ activeAccountId: account.id })],
        autoSwitchResume: false, autoSwitchPolicy: "registration",
        autoSwitchUsageGapPercent: null, resumeAccountPolicy: "activeAccount",
      });
      const panel = () => cy.anchor("dashboard.account-usage");
      const currentBar = () => panel().find(".account-usage-bar").last();
      const refresh = () => cy.get(".statusbar-refresh").should("not.be.disabled").click();

      cy.clock(now, ["Date"]);
      stubLocalLlmDisconnected();
      cy.stubInvoke("get_antigravity_pacing_usage", { statusCode: 200, body: [] });
      cy.stubInvoke("get_provider_accounts", (req) => req.reply({ statusCode: 200, body: snapshot() }));
      cy.stubInvoke("refresh_provider_account_usages", (req) => req.reply({ statusCode: 200, body: snapshot() }));
      cy.stubInvoke("get_account_usage_history", (req) => {
        req.alias = `history-${phase}`;
        if (phase === "failed") {
          req.reply({ statusCode: 500, body: { error: failure } });
          return;
        }
        req.reply({ statusCode: 200, body: { accounts: [{
          accountId: account.id, observedSince: now - 210 * day,
          cycles: [{ windowLabel: "7일", windowLengthMs: 7 * day,
            resetsAt: now + day, peakUsedPercent: phase === "initial" ? 20 : 90,
            firstObservedAt: now - 6 * day, lastObservedAt: now }],
        }] } });
      });

      cy.visitApp();
      cy.wait("@history-initial");
      panel().find(".account-usage-bar").should("have.length", 6);
      currentBar().should("not.have.class", "empty").and(($bar) => {
        expect($bar.attr("aria-label")).to.match(/소진율 \d+%$/u);
      }).then(($bar) => { originalLabel = $bar.attr("aria-label")!; });
      panel().find(".account-usage-history-error").should("not.exist");

      cy.then(() => { phase = "failed"; });
      refresh();
      cy.wait("@history-failed");
      panel().find(".account-usage-history-error").should("have.attr", "role", "alert")
        .and("contain.text", failure);
      currentBar().should("not.have.class", "empty").and(($bar) => {
        expect($bar.attr("aria-label"), "마지막 성공 수치를 유지한다").to.equal(originalLabel);
        expect($bar.attr("data-detail")).to.contain("사용량 이력을 읽지 못했습니다")
          .and.not.contain("이력을 불러오는 중입니다");
      });
      panel().find(".account-usage-legend").should("contain.text", account.displayName);

      cy.then(() => { phase = "recovered"; });
      refresh();
      cy.wait("@history-recovered");
      panel().find(".account-usage-history-error").should("not.exist");
      currentBar().should("not.have.class", "empty").and(($bar) => {
        expect($bar.attr("aria-label")).to.match(/소진율 \d+%$/u).and.not.equal(originalLabel);
        expect($bar.attr("data-detail")).not.to.contain("사용량 이력을 읽지 못했습니다")
          .and.not.contain("이력을 불러오는 중입니다");
      });
      panel().screenshot(`dashboard-history-retry-${label}`, { overwrite: true });
    });
  }
});
