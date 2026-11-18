/// <reference types="cypress" />
// 4b2e550a가 세션 목록에 출처(meta.origin.kind === "schedule") 필터 축을 더했다.
// 기존 AM-14 시나리오와 am20260907-sessions-more-filters 스펙은 '추가 필터' 팝오버의
// 체크 상태와 배지 숫자만 봤을 뿐, 그 체크가 실제로 행을 거르는지, 그리고 필터에 걸린
// 회차 세션을 대시보드에서 열었을 때 목록에 함께 보이는지는 어느 시나리오도 확인하지
// 않았다. 격리 백엔드에는 세션이 0건이라 스냅숏의 sessions만 갈아 끼워 본다.
//
// 바깥에서 연 세션은 필터를 켜서 드러내지 않고 그 한 건만 목록에 끼워 넣는다. 예전에는
// 필터를 실제로 켰던 탓에 알림에서 회차 하나를 열면 '반복 요청 포함'이 켜진 채 남았다.

import type { SessionDetail, SessionSummary } from "../../src/types";

function session(id: string, title: string, origin: SessionSummary["meta"]["origin"], updatedAt: number): SessionSummary {
  return {
    source: "codex",
    id,
    title,
    sourceTitle: null,
    project: "/tmp/qa-schedule-origin",
    cwd: "/tmp/qa-schedule-origin",
    startedAt: 1_757_200_000_000,
    updatedAt,
    messageCount: 3,
    tokenTotal: 120,
    tokenUsage: null,
    model: "gpt-5",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 1024,
    filePath: `/tmp/qa-schedule-origin/${id}.jsonl`,
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
      origin,
    },
    lastFailure: null,
  };
}

const USER_SESSION = session("qa-origin-user", "QA_USER_ORIGIN_SESSION", { kind: "user" }, 1_757_200_100_000);
const SCHEDULE_SESSION = session(
  "qa-origin-schedule",
  "QA_SCHEDULE_ORIGIN_SESSION",
  { kind: "schedule", scheduleId: "qa-schedule-1", runId: "qa-run-1" },
  1_757_200_200_000,
);

const DETAIL: SessionDetail = {
  session: SCHEDULE_SESSION,
  transcript: [],
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const MORE_FILTER_TRIGGER = ".more-filter-trigger";
const MORE_FILTER_PANEL = "#session-more-filter-panel";
const scheduleCheckbox = () =>
  cy.get(MORE_FILTER_PANEL).contains("label", "반복 요청 포함").find('input[type="checkbox"]');

describe("세션 목록의 반복 요청(출처=schedule) 필터 축", () => {
  beforeEach(() => {
    // 대시보드 최근 목록은 스냅샷의 다른 필드(dashboard.recent)라 목록과 함께 갈아 끼운다.
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        const body = res.body as { sessions: unknown; dashboard: { recent: unknown } };
        body.sessions = [SCHEDULE_SESSION, USER_SESSION];
        body.dashboard.recent = [SCHEDULE_SESSION, USER_SESSION];
      });
    });
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
  });

  it("기본 상태에서는 회차 세션이 목록에서 빠지고 체크하면 함께 보인다", () => {
    cy.openView("sessions").should("be.visible");

    // 기본값은 includeSchedule=false다. 사용자 대화만 남는다.
    cy.get(".session-table tbody tr").should("have.length", 1);
    cy.contains(".session-table tbody tr", USER_SESSION.title).should("exist");
    cy.contains(".session-table tbody tr", SCHEDULE_SESSION.title).should("not.exist");
    cy.contains(".table-caption strong", "세션 1개").should("exist");

    cy.get(MORE_FILTER_TRIGGER).click();
    scheduleCheckbox().should("not.be.checked").check();
    cy.get("body").type("{esc}");

    cy.get(".session-table tbody tr").should("have.length", 2);
    cy.contains(".session-table tbody tr", SCHEDULE_SESSION.title).should("exist");
    cy.contains(".table-caption strong", "세션 2개").should("exist");

    // 다시 해제하면 원래대로 걸러진다.
    cy.get(MORE_FILTER_TRIGGER).click();
    scheduleCheckbox().uncheck();
    cy.get("body").type("{esc}");
    cy.contains(".session-table tbody tr", SCHEDULE_SESSION.title).should("not.exist");
  });

  it("대시보드 최근 세션에서 회차 세션을 열면 필터를 켜지 않고 그 한 건만 목록에 끼워 넣는다", () => {
    cy.openView("dashboard").should("be.visible");
    // 대시보드 최근 세션 패널은 목록 필터를 거치지 않으므로 회차 세션도 그대로 나온다.
    cy.contains(".recent-list button", SCHEDULE_SESSION.title).click();

    cy.view("sessions").should("be.visible");
    cy.wait("@detail");

    // 연 세션 한 건만 목록에 끼워 넣는다. 필터 값은 그대로라 배지도 붙지 않는다 —
    // 예전처럼 includeSchedule을 켜 버리면 알림 한 번에 이후 목록이 회차로 덮인다.
    cy.contains(".session-table tbody tr", SCHEDULE_SESSION.title).should("exist");
    cy.contains(".session-table tbody tr", USER_SESSION.title).should("exist");
    cy.get(MORE_FILTER_TRIGGER).find("em").should("not.exist");

    // 상세를 닫으면 끼워 넣기도 걷혀 목록은 원래 좁힘으로 돌아간다.
    cy.get(".drawer-header").find('button[aria-label="닫기"]').click();
    cy.contains(".session-table tbody tr", SCHEDULE_SESSION.title).should("not.exist");
    cy.contains(".session-table tbody tr", USER_SESSION.title).should("exist");

    // 팝오버를 열어도 체크는 꺼진 채다.
    cy.get(MORE_FILTER_TRIGGER).click();
    scheduleCheckbox().should("not.be.checked");
  });
});
