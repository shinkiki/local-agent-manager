import type { ClaudeSettingsSnapshot, SkillSummary } from "../../src/types";
import { projectEntry } from "../support/projectRegistryFixtures";

const PROJECT = "/tmp/amproj/skill-boundary";
const SKILL: SkillSummary = {
  id: "claude:project:boundary",
  source: "claude",
  scope: "project",
  name: "프로젝트 경계 시험",
  description: "프로젝트 스킬 설정의 쓰기 경계",
  directory: `${PROJECT}/.claude/skills/boundary`,
  path: `${PROJECT}/.claude/skills/boundary/SKILL.md`,
  origin: PROJECT,
  archived: false,
};

const SNAPSHOT: ClaudeSettingsSnapshot = {
  scopes: { user: { path: "/tmp/am-skill-boundary/settings.json", exists: true } },
  plugins: [],
  skills: [{
    overrideKey: SKILL.name,
    name: SKILL.name,
    directory: SKILL.directory,
    scope: "project",
    projectPath: PROJECT,
    values: { local: "off" },
    effective: "off",
    decidedBy: "local",
    locked: false,
    disableModelInvocation: false,
  }],
};

describe("C8 C3-3: 프로젝트 설정 쓰기 경계", () => {
  for (const [label, entries, writable] of [
    ["미등록", [projectEntry("other")], false],
    ["비활성", [projectEntry("boundary", { path: PROJECT, active: false })], false],
    ["경로 없음", [projectEntry("boundary", { path: PROJECT, exists: false })], false],
    ["활성 등록", [projectEntry("boundary", { path: PROJECT })], true],
  ] as const) {
    it(`V2: ${label} 프로젝트의 설정 버튼을 검사한다`, () => {
      let writes = 0;
      cy.stubSnapshotField("skills", [SKILL]);
      cy.stubInvoke("get_project_registry", entries);
      // 전역 응답에는 상태를 넣지 않는다. 적용값 출현은 프로젝트 조회와
      // 레지스트리를 묶은 Promise.all의 렌더링이 끝났음을 확인한다.
      cy.stubInvoke("get_claude_settings_states", (req) => {
        const { projectPath } = req.body as { projectPath: string | null };
        req.reply({ statusCode: 200, body: projectPath === PROJECT ? SNAPSHOT : { ...SNAPSHOT, skills: [] } });
      });
      cy.stubInvoke("get_skill_detail", { statusCode: 200, body: { skill: SKILL, body: "# 프로젝트 경계", files: [] } });
      cy.stubInvoke("set_claude_skill_override", (req) => {
        writes += 1;
        req.reply({ statusCode: 200, body: SNAPSHOT });
      }).as("write");
      cy.visitApp();
      cy.openView("skills");
      cy.contains(".skill-library-row-head strong", SKILL.name).click();
      const card = ".claude-skill-settings";
      cy.get(`${card} .claude-skill-effective strong`).should("have.text", "꺼짐");
      cy.get(`${card} .claude-skill-scope select option:selected`).should("have.value", PROJECT);
      if (writable) {
        cy.get(`${card} .claude-skill-options button`).each((button) => cy.wrap(button).should("be.enabled"));
        cy.contains(`${card} button`, "상속으로 되돌리기").should("be.enabled").click();
        cy.wait("@write").its("request.body").should("deep.equal", {
          request: { overrideKey: SKILL.name, scope: "project", projectPath: PROJECT, value: null },
        });
      } else {
        // jQuery의 select.val()은 비활성 option을 값에서 제외하므로 선택된 option을 직접 확인한다.
        cy.get(`${card} .claude-skill-scope select option:selected`).should("be.disabled");
        cy.get(`${card} .claude-skill-lock-note`).should("contain.text", "현재 활성 프로젝트로 등록되지 않아");
        cy.get(`${card} .claude-skill-options button`).should("have.length", 4)
          .each((button) => cy.wrap(button).should("be.disabled"));
        cy.contains(`${card} button`, "상속으로 되돌리기").should("be.disabled");
        cy.then(() => expect(writes).to.equal(0));
      }
    });
  }
});
