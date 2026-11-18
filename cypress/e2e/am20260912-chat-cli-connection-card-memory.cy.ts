/// <reference types="cypress" />

/**
 * 채팅 시작 화면의 'CLI 연결 필요' 카드는 두 가지 닫기를 구분한다 — 이번 화면에서만
 * 치우는 닫기와, '다시 표시 안 함'을 켜고 닫는 영구 숨김이다.
 *
 * QA #68. 예전에는 기억을 켠 카드 하나를 닫을 때 이번 세션에서 그냥 치워 둔 카드까지 들어
 * 있는 화면 목록을 통째로 저장소에 썼다. 그래서 '다시 표시 안 함'을 켠 적 없는 공급자의
 * 카드가 새로고침 뒤에도 영영 돌아오지 않았다.
 *
 * 격리 백엔드는 계정이 비어 있지만 CLI 탐지는 호스트 PATH를 타므로, 네 공급자를 모두
 * '연결 필요'로 만들어 카드 네 장을 세운 뒤 확인한다(로컬 LLM이 `PROVIDERS`에 들어오면서
 * 카드가 하나 늘었다 — `crates/agent-manager-core/src/providers.rs:50`).
 */
const STORAGE_KEY = "agent-manager.hidden-cli-connection-cards.v1";

function cards() {
  return cy.get(".chat-cli-connections .chat-cli-connection-card");
}

function card(displayName: string) {
  return cy.contains(".chat-cli-connection-card", displayName);
}

function openChatLaunch() {
  cy.stubInvoke("get_manager_snapshot", (req) => {
    req.continue((res) => {
      const body = res.body as { status: { providers: { cli: { detected: boolean } }[] } };
      for (const provider of body.status.providers) provider.cli.detected = false;
    });
  });
  cy.visitApp();
  cy.openView("chat");
  cy.get(".chat-cli-connections").should("exist");
}

describe("CLI 연결 카드의 한 번 닫기와 영구 숨김", () => {
  it("기억을 켠 공급자만 저장되고, 그냥 닫은 카드는 새로고침에 돌아온다", () => {
    openChatLaunch();
    cards().should("have.length", 4);

    // 1) 기억을 켜지 않고 닫는다 — 이번 화면에서만 사라진다.
    card("Claude").find(".chat-cli-connection-close").click();
    cards().should("have.length", 3);
    cy.window().its("localStorage").invoke("getItem", STORAGE_KEY).should("equal", null);

    // 2) '다시 표시 안 함'을 켜고 닫는다 — 이 공급자만 저장된다.
    card("Codex").find(".chat-cli-connection-dismiss input").check();
    card("Codex").find(".chat-cli-connection-close").click();
    cards().should("have.length", 2);
    cy.window().its("localStorage").invoke("getItem", STORAGE_KEY)
      .should("equal", JSON.stringify(["codex"]));

    // 3) 다시 열면 기억한 Codex만 빠지고, 그냥 닫았던 Claude는 돌아온다.
    openChatLaunch();
    cards().should("have.length", 3);
    cy.contains(".chat-cli-connection-card", "Claude").should("exist");
    cy.get(".chat-cli-connections").should("not.contain.text", "Codex");
  });
});
