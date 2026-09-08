/// <reference types="cypress" />
// AM-174 · 애드온 화면 코덱스 탭의 "준비 중" 빈 상태 계약과 다국어 전환.
//
// CodexAddonCard(src/components/AddonsView.tsx:464)는 아직 기능이 없어 머리글과 빈 상태
// 안내만 두는 자리다. 기존 스펙은 이 카드를 부딪히기만 한다 —
// am20260907-subtab-keyboard-roving.cy.ts:48이 `be.visible`만 보고, 애드온 탭 저장값 스펙
// (am20260907-addons-tab-restore.cy.ts)은 활성 탭 판정에만 쓴다. 문구·구조·영어 전환은
// 아무도 보지 않는다.
//
// 여기서 새로 보는 것:
//   1) 기능이 없는 자리이므로 조작 가능한 버튼·입력이 하나도 없어야 한다. 여기에 무언가
//      생기면 "준비 중" 안내와 어긋나 눌러도 아무 일이 없는 자리가 된다.
//   2) 머리글 배지(CODEX)는 번역 대상이 아니고, 제목·설명·빈 상태 문구만 언어에 따라
//      바뀐다. 배지까지 번역되거나 문구가 한국어로 남으면 전환 계약이 깨진다.
//   3) 언어를 고르는 곳은 설정 화면이라 애드온에서 벗어난다. 되돌아왔을 때 탭 선택
//      저장값이 코덱스를 그대로 되살려야 한다.

/** 코덱스 탭을 열고 카드가 보일 때까지 기다린다. */
function openCodexTab() {
  cy.openView("addons").should("be.visible");
  cy.anchor("addons.tab.codex").click();
  cy.anchor("addons.tab.codex").should("have.class", "active");
  return cy.anchor("addons.codex-content").should("be.visible");
}

describe("코덱스 애드온 탭의 빈 상태와 다국어", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  // 영어로 바꾼 채 끝나는 케이스가 있어 반드시 되돌린다.
  after(() => {
    cy.restoreLanguage();
  });

  it("한국어 빈 상태가 계약 문구대로 나오고 조작할 요소가 없다", () => {
    cy.setLanguage("ko");
    openCodexTab().within(() => {
      cy.get(".plugin-page-title span").should("have.text", "CODEX");
      cy.get(".plugin-page-title h2").should("have.text", "Codex 애드온");
      cy.get(".plugin-page-header p").should("have.text", "Codex CLI에 붙는 부가 기능이 여기에 모입니다.");
      cy.get(".addon-empty-state strong").should("have.text", "준비 중입니다");
      cy.get(".addon-empty-state small").should(
        "have.text",
        "아직 등록된 Codex 애드온이 없습니다. Codex 플러그인·스킬 설정이 정해지면 이 자리에 들어옵니다.",
      );
      // 기능이 없는 자리이므로 누를 것도, 입력할 것도 없다.
      cy.get("button, input, select, textarea, a[href]").should("have.length", 0);
    });
  });

  it("영어로 바꾸면 제목·설명·빈 상태만 영어가 되고 CODEX 배지는 그대로다", () => {
    openCodexTab();
    // 언어 select는 설정 화면에만 있어 애드온에서 벗어난다. 돌아왔을 때 탭 선택
    // 저장값이 코덱스를 되살리는지까지 함께 본다.
    cy.setLanguage("en");
    cy.openView("addons").should("be.visible");

    cy.anchor("addons.tab.codex").should("have.class", "active");
    cy.anchor("addons.codex-content").should("be.visible").within(() => {
      cy.get(".plugin-page-title span").should("have.text", "CODEX");
      cy.get(".plugin-page-title h2").should("have.text", "Codex add-ons");
      cy.get(".plugin-page-header p").should("have.text", "Add-ons that attach to the Codex CLI will live here.");
      cy.get(".addon-empty-state strong").should("have.text", "Coming soon");
      cy.get(".addon-empty-state small").should(
        "have.text",
        "No Codex add-on is registered yet. Codex plugin and skill settings will appear here once defined.",
      );
    });
  });

  it("다른 탭을 거쳐 돌아와도 코덱스 카드만 남고 다른 탭 내용은 보이지 않는다", () => {
    cy.setLanguage("ko");
    openCodexTab();

    cy.anchor("addons.tab.claude").click();
    cy.anchor("addons.claude-plugins-content").should("be.visible");
    cy.anchor("addons.codex-content").should("not.be.visible");

    cy.anchor("addons.tab.codex").click();
    cy.anchor("addons.codex-content").should("be.visible");
    cy.anchor("addons.claude-plugins-content").should("not.be.visible");
    cy.anchor("addons.aia-content").should("not.be.visible");
    cy.anchor("addons.codex-content").find(".addon-empty-state strong").should("have.text", "준비 중입니다");
  });
});
