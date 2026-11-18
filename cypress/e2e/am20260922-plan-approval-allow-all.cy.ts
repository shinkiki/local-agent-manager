/// <reference types="cypress" />

/**
 * 계획 검토 카드의 "계획대로 실행 + 전체 허용(정책 제외)" 화면 쪽 계약.
 *
 * 계획을 승인하면 CLI는 계획 모드를 빠져나오지만 권한은 그대로라 도구마다 카드가 올라온다.
 * 편집 자동 승인만으로는 명령·조회 도구가 계획 실행 내내 사용자를 멈추게 하므로, 계획을
 * 읽고 실행을 고르는 자리에서 계획 변경·질문만 남기고 나머지를 앱이 승인하는 선택이 있어야
 * 한다. 보는 것은 넷이다 — 계획 카드에만 그 버튼이 서고, 누르면 `approve` 메시지의 결정이
 * `acceptAll`로 나가며, 결과 문구가 무엇을 승인했는지 말하고, 앱이 자동 승인한 뒤 올라온
 * 카드는 사용자가 누른 것으로 보이지 않게 백엔드가 보낸 사정(note)을 그대로 남긴다.
 */
import { openStoppedChat, stoppedChat, stubLiveChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";
import type { FakeChatSocketHandles } from "../support/chatSessionFixtures";

const chat = stoppedChat({
  chatId: "qa-plan-allow-all-chat",
  source: "claude",
  providerSessionId: "qa-plan-allow-all-provider-session",
  cwd: "/tmp/qa-plan-allow-all",
  mode: "plan",
  state: "running",
  lastTurnStatus: "started",
});

const ALLOW_ALL_LABEL = "계획대로 실행 + 전체 허용(정책 제외)";

describe("계획 검토 카드의 전체 허용(정책 제외)", () => {
  it("계획 카드에만 버튼이 서고, 결정은 acceptAll로 나가며, 자동 승인 카드는 사정을 남긴다", () => {
    stubLiveChat(chat);
    visitWithFakeChatSocket(chat);
    openStoppedChat();

    const handles = (win: Window) => win as unknown as FakeChatSocketHandles;
    const emit = (event: object) => cy.window().then((win) => {
      const target = handles(win).__qaChatSocket;
      expect(target, "가짜 채팅 소켓").not.to.equal(null);
      target?.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
    });
    const approveMessages = () => cy.window().then((win) =>
      handles(win).__qaSent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((message) => message.type === "approve"));

    cy.window().its("__qaChatSocket").should("not.equal", null);
    emit({ type: "turn", id: "turn-plan", status: "started", startedAt: 1_700_000_000_100 });
    // 백엔드는 계획 카드에만 acceptAll을 실어 보낸다. 같은 옵션이 없는 일반 카드를 나란히
    // 띄워 버튼이 옵션을 따라 서는지 본다.
    emit({
      type: "approval",
      id: "approval-plan",
      kind: "plan",
      title: "Claude 실행 계획 검토",
      detail: "# 계획\n\n1. 설정 파일을 고친다\n2. 테스트를 돌린다",
      options: ["accept", "acceptForSession", "acceptAll", "decline", "cancel"],
      interactive: true,
    });
    emit({
      type: "approval",
      id: "approval-bash",
      kind: "permission",
      title: "Claude 권한 확인 · Bash",
      detail: "{\"tool\":\"Bash\"}",
      options: ["accept", "acceptForSession", "decline", "cancel"],
      interactive: true,
    });

    cy.get(".chat-approval-dock .chat-approval").should("have.length", 2);
    cy.get(".chat-approval").contains(".chat-approval", "Bash").within(() => {
      cy.contains("button", ALLOW_ALL_LABEL).should("not.exist");
    });
    cy.get(".chat-approval").contains(".chat-approval", "실행 계획 검토").within(() => {
      cy.contains("button", "계획대로 실행 + 편집 자동 승인").should("exist");
      cy.contains("button", ALLOW_ALL_LABEL)
        .should("have.attr", "title")
        .and("contain", "계획 변경과 질문만 묻고");
      cy.contains("button", ALLOW_ALL_LABEL).click();
    });

    approveMessages().should((messages) => {
      expect(messages).to.have.length(1);
      expect(messages[0].approvalId).to.equal("approval-plan");
      expect(messages[0].decision).to.equal("acceptAll");
    });

    // 백엔드가 결정을 확정하면 카드에는 무엇을 승인했는지가 남는다.
    emit({ type: "approvalResolved", id: "approval-plan", decision: "acceptAll" });
    cy.get(".chat-approval").contains(".chat-approval", "실행 계획 검토")
      .find(".chat-approval-result")
      .should("contain.text", "나머지 권한을 자동 승인");

    // 그 뒤 앱이 자동 승인한 요청은 답을 받지 않는 카드로 오고, 백엔드가 보낸 사정이
    // 결정 문구 대신 그대로 남는다 — 사용자가 누른 것으로 읽히면 안 된다.
    emit({
      type: "approval",
      id: "approval-auto",
      kind: "permission",
      title: "Claude 권한 확인 · WebFetch",
      detail: "{\"tool\":\"WebFetch\"}",
      options: ["accept"],
      interactive: false,
    });
    emit({ type: "approvalResolved", id: "approval-auto", decision: "accept", note: "계획 실행 전체 허용으로 자동 승인했습니다" });
    cy.get(".chat-approval").contains(".chat-approval", "WebFetch").within(() => {
      cy.get("button").should("not.exist");
      cy.get(".chat-approval-result").should("contain.text", "계획 실행 전체 허용으로 자동 승인했습니다");
    });
  });
});
