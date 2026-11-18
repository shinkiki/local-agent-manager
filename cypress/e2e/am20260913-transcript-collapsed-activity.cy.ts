/// <reference types="cypress" />
// 9f2965f가 트랜스크립트 블록의 성격 가름을 transcriptBlockGroup 한 표로 모으면서, 접힌
// 작업 로그 요약의 개수 세기와 표시 갈래 선택이 같은 표를 읽게 됐다. 커밋이 "그대로 둔 것"으로
// 남긴 두 가지 — 도구 캡처 이미지는 도구 갈래지만 개수에 더하지 않는다, 응답 실패는 대화 본문에
// 남고 접힌 로그로 내려가지 않는다 — 를 세션 상세 대화 탭에서 확인한다.
// AM-210은 '작업 로그' 탭의 필터별 항목 분리를 봤고, 대화 탭의 접힌 요약은 처음 본다.

import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-collapsed-activity-session",
  title: "접힌 작업 로그 표본",
  sourceTitle: null,
  project: "/tmp/qa-collapsed-activity",
  cwd: "/tmp/qa-collapsed-activity",
  startedAt: 1_757_100_000_000,
  updatedAt: 1_757_100_060_000,
  messageCount: 9,
  tokenTotal: 210,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 2048,
  filePath: "/tmp/qa-collapsed-activity/session.jsonl",
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
  // 1턴: 도구 한 벌 + 추론 한 벌. 도구 결과에 딸린 캡처 이미지는 도구 갈래지만 개수에 안 든다.
  { index: 0, turnId: "turn-1", role: "user", timestamp: 1, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_REQUEST_ONE" }], usage: null },
  { index: 1, turnId: "turn-1", role: "assistant", timestamp: 2, model: null, typeLabel: null, blocks: [{ kind: "thinking", text: "QA_REASONING_MARKER" }], usage: null },
  { index: 2, turnId: "turn-1", role: "assistant", timestamp: 3, model: null, typeLabel: null, blocks: [{ kind: "tool_use", name: "Bash", inputJson: "{\"cmd\":\"true\"}" }], usage: null },
  {
    index: 3, turnId: "turn-1", role: "assistant", timestamp: 4, model: null, typeLabel: null, usage: null,
    blocks: [
      { kind: "tool_result", text: "QA_TOOL_OK_MARKER", isError: false },
      { kind: "image", mediaType: "image/png", byteSize: 1024, sourceOffset: 0, sourcePointer: "qa-capture-1" },
    ],
  },
  { index: 4, turnId: "turn-1", role: "assistant", timestamp: 5, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_ANSWER_MARKER" }], usage: null },
  // 2턴: 도구가 오류로 끝나고 런타임 실패가 뒤따른다. 실패는 대화 본문에 남아야 한다.
  { index: 5, turnId: "turn-2", role: "user", timestamp: 6, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_REQUEST_TWO" }], usage: null },
  { index: 6, turnId: "turn-2", role: "assistant", timestamp: 7, model: null, typeLabel: null, blocks: [{ kind: "tool_use", name: "Read", inputJson: "{\"path\":\"missing\"}" }], usage: null },
  { index: 7, turnId: "turn-2", role: "assistant", timestamp: 8, model: null, typeLabel: null, blocks: [{ kind: "tool_result", text: "QA_TOOL_ERROR_MARKER", isError: true }], usage: null },
  { index: 8, turnId: "turn-2", role: "runtime_failure", timestamp: 9, model: null, typeLabel: "응답 실패", blocks: [{ kind: "runtime_failure", status: "failed", code: "qa_failure", text: "QA_FAILURE_MARKER" }], usage: null },
];

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const turns = () => cy.get(".transcript-turn.conversation-turn");
const turnOne = () => turns().eq(0);
const turnTwo = () => turns().eq(1);

describe("세션 상세 대화 탭의 접힌 작업 로그 요약", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.wait("@detail");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
      .contains('[role="tab"]', "대화")
      .should("have.attr", "aria-selected", "true");
  });

  it("도구 캡처 이미지는 요약 개수를 부풀리지 않고, 접힌 동안 작업 블록 본문이 숨는다", () => {
    turns().should("have.length", 2);
    turnOne().should("contain.text", "QA_REQUEST_ONE").and("contain.text", "QA_ANSWER_MARKER");

    // tool_use 1 · tool_result 1 → 도구 1개. 같은 항목의 캡처 이미지는 더해지지 않는다.
    turnOne().find(".turn-activity-toggle")
      .should("have.attr", "aria-expanded", "false")
      .find("strong")
      .should("have.text", "도구 1개 · 진행 상황 1개");
    turnOne().find(".turn-activity-toggle em").should("contain.text", "응답 종료");

    turnOne().should("not.contain.text", "QA_REASONING_MARKER");
    turnOne().should("not.contain.text", "QA_TOOL_OK_MARKER");
    turnOne().find(".turn-activity-entry").should("not.exist");
  });

  it("펼치면 요약이 가리킨 항목이 모두 나오고 다시 접으면 사라진다", () => {
    turnOne().find(".turn-activity-toggle").click();
    turnOne().find(".turn-activity-toggle").should("have.attr", "aria-expanded", "true");
    // 추론 1 + 도구 호출 1 + 도구 결과 1 = 항목 3개. 요약의 도구 1개는 호출·결과 한 벌이다.
    turnOne().find(".turn-activity-entry").should("have.length", 3);
    turnOne().should("contain.text", "QA_REASONING_MARKER").and("contain.text", "QA_TOOL_OK_MARKER");

    turnOne().find(".turn-activity-toggle").click();
    turnOne().find(".turn-activity-toggle").should("have.attr", "aria-expanded", "false");
    turnOne().find(".turn-activity-entry").should("not.exist");
    turnOne().should("not.contain.text", "QA_REASONING_MARKER");
  });

  it("런타임 실패는 접힌 로그가 아니라 대화 본문에 그대로 남고 요약 상태를 실패로 바꾼다", () => {
    turnTwo().should("contain.text", "QA_REQUEST_TWO");
    // 실패 블록은 접기 전부터 보인다 — 대화 갈래이면서 작업 로그 갈래가 아니기 때문이다.
    turnTwo().should("contain.text", "QA_FAILURE_MARKER");
    turnTwo().find(".turn-activity-toggle strong").should("have.text", "도구 1개");
    turnTwo().find(".turn-activity-toggle em").should("contain.text", "실패 포함");
    turnTwo().find(".turn-activity-toggle .chat-tool-state").should("have.class", "chat-tool-state-failed");

    turnTwo().find(".turn-activity-toggle").click();
    turnTwo().find(".turn-activity-entry").should("have.length", 2);
    turnTwo().should("contain.text", "QA_TOOL_ERROR_MARKER");
    // 펼쳐도 실패 본문은 접힌 로그 안으로 들어가지 않는다.
    turnTwo().find(".turn-activity-entry").should("not.contain.text", "QA_FAILURE_MARKER");
  });
});
