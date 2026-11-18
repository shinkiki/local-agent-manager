/**
 * CLI 연결 드로워의 "터미널은 데스크톱 앱에서만" 안내(QA #59).
 *
 * 데스크톱 런타임이 아닌 곳(원격 웹·브라우저·이 격리 하네스)에서는 설치·로그인 터미널을 열 수
 * 없다는 안내가 뜬다. 아무 요청도 실패하지 않은 자리인데 ErrorBanner로 그려져 "요청을 처리하지
 * 못했습니다. APP_RUNTIME" 머리말이 붙었다. 이제 NoticeBanner로 문장만 보이고, 실패 배너는
 * 실제 실패(다시 검사 오류)에만 남는다.
 */
describe("설정 · 연결 · CLI 연결 드로워의 안내 배너", () => {
  it("데스크톱 터미널 안내는 실패 배너가 아니라 안내 배너로 뜬다", () => {
    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").within(() => {
      cy.get(".cli-settings-provider-states button.button").first().click();
    });
    cy.get('[role="dialog"]').should("have.length", 1).within(() => {
      cy.get(".notice-banner")
        .should("have.length", 1)
        .and("contain.text", "설치·로그인용 터미널은 데스크톱 앱에서만 열 수 있습니다.")
        .invoke("text").should("not.contain", "요청을 처리하지 못했습니다").and("not.contain", "APP_RUNTIME");
      // 드로워를 열기만 한 상태에서는 실패한 요청이 없으므로 실패 배너도 없다.
      cy.get(".error-banner").should("not.exist");
    });
  });
});
