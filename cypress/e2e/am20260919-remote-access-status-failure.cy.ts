/// <reference types="cypress" />
// 설정 → 시스템의 원격 접근 카드는 세 갈래 조회(접속 상태 `/api/access`·Tailscale·절전)를
// 각자 따로 건다. 이 중 Tailscale 조회 실패는 AM-249 티켓이 다뤘고, 접속 상태가 성공했을
// 때의 원격 읽기 전용 갈래는 AM-364가 열었다. 그런데 **접속 상태 조회 자체가 실패했을 때**
// 이 카드가 어떻게 보이는지는 아무도 화면으로 본 적이 없다 — `/api/access`를 손댄 스펙 둘
// (am20260917-remote-readonly-service-card·am20260918-tailscale-off-remote-confirm)은 모두
// 성공 응답의 세 칸만 갈아 끼웠다. 이 스펙은 그 실패 갈래만 본다.
//
// 확인할 계약은 넷이다(SettingsView.tsx:3815·3826·3830·3899).
//  1) 카드 머리말 요약이 "서비스주소 …"가 아니라 "연결 오류"로 바뀐다.
//  2) 실패 사유가 카드 아래 오류 배너에 실린다 — 서비스 포트 쪽 오류가 없을 때 accessError가
//     그 자리를 쓴다.
//  3) Tailscale·절전 조회가 **성공했는데도** 두 스위치가 모두 잠긴다. 잠그는 조건이
//     "접속 상태를 읽었는가"이므로(canManage), 백엔드 악수를 못 한 상태에서 조작을 받으면 안 된다.
//  4) 잠긴 이유가 값을 바꾸지는 않는다 — Tailscale 행은 조회된 켜짐 상태를 그대로 그린다.
//
// 가로채는 것은 `/api/access` 응답뿐이고, 그것도 앱이 뜬 뒤부터다(부팅 악수까지 막으면 화면이
// 아예 열리지 않는다). 스위치도 저장 버튼도 누르지 않으므로 set_* 명령이 나가지 않고, 호스트의
// Tailscale·절전 설정과 격리 백엔드 저장값 어디에도 닿지 않는다(스킬 5절).
const CARD = ".remote-access-card";
const ROW = ".backend-service-toggle";
const row = (label: string) => cy.get(ROW).filter(`:has(strong:contains("${label}"))`);
const LABELS = ["Tailscale 서비스", "절전 억제"];
const ACCESS_ERROR = "원격 접근 상태를 확인하지 못했습니다 · QA 재현";

// 잠금의 원인을 접속 상태 실패 하나로 좁히기 위해 나머지 두 조회는 "관리 가능"으로 성공시킨다.
const tailscaleStatus = {
  available: true,
  enabled: true,
  host: "qa-host.tail1234.ts.net",
  login: null,
  url: "https://qa-host.tail1234.ts.net",
  servicePort: 54_178,
  serveTarget: null,
  conflictTarget: null,
  remoteAccepted: true,
  error: null,
};
const sleepStatus = { supported: true, enabled: false, active: false, mechanism: null, error: null };

/**
 * 셸이 다 뜬 뒤부터 접속 상태 조회를 실패로 답하게 만든 다음 시스템 탭을 연다.
 * 부팅 악수까지 막으면 앱 자체가 뜨지 않으므로(왼쪽 내비가 그려지지 않는다) 깃발을
 * 내비가 보인 뒤에 올린다.
 */
const state = { fail: false };

const openServiceWithFailingAccess = () => {
  state.fail = false;
  cy.intercept("GET", "**/api/access", (req) => {
    if (!state.fail) { req.continue(); return; }
    req.reply({ statusCode: 503, body: { error: ACCESS_ERROR } });
  }).as("access");
  cy.stubInvoke("get_tailscale_service_status", { statusCode: 200, body: tailscaleStatus });
  cy.stubInvoke("get_sleep_prevention", { statusCode: 200, body: sleepStatus });

  cy.visitApp();
  cy.anchor("nav.settings").should("exist");
  cy.then(() => { state.fail = true; });
  cy.openSettingsTab("service");
  cy.get(CARD).should("be.visible");
};

describe("원격 접근 카드 · 접속 상태 조회가 실패했을 때", () => {
  it("요약이 연결 오류로 바뀌고 사유가 배너에 실리며, 다른 조회가 성공해도 두 스위치가 잠긴다", () => {
    openServiceWithFailingAccess();

    // 1) 머리말 요약 — 조회 중도 서비스주소도 아니고 실패를 말한다.
    cy.get(`${CARD} header small`).should("have.text", "연결 오류");

    // 2) 실패 사유는 카드 아래 오류 배너에 실린다.
    cy.get(`${CARD} .error-banner`).should("be.visible").and("contain.text", ACCESS_ERROR);

    // 3) Tailscale·절전 조회는 성공했는데도 두 스위치가 모두 잠긴다.
    for (const label of LABELS) {
      row(label).find('[role="switch"]').should("exist").and("be.disabled");
    }

    // 4) 잠금이 값을 바꾸지는 않는다 — 조회된 켜짐 상태를 그대로 그린다.
    row("Tailscale 서비스").find('[role="switch"]').should("have.attr", "aria-checked", "true");
    row("Tailscale 서비스").should("contain.text", tailscaleStatus.url);
  });

  it("영어로 전환해도 같은 실패를 영어 요약으로 알린다", () => {
    openServiceWithFailingAccess();
    // 언어 선택은 언어 탭에만 있으므로 되돌아와야 같은 카드를 다시 본다.
    cy.setLanguage("en");
    cy.openSettingsTab("service");

    cy.get(`${CARD} header small`).should("have.text", "Connection error");
    cy.get(`${CARD} .error-banner`).should("be.visible");
    // 되돌림은 앱을 다시 띄운다 — 부팅 악수를 막아 둔 채로는 화면이 뜨지 않으므로 먼저 푼다.
    cy.then(() => { state.fail = false; });
    cy.restoreLanguage();
  });
});
