import {
  pacingAccount,
  pacingAccountOverview,
  pacingConsumer,
  usageBudget,
} from "../support/usageBudgetFixtures";

/**
 * 회당 소비를 %p로 잴 수 없는 공급자가 섞인 회차. 토큰만 관측된 공급자는 목록에 "회당 토큰"
 * 으로 남되 남은 예산을 늘리지 못하고, 회당 소비가 0%p로 잡힌 공급자는 나눌 근거가 없으므로
 * 합계에서 통째로 빠져야 한다(0회로 세거나 무한으로 보지 않는다).
 */
describe("페이싱 회차의 잴 수 없는 회당 소비", () => {
  it("토큰만 관측한 공급자와 0%p 공급자를 남은 예산 합계에서 뺀다", () => {
    cy.visitApp();
    cy.stubInvoke("get_usage_budget", usageBudget({
      activeConsumers: ["unmeasurable-cost-round"],
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
        scheduleId: "unmeasurable-cost-round",
        name: "잴 수 없는 소비 회차",
        workflowId: "plan_usage_paced_runs",
        costs: {
          perProvider: {
            // 유일하게 나눌 수 있는 공급자. 순여유 50 ÷ 10 = 5회.
            claude: { percentPerRun: 10, observationWeight: 1 },
            // 0%p는 "무한"이 아니라 답이 없다 — 순여유 40이 있어도 합계에 들어가면 안 된다.
            antigravity: { percentPerRun: 0, observationWeight: 1 },
          },
          perAccount: [],
          recordedRuns: 4,
          // 토큰만 잰 공급자. 목록에는 남지만 순여유 60을 나눌 수 없다.
          savings: {
            codex: {
              observations: 4,
              baselineFixedAt: null,
              baselineCostPercent: null,
              currentCostPercent: null,
              baselineTokens: 100000,
              currentTokens: 120000,
              achievedReductionPercent: null,
              metric: "tokens",
              overCeiling: null,
            },
          },
        },
      })],
    }));

    cy.openView("workflows");
    cy.anchor("workflows.tab.recurring").click();
    cy.get('[data-schedule-id="unmeasurable-cost-round"]')
      .scrollIntoView()
      .should("be.visible")
      .within(() => {
        cy.contains("button", "상세정보").then(($button) => {
          if ($button.attr("aria-expanded") === "false") cy.wrap($button).click();
        });

        // 세 공급자 모두 목록에는 남는다: %p 둘, 토큰 하나.
        cy.get("dt").filter(":contains('회당 소비')").should("have.length", 2);
        cy.get("dt").filter(":contains('회당 토큰')").should("have.length", 1);
        cy.contains("dt", "회당 토큰").parent().find("dd").should("contain.text", "120,000");

        // 0%p 공급자는 값 자체는 보이되 합계에는 끼지 않는다.
        cy.get("dt")
          .filter(":contains('회당 소비')")
          .parent()
          .filter(":contains('Antigravity')")
          .should("contain.text", "0.00%p");

        // 5회(claude)만 남는다. codex 60%p·antigravity 40%p는 나눌 근거가 없다.
        cy.contains("dt", "남은 예산").parent().find("dd").should("contain.text", "약 5회");
      });
  });
});
