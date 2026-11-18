/// <reference types="cypress" />
// AM-39는 도움말 팝오버의 열고닫기 계약만 봤고, "열린 팝오버가 끝까지 보이는가"는 어느
// 시나리오에도 없었다. 설정 → 연결 탭의 마지막 줄인 "AIA 대화 기록" 도움말은 감싼
// .settings-card가 overflow: hidden이라 카드 밖으로 나간 문장이 통째로 잘려 있었다.
// 팝오버를 body로 내보내 뷰포트 기준으로 배치한 뒤의 회귀 경계를 여기서 잡는다.

function stubCodexSystemAgent(): void {
  cy.stubInvoke("get_system_automation_snapshot", (request) => {
    request.continue((response) => {
      response.body.settings.systemProvider = "codex";
    });
  });
}

const aiaRecordingHint = () => cy
  .contains(".system-setting-group", "AIA 대화 기록")
  .find(".help-hint-trigger");
const popover = () => cy.get(".help-hint-popover");

describe("도움말 팝오버가 카드 경계에 잘리지 않는다", () => {
  beforeEach(() => {
    stubCodexSystemAgent();
    cy.visitApp();
    cy.openSettingsTab("aia");
    cy.contains(".system-setting-group", "AIA 대화 기록").scrollIntoView().should("be.visible");
  });

  it("카드 맨 아래 도움말도 body에 붙어 카드 바깥으로 펼쳐진다", () => {
    aiaRecordingHint().click();
    // 카드 안에 남아 있으면 overflow: hidden이 다시 자른다. 부모가 body여야 한다.
    popover().should("have.length", 1).parent().should("match", "body");
  });

  it("설명 전문이 잘리지 않고 화면 안에 들어온다", () => {
    aiaRecordingHint().click();
    // 카드가 자르면 Cypress가 "부모의 overflow에 잘렸다"며 보이지 않는 것으로 센다.
    popover().find("small").should("be.visible").and("contain.text", "Codex 시스템 에이전트에만 해당합니다");
    popover().then(($popover) => {
      const element = $popover[0];
      const box = element.getBoundingClientRect();
      // 스크롤 막대가 생겼다면 max-height가 문장을 잘라 낸 것이다.
      expect(element.scrollHeight, "세로 스크롤 없이 전문이 들어간다").to.be.at.most(element.clientHeight);
      expect(box.height, "제목 한 줄로 접히지 않는다").to.be.greaterThan(60);
      expect(box.top, "위쪽이 화면 밖으로 나가지 않는다").to.be.at.least(0);
      expect(box.left, "왼쪽이 화면 밖으로 나가지 않는다").to.be.at.least(0);
      expect(box.bottom, "아래쪽이 화면 밖으로 나가지 않는다").to.be.at.most(Cypress.config("viewportHeight"));
      expect(box.right, "오른쪽이 화면 밖으로 나가지 않는다").to.be.at.most(Cypress.config("viewportWidth"));
    });
  });

  it("트리거 바로 아래에 붙어 어느 도움말인지 알 수 있다", () => {
    aiaRecordingHint().click();
    aiaRecordingHint().then(($trigger) => {
      const anchor = $trigger[0].getBoundingClientRect();
      popover().then(($popover) => {
        const box = $popover[0].getBoundingClientRect();
        // 아래로 열리든 위로 뒤집히든 트리거와 세로로 맞닿아 있어야 한다.
        const attached = Math.abs(box.top - anchor.bottom) < 24 || Math.abs(anchor.top - box.bottom) < 24;
        expect(attached, "트리거와 세로로 이어져 있다").to.equal(true);
      });
    });
  });
});
