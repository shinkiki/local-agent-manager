// AM-29 (임시 스펙): 설치본이 0건인 스킬 화면에서 저장된 '태그' 필터가 복원되는지,
// 알 수 없는 값이 전체로 떨어져 저장까지 정규화되는지, 그리고 0건 상태에서 태그를
// '모든 태그'로 되돌릴 수 있는지. AM-9는 같은 계약을 '구분' 필터에서만 확인했다.
const FILTERS_KEY = "agent-manager.skill-filters.v3";

function visitWithFilters(filters: unknown): void {
  cy.visitApp({ [FILTERS_KEY]: JSON.stringify(filters) });
  cy.openView("skills");
}

describe("스킬 태그 필터의 복원 경계와 0건에서의 되돌리기", () => {
  it("저장된 태그가 복원되고 0건에서도 '모든 태그'로 되돌릴 수 있다", () => {
    visitWithFilters({ group: "all", tag: "personal" });

    // 1) 저장된 태그가 그대로 복원된다.
    cy.get('.source-tabs[role="group"][aria-label="스킬 태그 필터"]').as("tags");
    cy.get("@tags").find("button").contains("개인").should("have.attr", "aria-pressed", "true");

    // 2) 구분은 심지 않았으므로 전체다.
    cy.get('.source-tabs[role="group"][aria-label="스킬 구분 필터"]')
      .find("button").contains("전체").should("have.attr", "aria-pressed", "true");

    // 3) 필터가 걸린 상태라 카운트에 분모가 붙는다.
    cy.get(".skill-library-toolbar .toolbar-count").should("have.text", "0 / 0개");

    // 4) 0건이어도 '모든 태그'는 눌러 필터를 풀 수 있어야 한다.
    cy.get("@tags").find("button").contains("모든 태그").as("allTag");
    cy.get("@allTag").should("not.be.disabled");
    cy.get("@allTag").click();
    cy.get("@allTag").should("have.attr", "aria-pressed", "true");
    cy.get(".skill-library-toolbar .toolbar-count").should("have.text", "0개");
  });

  it("알 수 없는 태그 값은 전체로 떨어지고 저장값도 정규화된다", () => {
    visitWithFilters({ group: "claude", tag: "무엇인가" });

    // 5) 알 수 없는 태그는 '모든 태그'로 떨어진다.
    cy.get('.source-tabs[role="group"][aria-label="스킬 태그 필터"]')
      .find("button").contains("모든 태그").should("have.attr", "aria-pressed", "true");

    // 6) 유효한 구분은 그대로 살아남는다.
    cy.get('.source-tabs[role="group"][aria-label="스킬 구분 필터"]')
      .find("button").contains("Claude").should("have.attr", "aria-pressed", "true");

    // 7) 정규화한 값이 저장으로 되써진다.
    cy.window().its("localStorage").invoke("getItem", FILTERS_KEY)
      .should("eq", JSON.stringify({ group: "claude", tag: "all" }));

    // 8) 새로고침 뒤에도 같은 값으로 복원된다.
    cy.reload();
    cy.anchor("nav.skills").click();
    cy.get('.source-tabs[role="group"][aria-label="스킬 구분 필터"]')
      .find("button").contains("Claude").should("have.attr", "aria-pressed", "true");
    cy.get('.source-tabs[role="group"][aria-label="스킬 태그 필터"]')
      .find("button").contains("모든 태그").should("have.attr", "aria-pressed", "true");
  });
});
