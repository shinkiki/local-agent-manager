// 개발 중인 화면(애드온)은 저장값이 없는 첫 실행에서 주 메뉴에 나오지 않고, 설정 → 화면의
// 메인 메뉴 편집기에는 '준비중' 태그가 붙은 채 숨김 상태로 남아 사용자가 직접 켤 수 있어야
// 한다. 하네스의 visitApp은 화면 스펙을 위해 모든 메뉴를 보이게 심으므로, 여기서는 그 키에
// 빈 문자열을 심어 저장값 없음으로 되돌린다.
import { NAVIGATION_PREFERENCES_KEY } from "../support/e2e";

const LEGACY_KEY = "agent-manager.navigation-preferences.v1";

function addonsPreferenceRow() {
  return cy.contains(".navigation-preference-row strong", "애드온").closest(".navigation-preference-row");
}

describe("준비중 메뉴의 기본 숨김과 태그", () => {
  it("저장값이 없으면 애드온이 메뉴에서 숨겨지고 편집기에서 준비중 태그와 함께 켤 수 있다", () => {
    cy.visitApp({ [NAVIGATION_PREFERENCES_KEY]: "" });
    cy.anchor("nav.dashboard").should("be.visible");
    cy.anchor("nav.addons").should("not.exist");

    cy.openSettingsTab("display");
    addonsPreferenceRow().should("have.class", "hidden-menu").within(() => {
      cy.get("strong .nav-preview-tag").should("have.text", "준비중");
      cy.get(".navigation-visibility-toggle").should("have.attr", "aria-pressed", "false").click();
    });

    // 켜면 사이드바에도 태그가 함께 붙고, 화면이 열린다.
    cy.anchor("nav.addons").should("be.visible");
    cy.anchor("nav.addons.preview").should("have.text", "준비중");
    cy.openView("addons").should("be.visible");
    cy.screenshot("preview-menu-tag");
  });

  it("준비중 화면이 생기기 전 v1 저장값은 애드온을 숨긴 채 v2로 넘어간다", () => {
    cy.visitApp({
      [NAVIGATION_PREFERENCES_KEY]: "",
      [LEGACY_KEY]: JSON.stringify({ order: ["chat", "dashboard"], hidden: ["docs"] }),
    });
    cy.anchor("nav.chat").should("be.visible");
    cy.anchor("nav.docs").should("not.exist");
    cy.anchor("nav.addons").should("not.exist");
    cy.window().should((win) => {
      const stored = JSON.parse(win.localStorage.getItem(NAVIGATION_PREFERENCES_KEY) || "null");
      expect(stored.hidden).to.include.members(["docs", "addons"]);
      expect(stored.order.slice(0, 2)).to.deep.equal(["chat", "dashboard"]);
    });
  });
});
