/// <reference types="cypress" />

/**
 * 버전 비교를 펼쳐 둔 채 다른 워크플로로 옮겼을 때 앞 계약의 선택이 남는지 본다.
 *
 * 버전 비교의 기준·비교 선택은 화면 안의 상태다. 워크플로를 바꾸면 버전 목록이 통째로
 * 달라지므로, 앞에서 고른 번호가 새 계약에 없을 수 있다. 그때 비교가 조용히 비어 버리면
 * 사람은 "두 버전이 같다"와 "고른 버전이 없다"를 구분할 수 없다.
 *
 * 같은 화면의 실행설정 편집기는 `key={detail.id}:{detail.version}`로 갈아 끼워 이 문제를
 * 피한다(`src/components/WorkflowsView.tsx:557`). 버전 이력에도 같은 보장이 있어야 한다.
 */
describe("워크플로 전환 후 버전 비교 잔존", () => {
  const invoke = (command: string, body: Record<string, unknown>) =>
    cy.request("POST", `/api/invoke/${command}`, body);

  const stamp = Date.now();
  const deepId = `version-switch-deep-${stamp}`;
  const shallowId = `version-switch-shallow-${stamp}`;
  const deepTitle = `버전 셋 계약 ${stamp}`;
  const shallowTitle = `버전 둘 계약 ${stamp}`;

  const contract = (id: string, displayName: string, overrides: Record<string, unknown> = {}) => ({
    id,
    displayName,
    description: "격리된 테스트 계약: 실행하지 않음",
    risk: "mutating",
    paced: true,
    inputSchema: { projectPath: { type: "string", required: true, label: "대상 저장소", defaultValue: "/tmp" }, message: { type: "string", required: true, defaultValue: "테스트" } },
    steps: [{
      id: "s01",
      operation: "start_chat",
      arguments: {
        request: {
          chat: { source: { $run: "source" }, accountId: { $run: "accountId" }, cwd: { $run: "cwd" }, model: { $run: "model" } },
          message: { $input: "message" },
          idempotencyKey: { $idempotencyKey: true },
        },
      },
    }],
    ...overrides,
  });

  const register = (request: Record<string, unknown>) =>
    invoke("propose_system_workflow_schema", { request }).then(({ body }) => {
      expect(body.valid, "계약 검증").eq(true);
      return invoke("register_system_workflow", { request: body.contract });
    });

  before(() => {
    // 기준이 되는 계약은 버전 셋, 옮겨 갈 계약은 버전 둘이다. 앞에서 v3을 고르면 뒤에는 없다.
    register(contract(deepId, deepTitle)).its("body.version").should("eq", 1);
    register(contract(deepId, deepTitle, { risk: "destructive" })).its("body.version").should("eq", 2);
    register(contract(deepId, deepTitle, {
      inputSchema: { projectPath: { type: "string", required: true, label: "대상 저장소", defaultValue: "/tmp" }, message: { type: "string", required: true, defaultValue: "테스트" }, note: { type: "string", required: false } },
    })).its("body.version").should("eq", 3);
    register(contract(shallowId, shallowTitle)).its("body.version").should("eq", 1);
    register(contract(shallowId, shallowTitle, { risk: "destructive" })).its("body.version").should("eq", 2);
  });

  it("앞 계약에서 고른 버전 번호가 다음 계약의 비교로 새지 않는다", () => {
    cy.viewport(1440, 1000);
    cy.visitApp();
    cy.openView("workflows");

    cy.selectWorkflow(deepTitle);
    cy.anchor("workflows.version-compare").click();
    cy.get(".workflow-version-diff").within(() => {
      cy.get("select").should("have.length", 2);
      // 사람이 직접 v1 ↔ v3을 고른다. 이 번호는 옮겨 갈 계약에 없다.
      cy.get("select").eq(0).select("1").should("have.value", "1");
      cy.get("select").eq(1).select("3").should("have.value", "3");
      cy.get(".workflow-diff-summary").should("contain.text", "입력 추가");
    });

    // 비교를 펼쳐 둔 채 버전이 둘뿐인 계약으로 옮긴다.
    cy.selectWorkflow(shallowTitle);
    cy.get(".workflow-versions em").should("have.text", "2");

    // 비교는 접힌 자리에서 다시 시작한다 — 앞 계약의 펼침 상태가 따라오지 않는다.
    cy.anchor("workflows.version-compare").should("have.attr", "aria-expanded", "false");
    cy.get(".workflow-version-diff").should("not.exist");

    cy.anchor("workflows.version-compare").click();
    cy.get(".workflow-version-diff").within(() => {
      // 고른 번호는 이 계약이 실제로 가진 버전이어야 한다. v3은 여기 없다.
      cy.get("select").eq(0).should("have.value", "1");
      cy.get("select").eq(1).should("have.value", "2");
      cy.get("select").eq(1).find("option").should("have.length", 2);
      // 비교가 성립했다는 근거가 화면에 있다.
      cy.get(".workflow-diff-summary").should("contain.text", "위험도 변경");
    });
  });
});
