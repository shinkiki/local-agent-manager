// Tailscale Serve 루트 경로를 다른 서비스가 쓰고 있을 때의 덮어쓰기 결정 경로.
// AM-166. 기존 원격접근 스펙(remote-write.cy.ts, am20260906-remote-write-host-scope,
// am20260907-remote-write-language)은 모두 "원격 편집 허용" 행만 다루고, Tailscale
// 서비스 행의 충돌 안내(SettingsView.tsx:2735 BackendServiceAlert)는 아무도 보지 않는다.
// 격리 백엔드에는 Tailscale이 없어 available=false로만 오므로 상태 조회와 저장 응답을
// 가로채 충돌 상황을 만든다. 확인할 계약은 세 가지다.
//  1) 꺼짐 + conflictTarget이면 요약이 "다른 서비스가 Serve 루트를 사용 중"을 알린다.
//  2) 켜기 저장이 "Serve 루트 경로" 오류로 실패하면 취소/덮어쓰고 켜기 두 갈래 안내가 뜨고,
//     취소는 안내와 실패 문구를 함께 걷고 스위치를 꺼짐으로 남긴다.
//     실패 사유는 카드 아래 오류 배너가 아니라 Tailscale 행 요약에 실린다
//     (SettingsView.tsx:2318 tailscaleSummaryText가 taskError를 가장 먼저 답한다).
//  3) 덮어쓰고 켜기는 replaceExisting=true로 다시 저장하고, 성공하면 안내가 사라지고
//     요약이 서비스주소로 바뀐다.
const TOGGLE = '[role="switch"][aria-label="Tailscale 서비스"]';
const CONFLICT_TARGET = "http://127.0.0.1:9911";
const SERVICE_URL = "https://qa-host.example.ts.net";
const SERVE_ROOT_ERROR = "Serve 루트 경로를 다른 서비스가 사용 중입니다.";

/** Tailscale 서비스 행. 같은 카드의 원격 편집·절전 행과 모양이 같아 제목으로 가른다. */
function tailscaleRow() {
  return cy.get(".remote-access-card .backend-service-toggle").filter(':contains("Tailscale 서비스")');
}

function status(overrides: Record<string, unknown>) {
  return {
    available: true,
    enabled: false,
    host: "qa-host.example.ts.net",
    login: "qa@example.com",
    url: null,
    servicePort: 4178,
    // 루프백 대상이면 포트 입력이 Tailscale을 따라가 이 시나리오와 무관한 문구가 끼어든다.
    serveTarget: null,
    conflictTarget: CONFLICT_TARGET,
    remoteAccepted: true,
    remoteWrite: true,
    error: null,
    ...overrides,
  };
}

describe("Tailscale Serve 루트 충돌의 덮어쓰기 결정", () => {
  it("충돌 요약을 알리고, 취소는 안내를 걷고, 덮어쓰고 켜기는 replaceExisting으로 다시 저장한다", () => {
    let enabled = false;
    let attempts = 0;

    cy.intercept("POST", "**/api/invoke/get_tailscale_service_status", (request) => {
      request.reply({
        statusCode: 200,
        body: enabled
          ? status({ enabled: true, url: SERVICE_URL, conflictTarget: null })
          : status({}),
      });
    }).as("tailscaleStatus");

    cy.intercept("POST", "**/api/invoke/set_tailscale_service_enabled", (request) => {
      attempts += 1;
      if (!request.body.replaceExisting) {
        request.reply({ statusCode: 500, body: { error: SERVE_ROOT_ERROR } });
        return;
      }
      enabled = true;
      request.reply({ statusCode: 200, body: status({ enabled: true, url: SERVICE_URL, conflictTarget: null }) });
    }).as("setTailscale");

    cy.visitApp();
    cy.openSettingsTab("service");

    // 1) 꺼짐 + 충돌 대상이면 요약이 그 사정을 먼저 알린다.
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false").and("be.enabled");
    cy.get(".remote-access-card")
      .should("contain.text", "다른 서비스가 Serve 루트를 사용 중")
      .and("contain.text", CONFLICT_TARGET);
    cy.get(".remote-access-card .backend-service-conflict").should("not.exist");

    // 2) 켜기 실패 → 두 갈래 안내와 오류 배너.
    cy.get(TOGGLE).click();
    cy.wait("@setTailscale");
    cy.get(".remote-access-card .backend-service-conflict")
      .should("be.visible")
      .and("contain.text", "Tailscale Serve 루트 경로를 다른 서비스가 사용하고 있습니다");
    cy.get(".remote-access-card .backend-service-conflict button").should("have.length", 2);
    tailscaleRow().should("contain.text", SERVE_ROOT_ERROR);
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false").and("be.enabled");

    // 취소는 안내와 오류를 함께 걷는다 — 남으면 다음 조작에서 옛 오류로 오해한다.
    cy.contains(".remote-access-card .backend-service-conflict button", "취소").click();
    cy.get(".remote-access-card .backend-service-conflict").should("not.exist");
    tailscaleRow().should("not.contain.text", SERVE_ROOT_ERROR)
      .and("contain.text", "다른 서비스가 Serve 루트를 사용 중");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");

    // 3) 다시 켜서 안내를 띄우고 덮어쓰기를 고른다.
    cy.get(TOGGLE).click();
    cy.wait("@setTailscale");
    cy.contains(".remote-access-card .backend-service-conflict button", "덮어쓰고 켜기").click();
    cy.wait("@setTailscale").its("request.body.replaceExisting").should("eq", true);

    cy.get(".remote-access-card .backend-service-conflict").should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(".remote-access-card").should("contain.text", `서비스주소 ${SERVICE_URL}`);
    cy.contains(".remote-access-card .settings-success", "Tailscale 서비스를 켰습니다").should("be.visible");
    cy.then(() => expect(attempts, "저장 호출 횟수").to.eq(3));
  });
});
