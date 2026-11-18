/// <reference types="cypress" />

// 격리 E2E 백엔드에서만 돌고 공급자 대화를 시작하지 않는다.
// QA #60 — `.cy.js`라 하네스가 잡지 못하던 스펙을 옮겼다. Cypress.env와 cy.saveResult를
// 걷어내고 주소는 baseUrl 상대 경로로, 화면 열기는 공용 명령으로 바꿨다.
describe("workflow shared runtime", () => {
  it("saves one preset for every provider and restores step inheritance", () => {
    const invoke = (command: string, body: Record<string, unknown>) => cy.request("POST", `/api/invoke/${command}`, body);
    const id = `runtime-e2e-${Date.now()}`;
    const title = `공통 실행설정 검증 ${id}`;
    const contract = {
      id,
      displayName: title,
      description: "격리된 테스트 계약: 실행하지 않음",
      risk: "mutating",
      inputSchema: {},
      steps: [
        {
          id: "start",
          operation: "start_chat",
          arguments: { request: { chat: { source: "codex", cwd: "/tmp", mode: "plan" }, message: "test only" } },
        },
      ],
    };
    invoke("propose_system_workflow_schema", { request: contract }).then(({ body }) => {
      expect(body.valid).eq(true);
      invoke("register_system_workflow", { request: body.contract }).its("body.version").should("eq", 1);
    });
    cy.viewport(1440, 1000);
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow(title);
    cy.stubInvoke("register_system_workflow").as("saveRuntime");
    const panel = '[data-ui-anchor="workflows.runtime-settings"]';
    cy.get(panel).find("select").should("have.length", 3);
    cy.get(panel).contains("button", "검토 후 저장").should("be.disabled");
    cy.get(panel).contains("button", "무인 개발 설정").click();
    cy.get(panel).find("select").eq(0).should("have.value", "fullAccess");
    cy.get(panel).find("select").eq(1).should("have.value", "never");
    cy.get(panel).find("select").eq(2).should("have.value", "recommended");
    cy.get(panel).contains("button", "검토 후 저장").click();
    cy.get(".modal").should("contain.text", "새 계약 버전").and("contain.text", "전체권한");
    // 격리 픽스처의 테스트 전용 확인 모달이지 AIA 승인 카드가 아니다.
    cy.get(".modal").contains("button", "새 버전 저장").click();
    cy.wait("@saveRuntime").its("response.statusCode").should("eq", 200);
    cy.get(".modal").should("not.exist");
    cy.get(panel).contains("button", "검토 후 저장").should("be.disabled");
    invoke("get_system_workflow", { workflowId: id }).then(({ body }) => {
      expect(body.version).eq(2);
      expect(body.contract.chatRuntime).deep.eq({ mode: "fullAccess", approvalMode: "never", decisionPolicy: "recommended" });
      expect(body.contract.steps[0].arguments.request.chat.mode).eq("plan");
    });
    cy.reload();
    cy.openView("workflows");
    cy.selectWorkflow(title);
    cy.get(panel).find("select").eq(2).should("have.value", "recommended");
    cy.get(panel).contains("button", "검토 후 저장").should("be.disabled");
    cy.get(panel).contains("button", "기존 단계 설정 사용").click();
    cy.get(panel).contains("button", "검토 후 저장").click();
    cy.get(".modal").contains("button", "새 버전 저장").click();
    cy.wait("@saveRuntime").its("response.statusCode").should("eq", 200);
    cy.get(".modal").should("not.exist");
    cy.get(panel).contains("button", "검토 후 저장").should("be.disabled");
    invoke("get_system_workflow", { workflowId: id }).then(({ body }) => {
      expect(body.version).eq(3);
      expect(body.contract.chatRuntime).eq(undefined);
      expect(body.contract.steps[0].arguments.request.chat.mode).eq("plan");
    });
  });
});
