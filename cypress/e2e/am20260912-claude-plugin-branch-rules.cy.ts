// 브랜치별 플러그인 규칙은 Claude 설정 파일에 적을 자리가 없어 앱이 따로 들고 있다가 실행을
// 띄울 때 넘긴다. 저장소가 플러그인 사용 설정과 다르므로, 화면에서 확인할 것은 "저장소의 로컬
// 브랜치가 목록으로 서고 그 자리에서 켜고 끌 수 있는가", "지금 체크아웃된 브랜치에 걸리는
// 규칙에만 적용 표시가 붙는가", "프로젝트별에서 끈 프로젝트는 접혀 있는가", 그리고 "패턴 입력이
// 그대로 저장 요청이 되는가" 넷이다. 격리 백엔드에는 설치된 플러그인이 없으므로 목록과 규칙을
// 모두 고정값으로 세운다.
import type { ClaudePluginBranchRulesSnapshot, ClaudeSettingsSnapshot } from "../../src/types";

const PLUGIN_ID = "demo@official";
const PROJECT = "/tmp/amproj/branch-demo";
const QUIET_PROJECT = "/tmp/amproj/no-rules";

const SETTINGS: ClaudeSettingsSnapshot = {
  scopes: { user: { path: "/tmp/amhome/.claude/settings.json", exists: true } },
  plugins: [{
    pluginId: PLUGIN_ID,
    name: "demo",
    marketplace: "official",
    version: "1.0.0",
    installPath: "/tmp/amhome/.claude/plugins/cache/official/demo/1.0.0",
    skillCount: 3,
    defaultEnabled: true,
    values: { user: "true" },
    effectiveEnabled: true,
    decidedBy: "user",
    locked: false,
  }],
  skills: [],
};

const RULES: ClaudePluginBranchRulesSnapshot = {
  schemaVersion: 1,
  rules: [
    { projectPath: PROJECT, branch: "release/*", pluginId: PLUGIN_ID, enabled: false },
    { projectPath: PROJECT, branch: "main", pluginId: PLUGIN_ID, enabled: true },
  ],
  projects: [
    { path: PROJECT, currentBranch: "release/3", branches: ["feature/login", "main", "release/3"] },
    { path: QUIET_PROJECT, currentBranch: "main", branches: ["main"] },
  ],
};

describe("애드온 클로드 플러그인 브랜치 규칙", () => {
  beforeEach(() => {
    cy.stubInvoke("get_claude_settings_states", SETTINGS);
    cy.stubInvoke("get_claude_plugin_branch_rules", RULES);
    cy.visitApp();
    cy.openView("addons").should("be.visible");
    cy.openAddonsTab("claude");
    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.contains(".plugin-row-name", PLUGIN_ID).should("be.visible");
      cy.contains(".claude-plugin-scope-toggle .button", "브랜치별").click();
    });
  });

  it("로컬 브랜치가 목록으로 서고 현재 브랜치에 걸리는 규칙에만 적용 표시가 붙는다", () => {
    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.get(".claude-branch-project-head").should("contain.text", "현재 release/3");
      // 브랜치 세 개는 목록으로, 목록에 없는 패턴 규칙은 따로 선다.
      cy.get(".claude-branch-list .claude-branch-rule").should("have.length", 3);
      cy.contains(".claude-branch-list .claude-branch-rule", "main")
        .should("contain.text", "이 브랜치에서 사용")
        .and("not.have.class", "applies");
      cy.contains(".claude-branch-list .claude-branch-rule", "feature/login")
        .should("contain.text", "프로젝트 설정 상속");
      cy.contains(".claude-branch-list .claude-branch-rule", "release/3")
        .should("have.class", "applies")
        .and("contain.text", "지금 적용");
      cy.contains(".claude-branch-extra .claude-branch-rule", "release/*")
        .should("have.class", "applies")
        .and("contain.text", "이 브랜치에서 사용 안 함");
    });
  });

  it("목록의 토글이 그 브랜치 규칙 저장 요청이 된다", () => {
    cy.stubInvoke("set_claude_plugin_branch_rule", {
      ...RULES,
      rules: [...RULES.rules, { projectPath: PROJECT, branch: "feature/login", pluginId: PLUGIN_ID, enabled: true }],
    }).as("saveRule");

    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.contains(".claude-branch-list .claude-branch-rule", "feature/login").find(".app-toggle").click();
    });

    cy.wait("@saveRule").its("request.body.request").should("deep.equal", {
      projectPath: PROJECT,
      branch: "feature/login",
      pluginId: PLUGIN_ID,
      enabled: true,
    });
    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.contains(".claude-branch-list .claude-branch-rule", "feature/login")
        .should("contain.text", "이 브랜치에서 사용");
    });
  });

  it("규칙도 없고 프로젝트별에서도 끈 프로젝트는 전체 보기에서만 나온다", () => {
    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.get(".claude-branch-project").should("have.length", 1)
        .and("contain.text", PROJECT);
      cy.get(".claude-branch-showall input").check();
      cy.get(".claude-branch-project").should("have.length", 2);
      cy.contains(".claude-branch-project", QUIET_PROJECT).should("be.visible");
    });
  });

  it("입력한 패턴이 그대로 저장 요청이 된다", () => {
    cy.stubInvoke("set_claude_plugin_branch_rule", {
      ...RULES,
      rules: [...RULES.rules, { projectPath: PROJECT, branch: "hotfix/*", pluginId: PLUGIN_ID, enabled: true }],
    }).as("saveRule");

    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.get(".claude-branch-add input").type("hotfix/*");
      cy.contains(".claude-branch-add .button", "추가").click();
    });

    cy.wait("@saveRule").its("request.body.request").should("deep.equal", {
      projectPath: PROJECT,
      branch: "hotfix/*",
      pluginId: PLUGIN_ID,
      enabled: true,
    });
    // 저장이 끝나면 돌려받은 패턴 규칙이 목록 밖에 한 줄로 더 선다.
    cy.anchor("addons.claude-plugins-content").within(() => {
      cy.get(".claude-branch-extra .claude-branch-rule").should("have.length", 2);
      cy.get(".claude-branch-add input").should("have.value", "");
    });
  });
});
