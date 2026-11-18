/// <reference types="cypress" />
import { cleanupDocRoot } from "../support/docRootFixtures";

// AM-271은 문서 트리거 활성 스위치의 정상 왕복과 탭 복원을 확인했다.
// 이 스펙은 별도 신규 패턴으로, 활성 변경 요청 실패 시 기존 상태가 보존되고
// 오류 안내 뒤 같은 스위치로 재시도할 수 있는지를 실제 격리 화면에서 검증한다.
describe("문서 변경 자동화 · 트리거 활성 변경 실패와 재시도", () => {
  const targetDir = `/tmp/am-e2e-doctrigger-toggle-failure-${Date.now()}`;
  const triggerName = "활성 변경 실패 복구 트리거";
  const tabs = () => cy.view("docs").find(".docs-section-tabs button");
  const row = () => cy.get(".document-trigger-list article").first();
  const toggle = () => row().find(".app-toggle");

  before(() => {
    cy.exec(`mkdir -p ${targetDir}`);
  });

  after(() => {
    cy.request("POST", "/api/invoke/get_document_automation_snapshot", {}).then((res) => {
      const triggers = (res.body?.triggers ?? []) as Array<{ id: string; name: string }>;
      for (const trigger of triggers) {
        if (trigger.name === triggerName) {
          cy.request("POST", "/api/invoke/delete_document_trigger", { id: trigger.id });
        }
      }
    });
    cleanupDocRoot(targetDir);
  });

  it("첫 변경이 실패하면 활성 상태를 보존하고 오류를 알린 뒤 재시도해 일시중지한다", { retries: 0 }, () => {
    let errorWasVisible = true;

    cy.visitApp();
    cy.openView("docs").should("be.visible");

    cy.get('[aria-label="등록 폴더 추가"]').first().click({ force: true });
    cy.get(".root-form input").eq(1).type(targetDir);
    cy.contains(".root-form button", "폴더 등록").click();
    cy.get(".root-row").should("have.length", 1);

    tabs().eq(1).click();
    cy.get(".document-trigger-grid input").first().type(triggerName);
    cy.get(".document-trigger-grid").last().find("select").first().select("startChat");
    cy.get(".document-trigger-form textarea").last().type("변경 파일을 검토하고 요약해줘");
    cy.get(".document-trigger-form-actions button.primary").click();

    row().find("strong").should("have.text", triggerName);
    toggle().should("have.attr", "aria-checked", "true").and("not.be.disabled");

    cy.intercept(
      { method: "POST", url: "**/api/invoke/set_document_trigger_enabled", times: 1 },
      { statusCode: 500, body: { error: "QA forced trigger toggle failure" } },
    ).as("failedToggle");

    toggle().click();
    cy.wait("@failedToggle");

    cy.get(".document-automation-panel .error-banner")
      .should("exist")
      .and("contain.text", "QA forced trigger toggle failure")
      .then(($banner) => {
        errorWasVisible = Cypress.dom.isVisible($banner);
      });
    toggle().should("have.attr", "aria-checked", "true").and("not.be.disabled");
    row().find("span").first().should("contain.text", "활성").and("not.contain.text", "일시중지");
    row().find("small").should("not.exist");
    cy.screenshot("doc-trigger-toggle-failure-hidden-error");

    toggle().click();
    toggle().should("have.attr", "aria-checked", "false").and("not.be.disabled");
    cy.get(".document-automation-panel .error-banner").should("not.exist");
    row().find("span").first().should("contain.text", "일시중지");
    row().find("small").should("contain.text", "사용자가 비활성화했습니다");

    cy.then(() => {
      expect(errorWasVisible, "실패 직후 오류 배너가 현재 화면에서 보임").to.equal(true);
    });
  });
});
