/// <reference types="cypress" />

// V2: 결정 방식은 저장 성공 뒤에만 바뀌며, 실패하면 기존 사람이 답할 범위를 유지한다.
// 실제 회차 실행 없이 HTTP 응답을 보류·해제해 실패와 재시도를 재현한다.
describe("회차 상세 · 결정 방식 저장 실패와 재시도", () => {
  let release: (() => void) | null = null;
  afterEach(() => { const reply = release; release = null; reply?.(); });

  for (const [label, width, height] of [["PC", 1440, 900], ["모바일", 390, 844]] as const) {
    it(`V2 ${label}: 실패하면 수동 방식을 유지하고 재시도 성공 뒤에만 배지를 다시 센다`, { retries: 0 }, () => {
      cy.viewport(width, height);
      let goal = {
        id: "mode-retry-goal", title: "결정 방식 복구 검증", goal: "저장 실패 뒤 다시 바꾼다.",
        targetPath: "/tmp/round-mode-fixture", verification: "", cadence: "auto",
        status: "active", decisionMode: "manual", skillKey: null, workflowId: null,
        scheduleId: null, notes: "", createdAt: 1, updatedAt: 1,
      };
      const report = {
        id: "mode-retry-report", goalId: goal.id, scheduleId: null, runId: null, sessionId: null,
        source: null, title: "방식 변경 검증 보고", outcome: "partial", summary: "결정 방식을 검증한다.",
        measures: [], failureKinds: [], fixes: [], commits: [], reverted: [], next: [],
        decisions: [
          { question: "내부 정리를 적용할까요?", options: ["적용", "보류"], recommendation: "적용", resolved: null, requiresHuman: false },
          { question: "외부에 게시할까요?", options: ["게시", "보류"], recommendation: "보류", resolved: null, requiresHuman: true },
        ],
        recordedAt: 1,
      };
      const failure = "결정 방식 저장 실패 시험";
      let attempts = 0;
      let answers = 0;
      cy.stubInvoke("get_round_goals", (req) => req.reply({ statusCode: 200, body: [goal] }));
      cy.stubInvoke("list_round_reports", { statusCode: 200, body: [report] });
      cy.stubInvoke("resolve_round_decision", (req) => {
        answers += 1;
        req.reply({ statusCode: 500, body: { error: "방식 변경이 결정에 답하면 안 됩니다." } });
      });
      cy.stubInvoke("update_round_goal", (req) => {
        attempts += 1;
        const fail = attempts === 1;
        return new Cypress.Promise<void>((done) => {
          release = () => {
            if (!fail) goal = { ...goal, decisionMode: req.body.request.patch.decisionMode };
            req.reply({ statusCode: fail ? 500 : 200, body: fail ? { error: failure } : goal });
            done();
          };
        });
      }).as("saveMode");

      cy.visitApp();
      cy.openAutomationTab();
      const badge = () => cy.anchor("workflows.round-goals").find("[data-goal-id='mode-retry-goal'] .round-goal-pending");
      badge().should("contain.text", "결정 대기 2");
      cy.anchor("workflows.round-goals").contains("[data-goal-id='mode-retry-goal'] button", "회차 상세").click();
      const modal = () => cy.get(".modal[role='dialog']").filter(":has(.round-report-modal-body[data-goal-id='mode-retry-goal'])");
      const mode = () => modal().find(".round-auto-decision-toggle select");
      const assertManual = () => {
        mode().should("have.value", "manual");
        modal().find(".modal-title .round-goal-pending").should("contain.text", "결정 대기 2");
        modal().find(".round-auto-decision-notice").should("not.exist");
        badge().should("contain.text", "결정 대기 2");
      };
      const reply = () => cy.then(() => { const next = release!; release = null; next(); });
      const request = { id: goal.id, patch: { decisionMode: "recommended" } };

      modal().should("be.visible");
      assertManual();
      mode().select("recommended");
      cy.wrap(null).should(() => expect(release, "보류 중인 첫 응답").to.be.a("function"));
      mode().should("be.disabled");
      modal().find(".round-decision-form input, .round-decision-form button, .modal-footer button")
        .each(($control) => expect($control).to.be.disabled);
      assertManual();
      reply();
      cy.wait("@saveMode").its("request.body.request").should("deep.equal", request);
      modal().find(".error-banner").should("be.visible").and("contain.text", failure);
      mode().should("not.be.disabled");
      assertManual();
      modal().screenshot(`round-mode-retry-${label}-failed`, { overwrite: true });

      mode().select("recommended");
      cy.wrap(null).should(() => expect(release, "보류 중인 재시도 응답").to.be.a("function"));
      modal().find(".error-banner").should("not.exist");
      mode().should("be.disabled");
      assertManual();
      reply();
      cy.wait("@saveMode").its("request.body.request").should("deep.equal", request);
      mode().should("have.value", "recommended").and("not.be.disabled");
      modal().find(".modal-title .round-goal-pending").should("contain.text", "결정 대기 1");
      badge().should("contain.text", "결정 대기 1");
      modal().find(".round-auto-decision-notice").should("contain.text", "1건");
      modal().find(".round-decision-human").should("have.length", 1);
      modal().find(".round-decision-form").should("have.length", 2);
      modal().find(".error-banner").should("not.exist");
      cy.then(() => {
        expect(attempts, "저장 요청 수").to.equal(2);
        expect(answers, "방식 변경은 결정에 직접 답하지 않음").to.equal(0);
      });
      modal().find(".modal-footer button").should("not.be.disabled").click();
      cy.get(".round-report-modal-body[data-goal-id='mode-retry-goal']").should("not.exist");
    });
  }
});

export {};
