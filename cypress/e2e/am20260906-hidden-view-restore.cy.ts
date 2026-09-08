// 새로고침 뒤 화면 복원(`agent-manager.active-view.v1`)이 주 메뉴에서 숨긴 화면까지
// 되살리지는 않는지 본다. 숨긴 화면은 사이드바로 갈 수 없지만 AIA 화면 안내는 그대로 열 수
// 있어, 안내로 열어 둔 채 새로고침하면 메뉴에 짚이는 자리가 없는 화면이 복원될 수 있다.
// 기존 addons.cy.ts는 표시 중인 화면·탭이 남는 갈래만 보고, navigation-preferences.cy.ts는
// 숨김·순서 저장만 본다. 두 저장값이 만나는 자리는 여기가 처음이다.
const ACTIVE_VIEW_KEY = "agent-manager.active-view.v1";
const NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v2";
// 사용자가 숨길 수 있는 메뉴 전부(`DEFAULT_NAVIGATION_ORDER`). 설정은 숨길 수 없어 여기 없다.
const ALL_CONFIGURABLE_VIEWS = [
  "dashboard", "chat", "sessions", "docs", "instructions", "skills", "agents", "artifacts", "workflows", "addons", "storage",
];

function chatPreferenceRow() {
  return cy.contains(".navigation-preference-row strong", "채팅").closest(".navigation-preference-row");
}

// AIA 화면 안내로 채팅 화면을 연다. 사이드바에서 숨겨도 안내는 화면 안의 대화 탭을 가리켜
// 화면 자체를 연다.
function openChatByGuide() {
  cy.e2e()
    .then((hooks) => hooks.showUiGuide({ target: "chat.conversation", element: null, note: null }))
    .should("eq", true);
  cy.view("chat").should("exist");
}

describe("숨긴 화면의 새로고침 복원 차단", () => {
  it("표시 중인 화면은 새로고침 뒤 복원되고, 메뉴에서 숨긴 화면은 메뉴에 보이는 첫 화면으로 돌아간다", () => {
    cy.visitApp();
    cy.anchor("nav.dashboard").should("be.visible");

    // 1) 표시 중일 때: 안내로 연 채팅 화면이 저장되고 새로고침을 건너 복원된다.
    openChatByGuide();
    cy.window().should((win) => {
      expect(win.localStorage.getItem(ACTIVE_VIEW_KEY)).to.eq("chat");
    });
    cy.reload();
    cy.view("chat").should("exist");

    // 2) 설정 → 화면·채팅에서 채팅을 숨긴다. 사이드바 항목이 사라지고, 설정 화면으로 옮겨
    //    왔으므로 저장된 화면도 설정으로 바뀐다.
    cy.openSettingsTab("display");
    cy.contains(".settings-subsection > header strong", "메인 메뉴").should("be.visible");
    chatPreferenceRow().within(() => {
      cy.get(".navigation-visibility-toggle").should("have.attr", "aria-pressed", "true").click();
      cy.contains("small", "메뉴에서 숨김").should("be.visible");
    });
    cy.anchor("nav.chat").should("not.exist");
    cy.window().should((win) => {
      expect(win.localStorage.getItem(ACTIVE_VIEW_KEY)).to.eq("settings");
    });

    // 3) 숨긴 뒤에도 안내는 채팅 화면을 열 수 있고, 그 선택이 저장된다.
    openChatByGuide();
    cy.window().should((win) => {
      expect(win.localStorage.getItem(ACTIVE_VIEW_KEY)).to.eq("chat");
    });

    // 4) 새로고침하면 숨긴 화면은 복원되지 않고 메뉴에 보이는 첫 화면(여기서는 대시보드)으로
    //    열린다. 저장값 자체는 남는다 —
    //    복원 시점에 활성 화면을 다시 쓰지 않기 때문이며, 다시 표시로 되돌리면 살아난다.
    cy.reload();
    cy.view("dashboard").should("exist");
    cy.view("chat").should("not.exist");
    cy.anchor("nav.chat").should("not.exist");
    cy.window().should((win) => {
      expect(win.localStorage.getItem(ACTIVE_VIEW_KEY)).to.eq("chat");
    });
    cy.screenshot("hidden-view-not-restored");

    // 5) 뒷정리 — 채팅을 다시 표시로 되돌린다. 저장값이 그대로였으므로 새로고침하면 다시
    //    채팅으로 복원된다.
    cy.openSettingsTab("display");
    chatPreferenceRow().find(".navigation-visibility-toggle").click().should("have.attr", "aria-pressed", "true");
    cy.anchor("nav.chat").should("be.visible");
    cy.window().then((win) => win.localStorage.setItem(ACTIVE_VIEW_KEY, "chat"));
    cy.reload();
    cy.view("chat").should("exist");
  });

  // QA #22 회귀: 폴백 자체가 숨긴 화면일 때. 대시보드까지 숨기면 고정값 대시보드로 떨어질 수
  // 없고, 사용자가 정한 순서에서 숨기지 않은 첫 메뉴가 열려야 한다. 열린 화면은 언제나 사이드바에서
  // 짚혀야 하므로 활성 항목(aria-current)도 함께 본다.
  it("대시보드도 숨겼으면 숨기지 않은 첫 메뉴로 열리고, 모두 숨기면 설정으로 열린다", () => {
    // 1) 기본 순서에서 대시보드·채팅을 숨기고 저장된 화면은 숨긴 채팅 — 셋째인 세션이 열린다.
    cy.visitApp({
      [NAVIGATION_PREFERENCES_KEY]: JSON.stringify({ hidden: ["dashboard", "chat"] }),
      [ACTIVE_VIEW_KEY]: "chat",
    });
    cy.view("sessions").should("exist");
    cy.view("dashboard").should("not.exist");
    cy.view("chat").should("not.exist");
    cy.anchor("nav.dashboard").should("not.exist");
    cy.anchor("nav.sessions").should("have.attr", "aria-current", "page");

    // 2) 순서를 바꿔 두면 그 순서의 첫 보이는 메뉴를 따른다. 저장값이 없는 첫 실행도 같다.
    cy.visitApp({
      [NAVIGATION_PREFERENCES_KEY]: JSON.stringify({ order: ["skills"], hidden: ["dashboard"] }),
      [ACTIVE_VIEW_KEY]: "",
    });
    cy.view("skills").should("exist");
    cy.anchor("nav.dashboard").should("not.exist");
    cy.anchor("nav.skills").should("have.attr", "aria-current", "page");

    // 3) 구성 가능한 메뉴를 모두 숨긴 극단 — 숨길 수 없는 고정 메뉴인 설정으로 떨어진다.
    cy.visitApp({
      [NAVIGATION_PREFERENCES_KEY]: JSON.stringify({ hidden: ALL_CONFIGURABLE_VIEWS }),
      [ACTIVE_VIEW_KEY]: "dashboard",
    });
    cy.view("settings").should("exist");
    cy.view("dashboard").should("not.exist");
    cy.get('.app-sidebar nav [data-ui-anchor^="nav."]').should("have.length", 1)
      .first().should("have.attr", "data-ui-anchor", "nav.settings");
    cy.screenshot("hidden-dashboard-fallback");
  });
});
