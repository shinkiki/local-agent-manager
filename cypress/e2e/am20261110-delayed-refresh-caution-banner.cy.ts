/**
 * 다시 하면 풀리는 지연은 빨간 실패가 아니라 노란 주의로 보인다.
 *
 * NAS가 바쁠 때 세션 색인 갱신이 응답 제한 시간(15초)을 넘기거나 다른 갱신과 겹치면
 * "요청을 처리하지 못했습니다 · APP_RUNTIME" 빨간 배너가 자주 떴다. 실제로는 다음 갱신이
 * 목록을 따라잡는 지연이라, 응답 없음(`BackendTimeoutError`)·바쁨(`BackendBusyError`)은
 * 주의 단계로 세우고 진짜 실패만 빨간 배너로 남긴다.
 */
function openSessionsWithDelta(reply: { statusCode: number; body: unknown }): void {
  // 목록 조정이 새 개정을 알려 화면이 변경분을 받으러 가게 만든다.
  cy.stubInvoke("reconcile_session_catalog", { statusCode: 200, body: { revision: 987_654, changed: true } });
  cy.stubInvoke("get_manager_snapshot_delta", reply);
  cy.visitApp();
  cy.anchor("nav.sessions").click();
}

describe("지연 알림의 단계", () => {
  it("갱신이 겹친 바쁨 응답은 노란 주의 배너로 보인다", () => {
    openSessionsWithDelta({ statusCode: 503, body: { error: "세션 목록 갱신이 진행 중입니다. 잠시 후 다시 시도하세요" } });

    cy.get(".content-error .error-banner", { timeout: 20_000 })
      .should("have.class", "caution")
      .and("have.attr", "data-tone", "caution")
      .and("contain.text", "요청이 지연되고 있습니다")
      .and("contain.text", "APP_BUSY")
      .and("not.contain.text", "요청을 처리하지 못했습니다");
    cy.screenshot("delayed-refresh-caution-banner", { overwrite: true });
  });

  it("진짜 실패는 그대로 빨간 실패 배너다", () => {
    openSessionsWithDelta({ statusCode: 500, body: { error: "세션 목록을 읽지 못했습니다(시험)" } });

    cy.get(".content-error .error-banner", { timeout: 20_000 })
      .should("not.have.class", "caution")
      .and("have.attr", "data-tone", "error")
      .and("contain.text", "요청을 처리하지 못했습니다");
  });
});
