/**
 * 스킬정보(설치된 스킬) 화면에서 "검색어"가 구분·태그 칩 개수와 요약 카운트에 어떻게
 * 반영되는지. AM-29는 설치본 0건에서 태그 필터의 복원·되돌리기만 봤고, AM-40은 다른
 * 화면(스킬관리)의 네 축 칩을 봤다. 검색어가 두 축의 칩 개수를 함께 좁히는 계약과,
 * 검색 때문에 0건이 된 "고른 칩"이 잠기지 않아 되돌아올 수 있는지는 아직 없다.
 *
 * 설치본은 격리 HOME이라 0건이므로, 스냅샷 응답의 skills만 표본으로 갈아 끼운다.
 */
const FILTERS_KEY = "agent-manager.skill-filters.v3";
const MODE_KEY = "agent-manager.skill-mode.v1";

function skill(id: string, source: string, scope: string, archived: boolean, description: string) {
  return {
    id,
    source,
    scope,
    name: id,
    description,
    path: `/tmp/am-qa-skills/${id}/SKILL.md`,
    directory: id,
    origin: null,
    archived,
  };
}

// 구분과 태그가 서로 다른 값을 갖도록 짠 표본. 설명의 "핵심표본"은 alpha·gamma 둘만
// 갖는다 — 검색으로 두 건만 남기되 두 건의 구분·태그가 갈리게 하려는 것이다.
const SAMPLE = [
  skill("alpha", "claude", "personal", false, "핵심표본 스킬"),
  skill("beta", "claude", "project", false, "부표본 스킬"),
  skill("gamma", "codex", "personal", true, "핵심표본 스킬"),
  skill("delta", "codex", "plugin", false, "부표본 스킬"),
  skill("epsilon", "gemini", "system", false, "부표본 스킬"),
];

function chip(group: string, label: string) {
  return cy.get(`.source-tabs[role="group"][aria-label="${group}"]`).contains("button", label);
}

function chipCount(group: string, label: string, expected: string) {
  return chip(group, label).find("small").should("have.text", expected);
}

const GROUP = "스킬 구분 필터";
const TAG = "스킬 태그 필터";

describe("스킬정보 검색어와 필터 칩 개수", () => {
  beforeEach(() => {
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        (res.body as { skills: unknown[] }).skills = SAMPLE;
      });
    });
    cy.visitApp({
      [FILTERS_KEY]: JSON.stringify({ group: "all", tag: "all" }),
      [MODE_KEY]: "installed",
    });
    cy.openView("skills");
    cy.get(".skill-library-filterbar").should("exist");
    cy.get(".skill-library-list .skill-library-item").should("have.length", 5);
  });

  it("검색어가 없으면 카운트에 분모가 없고 칩은 표본 전체를 축별로 센다", () => {
    cy.get(".toolbar-count").should("have.text", "5개");
    chipCount(GROUP, "전체", "5");
    chipCount(GROUP, "Claude", "2");
    chipCount(GROUP, "Codex", "2");
    chipCount(GROUP, "기타", "1");
    chipCount(GROUP, "Antigravity", "0");
    chipCount(TAG, "보관", "1");
    chipCount(TAG, "개인", "2");
    chipCount(TAG, "프로젝트", "1");
    chipCount(TAG, "플러그인", "1");
    chipCount(TAG, "시스템", "1");
  });

  it("검색어를 넣으면 두 축의 칩 개수가 함께 좁혀지고 카운트에 분모가 붙는다", () => {
    cy.get('input[aria-label="스킬 검색"]').type("핵심표본");
    cy.get(".skill-library-list .skill-library-item").should("have.length", 2);
    cy.get(".toolbar-count").should("have.text", "2 / 5개");

    // 남은 두 건은 alpha(claude·개인)와 gamma(codex·개인·보관)다.
    chipCount(GROUP, "Claude", "1");
    chipCount(GROUP, "Codex", "1");
    chipCount(GROUP, "기타", "0");
    chipCount(TAG, "개인", "2");
    chipCount(TAG, "보관", "1");
    chipCount(TAG, "프로젝트", "0");

    // 검색 결과 밖으로 밀려난 칩은 잠겨서 헛발질을 막는다.
    chip(GROUP, "기타").should("be.disabled");
    chip(TAG, "프로젝트").should("be.disabled");
  });

  it("검색으로 0건이 되어도 고른 칩은 잠기지 않아 전체로 되돌아올 수 있다", () => {
    cy.get('input[aria-label="스킬 검색"]').type("핵심표본");
    chip(GROUP, "Codex").click().should("have.attr", "aria-pressed", "true");
    cy.get(".skill-library-list .skill-library-item").should("have.length", 1);
    // 태그 축은 고른 구분(codex)까지 적용해 다시 센다.
    chipCount(TAG, "개인", "1");
    chipCount(TAG, "보관", "1");

    // 검색어를 아무것도 맞지 않는 값으로 바꾸면 고른 구분의 개수까지 0이 된다.
    cy.get('input[aria-label="스킬 검색"]').clear().type("없는말");
    cy.get(".skill-library-list .skill-library-item").should("not.exist");
    cy.contains("스킬을 찾지 못했습니다").should("be.visible");
    cy.get(".toolbar-count").should("have.text", "0 / 5개");
    chipCount(GROUP, "Codex", "0");
    // 고른 칩이 잠기면 되돌릴 길이 없어진다. 잠기지 않아야 한다.
    chip(GROUP, "Codex").should("be.enabled").and("have.attr", "aria-pressed", "true");
    chip(GROUP, "전체").should("be.enabled").click();

    cy.get(".toolbar-count").should("have.text", "0 / 5개");
    cy.get('input[aria-label="스킬 검색"]').clear();
    cy.get(".skill-library-list .skill-library-item").should("have.length", 5);
    cy.get(".toolbar-count").should("have.text", "5개");
  });
});
