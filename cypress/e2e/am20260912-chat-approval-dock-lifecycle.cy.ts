/// <reference types="cypress" />

/**
 * 여러 승인 요청을 모으는 채팅 하단 독의 수명주기. 기존 AM-223은 AIA 커서가 승인 카드
 * 버튼을 누르지 못하게 하는 경계였고, 사용자가 독을 접은 뒤 새 요청이 도착하는 흐름은
 * 다루지 않았다. 접힌 채로 새 승인을 놓치거나, 해결된 요청이 건수에 남으면 채팅은 실제
 * 응답을 기다리면서도 사용자가 무엇을 처리해야 하는지 잘못 알게 된다.
 */
import { openStoppedChat, stoppedChat, stubLiveChat } from "../support/chatSessionFixtures";
import { seedHarnessStorage } from "../support/appCommands";

const chat = stoppedChat({
  chatId: "qa-approval-dock-chat",
  providerSessionId: "qa-approval-dock-provider-session",
  cwd: "/tmp/qa-approval-dock",
  state: "running",
  lastTurnStatus: "started",
});

describe("채팅 승인 독의 다건 접기·새 요청 자동 펼침·해결 반영", () => {
  it("접은 동안 새 승인이 오면 다시 펼치고 해결된 요청은 대기 건수에서 뺀다", () => {
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
              this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "turn", id: "turn-approval", status: "started", startedAt: 1_700_000_000_100 }) }));
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

    const emit = (event: object) => cy.window().then((win) => {
      expect(chatSocket, "가짜 채팅 소켓").not.to.equal(null);
      chatSocket?.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
    });
    const approval = (id: string, title: string) => ({
      type: "approval",
      id,
      kind: "command",
      title,
      detail: `${title} 상세`,
      options: ["accept", "decline"],
      interactive: true,
    });

    emit(approval("approval-1", "첫 번째 명령 승인"));
    emit(approval("approval-2", "두 번째 파일 승인"));
    cy.get(".chat-approval-dock").should("be.visible").within(() => {
      cy.get(".chat-approval").should("have.length", 2);
      cy.get(".approval-dock-toggle").should("contain.text", "2건").and("have.attr", "aria-expanded", "true").click();
      cy.get(".chat-approval").should("have.length", 2).and("not.be.visible");
      cy.get(".approval-dock-summary").should("contain.text", "첫 번째 명령 승인").and("contain.text", "두 번째 파일 승인");
    });

    emit(approval("approval-3", "세 번째 설정 승인"));
    cy.get(".chat-approval-dock").should("not.have.class", "approval-dock-collapsed").within(() => {
      cy.get(".approval-dock-toggle").should("contain.text", "3건").and("have.attr", "aria-expanded", "true");
      cy.get(".chat-approval").should("have.length", 3).and("contain.text", "세 번째 설정 승인");
    });

    emit({ type: "approvalResolved", id: "approval-2", decision: "decline" });
    cy.get(".chat-approval-dock").within(() => {
      cy.get(".approval-dock-toggle").should("contain.text", "2건");
      cy.get(".chat-approval").should("have.length", 2).and("not.contain.text", "두 번째 파일 승인");
    });
    cy.get(".structured-chat .conversation-turn").should("contain.text", "두 번째 파일 승인").and("contain.text", "요청을 거절했습니다");

    // 접었다 펼쳐도 카드에 입력한 값은 남는다 — 접기가 카드를 언마운트하면 비밀번호가 비워졌다.
    emit({ ...approval("approval-secret", "sudo 비밀번호 승인"), needsSecret: true });
    cy.get(".chat-approval").contains(".chat-approval", "sudo 비밀번호 승인").find(".chat-approval-secret input").type("typed-value");
    cy.get(".chat-approval-dock .approval-dock-toggle").click();
    cy.get(".chat-approval-dock .chat-approval").should("not.be.visible");
    cy.get(".chat-approval-dock .approval-dock-toggle").click();
    cy.get(".chat-approval").contains(".chat-approval", "sudo 비밀번호 승인").within(() => {
      cy.get(".chat-approval-secret input").should("have.value", "typed-value");
      cy.get("button.primary").should("not.be.disabled");
    });
    cy.screenshot("am20260912-chat-approval-dock-lifecycle");
  });
});
