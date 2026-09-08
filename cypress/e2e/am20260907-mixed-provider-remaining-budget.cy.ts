import {
  pacingAccount,
  pacingAccountOverview,
  pacingConsumer,
  usageBudget,
} from "../support/workflowFixtures";

describe("혼합 공급자 페이싱 회차의 남은 예산", () => {
  it("공급자별 순여유를 각 회당 소비로 나눈 뒤 합산해 카드에 표시한다", () => {
    cy.visitApp();
    cy.stubInvoke("get_usage_budget", usageBudget({
      activeConsumers: ["mixed-provider-round"],
      accounts: [
        pacingAccount({
          accountId: "claude-a",
          email: "claude@example.com",
          provider: "claude",
          pacingEnabled: true,
          overview: pacingAccountOverview({
            usedPercent: 50,
            targetPercent: 100,
            netHeadroomPercent: 50,
          }),
        }),
        pacingAccount({
          accountId: "codex-a",
          email: "codex@example.com",
          provider: "codex",
          pacingEnabled: true,
          overview: pacingAccountOverview({
            usedPercent: 40,
            targetPercent: 100,
            netHeadroomPercent: 60,
          }),
        }),
        pacingAccount({
          accountId: "antigravity-a",
          email: "antigravity@example.com",
          provider: "antigravity",
          pacingEnabled: true,
          overview: pacingAccountOverview({
            usedPercent: 60,
            targetPercent: 100,
            netHeadroomPercent: 40,
          }),
        }),
      ],
      pacingWorkflowIds: ["plan_usage_paced_runs"],
      consumers: [pacingConsumer({
        scheduleId: "mixed-provider-round",
        name: "혼합 공급자 회차",
        workflowId: "plan_usage_paced_runs",
        costs: {
          perProvider: {
            claude: { percentPerRun: 10, observationWeight: 1 },
            codex: { percentPerRun: 20, observationWeight: 1 },
            antigravity: { percentPerRun: 10, observationWeight: 1 },
          },
          perAccount: [],
          recordedRuns: 4,
          savings: {},
        },
      })],
    }));

    cy.openView("workflows");
    cy.anchor("workflows.tab.recurring").click();
    cy.get('[data-schedule-id="mixed-provider-round"]')
      .scrollIntoView()
      .should("be.visible")
      .within(() => {
        cy.contains("button", "상세정보").then(($button) => {
          if ($button.attr("aria-expanded") === "false") cy.wrap($button).click();
        });
        cy.contains("dt", "평균 소진율").parent().find("dd").should("contain.text", "50%");
        cy.contains("dt", "남은 예산").parent().find("dd").should("contain.text", "약 12회");
        cy.contains("dt", "회당 토큰").should("not.exist");
        cy.get("dt").filter(":contains('회당 소비')").should("have.length", 3);
      });
  });
});
