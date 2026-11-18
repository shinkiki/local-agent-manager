/**
 * 스킬정보(설치된 스킬) 화면에서 **보관 설치본을 알리는 세 자리**가 서로 어긋나지
 * 않는지 본다.
 *
 * - 요약 줄의 `보관 N` 알약은 `archivedInstalls`가 센다(SkillsView.tsx:107). 이 값은
 *   `filtered`가 아니라 `skills` 전체에서 세므로, 검색·필터로 목록이 좁혀져도 숫자가
 *   따라 줄면 안 된다 — "설치본 중 보관본이 몇 개인가"를 알리는 자리다.
 * - 줄 카드는 `skill.archived`일 때 `.skill-archived-pill`을 붙이고 행에
 *   `is-shared`를 더한다(같은 파일 245·260줄).
 * - 드로워 제목도 같은 알약을 단다(같은 파일 336줄).
 *
 * 기존 스킬 시나리오는 필터 칩 개수(AM-9·AM-10·AM-40, am20260906-skill-search-chip-counts),
 * 스킬관리 쪽 보관 목록의 일괄 작업 바(AM-108), 상세 드로워의 구성 파일·사용 설정
 * (am20260917-skill-detail-file-tree, am20260914-claude-skill-usage-override)까지만 봤다.
 * **보관 표시 자체**가 요약 줄·행·드로워 세 자리에서 같은 사실을 말하는지, 그리고 요약
 * 줄의 수가 필터에 휘둘리지 않는지는 어느 시나리오도 확인한 적이 없다.
 *
 * 축은 스킬, 조건은 경계값(보관 0건)·화면 전환 후 잔존·다국어 전환이다.
 */
import type { SkillSummary } from "../../src/types";

const FILTERS_KEY = "agent-manager.skill-filters.v3";
const MODE_KEY = "agent-manager.skill-mode.v1";

function skill(key: string, scope: string, archived: boolean): SkillSummary {
  return {
    id: `codex:${scope}:${key}`,
    source: "codex",
    scope,
    name: key,
    description: `${key} 설명`,
    path: `/tmp/am20260917-archived/${key}/SKILL.md`,
    directory: `/tmp/am20260917-archived/${key}`,
    origin: null,
    archived,
  } as SkillSummary;
}

// 보관 2건(개인·프로젝트)과 비보관 2건. 보관은 scope 축과 직교하므로 두 scope에 걸쳐 둔다.
const ARCHIVED_A = skill("보관가", "personal", true);
const ARCHIVED_B = skill("보관나", "project", true);
const LIVE_A = skill("생생가", "personal", false);
const LIVE_B = skill("생생나", "plugin", false);
const SAMPLE = [ARCHIVED_A, LIVE_A, ARCHIVED_B, LIVE_B];

const rows = () => cy.get(".skill-library-list .skill-library-item");
const summaryPill = () => cy.get(".skill-sync-counts .skill-sync-pill");
const search = () => cy.get('input[aria-label="스킬 검색"]');
const tagChip = (label: string) => cy.contains('[aria-label="스킬 태그 필터"] button', label);

function stubDetail(): void {
  cy.stubInvoke("get_skill_detail", (req) => {
    const id = (req.body as { id: string }).id;
    const target = SAMPLE.find((entry) => entry.id === id) ?? SAMPLE[0];
    req.reply({ statusCode: 200, body: { skill: target, body: `# ${target.name}`, files: [] } });
  }).as("detail");
}

function openSkills(sample: SkillSummary[] = SAMPLE): void {
  cy.stubSnapshotField("skills", sample);
  cy.visitApp({
    [FILTERS_KEY]: JSON.stringify({ group: "all", tag: "all" }),
    [MODE_KEY]: "installed",
  });
  cy.openView("skills");
  cy.get(".skill-library-filterbar").should("exist");
  rows().should("have.length", sample.length);
}

describe("스킬정보의 보관 설치본 표시", () => {
  it("요약 줄의 보관 수는 설치본 전체 기준이라 검색·필터로 목록이 좁아져도 줄지 않는다", () => {
    openSkills();

    summaryPill().should("have.text", "보관 2");
    cy.get(".toolbar-count").should("have.text", "4개");

    // 1) 검색으로 비보관 1건만 남겨도 보관 수는 그대로다.
    search().type("생생가");
    rows().should("have.length", 1);
    cy.get(".toolbar-count").should("have.text", "1 / 4개");
    summaryPill().should("have.text", "보관 2");

    // 2) 아무것도 맞지 않는 검색어로 0건이 되어도 마찬가지다.
    search().clear().type("없는말");
    rows().should("not.exist");
    cy.contains("스킬을 찾지 못했습니다").should("be.visible");
    summaryPill().should("have.text", "보관 2");

    // 3) 태그 필터로 비보관만 남겨도 요약 줄은 설치본 기준을 지킨다.
    search().clear();
    tagChip("플러그인").click().should("have.attr", "aria-pressed", "true");
    rows().should("have.length", 1);
    summaryPill().should("have.text", "보관 2");
  });

  it("보관 태그 필터는 scope와 무관하게 보관본만 남기고, 행과 드로워가 같은 알약을 단다", () => {
    stubDetail();
    openSkills();

    // 보관은 scope 축과 직교한다 — 개인·프로젝트 두 scope의 보관본이 함께 남아야 한다.
    tagChip("보관").click().should("have.attr", "aria-pressed", "true");
    rows().should("have.length", 2);
    rows().each(($row) => {
      cy.wrap($row).find(".skill-archived-pill").should("have.text", "보관");
      cy.wrap($row).find(".skill-library-row").should("have.class", "is-shared");
    });
    cy.get(".skill-library-list .scope-pill").then(($pills) => {
      expect([...$pills].map((pill) => pill.textContent)).to.have.members(["개인", "프로젝트"]);
    });

    // 드로워 제목에도 같은 알약이 붙는다.
    cy.contains(".skill-library-row-head strong", ARCHIVED_B.name).click();
    cy.get(".drawer").should("exist");
    cy.get(".drawer .skill-archived-pill").should("have.text", "보관");

    // 비보관 스킬로 갈아타면 알약이 남지 않는다 — 드로워는 selected가 바뀌면 다시 그린다.
    cy.get(".drawer [aria-label='닫기']").click();
    cy.get(".drawer").should("not.exist");
    tagChip("모든 태그").click();
    rows().should("have.length", 4);
    cy.contains(".skill-library-row-head strong", LIVE_A.name).click();
    cy.get(".drawer .detail-card.meta-grid").should("exist");
    cy.get(".drawer .skill-archived-pill").should("not.exist");
    rows().filter(":has(.skill-archived-pill)").should("have.length", 2);
  });

  it("보관본이 없으면 요약 알약이 아예 서지 않고, 영어 UI에서는 Archived로 적는다", () => {
    openSkills([LIVE_A, LIVE_B]);

    // 0건일 때는 "보관 0"이 아니라 알약 자체가 없어야 한다.
    summaryPill().should("not.exist");
    cy.get(".toolbar-count").should("have.text", "2개");
    cy.get(".skill-archived-pill").should("not.exist");

    // 언어는 백엔드 설정에 남으므로 다시 띄워도 영어가 유지된다. 표본만 보관 포함으로 바꾼다.
    cy.setLanguage("en");
    openSkills(SAMPLE);
    summaryPill().should("have.text", "Archived 2");
    cy.get(".skill-library-list .skill-archived-pill").should("have.length", 2).first().should("have.text", "Archived");
    cy.restoreLanguage();
  });
});
