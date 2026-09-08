// 반복 요청 카드의 실행 내역 접기·펼침과 실행 상세 로딩, 대기 상태 안내를 검증한다.
// - 최근 실행 1건만 노출되고 '이전 실행 보기' 버튼으로 나머지를 펼치고 다시 접는 동작
// - 완료된 실행의 details를 열었을 때 get_scheduled_run_detail IPC로 전문 요약을 비동기 로딩하는 동작
// - 대기 상태(waitingForAccount)의 실행은 처음부터 open=true로 펼쳐져 보이며, 안내 문구가 오류 스타일이 아닌 대기 문구로 렌더링되는 계약
// - 스케줄러 전체 일시정지/재개 토글 시 낙관적 업데이트와 경고 배너 표시 계약

const testSchedule = {
  id: "schedule-qa-history",
  name: "실행 내역 검증 반복 요청",
  source: "claude",
  enabled: true,
  prompt: "테스트 프롬프트 전문",
  workspace: "/tmp/qa-history",
  mode: "default",
  frequency: "daily",
  scheduledHour: 9,
  scheduledMinute: 0,
  intervalHours: 1,
  scheduledDays: ["mon"],
  cronExpression: "0 9 * * 1",
  sessionStrategy: "new",
  resumeFailurePolicy: "newSession",
  useActiveAccount: true,
  accountId: null,
  model: null,
  approvalMode: "never",
  reasoningEffort: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  nextRunAt: 1_700_100_000_000,
  lastRunAt: 1_700_050_000_000,
  manualRunRequestedAt: null,
};

const run1 = {
  id: "run-1",
  scheduleId: "schedule-qa-history",
  scheduledFor: 1_700_050_000_000,
  startedAt: 1_700_050_100_000,
  finishedAt: null,
  status: "running",
  requestedAccountId: "claude-qa",
  actualAccountId: "claude-qa",
  providerSessionId: "session-1",
  previousProviderSessionId: null,
  sessionReplaced: false,
  retryCount: 0,
  summary: "실행 중 미리보기 요약",
  error: null,
  lastHeartbeatAt: 1_700_050_200_000,
  cancellationRequestedAt: null,
  recoveryError: null,
  manual: false,
};

const run2 = {
  id: "run-2",
  scheduleId: "schedule-qa-history",
  scheduledFor: 1_700_040_000_000,
  startedAt: 1_700_040_100_000,
  finishedAt: 1_700_040_500_000,
  status: "completed",
  requestedAccountId: "claude-qa",
  actualAccountId: "claude-qa",
  providerSessionId: "session-2",
  previousProviderSessionId: null,
  sessionReplaced: false,
  retryCount: 0,
  summary: "완료된 실행 축약 미리보기",
  error: null,
  lastHeartbeatAt: null,
  cancellationRequestedAt: null,
  recoveryError: null,
  manual: false,
};

const run3 = {
  id: "run-3",
  scheduleId: "schedule-qa-history",
  scheduledFor: 1_700_030_000_000,
  startedAt: 1_700_030_100_000,
  finishedAt: null,
  status: "waitingForAccount",
  requestedAccountId: "claude-qa",
  actualAccountId: null,
  providerSessionId: null,
  previousProviderSessionId: null,
  sessionReplaced: false,
  retryCount: 1,
  summary: null,
  error: "계정 사용량 복구를 기다리고 있습니다.",
  lastHeartbeatAt: null,
  cancellationRequestedAt: null,
  recoveryError: null,
  manual: false,
};

function makeSnapshot(paused = false, runs = [run1, run2, run3]) {
  return {
    paused,
    runnerActive: true,
    schedules: [testSchedule],
    runs,
  };
}

describe("반복 요청 카드의 실행 내역 접기·펼침과 상세 로딩", () => {
  beforeEach(() => {
    cy.stubInvoke("get_scheduler_snapshot", { statusCode: 200, body: makeSnapshot(false) });
    cy.visitApp();
    cy.openView("chat");
    cy.anchor("chat.tab.schedules").click().should("have.class", "active");
    cy.get(".schedules-panel").should("be.visible");
  });

  it("실행 내역이 여러 개일 때 최근 1건만 노출되고 '이전 실행 보기' 버튼으로 펼치고 접을 수 있다", () => {
    // 초기에는 최근 실행 1건만 노출되고, 숨겨진 2건이 버튼에 표시된다.
    cy.get(".schedule-card").should("exist");
    cy.get(".schedule-run").should("have.length", 1);
    cy.get(".schedule-run").contains("summary span", "최근 실행").should("be.visible");

    // 이전 실행 보기 버튼 상태 확인
    cy.get(".schedule-run-more")
      .should("be.visible")
      .and("have.attr", "aria-expanded", "false")
      .and("contain.text", "이전 실행 보기");
    cy.get(".schedule-run-more em").should("have.text", "2");

    // 펼치기 클릭
    cy.get(".schedule-run-more").click();

    // 3건이 모두 보이고 aria-expanded가 true로 전환되며 버튼 텍스트가 바뀐다.
    cy.get(".schedule-run-more")
      .should("have.attr", "aria-expanded", "true")
      .and("contain.text", "실행 내역 접기");
    cy.get(".schedule-run-more em").should("not.exist");
    cy.get(".schedule-run").should("have.length", 3);

    // 다시 접기 클릭
    cy.get(".schedule-run-more").click();

    // 다시 1건으로 축소되고 원래 버튼 텍스트와 뱃지가 복원된다.
    cy.get(".schedule-run").should("have.length", 1);
    cy.get(".schedule-run-more")
      .should("have.attr", "aria-expanded", "false")
      .and("contain.text", "이전 실행 보기");
    cy.get(".schedule-run-more em").should("have.text", "2");
  });

  it("완료된 실행 내역을 펼치면 get_scheduled_run_detail을 호출해 전문 요약으로 갱신한다", () => {
    const fullSummary = "이것은 백엔드에서 비동기로 가져온 실행 결과의 전문 요약입니다.";
    cy.stubInvoke("get_scheduled_run_detail", {
      statusCode: 200,
      body: {
        run: { ...run2, summary: fullSummary },
        summaryTruncated: false,
        errorTruncated: false,
      },
    }).as("getDetail");

    // 먼저 전체 목록을 펼친다.
    cy.get(".schedule-run-more").click();
    cy.get(".schedule-run").should("have.length", 3);

    // 완료된 실행(두 번째 run)은 완료 상태이므로 닫혀 있다.
    cy.get(".schedule-run").eq(1).should("not.have.attr", "open");
    cy.get(".schedule-run").eq(1).find("summary").click();

    // 열리면서 get_scheduled_run_detail IPC가 트리거된다.
    cy.wait("@getDetail");
    cy.get(".schedule-run").eq(1).should("have.attr", "open");
    cy.get(".schedule-run").eq(1).find("pre").should("contain.text", fullSummary);
  });

  it("대기(waitingForAccount) 상태인 실행은 기본 open 상태이며 오류가 아닌 대기 안내 문구로 렌더링된다", () => {
    // 전체 목록을 펼친다.
    cy.get(".schedule-run-more").click();
    cy.get(".schedule-run").should("have.length", 3);

    // 세 번째 run은 대기 상태(active)이므로 처음부터 열려(open) 있다.
    cy.get(".schedule-run").eq(2).should("have.attr", "open");

    // 오류 클래스가 아닌 대기 전용 안내 문구(.schedule-run-waiting)로 표시되어야 한다.
    cy.get(".schedule-run").eq(2).find(".schedule-run-waiting")
      .should("be.visible")
      .and("contain.text", "계정 사용량 복구를 기다리고 있습니다.");
    cy.get(".schedule-run").eq(2).find(".schedule-run-error").should("not.exist");
  });

  it("스케줄러 전체 일시정지 및 재개 토글 시 낙관적 업데이트와 배너가 전환된다", () => {
    cy.stubInvoke("set_schedules_paused", {
      statusCode: 200,
      body: makeSnapshot(true),
    }).as("setPaused");

    // 초기 상태: 전체 일시정지 버튼이 보이고 경고 배너는 없음
    cy.contains(".schedules-panel header button", "전체 일시정지").should("be.visible");
    cy.get(".warning-banner").should("not.exist");

    // 전체 일시정지 클릭
    cy.contains(".schedules-panel header button", "전체 일시정지").click();

    // 즉시 버튼이 '전체 재개'로 바뀌고 일시정지 경고 배너가 나타남
    cy.contains(".schedules-panel header button", "전체 재개").should("be.visible");
    cy.get(".warning-banner").should("contain.text", "전체 일시정지 중입니다.");

    // 다시 재개 클릭 준비
    cy.stubInvoke("set_schedules_paused", {
      statusCode: 200,
      body: makeSnapshot(false),
    }).as("setResume");

    cy.contains(".schedules-panel header button", "전체 재개").click();

    // 다시 '전체 일시정지' 버튼으로 돌아오고 경고 배너가 사라짐
    cy.contains(".schedules-panel header button", "전체 일시정지").should("be.visible");
    cy.get(".warning-banner").should("not.exist");
  });
});
