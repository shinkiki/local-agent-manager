/// <reference types="cypress" />

import type { SessionMeta } from "../../src/types";
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
          (win as unknown as { updateContext: (used: number | null) => void }).updateContext = (used) => this.emit({ type: "state", session: { ...CHAT, contextUsedTokens: used, contextWindowTokens: 1000 } });
          win.setTimeout(() => {
            this.emit({ type: "state", session: CHAT as LiveChatFixture });
            this.emit({ type: "turn", id: "qa-aia-bookmark-turn", status: "started", timestamp: 1 });
            this.emit({ type: "userInput", id: "header-user", text: "Shared user heading", attachments: [] });
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


describe("Shared user header and context meter in AIA", () => {
  for (const source of ["codex", "claude"] as const) {
    it(source + " uses the shared header and keeps unknown context visible", () => {
      cy.viewport(1100, 700);
      CHAT.source = source;
      cy.stubInvoke("get_system_automation_snapshot", (req) => req.continue((res) => {
        res.body.settings.systemProvider = source;
        res.body.settings.catalogAutoDiscovery = false;
        res.body.settings.aiaSuggestions = false;
      }));
      cy.stubInvoke("get_manager_snapshot", (req) => req.continue((res) => {
        const provider = res.body.status.providers.find((p: { provider: string }) => p.provider === source);
        if (provider) provider.cli.detected = true;
      }));
      cy.stubInvoke("get_live_chats", { statusCode: 200, body: [CHAT] });
      cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: { items: [], unreadCount: 0, pendingCount: 0 } });
      cy.stubInvoke("get_session_meta", { statusCode: 200, body: META });
      visitWithAiaResponse();
      cy.anchor("topbar.aia").click();
      cy.get(".aia-chat-popup.open .chat-message-user").scrollIntoView().should("have.css", "text-align", "left").within(() => {
        cy.get(".user-message-header > strong").should("have.text", "사용자 요청");
        cy.get(".user-message-header > time").should("have.attr", "datetime", "1970-01-01T00:00:00.001Z");
      });
      cy.get(".aia-chat-popup.open .chat-context-meter").should("be.visible").and("contain.text", "정보 없음");
      cy.window().then((win) => (win as unknown as { updateContext: (used: number | null) => void }).updateContext(500));
      cy.get(".aia-chat-popup.open .chat-context-meter").should("be.visible").and("contain.text", "50%");
      cy.window().then((win) => (win as unknown as { updateContext: (used: number | null) => void }).updateContext(null));
      cy.get(".aia-chat-popup.open .chat-context-meter").should("be.visible").and("contain.text", "정보 없음");
      cy.get(".aia-chat-popup.open").screenshot("shared-user-header-" + source);
    });
  }
});
