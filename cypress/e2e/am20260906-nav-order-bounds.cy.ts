// 설정 → 화면·채팅의 메인 메뉴 편집기에서 순서 이동의 양 끝 경계와, 숨긴 항목이 순서에서는
// 자리를 지키는지 본다. 이동 버튼은 index로만 막히고(src/components/SettingsView.tsx:255)
// 숨김은 order가 아니라 hidden에만 담기므로(src/lib/navigationPreferences.ts:44), 숨긴 항목을
// 옮겼다가 다시 표시하면 옮긴 자리에 나타나야 한다. AM-34는 숨김·복원과 한 칸 이동만 봤고
// 양 끝 비활성과 숨긴 항목의 순서 보존은 보지 않았다.
function preferenceRow(label: string) {
  return cy.contains(".navigation-preference-row strong", label).closest(".navigation-preference-row");
}

function orderButton(label: string, direction: "위로" | "아래로") {
  return preferenceRow(label).find(`button[aria-label="${label} ${direction} 이동"]`);
}

function expectLeadingNavigation(...anchors: string[]): void {
  cy.get('.app-sidebar nav [data-ui-anchor^="nav."]').then(($buttons) => {
    const actual = [...$buttons].map((button) => button.getAttribute("data-ui-anchor"));
    expect(actual.slice(0, anchors.length)).to.deep.equal(anchors);
  });
}

describe("메인 메뉴 순서 이동의 양 끝 경계와 숨긴 항목의 자리 보존", () => {
  it("첫·마지막 항목의 이동 버튼이 막히고, 숨긴 항목도 옮긴 자리를 지킨 채 다시 나타난다", () => {
    cy.visitApp();
    cy.openSettingsTab("display");

    // 기본 순서의 양 끝. 대시보드는 위로, 저장소는 아래로 갈 곳이 없어 그 방향만 막힌다.
    expectLeadingNavigation("nav.dashboard", "nav.chat", "nav.sessions");
    orderButton("대시보드", "위로").should("be.disabled");
    orderButton("대시보드", "아래로").should("not.be.disabled");
    orderButton("저장소", "아래로").should("be.disabled");
    orderButton("저장소", "위로").should("not.be.disabled");

    // 저장소를 맨 위까지 올리면 막히는 쪽이 맞바뀐다 — 경계가 자리로만 정해진다.
    for (let step = 0; step < 10; step += 1) orderButton("저장소", "위로").click();
    expectLeadingNavigation("nav.storage", "nav.dashboard", "nav.chat");
    orderButton("저장소", "위로").should("be.disabled");
    orderButton("저장소", "아래로").should("not.be.disabled");
    orderButton("대시보드", "위로").should("not.be.disabled");

    // 맨 위의 저장소를 숨기면 사이드바에서만 빠진다. 편집기 행과 이동 버튼은 그대로 남는다.
    preferenceRow("저장소").find(".navigation-visibility-toggle").click().should("have.attr", "aria-pressed", "false");
    cy.anchor("nav.storage").should("not.exist");
    expectLeadingNavigation("nav.dashboard", "nav.chat");

    // 숨긴 채로 한 칸 내려도 사이드바는 그대로다. 순서는 hidden과 따로 담기기 때문이다.
    orderButton("저장소", "아래로").click();
    cy.anchor("nav.storage").should("not.exist");
    expectLeadingNavigation("nav.dashboard", "nav.chat");

    // 다시 표시하면 원래 자리가 아니라 숨긴 동안 옮긴 자리(대시보드 다음)에 나타난다.
    preferenceRow("저장소").find(".navigation-visibility-toggle").click().should("have.attr", "aria-pressed", "true");
    expectLeadingNavigation("nav.dashboard", "nav.storage", "nav.chat");

    // 경계와 순서 모두 새로고침을 넘어 남는다.
    cy.reload();
    expectLeadingNavigation("nav.dashboard", "nav.storage", "nav.chat");
    cy.openSettingsTab("display");
    orderButton("대시보드", "위로").should("be.disabled");
    orderButton("저장소", "위로").should("not.be.disabled");
  });
});
