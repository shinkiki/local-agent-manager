// 임시 스펙: 스킬 화면의 모드 탭(스킬정보/스킬관리)이 자체 저장 키
// `agent-manager.skill-mode.v1`로 새로고침을 넘겨 복원되는지, 알 수 없는 값이
// 스킬정보로 떨어지는지, 그리고 모드를 오갔다 돌아왔을 때 검색어가 살아 있고
// 새로고침에는 사라지는지. AM-29·AM-40은 필터 축의 저장·복원만 봤고, 모드 탭의
// 저장 키와 모드 왕복 뒤 검색어 잔존은 아직 어느 시나리오도 확인하지 않았다.
import { skillLibraryFixtures } from "../support/skillLibraryFixtures";

const MODE_KEY = "agent-manager.skill-mode.v1";
const { library } = skillLibraryFixtures("/tmp/am-skill-mode");
const EMPTY_LIBRARY = library([]);

// 스킬정보와 스킬관리는 같은 `.skill-library-toolbar` 클래스를 쓴다. 두 화면을
// 가르는 것은 그 안의 검색 칸 aria-label이다.
const installedToolbar = () => cy.get('.skill-library-toolbar:has(.search-input[aria-label="스킬 검색"])');
const libraryToolbar = () => cy.get('.skill-library-toolbar:has(.search-input[aria-label="보관 스킬 검색"])');
const installedSearch = () => installedToolbar().find('.search-input[aria-label="스킬 검색"]');
const modeTabs = () => cy.get('.skill-mode-tabs[role="group"][aria-label="스킬 화면 모드"]');
const modeButton = (label: string) => modeTabs().contains("button", label);

function openSkills(seed?: Record<string, string>): void {
  cy.visitApp(seed);
  cy.openView("skills");
  modeTabs().should("exist");
}

describe("스킬 화면 모드 탭의 저장·복원과 모드 왕복 뒤 검색어 잔존", () => {
  beforeEach(() => {
    cy.stubInvoke("get_skill_library", EMPTY_LIBRARY);
  });

  it("기본은 스킬정보이고, 스킬관리를 고르면 저장 키에 남아 새로고침 뒤 복원된다", () => {
    openSkills();

    // 1) 아무것도 심지 않으면 스킬정보가 눌린 상태이고, 설치본 목록 툴바가 보인다.
    modeButton("스킬정보").should("have.attr", "aria-pressed", "true");
    modeButton("스킬관리").should("have.attr", "aria-pressed", "false");
    installedToolbar().should("exist");

    // 2) 화면을 연 것만으로 현재 모드가 저장 키에 적힌다.
    cy.window().its("localStorage").invoke("getItem", MODE_KEY).should("eq", "installed");

    // 3) 스킬관리로 옮기면 설치본 툴바가 사라지고 저장값이 바뀐다.
    modeButton("스킬관리").click();
    modeButton("스킬관리").should("have.attr", "aria-pressed", "true");
    installedToolbar().should("not.exist");
    libraryToolbar().should("exist");
    cy.window().its("localStorage").invoke("getItem", MODE_KEY).should("eq", "library");

    // 4) 새로고침하고 스킬 화면을 다시 열면 스킬관리로 복원된다.
    cy.reload();
    cy.openView("skills");
    modeButton("스킬관리").should("have.attr", "aria-pressed", "true");
    installedToolbar().should("not.exist");
    libraryToolbar().should("exist");
  });

  it("알 수 없는 저장값은 스킬정보로 떨어지고 저장값도 정규화된다", () => {
    openSkills({ [MODE_KEY]: "무엇인가" });

    // 5) 알 수 없는 값은 기본 모드로 떨어진다.
    modeButton("스킬정보").should("have.attr", "aria-pressed", "true");
    installedToolbar().should("exist");

    // 6) 떨어뜨린 값이 저장으로 되써져 다음 실행에 남지 않는다.
    cy.window().its("localStorage").invoke("getItem", MODE_KEY).should("eq", "installed");
  });

  it("모드를 오갔다 돌아오면 검색어가 남고, 새로고침에는 사라진다", () => {
    openSkills();

    // 7) 스킬정보의 검색어를 넣는다. 설치본 0건이라 분모가 붙은 카운트가 된다.
    installedSearch().type("자소분리");
    installedToolbar().find(".toolbar-count").should("have.text", "0 / 0개");

    // 8) 스킬관리로 갔다가 돌아온다.
    modeButton("스킬관리").click();
    installedToolbar().should("not.exist");
    libraryToolbar().should("exist");
    modeButton("스킬정보").click();

    // 9) 검색어는 화면이 마운트된 채라 그대로 살아 있어야 한다.
    installedSearch().should("have.value", "자소분리");
    installedToolbar().find(".toolbar-count").should("have.text", "0 / 0개");

    // 10) 검색어는 저장 대상이 아니므로 새로고침에는 사라진다.
    cy.reload();
    cy.openView("skills");
    installedSearch().should("have.value", "");
    installedToolbar().find(".toolbar-count").should("have.text", "0개");
  });
});
