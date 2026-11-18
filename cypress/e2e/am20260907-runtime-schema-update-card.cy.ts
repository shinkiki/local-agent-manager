/// <reference types="cypress" />
/**
 * 설정 → 연결 탭의 '채팅 실행설정 스키마' 카드(SettingsView.tsx:523,641)는 어느 스펙도
 * 잡은 적이 없다. 이 카드는 두 계약을 한 자리에 겹쳐 둔다.
 *
 *  1) 시스템 에이전트(AIA)가 없으면 재조사·되돌리기 요청 두 개가 모두 잠기고, 잠긴
 *     이유를 title과 카드 아래 안내문으로 알린다(권한·접근 통제).
 *  2) '자동 재조사' 체크박스는 호스트 설정(catalogAutoDiscovery)이라 낙관적으로 화면을
 *     먼저 바꾸고 백엔드에 쓴다(SettingsView.tsx:632). 그래서 새로고침 후 잔존이
 *     실제로 저장됐는지를 가리는 유일한 증거다.
 *
 * 격리 백엔드에는 시스템 에이전트가 비어 있어 1)의 잠긴 쪽이 기본 상태로 관찰된다.
 * 실제 AIA 재조사 요청 자체는 이 하네스로 확인할 수 없다.
 * 체크박스는 백엔드 설정에 남으므로 끝에 기본값(켬)으로 되돌린다.
 */
const CARD = ".settings-update-card";
const AUTO_TOGGLE = `${CARD} .settings-update-toggle input[type="checkbox"]`;

const openCard = () => {
  cy.openSettingsTab("connections");
  // 카드는 연결 탭 아래쪽에 있어 스크롤 전에는 부모의 overflow에 잘려 있다.
  cy.get(CARD).should("exist").scrollIntoView();
};

describe("채팅 실행설정 스키마 카드 · AIA 미선택 잠금과 자동 재조사 저장", () => {
  after(() => {
    cy.get("body").then(($body) => {
      const box = $body.find(AUTO_TOGGLE);
      if (box.length > 0 && !(box[0] as HTMLInputElement).checked) cy.wrap(box).click();
    });
  });

  it("시스템 에이전트가 없으면 재조사·되돌리기가 모두 잠기고 잠긴 이유를 알린다", () => {
    cy.visitApp();
    openCard();

    cy.get(CARD).find("h2").should("have.text", "채팅 실행설정 스키마");
    cy.get(CARD).contains("strong", "마지막 조사").should("exist");
    cy.get(CARD).contains("strong", "모델·추론 카탈로그").should("exist");

    cy.get(CARD).contains("button", "AIA 재검토")
      .should("be.disabled")
      .and("have.attr", "title", "시스템 설정에서 시스템 에이전트를 선택하세요");
    cy.get(CARD).contains("button", "제안 되돌리기").should("be.disabled");
    cy.get(CARD).contains("시스템 에이전트를 선택하면 재조사를 요청할 수 있습니다.").should("exist");
    // 잠긴 상태는 오류가 아니다 — 오류 배너까지 함께 뜨면 안 된다.
    cy.get(CARD).find(".error-banner").should("not.exist");
  });

  it("잠긴 재조사 버튼을 눌러도 상태 문구가 '요청 중…'으로 넘어가지 않는다", () => {
    cy.visitApp();
    openCard();
    cy.get(CARD).contains("button", "AIA 재검토").click({ force: true });
    cy.get(CARD).contains("button", "AIA 재검토").should("exist");
    cy.get(CARD).should("not.contain.text", "요청 중…");
    cy.get(CARD).should("not.contain.text", "다시 살펴보는 중");
  });

  it("자동 재조사 체크박스는 기본 켬이고, 끈 값이 새로고침 후에도 남는다", () => {
    cy.visitApp();
    openCard();

    cy.get(AUTO_TOGGLE).should("be.enabled").and("be.checked");
    cy.get(CARD).contains("CLI가 업데이트되면 AIA에게 모델·추론 재조사를 자동으로 요청").should("exist");

    cy.get(AUTO_TOGGLE).uncheck();
    cy.get(AUTO_TOGGLE).should("not.be.checked");
    cy.get(CARD).find(".error-banner").should("not.exist");

    cy.reload();
    openCard();
    cy.get(AUTO_TOGGLE).should("not.be.checked");

    cy.get(AUTO_TOGGLE).check();
    cy.get(AUTO_TOGGLE).should("be.checked");
    cy.reload();
    openCard();
    cy.get(AUTO_TOGGLE).should("be.checked");
  });

  it("영어로 바꾸면 카드 제목·설명·잠금 안내가 함께 영문으로 바뀐다", () => {
    cy.visitApp();
    openCard();
    // setLanguage는 언어 탭으로 옮겨 가므로 연결 탭을 다시 열어야 카드가 붙는다.
    cy.setLanguage("en");
    openCard();

    cy.get(CARD).find("h2").should("have.text", "Chat runtime settings schema");
    cy.get(CARD).contains("strong", "Last inspected").should("exist");
    cy.get(CARD).contains("strong", "Model and reasoning catalog").should("exist");
    cy.get(CARD).contains("button", "Re-check with AIA")
      .should("be.disabled")
      .and("have.attr", "title", "Select a system agent in system settings");
    cy.get(CARD).contains("Select a system agent to request a re-check.").should("exist");
    cy.get(CARD).contains("Ask AIA to re-check models and reasoning automatically after a CLI update").should("exist");

    cy.restoreLanguage();
    openCard();
    cy.get(CARD).find("h2").should("have.text", "채팅 실행설정 스키마");
  });
});
