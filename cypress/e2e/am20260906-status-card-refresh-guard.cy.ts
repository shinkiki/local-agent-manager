// 하단 상태바의 "CLI 연결과 사용량 새로고침" 버튼은 로고 새로고침과
// 다른 경로(refreshStatusCard)를 탄다. 계정 사용량 일괄 조회 가드가 runBulkUsageRefresh
// 한 벌로 모인 뒤(d2dfbe7), 이 버튼이 도는 동안 겹쳐 돌지 않고 끝나면 되살아나며 상태
// 바의 상세 줄이 빈 값으로 무너지지 않는지를 본다.
describe("사이드바 상태 카드 새로고침의 중복 실행 차단", () => {
  it("도는 동안 막히고 두 번째 조회가 나가지 않으며, 끝나면 다시 눌리고 상세 줄이 남는다", () => {
    let accountsCount = 0;
    // 실제 백엔드 응답을 그대로 쓰고 지연만 넣어 새로고침이 도는 중간 상태를 붙잡는다.
    cy.intercept("POST", "**/api/invoke/get_provider_accounts", (req) => {
      accountsCount += 1;
      req.on("response", (res) => { res.setDelay(1500); });
    }).as("accounts");

    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.get(".app-statusbar").as("statusCard");
    cy.get("@statusCard").find(".statusbar-detail").invoke("text").should("not.be.empty");

    cy.get(".statusbar-refresh")
      .should("not.be.disabled")
      .should("have.attr", "aria-label", "CLI 연결과 사용량 새로고침")
      .should("have.attr", "title", "CLI 연결과 사용량 새로고침");

    // 기동 직후 폴링과 섞이지 않도록 클릭 직전 횟수를 기준선으로 잡는다.
    cy.wrap(null).then(() => {
      const before = accountsCount;
      cy.get(".statusbar-refresh").click();
      cy.get(".statusbar-refresh").should("be.disabled").and("have.class", "busy");
      // 막힌 버튼을 한 번 더 눌러도 두 번째 계정 조회는 나가지 않는다.
      cy.get(".statusbar-refresh").click({ force: true });
      cy.get(".statusbar-refresh").should("be.disabled").then(() => {
        expect(accountsCount, "새로고침 중 추가 계정 조회").to.equal(before + 1);
      });
    });

    // 끝나면 버튼이 되살아나고 진행 표시가 걷힌다.
    cy.get(".statusbar-refresh", { timeout: 20000 })
      .should("not.be.disabled")
      .and("not.have.class", "busy");

    // 상태 카드가 빈 값으로 무너지지 않고 상세 줄 표시를 유지한다.
    cy.get("@statusCard").find(".statusbar-detail").invoke("text").should("not.be.empty");

    // 되살아난 버튼은 실제로 다시 눌린다.
    cy.wrap(null).then(() => {
      const before = accountsCount;
      cy.get(".statusbar-refresh").click();
      cy.get(".statusbar-refresh").should("be.disabled");
      cy.wrap(null).should(() => {
        expect(accountsCount, "재클릭 후 계정 조회").to.be.greaterThan(before);
      });
    });
  });
});
