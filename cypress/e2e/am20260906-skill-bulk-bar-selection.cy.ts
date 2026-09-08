// 스킬관리 보관 스킬의 '일괄 작업 바'가 선택 상태에 따라 어떤 짝으로 잠기는지,
// 전체선택이 필터·검색으로 좁혀진 범위만 담는지, 그리고 먼저 고른 뒤 필터를 좁히면
// 선택이 어디까지 남는지. AM-40은 같은 화면의 필터 칩 개수만 봤고, 일괄 작업 바의
// 잠금 짝과 선택 범위 계약은 아직 어느 시나리오도 확인하지 않았다.
import {
  openSkillLibrary,
  skillBulkBar as bar,
  skillBulkButton as barButton,
  skillLibraryFixtures,
} from "../support/skillLibraryFixtures";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/ambulk");

//   alpha  보관 / claude
//   beta   보관 / codex
//   gamma  미보관 / claude   ← '보관' 버튼이 열리는 유일한 항목
const LIBRARY = library([
  entry("alpha", { common: true, providers: [providerState("claude")] }),
  entry("beta", { common: true, providers: [providerState("codex")] }),
  entry("gamma", { common: false, providers: [providerState("claude")] }),
]);

const EMPTY_LIBRARY = library([]);

function openLibrary(snapshot: unknown): void {
  cy.stubInvoke("get_skill_library", snapshot);
  openSkillLibrary();
  bar().should("exist");
}

function check(name: string) {
  return cy.get(`.skill-library-item input[aria-label="${name} 선택"]`).check();
}

describe("보관 스킬 일괄 작업 바의 잠금 짝과 선택 범위", () => {
  it("아무것도 고르지 않으면 0개 선택됨과 함께 작업 다섯 개가 모두 잠긴다", () => {
    openLibrary(LIBRARY);

    // 1) 선택 개수는 0으로 시작한다.
    bar().find("strong").should("have.text", "0개 선택됨");

    // 2) 목록이 있으니 전체선택만 열려 있고, 실제 작업 다섯 개는 모두 잠긴다.
    barButton("전체선택").should("be.enabled");
    for (const label of ["보관", "보관취소", "사용", "미사용", "삭제"]) {
      barButton(label).should("be.disabled");
    }
  });

  it("목록이 0건이면 전체선택까지 잠긴다", () => {
    openLibrary(EMPTY_LIBRARY);

    // 3) 고를 것이 없으면 전체선택도 누를 수 없다.
    bar().find("strong").should("have.text", "0개 선택됨");
    barButton("전체선택").should("be.disabled");
    cy.get(".empty-state").should("contain.text", "표시할 스킬이 없습니다");
  });

  it("전체선택은 전체해제로 바뀌고, 보관·보관취소는 고른 항목의 보관 여부로 갈린다", () => {
    openLibrary(LIBRARY);

    // 4) 전체선택은 보이는 세 건을 모두 담고 라벨이 전체해제로 뒤바뀐다.
    barButton("전체선택").click();
    bar().find("strong").should("have.text", "3개 선택됨");
    barButton("전체해제").should("be.enabled");
    cy.get(".skill-library-item.selected").should("have.length", 3);

    // 5) 미보관(gamma)이 섞였으니 '보관'이 열리고, 보관본(alpha·beta)도 있으니
    //    '보관취소'도 열린다. 개수로만 판단하는 사용·미사용·삭제도 열린다.
    for (const label of ["보관", "보관취소", "사용", "미사용", "삭제"]) {
      barButton(label).should("be.enabled");
    }

    // 6) 보관본만 고르면 '보관'은 다시 잠기고 '보관취소'만 남는다.
    barButton("전체해제").click();
    bar().find("strong").should("have.text", "0개 선택됨");
    check("alpha");
    bar().find("strong").should("have.text", "1개 선택됨");
    barButton("보관").should("be.disabled");
    barButton("보관취소").should("be.enabled");

    // 7) 미보관본만 고르면 정반대로 갈린다.
    cy.get('.skill-library-item input[aria-label="alpha 선택"]').uncheck();
    check("gamma");
    barButton("보관").should("be.enabled");
    barButton("보관취소").should("be.disabled");
  });

  it("전체선택은 필터로 좁혀진 범위만 담는다", () => {
    openLibrary(LIBRARY);

    // 8) 에이전트 축에서 Codex를 고르면 beta 한 건만 남는다.
    cy.get('.source-tabs[role="group"][aria-label="사용 에이전트 필터"]').contains("button", "Codex").click();
    cy.get(".skill-library-item").should("have.length", 1);

    // 9) 전체선택은 숨겨진 alpha·gamma를 몰래 담지 않는다.
    barButton("전체선택").click();
    bar().find("strong").should("have.text", "1개 선택됨");
  });

  it("먼저 고른 뒤 필터로 좁히면 화면에서 사라진 항목은 선택에서 빠지고 삭제 대상도 보이는 것만 든다", () => {
    cy.intercept("POST", "**/api/invoke/delete_skill", { statusCode: 200, body: null }).as("del");
    openLibrary(LIBRARY);

    // 10) 세 건을 모두 고른다.
    barButton("전체선택").click();
    bar().find("strong").should("have.text", "3개 선택됨");

    // 11) Codex로 좁히면 목록에는 beta 하나만 보인다.
    cy.get('.source-tabs[role="group"][aria-label="사용 에이전트 필터"]').contains("button", "Codex").click();
    cy.get(".skill-library-item").should("have.length", 1);
    cy.get(".skill-library-item").should("contain.text", "beta");

    // 12) 선택 개수도 보이는 1로 줄어든다(QA #30). 화면에 없는 alpha·gamma는 선택에서 빠진다.
    bar().find("strong").should("have.text", "1개 선택됨");
    cy.get(".skill-library-item.selected").should("have.length", 1);

    // 13) 삭제 확인 대화도 보이는 beta 1건만 지운다고 알린다.
    barButton("삭제").click();
    cy.get(".confirm-dialog").should("contain.text", "스킬 1개를 삭제할까요?");
    cy.get(".confirm-dialog-items li").should("have.length", 1);
    cy.get(".confirm-dialog-items").should("contain.text", "beta")
      .and("not.contain.text", "alpha").and("not.contain.text", "gamma");

    // 14) 무르면 요청은 나가지 않는다.
    cy.get(".modal-footer").contains("button", "취소").click();
    cy.get(".confirm-dialog").should("not.exist");
    cy.get("@del.all").should("have.length", 0);
  });
});
