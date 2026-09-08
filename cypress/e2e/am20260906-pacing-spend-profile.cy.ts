import { pacingConsumer, usageBudget } from "../support/workflowFixtures";

// 회차 설정 모달의 '소비 성향' 한 줄은 레인별 추론수준 표를 대신한다. 표는 손으로 잡아 둔
// 레인이 하나라도 있을 때만 펼쳐지고, 성향을 고르면 그 레인이 지워진다. 성향과 표 사이의
// 이 왕복이 실제 화면에서 성립하는지 붙잡는다.
describe("페이싱 회차 설정의 소비 성향과 레인 표", () => {
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
        schedule("paced-plain", "성향 없는 회차"),
        schedule("paced-lane", "레인 잡은 회차"),
        schedule("paced-profile", "성향 걸린 회차"),
      ],
      runs: [],
    });
    const snapshot = usageBudget({
      activeConsumers: ["paced-plain", "paced-lane", "paced-profile"],
      pacingWorkflowIds: ["wf-paced"],
      consumers: [
        pacingConsumer({ scheduleId: "paced-plain", name: "성향 없는 회차", workflowId: "wf-paced" }),
        pacingConsumer({
          scheduleId: "paced-lane",
          name: "레인 잡은 회차",
          workflowId: "wf-paced",
          reasoningEfforts: { claude: { maxAuto: "medium" } },
        }),
        pacingConsumer({
          scheduleId: "paced-profile",
          name: "성향 걸린 회차",
          workflowId: "wf-paced",
          spendProfile: "quality",
        }),
      ],
    });
    cy.stubInvoke("get_usage_budget", snapshot);
    // 실제 저장 계약은 갱신된 스냅샷을 돌려준다. null을 주면 성공 응답인데도 화면이
    // commitSnapshot(null)을 읽다가 닫혀, 저장 뒤의 레인 표를 검증할 수 없다.
    cy.intercept("POST", "**/api/invoke/set_usage_budget_consumer", { statusCode: 200, body: snapshot }).as("saveConsumer");
    cy.visitApp();
    cy.openPacingTab();
  });

  const openSettings = (scheduleId: string) => {
    cy.get(`.usage-budget-card[data-schedule-id="${scheduleId}"]`).contains("button", "편집").click();
    return cy.get(".usage-budget-workflow-accounts").contains("소비 성향").should("be.visible");
  };

  const profileSelect = () => cy.contains("label.usage-budget-inline-field", "성향").find("select");

  it("레인을 잡지 않은 회차는 '기본값 따름'으로 서고 레인 표는 접혀 있다", () => {
    openSettings("paced-plain");
    profileSelect().should("have.value", "inherit");
    cy.get(".usage-budget-lane-efforts").should("not.exist");
    cy.get(".usage-budget-lane-hint").should("contain.text", "성향을 정하지 않으면");
  });

  it("레인을 손으로 잡아 둔 회차는 '직접 설정'으로 서고 레인 표가 펼쳐진다", () => {
    openSettings("paced-lane");
    profileSelect().should("have.value", "custom");
    cy.get(".usage-budget-lane-efforts").should("be.visible");
    cy.get(".usage-budget-lane-hint").should("contain.text", "공급자 1곳을 직접 잡아 두었습니다");
  });

  it("성향을 고르면 손으로 잡아 둔 레인을 함께 비워 저장한다", () => {
    openSettings("paced-lane");
    profileSelect().select("saver");
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body));
      expect(JSON.stringify(request)).to.contain("saver");
      expect(JSON.stringify(request)).to.contain("reasoningEfforts");
      expect(JSON.stringify(request)).to.not.contain("maxAuto");
    });
  });

  // AM-110 되짚기. custom은 저장되는 값이 아니라 잡아 둔 레인이 있을 때 계산되는 표시라,
  // 한 번도 레인을 잡은 적 없는 회차는 표가 열리지 않으면 성향 밖으로 나갈 길이 없었다.
  // 이제 셀렉트에서 고른 회차는 저장본에 레인이 없어도 표를 열고, 성향은 해제로 저장된다.
  it("레인이 없는 회차에서 '직접 설정…'을 고르면 성향을 해제하고 레인 표를 연다", () => {
    openSettings("paced-plain");
    profileSelect().select("custom");
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      // 칸을 빼면 백엔드가 기존 성향을 지키므로, 해제는 null을 실어 보내야 전달된다.
      expect(JSON.stringify(body)).to.contain('"spendProfile":null');
    });
    profileSelect().should("have.value", "custom");
    cy.get(".usage-budget-lane-efforts").should("be.visible");
    cy.get(".usage-budget-lane-hint").should("contain.text", "성향을 해제했습니다");
  });

  // 성향이 걸린 회차를 '기본값 따름'으로 되돌리는 길. 같은 해제라 여기서도 null이 실려야 한다.
  it("성향이 걸린 회차를 '기본값 따름'으로 되돌리면 해제를 실어 보낸다", () => {
    openSettings("paced-profile");
    profileSelect().should("have.value", "quality");
    profileSelect().select("inherit");
    cy.wait("@saveConsumer").its("request.body").then((body) => {
      expect(JSON.stringify(body)).to.contain('"spendProfile":null');
      expect(JSON.stringify(body)).to.contain("reasoningEfforts");
    });
  });
});
