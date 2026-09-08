/// <reference types="cypress" />
// AM-129 · 설정 화면 중분류 탭(SettingsView.tsx:180 `tab`) 선택의 잔존 계약.
//
// 애드온 화면의 탭은 localStorage에 저장돼 새로고침을 건너 복원되지만(AM-116),
// 설정 화면의 탭은 지역 상태뿐이라 계약이 다르다. 여기서 보는 것은 그 경계다.
//   1) 화면을 다녀와도 탭이 유지되는가 — 화면은 계속 마운트되므로 유지돼야 한다.
//   2) 새로고침하면 어디로 열리는가 — 저장이 없으므로 첫 탭(CLI 설정)으로 돌아가고
//      애드온과 달리 저장 키가 남지 않아야 한다.
//   3) 사용자가 누르지 않고 안내로 끌려간 탭(topbar.aia → 시스템 에이전트 자리)도
//      같은 규칙을 지나는가 — 화면 전환은 견디고 새로고침에는 초기화돼야 한다.
// 기존 AM-28·AM-30·AM-116은 각각 폼 상태·테마 저장값·애드온 탭만 다뤘고 설정 탭
// 자체의 잔존은 처음이다.

const ADDONS_TAB_KEY = "agent-manager.addons-tab.v1";
const TAB_IDS = ["connections", "plugins", "service", "repository", "language", "display", "automation"] as const;

/** 설정 화면에서 정확히 한 탭만 활성인지 본다. */
function onlyTabActive(id: (typeof TAB_IDS)[number]): void {
  for (const candidate of TAB_IDS) {
    cy.anchor(`settings.tab.${candidate}`)
      .should("have.attr", "aria-selected", candidate === id ? "true" : "false");
  }
}

/** 설정 탭을 저장하는 localStorage 키가 생겼는지 본다(애드온과 달리 없어야 한다). */
function settingsTabKeys() {
  return cy.window().then((win) =>
    Object.keys(win.localStorage).filter((key) => key.includes("settings") && key.includes("tab")),
  );
}

describe("설정 화면 탭 선택의 화면 전환·새로고침 잔존 경계", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  it("고른 탭은 다른 화면을 다녀와도 유지된다", () => {
    cy.openSettingsTab("display");
    onlyTabActive("display");

    cy.revisitView("settings");
    onlyTabActive("display");
    // 탭 패널 내용까지 그 탭의 것이어야 한다.
    cy.get('[role="radiogroup"][aria-label="화면 테마"]').should("exist");
  });

  it("새로고침하면 CLI 설정 탭으로 돌아가고 탭 저장 키를 남기지 않는다", () => {
    cy.openSettingsTab("automation");
    onlyTabActive("automation");
    settingsTabKeys().should("have.length", 0);

    cy.reload();
    cy.openView("settings");
    onlyTabActive("connections");
    cy.anchor("settings.connections").should("be.visible");
    settingsTabKeys().should("have.length", 0);
  });

  it("안내로 끌려간 탭도 화면 전환은 견디고 새로고침에는 초기화된다", () => {
    // 격리 백엔드에는 시스템 에이전트가 없어 topbar.aia는 설정 → CLI 설정의
    // 시스템 에이전트 자리로 데려간다.
    cy.openSettingsTab("language");
    onlyTabActive("language");

    cy.anchor("topbar.aia").click();
    cy.view("settings").should("exist");
    onlyTabActive("connections");
    cy.anchor("settings.system-agent").should("exist");

    // 끌려간 탭도 마운트가 유지되는 동안에는 그대로다.
    cy.revisitView("settings");
    onlyTabActive("connections");

    // 애드온 탭과 달리 저장값이 생기지 않아 다음 방문의 기본은 그대로 CLI 설정이다.
    settingsTabKeys().should("have.length", 0);
    cy.window().then((win) => {
      expect(win.localStorage.getItem(ADDONS_TAB_KEY)).to.not.eq("settings");
    });
  });
});
