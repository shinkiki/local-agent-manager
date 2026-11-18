// 브랜치 규칙은 플러그인 목록과 따로 읽는다. 그 읽기가 프로젝트별 상태보다 먼저 실패하면
// 오류 배너가 떠야 하고, 늦게 끝난 프로젝트 읽기의 성공이 그 배너를 지워서는 안 된다
// (지우면 브랜치별 칸이 규칙이 없는 것처럼 아무 안내 없이 비어 보인다).
import type { ClaudeSettingsSnapshot } from "../../src/types";
import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";

const SETTINGS: ClaudeSettingsSnapshot = {
  scopes: { user: { path: "/tmp/amhome/.claude/settings.json", exists: true } },
  plugins: [],
  skills: [],
};

describe("애드온 클로드 플러그인 브랜치 규칙 읽기 실패", () => {
  it("늦게 끝난 프로젝트 읽기가 브랜치 규칙 실패 배너를 지우지 않는다", () => {
    stubProjectRegistry([projectEntry("slow-project")]);
    cy.stubInvoke("get_claude_settings_states", (req) => {
      const projectPath = (req.body as { projectPath: string | null }).projectPath;
      req.reply({ statusCode: 200, body: SETTINGS, delay: projectPath ? 800 : 0 });
    }).as("settings");
    cy.stubInvoke("get_claude_plugin_branch_rules", {
      statusCode: 500,
      body: { error: "브랜치 규칙을 읽지 못했습니다." },
    }).as("rules");
    cy.visitApp();
    cy.openView("addons").should("be.visible");
    cy.openAddonsTab("claude");
    cy.wait("@rules");
    cy.wait("@settings");
    cy.wait("@settings");
    // 응답이 도착한 뒤 화면이 그 결과를 반영할 틈을 준다. 배너가 지워지는 것은 이 뒤다.
    cy.wait(500);
    cy.anchor("addons.claude-plugins-content")
      .find(".error-banner")
      .should("contain.text", "브랜치 규칙을 읽지 못했습니다.");
  });
});
