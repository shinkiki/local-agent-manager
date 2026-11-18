/// <reference types="cypress" />
import { WORKFLOW_LIMITS, workflowSummary } from "../support/workflowFixtures";
import { pacingConsumer, usageBudget } from "../support/usageBudgetFixtures";

// 페이싱 탭 아래쪽의 "회차가 없어 돌지 않습니다" 행은 후보 판정이 두 갈래를 함께 본다:
// 워크플로가 페이싱 대상인가(`pacingEnabled`), 그리고 그 워크플로를 실제로 돌리는 반복 요청이
// 살아 있는가(`consumer.scheduleExists`). 반복 요청을 지우면 소비자 설정은 찌꺼기로 남으므로,
// 그 찌꺼기를 회차로 세면 해당 워크플로는 영영 새 회차를 못 만든다. 그 판정이 2026-09-18
// 리팩토링(ead6b691)으로 패널 본문에서 훅으로 옮겨졌고, 모달이 받는 후보 목록도 같은 값을 쓴다.
// 목록에 서는 행과 "페이싱 추가"로 여는 모달의 선택지가 같은 규칙을 따르는지 붙잡는다.
// AM-84가 "회차가 있는 워크플로는 후보에서 빠진다"까지 봤다. 여기서 더 가는 것은 반복 요청이
// 지워져 찌꺼기 소비자만 남은 경계와, 페이싱을 끈 워크플로가 후보 목록에 아예 없다는 것이다.
describe("회차 없는 페이싱 워크플로 후보 판정과 새 회차 모달의 선택지", () => {
  const paced = (id: string, displayName: string, pacingEnabled: boolean) => workflowSummary({
    id,
    displayName,
    pacingCapable: true,
    pacingEnabled,
    pacingMode: "envelope",
  });

  beforeEach(() => {
    cy.stubInvoke("get_system_workflows", {
      limits: WORKFLOW_LIMITS,
      workflows: [
        paced("wf-live", "회차가 도는 워크플로", true),
        paced("wf-stale", "회차를 지운 워크플로", true),
        paced("wf-fresh", "회차를 만든 적 없는 워크플로", true),
        paced("wf-off", "페이싱을 끈 워크플로", false),
      ],
    });
    cy.stubInvoke("get_scheduler_snapshot", {
      paused: false,
      runnerActive: true,
      schedules: [{
        id: "round-live",
        name: "도는 회차",
        enabled: true,
        nextRunAt: 1_760_000_600_000,
        recurrence: { frequency: "auto" },
        workflow: { workflowId: "wf-live", approvedVersion: 1, arguments: {} },
      }],
      runs: [],
    });
    cy.stubInvoke("get_usage_budget", usageBudget({
      activeConsumers: ["round-live"],
      pacingWorkflowIds: ["wf-live", "wf-stale", "wf-fresh"],
      consumers: [
        pacingConsumer({ scheduleId: "round-live", name: "도는 회차", workflowId: "wf-live" }),
        // 반복 요청은 지워졌고 예산 정책의 소비자 설정만 남은 찌꺼기.
        pacingConsumer({
          scheduleId: "round-stale",
          name: "지운 회차",
          workflowId: "wf-stale",
          scheduleExists: false,
          scheduleEnabled: null,
        }),
      ],
    }));
    cy.visitApp();
    cy.openPacingTab();
  });

  it("회차가 살아 있는 워크플로와 페이싱을 끈 워크플로는 후보 행에 서지 않는다", () => {
    cy.get("[data-roundless-workflow]").should("have.length", 2);
    cy.get('[data-roundless-workflow="wf-live"]').should("not.exist");
    cy.get('[data-roundless-workflow="wf-off"]').should("not.exist");
    // 회차가 하나라도 살아 있으므로 "회차가 없습니다" 빈 안내는 서지 않는다.
    cy.anchor("workflows.usage-budget.consumers").find(".settings-empty").should("not.exist");
  });

  it("반복 요청이 지워져 찌꺼기 설정만 남은 워크플로도 새 회차를 만들 후보로 남는다", () => {
    cy.get('[data-roundless-workflow="wf-stale"]')
      .should("contain.text", "회차를 지운 워크플로")
      .and("contain.text", "페이싱 대상이지만 회차가 없어 돌지 않습니다.");
    cy.get('[data-roundless-workflow="wf-fresh"]').should("contain.text", "회차를 만든 적 없는 워크플로");
    // 찌꺼기 소비자는 회차 카드로도 서지 않는다 — 돌지 않는 회차를 운영 중인 것처럼 보이면 안 된다.
    cy.get('.usage-budget-card[data-schedule-id="round-stale"]').should("not.exist");
  });

  it("후보 행의 페이싱 추가로 연 모달은 후보만 선택지로 들고 누른 워크플로를 처음 값으로 세운다", () => {
    cy.get('[data-roundless-workflow="wf-stale"]').contains("button", "페이싱 추가").click();
    cy.contains(".modal-title", "새 페이싱 회차").should("be.visible");
    cy.contains("label", "실행할 워크플로").find("select").as("picker");
    cy.get("@picker").should("have.value", "wf-stale");
    cy.get("@picker").find("option:not([disabled])").should("have.length", 2);
    cy.get("@picker").find('option[value="wf-live"]').should("not.exist");
    cy.get("@picker").find('option[value="wf-off"]').should("not.exist");
  });
});
