/// <reference types="cypress" />

/**
 * 만료 해결이 먼저 기록된 카드에 늦은 허용 해결이 도착하는 역방향 경합을 검증한다.
 * AM-341은 사용자의 허용이 먼저 온 뒤 만료 해결이 늦게 오는 순서다. 이번 패턴은
 * 만료가 먼저 확정된 뒤 stale 허용 이벤트가 와도 자동 취소 사유가 정본인지 확인한다.
 */
import { openStoppedChat, stoppedChat, stubLiveChat } from "../support/chatSessionFixtures";
import { seedHarnessStorage } from "../support/appCommands";

const chat = stoppedChat({
  chatId: "qa-approval-expiry-first-chat",
  providerSessionId: "qa-approval-expiry-first-provider-session",
  cwd: "/tmp/qa-approval-expiry-first",
  state: "running",
  lastTurnStatus: "started",
});

describe("만료 해결 뒤 늦은 허용 이벤트의 선착 결정 보존", () => {
  it("먼저 확정된 자동 취소 사유를 뒤늦은 허용 해결이 덮지 않는다", () => {
    let chatSocket: (WebSocket & EventTarget) | null = null;

    stubLiveChat(chat);
    cy.visit("/", {
      onBeforeLoad(win) {
        seedHarnessStorage(win);
        const RealWebSocket = win.WebSocket;
        class FakeChatSocket extends win.EventTarget {
          readyState = 0;
          url: string;
          constructor(url: string) {
            super();
            this.url = url;
            chatSocket = this as unknown as WebSocket & EventTarget;
            win.setTimeout(() => {
              this.readyState = 1;
              this.dispatchEvent(new win.Event("open"));
              this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "state", session: chat }) }));
              this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "turn", id: "turn-expiry-first", status: "started", startedAt: 1_700_000_000_100 }) }));
            }, 0);
          }
          send(): void {}
          close(): void {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.dispatchEvent(new win.CloseEvent("close"));
          }
        }
        win.WebSocket = new Proxy(RealWebSocket, {
          construct(target, args: [string, ...unknown[]]) {
            if (String(args[0]).includes("/api/chat")) return new FakeChatSocket(args[0]);
            return new (target as unknown as new (...rest: unknown[]) => WebSocket)(...args);
          },
        }) as typeof WebSocket;
      },
    });
    openStoppedChat();
    cy.anchor("chat.tab.conversation").should("have.attr", "aria-selected", "true");

    const emit = (event: object) => cy.window().then((win) => {
      expect(chatSocket, "가짜 채팅 소켓").not.to.equal(null);
      chatSocket?.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
    });
    const expiredNote = "승인 시간이 지나 자동으로 취소되었습니다.";

    emit({
      type: "approval",
      id: "approval-expiry-first",
      kind: "command",
      title: "만료와 허용이 경합한 원격 명령",
      detail: "대상 서버: qa-remote",
      options: ["accept", "decline"],
      interactive: true,
    });
    cy.get(".chat-approval-dock .chat-approval").should("have.length", 1);

    // 만료 해결이 먼저 도착해 카드를 독에서 내리고 자동 취소 사유를 기록한다.
    emit({ type: "approvalResolved", id: "approval-expiry-first", decision: "decline", note: expiredNote });
    cy.get(".chat-approval-dock").should("not.exist");
    cy.contains(".structured-chat .chat-approval", "만료와 허용이 경합한 원격 명령")
      .should("contain.text", expiredNote)
      .and("not.contain.text", "요청을 거절했습니다")
      .find("button")
      .should("not.exist");

    // 이미 만료가 정본이 된 뒤 stale 허용 해결이 도착해도 먼저 온 결과를 지킨다.
    emit({ type: "approvalResolved", id: "approval-expiry-first", decision: "accept" });
    cy.contains(".structured-chat .chat-approval", "만료와 허용이 경합한 원격 명령")
      .should("contain.text", expiredNote)
      .and("not.contain.text", "이번 요청을 허용했습니다");

    cy.screenshot("am20260916-approval-expiry-first-resolution");
  });
});
