/// <reference types="cypress" />
// QA #30 회귀: 스킬관리 일괄 작업 바의 선택은 지금 화면에 보이는 항목 안에서만 유지된다.
// 먼저 고른 뒤 에이전트 필터나 검색으로 좁히면 숨은 항목이 선택에서 빠져 개수가 보이는
// 것과 같아지고, 필터를 다시 넓혀도 빠진 선택은 되살아나지 않는다. 그래서 일괄 삭제·
// 보관취소의 대상 목록은 언제나 화면에 있는 항목만 든다.
import {
  openSkillLibrary,
  skillBulkBar as bar,
  skillBulkButton as barButton,
  skillLibraryFixtures,
} from "../support/skillLibraryFixtures";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/qa30");

//   alpha  보관 / claude
//   beta   보관 / codex
//   gamma  미보관 / claude
const LIBRARY = library([
  entry("alpha", { common: true, providers: [providerState("claude")] }),
  entry("beta", { common: true, providers: [providerState("codex")] }),
  entry("gamma", { common: false, providers: [providerState("claude")] }),
]);

const agentFilter = (label: string) =>
  cy.get('.source-tabs[role="group"][aria-label="사용 에이전트 필터"]').contains("button", label);

function openLibrary(): void {
  cy.stubInvoke("get_skill_library", LIBRARY);
  openSkillLibrary();
  cy.get(".skill-library-item").should("have.length", 3);
}

describe("QA #30 스킬 일괄 선택은 화면에 보이는 항목만 따라간다", () => {
  it("에이전트 필터로 좁히면 숨은 선택이 빠지고, 다시 넓혀도 되살아나지 않는다", () => {
    openLibrary();
    barButton("전체선택").click();
    bar().find("strong").should("have.text", "3개 선택됨");

    // 1) Codex로 좁히면 beta만 남고 선택 개수도 1로 준다.
    agentFilter("Codex").click();
    cy.get(".skill-library-item").should("have.length", 1);
    bar().find("strong").should("have.text", "1개 선택됨");
    cy.get(".skill-library-item.selected").should("have.length", 1).and("contain.text", "beta");

    // 2) 전체로 되돌려도 alpha·gamma는 선택되지 않은 채 돌아온다.
    agentFilter("전체").click();
    cy.get(".skill-library-item").should("have.length", 3);
    bar().find("strong").should("have.text", "1개 선택됨");
    cy.get(".skill-library-item.selected").should("have.length", 1).and("contain.text", "beta");
    cy.get('.skill-library-item input[aria-label="alpha 선택"]').should("not.be.checked");
    cy.get('.skill-library-item input[aria-label="gamma 선택"]').should("not.be.checked");
  });

  it("검색으로 좁혀도 같은 규칙이 적용되고 보관취소 대상도 보이는 것만 든다", () => {
    cy.stubInvoke("unarchive_shared_skill", { statusCode: 200, body: {} }).as("unarchive");
    openLibrary();
    barButton("전체선택").click();
    bar().find("strong").should("have.text", "3개 선택됨");

    // 3) 'alp'로 검색하면 alpha만 남고 선택도 1건이 된다.
    cy.get('.search-input[aria-label="보관 스킬 검색"]').type("alp");
    cy.get(".skill-library-item").should("have.length", 1).and("contain.text", "alpha");
    bar().find("strong").should("have.text", "1개 선택됨");

    // 4) 보관취소 확인 대화도 보이는 alpha 1건만 대상으로 센다.
    barButton("보관취소").click();
    cy.get(".confirm-dialog").should("contain.text", "스킬 1개의 보관을 취소할까요?");
    cy.get(".confirm-dialog-items li").should("have.length", 1);
    cy.get(".confirm-dialog-items").should("contain.text", "alpha").and("not.contain.text", "beta");

    // 5) 무르면 요청은 나가지 않는다.
    cy.get(".modal-footer").contains("button", "취소").click();
    cy.get(".confirm-dialog").should("not.exist");
    cy.get("@unarchive.all").should("have.length", 0);
  });
});
