// 세션 참조 범위 편집기의 '기간' 선택 중 '직접 범위'(absoluteRange)를 붙잡는다.
// 이 갈래는 2026-09-13 리팩토링(6f83c47)으로 PolicyPeriodFields·PolicyAbsoluteRangeField
// 전용 컴포넌트로 갈라져 나왔는데(src/components/SessionReadPolicyFields.tsx:448,498),
// 기존 AM 시나리오는 기간을 '최근 N일'로 옮겨 숫자 칸이 생기는 것까지만 봤고 날짜 두 칸을
// 연 적이 없다.
//
// 붙잡는 계약
// - '직접 범위'로 처음 옮기면 from·to가 0이라 날짜 칸 둘 다 빈 값이다
//   (sessionReadPeriodFromChoice, src/lib/sessionReadPeriod.ts:87 / dateInputValue, 컴포넌트 323).
// - 날짜를 넣으면 시작은 그 날 00:00, 종료는 23:59:59.999로 환산되지만(dayBoundaryMs, 컴포넌트 332)
//   요약 문구는 숫자 없이 '직접 범위' 한 조각뿐이다(sessionReadPeriodLabel, sessionReadPeriod.ts:100).
// - 한쪽만 채우면 다른 쪽이 0으로 남아 서버가 거절하는 역전이 되고, 편집기가 그 자리에서 알린다.
// - 기간 종류를 오가면 물려받는 값이 종류마다 다르다: '최근 N일'은 일수를 물려받고,
//   '직접 범위'는 다른 종류를 한 번 거치면 날짜를 잃는다.
// - 한 단위 상대 기간('어제')은 딸린 숫자 칸이 없다.

import {
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";

function editor() {
  return cy.get(".schedule-editor");
}

function advancedToggle() {
  return editor().find(".schedule-advanced-toggle");
}

function policyFields() {
  return editor().find(".session-read-fields");
}

function policySummary() {
  return policyFields().find(".session-read-summary strong");
}

/** 라벨 span 텍스트로 정책 그리드의 칸 하나를 잡는다. */
function policyField(label: string) {
  return policyFields().contains("label > span", new RegExp(`^${label}$`)).parent();
}

function periodSelect() {
  return policyField("기간").find("select");
}

/** 직접 범위 칸 묶음. 기간 선택지 문구와 겹치지 않게 구조로 잡는다. */
function rangeField() {
  return policyFields().find(".session-read-range");
}

function rangeInput(side: "from" | "to") {
  return rangeField()
    .find("input[type=date]")
    .eq(side === "from" ? 0 : 1);
}

/** 최근 N일 숫자 칸. 상한 365는 이 정책에서 이 칸에만 붙는다. */
function recentDaysInput() {
  return policyFields().find('input[type=number][max="365"]');
}

function openPolicy() {
  advancedToggle().click().should("have.attr", "aria-expanded", "true");
  policyFields().find("> label.check-filter input[type=checkbox]").check();
}

describe("세션 참조 범위 편집기의 직접 범위 기간", () => {
  beforeEach(() => {
    stubProviderAccounts(
      [providerState({ provider: "claude", activeAccountId: "claude-qa-period" })],
      [providerAccount({
        id: "claude-qa-period",
        provider: "claude",
        displayName: "QA 계정",
        providerAccountId: "claude-qa-period-acc",
        providerDisplayName: "QA 계정",
        authStatus: "ready",
      })],
    );
    cy.visitApp();
    cy.openScheduleEditor();
    openPolicy();
  });

  it("직접 범위로 옮기면 날짜 칸 둘이 빈 값으로 서고, 한쪽만 채우면 역전으로 걸린다", () => {
    // 1) 기본은 보고기간이라 날짜 칸 자체가 없다.
    rangeField().should("not.exist");
    policySummary().should("contain.text", "보고기간");

    // 2) 옮기면 날짜 두 칸이 생기고, from·to가 0이라 둘 다 빈 값이다.
    periodSelect().select("absoluteRange");
    rangeField().should("be.visible");
    rangeInput("from").should("have.value", "");
    rangeInput("to").should("have.value", "");
    // 최근 N일 칸은 이 종류에 딸리지 않으므로 함께 뜨지 않는다.
    recentDaysInput().should("not.exist");

    // 3) 시작일만 채우면 종료가 0인 채로 남아 서버가 거절하는 역전이 된다. QA #79 이후
    //    편집기가 그 자리에서 알린다(아래 세 번째 it이 안내·저장 잠금까지 본다).
    rangeInput("from").type("2026-09-01").should("have.value", "2026-09-01");
    rangeInput("to").should("have.value", "");
    policyFields().find("[role=alert]").should("exist");
    // 요약은 숫자 없이 '직접 범위' 한 조각이라 어떤 날짜인지는 여전히 드러나지 않는다.
    policySummary().should("contain.text", "직접 범위").and("not.contain.text", "2026");

    // 4) 종료일까지 채우면 두 칸이 각자 값을 지키고 역전 안내가 걷힌다.
    rangeInput("to").type("2026-09-10").should("have.value", "2026-09-10");
    rangeInput("from").should("have.value", "2026-09-01");
    policyFields().find("[role=alert]").should("not.exist");

    // 5) 고급 옵션을 접었다 펴도 값은 편집기 쪽 상태라 그대로다.
    advancedToggle().click().should("have.attr", "aria-expanded", "false");
    policyFields().should("not.exist");
    advancedToggle().click().should("have.attr", "aria-expanded", "true");
    rangeInput("from").should("have.value", "2026-09-01");
    rangeInput("to").should("have.value", "2026-09-10");
  });

  it("기간 종류를 오가면 최근 N일은 일수를 물려받지만 직접 범위는 날짜를 잃는다", () => {
    // 1) 직접 범위에 날짜 두 개를 채운다.
    periodSelect().select("absoluteRange");
    rangeInput("from").type("2026-09-01");
    rangeInput("to").type("2026-09-10");

    // 2) 최근 N일로 옮기면 기본 7일이 서고 날짜 칸은 사라진다.
    periodSelect().select("recentDays");
    rangeField().should("not.exist");
    recentDaysInput().should("have.value", "7");
    recentDaysInput().type("{selectall}3");
    policySummary().should("contain.text", "최근 3일");

    // 3) 한 단위 상대 기간은 딸린 숫자 칸이 없다.
    periodSelect().select("lastDay");
    recentDaysInput().should("not.exist");
    rangeField().should("not.exist");
    policySummary().should("contain.text", "어제");

    // 4) 다시 최근 N일로 돌아오면 일수는 기본값으로 돌아간다 — 상대 기간을 거치며 종류가 바뀌었다.
    periodSelect().select("recentDays");
    recentDaysInput().should("have.value", "7");

    // 5) 직접 범위로 돌아오면 아까 넣은 날짜는 남아 있지 않다.
    periodSelect().select("absoluteRange");
    rangeInput("from").should("have.value", "");
    rangeInput("to").should("have.value", "");
    policySummary().should("contain.text", "직접 범위");
  });


  // 역전된 직접 범위는 서버가 거절한다(session_context.rs `normalize_period`, "세션 참조 기간의
  // 시작이 끝보다 늦습니다"). 같은 편집기의 활성 창 역전은 QA #49 이후 칸 옆 안내·요약·저장
  // 잠금으로 입력 시점에 알리고(qa49-schedule-active-window-inverted.cy.ts), 세션 참조 기간도
  // QA #79로 같은 자리를 갖췄다. 거절 문구 자체는 격리 하네스에서 볼 수 없다 — 서버가 계정을
  // 먼저 확인해 "계정을 찾을 수 없습니다"에서 멈춘다.
  it("시작이 끝보다 늦으면 칸 옆·요약이 역전을 알리고 저장 버튼이 잠긴다", () => {
    editor().contains("label > span", /^반복할 요청$/).parent().find("textarea").type("QA 직접 범위 검증");
    editor().contains("label > span", /^작업 경로$/).parent().find("input").clear().type("/tmp");

    periodSelect().select("absoluteRange");
    rangeInput("from").type("2026-09-10");
    rangeInput("to").type("2026-09-01");

    // 1) 칸 옆에 활성 창 역전과 같은 모양의 안내가 서고, 종료 칸이 invalid로 표시된다.
    policyFields().find("[role=alert]").should("contain.text", "종료일은 시작일보다 뒤여야 합니다");
    rangeInput("to").should("have.attr", "aria-invalid", "true");

    // 2) 안쪽 요약과 고급 옵션 접힘 요약 모두 역전을 말한다.
    policySummary().should("contain.text", "직접 범위").and("contain.text", "역전");
    advancedToggle().find("small").should("contain.text", "역전");

    // 3) 저장 버튼은 잠긴다. 다 작성한 뒤 저장 단계에서야 서버 거절을 만나지 않는다.
    editor().find('footer button[type="submit"]').should("be.disabled");

    // 4) 종료를 시작 뒤로 고치면 안내가 걷히고 저장이 다시 열린다.
    rangeInput("to").clear().type("2026-09-20");
    policyFields().find("[role=alert]").should("not.exist");
    rangeInput("to").should("not.have.attr", "aria-invalid");
    policySummary().should("not.contain.text", "역전");
    editor().find('footer button[type="submit"]').should("not.be.disabled");
  });
});
