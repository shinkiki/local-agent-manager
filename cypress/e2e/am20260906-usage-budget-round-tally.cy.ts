import { pacingConsumer, usageBudget } from "../support/workflowFixtures";

// 회차 봉투는 기동이 0건이어도 성공으로 끝난다. 그래서 실행 목록은 몇 시간째 아무것도
// 안 띄운 회차도 전부 "완료"로 보여 준다. 소비자 카드의 회차 성과 표기와 최근 회차
// 일함·쉼 집계가 그 둘을 실제로 가르는지, 표본이 최근 12회차에서 끊기는지를 붙잡는다.
describe("페이싱 소비자 카드의 회차 성과와 최근 회차 집계", () => {
  const round = (launchedRuns: number, staleRuns = 0) => ({
    plannedRuns: launchedRuns,
    launchedRuns,
    staleRuns,
    maxRuns: 5,
  });

  // 최근순 15건. 앞 12건은 일함 4 · 쉼 8 · 기동 합계 10이고, 표본을 넘어선 뒤 3건은
  // 각각 5건씩 띄웠다 — 표본 상한이 무너지면 합계가 25로 튀어 바로 드러난다.
  const LAUNCHED_SERIES = [2, 0, 0, 3, 0, 1, 0, 0, 0, 4, 0, 0, 5, 5, 5];

  const workedRuns = LAUNCHED_SERIES.map((launched, index) => ({
    id: `run-worked-${index}`,
    scheduleId: "paced-worked",
    status: "completed",
    scheduledFor: 1_760_000_000_000 - index * 600_000,
    round: index === 0 ? round(launched, 1) : round(launched),
  }));

  const restedRuns = [0, 0, 0].map((launched, index) => ({
    id: `run-rested-${index}`,
    scheduleId: "paced-rested",
    status: "completed",
    scheduledFor: 1_760_000_000_000 - index * 600_000,
    round: round(launched),
  }));

  // 회차 봉투 없이 도는 반복 요청. 집계할 회차가 없으므로 그 자리는 아예 비어야 한다.
  const plainRuns = [
    { id: "run-plain-0", scheduleId: "paced-plain", status: "completed", scheduledFor: 1_760_000_000_000 },
  ];

  const schedule = (id: string, name: string) => ({
    id,
    name,
    enabled: true,
    nextRunAt: 1_760_000_600_000,
    recurrence: { frequency: "auto" },
    workflow: { workflowId: "wf-paced", approvedVersion: 1, arguments: {} },
  });

  beforeEach(() => {
    cy.stubInvoke("get_scheduler_snapshot", {
      paused: false,
      runnerActive: true,
      schedules: [
        schedule("paced-worked", "일한 회차"),
        schedule("paced-rested", "쉰 회차"),
        schedule("paced-plain", "회차 봉투 없는 요청"),
      ],
      runs: [...workedRuns, ...restedRuns, ...plainRuns],
    });
    cy.stubInvoke("get_usage_budget", usageBudget({
      activeConsumers: ["paced-worked", "paced-rested", "paced-plain"],
      pacingWorkflowIds: ["wf-paced"],
      consumers: [
        pacingConsumer({
          scheduleId: "paced-worked",
          name: "일한 회차",
          workflowId: "wf-paced",
          costs: { perProvider: {}, recordedRuns: 7, savings: {} },
        }),
        pacingConsumer({ scheduleId: "paced-rested", name: "쉰 회차", workflowId: "wf-paced" }),
        pacingConsumer({ scheduleId: "paced-plain", name: "회차 봉투 없는 요청", workflowId: "wf-paced" }),
      ],
    }));
    cy.visitApp();
    cy.openPacingTab();
  });

  const card = (scheduleId: string) => cy.get(`.usage-budget-card[data-schedule-id="${scheduleId}"]`);

  it("최근 실행 자리에 회차가 실제로 띄운 건수와 정리 건수가 상태 대신 서고, 상태는 보조줄로 내려간다", () => {
    card("paced-worked").within(() => {
      cy.contains(".usage-budget-metrics > div", "최근 실행").within(() => {
        cy.get("dd").should("contain.text", "기동 2건").and("contain.text", "정리 1건");
        cy.get("dd > span").should("contain.text", "완료").and("contain.text", "기록 7건");
      });
    });
  });

  it("기동이 0건인 회차는 완료가 아니라 쉼으로 읽힌다", () => {
    card("paced-rested").within(() => {
      cy.contains(".usage-budget-metrics > div", "최근 실행").within(() => {
        cy.get("dd").should("contain.text", "쉼").and("contain.text", "기동 없음").and("not.contain.text", "기동 0건");
        cy.get("dd > span").should("contain.text", "완료");
      });
    });
  });

  it("상세정보 접힌 줄에 최근 회차 중 일한 횟수가 나오고, 펼치면 일함·쉼과 기동 합계가 최근 12회차로 끊긴다", () => {
    card("paced-worked").within(() => {
      cy.get(".usage-budget-detail-toggle small").should("contain.text", "최근 12회차 중 일함 4");
      cy.get(".usage-budget-detail-toggle").click();
      cy.contains(".usage-budget-card-details .usage-budget-metrics > div", "최근 12회차").within(() => {
        cy.get("dd").should("contain.text", "일함 4").and("contain.text", "쉼 8");
        cy.get("dd > span").should("contain.text", "기동 합계 10건");
      });
    });
  });

  it("회차 봉투가 없는 반복 요청은 최근 회차 집계 자리를 만들지 않는다", () => {
    card("paced-plain").within(() => {
      cy.get(".usage-budget-detail-toggle small").should("not.contain.text", "최근");
      cy.get(".usage-budget-detail-toggle").click();
      cy.get(".usage-budget-card-details").should("exist");
      cy.get(".usage-budget-card-details").should("not.contain.text", "일함");
    });
  });
});
