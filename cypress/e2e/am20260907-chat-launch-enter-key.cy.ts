/**
 * 새 채팅 시작 폼(ChatLaunchPanel.tsx)의 '첫 메시지'(선택) 칸은 composer와 같은
 * `submitComposerOnEnter`(src/lib/composerKeys.ts)를 달고 있지만, 감싸는 form이
 * composer가 아니라 `chat-launch-form`이다. 그래서 이 칸의 Enter는 '보내기'가 아니라
 * '새 채팅 시작'을 부른다. 어느 스펙도 이 키 계약을 잡은 적이 없다 — 채팅 축의 기존
 * 스펙(AM-77 탭, 채팅 목록 패널, 활동 탭 빈 상태)은 모두 폼 바깥이었다.
 *
 * 작업 경로는 선택이 되었다(adda3225). 비우면 백엔드가 앱의 기본 작업공간에서 시작하므로
 * 빈 경로는 더 이상 시작을 잠그지 않는다. 격리 백엔드에는 등록 프로젝트가 0건이라 경로
 * 선택 목록도 직접 입력 칸도 서지 않고 "기본 작업공간에서 시작" 안내만 선다.
 *
 * 그렇게 되면 Enter 한 번이 호스트에서 탐지된 실제 CLI를 띄울 수 있다. 그래서 `/api/chat`
 * 소켓만 가짜로 바꿔 시작 요청을 받아 적고 `rejected`로 돌려준다 — 화면은 시작을 부른 뒤
 * 실패를 안내하는 데까지 가고, 프로세스는 하나도 뜨지 않는다.
 */
import { seedHarnessStorage } from "../support/appCommands";

interface StartCapture {
  __qaChatStarts: Array<{ type: string; request?: { cwd?: string } }>;
}

const REJECTED_MESSAGE = "E2E가 채팅 시작을 가로챘습니다";

/** 가짜 `/api/chat` 소켓을 심고 연다. 시작 요청은 기록하고 거절로 답한다. */
function visitWithRejectingChatSocket(): void {
  cy.visit("/", {
    onBeforeLoad(win) {
      seedHarnessStorage(win);
      const capture = win as unknown as StartCapture;
      capture.__qaChatStarts = [];
      const RealWebSocket = win.WebSocket;
      class RejectingChatSocket extends win.EventTarget {
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
          capture.__qaChatStarts.push(JSON.parse(String(data)));
          win.setTimeout(() => {
            this.dispatchEvent(new win.MessageEvent("message", {
              data: JSON.stringify({ type: "rejected", code: "e2eBlocked", message: REJECTED_MESSAGE }),
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
          if (String(args[0]).includes("/api/chat")) return new RejectingChatSocket(args[0]);
          return new (target as unknown as new (...rest: unknown[]) => WebSocket)(...args);
        },
      }) as typeof WebSocket;
    },
  });
}

const starts = () => cy.window().then((win) => (win as unknown as StartCapture).__qaChatStarts);
const firstMessage = () => cy.get(".chat-initial-composer textarea");
const startButton = () => cy.get(".chat-start-button");

describe("새 채팅 시작 폼의 첫 메시지 칸 Enter 계약과 빈 작업 경로 시작", () => {
  beforeEach(() => {
    visitWithRejectingChatSocket();
    cy.openView("chat");
    cy.get(".chat-launch-form").should("be.visible");
  });

  it("등록 프로젝트가 없으면 작업 경로를 직접 적는 칸이 서고, 비워 둬도 시작은 잠기지 않는다", () => {
    cy.get(".chat-launch-form select").first().should("contain.text", "Claude Code");
    // 고를 프로젝트 목록이 없으니 입력칸이 경로를 적을 유일한 길이다. 칸이 없으면 첫 설치에서
    // 경로를 지정할 방법이 사라진다. 빈 칸은 "작업 경로 없음"이라 채워야 하는 칸(required)이 아니다.
    cy.get(".chat-launch-form input[placeholder^='/absolute/project/path']").should("be.visible").and("have.value", "");
    cy.get(".chat-launch-form [required]").should("not.exist");
    startButton().should("not.be.disabled").and("have.text", "새 채팅 시작");
    starts().should("have.length", 0);
  });

  it("첫 메시지 칸의 Shift+Enter는 줄바꿈만 남기고 채팅을 시작하지 않는다", () => {
    firstMessage().type("첫 줄{shift+enter}둘째 줄");
    firstMessage().should("have.value", "첫 줄\n둘째 줄");
    // 시작이 걸렸다면 소켓에 start가 실리고 거절 안내가 떴을 것이다.
    starts().should("have.length", 0);
    startButton().should("have.text", "새 채팅 시작");
    cy.get(".error-banner").should("not.exist");
  });

  it("첫 메시지 칸의 Enter는 줄바꿈 대신 빈 작업 경로로 새 채팅 시작을 부른다", () => {
    firstMessage().type("바로 보낼 요청{enter}");
    // 줄바꿈은 들어가지 않는다.
    firstMessage().should("have.value", "바로 보낼 요청");
    // 시작 요청 하나가 빈 경로로 나간다 — 백엔드가 이를 기본 작업공간으로 해석한다.
    starts().should("have.length", 1).then((sent) => {
      expect(sent[0].type).to.eq("start");
      expect(sent[0].request?.cwd).to.eq("");
    });
    // 거절되면 안내가 폼 안에 남고, 폼은 그대로 남아 다시 시도할 수 있어야 한다.
    cy.get(".error-banner").should("be.visible").and("contain.text", REJECTED_MESSAGE);
    cy.get(".chat-launch-form").should("be.visible");
    startButton().should("have.text", "새 채팅 시작").and("not.be.disabled");
    // 연결이 서지 않았으므로 첫 메시지도 지워지지 않는다.
    firstMessage().should("have.value", "바로 보낼 요청");
  });

  it("첫 메시지가 비어 있어도 Enter는 시작을 부른다 — 첫 메시지는 선택이라 버튼과 같은 기준", () => {
    firstMessage().type("{enter}");
    firstMessage().should("have.value", "");
    starts().should("have.length", 1).its("0.request.cwd").should("eq", "");
    cy.get(".error-banner").should("contain.text", REJECTED_MESSAGE);
  });
});
