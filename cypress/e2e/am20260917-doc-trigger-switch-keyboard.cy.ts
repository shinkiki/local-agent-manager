/// <reference types="cypress" />
import { cleanupDocRoot, ensureDocRoot, purgeDocRoots } from "../support/docRootFixtures";

// 3a402429가 문서 트리거 활성 체크박스를 공용 AppToggle로 바꿨다.
// 기존 AM-271은 마우스 클릭과 탭 왕복 뒤 상태 잔존을 확인한다.
// 이 신규 패턴은 공용 스위치가 추가한 접근 가능한 이름, Tab 키 초점 경로,
// 저장 중 비활성화에 따른 중복 요청 차단을 실제 화면과 API 요청 수로 확인한다.

describe("문서 트리거 공용 스위치의 키보드 초점과 중복 입력 차단", () => {
  const targetDir = `/tmp/am-e2e-doctrigger-keyboard-${Date.now()}`;
  const triggerName = "키보드 전환 확인 트리거";
  const tabs = () => cy.view("docs").find(".docs-section-tabs button");
  const row = () => cy.get(".document-trigger-list article").contains("strong", triggerName).closest("article");
  const toggle = () => row().find(`[role="switch"][aria-label="${triggerName} 활성화"]`);

  beforeEach(() => {
    cy.exec(`mkdir -p ${targetDir}`);
    cy.request("POST", "/api/invoke/get_document_automation_snapshot", {}).then((res) => {
      const triggers = (res.body?.triggers ?? []) as Array<{ id: string; name: string }>;
      for (const trigger of triggers) {
        if (trigger.name === triggerName) {
          cy.request("POST", "/api/invoke/delete_document_trigger", { id: trigger.id });
        }
      }
    });
    purgeDocRoots(targetDir);
    ensureDocRoot(targetDir);
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

  it("Tab으로 이름이 붙은 스위치에 도달하고 저장 중 두 번째 입력은 요청을 늘리지 않는다", () => {
    let toggleRequests = 0;
    cy.stubInvoke("set_document_trigger_enabled", (req) => {
      toggleRequests += 1;
      req.continue((res) => res.setDelay(900));
    }).as("toggleTrigger");

    cy.visitApp();
    cy.openView("docs").should("be.visible");

    tabs().eq(1).click();
    cy.get(".document-trigger-grid input").first().type(triggerName);
    cy.get(".document-trigger-grid").last().find("select").first().select("startChat");
    cy.get(".document-trigger-form textarea").last().type("변경 파일을 검토해줘");
    cy.get(".document-trigger-form-actions button.primary").click();

    toggle()
      .should("have.prop", "tagName", "BUTTON")
      .and("have.attr", "aria-checked", "true")
      .and("have.attr", "aria-label", `${triggerName} 활성화`)
      .and("not.be.disabled");
    row().find('button[aria-label="테스트"]').focus().should("have.focus");
    cy.press(Cypress.Keyboard.Keys.TAB);
    cy.focused()
      .should("have.attr", "role", "switch")
      .and("have.attr", "aria-label", `${triggerName} 활성화`)
      .click();

    toggle().should("be.disabled");
    toggle().click({ force: true });
    cy.wrap(null).then(() => {
      expect(toggleRequests, "저장 중 추가 전환 요청").to.equal(1);
    });

    cy.wait("@toggleTrigger").its("request.body").should("deep.include", { enabled: false });
    toggle()
      .should("not.be.disabled")
      .and("have.attr", "aria-checked", "false")
      .and("have.attr", "aria-label", `${triggerName} 활성화`);
    row().find("small").should("contain.text", "사용자가 비활성화했습니다");
    cy.wrap(null).then(() => {
      expect(toggleRequests, "완료된 상태 전환 요청").to.equal(1);
    });

    cy.screenshot("doc-trigger-switch-keyboard-focus");
  });
});
