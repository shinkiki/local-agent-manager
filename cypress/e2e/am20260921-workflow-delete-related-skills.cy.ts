/// <reference types="cypress" />

/**
 * 워크플로 삭제가 그 계약의 절차 스킬을 같이 지우는 갈래.
 *
 * 계약은 단계 목록일 뿐이고 절차는 `requiredSkills`가 거는 보관 스킬에 적혀 있다. 계약만
 * 지우면 아무도 부르지 않는 절차 스킬이 스킬 화면에 남으므로, 삭제 확인에서 한 번 더 묻고
 * 고른 때만 같이 지운다. 확인창의 선택 항목·스킬이 실제로 휴지통으로 가는지·다른 워크플로가
 * 같이 거는 스킬은 남는지는 화면과 백엔드를 함께 지나야만 참이라 여기서 본다.
 *
 * 계약과 스킬은 격리 백엔드에 실제로 등록한다.
 */
describe("워크플로 삭제와 절차 스킬", () => {
  const invoke = (command: string, body: Record<string, unknown>) =>
    cy.request("POST", `/api/invoke/${command}`, body);

  /**
   * 절차 스킬 만들기. 실패한 시도를 Cypress가 다시 돌릴 때 같은 키가 이미 있으면 409가
   * 오는데, 그 오류가 원래 실패를 덮어 무엇이 틀렸는지 보이지 않는다. 있으면 그대로 쓴다.
   */
  const ensureSkill = (key: string, description: string) =>
    cy.request({
      method: "POST",
      url: "/api/invoke/create_common_skill",
      body: { request: { key, description } },
      failOnStatusCode: false,
    });

  const stamp = Date.now();

  const contract = (id: string, title: string, skills: string[]) => ({
    id,
    displayName: title,
    description: "격리된 테스트 계약: 실행하지 않음",
    risk: "readOnly",
    requiredSkills: skills,
    steps: [{ id: "s01", operation: "get_system_workflows", arguments: {} }],
  });

  const register = (request: Record<string, unknown>) =>
    invoke("propose_system_workflow_schema", { request }).then(({ body }) => {
      expect(body.valid, "계약 검증").eq(true);
      return invoke("register_system_workflow", { request: body.contract });
    });

  const openDelete = (title: string) => {
    cy.viewport(1440, 1000);
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow(title);
    cy.get('.workflow-detail-header button[aria-label="워크플로 삭제"]').click();
    return cy.get(".confirm-dialog").should("be.visible");
  };

  const skillKeys = () => invoke("get_skill_library", {})
    .its("body.entries")
    .then((entries: { key: string }[]) => entries.map((entry) => entry.key));

  it("이 워크플로만 쓰는 스킬은 함께 지울지 묻고, 고르면 휴지통으로 보낸다", () => {
    const id = `delete-skill-e2e-${stamp}`;
    const title = `삭제 검증 ${id}`;
    const skill = `delete-skill-${stamp}`;
    ensureSkill(skill, "삭제 검증용 절차 스킬");
    register(contract(id, title, [skill])).its("body.version").should("eq", 1);

    openDelete(title)
      .should("contain.text", "이 워크플로만 쓰는 절차 스킬 1개도 함께 삭제")
      .and("contain.text", skill);
    // 기본값은 꺼짐이다 — 계약 밖의 자산을 지우는 일이라 사용자가 골라야 한다.
    cy.get(".confirm-dialog-option input").should("not.be.checked").check();
    cy.contains(".modal-footer button", "삭제").click();

    cy.get(".notice-banner").should("contain.text", title).and("contain.text", skill);
    cy.workflowCard(title).should("not.exist");
    skillKeys().should("not.include", skill);
    invoke("list_skill_trash", {}).its("body.items").then((items: { key: string }[]) => {
      expect(items.map((item) => item.key)).to.include(skill);
    });
  });

  it("고르지 않으면 계약만 사라지고 절차 스킬은 그대로 남는다", () => {
    const id = `keep-skill-e2e-${stamp}`;
    const title = `보존 검증 ${id}`;
    const skill = `keep-skill-${stamp}`;
    ensureSkill(skill, "보존 검증용 절차 스킬");
    register(contract(id, title, [skill])).its("body.version").should("eq", 1);

    openDelete(title);
    cy.get(".confirm-dialog-option input").should("not.be.checked");
    cy.contains(".modal-footer button", "삭제").click();

    cy.workflowCard(title).should("not.exist");
    skillKeys().should("include", skill);
  });

  it("다른 워크플로도 거는 스킬은 선택지에 없고 남긴다고 말한다", () => {
    const shared = `shared-skill-${stamp}`;
    const keeperId = `keeper-e2e-${stamp}`;
    const doomedId = `doomed-e2e-${stamp}`;
    const doomedTitle = `공유 스킬 검증 ${doomedId}`;
    ensureSkill(shared, "두 계약이 함께 쓰는 절차 스킬");
    register(contract(keeperId, `공유 스킬 보유자 ${keeperId}`, [shared])).its("body.version").should("eq", 1);
    register(contract(doomedId, doomedTitle, [shared])).its("body.version").should("eq", 1);

    openDelete(doomedTitle)
      .should("contain.text", "다른 워크플로도 쓰므로 그대로 둡니다")
      .and("contain.text", shared);
    // 지울 수 있는 스킬이 없으므로 선택 항목 자체가 뜨지 않는다.
    cy.get(".confirm-dialog-option").should("not.exist");
    cy.contains(".modal-footer button", "삭제").click();

    cy.workflowCard(doomedTitle).should("not.exist");
    skillKeys().should("include", shared);
  });
});
