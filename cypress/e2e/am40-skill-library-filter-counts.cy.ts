// AM-40 (임시 스펙): 스킬관리 보관 스킬 필터 네 축(보관 여부·상태·에이전트·출처)의
// 칩 개수가 "자기 축만 빼고 나머지 축을 모두 적용한" 수인지, 그 수가 목록 건수와
// 어긋나지 않는지. AM-29는 설치본 0건 스킬정보 화면의 '태그' 필터 복원만 봤고, 칩
// 개수가 축을 하나 빼고 계산되는 계약은 아직 어느 시나리오도 확인하지 않았다.
import {
  openSkillLibrary,
  SKILL_FILTERS_KEY as FILTERS_KEY,
  skillLibraryFixtures,
} from "../support/skillLibraryFixtures";

const PROJECT_PATH = "/tmp/am40-project";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/am40");

// 프로젝트에서 보관된 항목은 출처 축의 '프로젝트' 쪽을 대표한다.
const PROJECT_ORIGIN = {
  provider: "claude",
  scope: "project",
  projectPath: PROJECT_PATH,
  projectName: "AM40 프로젝트",
  archivedAtMs: 1_700_000_000_000,
};

// 네 항목이 축마다 다른 값을 갖도록 짠 표본.
//   alpha  보관 / 동기화됨 / claude / 개인
//   beta   보관 / 동기화됨 / codex  / 프로젝트
//   gamma  미보관 / 미사용 / claude / 개인
//   delta  보관 / 외부 수정 감지 / codex / 개인
const LIBRARY = library([
  entry("alpha", { common: true, providers: [providerState("claude")] }),
  entry("beta", { common: true, providers: [providerState("codex")], origin: PROJECT_ORIGIN }),
  entry("gamma", { common: false, providers: [providerState("claude")] }),
  entry("delta", { common: true, providers: [providerState("codex", { divergent: true })] }),
]);

function chip(group: string, label: string) {
  return cy.get(`.source-tabs[role="group"][aria-label="${group}"]`).contains("button", label);
}

function chipCount(group: string, label: string, expected: string) {
  return chip(group, label).find("small").should("have.text", expected);
}

function openLibrary(): void {
  openSkillLibrary();
  cy.get(".skill-library-filterbar").should("exist");
  cy.get(".skill-library-list .skill-library-item").should("have.length", 4);
}

describe("보관 스킬 필터 네 축의 칩 개수와 목록의 일치", () => {
  beforeEach(() => {
    cy.stubInvoke("get_skill_library", LIBRARY);
  });

  it("아무 필터도 걸지 않으면 각 축의 칩 개수가 표본 전체를 축별로 센 수와 같다", () => {
    openLibrary();

    // 1) 보관 여부: 보관 3(alpha·beta·delta), 미보관 1(gamma).
    chipCount("보관 여부 필터", "전체", "4");
    chipCount("보관 여부 필터", "보관", "3");
    chipCount("보관 여부 필터", "미보관", "1");

    // 2) 상태: 외부 수정 감지 1(delta), 미사용 1(gamma - 보관 원본이 없다).
    chipCount("스킬 상태 필터", "전체", "4");
    chipCount("스킬 상태 필터", "외부 수정 감지", "1");
    chipCount("스킬 상태 필터", "미사용", "1");

    // 3) 에이전트: claude 2(alpha·gamma), codex 2(beta·delta), antigravity 0.
    chipCount("사용 에이전트 필터", "Claude", "2");
    chipCount("사용 에이전트 필터", "Codex", "2");
    chipCount("사용 에이전트 필터", "Antigravity", "0");

    // 4) 출처: 개인 3, 프로젝트 1(beta).
    chipCount("스킬 출처 필터", "개인", "3");
    chipCount("스킬 출처 필터", "프로젝트", "1");

    // 5) 0건 칩은 고를 수 없다.
    chip("사용 에이전트 필터", "Antigravity").should("be.disabled");
  });

  it("한 축을 고르면 다른 축의 칩만 그 축으로 좁혀지고, 고른 축의 칩은 좁혀지지 않는다", () => {
    openLibrary();

    // 6) 보관 여부에서 '보관'을 고른다 - 목록은 세 건이 된다.
    chip("보관 여부 필터", "보관").click();
    chip("보관 여부 필터", "보관").should("have.attr", "aria-pressed", "true");
    cy.get(".skill-library-list .skill-library-item").should("have.length", 3);
    cy.get(".toolbar-count").should("have.text", "3개");

    // 7) 고른 축(보관 여부)의 칩 개수는 자기 축을 빼고 세므로 그대로 4·3·1이다.
    //    여기서 '전체 3, 보관 3, 미보관 0'으로 좁혀지면 다른 값으로 되돌아갈 길이 사라진다.
    chipCount("보관 여부 필터", "전체", "4");
    chipCount("보관 여부 필터", "보관", "3");
    chipCount("보관 여부 필터", "미보관", "1");
    chip("보관 여부 필터", "미보관").should("not.be.disabled");

    // 8) 나머지 축은 '보관' 안에서만 센다. gamma가 빠지므로 claude 1, 미사용 0이 된다.
    chipCount("스킬 상태 필터", "전체", "3");
    chipCount("스킬 상태 필터", "외부 수정 감지", "1");
    chipCount("스킬 상태 필터", "미사용", "0");
    chip("스킬 상태 필터", "미사용").should("be.disabled");
    chipCount("사용 에이전트 필터", "Claude", "1");
    chipCount("사용 에이전트 필터", "Codex", "2");
    chipCount("스킬 출처 필터", "개인", "2");
    chipCount("스킬 출처 필터", "프로젝트", "1");
  });

  it("두 축을 겹쳐 걸어도 각 축의 칩은 자기 축만 빼고 세고 목록 건수와 맞는다", () => {
    openLibrary();

    // 9) 보관 + Codex = beta·delta 두 건.
    chip("보관 여부 필터", "보관").click();
    chip("사용 에이전트 필터", "Codex").click();
    cy.get(".skill-library-list .skill-library-item").should("have.length", 2);

    // 10) 에이전트 축은 자기 축을 빼므로 '보관' 안의 claude 1이 그대로 보인다.
    chipCount("사용 에이전트 필터", "Claude", "1");
    chipCount("사용 에이전트 필터", "Codex", "2");

    // 11) 보관 여부 축은 에이전트만 적용해 센다. codex 스킬 중 미보관은 없다.
    chipCount("보관 여부 필터", "보관", "2");
    chipCount("보관 여부 필터", "미보관", "0");
    chip("보관 여부 필터", "미보관").should("be.disabled");

    // 12) 상태·출처 축은 두 축이 모두 걸린 결과 안에서 센다.
    chipCount("스킬 상태 필터", "전체", "2");
    chipCount("스킬 상태 필터", "외부 수정 감지", "1");
    chipCount("스킬 출처 필터", "개인", "1");
    chipCount("스킬 출처 필터", "프로젝트", "1");

    // 13) 출처에서 프로젝트를 고르면 프로젝트 칩 줄이 열리고 beta 한 건만 남는다.
    chip("스킬 출처 필터", "프로젝트").click();
    cy.get('.source-tabs[role="group"][aria-label="프로젝트 선택"]').should("exist");
    cy.get(".skill-library-list .skill-library-item").should("have.length", 1);
    cy.get(".skill-library-list .skill-library-item").should("contain.text", "beta");

    // 14) 걸린 조건은 저장으로 남는다.
    cy.window().its("localStorage").invoke("getItem", FILTERS_KEY)
      .should("eq", JSON.stringify({ kind: "shared", state: "all", agent: "codex", origin: "project" }));
  });
});
