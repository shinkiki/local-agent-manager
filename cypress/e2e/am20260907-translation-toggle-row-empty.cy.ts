/// <reference types="cypress" />
// AM-172
// 설정 → 언어·번역 탭의 번역 토글 네 행이 "시스템 에이전트 없음 + 번역 이력 없음"에서
// 어떤 모습인지 붙잡는다. 잠금 자체는 am20260906-system-agent-empty-readonly.cy.ts가 이미
// 보므로 여기서 새로 보는 것은 **잠금과 함께 사라져야 하는 것들**이다.
//
// 행 하나는 조건이 서로 다른 조각 넷으로 짜여 있다(src/components/SettingsView.tsx:2143~2160).
//  - 상태 문구: phase가 disabled면 진행 숫자 없이 소개 문장만 나온다(:2254 translationStatusText).
//    total이 0이므로 "· 항목 0/0" 같은 꼬리가 붙으면 아직 아무것도 안 했는데 진행처럼 읽힌다.
//  - "번역 초기화": status.total > 0일 때만 그린다. 지울 번역이 없는데 버튼이 있으면
//    잠긴 버튼을 눌러 보게 만들고, 잠금이 풀린 순간 사용량을 태우는 초기화가 열린다.
//  - "재시도": phase가 partial·error일 때만 그린다. 기본 상태에서는 재시도할 실행이 없다.
//  - enabled 클래스: 설정이 꺼져 있으면 붙지 않는다. readOnly는 설정을 보존만 하므로
//    잠금이 곧 "켜짐"으로 보이면 안 된다.
//
// 함께 보는 것은 안내문 분기(:2135)와 잠금 경계다. 번역 메뉴가 전부 꺼져 있으면 안내문은
// 사용량 경고가 아니라 "언어를 추가한 뒤 고르라"는 쪽이어야 하고, 언어 선택·언어 추가는
// 시스템 에이전트와 무관하므로 같은 화면에서 계속 열려 있어야 한다.

const MENUS = ["지침", "스킬", "에이전트", "아티팩트"];

function openLanguageTab(): void {
  cy.openSettingsTab("language");
  cy.get(".language-settings-section").should("be.visible");
  cy.get(".translation-toggle-list .translation-toggle-row").should("have.length", MENUS.length);
}

function rows() {
  return cy.get(".translation-toggle-list .translation-toggle-row");
}

describe("번역 이력이 없는 번역 토글 행", () => {
  beforeEach(() => {
    cy.visitApp();
    openLanguageTab();
  });

  it("네 행 모두 진행 숫자 없는 소개 문구만 내고 disabled 상태로 꺼져 있다", () => {
    MENUS.forEach((label, index) => {
      rows().eq(index).within(() => {
        cy.get(".translation-toggle-main > span > strong").should("have.text", label);
        // 소개 문장 그대로. 진행 꼬리(항목/캐시/요청)가 하나도 붙지 않아야 한다.
        cy.get(".translation-toggle-main > span > small")
          .should("have.text", "목록과 상세 내용을 자동번역합니다")
          .and("not.contain.text", "·");
      });
      rows().eq(index).should("have.class", "disabled").and("not.have.class", "enabled");
    });
  });

  it("지울 번역도 재시도할 실행도 없으므로 초기화·재시도 버튼을 아예 그리지 않는다", () => {
    rows().each(($row) => {
      cy.wrap($row).find(".translation-toggle-actions").within(() => {
        cy.contains("button", "번역 초기화").should("not.exist");
        cy.contains("button", "재시도").should("not.exist");
        // 남는 조작은 잠긴 스위치 하나뿐이다.
        cy.get("button").should("have.length", 1);
      });
      cy.wrap($row).find(".app-toggle")
        .should("be.disabled")
        .and("have.attr", "aria-checked", "false");
    });
    // 확인 패널은 버튼을 눌러야 열리므로 처음에는 어느 행에도 없다.
    cy.get(".translation-toggle-confirm").should("not.exist");
  });

  it("메뉴가 전부 꺼져 있어 안내문은 사용량 경고가 아니고, 언어 선택·언어 추가는 열려 있다", () => {
    cy.get(".translation-language-note")
      .should("have.text", "언어를 추가한 뒤 목록에서 선택할 수 있습니다.")
      .and("not.contain.text", "사용량");

    // 번역 실행 주체가 없어도 언어 자체를 고르고 늘리는 일은 막지 않는다.
    cy.languageSelect().should("be.enabled").and("have.value", "ko");
    cy.get(".translation-language-actions").contains("button", "언어 추가").should("be.enabled").click();
    cy.get(".translation-language-form").should("be.visible")
      .contains("button", "취소").click();
    cy.get(".translation-language-form").should("not.exist");

    // 다른 탭을 다녀와도 행 넷과 안내문 분기가 그대로다.
    cy.openSettingsTab("display");
    openLanguageTab();
    cy.get(".translation-language-note").should("have.text", "언어를 추가한 뒤 목록에서 선택할 수 있습니다.");
    rows().each(($row) => { cy.wrap($row).find(".app-toggle").should("be.disabled"); });
  });
});
