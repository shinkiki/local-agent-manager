/// <reference types="cypress" />
// 프로젝트 화면(C16)의 내비와 탭. 주 메뉴에 프로젝트 항목이 서고, 세 탭(프로젝트 파일·형상관리·
// 설정)이 tablist로 서며, 고른 탭은 localStorage(`agent-manager.projects-tab.v1`)에 남아 새로고침을
// 건너 복원된다. AIA 화면 안내(`projects.tab.settings`)가 탭을 열고, 예전 설정 → 라이브러리에 있던
// '세션에서 확인한 프로젝트' 카드는 이 화면의 설정 탭에만 있다.
import { projectRegistryCard } from "../support/projectRegistryFixtures";

const PROJECTS_TAB_KEY = "agent-manager.projects-tab.v1";

describe("프로젝트 화면 내비와 탭", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  it("네 탭이 서고 기본은 프로젝트 파일 탭이며 고른 탭은 새로고침을 건너 남는다", () => {
    cy.anchor("nav.projects").should("be.visible");
    cy.openView("projects");
    // 2026-10-04에 overlay 탭(C19, O11)이 서면서 셋에서 넷이 됐다.
    cy.view("projects").find('[role="tablist"] [role="tab"]').should("have.length", 4);
    cy.anchor("projects.tab.files").should("have.class", "active");
    cy.get("#projects-panel-files").should("be.visible");

    cy.openProjectsTab("git");
    cy.reload();
    cy.openView("projects");
    cy.anchor("projects.tab.git").should("have.class", "active");
    cy.window().then((win) => {
      expect(win.localStorage.getItem(PROJECTS_TAB_KEY)).to.eq("git");
    });
  });

  it("화면 안내가 설정 탭을 열고 프로젝트 활성여부 카드는 그 탭에만 있다", () => {
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "projects.tab.settings", element: null, note: null }))
      .should("eq", true);
    cy.view("projects").should("exist");
    cy.anchor("projects.tab.settings").should("have.class", "active");
    cy.get("#projects-panel-settings").should("be.visible");
    projectRegistryCard().should("exist");
    cy.get("body").type("{esc}");

    // 옮겨 온 카드는 공통 저장소 경로 카드 옆에 더 이상 없다. 그 카드도 설정에서 저장소
    // 화면의 라이브러리 탭으로 옮겨 갔다.
    cy.openStorageTab("library");
    cy.anchor("storage.repository-path").should("be.visible");
    cy.view("storage").should("not.contain.text", "세션에서 확인한 프로젝트");
  });
});
