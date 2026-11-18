import {
  accountUsage,
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";

/**
 * 대시보드 '계정 소진율' 막대의 상세 정보는 오랫동안 브라우저 기본 `title`이었다. 기본
 * 도움말은 커서를 1초 가까이 멈춰야 뜨기 때문에, 달·계정별 막대를 훑어보는 이 그래프에서는
 * 사실상 읽히지 않았다. 이제 막대에 마우스가 닿는 즉시 말풍선(`.chart-tooltip`)이 뜬다.
 *
 * 여기서는 지연이 없다는 것(hover 직후 같은 틱에 본문이 보인다)과, 커서가 막대를 벗어나면
 * 말풍선이 사라진다는 것만 단정한다. 본문 문구 자체는 이력 스펙(AM-20260910)이 본다.
 */

const PANEL = "dashboard.account-usage";
const DAY_MS = 86_400_000;

const ACCOUNT = providerAccount({
  displayName: "말풍선 계정",
  usage: accountUsage({ windows: [{ label: "7일", usedPercent: 42, resetsAt: null }] }),
});

describe("대시보드 계정 소진율 막대의 즉시 도움말", () => {
  it("막대에 마우스를 올리면 기다림 없이 상세 정보가 뜨고, 벗어나면 사라진다", () => {
    const now = Date.now();
    cy.stubInvoke("get_antigravity_pacing_usage", { statusCode: 200, body: [] });
    cy.stubInvoke("get_account_usage_history", {
      statusCode: 200,
      body: {
        accounts: [{
          accountId: ACCOUNT.id,
          observedSince: now - 210 * DAY_MS,
          cycles: [{
            windowLabel: "7일",
            windowLengthMs: 7 * DAY_MS,
            resetsAt: now + DAY_MS,
            peakUsedPercent: 50,
            firstObservedAt: now - 6 * DAY_MS,
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

    // 올리기 전에는 말풍선이 없다.
    cy.get(".chart-tooltip").should("not.exist");

    // 올린 직후 바로 보인다. 기본 `title`이라면 이 시점에는 아무것도 뜨지 않는다.
    cy.anchor(PANEL).find(".account-usage-bar").last()
      .trigger("mouseover")
      .trigger("mousemove");
    cy.get(".chart-tooltip")
      .should("be.visible")
      .and("contain.text", "소진율")
      .and("contain.text", "주기 제공 중");

    // 기본 도움말과 중복으로 뜨지 않도록 `title`은 남기지 않는다.
    cy.anchor(PANEL).find(".account-usage-bar").last().should("not.have.attr", "title");

    cy.anchor(PANEL).find(".account-usage-bar").last().trigger("mouseout");
    cy.get(".chart-tooltip").should("not.exist");
  });
});
