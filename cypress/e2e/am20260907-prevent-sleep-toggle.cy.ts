/// <reference types="cypress" />
// 백엔드 서비스 카드의 '절전 억제'는 호스트의 자동 절전을 caffeinate(macOS) 등으로 막아
// 원격 연결이 끊기지 않게 하는 토글이다.
// 기본값 꺼짐 → 토글 켬(성공 안내 및 caffeinate/자동 절전을 막고 있습니다 요약) →
// 새로고침 후 복원 → 다시 끔(원래 설정대로 되돌렸습니다 안내 및 꺼짐 요약)의 생명주기를 붙잡는다.
// 백엔드 설정에 남으므로 테스트 후 반드시 원래 기본값(꺼짐)으로 되돌린다.

const SLEEP_TOGGLE = '[role="switch"][aria-label="절전 억제"]';
const SLEEP_CONTAINER = '.backend-service-toggle:has([aria-label="절전 억제"])';

describe("백엔드 서비스 · 절전 억제 토글 라이프사이클", () => {
  after(() => {
    // 테스트 후 절전 억제 상태를 기본값(꺼짐)으로 복구
    cy.get("body").then(($body) => {
      const toggle = $body.find(SLEEP_TOGGLE);
      if (toggle.length > 0 && toggle.attr("aria-checked") === "true") {
        cy.wrap(toggle).click();
      }
    });
  });

  it("절전 억제 기본 꺼짐 상태에서 켜기, 새로고침 복원, 끄기 라이프사이클을 붙잡는다", () => {
    cy.visitApp();
    cy.openSettingsTab("service");

    // 1) 기본 상태 확인: 스위치는 꺼짐, 요약은 '꺼짐 · 호스트가 잠들면 원격 접속이 끊깁니다'
    cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "false").and("be.enabled");
    cy.get(SLEEP_CONTAINER).should("not.have.class", "enabled");
    cy.contains("꺼짐 · 호스트가 잠들면 원격 접속이 끊깁니다").should("be.visible");

    // 도움말 힌트 팝오버 확인
    cy.get('[aria-label="절전 억제 동작 설명"]').click();
    cy.contains("호스트가 자동으로 잠들지 않게 막습니다.").should("be.visible");
    cy.get("body").click(0, 0); // 팝오버 닫기

    // 2) 켜기 조작: 스위치 켬, enabled 클래스(강조), 성공 안내 및 요약 변경 확인
    cy.get(SLEEP_TOGGLE).click();
    cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(SLEEP_CONTAINER).should("have.class", "enabled");
    cy.contains("자동 절전을 막습니다").should("be.visible");
    cy.contains("자동 절전을 막고 있습니다").should("be.visible");

    // 3) 새로고침 후에도 백엔드 설정에서 불러와 켜진 상태가 복원된다
    cy.reload();
    cy.openSettingsTab("service");
    cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(SLEEP_CONTAINER).should("have.class", "enabled");
    cy.contains("자동 절전을 막고 있습니다").should("be.visible");

    // 4) 끄기 조작: 원래 설정대로 되돌림 안내 및 꺼짐 요약 복귀
    cy.get(SLEEP_TOGGLE).click();
    cy.get(SLEEP_TOGGLE).should("have.attr", "aria-checked", "false");
    cy.get(SLEEP_CONTAINER).should("not.have.class", "enabled");
    cy.contains("자동 절전을 원래 설정대로 되돌렸습니다").should("be.visible");
    cy.contains("꺼짐 · 호스트가 잠들면 원격 접속이 끊깁니다").should("be.visible");
  });
});
