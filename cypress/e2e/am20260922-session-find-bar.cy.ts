/// <reference types="cypress" />
import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

// 대화 안에서 찾기(Cmd+F / Ctrl+F)는 채팅 대화·AIA 팝업·세션 상세가 같은 훅을 쓴다
// (src/components/ChatFindBar.tsx). 여기서는 세션 상세 드로어를 본다 — 스크롤을 맡는
// 요소가 드로어 본문이고, 원문이 최신 쪽부터 잘려 오므로 "아직 올라오지 않은 구간이
// 있다"는 꼬리표가 붙는 유일한 자리이기도 하다.
//
// 검증 축: 세션·채팅 / 조건: 화면별 단축키 동작과 부분 적재 안내.
// 기존 세션 스펙(am20260918-session-reading-bookmarks)은 읽던 자리만 봤고, 대화 원문을
// 찾는 길은 이번에 처음 생겼다.

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-find-session",
  title: "찾기 표본 세션",
  sourceTitle: null,
  project: "/tmp/qa-find-session",
  cwd: "/tmp/qa-find-session",
  startedAt: 1_757_200_000_000,
  updatedAt: 1_757_200_060_000,
  messageCount: 2,
  tokenTotal: 120,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 4096,
  filePath: "/tmp/qa-find-session/session.jsonl",
  meta: {
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
  },
  lastFailure: null,
};

const ANSWER = ["첫 문단에 찾을낱말 하나.", "", "가운데 문단에는 없다.", "", "마지막 문단에 찾을낱말 둘."].join("\n");

// index가 0이 아니고 truncated가 참이라 '이전 대화 더보기'가 서고, 그 사실이 찾기 막대에
// 꼬리표로 나타난다.
const transcript: TranscriptItem[] = [
  { index: 12, turnId: "turn-1", role: "user", timestamp: 1, model: null, typeLabel: null, blocks: [{ kind: "text", text: "찾기 표본을 주세요" }], usage: null },
  { index: 13, turnId: "turn-1", role: "assistant", timestamp: 2, model: null, typeLabel: null, blocks: [{ kind: "text", text: ANSWER }], usage: null },
];

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: true,
  skippedLines: 0,
  unavailableReason: null,
};

// '이전 대화 더보기'가 읽어 오는 앞 구간. 여기에만 있는 낱말이 하나 더 있어, 전체 찾기가
// 실제로 앞 구간까지 읽었는지 결과 수로 드러난다.
const EARLIER: SessionDetail = {
  session: SESSION,
  transcript: [
    { index: 0, turnId: "turn-0", role: "user", timestamp: 0, model: null, typeLabel: null, blocks: [{ kind: "text", text: "예전 질문" }], usage: null },
    { index: 1, turnId: "turn-0", role: "assistant", timestamp: 0, model: null, typeLabel: null, blocks: [{ kind: "text", text: "예전 답에도 찾을낱말 셋." }], usage: null },
  ],
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

/** 첫 조회는 최신 구간, `transcriptBeforeIndex`가 붙은 조회는 앞 구간을 돌려준다. */
function stubPagedDetail(): void {
  cy.stubInvoke("get_session_detail", (req) => {
    const request = (req.body as { request?: { transcriptBeforeIndex?: number | null } }).request;
    req.reply({
      statusCode: 200,
      body: request?.transcriptBeforeIndex ? EARLIER : DETAIL,
    });
  }).as("detail");
}

function findBar() {
  return cy.get(".chat-find-bar");
}

function count() {
  return cy.get(".chat-find-count");
}

describe("세션 상세 대화 원문에서 찾기", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    stubPagedDetail();
    cy.visitApp();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.wait("@detail");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
      .contains('[role="tab"]', "대화")
      .click()
      .should("have.attr", "aria-selected", "true");
  });

  it("드로어 머리말에서 열려 원문을 찾고, 아직 올라오지 않은 구간을 알린다", () => {
    cy.get(".chat-find-bar").should("not.exist");
    cy.get("body").trigger("keydown", { key: "f", metaKey: true });

    // 막대는 본문 위에 떠 있다 — 스크롤 조작 묶음과 같은 겹이라 대화를 밀어내지 않는다.
    cy.get(".drawer-body-shell > .chat-find-bar").should("be.visible");
    cy.get(".chat-find-bar").should("have.css", "position", "absolute");
    findBar().find("input").should("be.focused").type("찾을낱말");
    count().should("have.text", "1/2");

    // 원문이 앞에서 잘려 왔으므로(이전 대화 더보기가 서 있다) 찾은 수가 전부가 아니라고 적는다.
    cy.get(".transcript-load-earlier").should("exist");
    cy.get(".chat-find-scope").should("have.text", "화면에 올라온 대화만");

    findBar().find("input").type("{enter}");
    count().should("have.text", "2/2");

    // Esc는 찾기만 닫는다. 드로어는 그대로 열려 있어야 한다 — 겹침 Esc가 함께 먹지 않는다.
    findBar().find("input").type("{esc}");
    cy.get(".chat-find-bar").should("not.exist");
    cy.get(".drawer-body").should("be.visible");
  });

  it("'전체 찾기'는 앞 구간을 끝까지 불러온 뒤 다시 세고 꼬리표를 거둔다", () => {
    cy.get("body").trigger("keydown", { key: "f", metaKey: true });
    findBar().find("input").type("찾을낱말");
    count().should("have.text", "1/2");

    // 아직 올라오지 않은 구간이 있을 때만 단추가 선다.
    findBar().find(".chat-find-expand").should("have.text", "전체 찾기").click();

    // 앞 구간이 붙으면 결과가 셋이 되고, 더 불러올 것이 없으므로 꼬리표와 단추가 사라진다.
    count().should("have.text", "1/3");
    cy.get(".transcript-load-earlier").should("not.exist");
    cy.get(".chat-find-scope").should("not.exist");
    findBar().find(".chat-find-expand").should("not.exist");

    // 자리 번호는 처음으로 되돌아간다 — 앞 구간이 붙으면 보고 있던 번호가 다른 곳을 가리킨다.
    findBar().find('button[aria-label="다음 결과"]').click();
    count().should("have.text", "2/3");
  });
});
