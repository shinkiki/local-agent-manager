/// <reference types="cypress" />
import { pacingConsumer, usageBudget } from "../support/usageBudgetFixtures";

// 페이싱 회차 카드의 상태 셋(진행중·일시정지·완료)과 회차 설정의 두 옵션(스프린트·완료조건).
//
// 1. 상태 배지: 트리거가 켜진 회차는 '진행중', 꺼진 회차는 '일시정지', 완료 시각이 있는 회차는
//    '완료'다. 완료는 트리거가 켜져 있어도 예약 기동을 받지 않으므로 '진행중'보다 먼저다.
// 2. 조작 줄: 진행중은 '지금 실행·일시정지', 일시정지는 '재개', 완료는 '다시 시작' 하나뿐이다.
// 3. '다음 실행' 값: 완료 회차는 상대 시각 대신 '완료'.
// 4. 회차 설정 모달: 스프린트 스위치는 즉시 `{sprint}`로 저장되고, 완료조건 칸은 blur 때
//    `{completionCondition}`로, 비우면 `null`(해제)로 저장된다.
// 5. '다시 시작'은 `resetCompletion: true`를 보내고, 트리거가 꺼져 있으면 이어서 켠다.
describe("페이싱 회차의 진행중·일시정지·완료 상태와 스프린트·완료조건 옵션", () => {
  const schedule = (id: string, name: string, enabled: boolean) => ({
    id,
    name,
    enabled,
    nextRunAt: 1_760_000_600_000,
    recurrence: { frequency: "auto" },
    workflow: { workflowId: "wf-paced", approvedVersion: 1, arguments: {}, pacing: { maxRuns: 1 } },
  });

  const card = (id: string) => cy.get(`.usage-budget-card[data-schedule-id="${id}"]`);
  const state = (id: string) => card(id).find("[data-round-state]");
  const requestOf = (body: unknown) => (typeof body === "string" ? JSON.parse(body) : body).request;

  beforeEach(() => {
    cy.stubInvoke("get_scheduler_snapshot", {
      paused: false,
      runnerActive: true,
      schedules: [
        schedule("round-running", "도는 회차", true),
        schedule("round-paused", "멈춘 회차", false),
        schedule("round-done", "끝난 회차", true),
        schedule("round-condition-off", "조건 꺼둔 회차", false),
        schedule("round-done-off", "끝나고 꺼진 회차", false),
      ],
      runs: [],
    });
    // 저장 응답은 스냅샷 자체라, 저장 뒤에도 카드가 남도록 같은 스냅샷을 돌려준다(스텁이라 값은 안 바뀐다).
    const budget = usageBudget({
      activeConsumers: ["round-running", "round-done"],
      pacingWorkflowIds: ["wf-paced"],
      consumers: [
        pacingConsumer({ scheduleId: "round-running", name: "도는 회차", workflowId: "wf-paced", sprint: true }),
        pacingConsumer({ scheduleId: "round-paused", name: "멈춘 회차", workflowId: "wf-paced", scheduleEnabled: false }),
        pacingConsumer({
          scheduleId: "round-done",
          name: "끝난 회차",
          workflowId: "wf-paced",
          completionCondition: "리팩토링 1000건 실행",
          completedRuns: 1000,
          completedAt: 1_760_000_000_000,
          completionNote: "1000건 모두 커밋됨",
        }),
        pacingConsumer({
          scheduleId: "round-condition-off",
          name: "조건 꺼둔 회차",
          workflowId: "wf-paced",
          scheduleEnabled: false,
          completionCondition: "마일스톤 완료",
          completionConditionEnabled: false,
        }),
        pacingConsumer({
          scheduleId: "round-done-off",
          name: "끝나고 꺼진 회차",
          workflowId: "wf-paced",
          scheduleEnabled: false,
          completionCondition: "마일스톤 완료",
          completedRuns: 12,
          completedAt: 1_760_000_000_000,
        }),
      ],
    });
    cy.stubInvoke("get_usage_budget", budget);
    cy.stubInvoke("set_usage_budget_consumer", { statusCode: 200, body: budget }).as("saveConsumer");
    cy.stubInvoke("set_schedule_enabled", { statusCode: 200, body: schedule("round-done-off", "끝나고 꺼진 회차", true) }).as("enableSchedule");
    cy.stubInvoke("run_scheduled_request_now", { statusCode: 200, body: null }).as("runNow");
    cy.visitApp();
    cy.openPacingTab();
  });

  it("카드 배지가 진행중·일시정지·완료로 갈리고 완료는 트리거보다 먼저다", () => {
    state("round-running").should("have.attr", "data-round-state", "running").and("contain.text", "진행중");
    state("round-paused").should("have.attr", "data-round-state", "paused").and("contain.text", "일시정지");
    state("round-done").should("have.attr", "data-round-state", "completed").and("contain.text", "완료");
    // 트리거가 꺼져 있어도 완료가 먼저다.
    state("round-done-off").should("have.attr", "data-round-state", "completed");
    // 스프린트 회차는 배지와 반복주기 보조줄에 드러난다.
    card("round-running").find(".skill-sync-pill").contains("스프린트").should("exist");
    card("round-running").contains("dt", "반복주기").parent().should("contain.text", "스프린트");
    card("round-paused").find(".skill-sync-pill").contains("스프린트").should("not.exist");
    // 옛 '활성·비활성' 배지는 남지 않는다.
    card("round-running").find(".skill-sync-pill").contains(/^활성$/).should("not.exist");
    card("round-paused").find(".skill-sync-pill").contains(/^비활성$/).should("not.exist");
  });

  it("완료 회차는 다음 실행이 '완료'이고 조작 줄에 '다시 시작'만 남는다", () => {
    card("round-done").contains("dt", "다음 실행").parent().should("contain.text", "완료");
    card("round-done").contains("button", "다시 시작").should("not.be.disabled");
    card("round-done").contains("button", "지금 실행").should("not.exist");
    card("round-done").contains("button", "일시정지").should("not.exist");
    // 진행중·일시정지 회차의 조작 줄.
    card("round-running").contains("button", "지금 실행").should("exist");
    card("round-running").contains("button", "일시정지").should("exist");
    card("round-paused").contains("button", "재개").should("exist");
    card("round-paused").contains("button", "활성화").should("not.exist");
    // 상세정보의 완료조건 지표.
    card("round-done").find(".usage-budget-detail-toggle").then(($toggle) => {
      if ($toggle.attr("aria-expanded") !== "true") cy.wrap($toggle).click();
    });
    card("round-done").contains("dt", "완료조건").parent()
      .should("contain.text", "리팩토링 1000건 실행")
      .and("contain.text", "1000건 모두 커밋됨");
  });

  it("'다시 시작'은 resetCompletion을 보내고 꺼진 트리거는 이어서 켠다", () => {
    card("round-done").contains("button", "다시 시작").click();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = requestOf(body);
      expect(request.scheduleId).to.equal("round-done");
      expect(request.resetCompletion).to.be.true;
      expect(request.completionCondition, "조건 문구는 건드리지 않는다").to.be.undefined;
    });
    cy.get("@enableSchedule.all").should("have.length", 0);

    card("round-done-off").contains("button", "다시 시작").click();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      expect(requestOf(body).scheduleId).to.equal("round-done-off");
    });
    cy.wait("@enableSchedule").its("request.body").then((body) => {
      const request = requestOf(body);
      expect(request.id).to.equal("round-done-off");
      expect(request.enabled).to.be.true;
    });
  });

  it("회차 설정의 스프린트 스위치는 즉시, 완료조건 칸은 blur 때 저장되고 비우면 해제다", () => {
    card("round-paused").contains("button", "편집").click();
    cy.contains(".modal-title", "회차 설정").should("be.visible");

    cy.contains(".usage-budget-toggle-field", "스프린트").find("button.app-toggle")
      .should("have.attr", "aria-checked", "false")
      .click();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = requestOf(body);
      expect(request.scheduleId).to.equal("round-paused");
      expect(request.sprint).to.be.true;
    });

    cy.contains(".usage-budget-inline-field", "완료조건").find("input")
      .should("have.value", "")
      .type("리팩토링 1000건 실행").blur();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = requestOf(body);
      expect(request.completionCondition).to.equal("리팩토링 1000건 실행");
      expect(request.sprint, "다른 칸은 유지(생략)").to.be.undefined;
    });
    // 같은 문구로 다시 벗어나면 저장하지 않는다(저장본이 비어 있어 한 번 더 간다는 점은 스텁이라 생략).
    cy.get(".modal-header button[aria-label='닫기']").click();

    // 이미 조건이 있는 회차에서 칸을 비우면 null(해제)이 실린다.
    card("round-done").contains("button", "편집").click();
    cy.contains(".usage-budget-inline-field", "완료조건").find("input")
      .should("have.value", "리팩토링 1000건 실행")
      .clear().blur();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = requestOf(body);
      expect(request.scheduleId).to.equal("round-done");
      expect(request.completionCondition).to.be.null;
    });
    cy.get(".modal .usage-budget-defaults-note").should("contain.text", "완료조건이 충족되어 회차가 완료 상태입니다");
  });

  // 6. 스프린트·완료조건은 별도 '회차 운영' 구역이 아니라 페이싱 설정 카드 안에 있다. 병렬
  //    실행은 트리거가 든 값이라 이 카드가 아니라 '회차 트리거' 편집기에 남는다(workflows 스펙).
  it("스프린트·완료조건은 페이싱 설정 카드가 들고 회차 운영 구역은 없다", () => {
    card("round-paused").contains("button", "편집").click();
    cy.contains(".usage-budget-modal-section", "페이싱 설정")
      .should("contain.text", "스프린트")
      .and("contain.text", "완료조건")
      .and("not.contain.text", "병렬 실행");
    cy.contains(".usage-budget-modal-section", "회차 운영").should("not.exist");
  });

  it("완료조건 사용을 끄면 문구는 남고 칸이 잠기며 적용되지 않는다", () => {
    // 꺼진 회차: 문구는 그대로지만 칸이 잠기고, 카드 지표와 안내가 '사용 꺼짐'을 말한다.
    card("round-condition-off").contains("button", "편집").click();
    cy.contains(".usage-budget-toggle-field", "완료조건 사용").find("button.app-toggle")
      .should("have.attr", "aria-checked", "false");
    cy.contains(".usage-budget-inline-field", "완료조건").find("input")
      .should("have.value", "마일스톤 완료")
      .and("be.disabled");
    cy.get(".modal .usage-budget-defaults-note").should("contain.text", "완료조건 사용이 꺼져 있어");
    cy.get(".modal-header button[aria-label='닫기']").click();
    card("round-condition-off").find(".usage-budget-detail-toggle").then(($toggle) => {
      if ($toggle.attr("aria-expanded") !== "true") cy.wrap($toggle).click();
    });
    card("round-condition-off").contains("dt", "완료조건").parent()
      .should("contain.text", "사용 꺼짐")
      .and("not.contain.text", "마일스톤 완료");

    // 켜져 있는 회차에서 스위치를 끄면 `completionConditionEnabled: false`만 실린다.
    card("round-done").contains("button", "편집").click();
    cy.contains(".usage-budget-toggle-field", "완료조건 사용").find("button.app-toggle")
      .should("have.attr", "aria-checked", "true")
      .click();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = requestOf(body);
      expect(request.scheduleId).to.equal("round-done");
      expect(request.completionConditionEnabled).to.be.false;
      expect(request.completionCondition, "문구는 건드리지 않는다").to.be.undefined;
    });
  });
});
