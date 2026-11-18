/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 애드온 화면의 탭은 "탭을 눌러 활성 상태를 보고 그 탭의 패널이 떴는지 본다"의 두 걸음인데,
// 탭 이름과 패널 앵커 이름이 서로 다르게 붙어 있어(claude → claude-plugins-content) 스펙마다
// 그 대응을 손으로 적어 왔다. 대응을 아는 곳은 여기 하나로 둔다. 화면 열기는 포함하지 않는다 —
// 같은 화면 안에서 탭만 옮기는 스펙이 내비를 다시 누르게 되면 보려던 것이 달라진다.
const ADDONS_PANELS: Record<string, string> = {
  mcp: "addons.mcp-content",
  ssh: "addons.ssh-content",
  db: "addons.db-content",
  k8s: "addons.k8s-content",
  peers: "addons.peers-content",
  runners: "addons.runners-content",
  index: "addons.index-content",
  cypress: "addons.cypress-content",
  mermaid: "addons.mermaid-content",
  claude: "addons.claude-plugins-content",
};

Cypress.Commands.add("openAddonsTab", (tab: string) => {
  // 탭을 누른 뒤 같은 요소를 이어서 단언하지 않는다 — 첫 탭(외부 MCP)의 목록 조회가 끝나며
  // 화면이 다시 그려지면 눌렀던 버튼이 DOM에서 떨어져 체인이 끊긴다. 다시 찾아서 본다.
  cy.anchor(`addons.tab.${tab}`).click();
  cy.anchor(`addons.tab.${tab}`).should("have.class", "active");
  // 여기서 볼 것은 "이 탭의 패널이 떴는가"다. be.visible은 그 위에 스크롤 위치까지 얹는데,
  // 앵커가 붙은 곳이 탭 안 마지막 카드인 탭에서는 위에 카드가 하나 늘어나는 것만으로 카드가
  // 스크롤 상자 밖으로 밀려 "clipped"로 거짓이 된다 — 화면은 멀쩡한데 탭 열기가 실패하는
  // 것이다. 꺼진 패널은 `hidden`이라 display:none이 되므로, 그려지고 있는지(offsetParent)만
  // 보면 스크롤 위치와 무관하게 같은 것을 확인한다.
  return cy.anchor(ADDONS_PANELS[tab]).should(($panel) => {
    expect($panel[0].offsetParent, `${tab} 패널이 떠 있어야 한다`).to.not.equal(null);
  });
});

// 애드온 화면의 도구 탭(외부 MCP·SSH·데이터베이스·Cypress·Mermaid·Claude Code)을 여는 절차.
// 설정 → 플러그인 중메뉴가 이리로 옮겨 오면서 openSettingsTab이 하던 자리를 대신한다.
// 같은 화면 안에서 탭만 옮길 때는 화면을 다시 열지 않는 openAddonsTab을 쓴다.
Cypress.Commands.add("openAddonsView", (tab: string) => {
  cy.openView("addons").should("be.visible");
  return cy.openAddonsTab(tab);
});
