/// <reference types="cypress" />
// 저장소 → 라이브러리의 저장소 경로 카드(ResourceRepositoryCard.tsx)는 첫 조회가 실패하면
// 오류 배너와 함께 '불러오는 중…'을 계속 보였고 다시 불러올 길이 없었다. 실패하면 '불러오는 중'
// 대신 다시 불러오기 버튼이 보이고, 그 버튼으로 같은 조회를 다시 해 카드가 채워지는지 본다.
const CARD = ".settings-card:has(.settings-subsection)";

describe("라이브러리 저장소 경로 카드의 첫 조회 실패와 다시 불러오기", () => {
  it("첫 조회가 실패하면 불러오는 중 대신 다시 불러오기를 보이고, 다시 불러오면 경로 칸이 뜬다", { retries: 0 }, () => {
    let fail = true;
    cy.intercept("POST", "**/api/invoke/get_resource_repository", (req) => {
      if (fail) req.reply({ statusCode: 500, body: { code: "APP_RUNTIME", message: "저장소 조회 실패(시험)" } });
      else req.continue();
    }).as("repo");
    cy.visitApp();
    cy.openStorageTab("library");
    cy.wait("@repo");
    cy.contains(CARD, "스킬·프로젝트 지침 저장 위치").within(() => {
      cy.get(".error-banner").should("be.visible");
      cy.contains("button", "다시 불러오기").should("be.visible");
      cy.contains("저장소 설정을 불러오는 중…").should("not.exist");
      cy.get("[data-ui-anchor='storage.repository-path']").should("not.exist");
    });
    cy.then(() => { fail = false; });
    cy.contains(CARD, "스킬·프로젝트 지침 저장 위치").contains("button", "다시 불러오기").click();
    cy.anchor("storage.repository-path").should("be.visible");
    cy.contains(CARD, "스킬·프로젝트 지침 저장 위치").within(() => {
      cy.contains("button", "다시 불러오기").should("not.exist");
      cy.get(".error-banner").should("not.exist");
    });
  });
});
