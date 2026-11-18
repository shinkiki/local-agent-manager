/// <reference types="cypress" />
// 999fbe41이 이어가기 작성기의 busy·설정 잠금·입력 가능 여부·계획 재시작 잠금·안내 문구를
// 순수 도우미 `continuationComposerState`(src/components/SessionsView.tsx) 한 벌로 옮겼다.
// 그중 실행 없이도 화면에 드러나는 갈래가 막힘 사유(blockedReason)다 — 작업 경로가 없는
// 세션과 서브에이전트 세션은 입력 자체가 잠기고, 안내 문구와 상태 줄이 모두 그 사유로
// 바뀌어야 한다. 기존 시나리오는 '대화' 탭의 말풍선·접힌 로그·로컬 링크만 봤고, 탭 아래
// 이어가기 작성기의 잠금 계약은 아직 어느 시나리오도 확인하지 않았다.

import type { SessionDetail, SessionSummary } from "../../src/types";

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    source: "codex",
    id: "qa-continuation-normal",
    title: "이어가기 표본",
    sourceTitle: null,
    project: "/tmp/qa-continuation",
    cwd: "/tmp/qa-continuation",
    startedAt: 1_757_200_000_000,
    updatedAt: 1_757_200_060_000,
    messageCount: 2,
    tokenTotal: 40,
    tokenUsage: null,
    model: "gpt-5",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 512,
    filePath: "/tmp/qa-continuation/session.jsonl",
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
    ...overrides,
  };
}

const NORMAL = summary({});
const NO_CWD = summary({ id: "qa-continuation-nocwd", title: "경로 없는 표본", cwd: null, project: null });
const SUBAGENT = summary({ id: "qa-continuation-subagent", title: "서브에이전트 표본", isSubagent: true });

function detail(session: SessionSummary): SessionDetail {
  return {
    session,
    transcript: [
      { index: 0, turnId: "turn-1", role: "user", timestamp: 1, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_USER_TEXT" }], usage: null },
    ],
    truncated: false,
    skippedLines: 0,
    unavailableReason: null,
  };
}

const FOOTER = ".session-continuation-footer";
const COMPOSER = `${FOOTER} textarea[aria-label="세션 대화 이어가기"]`;

function openConversation(session: SessionSummary, includeSubagents = false) {
  cy.stubSnapshotField("sessions", [session]);
  cy.stubInvoke("get_session_detail", { statusCode: 200, body: detail(session) }).as("detail");
  cy.visitApp();
  cy.openView("sessions");
  if (includeSubagents) {
    cy.get(".more-filter-trigger").click();
    cy.get("#session-more-filter-panel").contains("label", "서브에이전트 포함").find('input[type="checkbox"]').check();
    cy.get(".more-filter-trigger").click();
  }
  cy.contains(".session-table tbody tr", session.title).click();
  cy.wait("@detail");
  cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
    .contains('[role="tab"]', "대화")
    .click()
    .should("have.attr", "aria-selected", "true");
}

describe("세션 상세 대화 탭 이어가기 작성기의 막힘 사유 잠금", () => {
  it("이어갈 수 있는 세션은 입력이 열리고 기본 안내와 입력 대기 상태를 세운다", () => {
    openConversation(NORMAL);
    cy.get(COMPOSER)
      .should("not.be.disabled")
      .and("have.attr", "placeholder", "이 세션에 이어서 메시지를 입력한 뒤 전송 버튼을 누르세요");
    cy.get(FOOTER).should("contain.text", "입력 대기");
  });

  it("작업 경로가 없는 세션은 입력이 잠기고 안내와 상태 줄이 모두 그 사유로 바뀐다", () => {
    openConversation(NO_CWD);
    cy.get(COMPOSER)
      .should("be.disabled")
      .and("have.attr", "placeholder", "작업 경로가 없어 이어갈 수 없습니다");
    cy.get(FOOTER).should("contain.text", "작업 경로가 없어 이어갈 수 없습니다");
    // 막힘 사유가 상태 줄을 대신하므로 단계 문구는 남지 않는다.
    cy.get(FOOTER).should("not.contain.text", "입력 대기");
  });

  it("서브에이전트 세션은 입력이 잠기고 서브에이전트 사유를 세운다", () => {
    openConversation(SUBAGENT, true);
    cy.get(COMPOSER)
      .should("be.disabled")
      .and("have.attr", "placeholder", "서브에이전트 세션은 이어갈 수 없습니다");
    cy.get(FOOTER).should("contain.text", "서브에이전트 세션은 이어갈 수 없습니다");
    cy.get(FOOTER).should("not.contain.text", "입력 대기");
  });

  it("다른 탭으로 옮기면 작성기가 화면에서 사라진다", () => {
    openConversation(NORMAL);
    cy.get(FOOTER).should("exist");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
      .contains('[role="tab"]', "작업 로그")
      .click()
      .should("have.attr", "aria-selected", "true");
    cy.get(FOOTER).should("not.exist");
  });
});
