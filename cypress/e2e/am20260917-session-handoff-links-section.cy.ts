/// <reference types="cypress" />
/**
 * 세션 상세 '에이전트 인계 기록' 구역을 화면에서 확인한다.
 *
 * 724f862a(스냅숏 정규화가 meta.origin·handoffOrigin·handoffTargets를 떨어뜨리던 문제)
 * 이전에는 이 구역이 어느 세션에서도 렌더되지 않았고, 고친 뒤에도 E2E로 본 적이 없다.
 * 세션 서랍의 '세션 설정' 패널을 펼치는 스펙 자체가 없어(그 안의
 * SessionHandoffLinksSection·SessionAccountPinSection 모두) 이 구역은 미검증이다.
 *
 * 대상 코드는 src/components/SessionsView.tsx:143(resolveSessionHandoffLinks)과
 * :3165(SessionHandoffLinksSection), 서랍에 꽂히는 자리는 :2795다.
 *
 * 1. 인계 링크가 없는 세션에서는 구역이 아예 그려지지 않는다(:3174).
 * 2. 인계 대상이 둘이면 표시 순서대로 그려지고, 카탈로그에서 찾은 링크만 누를 수 있다.
 *    못 찾은 링크는 비활성이고 그 사실을 title로 알린다(:3186-3188).
 * 3. 누르면 그 세션 서랍으로 전환되고, 그쪽에서는 같은 링크가 '원본'으로 보인다.
 *    대상이 기본 필터(반복 요청 접기)에 걸려 목록에 없더라도 카탈로그에서 풀린다.
 */
import type { SessionDetail, SessionSummary } from "../../src/types";

const BASE = 1_757_300_000_000;

function session(
  id: string,
  title: string,
  source: SessionSummary["source"],
  meta: Partial<SessionSummary["meta"]>,
): SessionSummary {
  return {
    source,
    id,
    title,
    sourceTitle: null,
    project: "/tmp/qa-handoff-links",
    cwd: "/tmp/qa-handoff-links",
    startedAt: BASE - 60_000,
    updatedAt: BASE,
    messageCount: 2,
    tokenTotal: 90,
    tokenUsage: null,
    model: "qa-model",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 1024,
    filePath: `/tmp/qa-handoff-links/${id}.jsonl`,
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
      ...meta,
    },
    lastFailure: null,
  };
}

/** 인계를 보낸 원본. 대상 하나는 카탈로그에 있고 하나는 없다. */
const ORIGIN = session("qa-handoff-origin", "QA_HANDOFF_ORIGIN", "codex", {
  handoffTargets: [
    { source: "claude", id: "qa-handoff-target" },
    { source: "claude", id: "qa-handoff-missing" },
  ],
});

/**
 * 인계로 만들어진 세션. 반복 요청 출처라 기본 필터에서는 목록에 없지만, 서랍이 받는
 * 세션 목록은 걸러지기 전 카탈로그라 링크는 풀려야 한다.
 */
const TARGET = session("qa-handoff-target", "QA_HANDOFF_TARGET", "claude", {
  handoffOrigin: { source: "codex", id: "qa-handoff-origin" },
  origin: { kind: "schedule", scheduleId: "qa-schedule-1", runId: "qa-run-1" },
});

/** 인계와 무관한 세션. 구역이 아예 뜨지 않는 쪽을 본다. */
const PLAIN = session("qa-handoff-plain", "QA_HANDOFF_PLAIN", "codex", {});

const detail = (target: SessionSummary): SessionDetail => ({
  session: target,
  transcript: [],
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
});

const openSettings = () => cy.get(".session-settings-toggle").click();
const linkSection = () => cy.get(".session-handoff-links");

describe("세션 상세 '에이전트 인계 기록' 구역", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [ORIGIN, TARGET, PLAIN]);
    cy.stubInvoke("get_session_detail", (req) => {
      const { request } = req.body as { request: { id: string } };
      const found = [ORIGIN, TARGET, PLAIN].find((candidate) => candidate.id === request.id) ?? ORIGIN;
      req.reply({ statusCode: 200, body: detail(found) });
    });
    cy.visitApp();
    cy.openView("sessions").should("be.visible");
  });

  it("인계 링크가 없는 세션에는 구역이 그려지지 않는다", () => {
    cy.contains(".session-table tbody tr", PLAIN.title).click();
    openSettings();
    cy.get(".session-drawer-settings").should("be.visible");
    linkSection().should("not.exist");
  });

  it("인계 대상 둘을 순서대로 그리고 카탈로그에서 찾은 링크만 누를 수 있다", () => {
    cy.contains(".session-table tbody tr", ORIGIN.title).click();
    openSettings();

    linkSection().find("h4").should("have.text", "에이전트 인계 기록");
    linkSection().find("button").should("have.length", 2);
    linkSection().find("button").eq(0)
      .should("not.be.disabled")
      .and("contain.text", "인계 대상")
      .and("contain.text", TARGET.title)
      .and("have.attr", "title", "연결된 세션 열기");
    linkSection().find("button").eq(1)
      .should("be.disabled")
      .and("contain.text", "qa-handoff-missing")
      .and("have.attr", "title", "아직 세션 목록에서 찾지 못했습니다");
  });

  it("인계 대상을 누르면 그 세션 서랍으로 넘어가고 같은 링크가 '원본'으로 보인다", () => {
    cy.contains(".session-table tbody tr", ORIGIN.title).click();
    openSettings();
    linkSection().find("button").eq(0).click();

    // 서랍이 대상 세션으로 갈아 끼워진다(키가 바뀌며 설정 패널은 접힌 채 다시 뜬다).
    cy.get(".drawer").should("contain.text", TARGET.title);
    openSettings();
    linkSection().find("button").should("have.length", 1);
    linkSection().find("button").eq(0)
      .should("not.be.disabled")
      .and("contain.text", "원본")
      .and("contain.text", ORIGIN.title);
  });
});
