/// <reference types="cypress" />

// AIA 팝업에서 새 대화(헤더 새로고침)를 시작한 뒤 팝업을 닫았다 다시 열면 방금 버린
// 대화가 도로 열리던 갈래를 고정한다.
//
// 턴이 끝날 때마다 완료 알림이 하나 남고, 그 알림이 미확인이면 상단바 트리거는 팝업을
// 여는 대신 그 알림의 대화로 전환한다(`App.tsx`의 `toggleAia`). 보고 있던 대화와 같을
// 때는 전환이 제자리라 티가 나지 않지만, 새로고침으로 대화를 새로 시작하면 알림이 가리키는
// 대화와 화면의 대화가 갈라져 트리거가 이전 대화를 되살린다. 그래서 대화를 버릴 때 그
// 대화의 알림도 함께 걷는다(`aiaAttentionForChat`).
//
// 보는 것: (1) 새로고침이 버린 대화의 알림을 지우는가, (2) 트리거의 확인 대기 강조가
// 걷히는가, (3) 닫았다 다시 열 때 버린 대화로 다시 붙지 않는가(소켓 attach 횟수).

import { seedHarnessStorage } from "../support/appCommands";

const OLD_CHAT_ID = "e2e-aia-old";
const NEW_CHAT_ID = "e2e-aia-new";

function aiaChat(chatId: string) {
  return {
    chatId,
    startedAt: 1_700_000_000_000,
    source: "codex",
    accountId: null,
    resuming: false,
    providerSessionId: null,
    cwd: "/tmp/am-e2e-aia-refresh",
    model: null,
    reasoningEffort: null,
    mode: "workspace",
    approvalMode: "manual",
    state: "ready",
    turnCount: 1,
    lastTurnStatus: "completed",
    replayTruncated: false,
    unattended: false,
    origin: { kind: "aia" },
    attached: false,
    interactiveApprovals: true,
    profile: "aia",
    systemTools: true,
    contextUsedTokens: null,
    contextWindowTokens: null,
  };
}

function completedAttention(chatId: string) {
  return {
    id: "e2e-aia-completed",
    chatId,
    source: "codex",
    providerSessionId: null,
    cwd: "/tmp/am-e2e-aia-refresh",
    resuming: false,
    unattended: false,
    profile: "aia",
    origin: { kind: "aia" },
    kind: "completed",
    title: "AIA 답변",
    detail: null,
    approvalId: null,
    preview: null,
    createdAt: 1_700_000_000_000,
    read: false,
  };
}

/**
 * 첫 메시지(attach/start)를 읽고 그에 맞는 대화로 답하는 가짜 `/api/chat` 소켓.
 * `chatSessionFixtures`의 소켓은 열리자마자 정해진 세션 하나를 던지므로, 새 대화 시작으로
 * 대화 id가 갈리는 이 스펙에는 쓸 수 없다. 보낸 메시지는 창에 쌓아 두고 검증에 쓴다.
 */
function visitWithMessageAwareChatSocket(): void {
  cy.visit("/", {
    onBeforeLoad(win) {
      seedHarnessStorage(win);
      const scope = win as unknown as { __aiaChatMessages?: string[] };
      scope.__aiaChatMessages = [];
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
          }, 0);
        }
        send(data: string): void {
          scope.__aiaChatMessages?.push(data);
          const message = JSON.parse(data) as { type: string; chatId?: string };
          if (message.type !== "attach" && message.type !== "start") return;
          const chatId = message.type === "attach" ? message.chatId ?? OLD_CHAT_ID : NEW_CHAT_ID;
          win.setTimeout(() => {
            this.dispatchEvent(new win.MessageEvent("message", {
              data: JSON.stringify({ type: "state", session: aiaChat(chatId) }),
            }));
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

/**
 * 상단바 트리거로 팝업을 연다. 시스템 에이전트 설정이 도착하기 전의 트리거는 설정 안내
 * 버튼이라(`AiaTopbarTrigger`의 `enabled`), 그때 누르면 팝업 대신 설정 화면이 열린다.
 */
function openAiaFromTrigger(): void {
  cy.anchor("topbar.aia").should("have.attr", "title", "AIA 열기").click();
  cy.get(".aia-chat-popup").should("have.class", "open");
}

/** 이 대화에 붙은 횟수. 소켓 메시지는 비동기로 쌓이므로 재시도하는 단언으로 센다. */
function expectAttachCount(chatId: string, expected: number): void {
  cy.window().should((win) => {
    const messages = (win as unknown as { __aiaChatMessages?: string[] }).__aiaChatMessages ?? [];
    const attaches = messages.filter((raw) => raw.includes(`"attach"`) && raw.includes(chatId));
    expect(attaches, `attach ${chatId} (보낸 메시지: ${messages.join(" | ")})`).to.have.length(expected);
  });
}

describe("AIA 새 대화 시작은 버린 대화의 알림까지 걷는다", () => {
  // 알림 목록은 폴링마다 다시 읽히도록 변수에 담는다. 턴이 끝나 완료 알림이 생기는
  // 순간을 테스트 중간에 만들어야 하기 때문이다.
  let attentionItems: ReturnType<typeof completedAttention>[] = [];

  beforeEach(() => {
    attentionItems = [];
    cy.stubInvoke("get_system_automation_snapshot", (request) => {
      request.continue((response) => {
        response.body.settings.systemProvider = "codex";
        // 하네스는 호스트 CLI를 그대로 탐지해 자동 스키마 재조사가 살아 있다. 그 요청이
        // AIA 팝업을 열어 버리면 이 스펙이 보는 열고 닫기 순서가 흐트러진다.
        response.body.settings.catalogAutoDiscovery = false;
        // 제안 팩이 살아 있으면 트리거가 제안만으로도 강조되어(`aiaTriggerView`) 알림이
        // 걷혔는지 가릴 수 없다. 이 스펙이 보는 것은 알림뿐이므로 제안은 꺼 둔다.
        response.body.settings.aiaSuggestions = false;
      });
    });
    // 목록에는 이전 대화만 있다. 새 대화는 이 스펙의 소켓이 만들어 낸다.
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [aiaChat(OLD_CHAT_ID)] });
    cy.stubInvoke("get_chat_attention_snapshot", (request) => {
      request.reply({ items: attentionItems, unreadCount: attentionItems.length, pendingCount: 0 });
    });
    cy.stubInvoke("dismiss_chat_attention", (request) => {
      const { id } = request.body as { id: string };
      attentionItems = attentionItems.filter((item) => item.id !== id);
      request.reply({ items: attentionItems, unreadCount: attentionItems.length, pendingCount: 0 });
    }).as("dismiss");
  });

  it("새로고침한 뒤 닫았다 다시 열어도 버린 대화로 돌아가지 않는다", () => {
    visitWithMessageAwareChatSocket();

    // 1) 알림이 없을 때 트리거를 누르면 목록에 있던 이전 대화에 붙는다.
    openAiaFromTrigger();
    expectAttachCount(OLD_CHAT_ID, 1);

    // 2) 턴이 끝나 완료 알림이 생긴다 — 팝업을 보고 있어도 미확인으로 남는 알림이다.
    cy.then(() => { attentionItems = [completedAttention(OLD_CHAT_ID)]; });
    cy.anchor("topbar.aia").should("have.class", "attention");

    // 3) 새로고침으로 새 대화를 시작하면 버린 대화의 알림도 함께 걷힌다.
    cy.get(".aia-chat-header button[title='새 AIA 대화']").click();
    cy.wait("@dismiss").its("request.body.id").should("equal", "e2e-aia-completed");
    cy.anchor("topbar.aia").should("not.have.class", "attention");

    // 4) 닫았다 다시 열어도 트리거는 이전 대화로 전환하지 않는다 — attach는 1)의 한 번뿐이다.
    cy.get(".aia-chat-header button[title='AIA 닫기']").click();
    cy.get(".aia-chat-popup").should("not.have.class", "open");
    openAiaFromTrigger();
    expectAttachCount(OLD_CHAT_ID, 1);
  });
});
