/// <reference types="cypress" />
// 채팅 작성기의 음성 입력 버튼이 녹음 → 전사 → 작성기 병합까지 상태를 끌고 가는지 본다.
// 기존 qa52 스펙은 버튼의 라벨 언어만 봤을 뿐, 실제 상태 전이와 전사문 병합은 아무도 보지
// 않았다. 브라우저 음성 인식은 Cypress에서 쓸 수 없으므로 `window.SpeechRecognition`을
// 테스트가 모는 가짜 생성자로 바꾼다(`src/lib/voice.ts:88`이 호출 시점에 window에서 읽는다).
// 대화 창까지 가는 길은 chatSessionFixtures가 쥔 절차를 그대로 쓴다.

import { openStoppedChat, stoppedChat, stubLiveChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";

const chat = stoppedChat({
  chatId: "voice-input-chat",
  providerSessionId: "voice-input-provider-session",
  cwd: "/tmp/voice-input-workspace",
});

interface FakeRecognition {
  onstart: ((event: Event) => void) | null;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type VoiceWindow = Window & { __fakeRecognition?: FakeRecognition; SpeechRecognition?: unknown };

/** 테스트가 콜백을 직접 쏘는 가짜 인식기를 window에 심는다. 마지막 인스턴스를 물려 둔다. */
function installFakeRecognition(): void {
  cy.window().then((win) => {
    const voiceWindow = win as VoiceWindow;
    class Recognition implements FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onstart: ((event: Event) => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: ((event: Event) => void) | null = null;
      constructor() {
        voiceWindow.__fakeRecognition = this;
      }
      start(): void {
        this.onstart?.(new win.Event("start"));
      }
      stop(): void {
        this.onend?.(new win.Event("end"));
      }
      abort(): void {}
    }
    voiceWindow.SpeechRecognition = Recognition;
  });
}

/** 인식기가 중간 결과를 흘리는 모양 그대로 results를 만들어 던진다. */
function emitTranscript(...segments: string[]): void {
  cy.window().then((win) => {
    const results: Record<string | number, unknown> = { length: segments.length };
    segments.forEach((segment, index) => {
      results[index] = { isFinal: true, length: 1, 0: { transcript: segment } };
    });
    (win as VoiceWindow).__fakeRecognition?.onresult?.({ results });
  });
}

describe("채팅 작성기 음성 입력의 전사 병합과 오류 안내", () => {
  beforeEach(() => {
    stubLiveChat(chat);
    visitWithFakeChatSocket(chat);
    installFakeRecognition();
    openStoppedChat();
  });

  it("녹음을 멈추면 전사문이 작성기의 기존 초안 뒤에 붙는다", () => {
    cy.get(".chat-composer textarea").type("메모");

    cy.get(".voice-input-button")
      .should("have.attr", "aria-label", "음성 입력 시작")
      .and("have.attr", "aria-pressed", "false")
      .click();

    // 녹음 중: 버튼이 종료 동작으로 바뀌고 상태 문구가 뜬다.
    cy.get(".voice-input-button")
      .should("have.attr", "aria-label", "녹음 종료하고 전사")
      .and("have.attr", "aria-pressed", "true");
    cy.get(".voice-status-message").should("contain.text", "녹음 중");

    emitTranscript("오늘  일정", "정리해 줘");

    cy.get(".voice-input-button").click();

    // 전사 완료: 공백이 정규화된 문장이 초안 뒤에 한 칸 띄고 붙는다.
    cy.get(".chat-composer textarea").should("have.value", "메모 오늘 일정 정리해 줘");
    cy.get(".voice-status-message").should("contain.text", "전사 완료");
    cy.get(".voice-input-button")
      .should("have.attr", "aria-label", "음성 입력 시작")
      .and("have.attr", "aria-pressed", "false");
  });

  it("마이크 권한이 거부되면 경고로 안내하고 작성기 초안을 건드리지 않는다", () => {
    cy.get(".chat-composer textarea").type("초안 유지");
    cy.get(".voice-input-button").click();

    cy.window().then((win) => {
      (win as VoiceWindow).__fakeRecognition?.onerror?.({ error: "not-allowed" });
    });

    cy.get(".voice-status-message")
      .should("have.attr", "role", "alert")
      .and("contain.text", "마이크 권한이 거부되었습니다");
    cy.get(".chat-composer textarea").should("have.value", "초안 유지");
    cy.get(".voice-input-button")
      .should("have.attr", "aria-label", "음성 입력 시작")
      .and("not.be.disabled");
  });
});
