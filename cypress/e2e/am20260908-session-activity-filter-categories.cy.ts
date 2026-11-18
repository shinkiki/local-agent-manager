/// <reference types="cypress" />
// 52a3087이 실시간·세션 원문 작업 로그의 분류 판정을 switch와 단일 순회로 바꿨다.
// 단위 테스트는 개별 판정 함수만 확인하므로, 이 스펙은 세션 상세 화면에서 사용자가 고르는
// 네 필터가 실제 렌더 항목을 서로 섞지 않는지 확인한다. AM-93은 격리 홈에 런타임이 없어
// 작업 로그 항목·필터를 범위 밖으로 뒀고, 저장된 원문 응답을 주입한 화면 검증은 처음이다.

import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-activity-filter-session",
  title: "작업 로그 분류 표본",
  sourceTitle: null,
  project: "/tmp/qa-activity-filter",
  cwd: "/tmp/qa-activity-filter",
  startedAt: 1_757_000_000_000,
  updatedAt: 1_757_000_060_000,
  messageCount: 9,
  tokenTotal: 321,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 4096,
  filePath: "/tmp/qa-activity-filter/session.jsonl",
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
  { index: 3, turnId: "turn-1", role: "assistant", timestamp: 4, model: null, typeLabel: null, blocks: [{ kind: "tool_result", text: "QA_TOOL_OK_MARKER", isError: false }], usage: null },
  { index: 4, turnId: "turn-1", role: "assistant", timestamp: 5, model: null, typeLabel: null, blocks: [{ kind: "context", label: "사용 스킬 · qa-filter", text: "QA_SKILL_MARKER" }], usage: null },
  { index: 5, turnId: "turn-1", role: "assistant", timestamp: 6, model: null, typeLabel: null, blocks: [{ kind: "tool_use", name: "Read", inputJson: "{\"path\":\"missing\"}" }], usage: null },
  { index: 6, turnId: "turn-1", role: "assistant", timestamp: 7, model: null, typeLabel: null, blocks: [{ kind: "tool_result", text: "QA_TOOL_ERROR_MARKER", isError: true }], usage: null },
  { index: 7, turnId: "turn-1", role: "runtime_failure", timestamp: 8, model: null, typeLabel: "응답 실패", blocks: [{ kind: "runtime_failure", status: "failed", code: "qa_failure", text: "QA_RUNTIME_FAILURE_MARKER" }], usage: null },
];

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const log = () => cy.get(".transcript-section-activity");
const filter = () => cy.get('select[aria-label="작업 로그 항목 필터"]');

describe("세션 상세 작업 로그의 범주별 항목 분리", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.wait("@detail");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
      .contains('[role="tab"]', "작업 로그")
      .click()
      .should("have.attr", "aria-selected", "true");
  });

  it("도구·진행 상황·사용 스킬·오류 필터가 각 범주의 항목만 남기고 전체로 복원한다", () => {
    filter().should("have.value", "all");
    log().should("contain.text", "QA_REASONING_MARKER")
      .and("contain.text", "QA_TOOL_OK_MARKER")
      .and("contain.text", "QA_SKILL_MARKER")
      .and("contain.text", "QA_TOOL_ERROR_MARKER")
      .and("contain.text", "QA_RUNTIME_FAILURE_MARKER")
      // 전체는 턴의 사용자 요청도 함께 보여 작업 로그의 맥락을 보존한다.
      .and("contain.text", "QA_USER_TEXT");

    filter().select("reasoning");
    log().should("contain.text", "QA_REASONING_MARKER")
      .and("not.contain.text", "QA_TOOL_OK_MARKER")
      .and("not.contain.text", "QA_SKILL_MARKER")
      .and("not.contain.text", "QA_TOOL_ERROR_MARKER")
      .and("not.contain.text", "QA_RUNTIME_FAILURE_MARKER");

    filter().select("skill");
    log().should("contain.text", "QA_SKILL_MARKER")
      .and("not.contain.text", "QA_REASONING_MARKER")
      .and("not.contain.text", "QA_TOOL_OK_MARKER")
      .and("not.contain.text", "QA_TOOL_ERROR_MARKER")
      .and("not.contain.text", "QA_RUNTIME_FAILURE_MARKER");

    filter().select("error");
    log().should("contain.text", "QA_TOOL_ERROR_MARKER")
      .and("contain.text", "QA_RUNTIME_FAILURE_MARKER")
      .and("not.contain.text", "QA_REASONING_MARKER")
      .and("not.contain.text", "QA_TOOL_OK_MARKER")
      .and("not.contain.text", "QA_SKILL_MARKER");

    filter().select("tool");
    log().should("contain.text", "QA_TOOL_OK_MARKER")
      .and("contain.text", "QA_TOOL_ERROR_MARKER")
      .and("not.contain.text", "QA_REASONING_MARKER")
      .and("not.contain.text", "QA_SKILL_MARKER")
      .and("not.contain.text", "QA_RUNTIME_FAILURE_MARKER");

    filter().select("all");
    log().should("contain.text", "QA_REASONING_MARKER")
      .and("contain.text", "QA_TOOL_OK_MARKER")
      .and("contain.text", "QA_SKILL_MARKER")
      .and("contain.text", "QA_TOOL_ERROR_MARKER")
      .and("contain.text", "QA_RUNTIME_FAILURE_MARKER")
      .and("contain.text", "QA_USER_TEXT");

    cy.screenshot("am20260908-session-activity-filter-categories");
  });
});
