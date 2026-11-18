/// <reference types="cypress" />

/**
 * 워크플로 상세의 절차 도식·필요 스킬·버전 비교.
 *
 * 도식 원문을 만드는 일은 순수 함수라 node 테스트가 잡는다(`workflowDiagram.test.mjs`).
 * 여기서 확인할 것은 그 원문이 **엔진에서 실제로 그려지는가**다 — 라벨 이스케이프나 노드
 * 문법이 하나만 어긋나도 그림이 통째로 사라지는데, 문자열 단정으로는 그 실패가 보이지 않는다.
 *
 * 계약은 격리 백엔드에 실제로 등록한다. 새 계약 필드(`requiredSkills`)와 상세 응답의
 * `missingSkills`·버전별 계약 본문까지 같은 경로로 지나가야 화면이 보는 값이 진짜가 된다.
 */
describe("워크플로 절차 도식", () => {
  const invoke = (command: string, body: Record<string, unknown>) =>
    cy.request("POST", `/api/invoke/${command}`, body);
  const id = `procedure-e2e-${Date.now()}`;
  const title = `절차 도식 검증 ${id}`;
  const skill = `procedure-skill-${Date.now()}`;

  const contract = (overrides: Record<string, unknown> = {}) => ({
    id,
    displayName: title,
    description: "격리된 테스트 계약: 실행하지 않음",
    risk: "mutating",
    paced: true,
    requiredSkills: [skill],
    inputSchema: {
      projectPath: { type: "string", required: true, label: "대상 저장소", defaultValue: "/tmp" },
      message: { type: "string", required: true, defaultValue: "테스트" },
    },
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
    register(contract()).its("body.version").should("eq", 1);
  });

  it("회차 봉투와 계약 단계, 선언한 스킬을 한 그림으로 그린다", () => {
    cy.viewport(1440, 1000);
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow(title);

    // 엔진은 첫 다이어그램에서 내려온다. SVG가 붙어야 원문이 문법으로 성립했다는 뜻이다.
    cy.anchor("workflows.procedure-diagram")
      .find(".diagram-viewer-canvas svg", { timeout: 20_000 })
      .should("exist")
      .and("contain.text", "회차 봉투")
      .and("contain.text", "start_chat")
      // 상자 라벨은 두 줄로 접히므로 이름과 키가 한 문자열로 이어지지 않는다.
      .and("contain.text", skill);
  });

  it("선언한 스킬이 보관 저장소에 없으면 목록과 상세가 함께 알린다", () => {
    cy.viewport(1440, 1000);
    cy.visitApp();
    cy.openView("workflows");
    cy.workflowCard(title).should("contain.text", "스킬 없음");
    cy.selectWorkflow(title);
    cy.get(".workflow-procedure").should("contain.text", "이 장치에 없는 스킬").and("contain.text", skill);
    cy.get(".workflow-skill-chip.missing").should("have.length", 1);
  });

  it("스킬을 만들어 두면 상자를 눌러 본문을 읽을 수 있다", () => {
    invoke("create_common_skill", { request: { key: skill, description: "절차 도식 검증용 스킬" } });
    cy.viewport(1440, 1000);
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow(title);
    // 저장소에 생겼으므로 경고가 사라진다.
    cy.get(".workflow-procedure").should("not.contain.text", "이 장치에 없는 스킬");
    cy.get(".workflow-skill-chip").should("have.length", 1).and("not.have.class", "missing").click();
    cy.get(".drawer").should("contain.text", skill).find(".markdown-preview").should("contain.text", "절차 도식 검증용 스킬");
  });

  it("버전을 올리면 무엇이 달라졌는지 이름으로 먼저 말한다", () => {
    register(contract({ requiredSkills: [], risk: "destructive" })).its("body.version").should("eq", 2);
    cy.viewport(1440, 1000);
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow(title);
    cy.anchor("workflows.version-compare").click();
    cy.get(".workflow-version-diff").within(() => {
      cy.get("select").eq(0).should("have.value", "1");
      cy.get("select").eq(1).should("have.value", "2");
      cy.get(".workflow-diff-summary").should("contain.text", "스킬 삭제").and("contain.text", "위험도 변경");
      // 요약의 근거로 원문 비교가 함께 있고, 버전 번호 줄은 차이로 잡지 않는다.
      cy.get("pre.skill-diff").should("exist").and("not.contain.text", '"version"');
    });
  });
});
