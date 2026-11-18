/// <reference types="cypress" />
import { openStoppedChat, stoppedChat, stubLiveChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";
import type { SessionDetail, TranscriptItem } from "../../src/types";

// 84b1a64가 채팅 화면의 '현재 연결 이전 기록' 배선(원문을 읽을지 판정 · 라이브와 겹치는
// 구간 자르기 · 머리말과 더보기 세우기)을 ChatTranscriptHistory 훅 하나로 모았다. 그
// 커밋이 "그대로 유지"로 남긴 계약 셋을 채팅 대화 창에서 확인한다.
//   - 리플레이가 앞을 밀어내지도 않고 이어가기도 아닌 채팅은 원문을 아예 읽지 않는다
//     (ChatTranscriptHistory.tsx:48 — missesHistory).
//   - 머리말 부제는 읽지 못한 줄이 있으면 그 개수를, 없으면 '현재 연결 이전 기록'을 쓴다
//     (ChatTranscriptHistory.tsx:73).
//   - 라이브 턴이 하나도 없으면 '여기부터 현재 연결' 경계선을 세우지 않는다
//     (ChatTranscriptHistory.tsx:95).
// 검증 축: 세션·채팅 / 조건: 빈 상태와 경계값, 앞 구간 추가 후 개수 갱신.
// 기존 채팅 스펙(am20260916-chat-close-confirm-suppress, qa52-chat-conversation-english,
// am20260917-chat-launch-settings-restore)은 목록·확인 대화·작성기만 다뤘고, 세션 상세
// 스펙(am20260913-transcript-collapsed-activity 등)은 서랍 쪽 트랜스크립트만 봤다.
// 채팅 대화 창 위에 붙는 이전 기록 머리말은 처음 본다.

const CHAT = {
  chatId: "qa-chat-history-chat",
  providerSessionId: "qa-chat-history-provider-session",
  cwd: "/tmp/qa-chat-history",
};

const HISTORY = ".chat-transcript-history";
const HEAD = ".chat-transcript-history-head";

function item(index: number, role: "user" | "assistant", text: string): TranscriptItem {
  return {
    index,
    turnId: `turn-${index}`,
    role,
    timestamp: 1_757_200_000_000 + index * 1_000,
    model: null,
    typeLabel: null,
    blocks: [{ kind: "text", text }],
    usage: null,
  } as TranscriptItem;
}

/** 파일에 남은 최신 구간 3건. 앞에 index 0~9가 더 있다는 뜻으로 index를 10부터 센다. */
const LATEST: TranscriptItem[] = [
  item(10, "user", "QA_HISTORY_OLD_REQUEST"),
  item(11, "assistant", "QA_HISTORY_OLD_ANSWER"),
  item(12, "user", "QA_HISTORY_LAST_REQUEST"),
];

/** '이전 대화 더보기'가 위쪽에 붙일 앞 구간 2건. 붙인 뒤에는 더 읽을 것이 없다. */
const EARLIER: TranscriptItem[] = [
  item(8, "user", "QA_HISTORY_EARLIER_REQUEST"),
  item(9, "assistant", "QA_HISTORY_EARLIER_ANSWER"),
];

function detail(transcript: TranscriptItem[], truncated: boolean, skippedLines: number): SessionDetail {
  return {
    session: null,
    transcript,
    truncated,
    skippedLines,
    unavailableReason: null,
  } as unknown as SessionDetail;
}

/** 첫 조회와 '더보기'(transcriptBeforeIndex가 붙은 요청)를 갈라 응답한다. */
function stubTranscript(skippedLines: number): void {
  cy.stubInvoke("get_session_detail", (req) => {
    const request = (req.body as { request?: { transcriptBeforeIndex?: number } }).request ?? {};
    if (typeof request.transcriptBeforeIndex === "number") {
      req.reply(detail(EARLIER, false, skippedLines));
      return;
    }
    req.reply(detail(LATEST, true, skippedLines));
  });
}

describe("채팅 대화 창의 '현재 연결 이전 기록' 머리말", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("리플레이가 온전하고 이어가기도 아닌 채팅은 원문을 읽지 않아 이전 기록이 서지 않는다", () => {
    const chat = stoppedChat({ ...CHAT, resuming: false, replayTruncated: false });
    stubLiveChat(chat);
    cy.stubInvoke("get_session_detail", (req) => {
      // 호출되면 그 자체가 결함이다 — 아래 빈 상태 단언보다 먼저 드러나도록 표식을 준다.
      req.reply(detail([item(0, "user", "QA_HISTORY_SHOULD_NOT_LOAD")], false, 0));
    }).as("detail");
    visitWithFakeChatSocket(chat);
    openStoppedChat();

    cy.get(".structured-chat").should("contain.text", "CLI가 연결되었습니다");
    cy.get(HISTORY).should("not.exist");
    cy.get(".structured-chat").should("not.contain.text", "QA_HISTORY_SHOULD_NOT_LOAD");
    cy.get("@detail.all").should("have.length", 0);
  });

  it("이어가기 채팅은 머리말·표시 범위·더보기를 세우고, 라이브 턴이 없으면 경계선은 서지 않는다", () => {
    const chat = stoppedChat({ ...CHAT, resuming: true });
    stubLiveChat(chat);
    stubTranscript(1_234);
    visitWithFakeChatSocket(chat);
    openStoppedChat();

    // 머리말의 strong 뒤에 표시 범위 선택의 strong이 또 오므로 첫 번째만 본다.
    cy.get(HEAD).find("strong").first().should("have.text", "이전 대화 내역");
    // 읽지 못한 줄이 있으면 부제가 그 개수를 세 자리 구분으로 알린다.
    cy.get(HEAD).find("small").first().should("have.text", "읽지 못한 줄 1,234개");
    cy.get(HEAD).find(".session-transcript-range small").should("have.text", "3개 항목 표시 중");
    cy.get(HEAD).find('select[aria-label="채팅 대화 표시 범위"]').should("exist");

    cy.get(HISTORY).should("contain.text", "QA_HISTORY_OLD_REQUEST").and("contain.text", "QA_HISTORY_LAST_REQUEST");
    cy.get(HISTORY).find(".transcript-load-earlier button").should("contain.text", "이전 대화 더보기");
    // 라이브 스트림에 턴이 하나도 없으므로 '여기부터 현재 연결'은 세우지 않는다.
    cy.get(".chat-transcript-boundary").should("not.exist");
    cy.get(".error-banner").should("not.exist");
  });

  it("읽지 못한 줄이 없으면 부제가 기본 문구로 서고, 더보기는 앞 구간을 위에 붙인 뒤 사라진다", () => {
    const chat = stoppedChat({ ...CHAT, resuming: true });
    stubLiveChat(chat);
    stubTranscript(0);
    visitWithFakeChatSocket(chat);
    openStoppedChat();

    cy.get(HEAD).find("small").first().should("have.text", "현재 연결 이전 기록");

    cy.get(HISTORY).find(".transcript-load-earlier button").click();
    cy.get(HISTORY).should("contain.text", "QA_HISTORY_EARLIER_REQUEST");
    // 붙은 구간은 위쪽에 놓여야 한다 — 뒤에 붙으면 시간 순서가 뒤집힌다.
    cy.get(HISTORY).find(".transcript-turn").first().should("contain.text", "QA_HISTORY_EARLIER_REQUEST");
    // 표시 개수는 붙인 만큼 늘어난다.
    cy.get(HEAD).find(".session-transcript-range small").should("have.text", "5개 항목 표시 중");
    // 더 읽을 앞 구간이 없다고 응답했으므로 더보기는 사라진다.
    cy.get(HISTORY).find(".transcript-load-earlier").should("not.exist");
  });

  it("영어에서는 머리말·부제·표시 범위 라벨이 영어로 선다", () => {
    const chat = stoppedChat({ ...CHAT, resuming: true });
    stubLiveChat(chat);
    stubTranscript(1_234);
    visitWithFakeChatSocket(chat);
    cy.setLanguage("en");
    openStoppedChat();

    // 컴포넌트가 한국어 리터럴로 그려 정적 치환표에도 없던 문구들이다.
    cy.get(HEAD).find("strong").first().should("have.text", "Earlier conversation");
    cy.get(HEAD).find("small").first().should("have.text", "1,234 unreadable lines");
    cy.get(HEAD).find('select[aria-label="Chat transcript range"]').should("exist");
  });
});
