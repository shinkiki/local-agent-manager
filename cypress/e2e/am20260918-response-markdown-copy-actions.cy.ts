/// <reference types="cypress" />
import { seedHarnessStorage } from "../support/appCommands";
import { stoppedChat, type LiveChatFixture } from "../support/chatSessionFixtures";

// 어시스턴트 응답 안의 복사 손잡이는 세 갈래다. 응답 전체(ChatConversation.tsx:559),
// 제목별 섹션(MarkdownPreview.tsx:525), 코드 블록(MarkdownPreview.tsx:257). 섹션 버튼은
// 3단계 제목까지만 붙고(MarkdownPreview.tsx:277 `copyable && level <= 3`), 실패하면
// CopyAction.tsx:56 이 "복사 실패"로 알린 뒤 1.8초 뒤 원래 라벨로 돌아온다
// (CopyAction.tsx:59).
//
// 검증 축: 세션·채팅 / 조건: 경계값(제목 단계)과 실패 응답의 오류 안내·상태 복귀.
// 기존 복사 스펙 am20260913-clipboard-null-fallback 은 설정 화면의 경로 복사 한 건이
// 폴백으로 성공하는 길만 봤고, 대화 창의 마크다운 복사 손잡이가 몇 개 붙는지와 실패
// 상태가 스스로 풀리는지는 화면으로 확인된 적이 없다.
//
// 격리 백엔드에는 열린 채팅이 없으므로 get_live_chats를 종료된 채팅 한 건으로 스텁하고
// /api/chat 소켓을 가짜로 바꿔 턴 하나와 어시스턴트 메시지 하나를 흘려보낸다. 턴이
// completed로 끝나야 copyReady가 서서 복사 손잡이가 활성으로 그려진다.

const chat = stoppedChat({
  chatId: "qa-copy-chat",
  providerSessionId: "qa-copy-provider",
  cwd: "/tmp/qa-copy-workspace",
});

const RESPONSE = [
  "# 응답 제목",
  "머리말입니다.",
  "",
  "## 첫 섹션",
  "첫 섹션 본문.",
  "",
  "## 둘째 섹션",
  "둘째 섹션 본문.",
  "",
  "#### 네 단계 제목",
  "네 단계 본문.",
  "",
  "```sh",
  "echo hello",
  "```",
].join("\n");

const FIRST_SECTION = ["## 첫 섹션", "첫 섹션 본문.", ""].join("\n").trimEnd();

/** 턴 하나와 어시스턴트 마크다운 응답을 흘려보내는 가짜 소켓을 심은 채 앱을 연다. */
function visitWithAssistantResponse(): void {
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
            this.emit({ type: "turn", id: "qa-copy-turn", status: "started", timestamp: 1 });
            this.emit({ type: "messageDelta", id: "qa-copy-msg", role: "assistant", kind: "message", delta: RESPONSE });
            this.emit({ type: "turn", id: "qa-copy-turn", status: "completed", timestamp: 2 });
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

/** 네이티브 클립보드와 레거시 폴백을 함께 갈아 끼운다. 폴백까지 막으면 복사는 실패로 끝난다. */
function stubClipboard(win: Cypress.AUTWindow, outcome: "ok" | "fail"): { written: string[] } {
  const written: string[] = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (value: string) => {
        if (outcome === "fail") return Promise.reject(new Error("차단됨"));
        written.push(value);
        return Promise.resolve();
      },
    },
  });
  cy.stub(win.document, "execCommand").callsFake((command: string) => {
    expect(command).to.equal("copy");
    if (outcome === "fail") return false;
    written.push(win.document.querySelector("textarea[aria-hidden='true']")?.value ?? "");
    return true;
  });
  return { written };
}

describe("어시스턴트 응답의 복사 손잡이가 제목 단계를 가르고 실패를 되돌린다", () => {
  beforeEach(() => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [chat] });
    visitWithAssistantResponse();
    cy.openView("chat");
    cy.get(".chat-runtime-list-item").should("have.length", 1).click();
    cy.get(".structured-chat .chat-session-header").should("be.visible");
    cy.get(".chat-message-markdown").should("exist");
  });

  it("섹션 복사 버튼은 3단계 제목까지만 붙고 4단계 제목에는 붙지 않는다", () => {
    // h1·h2·h2 세 자리에만 붙는다. h4는 본문만 그려진다.
    cy.get(".chat-message-markdown .markdown-heading-copy").should("have.length", 3);
    cy.get(".chat-message-markdown h1").find(".markdown-heading-copy").should("have.length", 1);
    cy.get(".chat-message-markdown h2").should("have.length", 2);
    cy.get(".chat-message-markdown h2").each(($heading) => {
      cy.wrap($heading).find(".markdown-heading-copy").should("have.length", 1);
    });
    cy.get(".chat-message-markdown h4")
      .should("contain.text", "네 단계 제목")
      .find(".markdown-heading-copy")
      .should("not.exist");

    // 응답 전체와 코드 블록 손잡이는 따로 한 개씩 선다.
    cy.get(".message-copy-action").should("have.length", 1).and("not.be.disabled");
    cy.get(".chat-message-markdown .markdown-code-copy").should("have.length", 1);
    cy.screenshot("am20260918-copy-actions-heading-levels");
  });

  it("섹션 복사는 다음 같은 단계 제목 앞까지만 실어 보낸다", () => {
    cy.window().then((win) => {
      const clipboard = stubClipboard(win, "ok");
      cy.get(".chat-message-markdown h2").first().find(".markdown-heading-copy")
        .should("have.attr", "aria-label", "섹션 복사")
        .click()
        .should("have.class", "copy-action-copied")
        .and("have.attr", "aria-label", "복사됨")
        .then(() => {
          expect(clipboard.written).to.deep.equal([FIRST_SECTION]);
        });
    });
    cy.get(".chat-message-markdown .copy-action-announcement").contains("복사됨")
      .should("have.attr", "role", "status");
  });

  it("복사가 막히면 실패로 알리고 1.8초 뒤 원래 라벨로 스스로 돌아온다", () => {
    cy.window().then((win) => {
      stubClipboard(win, "fail");
      cy.get(".chat-message-markdown .markdown-code-copy")
        .should("have.attr", "aria-label", "코드 복사")
        .click()
        .should("have.class", "copy-action-failed")
        .and("have.attr", "aria-label", "복사 실패");
    });
    cy.screenshot("am20260918-copy-actions-failed-state");
    // 되돌림 타이머가 끝나면 알림 줄이 비고 라벨이 원래대로 선다.
    cy.get(".chat-message-markdown .markdown-code-copy", { timeout: 6_000 })
      .should("have.attr", "aria-label", "코드 복사")
      .and("not.have.class", "copy-action-failed");
    cy.get(".chat-message-markdown .markdown-code-copy .copy-action-announcement").should("have.text", "");
  });
});
