/// <reference types="cypress" />

// 격리 하네스에는 열린 채팅이 하나도 없어, 활성 대화 창을 보는 스펙은 `get_live_chats`를
// 종료된 채팅 한 건으로 스텁하고 `/api/chat` WebSocket만 가짜 소켓으로 바꿔 열리자마자
// state 이벤트를 던진다. 그러면 화면은 붙은 것으로 보고 대화 창을 그린다.
// 이 절차(24개 필드짜리 세션 표본 · 가짜 소켓을 심는 visit · 목록에서 대화 창 열기)를 스펙
// 둘이 글자 그대로 복사해 두고 있었다 — 세션 필드가 하나 늘면 두 곳을 같이 고쳐야 했다.
// 여기 한 벌만 두고 스펙은 달라지는 값(모델·추론 수준·승인 모드 따위)만 넘긴다.

import { seedHarnessStorage } from "./appCommands";

/** `get_live_chats`가 돌려주는 세션 한 건. 스펙이 손대는 필드만 이름을 드러낸다. */
export interface LiveChatFixture {
  chatId: string;
  startedAt: number;
  source: string;
  accountId: string | null;
  resuming: boolean;
  forked?: boolean;
  forkSourceSessionId?: string | null;
  providerSessionId: string | null;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  mode: string;
  approvalMode: string;
  state: string;
  turnCount: number;
  lastTurnStatus: string | null;
  replayTruncated: boolean;
  unattended: boolean;
  origin: unknown;
  attached: boolean;
  interactiveApprovals: boolean;
  profile: string;
  systemTools: boolean;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
}

/**
 * 종료된(state=stopped) 채팅 한 건. `providerSessionId`가 있어 이어가기 경로로 붙으므로
 * 작성기까지 활성화된 대화 창을 만나게 된다.
 */
export function stoppedChat(overrides: Partial<LiveChatFixture> = {}): LiveChatFixture {
  return {
    chatId: "e2e-chat",
    startedAt: 1_700_000_000_000,
    source: "codex",
    accountId: null,
    resuming: false,
    providerSessionId: "e2e-provider-session",
    cwd: "/tmp/e2e-workspace",
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
    ...overrides,
  };
}

/** 채팅 목록을 이 세션 한 건으로 고정한다. */
export function stubLiveChat(chat: LiveChatFixture): void {
  cy.stubInvoke("get_live_chats", { statusCode: 200, body: [chat] });
}

/** 가짜 소켓이 창에 남기는 손잡이. 스펙이 이벤트를 밀어 넣고 보낸 메시지를 읽는 자리다. */
export interface FakeChatSocketHandles {
  /** 마지막으로 열린 가짜 `/api/chat` 소켓. 스펙은 여기에 `message` 이벤트를 던진다. */
  __qaChatSocket: EventTarget | null;
  /** 화면이 소켓으로 보낸 메시지 원문, 보낸 순서대로. */
  __qaSent: string[];
}

/**
 * 가짜 `/api/chat` 소켓을 심은 채 앱을 연다. 다른 WebSocket은 원래 구현으로 넘긴다 —
 * 이벤트·터미널 소켓까지 바꾸면 보려던 것이 달라진다. 소켓과 보낸 메시지는
 * `FakeChatSocketHandles`로 창에 남겨, 카드 응답 같은 왕복을 보는 스펙이 가져다 쓴다.
 */
export function visitWithFakeChatSocket(chat: LiveChatFixture, url = "/"): void {
  cy.visit(url, {
    onBeforeLoad(win) {
      seedHarnessStorage(win);
      const handles = win as unknown as FakeChatSocketHandles;
      handles.__qaChatSocket = null;
      handles.__qaSent = [];
      const RealWebSocket = win.WebSocket;
      class FakeChatSocket extends win.EventTarget {
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
          handles.__qaChatSocket = this;
          win.setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new win.Event("open"));
            this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "state", session: chat }) }));
          }, 0);
        }
        send(data: string): void {
          handles.__qaSent.push(String(data));
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

/** 채팅 화면의 목록에서 하나뿐인 세션을 눌러 대화 창을 연다. */
export function openStoppedChat(): void {
  cy.openView("chat");
  cy.get(".chat-runtime-list-item").should("have.length", 1).click();
  cy.get(".structured-chat .chat-session-header").should("be.visible");
}
