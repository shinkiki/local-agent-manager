/// <reference types="cypress" />
// AM-39: 설정 → 백엔드 서비스 카드의 도움말(HelpHint) 팝오버 열고닫기 계약을 본다.
// 기존 스펙은 이 탭에서 포트 읽기 전용(AM-8)과 원격 편집 토글(AM-12)까지만 다뤘고,
// 카드 곳곳에 붙은 도움말 버튼 자체의 토글·바깥 클릭·ESC·여러 개 동시 열림·
// 화면 전환 후 닫힘 계약은 어떤 시나리오에도 없다.
// HelpHint는 Shared.tsx:580의 공용 컴포넌트라 여기서 본 계약이 앱 전체에 걸린다.

const hints = () => cy.get(".remote-access-card .help-hint-trigger");
const popovers = () => cy.get(".help-hint-popover");

describe("도움말 팝오버 열고닫기", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openSettingsTab("service");
    cy.get(".remote-access-card").should("be.visible");
  });

  it("처음에는 어떤 팝오버도 열려 있지 않고 트리거는 접힘을 알린다", () => {
    popovers().should("not.exist");
    hints().should("have.length.at.least", 2);
    hints().each((el) => expect(el.attr("aria-expanded")).to.equal("false"));
  });

  it("트리거를 누르면 설명이 열리고 같은 트리거를 다시 누르면 닫힌다", () => {
    hints().first().click();
    hints().first().should("have.attr", "aria-expanded", "true");
    popovers().should("have.length", 1).and("have.attr", "role", "note");
    popovers().should("contain.text", "원격");

    hints().first().click();
    hints().first().should("have.attr", "aria-expanded", "false");
    popovers().should("not.exist");
  });

  it("팝오버 바깥을 누르면 닫히고 ESC로도 닫힌다", () => {
    hints().first().click();
    popovers().should("exist");
    cy.get(".remote-access-card header strong").first().click();
    popovers().should("not.exist");

    hints().first().click();
    popovers().should("exist");
    cy.get("body").type("{esc}");
    popovers().should("not.exist");
  });

  it("팝오버 안을 눌러도 닫히지 않는다", () => {
    hints().first().click();
    popovers().find("small").first().click();
    popovers().should("exist");
  });

  it("다른 도움말을 열면 앞서 연 설명이 닫히고 하나만 남는다", () => {
    hints().eq(0).click();
    hints().eq(1).click();
    popovers().should("have.length", 1);
    hints().filter('[aria-expanded="true"]').should("have.length", 1);
  });

  it("팝오버를 열어 둔 채 다른 화면을 다녀오면 닫힌 상태로 돌아온다", () => {
    hints().first().click();
    popovers().should("exist");
    cy.anchor("nav.dashboard").click();
    popovers().should("not.exist");
    cy.anchor("nav.settings").click();
    cy.get(".remote-access-card").should("be.visible");
    popovers().should("not.exist");
    hints().first().should("have.attr", "aria-expanded", "false");
  });
});
