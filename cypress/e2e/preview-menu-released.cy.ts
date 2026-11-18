// 애드온은 준비중 화면이 아니다. 저장값이 없는 첫 실행에서 주 메뉴에 그대로 나오고, 설정 →
// 화면의 메인 메뉴 편집기에도 '준비중' 태그가 붙지 않아야 한다. 하네스의 visitApp은 화면
// 스펙을 위해 모든 메뉴를 보이게 심으므로, 여기서는 그 키에 빈 문자열을 심어 저장값 없음으로
// 되돌린 뒤 앱의 기본값을 본다.
//
// 두 번째 갈래가 이 스펙의 핵심이다. 애드온이 준비중이던 때 저장값(v2)의 hidden에는 사용자가
// 정하지 않아도 애드온이 들어 있었다. 그 흔적을 걷어내지 않으면 그 시절에 앱을 켜 본 기기에서는
// 준비중이 풀린 뒤에도 메뉴가 영구히 보이지 않는다.
import { NAVIGATION_PREFERENCES_KEY } from "../support/e2e";

const V1_KEY = "agent-manager.navigation-preferences.v1";
const V2_KEY = "agent-manager.navigation-preferences.v2";

function addonsPreferenceRow() {
  return cy.contains(".navigation-preference-row strong", "애드온").closest(".navigation-preference-row");
}

describe("준비중이 풀린 애드온 메뉴", () => {
  it("저장값이 없으면 애드온이 메뉴에 그대로 보이고 준비중 태그가 없다", () => {
    cy.visitApp({ [NAVIGATION_PREFERENCES_KEY]: "" });
    cy.anchor("nav.dashboard").should("be.visible");
    cy.anchor("nav.addons").should("be.visible");
    cy.anchor("nav.addons.preview").should("not.exist");

    cy.openSettingsTab("display");
    addonsPreferenceRow().should("not.have.class", "hidden-menu").within(() => {
      cy.get("strong .nav-preview-tag").should("not.exist");
      cy.get(".navigation-visibility-toggle").should("have.attr", "aria-pressed", "true");
    });

    cy.openView("addons").should("be.visible");
    cy.screenshot("preview-menu-released");
  });

  it("준비중이던 때 숨김이 굳은 v2 저장값에서도 애드온이 되살아난다", () => {
    cy.visitApp({
      [NAVIGATION_PREFERENCES_KEY]: "",
      [V2_KEY]: JSON.stringify({ order: ["chat", "dashboard"], hidden: ["docs", "addons"] }),
    });
    cy.anchor("nav.chat").should("be.visible");
    cy.anchor("nav.addons").should("be.visible");
    // 사용자가 직접 숨긴 화면은 그대로 숨겨져 있어야 한다.
    cy.anchor("nav.docs").should("not.exist");
    cy.window().should((win) => {
      const stored = JSON.parse(win.localStorage.getItem(NAVIGATION_PREFERENCES_KEY) || "null");
      expect(stored.hidden).to.deep.equal(["docs"]);
      expect(stored.order.slice(0, 2)).to.deep.equal(["chat", "dashboard"]);
    });
  });

  it("애드온이 생기기 전 v1 저장값도 순서를 지킨 채 새 세대로 넘어간다", () => {
    cy.visitApp({
      [NAVIGATION_PREFERENCES_KEY]: "",
      [V1_KEY]: JSON.stringify({ order: ["skills", "chat"], hidden: ["docs"] }),
    });
    cy.anchor("nav.addons").should("be.visible");
    cy.anchor("nav.docs").should("not.exist");
    cy.window().should((win) => {
      const stored = JSON.parse(win.localStorage.getItem(NAVIGATION_PREFERENCES_KEY) || "null");
      expect(stored.hidden).to.deep.equal(["docs"]);
      expect(stored.order.slice(0, 2)).to.deep.equal(["skills", "chat"]);
    });
  });
});
