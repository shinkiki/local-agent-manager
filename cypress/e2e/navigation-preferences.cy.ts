// 설정 → 화면·채팅의 메인 메뉴 편집기가 사이드바 표시 여부와 순서를 즉시 바꾸고,
// localStorage에 저장한 결과를 새로고침 뒤에도 복원하는지 한 흐름으로 검증한다.
const NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v2";

function openNavigationPreferences(): void {
  cy.openSettingsTab("display");
  cy.contains(".settings-subsection > header strong", "메인 메뉴").should("be.visible");
}

function chatPreferenceRow() {
  return cy.contains(".navigation-preference-row strong", "채팅").closest(".navigation-preference-row");
}

function expectLeadingNavigation(...anchors: string[]): void {
  cy.get('.app-sidebar nav [data-ui-anchor^="nav."]').then(($buttons) => {
    const actual = [...$buttons].map((button) => button.getAttribute("data-ui-anchor"));
    expect(actual.slice(0, anchors.length)).to.deep.equal(anchors);
  });
}

describe("메인 메뉴 표시·순서 편집과 저장 복원", () => {
  it("숨김·복원과 순서 변경이 사이드바에 즉시 반영되고 새로고침 뒤에도 남는다", () => {
    cy.visitApp();
    openNavigationPreferences();

    // 기본 순서의 두 번째인 채팅 메뉴를 숨기면 설정 행은 남고 사이드바 항목만 사라진다.
    expectLeadingNavigation("nav.dashboard", "nav.chat", "nav.sessions");
    chatPreferenceRow().within(() => {
      cy.get(".navigation-visibility-toggle").should("have.attr", "aria-pressed", "true").click();
      cy.contains("small", "메뉴에서 숨김").should("be.visible");
    });
    cy.anchor("nav.chat").should("not.exist");

    // 같은 조작으로 다시 표시한 뒤 위로 이동하면 채팅이 대시보드보다 앞선다.
    chatPreferenceRow().find(".navigation-visibility-toggle").click().should("have.attr", "aria-pressed", "true");
    cy.anchor("nav.chat").should("be.visible");
    chatPreferenceRow().find('button[aria-label="채팅 위로 이동"]').click();
    expectLeadingNavigation("nav.chat", "nav.dashboard", "nav.sessions");

    // 설정은 고정 메뉴라 편집 대상이 아니며, 저장된 순서에도 포함되지 않는다.
    // 고정 행은 목록 끝이라 설정 화면의 스크롤 밖에 있을 수 있다. 보이는지 보려면 먼저 스크롤한다.
    cy.contains(".navigation-preference-row.fixed-menu strong", "설정").scrollIntoView().should("be.visible");
    cy.window().should((win) => {
      const stored = JSON.parse(win.localStorage.getItem(NAVIGATION_PREFERENCES_KEY) ?? "null");
      expect(stored.order.slice(0, 3)).to.deep.equal(["chat", "dashboard", "sessions"]);
      expect(stored.hidden).not.to.include("chat");
      expect(stored.order).not.to.include("settings");
    });

    // 페이지를 새로 불러도 저장된 사이드바 순서와 설정의 마지막 고정 위치가 복원된다.
    cy.reload();
    expectLeadingNavigation("nav.chat", "nav.dashboard", "nav.sessions");
    cy.get('.app-sidebar nav [data-ui-anchor^="nav."]').last().should("have.attr", "data-ui-anchor", "nav.settings");
    cy.screenshot("navigation-preferences-after-reload");
  });
});
