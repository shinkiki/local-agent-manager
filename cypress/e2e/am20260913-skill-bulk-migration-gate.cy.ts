/**
 * 스킬 → 스킬관리 툴바의 '일괄 마이그레이션' 버튼 게이팅과 'OS 변형 필요' 개수 배지.
 *
 * 이 버튼은 SkillsView.tsx:133-143에 있지만 개수는 SkillLibraryPanel.tsx:332의
 * managedEntries에서 세어 onMigrationRequiredCount로 위 화면에 올라온다. 지금까지의
 * 스킬 시나리오(AM-40·AM-58·AM-87·AM-246 계열)는 필터바·일괄 작업 바·제안 팩 카드만
 * 봤고, 두 컴포넌트에 걸친 이 개수 전달과 버튼의 비활성 사유 안내는 어느 스펙도
 * 확인하지 않았다.
 *
 * 축은 스킬, 조건은 권한·접근 통제(연결된 시스템 에이전트가 없는 상태)와 목록 필터링
 * 후의 값 잔존.
 * 확인하는 것:
 *  - 배지 개수는 managed 항목의 migrationRequired만 세고 unmanaged 항목은 빼준다
 *  - 시스템 에이전트가 없는 격리 백엔드에서는 버튼이 비활성이고 그 사유를 title로 알린다
 *  - 검색으로 목록을 좁혀도 배지 개수는 전체 기준이라 그대로다
 *  - 변형이 필요한 스킬이 없으면 배지가 사라지고 title이 다른 사유로 바뀐다
 *  - 영어로 바꾸면 버튼 문구와 사유 안내도 함께 영어가 된다
 */
import { skillLibraryFixtures, openSkillLibrary, SKILL_FILTERS_KEY } from "../support/skillLibraryFixtures";

const { entry, library, providerState } = skillLibraryFixtures("/tmp/ammigrategate");

function managed(key: string, migrationRequired: boolean) {
  return { ...entry(key, { common: true, providers: [providerState("claude")] }), migrationRequired };
}

/** 목록에 나오지 않는 항목도 개수에 섞이는지 보려고 managed=false 하나를 같이 둔다. */
const UNMANAGED = { ...managed("outsider", true), managed: false };

const LIBRARY = library([managed("alpha", true), managed("bravo", false), managed("charlie", true), UNMANAGED]);
const CLEAN_LIBRARY = library([managed("alpha", false), managed("bravo", false)]);

const NEEDS_AGENT = "연결된 시스템 에이전트를 설정하세요";

function migrateButton() {
  return cy.get(".skill-mode-toolbar .skill-transfer-buttons button");
}

describe("스킬관리 일괄 마이그레이션 버튼의 게이팅과 OS 변형 필요 개수", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("배지는 managed 항목의 변형 필요 개수만 세고 버튼은 에이전트 없음 사유로 비활성이다", () => {
    cy.stubInvoke("get_skill_library", { statusCode: 200, body: LIBRARY });
    openSkillLibrary();

    // 목록에는 managed 세 건만 나오고 그중 둘에 'OS 변형 필요' 표시가 붙는다.
    cy.get(".skill-library-list > .skill-library-item").should("have.length", 3);
    cy.get(".skill-library-list .skill-sync-pill.conflict").should("have.length", 2);

    migrateButton().should("contain.text", "일괄 마이그레이션");
    migrateButton().find("small").should("have.text", "2");
    migrateButton().should("be.disabled").and("have.attr", "title", NEEDS_AGENT);
  });

  it("검색으로 목록을 좁혀도 배지 개수는 전체 기준으로 남는다", () => {
    cy.stubInvoke("get_skill_library", { statusCode: 200, body: LIBRARY });
    openSkillLibrary();
    migrateButton().find("small").should("have.text", "2");

    cy.get(".skill-library-toolbar .search-input").type("bravo");
    cy.get(".skill-library-list > .skill-library-item").should("have.length", 1);
    cy.get(".skill-library-list .skill-sync-pill.conflict").should("not.exist");
    migrateButton().find("small").should("have.text", "2");
  });

  it("변형이 필요한 스킬이 없으면 배지가 사라진다", () => {
    cy.stubInvoke("get_skill_library", { statusCode: 200, body: CLEAN_LIBRARY });
    openSkillLibrary();

    cy.get(".skill-library-list > .skill-library-item").should("have.length", 2);
    migrateButton().should("be.disabled");
    migrateButton().find("small").should("not.exist");
  });

  it("영어로 바꾸면 버튼 문구와 비활성 사유도 영어가 된다", () => {
    cy.stubInvoke("get_skill_library", { statusCode: 200, body: LIBRARY });
    cy.visitApp({ [SKILL_FILTERS_KEY]: JSON.stringify({ kind: "all", state: "all", agent: "all", origin: "all" }) });
    cy.setLanguage("en");
    cy.openView("skills");
    cy.get(".skill-mode-tabs button").eq(1).should("have.text", "Manage").click();

    migrateButton().should("contain.text", "Migrate all");
    migrateButton().find("small").should("have.text", "2");
    migrateButton().should("have.attr", "title", "Configure a connected system agent");
    cy.get(".skill-library-list .skill-sync-pill.conflict").first().should("have.text", "OS variant required");
  });
});
