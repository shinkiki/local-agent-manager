/// <reference types="cypress" />
import { pacingAccount, pacingAccountOverview, usageBudget } from "../support/usageBudgetFixtures";

// 워크플로 → 페이싱 탭 계정 풀 카드의 계정별 막대는 창 초기화까지 남은 시간을 `<time>`으로
// 적는다(UsageBudgetPanel.tsx:517-531). 기존 계정 풀 스펙 셋은 참여/제외 클래스(AM-41),
// 모달의 참여 토글(am20260907-usage-budget-pool-modal), 공급자 혼합 시 남은 예산
// (am20260907-mixed-provider-remaining-budget)만 봤고, resetsAt 경계값과 카드 상단
// '가장 이른 초기화' 지표가 풀 밖 계정을 섞지 않는지는 이번이 처음이다.
//
// 검증 축: 계정·사용량 / 조건: 경계값(과거·0·null 초기화 시각)과 집계 범위(풀 밖 제외).
// AM-284 / 결함 QA #75(수정 완료 — 지표는 앞으로 올 초기화만 고른다).
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function poolSection() {
  return cy.anchor("workflows.usage-budget.accounts");
}

function bar(email: string) {
  return poolSection().find(".usage-budget-pool-bars > li").filter(`:contains("${email}")`);
}

function metric(label: string) {
  return poolSection().find(".usage-budget-metrics").contains("dt", label).parent().find("dd");
}

describe("계정 풀 막대의 창 초기화 카운트다운과 '가장 이른 초기화' 지표", () => {
  beforeEach(() => {
    // 화면은 매 렌더에서 Date.now()를 다시 읽으므로 남은 시간은 스텁을 세운 시각 기준이다.
    const now = Date.now();
    cy.stubInvoke("get_usage_budget", usageBudget({
      poolConfigured: true,
      accounts: [
        // 풀 안, 1시간 30분 뒤 초기화. 카드의 '가장 이른 초기화'가 가리켜야 할 계정이다.
        pacingAccount({
          accountId: "pool-soon", email: "soon@example.com", provider: "codex", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 40, targetPercent: 100, resetsAt: now + HOUR + 30 * MINUTE }),
        }),
        // 풀 안, 36시간 뒤 → 일 단위 표기("1d 12h")로 접힌다.
        pacingAccount({
          accountId: "pool-later", email: "later@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 60, targetPercent: 100, resetsAt: now + 36 * HOUR }),
        }),
        // 풀 안, 이미 지난 초기화 시각 → 남은 시간을 적지 않는다.
        pacingAccount({
          accountId: "pool-past", email: "past@example.com", provider: "codex", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 20, targetPercent: 100, resetsAt: now - HOUR }),
        }),
        // 풀 안, 초기화 시각 0(=없음) → 남은 시간을 적지 않는다.
        pacingAccount({
          accountId: "pool-zero", email: "zero@example.com", provider: "codex", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 10, targetPercent: 100, resetsAt: 0 }),
        }),
        // 풀 밖. 전체에서 가장 이른 5분 뒤 초기화지만 페이싱 후보가 아니므로 지표에 섞이면 안 된다.
        pacingAccount({
          accountId: "excluded-earliest", email: "excluded@example.com", provider: "claude", pacingEnabled: false,
          overview: pacingAccountOverview({ usedPercent: 90, targetPercent: 100, inPool: false, resetsAt: now + 5 * MINUTE }),
        }),
      ],
    }));
    cy.visitApp();
    cy.openPacingTab();
    poolSection().scrollIntoView().should("be.visible");
  });

  it("남은 시간이 있는 계정만 카운트다운을 적고, 지난·0 시각은 비워 둔다", () => {
    poolSection().find(".usage-budget-pool-bars > li").should("have.length", 5);

    // 1) 한 시간 반 뒤 초기화는 "1h Mm"으로 접힌다. 분 칸은 실행 지연만큼 줄 수 있다.
    bar("soon@example.com").find("time").invoke("text").should("match", /^1h \d{1,2}m$/);
    // 2) 같은 값이 스크린리더용 이름에도 같은 문구로 실린다.
    bar("soon@example.com").find("time").then(($time) => {
      expect($time.attr("aria-label")).to.equal(`soon@example.com 창 초기화까지 ${$time.text()}`);
      expect($time.attr("datetime"), "datetime은 ISO 시각").to.match(/^\d{4}-\d{2}-\d{2}T/);
    });
    // 3) 하루를 넘기면 분을 버리고 "Nd Nh"로 줄인다.
    bar("later@example.com").find("time").invoke("text").should("match", /^1d 1[12]h$/);

    // 4) 이미 지난 시각과 0은 카운트다운을 만들지 않고, 툴팁에도 초기화 문구가 붙지 않는다.
    bar("past@example.com").find("time").should("not.exist");
    bar("past@example.com").should("have.attr", "title").and("not.contain", "초기화");
    bar("zero@example.com").find("time").should("not.exist");
    bar("zero@example.com").should("have.attr", "title").and("not.contain", "초기화");
  });

  it("'가장 이른 초기화'는 풀 안에서만 고르고 풀 밖의 더 이른 계정을 섞지 않는다", () => {
    // 풀 밖 계정은 막대에서 제외(off)로 갈리지만 남은 시간 자체는 읽을 수 있다.
    bar("excluded@example.com").should("have.class", "off");
    bar("excluded@example.com").should("have.attr", "title").and("contain", "제외됨");
    bar("excluded@example.com").find("time").invoke("text").should("match", /^[1-5]m$/);

    // 풀 밖 계정(5분 뒤)이 지표에 새지 않는 것은 지켜진다 — 샜다면 "분 후"가 된다.
    metric("가장 이른 초기화").should("not.contain.text", "분 후");
    metric("가장 이른 초기화").should("contain.text", "창 리셋");

    // QA #75 수정 확인: 지표는 이미 지나간 초기화 시각(pool-past)을 후보에서 빼고, 아직
    // 오지 않은 것 중 가장 이른 pool-soon(1시간 30분 뒤)을 고른다. 같은 계정의 막대가
    // 카운트다운을 적는 계정과 카드 지표가 이제 같은 계정을 가리킨다.
    // (pacingSummary.ts:63, UsageBudgetPanel.tsx:509)
    metric("가장 이른 초기화").invoke("text").should("match", /^1시간 후/);

    // 카드 제목의 참여 계정 수도 풀 밖 하나를 뺀 4 / 5여야 지표와 어긋나지 않는다.
    poolSection().find(".usage-budget-pool-card strong").first().should("have.text", "페이싱 계정 4 / 5");
  });
});
