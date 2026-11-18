/// <reference types="cypress" />
/**
 * 스킬정보(설치된 스킬) 화면을 **영어로 전환했을 때의 도달 범위**를 본다.
 *
 * 이 화면의 문구는 세 군데에서 따로 조립된다.
 * - 화면 뼈대의 `text(ko, en)` — 모드 탭·요약 줄·보관 알약·검색창·빈 상태
 *   (`src/components/SkillsView.tsx:103`·`144`·`150`·`155`·`180`).
 * - 개수 문구 — 한국어는 숫자 뒤에 `개`, 영어는 뒤에 `skills`가 붙는 **서로 다른 조립**이다
 *   (같은 파일 152·153줄). 영어에서 `개`가 남으면 바로 드러난다.
 * - 라벨 표 — 필터 칩과 범위 알약은 `text`가 아니라 `groupName`·`scopeName`이
 *   `labelLocale(locale)`을 받아 고른다(같은 파일 516·522줄). 즉 **로케일 전달 경로가
 *   화면 뼈대와 다르다.** 뼈대만 영어가 되고 라벨 표가 한국어로 남는 갈래가 구조적으로
 *   가능하다.
 * - 드로워의 메타 넉 줄도 같은 두 경로가 섞여 있다(같은 파일 338~341줄). 특히 `구성 파일`
 *   값은 한국어에서만 `개`를 붙이고 영어에서는 빈 문자열을 이어 붙인다(341줄).
 *
 * 기존 스킬 시나리오는 필터 칩 개수(AM-9·AM-10·AM-40), 일괄 선택 바, 보관 표시, 상세
 * 드로워의 구성 파일·사용 설정까지 **한국어로만** 확인했다. 다국어 축은 에이전트 정의
 * (am20260906-agents-language)·지침(am20260907-instructions-language)·문서
 * (am20260906-docs-language)·대화(am20260907-chat-screen-aria-language) 화면에만 있고,
 * 스킬 화면에는 한 건도 없다.
 *
 * 축은 스킬, 조건은 다국어 전환·화면 전환 후 잔존이다.
 */
import type { SkillSummary } from "../../src/types";

const FILTERS_KEY = "agent-manager.skill-filters.v3";
const MODE_KEY = "agent-manager.skill-mode.v1";

function skill(name: string, source: string, scope: string, archived: boolean): SkillSummary {
  return {
    id: `${source}:${scope}:${name}`,
    source,
    scope,
    name,
    description: `${name} description`,
    path: `/tmp/am20260918-skill-lang/${name}/SKILL.md`,
    directory: `/tmp/am20260918-skill-lang/${name}`,
    origin: null,
    archived,
  } as SkillSummary;
}

// 구분(공급자)·태그(범위)·보관이 서로 직교하도록 네 건을 깔아 둔다. 어느 축의 칩을 눌러도
// 남는 건수가 달라져 개수 문구가 좁혀진 꼴("N / M")로도 검사된다.
const CODEX_PERSONAL = skill("codex-personal", "codex", "personal", false);
const CODEX_ARCHIVED = skill("codex-archived", "codex", "project", true);
const CLAUDE_PLUGIN = skill("claude-plugin", "claude", "plugin", false);
const CLAUDE_ARCHIVED = skill("claude-archived", "claude", "personal", true);
const SAMPLE = [CODEX_PERSONAL, CODEX_ARCHIVED, CLAUDE_PLUGIN, CLAUDE_ARCHIVED];

const rows = () => cy.get(".skill-library-list .skill-library-item");
const count = () => cy.get(".skill-library-toolbar .toolbar-count");
const archivedPill = () => cy.get(".skill-sync-counts .skill-sync-pill");
const searchInput = () => cy.get(".skill-library-toolbar .search-input");
const axisLabels = () => cy.get(".skill-library-filterbar .skill-filter-label");

function stubDetail(): void {
  cy.stubInvoke("get_skill_detail", (req) => {
    const id = (req.body as { id: string }).id;
    const target = SAMPLE.find((entry) => entry.id === id) ?? SAMPLE[0];
    req.reply({
      statusCode: 200,
      body: {
        skill: target,
        body: `# ${target.name}`,
        // 파일 둘 — 드로워의 "구성 파일" 값이 2가 되어야 한다.
        files: [
          { name: "SKILL.md", path: `${target.directory}/SKILL.md`, isDirectory: false, children: [] },
          { name: "notes.md", path: `${target.directory}/notes.md`, isDirectory: false, children: [] },
        ],
      },
    });
  }).as("detail");
}

function openSkills(): void {
  cy.openView("skills");
  cy.get(".skill-library-filterbar").should("exist");
  rows().should("have.length", SAMPLE.length);
}

function seedAndVisit(): void {
  cy.stubSnapshotField("skills", SAMPLE);
  cy.visitApp({
    [FILTERS_KEY]: JSON.stringify({ group: "all", tag: "all" }),
    [MODE_KEY]: "installed",
  });
}

describe("스킬정보 화면의 영어 전환", () => {
  // 언어는 백엔드 설정에 남아 다음 스펙까지 따라가므로 스펙이 끝날 때 한국어로 되돌린다.
  after(() => {
    cy.restoreLanguage();
  });

  // 대조군. 영어 확인이 무엇과 달라지는지 기준을 남긴다.
  it("한국어에서는 개수에 '개'가 붙고 칩·알약이 한국어 라벨을 쓴다", () => {
    seedAndVisit();
    cy.setLanguage("ko");
    openSkills();

    cy.get(".skill-library-summary strong").should("have.text", "설치된 스킬");
    count().should("have.text", "4개");
    archivedPill().should("have.text", "보관 2");
    searchInput().should("have.attr", "placeholder", "스킬명·설명·출처 검색");
    cy.contains('[aria-label="스킬 태그 필터"] button', "모든 태그").should("exist");
    cy.contains('[aria-label="스킬 구분 필터"] button', "전체").should("exist");
    cy.get(".skill-library-list .scope-pill").then(($pills) => {
      expect([...$pills].map((pill) => pill.textContent)).to.include.members(["개인", "프로젝트", "플러그인"]);
    });
  });

  it("영어로 바꾸면 화면 뼈대에 한글이 남지 않는다", () => {
    seedAndVisit();
    cy.setLanguage("en");
    openSkills();

    // 목록 카드 본문은 사용자 데이터(스킬 이름·설명·경로)라 번역 대상이 아니다. 화면이
    // 만들어 내는 문구만 본다.
    cy.get(".skill-mode-toolbar").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".skill-library-toolbar").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".skill-library-filterbar").invoke("text").should("not.match", /[가-힣]/);
    searchInput().invoke("attr", "placeholder").should("not.match", /[가-힣]/);
    cy.get(".skill-library-list .scope-pill").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".skill-library-list .skill-archived-pill").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".skill-library-list .skill-provider-chip").invoke("text").should("not.match", /[가-힣]/);
  });

  it("영어 개수 문구는 '개' 대신 skills를 쓰고, 좁혀진 꼴에서도 같은 규칙을 지킨다", () => {
    seedAndVisit();
    cy.setLanguage("en");
    openSkills();

    count().should("have.text", "4 skills");
    archivedPill().should("have.text", "Archived 2");

    // 검색으로 좁히면 "N / M skills" 꼴이 된다. 좁혀도 보관 수는 설치본 전체 기준이다.
    searchInput().type("codex-personal");
    rows().should("have.length", 1);
    count().should("have.text", "1 / 4 skills");
    archivedPill().should("have.text", "Archived 2");

    // 0건이 되면 영어 빈 상태가 뜬다.
    searchInput().clear().type("zzz-no-such-skill");
    rows().should("not.exist");
    cy.get(".empty-state").should("contain.text", "No skills found");
    cy.get(".empty-state").should("contain.text", "Check local SKILL.md locations and your filters.");
    cy.get(".empty-state").invoke("text").should("not.match", /[가-힣]/);
  });

  it("영어 필터 칩·범위 알약이 라벨 표가 선언한 값과 같다", () => {
    seedAndVisit();
    cy.setLanguage("en");
    openSkills();

    axisLabels().invoke("text").should("not.match", /[가-힣]/);
    cy.get('[aria-label="Skill category filter"] button').then(($chips) => {
      expect([...$chips].map((chip) => chip.textContent?.replace(/\d+/g, "").trim()))
        .to.include.members(["All", "Claude", "Codex", "Antigravity", "Other"]);
    });
    cy.get('[aria-label="Skill tag filter"] button').then(($chips) => {
      expect([...$chips].map((chip) => chip.textContent?.replace(/\d+/g, "").trim()))
        .to.include.members(["All tags", "Archived", "Personal", "Project", "Plugin"]);
    });

    // 태그 칩을 눌러도 라벨 표가 한국어로 되돌아가지 않는다.
    cy.contains('[aria-label="Skill tag filter"] button', "Archived").click();
    rows().should("have.length", 2);
    cy.get(".skill-library-list .scope-pill").then(($pills) => {
      expect([...$pills].map((pill) => pill.textContent)).to.have.members(["Project", "Personal"]);
    });
    cy.get(".skill-library-list .skill-archived-pill").each(($pill) => {
      cy.wrap($pill).should("have.text", "Archived");
    });
  });

  it("영어 드로워의 메타 넉 줄과 설명 제목에 한글이 남지 않고 구성 파일 값은 숫자만 남는다", () => {
    stubDetail();
    seedAndVisit();
    cy.setLanguage("en");
    openSkills();

    cy.contains(".skill-library-row-head strong", CODEX_PERSONAL.name).click();
    cy.get(".drawer").should("exist");
    cy.wait("@detail");

    cy.get(".drawer .meta-grid > div > span").then(($labels) => {
      expect([...$labels].map((node) => node.textContent))
        .to.deep.equal(["Scope", "Source", "File", "Files"]);
    });
    cy.get(".drawer .meta-grid").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".drawer .meta-grid > div").eq(0).find("strong").should("have.text", "Personal");
    cy.get(".drawer .meta-grid > div").eq(1).find("strong").should("have.text", "Local");
    // 한국어는 "2개", 영어는 뒤에 빈 문자열이 붙어 숫자만 남는다(SkillsView.tsx:341).
    cy.get(".drawer .meta-grid > div").eq(3).find("strong").should("have.text", "2");
    cy.get(".drawer .section-title h3").invoke("text").should("not.match", /[가-힣]/);
  });

  // 언어는 라벨만 바꾼다. 고른 칩은 `agent-manager.skill-filters.v3`에 값(claude/personal)으로
  // 남으므로, 영어로 바꿔도 같은 칩이 눌린 채여야 하고 한국어로 되돌려도 그대로여야 한다.
  it("언어를 바꿔도 고른 구분·태그 칩 선택은 그대로 남는다", () => {
    seedAndVisit();
    // 언어는 백엔드 설정에 남아 앞선 it이 남긴 영어가 따라온다. 한국어에서 시작하는 걸음이므로
    // 명시적으로 되돌려 놓고 시작한다.
    cy.setLanguage("ko");
    openSkills();

    cy.contains('[aria-label="스킬 구분 필터"] button', "Claude").click()
      .should("have.attr", "aria-pressed", "true");
    cy.contains('[aria-label="스킬 태그 필터"] button', "개인").click()
      .should("have.attr", "aria-pressed", "true");
    rows().should("have.length", 1);

    cy.setLanguage("en");
    cy.openView("skills");
    cy.contains('[aria-label="Skill category filter"] button', "Claude")
      .should("have.attr", "aria-pressed", "true");
    cy.contains('[aria-label="Skill tag filter"] button', "Personal")
      .should("have.attr", "aria-pressed", "true");
    rows().should("have.length", 1);
    count().should("have.text", "1 / 4 skills");

    // 저장이 백엔드에 닿기 전에 화면을 옮기면 앞선 영어 저장이 뒤늦게 되밀려 온다. 내비
    // 이름표가 한국어가 될 때까지 기다린 뒤에 옮긴다(languageCommands.ts:27의 같은 이유).
    cy.setLanguage("ko");
    cy.anchor("nav.settings").should("contain.text", "설정");
    cy.openView("skills");
    cy.contains('[aria-label="스킬 구분 필터"] button', "Claude")
      .should("have.attr", "aria-pressed", "true");
    cy.contains('[aria-label="스킬 태그 필터"] button', "개인")
      .should("have.attr", "aria-pressed", "true");
    count().should("have.text", "1 / 4개");
  });

  it("다른 화면을 들렀다 돌아와도 영어가 그대로 남는다", () => {
    seedAndVisit();
    cy.setLanguage("en");
    openSkills();
    count().should("have.text", "4 skills");

    cy.openView("dashboard");
    cy.openView("skills");
    cy.get(".skill-library-filterbar").should("exist");
    count().should("have.text", "4 skills");
    cy.get(".skill-library-toolbar").invoke("text").should("not.match", /[가-힣]/);
  });
});
