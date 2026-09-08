/// <reference types="cypress" />
import { pacingConsumer, usageBudget } from "../support/workflowFixtures";

// b165b47은 회차 설정 모달의 페이싱 설정 안내문을 "스위치·셀렉트는 바꾸는 즉시,
// 숫자 칸은 칸을 벗어날 때 저장된다"는 실제 시점에 맞췄다.
// 이 스펙은 회차 설정 모달 내 우선순위·토큰 상한·%p 상한 숫자 칸의 blur 저장과
// 경계값 보정(0~100 clamp, 빈 입력 0 해제), 두 상한이 모두 없을 때 "상한 초과 시"
// 토글이 비활성화되는 조건, 그리고 안내문의 한/영 전환을 검증한다.
describe("페이싱 회차 설정의 숫자 상한 blur 저장과 토글 활성화 조건", () => {
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
        schedule("paced-no-ceiling", "상한 없는 회차"),
        schedule("paced-with-ceiling", "상한 있는 회차"),
      ],
      runs: [],
    });
    cy.stubInvoke("get_usage_budget", usageBudget({
      activeConsumers: ["paced-no-ceiling", "paced-with-ceiling"],
      pacingWorkflowIds: ["wf-paced"],
      consumers: [
        pacingConsumer({
          scheduleId: "paced-no-ceiling",
          name: "상한 없는 회차",
          workflowId: "wf-paced",
          priority: 50,
          maxTokensPerRun: null,
          maxCostPercentPerRun: null,
          enforceCeiling: false,
        }),
        pacingConsumer({
          scheduleId: "paced-with-ceiling",
          name: "상한 있는 회차",
          workflowId: "wf-paced",
          priority: 20,
          maxTokensPerRun: 100000,
          maxCostPercentPerRun: 5.0,
          enforceCeiling: false,
        }),
      ],
    }));
    cy.intercept("POST", "**/api/invoke/set_usage_budget_consumer", { statusCode: 200, body: null }).as("saveConsumer");
    cy.visitApp();
    cy.openPacingTab();
  });

  afterEach(() => {
    cy.restoreLanguage();
  });

  const openSettings = (scheduleId: string) => {
    cy.get(`.usage-budget-card[data-schedule-id="${scheduleId}"]`).contains("button", "편집").click();
    return cy.contains(".modal-title", "회차 설정").should("be.visible");
  };

  const closeModal = () => {
    cy.get(".modal-header button[aria-label='닫기']").click();
    cy.get(".modal").should("not.exist");
  };

  it("페이싱 설정 안내문이 스위치·셀렉트 즉시 저장과 숫자 칸 blur 저장을 명시하고 영어로 전환된다", () => {
    openSettings("paced-no-ceiling");
    cy.get(".usage-budget-modal-section header small")
      .should("contain.text", "스위치와 셀렉트는 바꾸는 즉시, 숫자 칸은 칸을 벗어날 때 저장됩니다");
    closeModal();

    cy.setLanguage("en");
    cy.openPacingTab();
    cy.get('.usage-budget-card[data-schedule-id="paced-no-ceiling"]').contains("button", "Edit").click();
    cy.get(".usage-budget-modal-section header small").should(
      "contain.text",
      "switches and selects save on change, number fields when you leave them",
    );
  });

  it("상한이 모두 없는 회차는 '상한 초과 시' 토글이 비활성화된다", () => {
    openSettings("paced-no-ceiling");
    cy.contains(".usage-budget-toggle-field", "상한 초과 시")
      .find("button.app-toggle")
      .should("be.disabled");
  });

  it("상한이 있는 회차는 '상한 초과 시' 토글이 활성화되고 누르면 즉시 저장된다", () => {
    openSettings("paced-with-ceiling");
    const toggle = cy.contains(".usage-budget-toggle-field", "상한 초과 시").find("button.app-toggle");
    toggle.should("not.be.disabled");
    toggle.click();

    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = (typeof body === "string" ? JSON.parse(body) : body).request;
      expect(request.scheduleId).to.equal("paced-with-ceiling");
      expect(request.enforceCeiling).to.be.true;
    });
  });

  it("우선순위 칸을 변경하고 blur하면 범위(0~100)로 보정되어 저장된다", () => {
    openSettings("paced-no-ceiling");
    cy.contains(".usage-budget-inline-field", "우선순위").find("input").should("have.value", "50");

    // 150 입력 후 벗어나면 100으로 clamp되어 저장
    cy.contains(".usage-budget-inline-field", "우선순위").find("input").clear().type("150").blur();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = (typeof body === "string" ? JSON.parse(body) : body).request;
      expect(request.scheduleId).to.equal("paced-no-ceiling");
      expect(request.priority).to.equal(100);
    });
  });

  it("토큰 상한을 입력하고 blur하면 정수로 저장된다", () => {
    openSettings("paced-with-ceiling");
    cy.contains(".usage-budget-inline-field", "토큰 상한/회").find("input").should("have.value", "100000");

    cy.contains(".usage-budget-inline-field", "토큰 상한/회").find("input").clear().type("60000").blur();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = (typeof body === "string" ? JSON.parse(body) : body).request;
      expect(request.scheduleId).to.equal("paced-with-ceiling");
      expect(request.maxTokensPerRun).to.equal(60000);
    });
  });

  it("%p 상한을 비우고 blur하면 0(해제)으로 저장된다", () => {
    openSettings("paced-with-ceiling");
    cy.contains(".usage-budget-inline-field", "%p 상한/회").find("input").should("have.value", "5");

    cy.contains(".usage-budget-inline-field", "%p 상한/회").find("input").clear().blur();
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = (typeof body === "string" ? JSON.parse(body) : body).request;
      expect(request.scheduleId).to.equal("paced-with-ceiling");
      expect(request.maxCostPercentPerRun).to.equal(0);
    });
  });
});
