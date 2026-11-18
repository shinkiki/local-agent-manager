/// <reference types="cypress" />

// AM-410 · 스킬정보(설치된 스킬) 화면의 검색어가 **어느 필드까지** 걸러내는지. 검색은 이름·설명만
// 보는 것이 아니라 번역된 이름·설명, 출처, 경로까지 함께 본다
// (SkillsView.tsx:571 matchesSkill → SkillLibraryPanel.tsx:2502 matchesNeedle).
// 값만 소문자로 내리므로 검색어를 먼저 내려 주는 쪽(SkillsView.tsx:79)이 빠지면 대문자로
// 친 검색이 조용히 0건이 된다.
//
// 검증 축: 스킬 / 조건: 검색 대상 필드 경계와 대소문자 무시.
// 기존 스펙과 다른 점 — AM-29(am29-skill-tag-filter)는 태그 칩의 복원만, AM-40은 다른
// 화면(스킬관리)의 네 축 칩만, am20260906-skill-search-chip-counts는 "설명"에 든 한 낱말로
// 검색해 칩 개수가 함께 좁는지만 봤다. 검색이 화면에 이름으로 보이지 않는 값(출처·경로)과
// 번역 결과까지 짚어 내는지, 그리고 대문자로 쳐도 같은 결과인지는 아직 아무 스펙도 없다.
//
// 격리 HOME에는 설치본이 0건이므로 스냅샷의 skills만 표본으로 갈아 끼우고, 번역 레코드는
// 실제 번역을 돌릴 수 없으니 get_menu_translations 응답으로 세운다.

const FILTERS_KEY = "agent-manager.skill-filters.v3";
const MODE_KEY = "agent-manager.skill-mode.v1";

function skill(id: string, name: string, description: string, origin: string | null, directory: string) {
  return {
    id,
    source: "claude",
    scope: "personal",
    name,
    description,
    path: `/tmp/am-qa-skills/${directory}/SKILL.md`,
    directory,
    origin,
    archived: false,
  };
}

// 필드마다 그 필드에만 있는 낱말을 심는다. 한 낱말로 검색했을 때 남는 한 건이 곧 그 필드를
// 검색이 보는지의 답이 된다.
const SAMPLE = [
  skill("alpha", "알파 러너", "공통 설명", null, "alpha"),
  skill("beta", "베타", "빌드검증도우미 설명", null, "beta"),
  skill("gamma", "감마", "공통 설명", "github.com/QA-Origin-Token", "gamma"),
  skill("delta", "델타", "공통 설명", null, "deltapathtoken"),
  skill("epsilon", "엡실론원문이름", "공통 설명", null, "epsilon"),
];

// epsilon 한 건만 번역 레코드를 갖는다. 목록의 이름·설명 자리는 번역본으로 덮이지만
// (SkillsView.tsx:230) 검색은 원문과 번역본을 함께 본다.
const TRANSLATED = {
  resourceId: "epsilon",
  fields: { name: "Epsilon Translated Token", description: "번역설명토큰" },
  updatedAt: 1_758_000_000,
};

const search = () => cy.get('input[aria-label="스킬 검색"]');
const items = () => cy.get(".skill-library-list .skill-library-item");

/** 검색어 한 낱말이 남긴 목록이 기대한 한 건인지. 이름 칸에 보이는 글자로 가른다. */
function onlyMatch(needle: string, visibleName: string): void {
  search().clear().type(needle);
  items().should("have.length", 1).find("strong").should("have.text", visibleName);
  cy.get(".toolbar-count").should("have.text", "1 / 5개");
}

describe("스킬정보 검색이 보는 필드와 대소문자", () => {
  beforeEach(() => {
    cy.stubSnapshotField("skills", SAMPLE);
    cy.stubInvoke("get_menu_translations", (request) => {
      const menu = (request.body as { menu: string }).menu;
      request.reply({
        statusCode: 200,
        body: {
          menu,
          language: "en",
          enabled: false,
          status: {
            phase: "disabled",
            total: 0,
            completed: 0,
            failed: 0,
            pending: 0,
            cached: 0,
            segmentTotal: 0,
            segmentCompleted: 0,
            segmentFailed: 0,
            segmentCached: 0,
            currentField: null,
          },
          records: menu === "skills" ? [TRANSLATED] : [],
        },
      });
    });
    cy.visitApp({
      [FILTERS_KEY]: JSON.stringify({ group: "all", tag: "all" }),
      [MODE_KEY]: "installed",
    });
    cy.openView("skills");
    items().should("have.length", 5);
  });

  it("이름·설명뿐 아니라 화면에 이름으로 보이지 않는 출처와 경로로도 한 건만 남는다", () => {
    // 이름: 목록 제목에 그대로 보이는 값.
    onlyMatch("러너", "알파 러너");

    // 설명: 제목이 아닌 본문에 든 값.
    onlyMatch("빌드검증도우미", "베타");

    // 출처: 줄 오른쪽 출처 칩의 값. 이름·설명 어디에도 없다.
    onlyMatch("qa-origin-token", "감마");

    // 경로: 줄 아래 경로 칸의 값. 여기까지 보지 않으면 경로로 스킬을 찾을 길이 없다.
    onlyMatch("deltapathtoken", "델타");
  });

  it("번역된 이름·설명과 번역에 덮인 원문 이름 모두로 찾힌다", () => {
    // 번역 레코드가 있는 줄의 제목은 번역 이름으로 덮인다 — 원문 이름은 화면에서 사라진다.
    items().find("strong").should("contain.text", "Epsilon Translated Token");
    cy.get(".skill-library-list").should("not.contain.text", "엡실론원문이름");

    // 번역 이름·설명으로 찾힌다.
    onlyMatch("Epsilon Translated", "Epsilon Translated Token");
    onlyMatch("번역설명토큰", "Epsilon Translated Token");

    // 화면에서 사라진 원문 이름으로도 찾힌다. 번역을 켠 뒤 원문 이름을 기억하는 사용자가
    // 제 스킬을 잃지 않는 쪽이다.
    onlyMatch("엡실론원문이름", "Epsilon Translated Token");
  });

  it("대문자로 쳐도 같은 한 건이 남는다", () => {
    // 비교는 값만 소문자로 내리므로 검색어를 내려 주지 않으면 대문자 검색이 0건이 된다.
    onlyMatch("QA-ORIGIN-TOKEN", "감마");
    onlyMatch("DELTAPATHTOKEN", "델타");
    onlyMatch("EPSILON TRANSLATED", "Epsilon Translated Token");
  });

  it("어느 필드에도 없는 말은 0건과 빈 안내로 떨어지고 검색어를 비우면 돌아온다", () => {
    search().type("어디에도없는낱말");
    items().should("not.exist");
    cy.contains("스킬을 찾지 못했습니다").should("be.visible");
    cy.get(".toolbar-count").should("have.text", "0 / 5개");

    search().clear();
    items().should("have.length", 5);
    cy.get(".toolbar-count").should("have.text", "5개");
  });
});
