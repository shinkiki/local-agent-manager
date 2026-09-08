/// <reference types="cypress" />
// QA #34: 설정 → 백엔드 서비스 카드의 스위치 셋(Tailscale 서비스·원격 편집 허용·절전 억제)은
// 상태 조회(get_tailscale_service_status·get_sleep_prevention)가 끝나기 전에 `Boolean(null)`로
// 꺼짐을 그렸고, 원격 편집 허용은 접근 정보만 오면 조작까지 받아 이미 켜진 설정에 "켜기"
// 확인 대화가 떴다. 조치 뒤에는 모르는 값을 false로 그리지 않는다 — 조회가 끝날 때까지 스위치
// 자리에 "확인 중…" 표식만 두고, 응답이 오면 그 값 그대로 스위치가 나타난다.
// 응답을 늦춰 조회 전 구간을 넓히고, 늦게 온 값은 켜짐으로 두어 되감김이 없는지 본다.
const ROW = ".backend-service-toggle";
const row = (label: string) => cy.get(ROW).filter(`:has(strong:contains("${label}"))`);

const tailscaleStatus = {
  available: true,
  enabled: true,
  host: "mac-host.tail1234.ts.net",
  login: null,
  url: "https://mac-host.tail1234.ts.net",
  servicePort: 54_178,
  serveTarget: null,
  conflictTarget: null,
  remoteAccepted: true,
  remoteWrite: true,
  error: null,
};

const sleepStatus = { supported: true, enabled: true, active: true, mechanism: "caffeinate", error: null };

describe("QA #34 · 백엔드 서비스 스위치는 상태 조회 전에 꺼짐으로 보이지 않는다", () => {
  it("조회가 끝날 때까지 스위치 대신 확인 중 표식을 두고, 늦게 온 켜짐 값을 그대로 그린다", () => {
    cy.stubInvoke("get_tailscale_service_status", (req) => {
      req.reply({ delay: 1500, statusCode: 200, body: tailscaleStatus });
    }).as("tailscale");
    cy.stubInvoke("get_sleep_prevention", (req) => {
      req.reply({ delay: 1500, statusCode: 200, body: sleepStatus });
    }).as("sleep");
    cy.visitApp();
    cy.openSettingsTab("service");
    cy.get(".remote-access-card").should("be.visible");

    // 1) 조회 전: 세 행 모두 스위치가 없고 확인 중 표식만 있다. 꺼짐(aria-checked=false)으로
    //    그려지는 순간이 없어야 하므로 스위치 자체가 존재하지 않아야 한다.
    for (const label of ["Tailscale 서비스", "원격 편집 허용", "절전 억제"]) {
      row(label).should("have.attr", "data-state", "unknown");
      row(label).find('[role="switch"]').should("not.exist");
      row(label).find('[role="status"]').should("contain.text", "확인 중…");
      row(label).should("not.have.class", "enabled");
    }
    cy.get('[role="dialog"], .confirm-dialog').should("not.exist");

    // 2) 응답이 오면 스위치가 그 값(켜짐)으로 나타난다 — 꺼짐을 거쳐 뒤집히지 않는다.
    cy.wait(["@tailscale", "@sleep"]);
    row("Tailscale 서비스").should("have.attr", "data-state", "on")
      .find('[role="switch"]').should("have.attr", "aria-checked", "true");
    row("원격 편집 허용").should("have.attr", "data-state", "on")
      .find('[role="switch"]').should("have.attr", "aria-checked", "true");
    row("절전 억제").should("have.attr", "data-state", "on").and("have.class", "enabled")
      .find('[role="switch"]').should("have.attr", "aria-checked", "true");
    cy.get(`${ROW} [role="status"]`).should("not.exist");
  });

  it("상태 조회가 실패하면 스위치를 내주지 않고 실패 사유를 요약에 적는다", () => {
    cy.stubInvoke("get_tailscale_service_status", { statusCode: 500, body: { error: "QA forced tailscale status failure" } });
    cy.stubInvoke("get_sleep_prevention", { statusCode: 500, body: { error: "QA forced sleep status failure" } });
    cy.visitApp();
    cy.openSettingsTab("service");
    cy.get(".remote-access-card").should("be.visible");

    row("Tailscale 서비스").should("contain.text", "QA forced tailscale status failure")
      .and("have.attr", "data-state", "unknown")
      .find('[role="switch"]').should("not.exist");
    row("원격 편집 허용").should("have.attr", "data-state", "unknown").find('[role="switch"]').should("not.exist");
    row("절전 억제").should("contain.text", "QA forced sleep status failure")
      .and("have.attr", "data-state", "unknown")
      .find('[role="switch"]').should("not.exist");
  });
});
