// 공통 실행설정(WorkflowRuntimeEditor.tsx)은 2026-09-10에 들어온 신규 패널이다.
// workflow-runtime.cy.js는 프리셋 적용 → 확인창 승인 → 저장 → 새로고침 잔존 →
// 상속 복원까지 "성공하는 길"만 본다. 여기서는 그 반대편, 즉 사용자가 저장을 물러선
// 자리들을 본다.
//   1) 확인창을 취소하면 계약 버전이 오르지 않고 고른 값은 화면에 그대로 남는가
//   2) '변경 취소'가 초안을 계약값으로 되돌리고 두 버튼을 다시 잠그는가
//   3) 승인 처리를 '직접 승인'으로 두면 무인 회차 경고가 뜨고, 물리면 사라지는가
// 격리 백엔드에만 계약을 만들고 채팅을 시작하지 않으므로 운영 데이터에 닿지 않는다.
const PANEL = '[data-ui-anchor="workflows.runtime-settings"]';
const MANUAL_NOTICE = "무인 회차에서는 직접 승인 요청을 처리할 수 없어";

describe("워크플로 공통 실행설정 · 저장을 물러서는 길", () => {
  it("확인창 취소는 버전을 올리지 않고, '변경 취소'는 초안을 계약값으로 되돌린다", () => {
    const base = Cypress.config("baseUrl") as string;
    expect(base).to.match(/^http:\/\/127\.0\.0\.1:\d{5}\/?$/);
    const invoke = (command: string, body: Record<string, unknown>) =>
      cy.request("POST", `${base.replace(/\/$/, "")}/api/invoke/${command}`, body);

    const id = `runtime-cancel-e2e-${Date.now()}`;
    const title = `실행설정 취소 검증 ${id}`;
    const contract = {
      id,
      displayName: title,
      description: "격리된 테스트 계약: 실행하지 않음",
      risk: "mutating",
      inputSchema: {},
      steps: [{
        id: "start",
        operation: "start_chat",
        arguments: { request: { chat: { source: "codex", cwd: "/tmp", mode: "plan" }, message: "test only" } },
      }],
    };
    invoke("propose_system_workflow_schema", { request: contract }).then(({ body }) => {
      expect(body.valid).to.eq(true);
      invoke("register_system_workflow", { request: body.contract }).its("body.version").should("eq", 1);
    });

    cy.visitApp();
    cy.openView("workflows");
    cy.contains("button", title).click();
    cy.stubInvoke("register_system_workflow").as("saveRuntime");

    // 사전조건: 계약에 chatRuntime이 없으므로 세 칸 모두 상속이고 두 버튼은 잠겨 있다.
    cy.get(PANEL).find("select").should("have.length", 3).each(($select) => {
      cy.wrap($select).should("have.value", "");
    });
    cy.get(PANEL).contains("button", "검토 후 저장").should("be.disabled");
    cy.get(PANEL).contains("button", "변경 취소").should("be.disabled");
    cy.get(PANEL).find('p[role="status"]').should("not.exist");

    // 1) '직접 승인'은 무인 회차 경고를 띄운다. 이 안내는 조건부라 상속 상태에서는 없었다.
    cy.get(PANEL).find('select[aria-label="승인 처리"]').select("manual");
    cy.get(PANEL).find('p[role="status"]').should("contain.text", MANUAL_NOTICE);
    cy.get(PANEL).contains("button", "검토 후 저장").should("be.enabled");
    cy.get(PANEL).contains("button", "변경 취소").should("be.enabled");

    // 물리면 안내도 함께 사라진다.
    cy.get(PANEL).find('select[aria-label="승인 처리"]').select("never");
    cy.get(PANEL).find('p[role="status"]').should("not.exist");

    // 2) 전체권한까지 골라 확인창을 연다. 요약과 경고가 고른 값을 그대로 되읽어야 한다.
    cy.get(PANEL).find('select[aria-label="권한 범위"]').select("fullAccess");
    cy.get(PANEL).find('select[aria-label="판단 처리"]').select("ask");
    cy.get(PANEL).contains("button", "검토 후 저장").click();
    cy.get('[role="dialog"]').should("be.visible")
      .and("contain.text", "권한 범위: 전체권한")
      .and("contain.text", "승인 처리: 승인 없이 실행")
      .and("contain.text", "판단 처리: 사용자에게 확인")
      .and("contain.text", "전체권한은 작업 경로 밖의");

    // 3) 취소하면 저장 요청 자체가 나가지 않는다.
    cy.get('[role="dialog"]').contains("button", "취소").click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.get("@saveRuntime.all").should("have.length", 0);

    // 고른 값은 화면에 남고, 저장 수단도 살아 있어야 한다 — 취소는 되돌리기가 아니다.
    cy.get(PANEL).find('select[aria-label="권한 범위"]').should("have.value", "fullAccess");
    cy.get(PANEL).find('select[aria-label="승인 처리"]').should("have.value", "never");
    cy.get(PANEL).find('select[aria-label="판단 처리"]').should("have.value", "ask");
    cy.get(PANEL).contains("button", "검토 후 저장").should("be.enabled");

    // 저장된 계약은 그대로 1판이고 chatRuntime도 붙지 않았다.
    invoke("get_system_workflow", { workflowId: id }).then(({ body }) => {
      expect(body.version).to.eq(1);
      expect(body.contract.chatRuntime).to.eq(undefined);
    });

    // 4) '변경 취소'는 초안을 계약값(= 상속)으로 되돌리고 두 버튼을 다시 잠근다.
    cy.get(PANEL).contains("button", "변경 취소").click();
    cy.get(PANEL).find("select").each(($select) => {
      cy.wrap($select).should("have.value", "");
    });
    cy.get(PANEL).contains("button", "검토 후 저장").should("be.disabled");
    cy.get(PANEL).contains("button", "변경 취소").should("be.disabled");
    cy.get(PANEL).find('p[role="status"]').should("not.exist");

    // 화면을 다녀와도 저장하지 않은 초안은 남지 않는다.
    cy.openView("sessions");
    cy.openView("workflows");
    cy.contains("button", title).click();
    cy.get(PANEL).find('select[aria-label="권한 범위"]').should("have.value", "");
    cy.get("@saveRuntime.all").should("have.length", 0);
    invoke("get_system_workflow", { workflowId: id }).its("body.version").should("eq", 1);
  });
});
