/// <reference types="cypress" />
// 724f862a가 스냅숏 정규화에서 떨어뜨리던 handoffOrigin·handoffTargets를 되살리면서 세션
// 상세의 '에이전트 인계 기록' 구역이 다시 렌더될 수 있게 됐다. 그런데 이 구역 자체는 어느
// 시나리오도 화면으로 확인한 적이 없다 — 출처·대상의 표시 순서, 목록에서 찾지 못한 링크의
// 비활성 처리, 찾은 링크를 눌렀을 때 그 세션으로 서랍이 옮겨 가는지가 미검증이다.
// 격리 백엔드에는 세션이 0건이라 스냅숏의 sessions를 갈아 끼워 본다.

import type { SessionDetail, SessionSummary } from "../../src/types";

function session(
  id: string,
  title: string,
  meta: Partial<SessionSummary["meta"]>,
  updatedAt: number,
  customTitle: string | null = null,
): SessionSummary {
  return {
    source: "codex",
    id,
    title,
    sourceTitle: null,
    project: "/tmp/qa-handoff-links",
    cwd: "/tmp/qa-handoff-links",
    startedAt: 1_757_300_000_000,
    updatedAt,
    messageCount: 2,
    tokenTotal: 80,
    tokenUsage: null,
    model: "gpt-5",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 512,
    filePath: `/tmp/qa-handoff-links/${id}.jsonl`,
    meta: {
      favorite: false,
      hidden: false,
      note: null,
      customTitle,
      folderIds: [],
      reasoningEffort: null,
      mode: null,
      approvalMode: null,
      creationAccountId: null,
      boundAccountId: null,
      pinnedAccountId: null,
      origin: { kind: "user" },
      ...meta,
    },
    lastFailure: null,
  };
}

const ORIGIN = session("qa-handoff-origin", "QA_HANDOFF_ORIGIN", {}, 1_757_300_100_000);
// 대상 하나는 사용자가 제목을 바꿔 뒀다. 버튼 문구가 customTitle을 먼저 쓰는지 본다.
const TARGET = session("qa-handoff-target", "QA_HANDOFF_TARGET_RAW", {}, 1_757_300_200_000, "QA_HANDOFF_TARGET_RENAMED");
const MISSING_ID = "qa-handoff-missing";
const CURRENT = session("qa-handoff-current", "QA_HANDOFF_CURRENT", {
  handoffOrigin: { source: "codex", id: ORIGIN.id },
  handoffTargets: [
    { source: "codex", id: TARGET.id },
    { source: "codex", id: MISSING_ID },
  ],
}, 1_757_300_300_000);

const DETAIL: SessionDetail = {
  session: CURRENT,
  transcript: [],
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const HANDOFF_SECTION = ".session-handoff-links";

function openSettings(title: string) {
  cy.contains(".session-table tbody tr", title).click();
  cy.get(".session-settings-toggle").click();
}

describe("세션 상세의 에이전트 인계 기록 구역", () => {
  beforeEach(() => {
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        const body = res.body as { sessions: unknown };
        body.sessions = [CURRENT, TARGET, ORIGIN];
      });
    });
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
    cy.openView("sessions").should("be.visible");
  });

  it("원본·인계 대상을 순서대로 보이고 목록에 없는 링크는 누를 수 없다", () => {
    openSettings(CURRENT.title);

    cy.get(HANDOFF_SECTION).should("be.visible");
    cy.get(HANDOFF_SECTION).find("h4").should("have.text", "에이전트 인계 기록");
    cy.get(`${HANDOFF_SECTION} button`).should("have.length", 3);

    // 출처가 먼저, 그다음 대상이 담긴 순서대로 나온다.
    cy.get(`${HANDOFF_SECTION} button`).eq(0).should("contain.text", "원본")
      .and("contain.text", ORIGIN.title)
      .and("not.be.disabled");
    // 이름은 customTitle이 있으면 그것을 먼저 쓴다.
    cy.get(`${HANDOFF_SECTION} button`).eq(1).should("contain.text", "인계 대상")
      .and("contain.text", "QA_HANDOFF_TARGET_RENAMED")
      .and("not.contain.text", "QA_HANDOFF_TARGET_RAW")
      .and("not.be.disabled");
    // 목록에서 찾지 못한 링크는 ID를 그대로 보이고 비활성이다.
    cy.get(`${HANDOFF_SECTION} button`).eq(2).should("contain.text", "인계 대상")
      .and("contain.text", MISSING_ID)
      .and("be.disabled")
      .and("have.attr", "title", "아직 세션 목록에서 찾지 못했습니다");
  });

  it("연결된 링크를 누르면 그 세션의 서랍으로 옮겨 가고 링크가 없는 세션에는 구역이 없다", () => {
    openSettings(CURRENT.title);
    cy.get(`${HANDOFF_SECTION} button`).eq(1).click();

    // 서랍 제목이 대상 세션으로 바뀐다.
    cy.get(".drawer-title").should("contain.text", "QA_HANDOFF_TARGET_RENAMED")
      .and("not.contain.text", CURRENT.title);

    // 대상 세션에는 인계 링크가 없으므로 설정을 펼쳐도 구역 자체가 그려지지 않는다.
    cy.get(".session-settings-toggle").then(($toggle) => {
      if ($toggle.attr("aria-expanded") !== "true") cy.wrap($toggle).click();
    });
    cy.get(".session-settings-toggle").should("have.attr", "aria-expanded", "true");
    cy.get("#session-drawer-settings").should("be.visible");
    cy.get(HANDOFF_SECTION).should("not.exist");
  });
});
