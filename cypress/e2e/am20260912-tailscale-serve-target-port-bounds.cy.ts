/// <reference types="cypress" />
// 백엔드 서비스 카드의 서비스 포트는 Tailscale Serve 대상이 이 컴퓨터의 루프백을 가리킬 때만
// 그 포트를 따라가고 편집이 잠긴다(loopbackTargetPort · SettingsView.tsx:2952). 기존
// am20260907-tailscale-service-row 스펙은 이 판정을 http://127.0.0.1:54321(따름)과
// http://100.64.0.9:54321(안 따름) 두 값으로만 봤다. 그래서 판정 안에 있는 나머지 조건 —
// localhost 별칭, 포트 범위 경계(1024·65535)와 그 바깥, 포트가 없는 대상, URL로 파싱조차 안 되는
// 대상 — 은 한 번도 화면으로 확인된 적이 없다. 이 스펙은 그 경계값만 본다.
//
// get_tailscale_service_status 응답만 가로챈다. 스위치도 저장 버튼도 누르지 않으므로
// set_tailscale_service_enabled·set_backend_service_port가 나가지 않고, 호스트의 실제 Tailscale
// Serve 설정과 격리 백엔드 저장값 어디에도 닿지 않는다(스킬 5절).
const PORT_INPUT = ".backend-service-port input";
const PORT_SAVE = ".backend-service-port button";

const status = (serveTarget: string | null) => ({
  available: true,
  enabled: true,
  host: "mac-host.tail1234.ts.net",
  login: null,
  url: "https://mac-host.tail1234.ts.net",
  servicePort: 54_178,
  serveTarget,
  conflictTarget: null,
  remoteAccepted: true,
  error: null,
});

const openService = (serveTarget: string | null) => {
  cy.stubInvoke("get_tailscale_service_status", { statusCode: 200, body: status(serveTarget) });
  cy.visitApp();
  cy.openSettingsTab("service");
  cy.get(".remote-access-card").should("be.visible");
};

/** 따르는 상태: 대상 포트가 칸에 박히고, 편집도 저장도 못 한다.
 *  안내 문구는 보지 않는다 — 이 하네스는 데스크톱이 아닌 브라우저 화면이라
 *  nativeRuntime이 거짓이고, 그 갈래의 "읽기 전용" 안내가 따름 안내보다 앞선다
 *  (SettingsView.tsx:2858). 따름 안내는 호스트 앱에서만 보이므로 이 회차에서는 보류다. */
const expectFollows = (port: string) => {
  cy.get(PORT_INPUT).should("have.value", port).and("be.disabled").and("have.attr", "readonly");
  // 따르는 동안에는 저장할 것이 없으므로 버튼을 아예 두지 않는다.
  cy.get(PORT_SAVE).should("not.exist");
};

/** 안 따르는 상태: 저장된 포트가 그대로 있고 저장 버튼이 남는다. */
const expectDoesNotFollow = () => {
  // not.have.attr는 단언 대상을 바꾸므로 체이닝하지 않고 나눠 본다.
  cy.get(PORT_INPUT).should("not.have.attr", "readonly");
  // 브라우저 화면에서는 따르지 않아도 칸이 disabled다(호스트 전용 편집).
  // 따름 여부를 가르는 신호는 readonly와 저장 버튼의 존재다.
  cy.get(PORT_SAVE).should("exist");
};

describe("백엔드 서비스 · Serve 대상 포트의 따름 판정 경계값", () => {
  it("localhost 별칭도 루프백으로 보고 포트를 따른다", () => {
    openService("http://localhost:54321");
    expectFollows("54321");
  });

  it("포트 범위의 양 끝값은 따르고, 그 바로 바깥은 따르지 않는다", () => {
    // 최솟값 1024 — 받아들여야 한다.
    openService("http://127.0.0.1:1024");
    expectFollows("1024");

    // 1023은 범위 밖이므로 서비스 포트가 끌려가면 안 된다.
    openService("http://127.0.0.1:1023");
    cy.get(PORT_INPUT).should("not.have.value", "1023");
    expectDoesNotFollow();

    // 최댓값 65535 — 받아들여야 한다.
    openService("https://127.0.0.1:65535");
    expectFollows("65535");
  });

  it("포트가 없는 대상과 URL이 아닌 대상은 따르지 않고 화면도 깨지지 않는다", () => {
    // 포트를 적지 않은 루프백 대상(http 기본 80)은 서비스 포트로 쓸 수 없다.
    openService("http://127.0.0.1");
    expectDoesNotFollow();

    // 파싱 자체가 안 되는 값이 와도 카드가 그려져야 한다.
    openService("127.0.0.1:54321");
    cy.get(".remote-access-card").should("be.visible");
    expectDoesNotFollow();

    // Serve 대상이 비어 있는 평상시 상태와 같아야 한다.
    openService(null);
    expectDoesNotFollow();
  });
});
