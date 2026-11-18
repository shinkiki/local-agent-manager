/// <reference types="cypress" />
import {
  accountUsage,
  providerAccount,
  providerState,
  stubLocalLlmDisconnected,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";
// 사이드바에서 하단 셸 footer로 분리된 상태바(.app-statusbar, 8fa8a23)의
// 접근성(a11y) 계약과 다국어 전환을 본다.
//
// 상태바는 다음 조작 요소와 접근성 속성을 갖는다:
// 1) footer.app-statusbar: aria-label="CLI 연결과 사용량 상태바"
// 2) "n/3 CLI 연결" 버튼(.statusbar-open)은 걷어냈다 — 상태바에 남아 있지 않아야 한다.
// 3) .statusbar-refresh:
//    - aria-label="CLI 연결과 사용량 새로고침" / title="CLI 연결과 사용량 새로고침"
// 4) 계정 사용량이 있으면 상태바 자체가 접힘·펼침 토글이 된다(전용 .statusbar-density 버튼은 없다):
//    - 접힘(기본): aria-expanded="false", title="사용량 상세정보 펴기"
//    - 펼침(detailed): aria-expanded="true", title="사용량 상세정보 접기"
//    - 줄의 빈 자리를 눌러도, 키보드 Enter로도 뒤집힌다
// 5) 언어를 영어(en)로 전환했을 때:
//    - 상태바 aria-label: "CLI connection and usage status bar"
//    - statusbar-refresh: "Refresh CLI connections and usage"
//    - 상태바 title: "Expand usage details" / "Collapse usage details"

const STATUSBAR = ".app-statusbar";
const DENSITY_KEY = "agent-manager.statusbar-usage-density.v1";

describe("하단 상태바 접근성 이름과 영어 전환 다국어 계약", () => {
  beforeEach(() => {
    // 로컬 연결이 켜져 있으면 상태바에 "무제한" 자리가 하나 더 붙는다.
    stubLocalLlmDisconnected();
  });

  after(() => {
    cy.restoreLanguage();
  });

  it("한국어 UI에서 상태바 랜드마크 및 버튼들의 접근성 이름과 툴팁이 올바르고 CLI 연결 수 버튼은 없다", () => {
    cy.visitApp();
    cy.view("dashboard").should("exist");

    // 1) 상태바 루트 접근성 이름
    cy.get(STATUSBAR)
      .should("have.attr", "aria-label", "CLI 연결과 사용량 상태바");

    // 2) 걷어낸 CLI 연결 수 버튼은 어떤 형태로도 남지 않는다
    cy.get(".statusbar-open").should("not.exist");
    cy.get(STATUSBAR).invoke("text").should("not.match", /\d\/3/);

    // 3) 새로고침 버튼 접근성 이름과 툴팁
    cy.get(".statusbar-refresh")
      .should("have.attr", "aria-label", "CLI 연결과 사용량 새로고침")
      .and("have.attr", "title", "CLI 연결과 사용량 새로고침");
  });

  it("사용량이 있는 경우 상태바 어느 자리를 눌러도 aria-expanded와 툴팁이 상태에 따라 토글된다", () => {
    const codex = providerAccount({ usage: accountUsage({ windows: [{ label: "5시간", usedPercent: 40, resetsAt: null }] }) });
    stubProviderAccounts([providerState({ activeAccountId: codex.id })], [codex]);

    cy.visitApp();
    cy.view("dashboard").should("exist");

    // 전용 펴기 버튼은 걷어냈다
    cy.get(".statusbar-density").should("not.exist");

    // 기본(접힘): aria-expanded false 및 펴기 문구
    cy.get(STATUSBAR)
      .should("have.class", "toggleable")
      .and("have.attr", "tabindex", "0")
      .and("have.attr", "aria-expanded", "false")
      .and("have.attr", "aria-controls", "statusbar-usage-details")
      .and("have.attr", "title", "사용량 상세정보 펴기");

    // 버튼이 아닌 줄의 빈 자리를 눌러도 펼쳐진다
    cy.get(".statusbar-detail").click();
    cy.get(STATUSBAR)
      .should("have.attr", "aria-expanded", "true")
      .and("have.attr", "title", "사용량 상세정보 접기");

    // 키보드로도 뒤집힌다
    cy.get(STATUSBAR).focus().trigger("keydown", { key: "Enter" });
    cy.get(STATUSBAR).should("have.attr", "aria-expanded", "false");

    // 새로고침 버튼은 자기 일만 하고 밀도를 건드리지 않는다
    cy.get(".statusbar-refresh").click();
    cy.get(STATUSBAR).should("have.attr", "aria-expanded", "false");
  });

  it("영어 UI로 전환 시 상태바 및 버튼들의 접근성 이름과 표시 텍스트가 영어로 번역된다", () => {
    const codex = providerAccount({ usage: accountUsage({ windows: [{ label: "5시간", usedPercent: 40, resetsAt: null }] }) });
    stubProviderAccounts([providerState({ activeAccountId: codex.id })], [codex]);

    cy.visitApp({ [DENSITY_KEY]: "compact" });
    cy.setLanguage("en");

    // 1) 상태바 루트
    cy.get(STATUSBAR)
      .should("have.attr", "aria-label", "CLI connection and usage status bar");

    // 2) 새로고침 버튼
    cy.get(".statusbar-refresh")
      .should("have.attr", "aria-label", "Refresh CLI connections and usage")
      .and("have.attr", "title", "Refresh CLI connections and usage");

    // 3) 상태바 토글 툴팁 (접힘 상태)
    cy.get(STATUSBAR)
      .should("have.attr", "title", "Expand usage details")
      .click();

    // 4) 상태바 토글 툴팁 (펼침 상태)
    cy.get(STATUSBAR)
      .should("have.attr", "title", "Collapse usage details");
  });
});
