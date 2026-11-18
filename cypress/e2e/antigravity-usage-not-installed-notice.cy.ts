/// <reference types="cypress" />

/**
 * 설정 → 연결 → Antigravity 사용량 카드의 "CLI 미설치" 안내.
 *
 * CLI가 없으면 `/usage` 조회는 시작도 못 한다. 그 사정이 사용량 뷰의 `error`로 실려 와
 * 실패 배너로 그려지면서 "요청을 처리하지 못했습니다. APP_RUNTIME" 머리말과 문의용
 * 오류코드가 붙었고, 아직 깔지 않은 CLI가 앱 장애처럼 보였다(QA #59와 같은 부류).
 * 이제 CLI 미탐지는 안내 배너로 문장만 보이고, 실패 배너는 CLI가 있는데 조회가 실패한
 * 자리에만 남는다.
 */
const USAGE_ERROR = {
  status: "error",
  windows: [],
  updatedAt: 1_700_000_000_000,
  error: "Antigravity CLI가 설치되어 있지 않습니다",
  retryAt: null,
  rateLimited: false,
  tokenRefreshLimited: false,
  tokenRefreshThrottleStreak: 0,
};

function stubAntigravityCli(detected: boolean) {
  cy.stubInvoke("get_manager_snapshot", (req) => req.continue((res) => {
    res.body.status.providers.forEach((provider: { provider: string; cli: { detected: boolean; path: string | null } }) => {
      if (provider.provider !== "antigravity") return;
      provider.cli.detected = detected;
      provider.cli.path = detected ? "/usr/local/bin/agy" : null;
    });
  }));
  cy.stubInvoke("get_antigravity_usage", { statusCode: 200, body: USAGE_ERROR });
  cy.visitApp();
  cy.openSettingsTab("connections");
}

describe("설정 · 연결 · Antigravity 사용량 카드", () => {
  it("CLI가 탐지되지 않으면 실패 배너가 아니라 안내 배너로 뜬다", () => {
    stubAntigravityCli(false);
    cy.anchor("settings.connections").within(() => {
      cy.get(".provider-usage-card .notice-banner")
        .should("have.length", 1)
        .and("contain.text", "Antigravity CLI가 설치되어 있지 않아 사용량을 읽을 수 없습니다.")
        .invoke("text").should("not.contain", "요청을 처리하지 못했습니다").and("not.contain", "APP_RUNTIME");
      cy.get(".provider-usage-card .error-banner").should("not.exist");
    });
  });

  it("CLI가 탐지된 뒤의 조회 실패는 실패 배너로 남는다", () => {
    // 사전 조건 안내로 바꾼 것은 미탐지 한 갈래뿐이다. CLI가 깔린 채 조회가 깨진
    // 것은 진짜 실패라, 머리말과 오류코드가 붙는 실패 배너가 그대로 맞다.
    stubAntigravityCli(true);
    cy.anchor("settings.connections").within(() => {
      cy.get(".provider-usage-card .error-banner").should("have.length", 1);
      cy.get(".provider-usage-card .notice-banner").should("not.exist");
    });
  });
});
