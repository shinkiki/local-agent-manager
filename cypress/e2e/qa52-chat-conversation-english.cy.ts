/// <reference types="cypress" />
// QA #52 회귀: 영어 UI에서 활성 채팅 대화 창(머리줄·빈 상태·작성기·음성 입력·실행설정 줄)이
// 영어로 그려져야 한다. 격리 하네스에는 열린 채팅이 없으므로 `get_live_chats`를 종료된 채팅
// 한 건으로 스텁하고, `/api/chat` WebSocket만 가짜 소켓으로 바꿔 열리자마자 state 이벤트 한 건을
// 던진다. 화면은 붙은 것으로 보고 대화 창을 그리며, state=stopped + providerSessionId라
// 이어가기 경로로 작성기까지 활성화된다. 다른 WebSocket은 원래 구현으로 넘긴다.
// 실행설정 요약의 모드·승인 라벨은 백엔드 스키마가 주는 문구라 여기서는 보지 않는다.

const E2E_HOOKS_KEY = "agent-manager.e2e-hooks";
const NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v2";

const chat = {
  chatId: "qa52-chat",
  startedAt: 1_700_000_000_000,
  source: "codex",
  accountId: null,
  resuming: false,
  providerSessionId: "qa52-provider-session",
  cwd: "/tmp/qa52-workspace",
  model: null,
  reasoningEffort: null,
  mode: "workspace",
  approvalMode: "manual",
  state: "stopped",
  turnCount: 0,
  lastTurnStatus: null,
  replayTruncated: false,
  unattended: false,
  origin: null,
  attached: false,
  interactiveApprovals: true,
  profile: "standard",
  systemTools: false,
  contextUsedTokens: null,
  contextWindowTokens: null,
};

function visitWithFakeChatSocket(): void {
  cy.visit("/", {
    onBeforeLoad(win) {
      win.localStorage.setItem(E2E_HOOKS_KEY, "1");
      win.localStorage.setItem(NAVIGATION_PREFERENCES_KEY, JSON.stringify({ hidden: [] }));
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
            this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "state", session: chat }) }));
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
}

function openStoppedChat(): void {
  cy.openView("chat");
  cy.get(".chat-runtime-list-item").should("have.length", 1).click();
  cy.get(".structured-chat .chat-session-header").should("be.visible");
}

const HANGUL = /[가-힣]/;

describe("QA #52 영어 UI의 활성 채팅 대화 창", () => {
  beforeEach(() => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [chat] });
  });

  after(() => {
    cy.restoreLanguage();
  });

  it("한국어에서는 머리줄·빈 상태·작성기가 한국어다", () => {
    visitWithFakeChatSocket();
    openStoppedChat();
    cy.get(".chat-session-header strong").should("have.text", "Codex · 종료됨");
    cy.get(".chat-stream .empty-state").should("contain.text", "CLI가 연결되었습니다");
    cy.get(".chat-composer textarea").should("have.attr", "aria-label", "채팅 메시지");
    cy.get(".voice-input-button").should("have.attr", "aria-label", "음성 입력 시작");
  });

  it("영어에서는 머리줄·빈 상태·작성기·음성 입력·실행설정 줄이 모두 영어다", () => {
    visitWithFakeChatSocket();
    cy.setLanguage("en");
    openStoppedChat();

    // 머리줄: 상태 문구와 동작 버튼.
    cy.get(".chat-session-header strong").should("have.text", "Codex · Stopped");
    cy.get(".chat-session-header").contains("button", "Resume").should("exist");
    cy.get(".chat-session-header").invoke("text").should("not.match", HANGUL);
    cy.get(".chat-session-meta").should("contain.text", "Default model").and("contain.text", "Reasoning Default");

    // 빈 상태.
    cy.get(".chat-stream .empty-state").should("contain.text", "CLI connected").and("contain.text", "Send your first message");

    // 작성기: 라벨·자리표시자·전송 버튼.
    cy.get(".chat-composer textarea")
      .should("have.attr", "aria-label", "Chat message")
      .and("have.attr", "placeholder", "This chat has stopped. Sending resumes the conversation");
    cy.get(".chat-composer button[type=\"submit\"]").should("have.text", "Send");

    // 음성 입력 버튼: 라벨과 상태 문구(title) 모두 영어. 전사 미지원 환경이면 오류 문구가 title에 실린다.
    cy.get(".voice-input-button").should("have.attr", "aria-label", "Start voice input");
    cy.get(".voice-input-button").invoke("attr", "title").should("not.match", HANGUL);
    cy.get("body").then(($body) => {
      const status = $body.find(".voice-status-message");
      if (status.length > 0) expect(status.text()).not.to.match(HANGUL);
    });

    // 실행설정 줄: 버튼 라벨 머리와 패널의 항목 라벨.
    cy.get(".session-runtime-settings-button").invoke("attr", "aria-label").should("match", /^Current Chat settings: /);
    cy.get(".session-runtime-settings-button span").should("contain.text", "Provider default").and("contain.text", "Default reasoning");
    cy.get(".session-runtime-settings-button").click();
    cy.get(".session-composer-settings").should("have.attr", "aria-label", "Chat run settings");
    cy.get(".session-model-selector select").should("have.attr", "aria-label", "Chat model");
    cy.get(".session-reasoning-selector select").should("have.attr", "aria-label", "Chat reasoning");

    // 탭 줄과 채팅 목록 라벨(#39)도 같은 화면에서 함께 영어다.
    cy.get(".chat-hub > .chat-hub-tabs [role=\"tablist\"]").should("have.attr", "aria-label", "Chat views");
  });
});
