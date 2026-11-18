/// <reference types="cypress" />
import { seedHarnessStorage } from "../support/appCommands";
import { stoppedChat, type LiveChatFixture } from "../support/chatSessionFixtures";

// 채팅별 입력 초안은 chatId를 열쇠로 화면에만 남는다. 떠날 때 남기고(ChatView.tsx:406
// rememberChatLocalState → ChatLocalMemory.tsx remember), 돌아올 때 연결을 기다리는
// 화면에 미리 올린다(ChatView.tsx:654 connectingChatSurface(draftOf)). 이 Map 셋은
// 2026-09-18에 ChatView 본문에서 useChatLocalMemory 훅으로 옮겨졌고(4941e43a), 옮긴
// 뒤 초안이 실제로 제 채팅으로만 돌아오는지는 화면으로 확인된 적이 없다.
//
// 검증 축: 세션·채팅 / 조건: 화면 전환 후 이전 데이터 잔존과 격리. 기존 채팅 스펙
// (am20260916-chat-close-confirm-suppress, qa52-chat-conversation-english)은 목록과
// 대화 창의 표시만 봤고, 두 채팅 사이를 오가며 입력창 내용이 섞이는지는 보지 않았다.
//
// 격리 백엔드에는 열린 채팅이 없으므로 get_live_chats를 종료된 채팅 두 건으로 스텁하고
// /api/chat 소켓만 가짜로 바꾼다. 가짜 소켓은 attach 메시지의 chatId를 읽어 그 채팅의
// state를 돌려주므로, 전환할 때마다 대화 창이 맞는 세션으로 선다.

const first = stoppedChat({
  chatId: "qa-draft-chat-a",
  providerSessionId: "qa-draft-provider-a",
  cwd: "/tmp/qa-draft-a",
});
const second = stoppedChat({
  chatId: "qa-draft-chat-b",
  providerSessionId: "qa-draft-provider-b",
  cwd: "/tmp/qa-draft-b",
});

const COMPOSER = ".structured-chat .chat-composer textarea";

/** attach로 붙은 chatId에 맞는 세션을 돌려주는 가짜 소켓을 심은 채 앱을 연다. */
function visitWithTwoChats(chats: LiveChatFixture[]): void {
  cy.visit("/", {
    onBeforeLoad(win) {
      seedHarnessStorage(win);
      const RealWebSocket = win.WebSocket;
      const byId = new Map(chats.map((chat) => [chat.chatId, chat]));
      class FakeChatSocket extends win.EventTarget {
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
          win.setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new win.Event("open"));
          }, 0);
        }
        send(raw: string): void {
          const message = JSON.parse(raw) as { type?: string; chatId?: string };
          if (message.type !== "attach") return;
          const session = byId.get(String(message.chatId));
          if (!session) return;
          win.setTimeout(() => {
            this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "state", session }) }));
          }, 0);
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
}

/** 목록에서 해당 경로를 가진 행을 눌러 그 채팅의 대화 창을 연다. */
function openChat(chat: LiveChatFixture): void {
  cy.get(".chat-runtime-list-item").contains(chat.cwd.split("/").pop() as string).click();
  cy.get(".structured-chat .chat-session-header").should("be.visible");
  cy.get(COMPOSER).should("exist");
}

describe("채팅별 입력 초안이 전환을 건너 제 채팅으로만 돌아온다", () => {
  beforeEach(() => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [first, second] });
    visitWithTwoChats([first, second]);
    cy.openView("chat");
    cy.get(".chat-runtime-list-item").should("have.length", 2);
  });

  it("다른 채팅으로 옮기면 입력창이 비고, 돌아오면 남겼던 초안이 그대로 선다", () => {
    openChat(first);
    cy.get(COMPOSER).type("첫 채팅에 쓰던 글");
    cy.get(COMPOSER).should("have.value", "첫 채팅에 쓰던 글");

    // 다른 채팅은 제 초안이 없으므로 빈 입력창으로 서야 한다.
    openChat(second);
    cy.get(COMPOSER).should("have.value", "");

    // 돌아오면 떠날 때 남긴 글이 그대로 올라온다.
    openChat(first);
    cy.get(COMPOSER).should("have.value", "첫 채팅에 쓰던 글");
  });

  it("두 채팅이 각자의 초안을 따로 들고 서로 덮어쓰지 않는다", () => {
    openChat(first);
    cy.get(COMPOSER).type("A의 초안");

    openChat(second);
    cy.get(COMPOSER).should("have.value", "").type("B의 초안");

    openChat(first);
    cy.get(COMPOSER).should("have.value", "A의 초안");

    openChat(second);
    cy.get(COMPOSER).should("have.value", "B의 초안");
  });
});
