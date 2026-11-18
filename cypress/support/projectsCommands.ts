/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 프로젝트 화면의 탭(프로젝트 파일·형상관리·설정)은 "탭을 눌러 활성 상태를 보고 그 탭의 패널이
// 떴는지 본다"의 두 걸음이다. 패널 id는 `SettingsSubTabPanel`이 `<prefix>-panel-<id>`로 붙이고
// 프로젝트 화면의 prefix는 `projects`라, 탭 이름에서 곧바로 나온다. 화면 열기는 포함하지 않는다
// — 같은 화면 안에서 탭만 옮기는 스펙이 내비를 다시 누르게 되면 보려던 것이 달라진다.
Cypress.Commands.add("openProjectsTab", (tab: string) => {
  cy.anchor(`projects.tab.${tab}`).click();
  cy.anchor(`projects.tab.${tab}`).should("have.class", "active");
  // 꺼진 패널은 `hidden`이라 display:none이 되므로, 그려지고 있는지(offsetParent)만 보면
  // 스크롤 위치와 무관하게 "이 탭의 패널이 떴는가"를 확인한다(애드온 화면과 같은 이유).
  return cy.get(`#projects-panel-${tab}`).should(($panel) => {
    expect($panel[0].offsetParent, `${tab} 패널이 떠 있어야 한다`).to.not.equal(null);
  });
});

// 프로젝트 화면을 연 뒤 `tab` 탭까지 연다. 설정 → 라이브러리에 있던 프로젝트 활성여부 카드가
// 이 화면의 설정 탭으로 옮겨 오면서 `openSettingsTab("repository")`가 하던 자리를 대신한다.
Cypress.Commands.add("openProjectsView", (tab: string) => {
  cy.openView("projects").should("be.visible");
  return cy.openProjectsTab(tab);
});
