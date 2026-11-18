import {
  accountUsage,
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";

/**
 * 대시보드 '계정 소진율' 패널은 세 갈래의 응답을 함께 그린다 — 계정 스냅샷, Antigravity
 * 자원 사용량, 그리고 지난 주기 이력(`get_account_usage_history`). 앞의 둘을 다룬
 * 시나리오는 있지만(AM-7 빈 계정, AM-73 범례 정렬), **이력 조회가 실패한 자리**는 어느
 * 스펙도 보지 않았다. 이력만 실패하면 계정도 현재 소진율도 멀쩡하므로, 패널이 통째로
 * 비어서는 안 되고 "왜 막대가 비었는지"를 사용자에게 알려야 한다.
 *
 * 여기서는 계정 하나를 세워 두고 이력 응답만 갈라 두 갈래를 본다.
 *
 *   실패(500)  → 그래프는 남고 오류 안내(role=alert)가 붙으며 막대는 값 없음(`—`)
 *   성공        → 같은 화면에서 막대가 누적 소비율(%)로 채워지고 도움말이 주기를 적는다
 *
 * 이력 계산 자체(`cumulativeUsage`)는 단위 테스트가 보므로, 여기서는 화면에 붙는
 * 오류 문구·막대 상태·접근성 라벨만 단정한다.
 */

const PANEL = "dashboard.account-usage";
const HISTORY_ERROR = "이력을 읽을 수 없는 저장소입니다";

/** 7일 창 하나를 가진 Codex 계정. 이력 계산은 이 창 라벨을 분모의 주기 길이로 쓴다. */
const ACCOUNT = providerAccount({
  displayName: "누적 계정",
  usage: accountUsage({ windows: [{ label: "7일", usedPercent: 42, resetsAt: null }] }),
});

const DAY_MS = 86_400_000;

/** 월 열들(맨 앞 눈금 열은 데이터가 아니라 축이라 제외한다). */
const monthColumns = () => cy.anchor(PANEL).find(".account-usage-chart .week-column:not(.account-usage-axis-column)");

function openDashboard(): void {
  // 격리 백엔드에서도 이 패널은 Antigravity 사용량을 따로 읽는다. 호스트에 설치된 CLI를
  // 실제로 부르지 않도록 빈 목록으로 막는다.
  cy.stubInvoke("get_antigravity_pacing_usage", { statusCode: 200, body: [] });
  stubProviderAccounts([providerState({ activeAccountId: ACCOUNT.id })], [ACCOUNT]);
  cy.visitApp();
  cy.view("dashboard").should("exist");
  cy.anchor(PANEL).should("be.visible");
}

describe("대시보드 계정 소진율의 사용량 이력 조회 실패", () => {
  it("이력 조회가 실패해도 그래프는 남고 오류를 알리며 막대는 값 없음으로 그려진다", () => {
    cy.stubInvoke("get_account_usage_history", {
      statusCode: 500,
      body: { error: HISTORY_ERROR },
    }).as("history");
    openDashboard();
    cy.wait("@history");

    // 계정이 있으므로 빈 상태로 떨어지지 않는다 — 이력 실패는 계정 없음과 다른 화면이다.
    cy.anchor(PANEL).should("not.contain.text", "등록된 계정이 없습니다");
    cy.anchor(PANEL).find(".account-usage-figure").should("exist");
    cy.anchor(PANEL).find(".account-usage-legend").should("contain.text", "누적 계정");

    // 왜 막대가 비었는지 알린다. 백엔드가 준 사유를 그대로 붙여야 사용자가 손볼 수 있다.
    cy.anchor(PANEL).find(".account-usage-history-error")
      .should("have.attr", "role", "alert")
      .and("contain.text", "사용량 이력을 읽지 못했습니다:")
      .and("contain.text", HISTORY_ERROR);

    // 최근 6개월 × 계정 1건. 값이 없는 달은 0%와 구분되는 빈 막대이고 라벨은 `—`다.
    monthColumns().should("have.length", 6);
    cy.anchor(PANEL).find(".account-usage-bar").should("have.length", 6)
      .each(($bar) => {
        expect($bar.attr("class"), "값 없는 막대").to.contain("empty");
        expect($bar.attr("aria-label"), "막대 접근성 라벨").to.match(/소진율 —$/u);
      });

    // 막대 도움말(마우스를 올리면 즉시 뜨는 말풍선 본문)도 같은 실패를 말한다. QA #62 —
    // 예전에는 조회가 끝난 뒤에도 "불러오는 중"에 머물러, 위 안내와 도움말이 어긋났다.
    cy.anchor(PANEL).find(".account-usage-bar").first()
      .should("have.attr", "data-detail")
      .and("contain", "사용량 이력을 읽지 못했습니다")
      .and("not.contain", "이력을 불러오는 중입니다");
    cy.screenshot("dashboard-usage-history-error");
  });

  it("이력이 오면 같은 화면의 막대가 누적 소비율로 채워진다", () => {
    const now = Date.now();
    cy.stubInvoke("get_account_usage_history", {
      statusCode: 200,
      body: {
        accounts: [{
          accountId: ACCOUNT.id,
          // 6개월 열 전부가 관측 구간 안에 들도록 넉넉히 앞에서 시작한다.
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
    openDashboard();
    cy.wait("@history");

    // 성공했으면 오류 안내는 없다.
    cy.anchor(PANEL).find(".account-usage-history-error").should("not.exist");

    // 이번 달(맨 오른쪽 열)은 주기가 있어 수치로, 소비가 없던 지난달은 0%로 그려진다.
    // 어느 쪽도 `—`가 아니다 — 관측했는데 안 썼다는 것과 모른다는 것은 다른 표시다.
    monthColumns().last().find(".account-usage-bar")
      .should("not.have.class", "empty")
      .and(($bar) => {
        expect($bar.attr("aria-label"), "이번 달 막대").to.match(/소진율 \d+%$/u);
        expect($bar.attr("data-detail"), "이번 달 도움말").to.contain("(이번 달, 지금까지)");
        expect($bar.attr("data-detail"), "도움말의 주기 표기").to.contain("주기 제공 중");
      });
    monthColumns().eq(4).find(".account-usage-bar")
      .should("have.attr", "aria-label")
      .and("match", /소진율 0%$/u);
  });
});
