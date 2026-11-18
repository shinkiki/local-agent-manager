/// <reference types="cypress" />
import { pacingAccount, pacingAccountOverview, usageBudget } from "../support/usageBudgetFixtures";

// 워크플로 → 페이싱 탭 → 계정 풀 카드 → '계정 풀 설정' 모달의 계정 행은 2026-09-18부터
// 같은 쿼터 풀을 쓰는 다른 계정 이름을 경고색으로 적는다(UsageBudgetPanel.tsx:745-755, 799-806).
// 판단 근거는 "같은 공급자 + 창 초기화 시각이 밀리초까지 같음"이다.
// 기존 계정 풀 모달 스펙(AM-136 참여 토글·목표 override, AM-321 저장 실패, AM-360 모달 배타)은
// 이 문구를 보지 않았고, resetsAt을 다룬 AM-284는 모달이 아니라 카드 막대의 카운트다운이었다.
//
// 검증 축: 계정·사용량 / 조건: 경계값(1ms 차이, 0, null)과 묶음 범위(공급자 경계, 3인 풀).
const RESET_AT = 1789000000000; // 고정 epoch ms — 경고는 남은 시간이 아니라 값의 일치만 본다

function poolSection() {
  return cy.anchor("workflows.usage-budget.accounts");
}

function row(accountId: string) {
  return cy.get(`.modal .usage-budget-modal-row[data-account-id="${accountId}"]`);
}

function warning(accountId: string) {
  return row(accountId).find(".usage-budget-pool-warning");
}

describe("계정 풀 설정 모달의 '같은 쿼터 풀' 경고 범위", () => {
  beforeEach(() => {
    cy.stubInvoke("get_usage_budget", usageBudget({
      poolConfigured: true,
      accounts: [
        // 가족 구독 세 계정: 같은 공급자·같은 초기화 시각 → 서로를 이름으로 가리켜야 한다.
        pacingAccount({
          accountId: "fam-a", email: "fam-a@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 40, targetPercent: 100, resetsAt: RESET_AT }),
        }),
        pacingAccount({
          accountId: "fam-b", email: "fam-b@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 30, targetPercent: 100, resetsAt: RESET_AT }),
        }),
        // 표시 이름을 준 계정 — 경고 문구는 이메일이 아니라 표시 이름을 써야 한다.
        pacingAccount({
          accountId: "fam-c", email: "fam-c@example.com", displayName: "가족 셋째", provider: "claude",
          pacingEnabled: false,
          overview: pacingAccountOverview({ usedPercent: 10, targetPercent: 100, resetsAt: RESET_AT }),
        }),
        // 1ms 차이 → 같은 풀이 아니다. 경계값.
        pacingAccount({
          accountId: "solo-1ms", email: "solo@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 20, targetPercent: 100, resetsAt: RESET_AT + 1 }),
        }),
        // 시각은 같지만 다른 공급자 → 쿼터를 나눠 쓰지 않는다.
        pacingAccount({
          accountId: "other-provider", email: "codex@example.com", provider: "codex", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 50, targetPercent: 100, resetsAt: RESET_AT }),
        }),
        // 초기화 시각을 못 읽은 계정 둘(null) → 서로 묶을 근거가 없다.
        pacingAccount({
          accountId: "null-a", email: "null-a@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 5, targetPercent: 100, resetsAt: null }),
        }),
        pacingAccount({
          accountId: "null-b", email: "null-b@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 5, targetPercent: 100, resetsAt: null }),
        }),
        // 초기화 시각 0은 카드 막대가 '없음'으로 다루는 값이다(AM-284) → 역시 묶을 근거가 없다.
        pacingAccount({
          accountId: "zero-a", email: "zero-a@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 7, targetPercent: 100, resetsAt: 0 }),
        }),
        pacingAccount({
          accountId: "zero-b", email: "zero-b@example.com", provider: "claude", pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 7, targetPercent: 100, resetsAt: 0 }),
        }),
        // 개요가 아예 없는 계정(풀 밖의 흔한 모양) → 경고가 붙을 곳이 없다.
        pacingAccount({ accountId: "no-overview", email: "bare@example.com", provider: "claude" }),
      ],
    }));
    cy.visitApp();
    cy.openPacingTab();
    poolSection().scrollIntoView();
    poolSection().find("button[aria-label='계정 풀 설정']").click();
    cy.get(".modal").should("be.visible");
  });

  it("같은 공급자·같은 초기화 시각 계정끼리만 서로를 가리키고 표시 이름을 쓴다", () => {
    cy.get(".modal .usage-budget-modal-row").should("have.length", 10);

    // 1) 세 계정 풀: 각 행이 나머지 둘을 목록으로 적는다. 표시 이름을 준 계정은 그 이름으로 온다.
    warning("fam-a").should("have.text", " · fam-b@example.com, 가족 셋째와 같은 쿼터 풀");
    warning("fam-b").should("have.text", " · fam-a@example.com, 가족 셋째와 같은 쿼터 풀");
    warning("fam-c").should("have.text", " · fam-a@example.com, fam-b@example.com와 같은 쿼터 풀");

    // 2) 참여를 끈 계정(fam-c)도 경고를 받는다 — 켜는 순간 같은 쿼터를 두 번 세게 되므로
    //    켜기 전에 보이는 것이 이 문구의 목적이다.
    row("fam-c").should("have.class", "muted");

    // 3) 경고는 사용량 한 줄 뒤에 붙고, 원래 문장을 밀어내지 않는다.
    row("fam-a").find("small").should("contain.text", "7일 40% 사용");
  });

  it("1ms만 달라도, 공급자가 달라도 같은 풀로 묶지 않는다", () => {
    // 4) 1ms 차이 — 문자열이 아니라 값 비교라도 경계에서 새면 안 된다.
    warning("solo-1ms").should("not.exist");
    // 5) 같은 시각이지만 공급자가 다르면 별개 쿼터다.
    warning("other-provider").should("not.exist");
    // 6) 개요가 없는 계정에는 붙일 근거가 없다.
    warning("no-overview").should("not.exist");
  });

  it("초기화 시각을 못 읽은 계정끼리는 서로 묶지 않는다", () => {
    // 7) null은 '모른다'이지 '같다'가 아니다.
    warning("null-a").should("not.exist");
    warning("null-b").should("not.exist");
    // 8) 0도 '모른다'다. 카드 막대가 0을 '초기화 시각 없음'으로 다루는 것과 같은 기준으로
    //    (AM-284) 0끼리도 묶지 않는다 — 한때 0 === 0으로 통해 아무 관계 없는 두 계정에
    //    경고가 붙었다(QA #94, `UsageBudgetPanel.tsx`의 `quotaPoolMates`).
    warning("zero-a").should("not.exist");
    warning("zero-b").should("not.exist");
  });
});
