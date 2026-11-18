/// <reference types="cypress" />

/**
 * 좁은 화면에서 설정 중메뉴(탭 줄)가 가로로 넘칠 때, 사용자가 탭을 직접 누르지 않고
 * 바깥에서 탭이 바뀌는 경로에서도 활성 탭이 스스로 보이는 자리로 끌려오는지.
 *
 * AM-237은 애드온 탭 줄이 겹치지 않고 가로로 스크롤되는지만 봤고, AM-129는 넓은 화면에서
 * 설정 탭 선택의 잔존만 봤다. 바깥 요청(AIA 화면 안내)으로 탭이 바뀌는 경로는 클릭이
 * 없어 브라우저의 기본 스크롤 보정도 없다 — SettingsView.tsx:200 의 보정 효과가 유일한
 * 수단이라 여기서만 드러난다.
 *
 * 가시성은 be.visible이 아니라 좌표로 본다. 탭 줄은 overflow 컨테이너라 스크롤 밖 버튼도
 * Cypress에게는 보이는 것으로 잡힌다.
 */
const STRIP = ".settings-hub-tabs";

function expectTabInsideStrip(anchor: string) {
  // 스크롤이 smooth라 한 번에 끝나지 않는다. should 콜백의 재시도로 멎을 때까지 기다린다.
  cy.get(STRIP).should(($nav) => {
    const nav = $nav[0].getBoundingClientRect();
    const tab = $nav[0].querySelector<HTMLElement>(`[data-ui-anchor="${anchor}"]`);
    expect(tab, `${anchor} 버튼이 탭 줄 안에 있다`).to.not.equal(null);
    const rect = tab!.getBoundingClientRect();
    expect(rect.left, `${anchor} 왼쪽 끝이 탭 줄 안`).to.be.at.least(nav.left - 1);
    expect(rect.right, `${anchor} 오른쪽 끝이 탭 줄 안`).to.be.at.most(nav.right + 1);
  });
}

function openNarrowSettings() {
  cy.viewport(420, 900);
  cy.visitApp();
  cy.openView("settings");
  // 사전조건: 이 폭에서 탭 줄은 실제로 넘친다. 넘치지 않으면 이 시나리오가 헛돈다.
  cy.get(STRIP).should(($nav) => {
    expect($nav[0].scrollWidth, "탭 줄이 가로로 넘친다").to.be.greaterThan($nav[0].clientWidth + 1);
    expect($nav[0].scrollLeft, "처음에는 맨 왼쪽").to.be.lessThan(2);
    const nav = $nav[0].getBoundingClientRect();
    const last = $nav[0].querySelector<HTMLElement>('[data-ui-anchor="settings.tab.display"]')!;
    expect(last.getBoundingClientRect().left, "마지막 탭은 스크롤 밖").to.be.greaterThan(nav.right);
  });
}

describe("좁은 화면 설정 탭 줄의 활성 탭 끌어오기", () => {
  it("오른쪽 스크롤 밖의 탭이 바깥 요청으로 활성화되면 줄 안으로 끌려온다", () => {
    openNarrowSettings();
    expectTabInsideStrip("settings.tab.connections");

    // 화면 안내가 마지막 탭(화면·채팅) 안의 대상을 가리키면 탭이 바뀐다. 클릭이 없는데도
    // 그 탭 버튼이 줄 안으로 끌려와야 한다.
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.theme", element: null, note: "여기가 테마" }))
      .should("eq", true);
    cy.anchor("settings.tab.display").should("have.class", "active");
    cy.get(".ui-guide-note").should("contain.text", "여기가 테마");
    expectTabInsideStrip("settings.tab.display");
    cy.get(STRIP).should(($nav) => {
      expect($nav[0].scrollLeft, "오른쪽으로 감겼다").to.be.greaterThan(1);
    });

    // 안내를 거둬도 끌어온 자리와 탭 선택은 그대로 남는다.
    cy.get("body").type("{esc}");
    cy.get(".ui-guide").should("not.exist");
    cy.anchor("settings.tab.display").should("have.class", "active");
    expectTabInsideStrip("settings.tab.display");
  });

  // QA #77. 되감을 목표를 버튼의 offsetLeft(offsetParent 기준)가 아니라 탭 줄 기준 위치로
  // 읽도록 고친 자리다. 오른쪽 갈래는 과하게 감겨도 결과적으로 활성 탭이 보여 증상이
  // 드러나지 않으므로, 되감기는 이 왼쪽 갈래가 회귀를 붙잡는 쪽이다.
  it("왼쪽 스크롤 밖으로 밀린 탭이 다시 활성화되면 줄이 되감긴다", () => {
    openNarrowSettings();
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.theme", element: null, note: "여기가 테마" }))
      .should("eq", true);
    expectTabInsideStrip("settings.tab.display");

    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "settings.connections", element: null, note: "여기가 CLI 연결" }))
      .should("eq", true);
    cy.anchor("settings.tab.connections").should("have.class", "active");
    expectTabInsideStrip("settings.tab.connections");
  });
});
