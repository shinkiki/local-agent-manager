/// <reference types="cypress" />
/**
 * 설정 → 자동화(settings.tab.automation)의 Cypress 자동화 작업공간(settings.cypress) 패널.
 * "AIA가 Cypress 자동화를 실행할 수 있음" 토글(role="switch")의 기본 상태(꺼짐),
 * 켜기 조작 및 백엔드 설정 반영, 껐을 때 하단 실행 구역의 안내 문구 노출
 * ("위 토글이 꺼져 있어도 여기서 직접 실행은 할 수 있습니다."),
 * 새로고침 후 복원, 다시 끄기 조작 라이프사이클을 검증한다.
 *
 * 축: 설정 (Cypress 자동화)
 * 조건: 스위치 조작, 연동 안내 문구 노출/숨김, 새로고침 후 잔존 및 복원.
 */

const TOGGLE = '[data-ui-anchor="settings.cypress"] [role="switch"][aria-label="AIA가 Cypress 자동화를 실행할 수 있음"]';
const MANUAL_RUN_NOTE = "위 토글이 꺼져 있어도 여기서 직접 실행은 할 수 있습니다.";

describe("Cypress 작업공간 AIA 자동화 실행 스위치 라이프사이클과 수동 실행 안내", () => {
  const openAutomation = () => {
    cy.visitApp();
    cy.openSettingsTab("automation");
    cy.anchor("settings.cypress").should("be.visible");
    cy.get(".cypress-panel").should("not.contain.text", "작업공간을 불러오는 중…");
  };

  afterEach(() => {
    // 실패 뒤 재시도도 같은 백엔드 설정을 이어받으므로 매 시도 끝에서 기본값(꺼짐)으로 복구
    cy.get("body").then(($body) => {
      const toggle = $body.find(TOGGLE);
      if (toggle.length > 0 && toggle.attr("aria-checked") === "true") {
        cy.wrap(toggle).click({ force: true });
      }
    });
  });

  it("AIA 실행 허용 스위치는 기본 꺼짐이며 켜면 수동 안내가 사라지고 새로고침 후에도 유지되며 다시 끄면 안내가 복원된다", () => {
    openAutomation();

    // 1) 초기 상태: 격리 환경에서 AIA Cypress 실행 스위치는 기본 꺼짐(false)이고 수동 실행 안내가 보임
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false").and("be.enabled");
    cy.get(".cypress-panel").should("contain.text", MANUAL_RUN_NOTE);

    // 2) 켜기 조작: 스위치가 켜지고(true), 실행 구역에서 수동 실행 안내가 사라짐
    cy.get(TOGGLE).click({ force: true });
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(".cypress-panel").should("not.contain.text", MANUAL_RUN_NOTE);

    // 3) 새로고침 후 복원 확인: 백엔드에 저장되어 새로고침 후에도 켜진 상태가 유지됨
    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSettingsTab("automation");
    cy.anchor("settings.cypress").should("be.visible");
    cy.get(".cypress-panel").should("not.contain.text", "작업공간을 불러오는 중…");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(".cypress-panel").should("not.contain.text", MANUAL_RUN_NOTE);

    // 4) 다시 끄기 조작: 스위치가 꺼지고(false), 수동 실행 안내가 다시 나타남
    cy.get(TOGGLE).click({ force: true });
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.get(".cypress-panel").should("contain.text", MANUAL_RUN_NOTE);

    // 5) 다시 새로고침 후 복원 확인: 꺼진 상태가 정상 유지됨
    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSettingsTab("automation");
    cy.anchor("settings.cypress").should("be.visible");
    cy.get(".cypress-panel").should("not.contain.text", "작업공간을 불러오는 중…");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.get(".cypress-panel").should("contain.text", MANUAL_RUN_NOTE);
  });
});
