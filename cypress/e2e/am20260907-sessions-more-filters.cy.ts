/// <reference types="cypress" />
// 세션 목록 툴바의 "추가 필터" 팝오버 계약을 검증한다.
// 1. 기본 상태: 보관(false), 서브에이전트(false), AIA대화(true) 설정이며 뱃지(카운트)가 표시되지 않는다.
// 2. 팝오버 토글: 버튼 클릭 시 패널이 열리고 aria-expanded가 true가 되며, Esc 또는 바깥 클릭 시 닫힌다.
// 3. 기본값 대비 변경 시: 체크박스 변경(예: 공급자 보관 세션 포함 체크) 시 뱃지에 변경된 개수(1)가 표시된다.
// 4. 화면 전환 잔존 및 새로고침 초기화: 컴포넌트 상태이므로 대시보드 다녀와도 유지되나, 새로고침 시 기본값으로 복귀한다.

const MORE_FILTER_TRIGGER = ".more-filter-trigger";
const MORE_FILTER_PANEL = "#session-more-filter-panel";

function openMoreFilters() {
  cy.get(MORE_FILTER_TRIGGER).click();
  return cy.get(MORE_FILTER_PANEL).should("be.visible");
}

describe("세션 목록 추가 필터 팝오버 및 뱃지 카운트 계약", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("sessions").should("be.visible");
  });

  it("추가 필터 버튼의 초기 상태와 접근성 속성이 올바르다", () => {
    cy.get(MORE_FILTER_TRIGGER).should("be.visible")
      .and("have.attr", "aria-expanded", "false")
      .and("have.attr", "aria-controls", "session-more-filter-panel");
    // 기본 상태에서는 기본값과 다른 항목이 없으므로 뱃지(em)가 없다.
    cy.get(MORE_FILTER_TRIGGER).find("em").should("not.exist");
    cy.get(MORE_FILTER_PANEL).should("not.exist");
  });

  it("클릭으로 팝오버가 열리고, 기본 체크 상태가 올바르다", () => {
    openMoreFilters();
    cy.get(MORE_FILTER_TRIGGER).should("have.attr", "aria-expanded", "true");

    // 기본값: 보관 세션 미포함(unchecked), 서브에이전트 미포함(unchecked), AIA 대화 포함(checked)
    cy.get(MORE_FILTER_PANEL).contains("label", "공급자 보관 세션 포함").find('input[type="checkbox"]').should("not.be.checked");
    cy.get(MORE_FILTER_PANEL).contains("label", "서브에이전트 포함").find('input[type="checkbox"]').should("not.be.checked");
    cy.get(MORE_FILTER_PANEL).contains("label", "AIA 대화 포함").find('input[type="checkbox"]').should("be.checked");
  });

  it("체크박스를 변경하면 트리거 버튼에 변경된 개수 뱃지가 표시된다", () => {
    openMoreFilters();

    // 공급자 보관 세션 포함 체크 -> 1개 변경
    cy.get(MORE_FILTER_PANEL).contains("label", "공급자 보관 세션 포함").find('input[type="checkbox"]').check();
    cy.get(MORE_FILTER_TRIGGER).find("em").should("be.visible").and("have.text", "1");

    // AIA 대화 포함 해제 -> 2개 변경
    cy.get(MORE_FILTER_PANEL).contains("label", "AIA 대화 포함").find('input[type="checkbox"]').uncheck();
    cy.get(MORE_FILTER_TRIGGER).find("em").should("be.visible").and("have.text", "2");

    // 서브에이전트 포함 체크 -> 3개 모두 기본값과 다름
    cy.get(MORE_FILTER_PANEL).contains("label", "서브에이전트 포함").find('input[type="checkbox"]').check();
    cy.get(MORE_FILTER_TRIGGER).find("em").should("be.visible").and("have.text", "3");

    // 다시 원래대로 되돌리면 뱃지 사라짐
    cy.get(MORE_FILTER_PANEL).contains("label", "공급자 보관 세션 포함").find('input[type="checkbox"]').uncheck();
    cy.get(MORE_FILTER_PANEL).contains("label", "AIA 대화 포함").find('input[type="checkbox"]').check();
    cy.get(MORE_FILTER_PANEL).contains("label", "서브에이전트 포함").find('input[type="checkbox"]').uncheck();
    cy.get(MORE_FILTER_TRIGGER).find("em").should("not.exist");
  });

  it("Esc 키를 누르면 팝오버가 닫힌다", () => {
    openMoreFilters();
    cy.get("body").type("{esc}");
    cy.get(MORE_FILTER_PANEL).should("not.exist");
    cy.get(MORE_FILTER_TRIGGER).should("have.attr", "aria-expanded", "false");
  });

  it("바깥 영역을 클릭하면 팝오버가 닫힌다", () => {
    openMoreFilters();
    cy.get(".toolbar-card input.search-input").click();
    cy.get(MORE_FILTER_PANEL).should("not.exist");
    cy.get(MORE_FILTER_TRIGGER).should("have.attr", "aria-expanded", "false");
  });

  it("선택된 필터 상태는 다른 화면을 다녀와도 유지되나, 새로고침 시 기본값으로 초기화된다", () => {
    openMoreFilters();
    cy.get(MORE_FILTER_PANEL).contains("label", "공급자 보관 세션 포함").find('input[type="checkbox"]').check();
    cy.get("body").type("{esc}");
    cy.get(MORE_FILTER_TRIGGER).find("em").should("have.text", "1");

    // 화면 전환 후 복귀
    cy.openView("dashboard").should("be.visible");
    cy.anchor("nav.sessions").click();
    cy.view("sessions").should("be.visible");
    cy.get(MORE_FILTER_TRIGGER).find("em").should("have.text", "1");
    openMoreFilters();
    cy.get(MORE_FILTER_PANEL).contains("label", "공급자 보관 세션 포함").find('input[type="checkbox"]').should("be.checked");

    // 새로고침 시 컴포넌트 상태이므로 기본값 복귀
    cy.reload();
    cy.openView("sessions").should("be.visible");
    cy.get(MORE_FILTER_TRIGGER).find("em").should("not.exist");
    openMoreFilters();
    cy.get(MORE_FILTER_PANEL).contains("label", "공급자 보관 세션 포함").find('input[type="checkbox"]').should("not.be.checked");
  });
});
