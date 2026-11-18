/// <reference types="cypress" />
// 2026-09-18 QA(축: 설정) — 설정 → 연결 → CLI 설정의 계정 구획이 이제 화면에 적힌 목록이
// 아니라 계정 스냅샷의 공급자 자리로 열린다(`src/components/SettingsView.tsx:1824`,
// `fd959505`). 백엔드 `ProviderId::manages_accounts`가
// (`crates/agent-manager-core/src/domain.rs:138`) Antigravity를 포함하게 됐으므로,
// Antigravity 카드도 Claude·Codex와 같은 계정 구획(홈 계정 카드 + 계정 목록)을 보여야
// 한다. 동시에 등록 계정이 0건인 동안에는 기계 전역 사용량 카드를 함께 남긴다.
// 격리 하네스에는 계정이 하나도 없으므로 그 빈 상태가 이 스펙의 사전조건 그대로다.
import { stubLocalLlmDisconnected } from "../support/providerAccountFixtures";

describe("2026-09-18 · Antigravity 카드가 계정 구획을 열고 빈 상태에서 전역 사용량을 함께 보인다", () => {
  beforeEach(() => {
    // 연결 탭의 로컬 LLM 카드가 저장본을 직접 읽는다. 호스트 상태와 무관하게 "미연결"로
    // 고정해 이 스펙이 보는 카드 수가 흔들리지 않게 한다.
    stubLocalLlmDisconnected();
    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").should("be.visible");
  });

  it("계정을 관리하는 세 공급자만 계정 구획을 갖고, Antigravity도 빈 계정 안내를 보인다", () => {
    // 공급자 카드는 넷이다 — 로컬 LLM(Ollama)이 `PROVIDERS`에 들어오면서 카드가 하나 늘었다
    // (`crates/agent-manager-core/src/providers.rs:50`).
    cy.get(".cli-settings-provider", { timeout: 20000 }).should("have.length", 4);
    // 계정 구획은 `manages_accounts`가 참인 공급자에만 열린다. 로컬은 계정이 없으므로 셋뿐이다.
    cy.get(".cli-settings-provider .provider-account-list").should("have.length", 3);
    cy.get(".cli-settings-provider").filter(":has(.source-antigravity)").should("have.length", 1).within(() => {
      // 계정 구획 자체가 열려야 한다. 예전처럼 공급자 목록이 화면에 적혀 있으면 이 구획이
      // 통째로 없어 계정을 등록할 길이 사라진다.
      cy.get(".provider-home-card").should("exist");
      cy.get(".provider-account-list").should("exist");
      cy.get(".provider-account-list .provider-account-empty")
        .should("contain.text", "등록된 계정이 없습니다");
    });
  });

  it("등록 계정이 없는 동안에는 Antigravity 전역 사용량 카드가 남는다", () => {
    cy.get(".cli-settings-provider").filter(":has(.source-antigravity)").within(() => {
      cy.get(".provider-usage-card").should("exist").within(() => {
        cy.contains("button", "새로고침").should("exist");
      });
    });
    // 전역 사용량 카드는 이 공급자에만 붙는다.
    cy.get(".cli-settings-provider .provider-usage-card").should("have.length", 1);
  });
});
