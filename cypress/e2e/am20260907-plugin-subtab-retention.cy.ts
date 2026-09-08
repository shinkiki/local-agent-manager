/// <reference types="cypress" />
// 설정 → 플러그인 중메뉴(`PluginSettingsView.tsx:22` `section`) 선택의 잔존 계약.
//
// 중메뉴 부품 자체는 AM-131(키보드 로빙)이 다뤘고, 상위 설정 탭의 잔존은 AM-129가,
// 애드온 중메뉴의 저장값 복원은 AM-116이 다뤘다. 아직 아무도 보지 않은 것은
// "플러그인 중메뉴가 어디까지 살아남는가"다. 이 자리는 저장값이 없는 세션 상태이고
// (SettingsView의 `pluginSection`), 뷰 자체는 상위가 `tab === "plugins"`일 때만 그려진다.
//   1) 메인 화면을 다녀오는 동안 설정 화면은 마운트된 채라 중메뉴도 살아남는다.
//   2) 다른 설정 탭으로 갔다 와도 남는다 — 선택은 SettingsView가 들고 있어(QA #46 조치)
//      PluginSettingsView가 언마운트돼도 되감기지 않는다. 상위 설정 탭(AM-129)과 같은 계약.
//   3) 새로고침은 상위 설정 탭부터 CLI로 돌아가므로 중메뉴도 처음부터 다시 시작한다.
// 감춰진 패널은 `hidden`으로만 가려지고 DOM에는 남는다(`SettingsSubTabs.tsx:88`).
// 그래서 "보이지 않는다"는 존재 여부가 아니라 가시성으로 봐야 한다.

const SECTIONS = ["external", "ssh"] as const;
const TAB_ANCHOR = { external: "settings.plugins", ssh: "settings.ssh-keys" } as const;
const CARD_ANCHOR = { external: "settings.external-plugins-content", ssh: "settings.ssh-keys-content" } as const;

/** 중메뉴에서 정확히 한 갈래만 선택되고 그 패널·카드만 보이는지 본다. */
function onlySectionActive(id: (typeof SECTIONS)[number]): void {
  for (const candidate of SECTIONS) {
    const on = candidate === id;
    cy.anchor(TAB_ANCHOR[candidate])
      .should("have.attr", "aria-selected", on ? "true" : "false")
      .and(on ? "have.class" : "not.have.class", "active");
    // 패널은 감춰져도 DOM에 남으므로 존재가 아니라 가시성으로 가른다.
    cy.get(`#plugin-panel-${candidate}`).should(on ? "not.have.attr" : "have.attr", "hidden");
    cy.anchor(CARD_ANCHOR[candidate]).should(on ? "be.visible" : "not.be.visible");
  }
}

describe("설정 → 플러그인 중메뉴 선택의 잔존 경계", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openSettingsTab("plugins");
  });

  it("플러그인 탭은 외부 MCP로 열리고, 감춘 SSH 패널도 aria로 이어진 채 DOM에 남는다", () => {
    onlySectionActive("external");
    cy.anchor(TAB_ANCHOR.external)
      .should("have.attr", "aria-controls", "plugin-panel-external")
      .and("have.attr", "id", "plugin-tab-external");
    cy.get("#plugin-panel-ssh")
      .should("have.attr", "role", "tabpanel")
      .and("have.attr", "aria-labelledby", "plugin-tab-ssh");
    cy.get("nav.settings-subtab-nav").should("have.attr", "aria-label", "플러그인 종류");
  });

  it("SSH를 고르면 두 패널의 가시성이 함께 뒤집힌다", () => {
    cy.anchor(TAB_ANCHOR.ssh).click();
    onlySectionActive("ssh");
    cy.anchor(CARD_ANCHOR.ssh).should("contain.text", "SSH 인증키");
  });

  it("메인 화면을 다녀와도 고른 SSH가 그대로 남는다", () => {
    cy.anchor(TAB_ANCHOR.ssh).click();
    onlySectionActive("ssh");
    cy.revisitView("settings");
    cy.anchor("settings.tab.plugins").should("have.class", "active");
    onlySectionActive("ssh");
  });

  it("다른 설정 탭을 다녀와도 고른 SSH가 그대로 남는다 (QA #46)", () => {
    cy.anchor(TAB_ANCHOR.ssh).click();
    onlySectionActive("ssh");
    cy.anchor("settings.tab.display").click();
    cy.get(".display-settings-card").should("be.visible");
    cy.anchor("settings.tab.plugins").click().should("have.class", "active");
    // 선택은 SettingsView가 들고 있어 PluginSettingsView가 다시 마운트돼도 되감기지 않는다.
    onlySectionActive("ssh");
  });

  it("새로고침하면 설정 탭부터 CLI로 돌아가고 중메뉴 선택도 저장되지 않는다", () => {
    cy.anchor(TAB_ANCHOR.ssh).click();
    onlySectionActive("ssh");
    cy.reload();
    cy.openView("settings");
    cy.anchor("settings.tab.connections").should("have.class", "active");
    cy.window().then((win) =>
      expect(Object.keys(win.localStorage).filter((key) => key.includes("plugin"))).to.deep.equal([]),
    );
    cy.anchor("settings.tab.plugins").click();
    onlySectionActive("external");
  });
});
