/// <reference types="cypress" />
// 좌측 주 메뉴(App.tsx:1242~1249)의 초점 도달과 활성 상태 노출을 본다.
//
// 중메뉴 탭은 tablist·로빙 tabIndex로 정돈돼 있고, 주 메뉴 항목의 순서·표시 여부는
// nav-order-bounds가 다뤘다. 그러나 "주 메뉴가 초점으로 도달되는가"와 "지금 어느 화면에 있는지가
// 보조기술에 전달되는가"는 아직 아무 스펙도 보지 않았다.
//
// 키 입력으로 버튼을 '누르는' 것 자체는 여기서 확인하지 않는다. Cypress의 type("{enter}")는
// 네이티브 버튼의 기본 활성화를 일으키지 않아서(초점만 준 채 화면이 바뀌지 않는다) 제품 결함과
// 하네스 한계를 구분할 수 없다. 그래서 초점 도달·탭 순서·활성 상태 노출만 다룬다.
describe("좌측 주 메뉴의 초점 도달과 활성 상태 노출", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
  });

  it("주 메뉴에 접근 이름이 붙어 있고 항목이 모두 초점 가능한 버튼이다", () => {
    cy.get(".app-sidebar nav").should("have.attr", "aria-label", "주 메뉴");
    cy.get(".app-sidebar nav button").should("have.length.greaterThan", 1);
    cy.get(".app-sidebar nav button").each(($b) => {
      expect($b.prop("tagName")).to.equal("BUTTON");
      // 음수 tabindex로 탭 순서에서 빼놓지 않았는지, 비활성으로 막지 않았는지 본다.
      expect($b.attr("tabindex") ?? "0").to.not.equal("-1");
      expect($b.attr("disabled")).to.equal(undefined);
    });
  });

  it("모든 주 메뉴 항목이 초점을 받는다", () => {
    cy.get(".app-sidebar nav button").each(($b) => {
      const id = $b.attr("data-ui-anchor");
      cy.wrap($b).focus();
      cy.focused().should("have.attr", "data-ui-anchor", id);
    });
  });

  it("항목을 눌러 화면을 옮겨도 초점이 그 항목에 남는다", () => {
    cy.anchor("nav.skills").click();
    cy.view("skills").should("be.visible");
    cy.focused().should("have.attr", "data-ui-anchor", "nav.skills");
  });

  // QA #32 회귀(AM-124): 활성 항목은 CSS class뿐 아니라 aria-current="page"로도 드러나 낭독기가
  // "현재 페이지"로 읽는다. 표준 패턴이라 aria-selected·aria-pressed는 쓰지 않고, 접근 이름은
  // 라벨 텍스트 그대로다. 화면을 옮기면 속성도 새 항목으로 옮겨 가고 언제나 하나만 달린다.
  it("활성 항목만 aria-current=\"page\"를 달고, 화면을 옮기면 그 항목으로 옮겨 간다", () => {
    cy.anchor("nav.artifacts").click();
    cy.view("artifacts").should("be.visible");
    cy.anchor("nav.artifacts").should("have.class", "active").and("have.attr", "aria-current", "page");
    cy.anchor("nav.artifacts").should("not.have.attr", "aria-selected");
    cy.anchor("nav.artifacts").should("not.have.attr", "aria-pressed");
    cy.get(".app-sidebar nav button.active").should("have.length", 1);
    cy.get(".app-sidebar nav button[aria-current]").should("have.length", 1);
    cy.anchor("nav.docs").should("not.have.attr", "aria-current");

    cy.anchor("nav.docs").click();
    cy.view("docs").should("be.visible");
    cy.anchor("nav.docs").should("have.attr", "aria-current", "page");
    cy.anchor("nav.artifacts").should("not.have.attr", "aria-current");
    cy.get(".app-sidebar nav button[aria-current]").should("have.length", 1);
  });
});
