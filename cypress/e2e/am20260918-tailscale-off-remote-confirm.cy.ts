/// <reference types="cypress" />
// Tailscale 서비스를 끄는 조작은 어디서 눌렀는지에 따라 확인 절차가 달라진다 —
// 원격(Tailscale) 접속에서 끄면 지금 쓰는 접속 경로가 그대로 사라지므로 위험 확인창을
// 한 번 받고, 호스트 화면에서 끄면 바로 저장한다(SettingsView.tsx:3622 toggleTailscale의
// `confirm: !next && access?.remote`).
//
// 기존 Tailscale 스펙 넷(am20260907-tailscale-service-row, am20260907-tailscale-serve-conflict,
// am20260912-tailscale-serve-target-port-bounds, am20260913-tailscale-status-load-failure)은
// 모두 `/api/access`를 손대지 않아 호스트 접속으로만 돌았다. 그래서 원격 접속에서 끄기
// 확인창이 뜨는지, 취소가 저장을 막는지는 한 번도 화면으로 확인된 적이 없다.
//
// 가로채는 것은 접속 상태의 채널 칸(mode·remote·channel)과 Tailscale 상태·저장 응답뿐이다.
// 호스트의 실제 Tailscale Serve 설정에는 닿지 않고, 확인창을 취소하는 경로에서는 저장
// 명령 자체가 나가지 않는다(스킬 5절).
const TOGGLE = '[role="switch"][aria-label="Tailscale 서비스"]';
const SERVICE_URL = "https://qa-host.example.ts.net";

function status(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    enabled: true,
    host: "qa-host.example.ts.net",
    login: "qa@example.com",
    url: SERVICE_URL,
    servicePort: 4178,
    serveTarget: null,
    conflictTarget: null,
    remoteAccepted: true,
    error: null,
    ...overrides,
  };
}

const sleepStatus = { supported: true, enabled: false, active: false, mechanism: null, error: null };

/** 접속 상태 응답의 채널 칸만 갈아 끼운다. 나머지 필드는 백엔드가 준 값 그대로 흘린다. */
const stubAccess = (patch: { mode: string; remote: boolean; channel: string }) =>
  cy.intercept("GET", "**/api/access", (req) => {
    req.continue((res) => { Object.assign(res.body as Record<string, unknown>, patch); });
  }).as("access");

/** 켜져 있는 Tailscale 서비스 행을 띄운다. 저장 호출 횟수를 세는 통을 돌려준다. */
function openService(patch: { mode: string; remote: boolean; channel: string }) {
  const calls: Array<{ enabled: boolean; replaceExisting: boolean }> = [];
  let enabled = true;

  stubAccess(patch);
  cy.stubInvoke("get_tailscale_service_status", (request) => {
    request.reply({ statusCode: 200, body: status({ enabled, url: enabled ? SERVICE_URL : null }) });
  }).as("tailscaleStatus");
  cy.stubInvoke("set_tailscale_service_enabled", (request) => {
    calls.push({ enabled: request.body.enabled, replaceExisting: request.body.replaceExisting });
    enabled = Boolean(request.body.enabled);
    request.reply({ statusCode: 200, body: status({ enabled, url: enabled ? SERVICE_URL : null }) });
  }).as("setTailscale");
  cy.stubInvoke("get_sleep_prevention", { statusCode: 200, body: sleepStatus });

  cy.visitApp();
  cy.openSettingsTab("service");
  cy.get(".remote-access-card").should("be.visible");
  cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
  return calls;
}

describe("Tailscale 서비스 끄기 · 원격 접속에서만 받는 위험 확인", () => {
  it("원격에서 끄면 확인창이 뜨고, 취소는 저장을 내보내지 않고 스위치를 켜짐으로 남긴다", () => {
    const calls = openService({ mode: "tailscale", remote: true, channel: "remote" });

    // 로그인 뒤의 원격은 데스크톱과 같은 권한이라 Tailscale 행은 눌린다(C20).
    cy.get(TOGGLE).should("be.enabled");

    cy.get(TOGGLE).click();

    // 1) 확인창은 무엇이 끊기는지와 어디서 되살려야 하는지를 함께 말한다.
    cy.get(".confirm-dialog").should("be.visible")
      .and("contain.text", "지금 쓰는 이 원격 접속이 끊깁니다");
    cy.contains(".modal-header, .modal", "Tailscale 서비스 끄기").should("exist");
    cy.get(".confirm-dialog-warning").should("contain.text", "맥에서 직접 다시 켜야");
    cy.get(".modal-footer").contains("button", "끄기").should("have.class", "danger");

    // 2) 취소는 확인창만 걷고 저장 명령을 내보내지 않는다 — 여기서 한 번이라도 나가면
    //    확인을 받는 의미가 없다.
    cy.get(".modal-footer").contains("button", "취소").click();
    cy.get(".confirm-dialog").should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true").and("be.enabled");
    cy.get(".remote-access-card .settings-success").should("not.exist");
    cy.then(() => expect(calls, "취소 뒤 저장 호출").to.have.length(0));

    // 3) 다시 눌러 확인하면 껐다고 알리고 스위치가 꺼짐으로 내려온다.
    cy.get(TOGGLE).click();
    cy.get(".modal-footer").contains("button", "끄기").click();
    cy.wait("@setTailscale");
    cy.get(".confirm-dialog").should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.contains(".remote-access-card .settings-success", "Tailscale 서비스를 껐습니다").should("be.visible");
    cy.then(() => expect(calls, "확인 뒤 저장 호출").to.deep.eq([{ enabled: false, replaceExisting: false }]));
  });

  it("호스트 화면에서 끄면 확인창 없이 바로 저장한다", () => {
    const calls = openService({ mode: "local", remote: false, channel: "localBrowser" });

    cy.get(TOGGLE).click();
    cy.wait("@setTailscale");
    cy.get(".confirm-dialog").should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.then(() => expect(calls, "호스트 저장 호출").to.deep.eq([{ enabled: false, replaceExisting: false }]));
  });
});
