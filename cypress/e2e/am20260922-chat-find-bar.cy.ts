/// <reference types="cypress" />
import { seedHarnessStorage } from "../support/appCommands";
import { stoppedChat, type LiveChatFixture } from "../support/chatSessionFixtures";

// 대화창 안에서 찾기(Cmd+F / Ctrl+F). 앱은 웹뷰라 공급자의 찾기 막대가 없어 대화 화면이
// 직접 막대를 세운다 — 단축키 판정은 src/lib/findInPage.ts, 칠하기와 굴리기는
// src/components/ChatFindBar.tsx, 붙는 자리는 src/components/ChatView.tsx 의 대화 패널이다.
//
// 검증 축: 세션·채팅 / 조건: 키보드 단축키와 결과 순환·경계(결과 없음, 끝에서 되돌기).
// 기존 채팅 스펙(am20260918-response-markdown-copy-actions, am20260918-chat-composer-draft-per-chat)은
// 복사 손잡이와 입력 초안만 봤고 대화 안 찾기는 이번에 처음 생겼다.
//
// 격리 백엔드에는 열린 채팅이 없으므로 get_live_chats를 종료된 채팅 한 건으로 스텁하고
// /api/chat 소켓을 가짜로 바꿔 턴 하나와 어시스턴트 메시지 하나를 흘려보낸다.

const chat = stoppedChat({
  chatId: "qa-find-chat",
  providerSessionId: "qa-find-provider",
  cwd: "/tmp/qa-find-workspace",
});

// '찾을낱말'이 세 번 나온다. 사이에 다른 문단을 끼워 여러 글 조각에 흩어지게 한다.
const RESPONSE = [
  "첫 문단에 찾을낱말 하나.",
  "",
  "가운데 문단에는 없다.",
  "",
  "마지막 문단에 찾을낱말, 그리고 또 찾을낱말.",
].join("\n");

function findBar() {
  return cy.get(".chat-find-bar");
}

function count() {
  return cy.get(".chat-find-count");
}

/** 턴 하나와 어시스턴트 응답을 흘려보내는 가짜 소켓을 심은 채 앱을 연다. */
function visitWithConversation(): void {
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
          win.setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new win.Event("open"));
            this.emit({ type: "state", session: chat as unknown as LiveChatFixture });
            this.emit({ type: "turn", id: "qa-find-turn", status: "started", timestamp: 1 });
            this.emit({ type: "messageDelta", id: "qa-find-msg", role: "assistant", kind: "message", delta: RESPONSE });
            this.emit({ type: "turn", id: "qa-find-turn", status: "completed", timestamp: 2 });
          }, 0);
        }
        emit(event: unknown): void {
          this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
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
}

describe("대화창 찾기 막대가 단축키로 열려 결과를 돌아가며 짚는다", () => {
  beforeEach(() => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [chat] });
    visitWithConversation();
    cy.openView("chat");
    cy.get(".chat-runtime-list-item").should("have.length", 1).click();
    cy.get(".structured-chat .chat-session-header").should("be.visible");
    cy.get(".chat-message-markdown").should("contain.text", "찾을낱말");
  });

  it("Cmd+F로 열고 결과를 앞뒤로 돌며 Esc로 닫는다", () => {
    // 열기 전에는 막대가 없다.
    cy.get(".chat-find-bar").should("not.exist");

    cy.get("body").trigger("keydown", { key: "f", metaKey: true });
    findBar().should("be.visible");
    findBar().find("input").should("be.focused");
    // 아직 찾을 말이 없으면 숫자도 없다.
    count().should("have.text", "");

    findBar().find("input").type("찾을낱말");
    count().should("have.text", "1/3");

    // 칠하기는 DOM을 건드리지 않고 CSS 사용자 하이라이트로 얹는다.
    cy.window().then((win) => {
      const highlights = (win.CSS as unknown as { highlights: Map<string, unknown> }).highlights;
      expect(highlights.has("chat-find")).to.equal(true);
      expect(highlights.has("chat-find-current")).to.equal(true);
    });

    // 다음 결과로 두 번 내려가고, 끝에서 한 번 더 누르면 처음으로 돌아온다.
    findBar().find('button[aria-label="다음 결과"]').click();
    count().should("have.text", "2/3");
    findBar().find('button[aria-label="다음 결과"]').click();
    count().should("have.text", "3/3");
    findBar().find('button[aria-label="다음 결과"]').click();
    count().should("have.text", "1/3");

    // 이전 결과는 반대쪽 끝으로 되돌아간다.
    findBar().find('button[aria-label="이전 결과"]').click();
    count().should("have.text", "3/3");

    // Enter·Shift+Enter도 같은 두 손잡이다.
    findBar().find("input").type("{enter}");
    count().should("have.text", "1/3");
    findBar().find("input").type("{shift}{enter}");
    count().should("have.text", "3/3");

    // 없는 말은 결과 없음으로 알리고 이동 버튼이 잠긴다.
    findBar().find("input").clear().type("없는말");
    count().should("have.text", "결과 없음");
    findBar().find('button[aria-label="다음 결과"]').should("be.disabled");

    // Esc로 닫으면 막대도 칠하기도 사라진다.
    findBar().find("input").type("{esc}");
    cy.get(".chat-find-bar").should("not.exist");
    cy.window().then((win) => {
      const highlights = (win.CSS as unknown as { highlights: Map<string, unknown> }).highlights;
      expect(highlights.has("chat-find")).to.equal(false);
    });
  });

  it("작업 로그 탭에서도 같은 막대가 열리고, 채팅 화면 밖에서는 열리지 않는다", () => {
    cy.anchor("chat.tab.activity").click().should("have.class", "active");
    cy.get("body").trigger("keydown", { key: "f", ctrlKey: true });
    findBar().should("be.visible");
    // 작업 로그 탭은 도구·진행 상황만 세우므로 대화 본문의 낱말은 잡히지 않는다 —
    // 찾기가 보고 있는 것이 그때 그려진 탭의 내용이라는 뜻이다.
    findBar().find("input").type("찾을낱말");
    count().should("have.text", "결과 없음");
    findBar().find("input").type("{esc}");
    cy.get(".chat-find-bar").should("not.exist");

    // 채팅 화면은 다른 화면으로 옮겨도 감춰질 뿐 살아 있다. 감춰진 대화에서는 단축키가
    // 듣지 않아야 보이지 않는 막대에 글을 치는 일이 없다.
    cy.openView("dashboard");
    cy.get("body").trigger("keydown", { key: "f", metaKey: true });
    cy.get(".chat-find-bar").should("not.exist");

    // 돌아오면 다시 열린다.
    cy.openView("chat");
    cy.get("body").trigger("keydown", { key: "f", metaKey: true });
    findBar().should("be.visible");
  });
});
