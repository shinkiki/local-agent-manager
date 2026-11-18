/// <reference types="cypress" />
// 백엔드 서비스 카드의 '절전 억제'는 설정 저장과 실제 억제가 따로 논다. 백엔드가 값을 저장해도
// 이 호스트에 걸 수단이 없으면 `active`는 거짓으로 돌아오고, 화면은 그것을 성공으로 보이면
// 안 된다(SettingsView.tsx:3374). 기존 am20260907-prevent-sleep-toggle 스펙은 켜기·복원·끄기가
// 모두 성공하는 갈래만 봤다. 저장은 됐지만 걸리지 않은 갈래와, 백엔드가 사유를 실어 보낸 갈래,
// 그리고 끄기는 active가 거짓이어도 성공이라는 갈래는 화면으로 확인된 적이 없다. 이 스펙은
// 그 세 갈래만 본다.
//
// set_sleep_prevention 응답을 가로채므로 요청이 격리 백엔드에 닿지 않는다. 호스트의 실제
// 절전 설정과 저장값 어디에도 손대지 않는다(스킬 5절).
const SLEEP_TOGGLE = '[role="switch"][aria-label="절전 억제"]';
const SLEEP_ROW = '.backend-service-toggle:has([aria-label="절전 억제"])';

const status = (over: Partial<{ supported: boolean; enabled: boolean; active: boolean; mechanism: string | null; error: string | null }> = {}) => ({
  supported: true,
  enabled: false,
  active: false,
  mechanism: null,
  error: null,
  ...over,
});

const openService = () => {
  cy.stubInvoke("get_sleep_prevention", { statusCode: 200, body: status() });
  cy.visitApp();
  cy.openSettingsTab("service");
  cy.get(".remote-access-card").should("be.visible");
  cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "false");
};

describe("백엔드 서비스 · 절전 억제가 저장만 되고 걸리지 않은 경우", () => {
  it("켰는데 실제로 걸리지 않으면 성공 안내를 내지 않고 실패를 말한다", () => {
    openService();
    cy.stubInvoke("set_sleep_prevention", { statusCode: 200, body: status({ enabled: true, active: false }) }).as("setSleep");
    cy.get(SLEEP_TOGGLE).click();
    cy.wait("@setSleep").its("request.body.enabled").should("equal", true);

    // 저장은 됐으니 스위치는 켜짐이지만, 실제로 걸리지 않았으므로 강조는 붙지 않는다.
    cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(SLEEP_ROW).should("not.have.class", "enabled");
    // 요약 자리는 성공 문구가 아니라 실패 사유를 말한다.
    cy.get(SLEEP_ROW).find("small").should("contain.text", "설정은 저장했지만 이 호스트에서 자동 절전을 막지 못했습니다.");
    cy.contains("자동 절전을 막습니다").should("not.exist");
    cy.get(".settings-success").should("not.exist");
  });

  it("백엔드가 사유를 실어 보내면 기본 문구 대신 그 사유를 그대로 보여 준다", () => {
    openService();
    cy.stubInvoke("set_sleep_prevention", {
      statusCode: 200,
      body: status({ enabled: true, active: false, error: "caffeinate 실행 파일을 찾지 못했습니다." }),
    }).as("setSleep");
    cy.get(SLEEP_TOGGLE).click();
    cy.wait("@setSleep");

    cy.get(SLEEP_ROW).find("small").should("contain.text", "caffeinate 실행 파일을 찾지 못했습니다.");
    cy.get(SLEEP_ROW).find("small").should("not.contain.text", "설정은 저장했지만");
    cy.get(".settings-success").should("not.exist");
  });

  it("끄기는 active가 거짓으로 돌아와도 정상 처리로 안내한다", () => {
    openService();
    // 먼저 걸린 상태로 만든다.
    cy.stubInvoke("set_sleep_prevention", { statusCode: 200, body: status({ enabled: true, active: true, mechanism: "caffeinate" }) }).as("turnOn");
    cy.get(SLEEP_TOGGLE).click();
    cy.wait("@turnOn");
    cy.get(SLEEP_ROW).should("have.class", "enabled");
    cy.get(SLEEP_ROW).find("small").should("contain.text", "자동 절전을 막고 있습니다");

    // 끄면 active가 거짓으로 돌아오는 것이 정상이므로 실패로 읽으면 안 된다.
    cy.stubInvoke("set_sleep_prevention", { statusCode: 200, body: status({ enabled: false, active: false }) }).as("turnOff");
    cy.get(SLEEP_TOGGLE).click();
    cy.wait("@turnOff").its("request.body.enabled").should("equal", false);
    cy.get(".settings-success").should("contain.text", "자동 절전을 원래 설정대로 되돌렸습니다");
    cy.get(SLEEP_ROW).should("not.have.class", "enabled");
    cy.get(SLEEP_ROW).find("small").should("contain.text", "꺼짐 · 호스트가 잠들면 원격 접속이 끊깁니다");
  });
});
