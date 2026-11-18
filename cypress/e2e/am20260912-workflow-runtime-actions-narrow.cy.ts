/// <reference types="cypress" />
// 워크플로 상세의 공통 실행설정(WorkflowRuntimeEditor.tsx) 안 버튼 줄이 좁은 화면에서
// 입력들과 좌우 끝을 맞추는지 본다.
//
// 이 줄은 원래 상세 헤더용 `.workflow-detail-actions`를 그대로 썼다. 그 클래스에는
// `padding: 11px 18px`와 `border-bottom`이 붙어 있어(App.css:1798) fieldset 안에서는
// 셀렉트보다 18px 안쪽에서 시작하고 밑줄까지 따라왔다. 데스크톱에선 오른쪽 정렬이라
// 덜 드러나다가, 600px 아래에서 `justify-content: stretch`로 풀리면서 모바일에서
// 어긋남이 보였다(ab31c18에서 `.runtime-settings-actions`로 분리).
//
// 기존 실행설정 스펙(am20260910-workflow-runtime-cancel, workflow-runtime)은 값·저장
// 흐름만 보고 배치는 보지 않는다. 여기서는 문구가 아니라 배치만 붙잡는다.
const PANEL = '[data-ui-anchor="workflows.runtime-settings"]';
const NARROW = 390;

/** 가로 끝 맞춤은 반올림 차이를 허용한다. 18px 어긋남은 이 범위를 훌쩍 넘는다. */
const TOLERANCE = 1.5;

describe("좁은 화면 공통 실행설정 버튼 줄의 좌우 끝", () => {
  it("390px에서 두 버튼 줄이 셀렉트와 좌우 끝을 맞추고 구분선을 끌고 오지 않는다", () => {
    const base = (Cypress.config("baseUrl") as string).replace(/\/$/, "");
    expect(base).to.match(/^http:\/\/127\.0\.0\.1:\d{5}$/);

    const id = `runtime-actions-narrow-e2e-${Date.now()}`;
    const title = `실행설정 버튼 줄 배치 검증 ${id}`;
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
    cy.request("POST", `${base}/api/invoke/propose_system_workflow_schema`, { request: contract })
      .then(({ body }) => {
        expect(body.valid).to.eq(true);
        cy.request("POST", `${base}/api/invoke/register_system_workflow`, { request: body.contract })
          .its("body.version").should("eq", 1);
      });

    cy.viewport(NARROW, 844);
    cy.visitApp();
    cy.openView("workflows");
    cy.contains("button", title).click();
    cy.get(PANEL).should("be.visible");

    // 사전조건: 프리셋 줄 하나, 저장/취소 줄 하나, 그리고 셀렉트 셋.
    cy.get(PANEL).find(".runtime-settings-actions").should("have.length", 2);
    cy.get(PANEL).find(".workflow-inputs select").should("have.length", 3);
    // 헤더용 액션 바를 더는 빌려 쓰지 않는다 — 다시 쓰면 여백·밑줄이 함께 돌아온다.
    cy.get(PANEL).find("fieldset .workflow-detail-actions").should("not.exist");

    cy.get(PANEL).find(".workflow-inputs select").first().then(($select) => {
      const field = $select[0].getBoundingClientRect();
      expect(field.width, "좁은 화면에서 셀렉트가 한 칸으로 펼쳐진다").to.be.greaterThan(200);

      cy.get(PANEL).find(".runtime-settings-actions").each(($row, index) => {
        const style = window.getComputedStyle($row[0]);
        const buttons = Array.from($row[0].querySelectorAll("button"))
          .map((button) => button.getBoundingClientRect());
        expect(buttons, `${index}번 줄에 버튼 둘이 있다`).to.have.length(2);

        // 줄 상자가 아니라 버튼 끝을 본다. 헤더용 액션 바의 좌우 18px 여백은 상자
        // 안쪽에 들어가므로 상자 사각형만 보면 어긋남이 드러나지 않는다.
        const left = Math.min(...buttons.map((rect) => rect.left));
        const right = Math.max(...buttons.map((rect) => rect.right));
        expect(left, `${index}번 줄 첫 버튼이 셀렉트와 왼쪽 끝을 맞춘다`)
          .to.be.closeTo(field.left, TOLERANCE);
        expect(right, `${index}번 줄 버튼이 셀렉트 오른쪽을 넘지 않는다`)
          .to.be.at.most(field.right + TOLERANCE);
        expect(style.borderBottomWidth, `${index}번 버튼 줄에 구분선이 없다`).to.eq("0px");
      });
    });

    // 배치만 보는 스펙이므로 계약은 그대로 1판이어야 한다(저장 흐름을 건드리지 않았다).
    cy.request("POST", `${base}/api/invoke/get_system_workflow`, { workflowId: id })
      .its("body.version").should("eq", 1);
  });
});
