/// <reference types="cypress" />
// 헤드리스 리눅스(NAS) 컨테이너에는 `systemd-inhibit`이 없어 백엔드가 절전 억제를 걸 수단을
// 찾지 못한다(docs/headless-linux-gaps.md L03, 2026-10-10 실측: get_sleep_prevention 이
// {supported:false, enabled:false, error:null}). 그 호스트에서도 토글은 눌렸고, 사용자는 누른
// 뒤에야 "막지 못했습니다" 오류로 그 사실을 알았다. 지금은 켜는 방향이 잠긴다 —
// 이 스펙이 그 배선(SettingsView → sleepToggleDisabled)을 화면에서 고정한다.
//
// get_sleep_prevention 응답만 가로채므로 호스트의 실제 절전 설정에는 손대지 않는다.
const SLEEP_TOGGLE = '[role="switch"][aria-label="절전 억제"]';
const SLEEP_ROW = '.backend-service-toggle:has([aria-label="절전 억제"])';

const openService = (body: Record<string, unknown>) => {
  cy.stubInvoke("get_sleep_prevention", { statusCode: 200, body });
  cy.visitApp();
  cy.openSettingsTab("service");
  cy.get(".remote-access-card").should("be.visible");
};

describe("백엔드 서비스 · 억제 수단이 없는 호스트", () => {
  it("켜는 방향을 잠그고 사유를 요약에 적는다", () => {
    openService({ supported: false, enabled: false, active: false, mechanism: null, error: null });

    cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "false");
    cy.get(SLEEP_TOGGLE).should("be.disabled");
    cy.get(SLEEP_ROW).find("small").should("contain.text", "이 호스트에서 쓸 수 있는 절전 억제 수단을 찾지 못했습니다.");
  });

  it("수단이 없어도 이미 켜져 있던 값은 끌 수 있다", () => {
    openService({ supported: false, enabled: true, active: false, mechanism: null, error: null });

    cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(SLEEP_TOGGLE).should("not.be.disabled");
  });
});
