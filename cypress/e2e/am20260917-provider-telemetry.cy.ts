// C13. 설정 → CLI 설정 탭에 선 공급자 수집 설정 카드. 격리 환경의 임시 HOME에는 어떤
// 공급자 설정 파일도 없으므로, 이 시나리오가 보는 것은 "미설정 = 공급자 기본값" 표시와
// 토글을 눌렀을 때 파일이 실제로 만들어지며 상태가 뒤집히는 왕복이다. 학습 동의와 다르다는
// 안내(C13-8)와 Antigravity에는 해당 설정이 없다는 문구(C13-9)도 함께 못박는다.
describe("CLI 설정 사용정보 수집", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openSettingsTab("connections");
  });

  it("설정 파일이 없는 환경에서 전부 미설정으로 보이고 학습 동의와 구분해 알린다", () => {
    // 카드는 CLI 설정 탭 아래쪽에 있어 처음에는 스크롤 밖이다.
    cy.anchor("settings.telemetry").scrollIntoView().should("be.visible").within(() => {
      cy.contains("사용정보 수집").should("be.visible");
      cy.get(".telemetry-provider", { timeout: 20000 }).should("have.length", 3);

      // 세 공급자 일곱 항목이 모두 "미설정"으로 선다. 파일이 없으면 공급자 기본값을 따른다.
      cy.get(".telemetry-option").should("have.length", 7);
      cy.get(".telemetry-option-state em").each((state) => {
        expect(state.text()).to.equal("미설정 · 공급자 기본값");
      });
      cy.get(".telemetry-option [role=switch]").should("have.attr", "aria-checked", "false");

      // 파일에 무엇이 적히는지 화면이 감추지 않는다. 카드가 길어 아래쪽 항목은 스크롤
      // 밖이므로 보이는지가 아니라 적혀 있는지를 본다.
      cy.contains("code", 'env.DISABLE_TELEMETRY = "1"').should("exist");
      cy.contains("code", '[otel] exporter = "none"').should("exist");
      cy.contains("code", "privacy.usageStatisticsEnabled = false").should("exist");

      // C13-9. 빠뜨린 것이 아니라 그 CLI에 설정이 없다는 것을 적는다.
      cy.get(".telemetry-settings-absent").should("contain.text", "Antigravity CLI에는");
      cy.get(".error-banner").should("not.exist");
    });

    // C13-8. 학습 동의와 다르다는 설명은 카드 머리의 물음표 안에 있다.
    cy.anchor("settings.telemetry").find("header .help-hint button").click();
    cy.contains("모델 학습 동의와는 다릅니다").should("be.visible");
    cy.contains("공급자 계정과 조직 정책이 정하며").should("be.visible");
  });

  it("토글을 켜면 보내지 않음으로 바뀌고 다시 끄면 미설정으로 돌아온다", () => {
    cy.anchor("settings.telemetry").scrollIntoView().within(() => {
      cy.get(".telemetry-provider", { timeout: 20000 }).should("have.length", 3);

      cy.get(".telemetry-option").first().as("row");
      cy.get("@row").find("[role=switch]").click();
      cy.get("@row").find(".telemetry-option-state em").should("have.text", "보내지 않음");
      cy.get("@row").find("[role=switch]").should("have.attr", "aria-checked", "true");

      // 되돌리면 반대값을 적는 것이 아니라 키를 지우므로 다시 "미설정"이다(C13-3).
      cy.get("@row").find("[role=switch]").click();
      cy.get("@row").find(".telemetry-option-state em").should("have.text", "미설정 · 공급자 기본값");
      cy.get(".error-banner").should("not.exist");
    });
  });
});
