/// <reference types="cypress" />

// V2: 완료 항목을 숨겨도 원래 결정 순번과 보고 ID를 저장하고, 다른 결정의 초안은 보존한다.
// 서로 다른 보고에 같은 선택지를 두어 화면 표시만으로 대상 혼동이 가려지지 않게 한다.
describe("회차 상세 · 결정 답변 대상 식별", () => {
  for (const [label, width, height] of [["PC", 1440, 900], ["모바일", 390, 844]] as const) {
    it(`V2 ${label}: 원래 보고와 결정 순번에 답하고 다른 초안을 보존한다`, { retries: 0 }, () => {
      cy.viewport(width, height);
      const goal = {
        id: "identity-goal", title: "답변 대상 식별 검증", goal: "고른 결정에만 답한다.",
        targetPath: "/tmp/round-identity-fixture", verification: "", cadence: "auto",
        status: "active", decisionMode: "manual", skillKey: null, workflowId: null,
        scheduleId: null, notes: "", createdAt: 1, updatedAt: 1,
      };
      const decision = (question: string, resolved: string | null = null) => ({
        question, options: ["적용", "보류"], recommendation: "보류", requiresHuman: true, resolved,
      });
      const report = (id: string, recordedAt: number) => ({
        id, recordedAt, goalId: goal.id, scheduleId: null, runId: null, sessionId: null,
        source: null, title: id, outcome: "partial", summary: `${id} 본문`,
        measures: [], failureKinds: [], fixes: [], commits: [], reverted: [], next: [],
        decisions: [decision("이미 답한 결정", "이전 답변"), decision("첫 미결 결정"), decision("둘째 미결 결정")],
      });
      const reports = [report("older-report", 100), report("newer-report", 200)];
      let writes = 0;
      cy.stubInvoke("get_round_goals", { statusCode: 200, body: [goal] });
      cy.stubInvoke("list_round_reports", (req) => req.reply({ statusCode: 200, body: reports }));
      cy.stubInvoke("resolve_round_decision", (req) => {
        writes += 1;
        const { id, index, answer } = req.body.request;
        const target = reports.find((item) => item.id === id);
        if (!target || !target.decisions[index] || target.decisions[index].resolved) {
          req.reply({ statusCode: 409, body: { error: "답변 대상이 잘못되었습니다." } });
          return;
        }
        target.decisions[index].resolved = answer;
        req.reply({ statusCode: 200, body: target });
      }).as("saveAnswer");

      cy.visitApp();
      cy.openAutomationTab();
      cy.anchor("workflows.round-goals").contains("[data-goal-id='identity-goal'] button", "회차 상세").click();
      const modal = () => cy.get(".modal[role='dialog']").filter(":has(.round-report-modal-body[data-goal-id='identity-goal'])");
      const item = (id: string) => modal().find(`[data-round-id='${id}']`);
      const form = (id: string, index: number) => item(id).find(`[data-decision-index='${index}'] .round-decision-form`);

      modal().should("be.visible");
      for (const id of ["older-report", "newer-report"]) {
        item(id).find(".round-decision").should("have.length", 2);
        item(id).find("[data-decision-index='0']").should("not.exist");
      }
      form("newer-report", 1).find("input").type("  새 보고 초안  ");
      form("older-report", 1).find("input").type("과거 보고 초안");
      form("older-report", 2).contains("button", "적용").click();
      cy.wait("@saveAnswer").its("request.body.request").should("deep.equal", {
        id: "older-report", index: 2, answer: "적용",
      });
      item("older-report").find("[data-decision-index='2']").should("not.exist");
      item("older-report").find(".round-report-body").should("contain.text", "둘째 미결 결정 → 적용");
      form("older-report", 1).find("input").should("have.value", "과거 보고 초안");
      form("newer-report", 1).find("input").should("have.value", "  새 보고 초안  ");
      form("newer-report", 2).should("exist");
      modal().find(".modal-title .round-goal-pending").should("contain.text", "결정 대기 3");

      form("newer-report", 1).contains("button", "적기").click();
      cy.wait("@saveAnswer").its("request.body.request").should("deep.equal", {
        id: "newer-report", index: 1, answer: "새 보고 초안",
      });
      item("newer-report").find("[data-decision-index='1']").should("not.exist");
      item("newer-report").find(".round-report-body").should("contain.text", "첫 미결 결정 → 새 보고 초안");
      form("older-report", 1).find("input").should("have.value", "과거 보고 초안");
      form("newer-report", 2).should("exist");
      modal().find(".modal-title .round-goal-pending").should("contain.text", "결정 대기 2");
      modal().find(".error-banner").should("not.exist");
      cy.then(() => expect(writes, "고른 두 결정에만 저장").to.equal(2));
      modal().screenshot(`round-decision-identity-${label}`, { overwrite: true });
      modal().find(".modal-footer button").should("not.be.disabled").click();
      cy.get(".round-report-modal-body[data-goal-id='identity-goal']").should("not.exist");
    });
  }
});

export {};
