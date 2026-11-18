/// <reference types="cypress" />

/**
 * C9-19. sudo 비밀번호를 요구하는 승인 카드의 화면 쪽 계약.
 *
 * 보는 것은 다섯이다 — 요구한 카드만 password 입력칸을 그리고, 값이 비면 허용을 막고(거절은
 * 열어 두고), 보낸 메시지의 `secret`으로만 값이 나가며(`answers`는 비어 있다), 보낸 즉시
 * 입력칸이 비워지고, 값이 화면 어디에도 남지 않는다.
 *
 * 되살아난 카드도 함께 본다. 승인 카드는 대화 화면이 붙어 있지 않아도 알림 목록에 남았다가
 * 화면이 다시 붙을 때 되살아나는데(`attach` → `pending_events`), 한때 그 재구성이
 * `needs_secret`을 떨어뜨려 **입력칸 없는 카드**가 서고 값 없는 허용이 나갔다(QA #81).
 * 지금은 알림 항목이 그 한 칸을 들고 있어 되살아난 카드도 같은 질문을 한다.
 */
import { openStoppedChat, stoppedChat, stubLiveChat } from "../support/chatSessionFixtures";
import { seedHarnessStorage } from "../support/appCommands";

const chat = stoppedChat({
  chatId: "qa-approval-secret-chat",
  providerSessionId: "qa-approval-secret-provider-session",
  cwd: "/tmp/qa-approval-secret",
  state: "running",
  lastTurnStatus: "started",
});

const PASSWORD = "qa-remote-sudo-1!";

describe("sudo 비밀번호를 요구하는 승인 카드", () => {
  it("요구한 카드만 값을 묻고, 값은 secret 통로로만 나가며 화면에 남지 않는다", () => {
    let chatSocket: (WebSocket & EventTarget) | null = null;
    const sent: string[] = [];

    stubLiveChat(chat);
    cy.visit("/", {
      onBeforeLoad(win) {
        seedHarnessStorage(win);
        (win as unknown as { __qaSent: string[] }).__qaSent = sent;
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
              this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "turn", id: "turn-secret", status: "started", startedAt: 1_700_000_000_100 }) }));
            }, 0);
          }
          send(data: string): void {
            sent.push(String(data));
          }
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
    const approveMessages = () => sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((message) => message.type === "approve");

    // 정상 경로로 온 카드와, 알림 목록에서 재구성돼 되살아난 같은 명령의 카드를 나란히 띄운다.
    // 되살아난 카드도 `needsSecret`을 들고 온다 — 한때 이 칸이 떨어져 입력칸 없는 카드가
    // 섰다(QA #81). 값을 묻지 않는 평범한 카드도 하나 띄워 입력칸이 그 카드에만 서는지 본다.
    emit({
      type: "approval",
      id: "approval-sudo",
      kind: "command",
      title: "원격 명령 실행: sudo systemctl restart agent",
      detail: "host: qa-remote / sudo 비밀번호가 필요합니다",
      options: ["accept", "decline"],
      interactive: true,
      needsSecret: true,
    });
    emit({
      type: "approval",
      id: "approval-replayed",
      kind: "approval",
      title: "원격 명령 실행(되살아난 카드): sudo systemctl restart agent",
      detail: "host: qa-remote",
      options: ["accept", "acceptForSession", "decline", "cancel"],
      interactive: true,
      needsSecret: true,
    });
    emit({
      type: "approval",
      id: "approval-plain",
      kind: "command",
      title: "원격 명령 실행: systemctl status agent",
      detail: "host: qa-remote",
      options: ["accept", "decline"],
      interactive: true,
    });

    cy.get(".chat-approval-dock .chat-approval").should("have.length", 3);

    // 되살아난 카드도 같은 질문을 한다 — 입력칸이 서고, 값이 비면 허용이 잠긴다.
    cy.get(".chat-approval").contains(".chat-approval", "되살아난 카드").within(() => {
      cy.get(".chat-approval-secret input").should("have.attr", "type", "password");
      cy.get("button.primary").should("be.disabled");
    });

    // 값을 묻지 않는 카드에는 입력칸이 서지 않고 허용도 열려 있다.
    cy.get(".chat-approval").contains(".chat-approval", "systemctl status agent").within(() => {
      cy.get(".chat-approval-secret").should("not.exist");
      cy.get("button.primary").should("not.be.disabled");
    });

    // 요구한 카드는 password 입력칸을 그리고, 값이 비면 허용을 막는다. 거절은 열려 있다.
    cy.get(".chat-approval").contains(".chat-approval", "sudo systemctl restart agent").within(() => {
      cy.get(".chat-approval-secret input")
        .should("have.attr", "type", "password")
        .and("have.attr", "autocomplete", "off")
        .and("have.value", "");
      cy.get(".chat-approval-secret em").should("contain.text", "저장되지 않고");
      cy.get("button.primary").should("be.disabled");
      cy.get("button.danger-subtle").should("not.be.disabled");

      cy.get(".chat-approval-secret input").type(PASSWORD);
      cy.get("button.primary").should("not.be.disabled").click();
      // 보낸 즉시 입력칸은 비워진다 — 카드가 화면에 남아 있어도 값이 머무르지 않는다.
      cy.get(".chat-approval-secret input").should("have.value", "");
    });

    cy.wrap(null).should(() => {
      const messages = approveMessages();
      expect(messages, "허용 전송").to.have.length(1);
      expect(messages[0].approvalId).to.equal("approval-sudo");
      expect(messages[0].decision).to.equal("accept");
      expect(messages[0].secret).to.equal(PASSWORD);
      expect(messages[0].answers).to.deep.equal({});
    });

    // 값을 묻지 않는 카드의 허용에는 secret 키가 붙지 않는다.
    cy.get(".chat-approval").contains(".chat-approval", "systemctl status agent").within(() => {
      cy.get("button.primary").click();
    });
    cy.wrap(null).should(() => {
      const messages = approveMessages();
      expect(messages, "두 건의 허용 전송").to.have.length(2);
      expect(messages[1].approvalId).to.equal("approval-plain");
      expect(messages[1]).to.not.have.property("secret");
    });

    // 해결된 카드는 대화로 내려가고, 어느 기록에도 비밀번호는 남지 않는다.
    emit({ type: "approvalResolved", id: "approval-sudo", decision: "accept" });
    cy.get(".structured-chat .conversation-turn").should("contain.text", "sudo systemctl restart agent");
    cy.get("body").should("not.contain.text", PASSWORD);
    cy.screenshot("am20260920-approval-sudo-secret");
  });
});
