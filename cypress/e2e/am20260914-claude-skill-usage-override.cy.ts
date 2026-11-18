/**
 * 스킬 → 스킬정보 → 설치본 드로워의 '사용 설정'. Claude 설치 스킬의 on/이름만/직접
 * 호출만/꺼짐 재정의를 전역과 프로젝트 두 범위에서 쓰는 자리다
 * (SkillsView.tsx:395-460, 목록의 상태 표시는 SkillsView.tsx:464-474).
 *
 * 지금까지의 스킬 시나리오(AM-9·AM-10 필터, AM-40 출처 칩, AM-108 일괄 작업 바,
 * AM-307 제안 팩, AM-310 일괄 마이그레이션, AM-238 스캔 배너)는 목록·필터·툴바만 봤고,
 * 드로워의 사용 설정은 어느 스펙도 열어 본 적이 없다. `set_claude_skill_override`를
 * 건드리는 스펙은 저장소에 하나도 없고, `get_claude_settings_states`를 쓰는 스펙은
 * 애드온 플러그인 카드(am20260912-claude-plugin-branch-rules) 하나뿐이다.
 *
 * 축은 스킬, 조건은 권한·접근 통제(관리 정책 잠금·원격 읽기 전용)와 화면 전환 뒤의
 * 재조회(적용 범위를 바꾸면 그 범위 값으로 다시 읽는가)다.
 *
 * 확인하는 것:
 *  - 목록 한 줄의 상태 배지가 유효값을 그대로 보여 주고, 꺼진 스킬만 흐리게 표시된다
 *  - 전역 범위에서 명시값이 없으면 '상속으로 되돌리기'가 없고, 값을 고르면 scope=user·
 *    projectPath=null로 나가며 응답 뒤 되돌리기가 생긴다
 *  - 적용 범위를 프로젝트로 바꾸면 그 경로로 다시 조회하고, 프로젝트 명시값(local)이
 *    되돌리기를 띄우며 되돌리기는 scope=project·value=null로 나간다
 *  - 관리 정책으로 잠긴 스킬은 네 버튼이 모두 잠기고 그 사유가 화면에 뜬다
 */
import type { ClaudeSettingsSnapshot, ClaudeSkillOverrideState, SkillOverrideValue, SkillSummary } from "../../src/types";
import { projectEntry } from "../support/projectRegistryFixtures";

const HOME_SKILLS = "/tmp/amskillov/.claude/skills";
const PROJECT = "/tmp/amproj/demo";

function skill(key: string, name: string): SkillSummary {
  return {
    id: `claude:personal:${key}`,
    source: "claude",
    scope: "personal",
    name,
    description: `${name} 설명`,
    path: `${HOME_SKILLS}/${key}/SKILL.md`,
    directory: `${HOME_SKILLS}/${key}`,
    origin: null,
    archived: false,
  };
}

const ALPHA = skill("alpha", "알파");
const BRAVO = skill("bravo", "브라보");
const CHARLIE = skill("charlie", "찰리");
const SKILLS = [ALPHA, BRAVO, CHARLIE];

function override(
  target: SkillSummary,
  effective: SkillOverrideValue,
  extra: Partial<ClaudeSkillOverrideState> = {},
): ClaudeSkillOverrideState {
  return {
    overrideKey: target.name,
    name: target.name,
    directory: target.directory,
    scope: "personal",
    projectPath: null,
    values: {},
    effective,
    decidedBy: null,
    locked: false,
    disableModelInvocation: false,
    ...extra,
  };
}

function settings(skills: ClaudeSkillOverrideState[]): ClaudeSettingsSnapshot {
  return {
    scopes: { user: { path: "/tmp/amskillov/.claude/settings.json", exists: true } },
    plugins: [],
    skills,
  };
}

/** 전역 범위. 알파는 상속(명시값 없음), 브라보는 전역에서 끔, 찰리는 관리 정책으로 잠김. */
const GLOBAL = settings([
  override(ALPHA, "on"),
  override(BRAVO, "off", { values: { user: "off" }, decidedBy: "user" }),
  override(CHARLIE, "name-only", { values: { policy: "name-only" }, decidedBy: "policy", locked: true }),
]);

/** 알파를 전역에서 끈 뒤의 응답. 명시값이 생겨 되돌리기가 붙어야 한다. */
const GLOBAL_AFTER_OFF = settings([
  override(ALPHA, "off", { values: { user: "off" }, decidedBy: "user" }),
  ...GLOBAL.skills.slice(1),
]);

/** 프로젝트 범위. 쓰기 대상이 settings.local.json이라 명시값은 local에 선다. */
const PROJECT_SCOPED = settings([
  override(ALPHA, "off", { values: { local: "off" }, decidedBy: "local" }),
  ...GLOBAL.skills.slice(1),
]);

const options = () => cy.get(".claude-skill-settings .claude-skill-options button");
const effective = () => cy.get(".claude-skill-settings .claude-skill-effective");
const scopeSelect = () => cy.get(".claude-skill-settings .claude-skill-scope select");

function openSkills(global: ClaudeSettingsSnapshot = GLOBAL): void {
  cy.stubSnapshotField("skills", SKILLS);
  cy.stubInvoke("get_claude_settings_states", (req) => {
    const { projectPath } = req.body as { projectPath: string | null };
    req.reply({ statusCode: 200, body: projectPath === PROJECT ? PROJECT_SCOPED : global });
  }).as("states");
  cy.stubInvoke("get_project_registry", [projectEntry("demo", { path: PROJECT })]);
  cy.stubInvoke("get_skill_detail", (req) => {
    const id = (req.body as { id: string }).id;
    const target = SKILLS.find((entry) => entry.id === id) ?? ALPHA;
    req.reply({ statusCode: 200, body: { skill: target, body: `# ${target.name}\n\n본문.`, files: [] } });
  });
  cy.visitApp();
  cy.openView("skills");
  cy.get(".skill-library-list > .skill-library-item").should("have.length", 3);
}

function openDrawer(target: SkillSummary): void {
  cy.contains(".skill-library-row-head strong", target.name).click();
  cy.get(".drawer .claude-skill-settings").should("exist");
}

describe("설치된 Claude 스킬의 사용 설정 재정의", () => {
  it("목록 배지는 유효값을 그대로 보여 주고 꺼진 스킬만 흐리게 선다", () => {
    openSkills();

    cy.get(".skill-library-list > .skill-library-item").as("rows");
    cy.get("@rows").eq(0).find(".skill-state-pill").should("have.text", "사용").and("not.have.class", "off");
    cy.get("@rows").eq(0).should("not.have.class", "skill-disabled");

    cy.get("@rows").eq(1).find(".skill-state-pill").should("have.text", "꺼짐").and("have.class", "off");
    cy.get("@rows").eq(1).should("have.class", "skill-disabled");

    // 잠겨 있어도 '이름만'이라 흐려지지는 않는다 — 꺼짐만 흐려진다.
    cy.get("@rows").eq(2).find(".skill-state-pill").should("have.text", "이름만");
    cy.get("@rows").eq(2).should("not.have.class", "skill-disabled");
  });

  it("전역 범위에서 상속이면 되돌리기가 없고, 고른 값은 scope=user로 나간다", () => {
    openSkills();
    cy.stubInvoke("set_claude_skill_override", (req) => {
      req.reply({ statusCode: 200, body: GLOBAL_AFTER_OFF });
    }).as("write");
    openDrawer(ALPHA);

    scopeSelect().should("have.value", "");
    options().should("have.length", 4);
    options().contains("사용").should("have.attr", "aria-pressed", "true");
    effective().find("strong").should("have.text", "사용");
    // 전역 명시값이 없으니 결정 근거 표시도 되돌리기도 없다.
    effective().find("small").should("not.exist");
    effective().find("button").should("not.exist");

    options().contains("꺼짐").click();
    cy.wait("@write").its("request.body").should("deep.equal", {
      request: { overrideKey: "알파", scope: "user", projectPath: null, value: "off" },
    });

    // 응답이 명시값을 들고 오면 되돌리기가 생기고 유효값이 따라 바뀐다.
    options().contains("꺼짐").should("have.attr", "aria-pressed", "true");
    effective().find("strong").should("have.text", "꺼짐");
    effective().find("small").should("have.text", "전역 설정에서 결정");
    effective().contains("button", "상속으로 되돌리기").should("be.enabled");
  });

  it("적용 범위를 프로젝트로 바꾸면 그 경로로 다시 읽고 되돌리기는 scope=project로 나간다", () => {
    openSkills();
    cy.stubInvoke("set_claude_skill_override", (req) => {
      req.reply({ statusCode: 200, body: GLOBAL });
    }).as("write");
    openDrawer(ALPHA);

    scopeSelect().select(PROJECT);
    // 같은 스킬을 프로젝트 범위로 다시 조회한다. 화면 진입·드로워 열기에서 이미 전역
    // 조회가 몇 번 나가 있으므로 순서로 집지 않고 나간 경로 전체에서 확인한다.
    cy.get("@states.all").should((calls: unknown) => {
      const paths = (calls as { request: { body: { projectPath: string | null } } }[])
        .map((call) => call.request.body.projectPath);
      expect(paths).to.include(PROJECT);
    });

    options().contains("꺼짐").should("have.attr", "aria-pressed", "true");
    effective().find("strong").should("have.text", "꺼짐");
    effective().find("small").should("have.text", "프로젝트 로컬 설정에서 결정");

    effective().contains("button", "상속으로 되돌리기").click();
    cy.wait("@write").its("request.body").should("deep.equal", {
      request: { overrideKey: "알파", scope: "project", projectPath: PROJECT, value: null },
    });
  });

  it("관리 정책으로 잠긴 스킬은 네 버튼이 모두 잠기고 사유가 뜬다", () => {
    openSkills();
    openDrawer(CHARLIE);

    options().should("have.length", 4).each((button) => {
      cy.wrap(button).should("be.disabled");
    });
    effective().find("small").should("have.text", "관리 정책에서 결정");
    cy.get(".claude-skill-settings .claude-skill-lock-note")
      .should("contain.text", "관리 정책 또는 알 수 없는 사용자 지정 값이 우선해");
  });

  it("C8 V2: 저장 전 조회가 늦게 도착해도 저장한 사용 설정을 되돌리지 않는다", () => {
    openSkills();
    // 목록이 전역 설정을 받은 뒤 드로워의 첫 조회만 보류한다.
    cy.get(".skill-library-item").first().find(".skill-state-pill").should("have.text", "사용");
    let releaseRead: (() => void) | undefined;
    let readHeld = false;
    cy.stubInvoke("get_claude_settings_states", (req) => {
      if (readHeld) {
        req.reply({ statusCode: 200, body: GLOBAL_AFTER_OFF });
        return;
      }
      readHeld = true;
      req.alias = "staleSettings";
      return new Cypress.Promise<void>((resolve) => {
        releaseRead = () => {
          req.reply({ statusCode: 200, body: GLOBAL });
          resolve();
        };
      });
    });
    cy.stubInvoke("set_claude_skill_override", GLOBAL_AFTER_OFF).as("write");
    openDrawer(ALPHA);
    cy.wrap(null).should(() => expect(releaseRead).to.be.a("function"));
    scopeSelect().find(`option[value="${PROJECT}"]`).should("not.exist");

    options().contains("꺼짐").click();
    cy.wait("@write");
    effective().find("strong").should("have.text", "꺼짐");
    effective().find("small").should("have.text", "전역 설정에서 결정");

    cy.then(() => { releaseRead!(); });
    cy.wait("@staleSettings");
    // 프로젝트 선택지는 같은 Promise.all의 결과이므로 늦은 조회가 처리된 렌더링을 증명한다.
    scopeSelect().find(`option[value="${PROJECT}"]`).should("exist");
    effective().find("strong").should("have.text", "꺼짐");
    options().contains("꺼짐").should("have.attr", "aria-pressed", "true");
    effective().contains("button", "상속으로 되돌리기").should("be.enabled");
  });

});
