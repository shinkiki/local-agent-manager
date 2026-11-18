/// <reference types="cypress" />
import { pacingConsumer, usageBudget } from "../support/usageBudgetFixtures";

// 페이싱 회차의 모델 사다리. 모델 하나에만 걸린 한도(Claude Fable 주간 한도·Antigravity
// 모델군 쿼터)는 그 모델을 쓰는 실행만 채울 수 있어, 회차가 공급자마다 모델 하나로 고정되면
// 그 한도가 매주 버려진다. 회차 트리거 편집기는 페이싱 회차의 공급자 모델 입력에서 여러 모델을
// 고르게 하고, 쉼표 목록으로 저장한다(계정마다 한도가 남은 모델은 계획이 고른다).
//
// 1. 페이싱 회차의 claudeModel 칸은 체크박스 무리이고, 사다리 안내가 보인다.
// 2. 두 모델을 고르면 선택지 순서의 쉼표 목록으로 저장된다. 둘 이상 골라도 붉게 표시되지 않는다.
describe("페이싱 회차 트리거의 모델 사다리", () => {
  const schedule = {
    id: "round-ladder",
    name: "사다리 회차",
    enabled: true,
    nextRunAt: 1_760_000_600_000,
    recurrence: { frequency: "auto" },
    workflow: {
      workflowId: "wf-ladder",
      approvedVersion: 1,
      arguments: { claudeModel: "claude-opus-5-5", projectPath: "/tmp/am-ladder-qa" },
      pacing: { maxRuns: 1 },
    },
  };
  const workflow = {
    id: "wf-ladder",
    displayName: "사다리 워크플로",
    description: "fixture",
    version: 1,
    compatible: true,
    computedRisk: "mutating",
    risk: "mutating",
    contractDigest: "test",
    paced: true,
    pacingMode: "envelope",
    pacingCapable: true,
    pacingEnabled: true,
    inputSchema: {
      claudeModel: { type: "string", required: true, label: "claude 레인 모델", defaultValue: "claude-opus-5-5" },
      projectPath: { type: "string", required: true, label: "대상 저장소", defaultValue: "/tmp/am-ladder-qa" },
    },
    requiredOperations: ["start_chat"],
    requiredSkills: [],
    missingSkills: [],
    hardToRecoverEffects: [],
    lastExecution: null,
  };
  const card = () => cy.get(`.usage-budget-card[data-schedule-id="${schedule.id}"]`);
  const ladder = () => cy.contains("fieldset.workflow-input-multi", "claude 레인 모델");

  beforeEach(() => {
    cy.stubInvoke("get_scheduler_snapshot", { paused: false, runnerActive: true, schedules: [schedule], runs: [] });
    cy.stubInvoke("get_system_workflows", {
      workflows: [workflow],
      limits: { maxSteps: 20, maxWorkflows: 64, maxForEachIterations: 100, maxTotalOperationCalls: 200, allowedControl: [], forbidden: [] },
    }).as("systemWorkflows");
    cy.stubInvoke("get_chat_provider_options", (req) => {
      const source = (req.body as { source: string }).source;
      const models = source === "claude"
        ? [
          { model: "claude-fable-5-1", displayName: "Fable 5.1", supportedReasoningEfforts: [] },
          { model: "claude-opus-5-5", displayName: "Opus 5.5", supportedReasoningEfforts: [] },
        ]
        : [];
      req.reply({ source, models, supportedReasoningEfforts: [], settings: [] });
    });
    const budget = usageBudget({
      activeConsumers: [schedule.id],
      pacingWorkflowIds: [workflow.id],
      consumers: [pacingConsumer({ scheduleId: schedule.id, name: schedule.name, workflowId: workflow.id })],
    });
    cy.stubInvoke("get_usage_budget", budget).as("usageBudget");
    cy.stubInvoke("update_scheduled_request", { statusCode: 200, body: null }).as("updateSchedule");
    cy.visitApp();
    cy.openPacingTab();
    card().contains("button", "편집").click();
    cy.contains(".modal-title", "회차 설정").should("be.visible");
  });

  // 편집기 그리드의 입력 규칙(폭 100%·높이 39px)이 체크박스에 걸려 칸마다 한 줄을 다 차지하고 이름이
  // 아래로 밀리던 자리. 체크박스는 글자 크기이고 이름과 한 줄이며, 모바일에서도 그렇다.
  for (const [device, width, height] of [["pc", 1280, 900], ["mobile", 390, 844]] as const) {
    it(`모델 체크박스는 이름과 한 줄의 작은 칸이다(${device})`, () => {
      cy.viewport(width, height);
      ladder().scrollIntoView();
      ladder().find("label.workflow-input-boolean").each(($label) => {
        const box = $label.find("input[type=checkbox]")[0].getBoundingClientRect();
        const name = $label.find("span")[0].getBoundingClientRect();
        expect(box.width, "체크박스 폭").to.be.lessThan(24);
        expect(box.height, "체크박스 높이").to.be.lessThan(24);
        // 이름이 체크박스 오른쪽, 같은 줄에 선다.
        expect(name.left).to.be.greaterThan(box.right - 1);
        expect(Math.abs((name.top + name.bottom) / 2 - (box.top + box.bottom) / 2)).to.be.lessThan(12);
      });
      // PC는 여러 열(두 모델이 한 줄), 좁은 화면은 한 열(위아래)이다.
      ladder().find("label.workflow-input-boolean").should("have.length", 2).then(($labels) => {
        const [first, second] = [...$labels].map((label) => label.getBoundingClientRect());
        if (device === "pc") expect(Math.abs(first.top - second.top)).to.be.lessThan(2);
        else expect(second.top).to.be.greaterThan(first.bottom - 1);
      });
      ladder().screenshot(`pacing-model-ladder-${device}`, { overwrite: true });
    });
  }

  // 페이싱 화면은 30초마다 회차·워크플로 목록을 다시 읽는다. 그때 내용이 같은 새 객체가 오는데,
  // 편집기가 그것을 "저장값이 바뀌었다"로 읽어 고르던 값을 저장값으로 되돌렸다(2026-10-26 사용자 보고).
  it("주기적으로 목록을 다시 읽어도 고르던 모델이 저장 전에 되돌아가지 않는다", () => {
    // 처음 읽은 예산 조회 응답들은 흘려보낸다 — 아래 기다림은 편집기를 연 뒤의 주기 갱신이어야 한다.
    cy.get("@usageBudget.all").then((calls) => {
      for (let index = 0; index < calls.length; index += 1) cy.wait("@usageBudget");
    });
    cy.get("@systemWorkflows.all").then((calls) => {
      for (let index = 0; index < calls.length; index += 1) cy.wait("@systemWorkflows");
    });
    ladder().contains("label", "Fable 5.1").find("input[type=checkbox]").check();
    // 편집기를 연 뒤의 주기 갱신(30초)을 기다린다. 예산 조회는 페이싱 화면만 부르므로 그 주기의
    // 표지다 — 반복 요청 목록은 앱 전체가 10초마다 따로 읽어 기준으로 쓰면 30초 갱신 전에 통과한다.
    cy.wait("@usageBudget", { timeout: 40_000 });
    // 편집기에 새 객체를 넘기는 것은 같은 갱신의 목록 다시 읽기다. 그 응답까지 받고 다시 그려질 틈을 준다.
    cy.wait("@systemWorkflows", { timeout: 40_000 });
    cy.wait(500);
    ladder().contains("label", "Fable 5.1").find("input[type=checkbox]").should("be.checked");
    cy.get(".modal").find('footer button[type="submit"]').click();
    cy.wait("@updateSchedule").its("request.body").then((body) => {
      const request = (typeof body === "string" ? JSON.parse(body) : body).request;
      const args = request.input?.workflow?.arguments ?? request.workflow?.arguments;
      expect(args.claudeModel).to.equal("claude-fable-5-1,claude-opus-5-5");
    });
  });

  it("공급자 모델 칸에서 여러 모델을 골라 선택지 순서의 쉼표 목록으로 저장한다", () => {
    ladder().should("not.have.class", "workflow-input-invalid");
    ladder().find(".workflow-input-hint").should("contain.text", "모델 전용 주간 한도");
    ladder().contains("label", "Opus 5.5").find("input[type=checkbox]").should("be.checked");
    ladder().contains("label", "Fable 5.1").find("input[type=checkbox]").check();
    // 둘 이상 골라도 정상 값이다.
    ladder().should("not.have.class", "workflow-input-invalid");
    cy.get(".modal").find('footer button[type="submit"]').click();
    cy.wait("@updateSchedule").its("request.body").then((body) => {
      const request = (typeof body === "string" ? JSON.parse(body) : body).request;
      const args = request.input?.workflow?.arguments ?? request.workflow?.arguments;
      expect(args.claudeModel).to.equal("claude-fable-5-1,claude-opus-5-5");
    });
  });
});
