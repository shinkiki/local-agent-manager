// 사이드바 브랜드 로고의 "데이터 새로고침"(App.tsx:1226) 버튼은 refreshApp이 도는 동안
// disabled로 막혀 같은 갱신이 겹쳐 돌지 않아야 한다. 빠른 연속 클릭에서 세션 목록 재조정
// 요청(reconcile_session_catalog)이 한 번만 나가는지, 끝난 뒤 다시 눌리는지를 본다.
describe("사이드바 로고 새로고침의 중복 실행 차단", () => {
  it("새로고침이 도는 동안 버튼이 막히고 두 번째 요청이 나가지 않으며, 끝나면 다시 눌린다", () => {
    let reconcileCount = 0;
    // 실제 백엔드 응답을 그대로 쓰되 지연만 넣어, 새로고침이 도는 중간 상태를 붙잡는다.
    cy.intercept("POST", "**/api/invoke/reconcile_session_catalog", (req) => {
      reconcileCount += 1;
      req.on("response", (res) => { res.setDelay(1500); });
    }).as("reconcile");

    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.get(".brand-logo")
      .should("not.be.disabled")
      .should("have.attr", "aria-label", "데이터 새로고침")
      .should("have.attr", "title", "데이터 새로고침");

    // 기동 중 자동 호출과 섞이지 않도록 클릭 직전 횟수를 기준선으로 잡는다.
    cy.wrap(null).then(() => {
      const before = reconcileCount;
      cy.get(".brand-logo").click();
      cy.get(".brand-logo").should("be.disabled");
      // 막힌 버튼을 한 번 더 눌러도 두 번째 재조정 요청은 나가지 않는다.
      cy.get(".brand-logo").click({ force: true });
      cy.get(".brand-logo").should("be.disabled").then(() => {
        expect(reconcileCount, "새로고침 중 추가 요청").to.equal(before + 1);
      });

      // 응답이 끝나면 버튼이 다시 눌리는 상태로 돌아온다.
      cy.wait("@reconcile");
      cy.get(".brand-logo", { timeout: 20000 }).should("not.be.disabled");
      cy.screenshot("sidebar-refresh-guard-after-refresh");

      // 두 번째 새로고침은 정상적으로 새 요청을 낸다.
      cy.get(".brand-logo").click();
      cy.get(".brand-logo").should("be.disabled").then(() => {
        expect(reconcileCount, "두 번째 새로고침 요청").to.equal(before + 2);
      });
    });
  });
});
