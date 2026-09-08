/// <reference types="cypress" />
// AM-48 회귀 상시화: 지침 화면(지침관리 모드)의 영어 전환 계약. AM-48 회차는 개발선이 갈라져
// 임시 스펙으로만 돌고 커밋하지 못했다. 모드 탭·보관 요약·툴바·빈 상태 안내와
// 막힌 버튼의 사유(title)까지 영어 계약대로 나오는지 본다. AM-20은 한국어 문구만 봤고,
// 이 스펙은 같은 화면의 다국어 전환 축을 본다.
const MODE_KEY = "agent-manager.instruction-mode.v1";

describe("지침 화면 영어 전환 계약", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.window().its("localStorage").invoke("setItem", MODE_KEY, "manage");
  });

  // 이 스펙은 영어로 바꾼 채 끝나므로 반드시 한국어로 되돌린다.
  after(() => {
    cy.restoreLanguage();
  });

  it("영어에서 모드 탭 이름과 그룹 이름이 영어 계약값과 같다", () => {
    cy.setLanguage("en");
    cy.openInstructionMode("manage");
    cy.get(".skill-mode-tabs[role=group]").should("have.attr", "aria-label", "Instruction view mode");
    cy.get(".skill-mode-tabs[role=group] button").eq(0).should("have.text", "Info");
    cy.get(".skill-mode-tabs[role=group] button").eq(1).should("have.text", "Manage");
  });

  it("영어에서 보관 지침 요약이 개수 뒤에 '개' 없이 루트 경로만 붙인다", () => {
    cy.setLanguage("en");
    cy.openInstructionMode("manage");
    cy.get(".skill-library-summary strong").should("have.text", "Archived instructions");
    cy.get(".skill-library-summary small").invoke("text").should("match", /^0 · \S+/);
  });

  it("영어 빈 상태가 제목·안내 모두 영어 계약값과 같다", () => {
    cy.setLanguage("en");
    cy.openInstructionMode("manage");
    cy.get(".instructions-view .empty-state strong").should("have.text", "No archived instructions");
    cy.get(".instructions-view .empty-state p").should(
      "have.text",
      "Use 'New instruction' above, or 'Import' to archive an existing instruction from a registered project.",
    );
  });

  it("영어에서 막힌 버튼의 사유(title)가 영어로 나온다", () => {
    cy.setLanguage("en");
    cy.openInstructionMode("manage");
    cy.get(".skill-library-toolbar-row button").contains("Import").should("be.disabled")
      .and("have.attr", "title", "No unarchived instruction files in registered projects or personal settings");
    cy.get(".skill-mode-toolbar .skill-transfer-buttons button").contains("Migrate all")
      .should("be.disabled")
      .and("have.attr", "title", "Configure a connected system agent");
  });

  it("영어 지침관리 화면 본문에 한글이 남지 않는다", () => {
    cy.setLanguage("en");
    cy.openInstructionMode("manage");
    cy.get(".instructions-view .skill-library-toolbar").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".instructions-view .empty-state").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".instructions-view .settings-card header").invoke("text").should("not.match", /[가-힣]/);
  });
});
