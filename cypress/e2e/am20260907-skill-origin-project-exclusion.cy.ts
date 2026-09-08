/**
 * 스킬관리 출처 필터의 "프로젝트 칩"과 설정 → 라이브러리의 '프로젝트 활성여부'가 같은
 * 제외 판정을 보는지. 두 화면을 걸친 이 정합성은 어느 시나리오도 아직 열어 본 적이 없다.
 * AM-40은 출처 축의 개인·프로젝트 두 칩 개수만 봤고, 프로젝트 이름 칩이 레지스트리의
 * 제외를 따르는지는 확인하지 않았다.
 *
 * 여기서 보는 것은 셋이다. (1) 제외되지 않은 프로젝트만 이름 칩으로 나오는지,
 * (2) 설정에서 제외·재활성한 것이 이미 열려 있던 스킬관리 칩에 새로고침 없이 곧바로
 * 반영되고 그 칩을 고른 상태였던 필터가 '전체 프로젝트'로 떨어지는지,
 * (3) 제외된 프로젝트 출처 스킬 자체는 목록·출처 표시·출처 축 개수에 그대로 남는지.
 */
import type { ProjectRegistryEntry } from "../../src/types";
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const ALPHA = "/tmp/am-origin-excl/alpha-proj";
const BETA = "/tmp/am-origin-excl/beta-proj";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/am-origin-excl");

function origin(path: string, name: string) {
  return { provider: "claude", scope: "project", projectPath: path, projectName: name, archivedAtMs: 1_700_000_000_000 };
}

// 개인 출처 하나와 프로젝트 출처 둘. 프로젝트 칩이 둘로 갈려야 제외로 하나만 사라지는
// 것을 볼 수 있다.
const LIBRARY = library([
  cyEntry("solo"),
  cyEntry("alpha-skill", origin(ALPHA, "알파 프로젝트")),
  cyEntry("beta-skill", origin(BETA, "베타 프로젝트")),
]);

function cyEntry(key: string, entryOrigin?: unknown) {
  return entry(key, { common: true, providers: [providerState("claude")], origin: entryOrigin });
}

function project(name: string, path: string, overrides: Partial<ProjectRegistryEntry> = {}): ProjectRegistryEntry {
  return {
    path,
    name,
    sessionCount: 3,
    hiddenSessionCount: 0,
    updatedAt: null,
    providers: ["claude"],
    active: true,
    pending: false,
    exists: true,
    ...overrides,
  };
}

const chip = (group: string, label: string) =>
  cy.get(`.source-tabs[role="group"][aria-label="${group}"]`).contains("button", label);
const projectChips = () => cy.get('.skill-origin-projects[role="group"] button');
const items = () => cy.get(".skill-library-list .skill-library-item");
const card = () => cy.get(".settings-card").contains("h2", "세션에서 확인한 프로젝트").closest(".settings-card");

/** 백엔드가 들고 있는 레지스트리. 설정 화면의 토글이 이 값을 실제로 바꾸게 둔다. */
let registry: ProjectRegistryEntry[] = [];

function openManagedSkills(): void {
  cy.get(".skill-mode-tabs button").contains("스킬관리").click();
  cy.get(".skill-library-filterbar").should("exist");
}

describe("스킬 출처 프로젝트 칩과 설정의 프로젝트 제외", () => {
  beforeEach(() => {
    registry = [project("알파 프로젝트", ALPHA), project("베타 프로젝트", BETA)];
    cy.stubInvoke("get_skill_library", LIBRARY);
    cy.stubInvoke("get_project_registry", (req) => { req.reply({ statusCode: 200, body: registry }); });
    cy.stubInvoke("set_project_active", (req) => {
      const request = (req.body as { request: { path: string; active: boolean } }).request;
      registry = registry.map((item) => (
        item.path === request.path ? { ...item, active: request.active, pending: false } : item
      ));
      req.reply({ statusCode: 200, body: registry });
    });
    openSkillLibrary();
    cy.get(".skill-library-filterbar").should("exist");
    items().should("have.length", 3);
  });

  it("출처 '프로젝트'를 고르면 제외되지 않은 프로젝트만 이름 칩으로 나온다", () => {
    // 1) 프로젝트를 고르기 전에는 이름 칩을 내지 않는다.
    cy.get(".skill-origin-projects").should("not.exist");

    // 2) 출처 축의 '프로젝트'를 고르면 레지스트리의 활성 프로젝트 둘이 이름 칩으로 나온다.
    chip("스킬 출처 필터", "프로젝트").click();
    projectChips().should("have.length", 3);
    projectChips().eq(0).should("contain.text", "전체 프로젝트").and("have.attr", "aria-pressed", "true");
    // 이름 칩은 이름의 로케일 정렬이라 '베타'가 '알파'보다 앞이다(ㅂ < ㅇ).
    projectChips().eq(1).should("contain.text", "베타 프로젝트");
    projectChips().eq(2).should("contain.text", "알파 프로젝트");

    // 3) 이름 칩을 고르면 그 프로젝트 출처 스킬만 남는다.
    chip("프로젝트 선택", "알파 프로젝트").click();
    items().should("have.length", 1).first().should("contain.text", "alpha-skill");
  });

  it("설정에서 제외하면 스킬관리 이름 칩이 곧바로 사라지고 필터는 전체 프로젝트로 되돌아온다", () => {
    chip("스킬 출처 필터", "프로젝트").click();
    chip("프로젝트 선택", "알파 프로젝트").click();
    items().should("have.length", 1);

    // 4) 설정 → 라이브러리에서 알파를 제외한다. 카드는 제외 1건으로 접힌 목록을 알린다.
    cy.openSettingsTab("repository");
    card().find('[role="switch"][aria-label="알파 프로젝트 활성"]').click();
    card().find(".project-registry-collapse").should("contain.text", "제외 프로젝트 1개");

    // 5) 스킬 화면으로 돌아오면 칩이 곧바로 사라져 있다. 활성여부 변경이 자원 화면을
    //    무효화해 목록·레지스트리를 다시 읽게 하므로(App의 invalidateResourceViews),
    //    새로고침 없이도 두 화면의 제외 판정이 어긋나지 않는다.
    cy.openView("skills");
    cy.get(".skill-origin-projects").should("not.contain.text", "알파 프로젝트");
    projectChips().should("have.length", 2);

    // 6) 사라진 칩을 가리키던 필터는 '전체 프로젝트'로 떨어진다 — 아무것도 안 나오는
    //    필터로 남지 않는다. 제외는 칩만 감추므로 알파 출처 스킬은 목록에 그대로 있고
    //    출처 표시와 출처 축의 개수도 두 건을 그대로 센다.
    projectChips().eq(0).should("contain.text", "전체 프로젝트").and("have.attr", "aria-pressed", "true");
    items().should("have.length", 2);
    cy.get(".skill-library-item").contains(".skill-origin-pill", "프로젝트: 알파 프로젝트").should("exist");
    chip("스킬 출처 필터", "프로젝트").find("small").should("have.text", "2");

    // 7) 설정에서 다시 켜면 이름 칩도 돌아온다. 되돌린 뒤에도 필터는 전체 프로젝트다.
    cy.openSettingsTab("repository");
    card().find(".project-registry-collapse").click();
    card().find('[role="switch"][aria-label="알파 프로젝트 활성"]').click();
    cy.openView("skills");
    chip("프로젝트 선택", "알파 프로젝트").should("exist").and("have.attr", "aria-pressed", "false");
    projectChips().eq(0).should("have.attr", "aria-pressed", "true");
  });

  it("제외한 채로 새로 뜨면 저장된 프로젝트 필터가 전체 프로젝트로 떨어진다", () => {
    chip("스킬 출처 필터", "프로젝트").click();
    chip("프로젝트 선택", "알파 프로젝트").click();
    items().should("have.length", 1);

    cy.openSettingsTab("repository");
    card().find('[role="switch"][aria-label="알파 프로젝트 활성"]').click();
    card().find(".project-registry-collapse").should("contain.text", "제외 프로젝트 1개");

    // 8) 앱을 다시 띄운다. 필터는 localStorage에 남아 `project:알파`로 복원된다.
    cy.visitApp();
    cy.openView("skills");
    openManagedSkills();

    // 9) 제외된 알파는 이름 칩에서 빠지고, 사라진 칩을 가리키던 필터는 전체 프로젝트로
    //    되돌아온다 — 아무것도 안 나오는 필터로 남지 않는다.
    projectChips().should("have.length", 2);
    projectChips().eq(0).should("contain.text", "전체 프로젝트").and("have.attr", "aria-pressed", "true");
    projectChips().eq(1).should("contain.text", "베타 프로젝트");
    cy.get(".skill-origin-projects").should("not.contain.text", "알파 프로젝트");

    // 10) 제외는 칩만 감춘다. 출처 표시는 이력이라 목록 항목에는 그대로 남고, 출처 축의
    //    '프로젝트' 개수도 두 건을 그대로 센다.
    items().should("have.length", 2);
    items().first().should("contain.text", "alpha-skill");
    cy.get(".skill-library-item").contains(".skill-origin-pill", "프로젝트: 알파 프로젝트").should("exist");
    chip("스킬 출처 필터", "프로젝트").find("small").should("have.text", "2");
  });
});
