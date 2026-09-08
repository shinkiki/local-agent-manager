// 설정 → 라이브러리의 '프로젝트 활성여부' 카드. 이 카드는 어느 시나리오도 아직 열어 본
// 적이 없다. 여기서 보는 것은 네 가지다. (1) 등록이 0건인 빈 상태와 검색이 아무것도
// 맞히지 못한 빈 상태가 서로 다른 문구로 갈리는지, (2) 요약 수치가 검색으로 좁혀도
// 전체 기준을 지키는지, (3) 제외 목록이 검색 중에는 스스로 펼쳐지고 그동안 접기 조작을
// 내주지 않으며 검색을 지우면 접힌 상태로 돌아오는지, (4) 활성여부를 뒤집는 동안
// 나머지 토글까지 함께 잠기고 실패하면 오류 배너로 알리는지.
import type { ProjectRegistryEntry } from "../../src/types";

function project(name: string, overrides: Partial<ProjectRegistryEntry> = {}): ProjectRegistryEntry {
  return {
    path: `/tmp/amproj/${name}`,
    name,
    sessionCount: 2,
    hiddenSessionCount: 0,
    updatedAt: null,
    providers: ["claude"],
    active: true,
    pending: false,
    exists: true,
    ...overrides,
  };
}

//   alpha  활성
//   beta   활성 / 결정 대기
//   gamma  제외        ← 접이식 '제외 프로젝트' 목록에 들어가는 유일한 항목
const REGISTRY = [
  project("alpha"),
  project("beta", { pending: true }),
  project("gamma", { active: false }),
];

const card = () => cy.get(".settings-card").contains("h2", "세션에서 확인한 프로젝트").closest(".settings-card");
const search = () => card().find("input.search-input");
const summary = () => card().find(".settings-subsection > header small");
const collapse = () => card().find(".project-registry-collapse");
const inactiveList = () => card().find("#project-registry-inactive-list");
const toggle = (name: string) => card().find(`[role="switch"][aria-label="${name} 활성"]`);

function openCard(entries: ProjectRegistryEntry[]): void {
  cy.stubInvoke("get_project_registry", entries);
  cy.openSettingsTab("repository");
  card().should("exist");
}

describe("설정 라이브러리 프로젝트 활성여부 카드", () => {
  beforeEach(() => { cy.visitApp(); });

  it("등록 0건과 검색 무결과는 서로 다른 빈 상태 문구로 갈린다", () => {
    openCard([]);

    // 1) 세션에서 역산한 프로젝트가 하나도 없을 때의 문구.
    card().find(".project-registry-empty").should("have.text", "세션에서 확인한 프로젝트가 없습니다.");
    // 목록이 없으면 검색칸 자체는 열려 있되(로드는 끝났다) 접이식 제외 목록은 없다.
    search().should("be.enabled");
    collapse().should("not.exist");

    // 2) 목록은 있는데 검색이 아무것도 맞히지 못하면 다른 문구가 나온다.
    cy.visitApp();
    openCard(REGISTRY);
    search().type("zzz-없는프로젝트");
    card().find(".project-registry-empty").should("have.text", "검색 결과가 없습니다.");
  });

  it("요약 수치는 결정 대기를 함께 세고, 검색으로 좁혀도 전체 기준을 지킨다", () => {
    openCard(REGISTRY);

    // 3) 활성 2 · 제외 1 · 결정 대기 1(beta).
    summary().should("have.text", "활성 2 · 제외 1 · 결정 대기 1");

    // 4) 검색은 보이는 행만 줄인다. 요약은 등록 전체를 세므로 그대로다.
    search().type("alpha");
    card().find(".project-registry-row").should("have.length", 1);
    summary().should("have.text", "활성 2 · 제외 1 · 결정 대기 1");
  });

  it("제외 목록은 기본 접혀 있고 검색 중에만 스스로 펼쳐지며 접기 조작이 잠긴다", () => {
    openCard(REGISTRY);

    // 5) 기본은 접힘. 머리글은 개수를 알려 주고 목록은 아직 없다.
    collapse().should("have.attr", "aria-expanded", "false");
    collapse().should("contain.text", "제외 프로젝트 1개").and("contain.text", "펼쳐서 다시 켤 수 있습니다");
    inactiveList().should("not.exist");

    // 6) 직접 누르면 펼쳐진다.
    collapse().click();
    collapse().should("have.attr", "aria-expanded", "true");
    inactiveList().find(".project-registry-row").should("have.length", 1);
    collapse().click();
    inactiveList().should("not.exist");

    // 7) 검색 중에는 결과가 숨지 않도록 자동으로 펼치고, 접기 조작 자체를 내주지 않는다.
    search().type("gamma");
    collapse().should("have.attr", "aria-expanded", "true").and("be.disabled");
    collapse().should("contain.text", "검색 중에는 항상 펼칩니다");
    inactiveList().find(".project-registry-row").should("have.length", 1);

    // 8) 검색을 지우면 자동 펼침이 풀려 다시 접힌 상태로 돌아온다(QA #15의 잔존 방지).
    search().clear();
    collapse().should("have.attr", "aria-expanded", "false").and("be.enabled");
    inactiveList().should("not.exist");
  });

  it("활성여부를 뒤집는 동안 다른 토글까지 잠기고, 실패하면 오류 배너가 뜬다", () => {
    openCard(REGISTRY);

    // 9) 응답을 늦춰 두고 alpha를 끄면, 그 사이 beta 토글까지 함께 잠긴다.
    cy.stubInvoke("set_project_active", (req) => {
      req.reply({ delay: 400, statusCode: 200, body: REGISTRY.map((entry) => (
        entry.name === "alpha" ? { ...entry, active: false, pending: false } : entry
      )) });
    }).as("setActive");
    toggle("alpha").click();
    toggle("beta").should("be.disabled");

    // 10) 응답이 오면 잠금이 풀리고, alpha는 제외 목록으로 내려간다.
    cy.wait("@setActive");
    toggle("beta").should("be.enabled");
    collapse().should("contain.text", "제외 프로젝트 2개");
    card().find(".project-registry-row:not(.inactive)").should("have.length", 1);

    // 11) 실패 응답은 배너로 알리고 토글은 다시 쓸 수 있어야 한다.
    cy.stubInvoke("set_project_active", { statusCode: 500, body: { error: "프로젝트 설정을 저장하지 못했습니다." } });
    toggle("beta").click();
    card().find(".error-banner").should("contain.text", "프로젝트 설정을 저장하지 못했습니다.");
    toggle("beta").should("be.enabled").and("have.attr", "aria-checked", "true");
  });
});
