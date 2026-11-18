/// <reference types="cypress" />

/**
 * 설정 화면의 탭을 옮겨 가며 화면 안내를 연달아 세울 때, 마지막 안내가 남아 있는지.
 *
 * QA #67. 앞선 안내의 포인터는 대상 요소가 DOM에서 빠진 것을 스크롤·ResizeObserver 콜백으로
 * 뒤늦게 알아채고 거두기를 부른다. 그 거두기가 "지금 서 있는 안내"를 무조건 지우던 시절에는,
 * 그사이 새로 세운 안내까지 함께 사라졌다 — 탭이 바뀌면서 앞 탭의 앵커가 통째로 교체되는
 * AIA 설정 탭('시스템 에이전트')에서 특히 서자마자 사라졌다. 이제 포인터는 자기 번호를
 * 함께 넘겨 남의 안내를 지우지 않는다.
 *
 * AM-17은 같은 화면 안의 연속 호출만 봤고, 탭이 갈리는 연속 호출은 이번이 처음이다.
 */
describe("설정 탭을 넘나드는 연속 화면 안내", () => {
  it("앞선 안내의 대상이 사라져도 마지막 안내는 그대로 선다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");

    // 1) CLI 설정 탭의 대상을 먼저 가리킨다.
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.telemetry", element: null, note: "먼저 여기" }))
      .should("eq", true);
    cy.get(".ui-guide-note").should("contain.text", "먼저 여기");

    // 2) 거두지 않은 채 AIA 설정 탭의 시스템 에이전트로 옮긴다. 탭이 바뀌면서 1)의 앵커는
    //    DOM에서 빠지고, 그 포인터의 늦은 거두기가 뒤따라 온다.
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.system-agent", element: null, note: "여기서 고릅니다" }))
      .should("eq", true);
    cy.anchor("settings.tab.aia").should("have.class", "active");

    // 3) 늦은 거두기가 지나가고도 안내는 남아 있어야 한다.
    cy.get(".ui-guide").should("have.length", 1);
    cy.get(".ui-guide-note").should("contain.text", "여기서 고릅니다");
    cy.wait(600);
    cy.get(".ui-guide").should("have.length", 1);
    cy.get(".ui-guide-note").should("contain.text", "여기서 고릅니다").and("not.contain.text", "먼저 여기");

    // 4) 사용자가 직접 거두는 길은 그대로다.
    cy.get("body").type("{esc}");
    cy.get(".ui-guide").should("not.exist");
  });
});
