/// <reference types="cypress" />
// 설정 → 라이브러리의 저장소 경로 카드는 "바꿀 수 있는 칸 하나 + 참고용 읽기 전용 칸 셋"으로
// 되어 있다(SettingsView.tsx:423-470). settings.cy.ts는 이 앵커가 보이는지만 보고,
// ui-guide 스펙들은 같은 앵커를 화면안내 표적으로만 쓴다. 여기서는 아무것도 저장하지 않고
// 입력 경계와 잠금 짝만 본다 — 저장·복귀 버튼을 누르면 격리 백엔드의 임시 app-data라도
// 스킬·지침 원본을 옮기므로 누르지 않는다.
const CARD = ".settings-card:has([data-ui-anchor='settings.repository-path'])";
const APPLY = "적용";
const RESTORE = "기본 경로로 복귀";

describe("라이브러리 저장소 경로 카드의 잠금과 입력 경계", () => {
  const openCard = () => {
    cy.openSettingsTab("repository");
    cy.anchor("settings.repository-path").should("be.visible");
    cy.get(CARD).should("not.contain.text", "저장소 설정을 불러오는 중…");
  };

  it("앱 기본값 상태에서는 복귀 버튼이 잠기고 참고용 경로 칸은 읽기 전용이다", () => {
    cy.visitApp();
    openCard();

    // 사전조건: 격리 백엔드는 경로를 바꾼 적이 없어 '앱 기본값' 배지가 붙는다.
    cy.get(CARD).find(".skill-sync-pill").should("have.text", "앱 기본값");

    // 이미 기본값이므로 되돌릴 것이 없어 복귀 버튼만 잠긴다.
    cy.get(CARD).contains("button", RESTORE).should("be.disabled");
    cy.get(CARD).contains("button", APPLY).should("be.enabled");

    // 기본 경로·하위 경로는 보여주기만 하는 칸이라 readOnly다.
    cy.get("#resource-repository-default-path").should("have.attr", "readonly");
    cy.get(CARD).find(".path-field-group input").should("have.length", 2).each(($input) => {
      cy.wrap($input).should("have.attr", "readonly");
    });

    // 바꿀 수 있는 칸은 저장소 경로 하나뿐이고, 기본 경로와 같은 값으로 시작한다.
    cy.get("#resource-repository-path").should("not.have.attr", "readonly");
    cy.get("#resource-repository-default-path").invoke("val").then((defaultPath) => {
      cy.get("#resource-repository-path").should("have.value", defaultPath as string);
    });
  });

  it("경로를 비우거나 공백만 남기면 적용이 잠기고, 값을 되돌리면 다시 풀린다", () => {
    cy.visitApp();
    openCard();

    cy.get("#resource-repository-path").invoke("val").then((original) => {
      // 경계 1) 빈 문자열
      cy.get("#resource-repository-path").clear();
      cy.get(CARD).contains("button", APPLY).should("be.disabled");

      // 경계 2) 공백만 — trim 후 저장하므로 빈 값과 같이 잠겨야 한다.
      cy.get("#resource-repository-path").type("   ");
      cy.get("#resource-repository-path").should("have.value", "   ");
      cy.get(CARD).contains("button", APPLY).should("be.disabled");

      // 한 글자만 있어도 잠금은 풀린다(경로 유효성은 저장 시점에 백엔드가 본다).
      cy.get("#resource-repository-path").clear();
      cy.get("#resource-repository-path").type("/");
      cy.get(CARD).contains("button", APPLY).should("be.enabled");

      // 원래 값으로 되돌려도 저장 버튼은 잠기지 않는다(변경 없음을 따로 보지 않는 현행 동작).
      cy.get("#resource-repository-path").clear();
      cy.get("#resource-repository-path").type(original as string);
      cy.get(CARD).contains("button", APPLY).should("be.enabled");
    });
  });

  it("저장하지 않은 편집은 화면을 다녀와도 남고 새로고침해야 사라진다", () => {
    cy.visitApp();
    openCard();

    cy.get("#resource-repository-path").invoke("val").then((original) => {
      cy.get("#resource-repository-path").clear();
      cy.get("#resource-repository-path").type("/tmp/am-qa-not-saved");
      cy.get(CARD).find(".check-filter input[type=checkbox]").uncheck();

      cy.revisitView("settings");
      openCard();

      // 현행 동작: 설정 화면은 다녀와도 다시 마운트되지 않아 저장하지 않은 편집이 그대로
      // 남는다. 배지는 저장된 상태(앱 기본값)를 가리키므로 칸의 값과 배지가 어긋난 채로 보인다.
      cy.get("#resource-repository-path").should("have.value", "/tmp/am-qa-not-saved");
      cy.get(CARD).find(".skill-sync-pill").should("have.text", "앱 기본값");
      cy.get(CARD).find(".check-filter input[type=checkbox]").should("not.be.checked");

      // 새로고침은 마운트를 다시 하므로 저장된 값으로 돌아간다.
      cy.visitApp();
      openCard();
      cy.get("#resource-repository-path").should("have.value", original as string);
      cy.get(CARD).find(".check-filter input[type=checkbox]").should("be.checked");
    });
  });
});
