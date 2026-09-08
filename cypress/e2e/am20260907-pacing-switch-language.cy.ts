/// <reference types="cypress" />
// 새로 추가된 워크플로 페이싱 전체 스위치의 기존 스펙은 한국어에서 기본값·저장·다른
// 모달 저장과의 공존을 본다. 이 패턴은 영어 UI에서 접근성 이름과 꺼짐 안내가 함께
// 번역되고, 한국어로 돌아온 뒤에도 같은 저장 상태를 읽는 한 번의 언어 왕복만 검증한다.

function pacingSwitch(label: string) {
  return cy.anchor("workflows.usage-budget.enabled").find(`[role="switch"][aria-label="${label}"]`);
}

describe("워크플로 페이싱 전체 스위치의 다국어 상태 일치", () => {
  after(() => {
    // 뒤따르는 격리 스펙에 언어와 페이싱 값을 흘리지 않는다.
    cy.restoreLanguage();
    cy.openPacingTab();
    pacingSwitch("워크플로 페이싱 사용").then(($toggle) => {
      if ($toggle.attr("aria-checked") === "true") return;
      cy.wrap($toggle).click();
      pacingSwitch("워크플로 페이싱 사용").should("have.attr", "aria-checked", "true");
    });
  });

  it("영어로 끈 상태의 접근성 이름·안내가 영어이고 한국어 복귀 뒤에도 꺼짐이 유지된다", () => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.openPacingTab();

    pacingSwitch("Use workflow pacing").should("have.attr", "aria-checked", "true").click();
    pacingSwitch("Use workflow pacing").should("have.attr", "aria-checked", "false");
    cy.anchor("workflows.usage-budget.enabled")
      .should("contain.text", "Pacing")
      .and("contain.text", "off")
      .invoke("text")
      .should("not.match", /[가-힣]/);
    cy.anchor("workflows.usage-budget").find('.usage-budget-pacing-off[role="status"]')
      .should("contain.text", "Workflow pacing is off")
      .and("contain.text", "Paced rounds do not launch when their scheduled time arrives")
      .invoke("text")
      .should("not.match", /[가-힣]/);

    cy.restoreLanguage();
    cy.openPacingTab();
    pacingSwitch("워크플로 페이싱 사용").should("have.attr", "aria-checked", "false");
    cy.anchor("workflows.usage-budget").find('.usage-budget-pacing-off[role="status"]')
      .should("contain.text", "워크플로 페이싱 꺼짐");
    cy.get(".error-banner").should("not.exist");
  });
});
