/// <reference types="cypress" />

import type { SessionBookmark, SessionMeta } from "../../src/types";
import { seedHarnessStorage } from "../support/appCommands";
import { stoppedChat, type LiveChatFixture } from "../support/chatSessionFixtures";

// AIA 팝업도 대화 화면·세션 상세와 같은 읽던 자리 훅을 쓰지만, 2026-09-24 전에는
// 팝업의 메시지에 `data-message-key`가 없어 "여기 표시"가 늘 실패했다. 세션 상세의
// 기존 스펙은 저장소 왕복까지 보지만 AIA 렌더 경로를 지나지 않으므로 이 누락을 잡지
// 못했다. 긴 AIA 답변을 실제 팝업에 흘리고, 화면에서 남긴 앵커가 공급자 세션 메타로
// 저장되는지 확인한다.

const CHAT = stoppedChat({
  chatId: "qa-aia-bookmark-chat",
  providerSessionId: "qa-aia-bookmark-provider",
  cwd: "/tmp/qa-aia-bookmark",
  state: "ready",
  turnCount: 1,
  lastTurnStatus: "completed",
  origin: { kind: "aia" },
  attached: true,
  profile: "aia",
  systemTools: true,
});

const META: SessionMeta = {
  favorite: false,
  hidden: false,
  note: null,
  customTitle: null,
  folderIds: [],
  reasoningEffort: null,
  mode: null,
  approvalMode: null,
  creationAccountId: null,
  boundAccountId: null,
  pinnedAccountId: null,
  bookmarks: [],
};

const RESPONSE = Array.from(
  { length: 60 },
  (_, index) => `AIA 책갈피 문단 ${index}입니다. 팝업 안에서 읽던 자리를 확인합니다.`,
).join("\n\n");

/** 붙기 요청에 답해 긴 완료 응답을 한 번 흘리는 AIA 전용 가짜 소켓. */
function visitWithAiaResponse(): void {
  cy.visit("/", {
    onBeforeLoad(win) {
      seedHarnessStorage(win, { "agent-manager.aia-chat.v1": CHAT.chatId });
      const RealWebSocket = win.WebSocket;
      class FakeChatSocket extends win.EventTarget {
        readyState = 0;
        sentResponse = false;

        constructor() {
          super();
          win.setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new win.Event("open"));
          }, 0);
        }

        emit(event: unknown): void {
          this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
        }

        send(raw: string): void {
          const request = JSON.parse(raw) as { type: string };
          if (request.type !== "attach" || this.sentResponse) return;
          this.sentResponse = true;
          win.setTimeout(() => {
            this.emit({ type: "state", session: CHAT as LiveChatFixture });
            this.emit({ type: "turn", id: "qa-aia-bookmark-turn", status: "started", timestamp: 1 });
            this.emit({ type: "messageDelta", id: "qa-aia-bookmark-msg", role: "assistant", kind: "message", delta: RESPONSE });
            this.emit({ type: "turn", id: "qa-aia-bookmark-turn", status: "completed", timestamp: 2 });
          }, 0);
        }

        close(): void {
          this.readyState = 3;
        }
      }

      win.WebSocket = new Proxy(RealWebSocket, {
        construct(target, args: [string, ...unknown[]]) {
          if (String(args[0]).includes("/api/chat")) return new FakeChatSocket();
          return new (target as unknown as new (...rest: unknown[]) => WebSocket)(...args);
        },
      }) as typeof WebSocket;
    },
  });
}

describe("AIA 팝업의 읽던 자리 저장", () => {
  let saved: SessionBookmark[];

  beforeEach(() => {
    saved = [];
    cy.stubInvoke("get_system_automation_snapshot", (request) => request.continue((response) => {
      response.body.settings.systemProvider = "codex";
      response.body.settings.catalogAutoDiscovery = false;
      response.body.settings.aiaSuggestions = false;
    }));
    cy.stubInvoke("get_manager_snapshot", (request) => request.continue((response) => {
      const codex = response.body.status.providers.find((provider: { provider: string }) => provider.provider === "codex");
      if (codex) codex.cli.detected = true;
    }));
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [CHAT] });
    cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: { items: [], unreadCount: 0, pendingCount: 0 } });
    cy.stubInvoke("get_session_meta", (request) => request.reply({ statusCode: 200, body: { ...META, bookmarks: saved } }));
    cy.stubInvoke("patch_session_meta", (request) => {
      const body = request.body as { request: { patch: { bookmarks: SessionBookmark[] } } };
      saved = body.request.patch.bookmarks;
      request.reply({ statusCode: 200, body: { ...META, bookmarks: saved } });
    }).as("patchMeta");
  });

  it("팝업 메시지의 안정된 키로 현재 자리를 저장하고 다시 열어도 표시한다", () => {
    visitWithAiaResponse();
    cy.anchor("topbar.aia").should("have.attr", "title", "AIA 열기").click();

    cy.get('.aia-chat-popup.open [data-message-key="live:qa-aia-bookmark-msg:message"]')
      .should("contain.text", "AIA 책갈피 문단 0");
    cy.get(".aia-chat-popup.open .aia-chat-stream").scrollTo(0, 500);
    cy.get(".aia-chat-popup.open .reading-bookmark-toggle").click();
    cy.get(".aia-chat-popup.open .reading-bookmark-panel").contains("button", "여기 표시").click();

    cy.wait("@patchMeta").its("request.body.request").should((request: unknown) => {
      const typed = request as { source: string; id: string; patch: { bookmarks: SessionBookmark[] } };
      expect(typed.source).to.equal("codex");
      expect(typed.id).to.equal(CHAT.providerSessionId);
      expect(typed.patch.bookmarks).to.have.length(1);
      expect(typed.patch.bookmarks[0].anchor.messageKey).to.equal("live:qa-aia-bookmark-msg:message");
      expect(typed.patch.bookmarks[0].snippet).to.match(/AIA 책갈피 문단 \d+/);
    });

    cy.get(".aia-chat-popup.open .reading-bookmark-list li").should("have.length", 1);
    cy.get('.aia-chat-popup.open button[title="AIA 닫기"]').click();
    cy.anchor("topbar.aia").click();
    cy.get(".aia-chat-popup.open .reading-bookmark-toggle .reading-bookmark-count").should("have.text", "1");
  });
});
