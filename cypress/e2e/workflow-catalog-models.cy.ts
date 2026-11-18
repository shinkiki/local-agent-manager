/// <reference types="cypress" />

// 격리 UI 회귀: 워크플로 실행은 모두 가로채고 공급자를 띄우지 않는다.
// QA #60 — 이 스펙은 `.cy.js`라 specPattern(`**/*.cy.ts`) 밖에 있어 하네스가 잡지 못했다.
// 옮기면서 Cypress.env(하네스가 allowCypressEnv:false로 막아 둔 것)와 존재하지 않는
// cy.saveResult 호출을 걷어내고, 주소·화면 열기를 공용 명령으로 바꿨다.
describe("workflow management model selectors", () => {
  it("rejects stale IDs and submits selected provider IDs while preserving ordinary inputs", () => {
    const schema = {
      codexModel: { type: "string", required: true, defaultValue: "obsolete-id" },
      claudeModel: { type: "string", required: false },
      antigravityModel: { type: "string", required: false },
      localModel: { type: "string", required: false },
      projectPath: { type: "string", required: true, defaultValue: "/tmp/test-project" },
    };
    const summary = {
      id: "model-selector-test",
      displayName: "모델 선택 검증",
      description: "fixture",
      version: 1,
      compatible: true,
      computedRisk: "readOnly",
      risk: "readOnly",
      contractDigest: "test",
      inputSchema: schema,
      requiredOperations: ["get_app_status"],
      hardToRecoverEffects: [],
      lastExecution: null,
      paced: false,
    };
    cy.stubInvoke("get_system_workflows", {
      workflows: [summary],
      limits: { maxSteps: 20, maxWorkflows: 64, maxForEachIterations: 100, maxTotalOperationCalls: 200, allowedControl: [], forbidden: [] },
    });
    cy.stubInvoke("get_system_workflow", {
      ...summary,
      contract: { ...summary, steps: [{ id: "read", operation: "get_app_status", arguments: {} }] },
      versions: [],
    });
    cy.stubInvoke("get_chat_provider_options", (req) => {
      const source = (req.body as { source: string }).source;
      req.reply({
        source,
        models: [{ model: `${source}-exact-id`, displayName: `${source} Friendly model`, supportedReasoningEfforts: [] }],
        supportedReasoningEfforts: [],
        settings: [],
      });
    });
    let calls = 0;
    cy.stubInvoke("execute_system_workflow", (req) => {
      calls += 1;
      expect(req.body.arguments).deep.eq({
        codexModel: "codex-exact-id",
        claudeModel: "claude-exact-id",
        antigravityModel: "antigravity-exact-id",
        localModel: "local-exact-id",
        projectPath: "/tmp/test-project",
      });
      req.reply({ executionId: "test", workflowId: summary.id, version: 1, succeeded: true, steps: [], changedTargets: [] });
    }).as("executeFixture");

    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow(summary.displayName);
    const fields = ".workflow-run-section .workflow-inputs";
    // 모델 선택 입력은 넷이다 — 로컬 LLM이 네 번째 공급자로 들어왔다
    // (`src/lib/scheduleWorkflowInputs.ts:35`의 `localModel` 매핑).
    cy.get(fields).find("select").should("have.length", 4);
    cy.get(fields).contains("label", "projectPath").find("input").should("have.value", "/tmp/test-project");
    cy.get(fields).contains("label", "codexModel").find("select").should("have.attr", "aria-invalid", "true");
    cy.clickWorkflowAction("워크플로 실행");
    cy.contains("모델 목록에서 다시 선택하세요").should("be.visible");
    cy.get(".modal").should("not.exist");
    cy.then(() => expect(calls).eq(0));
    for (const source of ["codex", "claude", "antigravity", "local"]) {
      cy.get(fields).contains("label", `${source}Model`).find("select").select(`${source}-exact-id`).should("not.have.attr", "aria-invalid");
    }
    cy.clickWorkflowAction("워크플로 실행");
    cy.get(".modal").contains("button", /^실행$/).click();
    cy.wait("@executeFixture");
    cy.then(() => expect(calls).eq(1));
  });
});
