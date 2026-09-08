/// <reference types="cypress" />
// AM-116 · 애드온 화면의 탭 선택 저장값 복원 계약.
// 애드온 화면의 탭 선택 저장값(`agent-manager.addons-tab.v1`) 복원 계약.
//
// 기존 addons.cy.ts는 "클로드 탭을 누르고 새로고침하면 클로드가 남는다"까지만 본다.
// 여기서 새로 보는 것은 저장값이 정상이 아닐 때와, 사용자가 탭을 누르지 않고 화면 안내로
// 끌려갔을 때다.
//   1) loadAddonsTab(src/components/AddonsView.tsx:19)은 저장값이 세 탭 id가 아니면 "aia"로
//      떨어진다. 알 수 없는 값·빈 문자열·대소문자가 다른 값이 모두 여기로 온다. 이 갈래가
//      깨지면 저장값 하나가 애드온 화면을 빈 판으로 만든다 — 어느 패널도 active가 아니게 된다.
//   2) 떨어진 뒤에는 저장 효과(:45)가 정정된 값을 다시 적어야 한다. 정정하지 않으면 쓰레기
//      값이 계속 남아 매번 같은 복구를 반복한다.
//   3) 화면 안내(showUiGuide)가 여는 탭은 tabRequest 경유라 사용자가 누른 것이 아니다.
//      그래도 같은 저장 효과를 지나므로 저장값이 갱신되고 다음 방문에 그 탭으로 열린다.
const TAB_KEY = "agent-manager.addons-tab.v1";

function storedTab() {
  return cy.window().then((win) => win.localStorage.getItem(TAB_KEY));
}

/** 애드온 화면에서 정확히 한 탭만 활성이고 그 패널만 보이는지 본다. */
function onlyTabActive(id: "aia" | "claude" | "codex"): void {
  for (const candidate of ["aia", "claude", "codex"] as const) {
    cy.anchor(`addons.tab.${candidate}`).should(candidate === id ? "have.class" : "not.have.class", "active");
  }
  cy.anchor(id === "claude" ? "addons.claude-plugins-content" : `addons.${id}-content`).should("be.visible");
}

describe("애드온 탭 저장값의 복원과 정정", () => {
  it("알 수 없는 저장값으로 열면 아이아 탭으로 떨어지고 저장값도 정정된다", () => {
    cy.visitApp({ [TAB_KEY]: "notion" });
    cy.openView("addons").should("be.visible");

    onlyTabActive("aia");
    storedTab().should("eq", "aia");
  });

  it("빈 문자열과 대소문자가 다른 값도 아이아로 떨어진다", () => {
    cy.visitApp({ [TAB_KEY]: "" });
    cy.openView("addons").should("be.visible");
    onlyTabActive("aia");

    cy.visitApp({ [TAB_KEY]: "CODEX" });
    cy.openView("addons").should("be.visible");
    onlyTabActive("aia");
    storedTab().should("eq", "aia");
  });

  it("화면 안내가 연 탭도 저장값으로 남아 다음 방문에 그대로 열린다", () => {
    cy.visitApp({ [TAB_KEY]: "aia" });
    cy.openView("dashboard").should("be.visible");

    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "addons.claude", element: null, note: "여기" }))
      .should("eq", true);
    cy.view("addons").should("exist");
    onlyTabActive("claude");
    storedTab().should("eq", "claude");

    // 저장값만 남기고 다시 들어오면, 안내 없이도 같은 탭에서 이어 간다.
    cy.reload();
    cy.view("addons").should("be.visible");
    onlyTabActive("claude");
  });
});
