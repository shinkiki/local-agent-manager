/// <reference types="cypress" />

// V2: 실제 회차를 실행하지 않고 답변 저장의 전송 실패와 재시도만 격리 화면에서 재현한다.
// 응답은 단언이 끝난 뒤 풀어 저장 중 닫기·중복 입력 차단을 시간 지연 없이 확인한다.
describe("회차 상세 · 결정 답변 저장 실패와 재시도", () => {
  let release: (() => void) | null = null;
  // 단언이 실패해도 보류 응답을 풀어 다음 시험과 원래 실패 진단을 보존한다.
  afterEach(() => { const reply = release; release = null; reply?.(); });

  for (const [label, width, height] of [["PC", 1440, 900], ["모바일", 390, 844]] as const) {
    it(`V2 ${label}: 저장 중 닫기를 막고, 실패한 초안을 보존해 같은 답변을 재시도한다`, { retries: 0 }, () => {
      cy.viewport(width, height);
      const goal = {
        id: "retry-goal", title: "결정 답변 복구 검증", goal: "저장 실패 뒤 다시 답한다.",
        targetPath: "/tmp/round-retry-fixture", verification: "", cadence: "auto",
        status: "active", decisionMode: "manual", skillKey: null, workflowId: null,
        scheduleId: null, notes: "", createdAt: 1, updatedAt: 1,
      };
      const answer = "검증 뒤 적용";
      const failure = "답변 저장 실패 시험";
      let resolved: string | null = null;
      let attempts = 0;
      const report = () => ({
        id: "retry-report", goalId: goal.id, scheduleId: null, runId: null, sessionId: null,
        source: null, title: "검증 보고", outcome: "partial", summary: "답변 저장을 검증한다.",
        measures: [], failureKinds: [], fixes: [], commits: [], reverted: [], next: [],
        decisions: [{ question: "검증 뒤 적용할까요?", options: ["적용", "보류"], recommendation: "보류", resolved }],
        recordedAt: 1,
      });
      cy.stubInvoke("get_round_goals", { statusCode: 200, body: [goal] });
      cy.stubInvoke("list_round_reports", (req) => req.reply({ statusCode: 200, body: [report()] }));
      cy.stubInvoke("resolve_round_decision", (req) => {
        attempts += 1;
        const fail = attempts === 1;
        return new Cypress.Promise<void>((done) => {
          release = () => {
            if (!fail) resolved = req.body.request.answer;
            req.reply({ statusCode: fail ? 500 : 200, body: fail ? { error: failure } : report() });
            done();
          };
        });
      }).as("saveDecision");

      cy.visitApp();
      cy.openAutomationTab();
      cy.anchor("workflows.round-goals").contains("[data-goal-id='retry-goal'] button", "회차 상세").click();
      const modal = () => cy.get(".modal[role='dialog']").filter(":has(.round-report-modal-body[data-goal-id='retry-goal'])");
      const assertStillOpen = () => cy.get("body").then(($body) => {
        const $modalBody = $body.find(".round-report-modal-body[data-goal-id='retry-goal']");
        expect($modalBody.length, "저장 중 모달 유지").to.equal(1);
      });
      const form = () => modal().find(".round-decision-form");
      const submit = () => form().contains("button", "적기");
      const badge = () => cy.anchor("workflows.round-goals").find("[data-goal-id='retry-goal'] .round-goal-pending");

      modal().should("be.visible");
      form().find("input").type(`  ${answer}  `);
      submit().click();
      cy.wrap(null).should(() => expect(release, "보류 중인 첫 응답").to.be.a("function"));
      form().find("input, button").each(($control) => expect($control).to.be.disabled);
      modal().find(".round-auto-decision-toggle select, .modal-footer button").each(($control) => expect($control).to.be.disabled);
      modal().find(".modal-header button").click();
      assertStillOpen();
      cy.get("body").trigger("keydown", { key: "Escape" });
      assertStillOpen();
      cy.get(".modal-backdrop").trigger("mousedown", { force: true });
      assertStillOpen();
      cy.then(() => { const reply = release!; release = null; reply(); });
      cy.wait("@saveDecision").its("request.body.request").should("deep.equal", {
        id: "retry-report", index: 0, answer,
      });

      modal().find(".error-banner").should("be.visible").and("contain.text", failure);
      form().find("input").should("have.value", `  ${answer}  `).and("not.be.disabled");
      submit().should("not.be.disabled");
      badge().should("contain.text", "결정 대기 1");
      modal().screenshot(`round-decision-retry-${label}-failed`, { overwrite: true });

      submit().click();
      cy.wrap(null).should(() => expect(release, "보류 중인 재시도 응답").to.be.a("function"));
      modal().find(".error-banner").should("not.exist");
      form().find("input, button").each(($control) => expect($control).to.be.disabled);
      cy.then(() => { const reply = release!; release = null; reply(); });
      cy.wait("@saveDecision").its("request.body.request").should("deep.equal", {
        id: "retry-report", index: 0, answer,
      });
      modal().find(".round-decision-form, .error-banner").should("not.exist");
      modal().find(".round-report-body").should("contain.text", `→ ${answer}`);
      modal().find(".modal-title .round-goal-pending").should("not.exist");
      badge().should("not.exist");
      cy.then(() => expect(attempts, "저장 요청 수").to.equal(2));
      modal().find(".modal-footer button").should("not.be.disabled").click();
      cy.get(".round-report-modal-body[data-goal-id='retry-goal']").should("not.exist");
    });
  }
});

export {};
