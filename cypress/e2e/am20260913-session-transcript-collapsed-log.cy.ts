/// <reference types="cypress" />
// 9f2965f가 트랜스크립트 블록의 성격 가름(message·tool·reasoning·context·failure)을
// 판정 표 한 벌로 모았다. 표시 술어 셋과 접힌 로그 요약이 같은 표를 읽게 됐으므로,
// 세션 상세 '대화' 탭에서 접힌 작업 로그의 요약 개수가 펼쳤을 때 실제로 보이는 항목과
// 맞는지, 같은 블록이 말풍선과 접힌 로그 두 자리에 겹쳐 나오지 않는지 화면으로 본다.
// AM-278은 같은 화면의 로컬 링크 미리보기만 봤고, 작업 로그 범주 분리 스펙은 '작업 로그'
// 탭만 봤다. '대화' 탭의 접힌 로그 계약은 아직 어느 시나리오도 확인하지 않았다.

import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-collapsed-log-session",
  title: "접힌 작업 로그 표본",
  sourceTitle: null,
  project: "/tmp/qa-collapsed-log",
  cwd: "/tmp/qa-collapsed-log",
  startedAt: 1_757_100_000_000,
  updatedAt: 1_757_100_060_000,
  messageCount: 6,
  tokenTotal: 210,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 2048,
  filePath: "/tmp/qa-collapsed-log/session.jsonl",
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

const transcript: TranscriptItem[] = [
  { index: 0, turnId: "turn-1", role: "user", timestamp: 1, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_USER_TEXT" }], usage: null },
  { index: 1, turnId: "turn-1", role: "assistant", timestamp: 2, model: null, typeLabel: null, blocks: [{ kind: "thinking", text: "QA_REASONING_MARKER" }], usage: null },
  { index: 2, turnId: "turn-1", role: "assistant", timestamp: 3, model: null, typeLabel: null, blocks: [{ kind: "tool_use", name: "Bash", inputJson: "{\"cmd\":\"true\"}" }], usage: null },
  { index: 3, turnId: "turn-1", role: "assistant", timestamp: 4, model: null, typeLabel: null, blocks: [{ kind: "tool_result", text: "QA_TOOL_MARKER", isError: false }], usage: null },
  // 도구 블록과 컨텍스트 블록이 한 항목에 섞인 자리. 컨텍스트는 대화 갈래에도, 접힌 로그
  // 갈래에도 그려지지 않으므로 요약 개수에 들어가면 펼친 화면과 어긋난다.
  {
    index: 4,
    turnId: "turn-1",
    role: "assistant",
    timestamp: 5,
    model: null,
    typeLabel: null,
    blocks: [
      { kind: "tool_use", name: "Grep", inputJson: "{\"pattern\":\"qa\"}" },
      { kind: "context", label: "컨텍스트 묶음", text: "QA_CONTEXT_MARKER" },
    ],
    usage: null,
  },
  { index: 5, turnId: "turn-1", role: "assistant", timestamp: 6, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_ANSWER_TEXT" }], usage: null },
];

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const turn = () => cy.get(".transcript-turn.conversation-turn");
const collapsed = () => turn().find(".turn-activity-summary");
const toggle = () => collapsed().find("button.turn-activity-toggle");

describe("세션 상세 대화 탭의 접힌 작업 로그 요약과 펼침 항목", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.wait("@detail");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
      .contains('[role="tab"]', "대화")
      .click()
      .should("have.attr", "aria-selected", "true");
  });

  it("대화에는 말풍선만 남고 작업 블록은 접힌 로그로 내려간다", () => {
    turn().should("contain.text", "QA_USER_TEXT").and("contain.text", "QA_ANSWER_TEXT");
    turn().should("not.contain.text", "QA_REASONING_MARKER");
    turn().should("not.contain.text", "QA_TOOL_MARKER");
    collapsed().should("exist");
    toggle().should("have.attr", "aria-expanded", "false");
    collapsed().find(".turn-activity-entry").should("not.exist");
  });

  it("펼치면 도구·진행 상황 항목이 보이고, 요약은 보이지 않는 컨텍스트를 세지 않는다", () => {
    toggle().find("strong").invoke("text").as("summary");
    toggle().click().should("have.attr", "aria-expanded", "true");
    collapsed().find(".turn-activity-entry").should("have.length.at.least", 1);
    collapsed().should("contain.text", "QA_REASONING_MARKER");
    collapsed().should("contain.text", "QA_TOOL_MARKER");
    collapsed().should("not.contain.text", "QA_CONTEXT_MARKER");
    cy.get("@summary").should("contain", "도구 2개");
    cy.get("@summary").should("contain", "진행 상황 1개");
    // QA #78. 컨텍스트 블록은 대화 갈래에도 접힌 로그 갈래에도 그려지지 않으므로
    // (`isConversationBlock`·`isConversationActivityBlock`) 요약도 세지 않는다. 접힌 줄의
    // 개수는 펼쳤을 때 실제로 보이는 항목 수와 같아야 한다.
    cy.get("@summary").should("not.contain", "컨텍스트");
  });

  it("다시 접으면 펼친 항목이 사라진다", () => {
    toggle().click().should("have.attr", "aria-expanded", "true");
    toggle().click().should("have.attr", "aria-expanded", "false");
    collapsed().find(".turn-activity-entry").should("not.exist");
    turn().should("not.contain.text", "QA_TOOL_MARKER");
  });
});
