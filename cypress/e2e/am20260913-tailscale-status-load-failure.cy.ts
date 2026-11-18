/// <reference types="cypress" />
// 설정 → 시스템 카드는 화면을 열 때 get_tailscale_service_status를 한 번 부르고, 그
// 한 응답으로 Tailscale 서비스 행을 그린다(원격 편집 허용 행은 C20 로그인 설정으로 대체돼
// 사라졌다). 기존 원격 스펙들(am20260907-tailscale-service-row,
// am20260907-tailscale-serve-conflict, am20260912-tailscale-serve-target-port-bounds,
// am20260906-remote-write-host-scope)은 모두 **조회가 성공한** 응답만 갈래로 넣었다.
// 조회 자체가 실패했을 때 이 줄이 무엇을 말하는지는 한 번도 화면으로 확인된 적이 없다.
//
// get_tailscale_service_status 응답만 500으로 가로챈다. 스위치를 누르지 않으므로
// set_tailscale_service_enabled가 나가지 않고, 호스트의 Tailscale
// Serve 설정과 격리 백엔드 저장값 어디에도 닿지 않는다(스킬 5절).
const ROW = ".backend-service-toggle";
const FAILURE = "Tailscale 상태를 읽지 못했습니다.";

const row = (title: string) => cy.contains(`${ROW} strong`, title).parents(ROW).first();

const openServiceWithFailedStatus = () => {
  cy.stubInvoke("get_tailscale_service_status", { statusCode: 500, body: { error: FAILURE } });
  cy.visitApp();
  cy.openSettingsTab("service");
  cy.get(".remote-access-card").should("be.visible");
};

describe("백엔드 서비스 · Tailscale 상태 조회가 실패했을 때의 행", () => {
  it("Tailscale 서비스 행은 실패 사유를 요약에 적는다", () => {
    openServiceWithFailedStatus();

    row("Tailscale 서비스").find("small").should("have.text", FAILURE);
  });

  it("상태를 모르는 동안에는 스위치를 내주지 않는다", () => {
    openServiceWithFailedStatus();

    // 값이 null이면 BackendServiceToggleRow는 스위치 대신 표식을 둔다(SettingsView.tsx:3244).
    // 모르는 값을 꺼짐으로 그려 사용자가 그 위에서 켜고 끄는 일을 막는 규칙이다.
    row("Tailscale 서비스").find('[role="switch"]').should("not.exist");
  });

  // 조회가 실패로 끝난 뒤의 행. 이전에는 '확인 중…'에 머물러 다시 부를 길도 없이 영원히
  // 기다리는 표식이 남았다(QA #80). 지금은 '읽지 못함'이다.
  it("실패가 끝난 뒤에는 스위치 자리가 '확인 중'이 아니라 읽지 못했다고 말한다", () => {
    openServiceWithFailedStatus();

    row("Tailscale 서비스").find(".backend-service-toggle-pending").should("not.exist");
    row("Tailscale 서비스").find(".backend-service-toggle-failed").should("have.text", "읽지 못함");
  });
});
