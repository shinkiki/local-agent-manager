/// <reference types="cypress" />
// QA #23 (AM-76 조건 B): 쿠키를 전면 차단한 브라우저는 `window.localStorage`를 읽는 것만으로
// SecurityError를 던진다. 저장소 읽기는 기본값으로, 쓰기는 무동작으로 떨어져 앱은 정상 기동해야
// 하고, 화면 상태만 이번 실행 동안 기억되지 않는다. 결함은 기기 알림 설정 읽기 한 곳이 예외를
// 막지 않아 상단바 마운트에서 셸 전체가 오류 경계로 떨어지던 것이다.
//
// cy.visitApp은 localStorage에 씨앗을 심으므로 쓰지 않는다. E2E 훅도 같은 이유로 없으니
// 화면 전환은 사이드바·탭 클릭으로만 한다. 준비중 화면(애드온)은 저장값이 없으면 기본 숨김이다.
function blockStorage(win: Cypress.AUTWindow): void {
  const blocked = () => {
    throw new win.DOMException("The operation is insecure.", "SecurityError");
  };
  Object.defineProperty(win, "localStorage", { configurable: true, get: blocked });
  Object.defineProperty(win, "sessionStorage", { configurable: true, get: blocked });
}

describe("저장소 접근이 막힌 브라우저(쿠키 차단)에서의 기동", () => {
  it("localStorage 읽기가 예외를 던져도 앱 셸이 뜨고 화면 전환·탭 선택이 동작한다", () => {
    cy.visit("/", { onBeforeLoad: blockStorage });
    // 차단이 실제로 걸렸는지부터 본다 — 안 걸렸으면 이 스펙은 아무것도 증명하지 못한다.
    cy.window().then((win) => {
      expect(() => win.localStorage).to.throw();
    });

    cy.get(".app-sidebar nav", { timeout: 20000 }).should("be.visible");
    cy.anchor("nav.dashboard").should("be.visible");
    cy.get(".topbar").should("be.visible");
    cy.get(".view-error").should("not.exist");

    cy.openView("skills");
    cy.openSettingsTab("display");
    cy.get(".view-error").should("not.exist");
    cy.screenshot("qa23-blocked-storage-boots");
  });
});
