import { stubWorkflowCatalog, workflowDetail, workflowSummary } from "../support/workflowFixtures";

// 계약이 선언한 입력 타입별로 어떤 컨트롤이 그려지는지(src/components/Shared.tsx:1012-1069)는
// 어느 화면 스펙도 보지 않았다. 기존 워크플로 스펙 셋은 문자열 입력만 쓰는 계약으로
// 기본값 프리필(AM 기본값 스펙)·필수 안내·탭 전환 잔존만 확인한다. 여기서 보는 것은
// 네 가지다.
//   1) string/number/enum/boolean이 각각 text·number·select·checkbox로 갈린다
//   2) 라벨·키·설명·필수 별표가 계약대로 붙는다
//   3) 필수 boolean은 체크하지 않아도 실행을 막지 않는다
//      (WorkflowsView.tsx:260의 `field.type !== "boolean"` 예외)
//   4) 빈 필수 enum은 실행을 막고 aria-invalid가 붙으며, 고르면 그 표시만 걷힌다
describe("워크플로 실행 입력의 타입별 컨트롤과 필수 판정", () => {
  const CONTRACT = workflowSummary({
    description: "네 가지 입력 타입을 모두 선언한 계약",
    displayName: "입력 타입 계약",
    id: "wf-input-types",
    inputSchema: {
      // 라벨과 설명이 모두 있는 필수 문자열. 제목은 라벨, 키는 작게 함께 남아야 한다.
      branch: { defaultValue: null, description: "빌드를 돌릴 브랜치", label: "대상 브랜치", required: true, type: "string", values: null },
      // 라벨이 없는 선택 숫자. 제목 자리에 키가 그대로 온다.
      maxRuns: { defaultValue: null, description: null, label: null, required: false, type: "number", values: null },
      // 필수 enum. 빈 칸이면 실행을 막아야 한다.
      mode: { defaultValue: null, description: null, label: "실행 모드", required: true, type: "enum", values: ["dry-run", "apply"] },
      // 필수 boolean. 체크하지 않아도 실행을 막으면 안 된다.
      notify: { defaultValue: null, description: null, label: "알림 보내기", required: true, type: "boolean", values: null },
    },
  });

  const control = (index: number) => cy.get(".workflow-inputs > label").eq(index);

  beforeEach(() => {
    stubWorkflowCatalog([CONTRACT]);
    cy.stubInvoke("get_system_workflow", workflowDetail(CONTRACT));
    cy.visitApp();
    cy.openView("workflows");
    cy.get(".workflow-inputs > label").should("have.length", 4);
  });

  it("타입마다 다른 컨트롤을 그린다 — text·number·select·checkbox", () => {
    // 스키마 선언 순서(branch, maxRuns, mode, notify)를 그대로 따른다.
    control(0).find("input").should("have.attr", "type", "text");
    control(1).find("input").should("have.attr", "type", "number");
    control(2).find("select").should("exist");
    control(3).should("have.class", "workflow-input-boolean").find("input").should("have.attr", "type", "checkbox");
  });

  it("enum은 빈 '선택' 항목과 선언한 값만 목록에 둔다", () => {
    control(2).find("select option").should("have.length", 3);
    control(2).find("select option").eq(0).should("have.value", "").and("have.text", "선택");
    control(2).find("select option").eq(1).should("have.value", "dry-run");
    control(2).find("select option").eq(2).should("have.value", "apply");
    control(2).find("select").should("have.value", "");
  });

  it("라벨이 있으면 제목은 라벨이고 키는 작게 함께 남으며, 없으면 키가 제목이 된다", () => {
    control(0).find(".workflow-input-heading > span").first().should("have.text", "대상 브랜치");
    control(0).find(".workflow-input-key").should("have.text", "branch");
    control(0).should("contain.text", "빌드를 돌릴 브랜치");

    control(1).find(".workflow-input-heading > span").first().should("have.text", "maxRuns");
    control(1).find(".workflow-input-key").should("not.exist");
  });

  it("필수 입력에만 별표와 aria-required가 붙는다", () => {
    // branch·mode·notify 셋이 필수, maxRuns만 선택이다.
    cy.get(".workflow-inputs .workflow-input-required").should("have.length", 3);
    control(1).find(".workflow-input-required").should("not.exist");

    control(0).find("input").should("have.attr", "aria-required", "true");
    control(1).find("input").should("not.have.attr", "aria-required");
    control(2).find("select").should("have.attr", "aria-required", "true");
  });

  it("필수 boolean은 체크하지 않아도 실행을 막지 않고, 빈 필수 문자열·enum만 짚는다", () => {
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".workflow-input-problem")
      .should("be.visible")
      .and("contain.text", "필수 입력 2개")
      .and("contain.text", "대상 브랜치")
      .and("contain.text", "실행 모드")
      .and("not.contain.text", "알림 보내기");

    // 짚힌 두 칸에만 유효하지 않음 표시가 붙는다.
    cy.get(".workflow-inputs .workflow-input-invalid").should("have.length", 2);
    control(2).find("select").should("have.attr", "aria-invalid", "true");
    control(3).should("not.have.class", "workflow-input-invalid");
  });

  it("빈 필수 enum을 고르면 그 칸의 표시만 걷히고 남은 칸이 안내에 남는다", () => {
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".workflow-input-problem").should("contain.text", "필수 입력 2개");

    control(2).find("select").select("apply");
    cy.get(".workflow-input-problem")
      .should("contain.text", "필수 입력 1개")
      .and("contain.text", "대상 브랜치")
      .and("not.contain.text", "실행 모드");
    control(2).find("select").should("not.have.attr", "aria-invalid");

    // 남은 필수 문자열까지 채우면 안내가 사라지고 확인 대화상자로 넘어간다.
    control(0).find("input").type("dev-history");
    cy.get(".workflow-input-problem").should("not.exist");
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".modal-backdrop .modal").should("be.visible").and("contain.text", "입력 타입 계약 실행");
  });
});
