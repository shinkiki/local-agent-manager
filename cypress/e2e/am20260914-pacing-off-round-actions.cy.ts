/// <reference types="cypress" />
import { pacingConsumer, usageBudget } from "../support/usageBudgetFixtures";

// 워크플로 → 페이싱 탭에서 페이싱 기능 스위치를 끄면 사용량 예산 카드가 약속한다:
// "계정 풀·회차·예산 설정은 그대로 남아 다시 켜면 이어지고, 회차 카드의 [지금 실행]은
// 꺼져 있어도 나갑니다"(UsageBudgetPanel.tsx:2242). 스케줄러가 예약 발화만 막고 수동 단건
// 실행은 막지 않기 때문인데, 화면이 그 약속을 지키는지는 어느 스펙도 보지 않았다.
//
// 기존 셋과의 차이: usage-budget-pacing-switch.cy.ts는 스위치와 알림·저장 잔존만,
// am20260907-pacing-off-next-run.cy.ts는 같은 상태의 "다음 실행" 표기만 본다. 둘 다 회차
// 카드의 조작 줄(ConsumerRoundActions, UsageBudgetPanel.tsx:1406-1455)은 건드리지 않는다.
// 조작 줄이 꺼짐 상태에서 함께 잠기면, 사용자는 안내를 읽고도 회차를 한 번 돌릴 방법이 없다.
//
// 검증 축: 계정·사용량(워크플로 페이싱) / 조건: 기능 전체를 끈 뒤의 조작 가능 여부와 호출 인자.
const PACED_RUN_NOW = "지금 실행";

const schedule = (id: string, name: string, enabled: boolean) => ({
  id,
  name,
  enabled,
  nextRunAt: 1_700_000_000_000,
  recurrence: { frequency: "auto" },
  workflow: { workflowId: "wf-paced", approvedVersion: 1, arguments: {} },
});

function stubBudget(pacingEnabled: boolean) {
  cy.stubInvoke("get_scheduler_snapshot", {
    paused: false,
    runnerActive: true,
    schedules: [schedule("paced-on", "켜진 회차", true), schedule("paced-off", "끈 회차", false)],
    runs: [],
  });
  // 스위치 칸(`defaults.enabled`)은 픽스처 타입에 없는 신규 필드라 여기서 덧댄다.
  cy.stubInvoke("get_usage_budget", {
    ...usageBudget({
      activeConsumers: pacingEnabled ? ["paced-on"] : [],
      pacingWorkflowIds: ["wf-paced"],
      consumers: [
        pacingConsumer({ scheduleId: "paced-on", name: "켜진 회차", workflowId: "wf-paced" }),
        pacingConsumer({ scheduleId: "paced-off", name: "끈 회차", workflowId: "wf-paced", scheduleEnabled: false }),
      ],
    }),
    defaults: { windowLabel: "7일", targetPercent: 95, guardWindowLabel: "5시간", guardPercent: 90, enabled: pacingEnabled },
  });
  cy.stubInvoke("run_scheduled_request_now", { statusCode: 200, body: schedule("paced-on", "켜진 회차", true) }).as("runNow");
  cy.stubInvoke("set_schedule_enabled", { statusCode: 200, body: schedule("paced-on", "켜진 회차", false) }).as("setEnabled");
  cy.visitApp();
  cy.openPacingTab();
}

const card = (scheduleId: string) => cy.get(`.usage-budget-card[data-schedule-id="${scheduleId}"]`);
const action = (scheduleId: string, label: string) =>
  card(scheduleId).find(".usage-budget-card-actions").contains("button", label);

describe("페이싱을 끈 동안의 회차 카드 조작 줄", () => {
  it("안내가 약속한 대로 활성 회차의 지금 실행이 열려 있고, 누르면 그 회차 ID로 나간다", () => {
    stubBudget(false);

    // 1) 약속을 적은 자리가 실제로 서 있어야 이 시험이 무엇을 지키는지가 화면에도 남는다.
    cy.anchor("workflows.usage-budget")
      .find(".usage-budget-pacing-off")
      .should("be.visible")
      .and("contain.text", "[지금 실행]은 꺼져 있어도 나갑니다");

    // 2) 조작 줄 넷은 페이싱 스위치와 무관하게 열려 있다. 예약 발화만 멈추는 스위치가
    //    수동 조작까지 잠그면 회차를 한 번 돌릴 방법이 사라진다.
    action("paced-on", PACED_RUN_NOW).should("not.be.disabled");
    action("paced-on", "일시정지").should("not.be.disabled");
    action("paced-on", "편집").should("not.be.disabled");

    // 3) 실제로 나가는지와, 다른 회차 ID가 섞이지 않는지.
    action("paced-on", PACED_RUN_NOW).click();
    cy.wait("@runNow").its("request.body").should("deep.equal", { id: "paced-on" });
    cy.get("@runNow.all").should("have.length", 1);
    cy.get(".error-banner").should("not.exist");
  });

  it("꺼진 상태에서도 일시정지된 회차의 단건 실행과 재개가 각자 자기 회차로 나간다", () => {
    stubBudget(false);

    // 일시정지는 페이싱 스위치와 다른 축이다. 꺼진 회차의 버튼은 '재개'로 뒤집히되
    // 단건 실행은 그대로 열려 있어야 한다(회차를 되살리지 않고 한 번만 돌리는 길).
    action("paced-off", "재개").should("not.be.disabled");
    action("paced-off", "일시정지").should("not.exist");
    action("paced-off", PACED_RUN_NOW).should("not.be.disabled").click();
    cy.wait("@runNow").its("request.body").should("deep.equal", { id: "paced-off" });

    action("paced-off", "재개").click();
    cy.wait("@setEnabled").its("request.body").should("deep.equal", { request: { id: "paced-off", enabled: true } });
  });

  it("대조군: 페이싱이 켜져 있을 때도 같은 조작 줄이 같은 인자로 나간다", () => {
    stubBudget(true);

    cy.anchor("workflows.usage-budget").find(".usage-budget-pacing-off").should("not.exist");
    action("paced-on", PACED_RUN_NOW).click();
    cy.wait("@runNow").its("request.body").should("deep.equal", { id: "paced-on" });

    action("paced-on", "일시정지").click();
    cy.wait("@setEnabled").its("request.body").should("deep.equal", { request: { id: "paced-on", enabled: false } });
  });
});
