/// <reference types="cypress" />
// QA #51. 영어 UI에서 대시보드의 계정 소진율 패널이 통째로 한국어로 남고, 반복 일정 머리말은
// 정적 치환기의 부분 규칙(`전체 ` → `total `)에 걸려 "활성 0 / total 0 · 다음 실행 순"으로
// 한국어·영어가 섞였다. 개수가 끼는 머리말은 카탈로그로 못 만들므로 컴포넌트가
// `text(ko, en)`으로 언어마다 문장을 통째로 들고, 정적 치환기는 문구 전체가 수량 표현일 때만
// 폴백한다. 격리 하네스는 계정·일정이 비어 있어 두 패널 모두 빈 상태 문구를 낸다.
const HANGUL = /[가-힣]/;

describe("영어 UI 대시보드 패널 문구", () => {
  const panel = (title: string) =>
    cy.view("dashboard").find(".dashboard-grid .panel").filter(`:contains("${title}")`).first();

  before(() => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.anchor("nav.dashboard").should("contain.text", "Dashboard");
  });

  after(() => {
    cy.restoreLanguage();
  });

  beforeEach(() => {
    cy.visitApp();
    cy.openView("dashboard");
  });

  it("계정 소진율 패널의 제목·설명·빈 상태가 모두 영어다", () => {
    cy.anchor("dashboard.account-usage").within(() => {
      cy.get("h2").should("have.text", "Account burn rate");
      cy.get(".panel-heading p").invoke("text").should("match", /^Share of each account's allowance consumed over the last \d+ months$/);
      cy.get(".empty-state").should("contain.text", "No registered accounts")
        .and("contain.text", "Add Claude or Codex accounts in account management and their burn rate appears here.");
    });
    cy.anchor("dashboard.account-usage").invoke("text").should("not.match", HANGUL);
  });

  it("반복 일정 머리말이 한 언어의 온전한 문장이다", () => {
    panel("Recurring schedules").find(".panel-heading p").first()
      .should("have.text", "Active 0 / 0 total · by next run");
    panel("Recurring schedules").find(".panel-heading .button").should("have.text", "Manage");
    panel("Recurring schedules").find(".empty-state")
      .should("contain.text", "No recurring schedules")
      .and("contain.text", "Click Manage to create your first recurring request.");
    panel("Recurring schedules").invoke("text").should("not.match", HANGUL);
  });

  it("최근 세션 설명과 나머지 패널 머리말에 한국어가 남지 않는다", () => {
    panel("Recent sessions").find(".panel-heading p").first()
      .should("have.text", "Most recently updated · run status");
    panel("Recent sessions").find(".empty-state").should("contain.text", "No sessions");
    cy.view("dashboard").find(".dashboard-grid .panel-heading").each(($heading) => {
      expect($heading.text(), $heading.text()).not.to.match(HANGUL);
    });
    cy.view("dashboard").find(".stat-grid").invoke("text").should("not.match", HANGUL);
    cy.view("dashboard").find(".provider-strip").invoke("text").should("not.match", HANGUL);
  });

  it("한국어로 되돌리면 머리말이 원문으로 돌아온다", () => {
    cy.setLanguage("ko");
    cy.openView("dashboard");
    panel("반복 일정").find(".panel-heading p").first().should("have.text", "활성 0 / 전체 0 · 다음 실행 순");
    cy.anchor("dashboard.account-usage").find("h2").should("have.text", "계정 소진율");
  });
});
