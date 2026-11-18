import {
  accountUsage,
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";

/**
 * 대시보드 '계정 소진율' 기둥 그래프가 **관측 시작 이전 달**과 **관측 이후 달**을 구분해
 * 그리는지 본다.
 *
 * 기존 시나리오와 다른 점: AM-229는 이력 조회가 실패했을 때의 안내를, AM-266은 말풍선이
 * 지연 없이 뜨는지를 보았다. 둘 다 "이력이 정상으로 왔을 때 달마다 무엇이 달라지는가"는
 * 보지 않았다. 여기는 이력이 정상으로 왔고 관측 시작이 이번 달 안에 있는 경우를 세워,
 * 관측 전 다섯 달이 0%가 아니라 계산 불가(`—`)로 남고 이번 달만 잘린 구간(`…부터`)으로
 * 계산되는지를 판정한다.
 *
 * 관련 코드: src/lib/usageCumulative.ts:88(관측 시작으로 구간 앞을 자르고 truncated 표시),
 * src/components/DashboardView.tsx:558(막대 상세 다섯 갈래).
 */

const PANEL = "dashboard.account-usage";
const DAY_MS = 86_400_000;

const ACCOUNT = providerAccount({
  displayName: "누적 관측 계정",
  usage: accountUsage({ windows: [{ label: "7일", usedPercent: 42, resetsAt: null }] }),
});

describe("대시보드 월별 소진율 - 관측 시작 이전 달", () => {
  it("관측 전 달은 0%가 아니라 계산 불가로 남고, 이번 달만 잘린 구간으로 계산된다", () => {
    const now = Date.now();
    const current = new Date(now);
    // 이번 달 시작 1초 뒤부터 관측했다고 둔다. 그래프가 보여 주는 여섯 달 중 앞의
    // 다섯 달은 통째로 관측 이전이 되고, 이번 달만 앞이 1초 잘린 채 계산된다.
    const monthStart = new Date(current.getFullYear(), current.getMonth(), 1).getTime();
    const observedSince = monthStart + 1000;

    cy.stubInvoke("get_antigravity_pacing_usage", { statusCode: 200, body: [] });
    cy.stubInvoke("get_account_usage_history", {
      statusCode: 200,
      body: {
        accounts: [{
          accountId: ACCOUNT.id,
          observedSince,
          cycles: [{
            windowLabel: "7일",
            windowLengthMs: 7 * DAY_MS,
            resetsAt: now + DAY_MS,
            peakUsedPercent: 50,
            firstObservedAt: Math.max(observedSince, now - 6 * DAY_MS),
            lastObservedAt: now,
          }],
        }],
      },
    }).as("history");
    stubProviderAccounts([providerState({ activeAccountId: ACCOUNT.id })], [ACCOUNT]);
    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.anchor(PANEL).should("be.visible");
    cy.wait("@history");

    // 계정 하나 × 여섯 달.
    cy.anchor(PANEL).find(".account-usage-bar").should("have.length", 6);

    // 앞의 다섯 달: 관측 전이므로 값이 없다. 높이 0에 `empty`로 남아 0%와 구분된다.
    for (let index = 0; index < 5; index += 1) {
      cy.anchor(PANEL).find(".account-usage-bar").eq(index).as("past");
      cy.get("@past").should("have.class", "empty");
      cy.get("@past").should("have.attr", "aria-label").and("match", /소진율 —$/);
      cy.get("@past").should("have.attr", "data-detail").and("contain", "관측 시작 이후 자료가 없습니다");
      cy.get("@past").should("have.attr", "data-detail").and("not.contain", "주기 제공 중");
      cy.get("@past").invoke("attr", "style").should("contain", "height: 0%");
    }

    // 이번 달: 관측 구간이 있으므로 비율이 계산되고, 앞이 잘렸음을 '…부터'로 알린다.
    cy.anchor(PANEL).find(".account-usage-bar").eq(5).as("thisMonth");
    cy.get("@thisMonth").should("not.have.class", "empty");
    cy.get("@thisMonth").should("have.attr", "aria-label").and("match", /소진율 \d+%$/);
    cy.get("@thisMonth").should("have.attr", "data-detail").and("match", /부터 · 7일 \d/);
    cy.get("@thisMonth").should("have.attr", "data-detail").and("contain", "주기분 소비");
    // 이번 달 막대임을 알리는 꼬리표가 상세에 붙는다.
    cy.get("@thisMonth").should("have.attr", "data-detail").and("contain", "(이번 달, 지금까지)");

    // 관측 전 달의 막대에도 말풍선은 뜬다 — 값이 없다는 사실 자체가 읽혀야 한다.
    cy.anchor(PANEL).find(".account-usage-bar").first()
      .trigger("mouseover")
      .trigger("mousemove");
    cy.get(".chart-tooltip")
      .should("be.visible")
      .and("contain.text", "관측 시작 이후 자료가 없습니다");
  });
});
