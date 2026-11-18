/// <reference types="cypress" />
import { WORKFLOW_LIMITS, workflowDetail, workflowSummary } from "../support/workflowFixtures";

// 워크플로 관리 화면에서 일시정지(paused)된 페이싱 회차의 상태 표기와 1건 수동 실행 확인창.
//
// 페이싱 회차 계약은 백엔드가 봉투를 두르고 반복 요청(회차)으로 도는데, 회차가 일시정지 상태이면
// 예산이 주기적으로 기동하지 않으므로 목록의 '페이싱' 배지와 상세 헤더의 '사용량 페이싱' 상태는
// 숨겨져야 한다.
//
// 그러나 사용자가 해당 워크플로를 화면에서 수동으로 한 번 돌리고자 할 때:
// 1. 실행 구역(workflow-run-section)은 저장된 인자와 병렬 설정, 그리고 '일시정지' 상태를 명시한다.
// 2. '워크플로 실행'을 누르면 확인 모달이 뜨고, 제목은 '회차 1건 실행'이며 본문에는
//    "회차가 일시정지 상태여도 이 한 번은 실행됩니다."라는 단건 실행 약속 문구가 포함된다.
// 3. 취소 시 모달만 닫히고 run_scheduled_request_now는 호출되지 않는다.
// 4. 승인 시 run_scheduled_request_now가 해당 회차 ID로 1회 호출되고, 15초 이내 스케줄러 기동 안내(role="status")가 뜬다.
// 5. 대조군: 활성(enabled) 회차일 때는 '활성' 상태와 페이싱 배지가 노출되고, 모달에 일시정지 문구가 없다.
describe("일시정지된 페이싱 회차의 상태 표기와 수동 단건 실행", () => {
  const SUMMARY = workflowSummary({
    contractDigest: "feed0000beef1111",
    description: "일시정지 회차 수동 실행 검증용 계약",
    displayName: "페이싱 수동 실행 워크플로",
    id: "wf-paused-paced",
    pacingCapable: true,
    pacingEnabled: true,
    pacingMode: "envelope",
    requiredOperations: ["start_chat"],
  });

  const PAUSED_ROUND = {
    id: "schedule-paused-round",
    name: "정기 점검 페이싱 회차",
    enabled: false,
    workflow: {
      workflowId: "wf-paused-paced",
      approvedVersion: 1,
      arguments: { query: "daily-audit" },
      pacing: { maxRuns: 2 },
    },
  };

  const ACTIVE_ROUND = {
    ...PAUSED_ROUND,
    id: "schedule-active-round",
    name: "활성 점검 페이싱 회차",
    enabled: true,
  };

  function setup(round: typeof PAUSED_ROUND) {
    cy.stubInvoke("get_system_workflows", { limits: WORKFLOW_LIMITS, workflows: [SUMMARY] });
    cy.stubInvoke("get_system_workflow", workflowDetail(SUMMARY));
    cy.stubInvoke("get_scheduler_snapshot", {
      paused: false,
      runnerActive: true,
      schedules: [round],
      runs: [],
    });
    cy.stubInvoke("run_scheduled_request_now", { statusCode: 200, body: {} }).as("runNow");
    cy.visitApp();
    cy.openView("workflows");
    cy.selectWorkflow("페이싱 수동 실행 워크플로");
  }

  it("일시정지 상태에서는 페이싱 배지가 숨겨지고, 실행 구역에 일시정지와 저장된 인자를 표시한다", () => {
    setup(PAUSED_ROUND);

    // 1) 페이싱이 돌지 않으므로 목록 배지와 상세 헤더 상태는 미노출
    cy.get(".workflow-card-badges .paced").should("not.exist");
    cy.get('[data-ui-anchor="workflows.pacing-status"]').should("not.exist");

    // 2) 실행 구역: 일반 입력 칸(input/textarea) 없이 회차 1건 실행과 일시정지·병렬 실행 수치 표시
    const section = () => cy.get(".workflow-run-section");
    section().should("be.visible");
    section().should("contain.text", "회차 1건 실행");
    section().should("contain.text", "정기 점검 페이싱 회차");
    section().should("contain.text", "일시정지");
    section().should("contain.text", "2건");
    section().should("not.contain.text", "활성");

    // 저장된 인자 query = daily-audit가 목록으로 보인다
    section().find(".workflow-round-arguments").should("contain.text", "daily-audit");
    section().find(".workflow-inputs").should("not.exist");
  });

  it("실행 확인 모달에 일시정지 예외 문구가 뜨고, 취소 시 요청이 나가지 않는다", () => {
    setup(PAUSED_ROUND);

    // 실행 버튼 클릭
    cy.get(".workflow-detail-actions button.primary").contains("워크플로 실행").click();

    // 확인 모달 검증
    const modal = () => cy.get(".modal-backdrop .modal");
    modal().should("be.visible");
    modal().should("contain.text", "회차 1건 실행");
    modal().should("contain.text", "정기 점검 페이싱 회차");
    modal().should("contain.text", "회차가 일시정지 상태여도 이 한 번은 실행됩니다.");

    // 취소 클릭
    modal().contains("button", "취소").click();
    modal().should("not.exist");
    cy.get("@runNow.all").should("have.length", 0);
  });

  it("모달에서 실행 승인 시 즉시 실행 요청을 보내고 15초 이내 기동 안내를 알린다", () => {
    setup(PAUSED_ROUND);

    cy.get(".workflow-detail-actions button.primary").contains("워크플로 실행").click();
    cy.get(".modal-backdrop .modal").contains("button", "회차 1건 실행").click();

    // run_scheduled_request_now가 회차 id로 1회 호출됨
    cy.wait("@runNow").then((interception) => {
      expect((interception.request.body as { id: string }).id).to.eq(PAUSED_ROUND.id);
    });

    // 화면 안내 배너 노출
    cy.get('.workflow-detail-body [role="status"]').should("be.visible")
      .and("contain.text", "정기 점검 페이싱 회차")
      .and("contain.text", "스케줄러가 다음 틱(15초 이내)에 시작하며");
  });

  it("대조군: 활성 회차는 페이싱 상태가 뜨고, 모달에 일시정지 문구가 포함되지 않는다", () => {
    setup(ACTIVE_ROUND);

    // 활성 상태이므로 목록 배지와 상세 헤더에 페이싱 표시가 뜬다
    cy.get(".workflow-card-badges .paced").should("contain.text", "페이싱");
    cy.anchor("workflows.pacing-status").should("contain.text", "사용량 페이싱");

    // 실행 구역에 '활성' 표시
    cy.get(".workflow-run-section").should("contain.text", "활성")
      .and("not.contain.text", "일시정지");

    // 실행 모달에는 일시정지 보장 문구가 없다
    cy.get(".workflow-detail-actions button.primary").contains("워크플로 실행").click();
    cy.get(".modal-backdrop .modal").should("be.visible")
      .and("not.contain.text", "회차가 일시정지 상태여도 이 한 번은 실행됩니다.");
  });
});
