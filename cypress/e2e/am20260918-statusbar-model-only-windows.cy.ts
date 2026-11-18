/// <reference types="cypress" />
import {
  accountUsage,
  providerAccount,
  providerState,
  stubLocalLlmDisconnected,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";

// AM-412 · 접힌 상태바는 모델별 창을 빼고 대표 창만 늘어놓는다(sidebarUsage.ts:250). 그런데 계정이
// 모델별 창'만' 받아 온 경우 그 규칙을 그대로 적용하면 창이 0개가 되고, 상태바는 수치가
// 멀쩡히 있는데도 "사용량 정보 없음" 한 칸을 그린다(AppStatusbar.tsx:11). 그래서
// sidebarUsage.ts:251에 `governing.size > 0` 예외가 있다 — 대표 창이 하나도 없으면 접어도
// 감추지 않는다.
//
// 검증 축: 계정·사용량 / 조건: 대표 창 0개라는 경계값과 밀도 전환.
// 기존 스펙과 다른 점 — am20260907-sidebar-usage-meters는 대표 창 2개 + 모델별 1개인
// 계정에서 접힘이 모델별을 빼는 것만 봤고("기본은 접힌 요약이고…"), 창이 아예 0개인 계정의
// "사용량 정보 없음" 갈래도 봤다. 그 둘 사이의 경계 — 창은 있는데 전부 모델별인 계정 — 은
// 어느 스펙도 보지 않았다. 이 예외가 사라지면 사용량이 있는 계정이 접힌 상태바에서
// 정보 없음으로 보인다.
//
// 격리 백엔드는 계정이 비어 있으므로 get_provider_accounts 응답으로 두 공급자를 세운다.
// 한쪽은 모델별 창만, 다른 한쪽은 대표 창이 섞인 계정이라 같은 화면에서 두 갈래가 갈린다.
const STATUSBAR = ".app-statusbar";
const COMPACT_USAGES = ".statusbar-usages";
const DETAILS = ".statusbar-details";
// 접기·펴기 전용 버튼은 없다. 상태바 어느 자리든 눌러 뒤집는다.
const DENSITY_TOGGLE = ".statusbar-detail";

// 모델별 창만 받은 계정. 대표 창이 하나도 없다.
const MODEL_ONLY = providerAccount({
  id: "codex-model-only",
  provider: "codex",
  displayName: "모델창만",
  usage: accountUsage({ windows: [
    { label: "Fable 7일", usedPercent: 44, resetsAt: null, modelScoped: true },
    { label: "Opus 7일", usedPercent: 91, resetsAt: null, modelScoped: true },
  ] }),
});

// 대조군. 대표 창이 하나라도 있으면 접힘은 모델별 창을 뺀다.
const MIXED = providerAccount({
  id: "claude-mixed",
  provider: "claude",
  displayName: "섞인계정",
  usage: accountUsage({ windows: [
    { label: "5시간", usedPercent: 12, resetsAt: null },
    { label: "Sonnet 7일", usedPercent: 88, resetsAt: null, modelScoped: true },
  ] }),
});

/** 접힌 줄의 계정 칸 하나. 계정 이름 칸의 글자로 고른다. */
function compactMeter(displayName: string) {
  return cy.get(`${COMPACT_USAGES} .statusbar-usage`).filter(`:contains(${displayName})`);
}

describe("접힌 상태바에서 모델별 창만 받은 계정", () => {
  beforeEach(() => {
    // 사이드바가 Antigravity 사용량을 따로 읽는다. 호스트 CLI가 탐지되는 하네스에서 실제
    // `/usage`를 띄우지 않도록 비어 있는 응답으로 막는다.
    cy.stubInvoke("get_antigravity_usage", { statusCode: 200, body: accountUsage({ status: "idle", updatedAt: null }) });
    // 로컬 연결이 켜져 있으면 "무제한" 자리가 하나 더 붙어 미터 수가 달라진다.
    stubLocalLlmDisconnected();
    stubProviderAccounts(
      [
        providerState({ provider: "codex", activeAccountId: MODEL_ONLY.id }),
        providerState({ provider: "claude", activeAccountId: MIXED.id }),
      ],
      [MODEL_ONLY, MIXED],
    );
    cy.visitApp();
    cy.view("dashboard").should("exist");
  });

  it("대표 창이 없으면 접어도 모델별 창을 그대로 적고 정보 없음으로 떨어지지 않는다", () => {
    cy.get(STATUSBAR).should("have.class", "compact");
    cy.get(`${COMPACT_USAGES} .statusbar-usage`).should("have.length", 2);

    // 모델별 창만 있는 계정: 두 창 모두 남는다.
    compactMeter("모델창만").as("modelOnly");
    cy.get("@modelOnly").find(".statusbar-usage-pill").should("have.length", 2);
    cy.get("@modelOnly").find(".statusbar-window-label").then(($labels) => {
      expect([...$labels].map((node) => node.textContent)).to.deep.equal(["Fable 7일", "Opus 7일"]);
    });
    cy.get("@modelOnly").find(".statusbar-usage-value").then(($values) => {
      expect([...$values].map((node) => node.textContent)).to.deep.equal(["44%", "91%"]);
    });
    // 정보 없음 갈래로 떨어지면 칸이 하나로 줄고 unavailable 꼬리표가 붙는다.
    cy.get("@modelOnly").find(".statusbar-usage-pill.unavailable").should("not.exist");
    cy.get("@modelOnly").contains("사용량 정보 없음").should("not.exist");
    // 색 단계는 펼친 카드와 같은 기준(90% 이상은 critical)을 쓴다.
    cy.get("@modelOnly").find(".statusbar-usage-pill").eq(1).should("have.class", "critical");
    cy.get("@modelOnly").invoke("attr", "title").should("match", / · Fable 7일 44% · Opus 7일 91%$/);

    // 대조군: 대표 창이 있으면 접힘은 모델별 창을 뺀다.
    compactMeter("섞인계정").as("mixed");
    cy.get("@mixed").find(".statusbar-usage-pill").should("have.length", 1);
    cy.get("@mixed").find(".statusbar-window-label").should("have.text", "5시간");
    // 도움말은 밀도와 무관하게 모델별 창까지 적는다.
    cy.get("@mixed").invoke("attr", "title").should("match", / · 5시간 12% · Sonnet 7일 88%$/);
  });

  it("펴면 두 계정 모두 모든 창에 진행바가 생기고 다시 접어도 각자의 창 수로 돌아온다", () => {
    cy.get(DENSITY_TOGGLE).click();
    cy.get(STATUSBAR).should("have.class", "detailed");
    cy.get(`${DETAILS} .statusbar-usage-card`).should("have.length", 2);

    cy.get(`${DETAILS} .statusbar-usage-card`).filter(":contains(모델창만)").as("modelOnlyCard");
    cy.get("@modelOnlyCard").find(".statusbar-progress").should("have.length", 2);
    cy.get("@modelOnlyCard").find(".statusbar-progress").eq(1).should("have.attr", "aria-valuenow", "91");

    cy.get(`${DETAILS} .statusbar-usage-card`).filter(":contains(섞인계정)").as("mixedCard");
    cy.get("@mixedCard").find(".statusbar-progress").should("have.length", 2);
    cy.get("@mixedCard").find(".statusbar-window-label").last().should("have.text", "Sonnet 7일");

    // 다시 접으면 예외가 있는 쪽만 창 수를 그대로 유지한다.
    cy.get(DENSITY_TOGGLE).click();
    cy.get(STATUSBAR).should("have.class", "compact");
    compactMeter("모델창만").find(".statusbar-usage-pill").should("have.length", 2);
    compactMeter("섞인계정").find(".statusbar-usage-pill").should("have.length", 1);
  });
});
