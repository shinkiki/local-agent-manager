/// <reference types="cypress" />
// L08. "시스템 시작 시 Agent Manager 자동 시작" 행은 데스크톱 셸(tauri autostart)이 가진
// 값이라, 브라우저 화면에서는 "호스트의 Agent Manager 데스크톱 앱에서만 바꿀 수 있습니다"로
// 안내해 왔다. 헤드리스(NAS 컨테이너) 기동에는 그 호스트 앱이 아예 없으므로 그 문구는
// 존재하지 않는 화면을 가리킨다(docs/headless-linux-gaps.md L08).
//
// 가로채는 것은 접속 상태 응답의 `headless` 한 칸뿐이고 나머지 필드는 백엔드가 준 값을
// 그대로 흘린다. 스위치는 누르지 않으므로 set_background_settings가 나가지 않고, 호스트의
// OS 로그인 항목에는 닿지 않는다(운영 호스트의 상태를 변경하지 않는다).
const ROW = ".backend-service-toggle";
const row = () => cy.get(ROW).filter(':has(strong:contains("시스템 시작 시 Agent Manager 자동 시작"))');
const sleepRow = () => cy.get(ROW).filter(':has(strong:contains("절전 억제"))');

const tailscaleStatus = {
  available: true,
  enabled: false,
  host: "nas.tail1234.ts.net",
  login: null,
  url: null,
  servicePort: 54_178,
  serveTarget: null,
  conflictTarget: null,
  remoteAccepted: true,
  remoteWrite: true,
  error: null,
};

const sleepStatus = { supported: true, enabled: false, active: false, mechanism: null, error: null };

const openService = (patch: { headless: boolean }) => {
  cy.intercept("GET", "**/api/access", (req) => {
    req.continue((res) => {
      Object.assign(res.body as Record<string, unknown>, { mode: "tailscale", remote: true, writable: true, ...patch });
    });
  }).as("access");
  cy.stubInvoke("get_tailscale_service_status", { statusCode: 200, body: tailscaleStatus });
  cy.stubInvoke("get_sleep_prevention", { statusCode: 200, body: sleepStatus });
  cy.visitApp();
  cy.openSettingsTab("service");
  cy.get(".remote-access-card").should("be.visible");
};

describe("백엔드 서비스 · 헤드리스에서의 자동 시작 행", () => {
  it("헤드리스면 해당 없음으로 접히고 가리킬 데스크톱 앱을 말하지 않는다", () => {
    openService({ headless: true });

    row().should("have.attr", "data-state", "unknown");
    row().find(".backend-service-toggle-not-applicable").should("contain.text", "해당 없음");
    row().find(".backend-service-toggle-desktop-only").should("not.exist");
    row().find('[role="switch"]').should("not.exist");
    // 존재하지 않는 화면으로 보내는 대신, 재시작을 실제로 정하는 자리를 말한다.
    row().should("not.contain.text", "호스트의 Agent Manager 데스크톱 앱에서만 바꿀 수 있습니다");
    row().should("contain.text", "컨테이너 재시작 정책");
    // 같은 행의 도움말도 함께 봐야 한다. 팝오버는 createPortal로 body에 붙으므로 행 하위
    // 단언으로는 잡히지 않는다 — 요약줄만 고치고 여기 같은 문장을 남기면 사용자는 ⓘ를
    // 누르는 순간 없애려던 안내를 그대로 읽는다.
    row().find(".help-hint-trigger").click();
    cy.get(".help-hint-popover")
      .should("not.contain.text", "호스트의 데스크톱 앱에서만")
      .and("contain.text", "데스크톱 셸이 없어 이 항목은 해당 없습니다");
    // 헤드리스 표시는 이 행만 접는다 — 절전 억제는 아래 비헤드리스 경우와 같아야 한다.
    sleepRow().find('[role="switch"]').should("be.enabled");
  });

  it("헤드리스 표시가 없으면 종전대로 데스크톱 앱 전용 안내다", () => {
    openService({ headless: false });

    row().find(".backend-service-toggle-desktop-only").should("contain.text", "데스크톱 앱 전용");
    row().find(".backend-service-toggle-not-applicable").should("not.exist");
    row().should("contain.text", "호스트의 Agent Manager 데스크톱 앱에서만 바꿀 수 있습니다");
    row().find(".help-hint-trigger").click();
    cy.get(".help-hint-popover")
      .should("contain.text", "호스트의 데스크톱 앱에서만")
      .and("not.contain.text", "데스크톱 셸이 없어");
    // 위 헤드리스 경우와 같은 단언이다. 둘이 같아야 "헤드리스 표시가 이 행만 접는다"가
    // 성립한다 — 한쪽에만 두면 스텁이 supported라는 사실만 보게 된다.
    sleepRow().find('[role="switch"]').should("be.enabled");
  });
});
