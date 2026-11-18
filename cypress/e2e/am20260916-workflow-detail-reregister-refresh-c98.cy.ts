/// <reference types="cypress" />

/**
 * 같은 워크플로 계약이 새 버전으로 재등록된 뒤 목록 새로고침이 상세까지 갱신하는지 본다.
 * 기존 워크플로 스펙은 최초 등록·실행·삭제와 탭 왕복을 다뤘지만, 선택 id가 그대로인 채
 * 계약 버전이 바뀌는 흐름은 다루지 않았다. 새 버전의 필드는 반영하되 사용자가 채우던
 * 기존 입력은 보존해야 한다.
 */
describe("워크플로 재등록 뒤 같은 선택의 상세 갱신", () => {
  it("새로고침하면 v2 상세와 새 기본값을 받고 기존 입력 초안은 지킨다", () => {
    const base = Cypress.config("baseUrl") as string;
    expect(base).to.match(/^http:\/\/127\.0\.0\.1:\d{5}\/?$/);
    const invoke = (command: string, body: Record<string, unknown>) =>
      cy.request("POST", `${base.replace(/\/$/, "")}/api/invoke/${command}`, body);

    const id = `detail-refresh-e2e-${Date.now()}`;
    const title = `상세 갱신 검증 ${id}`;
    const contract = (description: string, includeCount: boolean) => ({
      id,
      displayName: title,
      description,
      risk: "mutating",
      inputSchema: {
        message: {
          type: "string",
          required: true,
          label: "전달 문구",
          defaultValue: "초기 문구",
        },
        ...(includeCount ? {
          count: {
            type: "number",
            required: false,
            label: "반복 횟수",
            defaultValue: 3,
          },
        } : {}),
      },
      steps: [{
        id: "start",
        operation: "start_chat",
        arguments: {
          request: {
            chat: { source: "codex", cwd: "/tmp", mode: "plan" },
            message: { $input: "message" },
          },
        },
      }],
    });

    const register = (request: Record<string, unknown>) =>
      invoke("propose_system_workflow_schema", { request }).then(({ body }) => {
        expect(body.valid).to.eq(true);
        return invoke("register_system_workflow", { request: body.contract });
      });

    register(contract("첫 버전 설명", false)).its("body.version").should("eq", 1);

    cy.visitApp();
    cy.openView("workflows");
    cy.anchor("workflows.tab.catalog").should("have.class", "active");
    cy.selectWorkflow(title);
    cy.get(".workflow-detail-panel")
      .should("contain.text", "첫 버전 설명")
      .and("contain.text", "v1");
    cy.get(".workflow-inputs input").should("have.length", 1);
    cy.contains(".workflow-inputs label", "전달 문구").find("input").clear().type("사용자가 작성 중인 문구");

    register(contract("재등록된 두 번째 버전 설명", true)).its("body.version").should("eq", 2);

    // 백엔드가 바뀌어도 새로고침 전 화면은 사용자가 보고 있던 v1 상세다.
    cy.get(".workflow-detail-panel")
      .should("contain.text", "첫 버전 설명")
      .and("contain.text", "v1")
      .and("not.contain.text", "재등록된 두 번째 버전 설명");

    cy.get(".workflow-overview-actions button[aria-label='새로고침']").click();

    cy.get(".workflow-detail-panel")
      .should("contain.text", "재등록된 두 번째 버전 설명")
      .and("contain.text", "v2")
      .and("not.contain.text", "첫 버전 설명");
    cy.get(".workflow-inputs input").should("have.length", 2);
    cy.contains(".workflow-inputs label", "전달 문구").find("input").should("have.value", "사용자가 작성 중인 문구");
    cy.contains(".workflow-inputs label", "반복 횟수").find("input").should("have.value", "3");

    cy.screenshot("am20260916-workflow-detail-reregister-refresh-c98");
  });
});
