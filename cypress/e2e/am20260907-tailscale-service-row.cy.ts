/// <reference types="cypress" />
// 백엔드 서비스 카드에서 Tailscale 서비스 행은 지금까지 아무 스펙도 보지 않았다. 기존 원격
// 스펙 셋(remote-write, am20260906-remote-write-host-scope, am20260907-remote-write-language)은
// 모두 그 아래의 "원격 편집 허용" 행만 보고, Tailscale 행은 실제 CLI 상태에 따라 문구가
// 갈리므로 손대지 않았다. 그래서 tailscaleSummaryText(SettingsView.tsx:2317)의 다섯 갈래와
// loopbackTargetPort(SettingsView.tsx:2760)의 포트 따름 규칙은 한 번도 화면으로 확인된 적이 없다.
//
// 이 스펙은 get_tailscale_service_status 응답만 가로채 갈래를 만든다. 스위치는 한 번도
// 누르지 않으므로 set_tailscale_service_enabled가 나가지 않고, 호스트의 실제 Tailscale
// Serve 설정에는 닿지 않는다(스킬 5절). 읽기만 가로채므로 격리 백엔드에 남는 값도 없다.
const SWITCH = '[role="switch"][aria-label="Tailscale 서비스"]';
const ROW = ".backend-service-toggle";

/** 상태 응답의 기본값. 갈래마다 필요한 칸만 덮어쓴다. remoteWrite는 기본값(켜짐)을 유지해
 *  아래 "원격 편집 허용" 행이 이 스펙 때문에 다른 갈래로 빠지지 않게 한다. */
const status = (overrides: Record<string, unknown>) => ({
  available: true,
  enabled: false,
  host: null,
  login: null,
  url: null,
  servicePort: 54_178,
  serveTarget: null,
  conflictTarget: null,
  remoteAccepted: true,
  remoteWrite: true,
  error: null,
  ...overrides,
});

const openService = (overrides: Record<string, unknown>) => {
  cy.stubInvoke("get_tailscale_service_status", { statusCode: 200, body: status(overrides) });
  cy.visitApp();
  cy.openSettingsTab("service");
  cy.get(".remote-access-card").should("be.visible");
};

/** Tailscale 행만 골라 요약 문구를 본다. 같은 카드에 원격 편집·절전 억제 행이 함께 있어
 *  카드 전체로 contains를 걸면 다른 행의 문구를 잡을 수 있다. */
const tailscaleRow = () => cy.get(ROW).filter(':has([aria-label="Tailscale 서비스"])');

describe("백엔드 서비스 · Tailscale 서비스 행의 상태별 표기", () => {
  it("사용할 수 없으면 사정을 요약에 적고 스위치를 잠근다", () => {
    // CLI 오류 문구가 있으면 그대로 보여준다 — 왜 못 쓰는지가 사용자에게 필요한 정보다.
    openService({ available: false, error: "tailscale 명령을 찾을 수 없습니다." });
    tailscaleRow().should("contain.text", "tailscale 명령을 찾을 수 없습니다.");
    cy.get(SWITCH).should("have.attr", "aria-checked", "false").and("be.disabled");
    // 포트가 Tailscale을 따른다는 경고는 Tailscale을 쓸 수 있을 때만 나온다.
    cy.get(".backend-service-port-warning").should("not.exist");
    cy.get(".backend-service-conflict").should("not.exist");

    // 오류 문구가 없으면 기본 안내로 떨어진다.
    openService({ available: false, error: null });
    tailscaleRow().should("contain.text", "Tailscale을 사용할 수 없습니다.");
    cy.get(SWITCH).should("be.disabled");
  });

  it("꺼져 있으면 켤 주소를 미리 알리고, Serve 루트가 남의 것이면 그 주인을 알린다", () => {
    openService({ enabled: false, host: "mac-host.tail1234.ts.net" });
    tailscaleRow().should("contain.text", "꺼짐 · 켜면 https://mac-host.tail1234.ts.net");
    // 쓸 수 있고 호스트 화면이므로 이 행은 조작 가능해야 한다(누르지는 않는다).
    cy.get(SWITCH).should("have.attr", "aria-checked", "false").and("be.enabled");
    cy.get(".backend-service-port-warning")
      .should("contain.text", "동일한 서비스 포트로 설정됩니다");

    // 충돌 대상은 꺼짐 안내보다 먼저 알려야 한다 — 켜기 전에 알아야 할 사정이다.
    openService({ enabled: false, host: "mac-host.tail1234.ts.net", conflictTarget: "http://127.0.0.1:8080" });
    tailscaleRow()
      .should("contain.text", "다른 서비스가 Serve 루트를 사용 중: http://127.0.0.1:8080")
      .and("not.contain.text", "꺼짐 · 켜면");
  });

  it("켜져 있는데 백엔드가 원격 요청을 안 받으면 경고하고, 브라우저 화면에는 재시작 버튼을 주지 않는다", () => {
    openService({
      enabled: true,
      host: "mac-host.tail1234.ts.net",
      url: "https://mac-host.tail1234.ts.net",
      remoteAccepted: false,
    });
    tailscaleRow().should("contain.text", "서비스주소 https://mac-host.tail1234.ts.net");
    cy.get(SWITCH).should("have.attr", "aria-checked", "true");
    cy.get(".backend-service-conflict")
      .should("have.attr", "role", "alert")
      .and("contain.text", "호스트의 Agent Manager 데스크톱 앱에서 원격 허용으로 재시작하세요");
    // 재시작은 호스트에서만 되므로 브라우저 화면에는 버튼이 아예 없어야 한다.
    cy.get(".backend-service-conflict").find("button").should("not.exist");

    // 원격을 받는 정상 상태에서는 이 경고가 사라진다.
    openService({
      enabled: true,
      host: "mac-host.tail1234.ts.net",
      url: "https://mac-host.tail1234.ts.net",
      remoteAccepted: true,
    });
    cy.get(".backend-service-conflict").should("not.exist");
  });

  it("Serve 대상이 이 컴퓨터 루프백이면 서비스 포트가 그 포트를 따르고 저장 버튼이 사라진다", () => {
    openService({ enabled: true, host: "mac-host.tail1234.ts.net", serveTarget: "http://127.0.0.1:54321" });
    cy.get(".backend-service-port input").should("have.value", "54321").and("be.disabled");
    // 따르는 동안에는 저장할 것이 없으므로 버튼 자체를 두지 않는다.
    cy.get(".backend-service-port button").should("not.exist");
    // 브라우저 화면에서는 재시작을 할 수 없으니 포트 미적용 경고도 뜨지 않는다.
    cy.get(".backend-service-conflict").should("not.exist");

    // 다른 호스트를 가리키는 대상은 따라갈 수 없다 — 저장 버튼이 그대로 있어야 한다.
    openService({ enabled: true, host: "mac-host.tail1234.ts.net", serveTarget: "http://100.64.0.9:54321" });
    cy.get(".backend-service-port input").should("not.have.value", "54321");
    cy.get(".backend-service-port button").should("exist").and("be.disabled");
  });
});
