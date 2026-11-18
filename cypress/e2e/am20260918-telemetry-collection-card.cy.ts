/**
 * 설정 → CLI 설정 → **사용정보 수집** 카드가 공급자별 수집 설정을 읽어 세우는지.
 *
 * 직전 커밋 734e7b08이 `crates/agent-manager-core/src/provider_telemetry.rs`의
 * 읽기 한 함수를 자리별 네 갈래로 갈랐다. 그 결과가 그대로 서는 화면이 이 카드다
 * (`src/components/TelemetrySettingsCard.tsx:61`, `SettingsView.tsx:1928`).
 *
 * 스텁을 두지 않고 격리 백엔드의 실제 응답을 본다 — 임시 HOME에는 공급자 CLI 설정
 * 파일이 없으므로, 파일이 없는 자리를 '아직 없음'으로 구분해 세우는지까지 함께
 * 확인할 수 있다. 로딩 문구(`TelemetrySettingsCard.tsx:82`)는 스냅숏이 오면
 * 사라져야 하고, Antigravity 부재 안내(`:92`)는 스냅숏을 받은 뒤에만 선다.
 *
 * 축은 설정, 조건은 빈 상태와 화면 전환 후 잔존이다.
 */
describe("CLI 설정 사용정보 수집 카드", () => {
  const card = () => cy.anchor("settings.telemetry");

  beforeEach(() => {
    cy.visitApp();
    cy.openView("settings");
    cy.anchor("settings.tab.connections").should("have.class", "active");
  });

  it("스냅숏을 받아 공급자별 블록을 세우고 로딩 문구를 걷는다", () => {
    card().should("exist");
    card().find(".telemetry-provider").should("have.length.at.least", 1);
    card().find(".telemetry-settings-loading").should("not.exist");
    card().find(".error-banner").should("not.exist");
    // 부재 안내는 스냅숏이 온 뒤에만 서는 자리다.
    card().find(".telemetry-settings-absent").should("contain.text", "Antigravity");
  });

  it("임시 HOME에 없는 설정 파일은 경로 뒤에 '아직 없음'으로 구분한다", () => {
    card().find(".telemetry-provider").first().find(".telemetry-provider-copy small")
      .should("contain.text", "아직 없음");
  });

  it("다른 중메뉴를 들렀다 돌아와도 로딩 문구에 머무르지 않고 같은 항목을 다시 세운다", () => {
    card().find(".telemetry-provider").then(($before) => {
      const count = $before.length;
      cy.anchor("settings.tab.language").click();
      card().should("not.exist");
      cy.anchor("settings.tab.connections").click();
      card().find(".telemetry-settings-loading").should("not.exist");
      card().find(".error-banner").should("not.exist");
      card().find(".telemetry-provider").should("have.length", count);
    });
  });
});
