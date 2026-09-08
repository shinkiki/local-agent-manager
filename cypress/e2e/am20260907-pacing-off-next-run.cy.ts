import { pacingConsumer, usageBudget } from "../support/workflowFixtures";

// 페이싱 기능 스위치(f791028)를 끄면 스케줄러는 페이싱 회차를 발화하지 않고 저장된 다음 실행
// 시각도 그대로 둔다(scheduler.rs:1419의 round_paused 게이트). 그래서 소비자 카드의 "다음
// 실행"은 저장값 대신 "페이싱 꺼짐"을 적어야 한다 — 그대로 두면 이미 지난 시각이 다음 실행으로
// 남아 회차가 밀린 것처럼 보인다.
//
// 기존 usage-budget-pacing-switch.cy.ts는 스위치 자체와 다른 모달 저장 뒤의 되살아남만 본다.
// 소비자 카드 쪽 표기는 어느 스펙도 보지 않았다. 켠 상태의 상대시각, 끈 상태의 "페이싱 꺼짐",
// 그리고 끈 상태에서도 유지되어야 하는 "일시정지"(우선순위가 뒤집히면 비활성 회차가 살아 있는
// 것처럼 읽힌다)를 한자리에서 붙잡고, 제한 시간대 보조문구가 꺼진 뒤에도 남는지도 함께 본다.
const NEXT_RUN = "다음 실행";

function defaults(enabled: boolean) {
  return { windowLabel: "7일", targetPercent: 95, guardWindowLabel: "5시간", guardPercent: 90, enabled };
}

const schedule = (id: string, name: string, enabled: boolean) => ({
  id,
  name,
  enabled,
  // 이미 지난 시각. 페이싱이 꺼졌는데 저장값을 그대로 적으면 "13분 전"처럼 읽힌다.
  nextRunAt: 1_700_000_000_000,
  recurrence: { frequency: "auto" },
  workflow: { workflowId: "wf-paced", approvedVersion: 1, arguments: {} },
});

function stubBudget(pacingEnabled: boolean) {
  cy.stubInvoke("get_scheduler_snapshot", {
    paused: false,
    runnerActive: true,
    // 제한 시간대에 걸린 상태로 둔다 — 보조문구와 본값이 서로 다른 것을 말하는지 본다.
    quietStatus: { blocked: true, changesAt: 1_700_000_600_000 },
    schedules: [schedule("paced-on", "켜진 회차", true), schedule("paced-off", "끈 회차", false)],
    runs: [],
  });
  // 스위치 칸(`defaults.enabled`)과 제한 시간대 상태는 픽스처 타입에 없는 신규 필드라 여기서
  // 덧댄다. 픽스처를 넓히는 것은 이 회차의 일이 아니다(테스트 스펙 밖의 변경).
  cy.stubInvoke("get_usage_budget", { ...usageBudget({
    activeConsumers: pacingEnabled ? ["paced-on"] : [],
    pacingWorkflowIds: ["wf-paced"],
    consumers: [
      pacingConsumer({ scheduleId: "paced-on", name: "켜진 회차", workflowId: "wf-paced" }),
      pacingConsumer({ scheduleId: "paced-off", name: "끈 회차", workflowId: "wf-paced", scheduleEnabled: false }),
    ],
  }), defaults: defaults(pacingEnabled), quietStatus: { blocked: true, changesAt: 1_700_000_600_000 } });
  cy.visitApp();
  cy.openPacingTab();
}

const card = (scheduleId: string) => cy.get(`.usage-budget-card[data-schedule-id="${scheduleId}"]`);
const nextRun = () => cy.contains(".usage-budget-metrics > div", NEXT_RUN);

describe("페이싱이 꺼진 동안의 소비자 카드 다음 실행", () => {
  it("켜져 있으면 저장된 다음 실행 시각을 상대시각으로 적는다", () => {
    stubBudget(true);
    card("paced-on").within(() => {
      nextRun().find("dd").should("contain.text", "전").and("not.contain.text", "페이싱 꺼짐");
      // 켜져 있는 동안에는 제한 시간대에 걸린 사실을 보조문구가 그대로 말한다(#42의 대조).
      nextRun().find("dd > span").should("contain.text", "제한 시간대 대기");
    });
  });

  it("꺼져 있으면 지난 시각 대신 페이싱 꺼짐을 적고, 비활성 회차는 일시정지로 남는다", () => {
    stubBudget(false);
    // 1) 발화하지 않는 저장값을 그대로 적으면 회차가 밀린 것처럼 읽힌다.
    card("paced-on").within(() => {
      nextRun().find("dd").should("contain.text", "페이싱 꺼짐");
    });
    // 2) 비활성은 페이싱과 무관한 사실이라 스위치가 덮어써서는 안 된다.
    card("paced-off").within(() => {
      nextRun().find("dd").should("contain.text", "일시정지").and("not.contain.text", "페이싱 꺼짐");
    });
    // 3) 카드 위쪽 알림도 함께 서 있어야 이유를 알 수 있다.
    cy.anchor("workflows.usage-budget").find(".usage-budget-pacing-off").should("be.visible");
  });

  // QA #42 되짚기. 페이싱을 꺼도 보조문구가 "제한 시간대 대기"로 남아 본값의 "페이싱 꺼짐"과
  // 서로 다른 이유를 말했다(보조문구 조건이 pacingOn을 보지 않았다). 이제 조건에 pacingOn이
  // 들어가 꺼진 동안에는 제한 시간대 문구가 사라진다.
  it("꺼진 회차의 보조문구가 제한 시간대 대기를 말하지 않는다", () => {
    stubBudget(false);
    // 페이싱이 꺼져 있으면 제한 시간대가 열리든 말든 발화하지 않는다. 보조문구가 "제한 시간대
    // 대기"라고 적으면 시간대만 지나면 다시 도는 줄로 읽힌다.
    card("paced-on").within(() => {
      nextRun().find("dd > span").should("not.contain.text", "제한 시간대 대기");
    });
  });
});
