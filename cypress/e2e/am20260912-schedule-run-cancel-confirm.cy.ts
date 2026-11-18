/**
 * 반복 요청 카드의 '실행 취소' 되묻기 계약(afa942a로 브라우저 confirm → 앱 공용 확인 모달).
 *
 * am20260908-schedule-run-history는 실행 내역의 접기·펼침과 상세 로딩만 봤고, 취소 버튼을
 * 누르는 스펙은 없었다(해당 커밋 메시지도 "두 버튼을 누르는 스펙이 없어 스펙 변경은 없다"고
 * 적었다). 같은 커밋의 반복 요청 '삭제' 모달은 AM-245가 이미 다뤘으므로, 여기서는 아직 아무도
 * 누르지 않은 '실행 취소' 갈래만 본다.
 *
 * 축은 워크플로·반복요청, 조건은 확인 모달의 취소/승인 갈래와 되돌릴 수 없는 요청의 중복 처리.
 * 확인하는 것:
 *  - 네이티브 window.confirm이 전혀 불리지 않는다(브라우저 기본 확인창 잔존 여부)
 *  - 모달 취소(버튼·Esc)면 cancel_scheduled_run이 나가지 않는다
 *  - 승인하면 IPC가 runId·사유와 함께 한 번만 나가고 취소 영수증 문구가 회차 줄에 남는다
 */

const schedule = {
  id: "schedule-qa-cancel",
  name: "실행 취소 되묻기 검증 반복 요청",
  source: "claude",
  enabled: true,
  prompt: "테스트 프롬프트 전문",
  workspace: "/tmp/qa-cancel",
  mode: "default",
  frequency: "daily",
  scheduledHour: 9,
  scheduledMinute: 0,
  intervalHours: 1,
  scheduledDays: ["mon"],
  cronExpression: "0 9 * * 1",
  sessionStrategy: "new",
  resumeFailurePolicy: "newSession",
  useActiveAccount: true,
  accountId: null,
  model: null,
  approvalMode: "never",
  reasoningEffort: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  nextRunAt: 1_700_100_000_000,
  lastRunAt: 1_700_050_000_000,
  manualRunRequestedAt: null,
};

// 실행 중(running)인 회차에만 '실행 취소' 버튼이 붙는다(ChatSchedules.tsx:258).
const runningRun = {
  id: "run-active",
  scheduleId: schedule.id,
  scheduledFor: 1_700_050_000_000,
  startedAt: 1_700_050_100_000,
  finishedAt: null,
  status: "running",
  requestedAccountId: "claude-qa",
  actualAccountId: "claude-qa",
  providerSessionId: "session-active",
  previousProviderSessionId: null,
  sessionReplaced: false,
  retryCount: 0,
  summary: "실행 중 미리보기 요약",
  error: null,
  lastHeartbeatAt: 1_700_050_200_000,
  cancellationRequestedAt: null,
  recoveryError: null,
  manual: false,
};

function snapshot(runs: unknown[] = [runningRun]) {
  return { paused: false, runnerActive: true, schedules: [schedule], runs };
}

function cancelButton() {
  return cy.get(".schedule-run-actions").contains("button", "실행 취소");
}

function dialog() {
  return cy.get('.modal[role="dialog"]');
}

describe("반복 실행 취소 확인 모달의 취소·승인 갈래", () => {
  beforeEach(() => {
    cy.stubInvoke("get_scheduler_snapshot", { statusCode: 200, body: snapshot() });
    // 취소 IPC는 기본적으로 막아 두고, 승인 갈래에서만 응답을 덮어쓴다. 여기서 세어
    // "누르지 않았는데 나갔는지"까지 본다.
    cy.stubInvoke("cancel_scheduled_run", { statusCode: 200, body: { runId: runningRun.id, alreadyTerminal: false, stopError: null } }).as("cancelRun");
    cy.visitApp();
    // 브라우저 기본 확인창이 하나도 남지 않았다는 것이 이 갈래의 핵심이다. 되묻기는 버튼을
    // 누른 뒤에야 불리므로 로드 후에 감싸도 늦지 않는다.
    cy.window().then((win) => { cy.stub(win, "confirm").as("nativeConfirm").returns(false); });
    cy.openView("chat");
    cy.anchor("chat.tab.schedules").click().should("have.class", "active");
    cy.get(".schedule-card").should("exist");
  });

  it("'실행 취소'는 브라우저 confirm 대신 danger 톤의 앱 확인 모달을 띄운다", () => {
    cancelButton().click();

    dialog().should("be.visible");
    dialog().find(".modal-title").should("contain.text", "반복 실행 취소");
    // 개행으로 나눈 두 줄이 각각 문단으로 렌더된다(Shared.tsx:526).
    dialog().find(".confirm-dialog p").should("have.length", 2);
    dialog().find(".confirm-dialog p").first().should("have.text", "이 반복 실행을 취소할까요?");
    dialog().find(".confirm-dialog p").last().should("have.text", "실행 중 런타임이 있으면 안전하게 종료합니다.");
    // 되돌릴 수 없는 조작이므로 확인 버튼은 danger 톤이어야 한다.
    dialog().find(".modal-footer button").last().should("have.text", "실행 취소").and("have.class", "danger");

    cy.get("@nativeConfirm").should("not.have.been.called");
    cy.get("@cancelRun.all").should("have.length", 0);
  });

  it("모달을 취소 버튼으로 닫으면 취소 요청이 나가지 않고 회차가 실행 중으로 남는다", () => {
    cancelButton().click();
    dialog().find(".modal-footer button").first().should("have.text", "취소").click();

    cy.get(".modal").should("not.exist");
    cy.get("@cancelRun.all").should("have.length", 0);
    cy.get(".schedule-run em").should("have.text", "실행 중");
    // 영수증 문구가 붙지 않아야 한다.
    cy.get(".schedule-run-result").should("not.exist");
    cancelButton().should("be.enabled");
  });

  it("모달을 Esc로 닫아도 취소 요청이 나가지 않는다", () => {
    cancelButton().click();
    dialog().should("be.visible");
    cy.get("body").type("{esc}");

    cy.get(".modal").should("not.exist");
    cy.get("@cancelRun.all").should("have.length", 0);
    cy.get(".schedule-run em").should("have.text", "실행 중");
  });

  it("승인하면 runId와 사유를 담아 취소 IPC를 한 번만 보내고 취소 영수증이 회차 줄에 남는다", () => {
    // 취소 뒤 다시 읽는 스냅샷에서는 회차가 취소됨으로 바뀐다.
    cy.stubInvoke("get_scheduler_snapshot", (req) => {
      req.reply({ statusCode: 200, body: snapshot([{ ...runningRun, status: "cancelled", finishedAt: 1_700_050_300_000, cancellationRequestedAt: 1_700_050_250_000 }]) });
    });

    cancelButton().click();
    dialog().find(".modal-footer button").last().click();

    cy.wait("@cancelRun").its("request.body").should((body: Record<string, unknown>) => {
      expect(body.runId).to.eq(runningRun.id);
      expect(String(body.reason)).to.contain("운영자가 실행 취소를 요청");
    });
    cy.get(".modal").should("not.exist");
    cy.get(".schedule-run-result").should("have.text", "취소 완료");
    cy.get("@cancelRun.all").should("have.length", 1);
    cy.get("@nativeConfirm").should("not.have.been.called");
  });
});
