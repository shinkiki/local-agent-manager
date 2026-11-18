/// <reference types="cypress" />

// V2: 최신 결과와 오래된 미결 요청이 함께 보이고, 처리한 과거 결과는 접혀 있어야 한다.
// 서버 응답 순서를 일부러 섞어 최신 보고가 잘못 선택되는 회귀도 잡는다.
describe("회차 상세 · 보고 순서와 펼침", () => {
  for (const [label, width, height] of [["PC", 1440, 900], ["모바일", 390, 844]] as const) {
    it(`V2 ${label}: 최신·미결 보고를 펼치고 사용자가 바꾼 펼침을 유지한다`, { retries: 0 }, () => {
      cy.viewport(width, height);
      const goal = {
        id: "report-order-goal", title: "보고 우선 노출 검증", goal: "최신 결과와 남은 결정을 확인한다.",
        targetPath: "/tmp/report-order-fixture", verification: "", cadence: "auto",
        status: "active", decisionMode: "manual", skillKey: null, workflowId: null,
        scheduleId: null, notes: "", createdAt: 1, updatedAt: 1,
      };
      const report = (id: string, recordedAt: number, decisions: object[] = []) => ({
        id, recordedAt, decisions, goalId: goal.id, scheduleId: null, runId: null,
        sessionId: null, source: null, title: id, outcome: "pass", summary: `${id} 본문`,
        measures: [], failureKinds: [], fixes: [], commits: [], reverted: [], next: [],
      });
      const decision = {
        question: "검증 결과를 적용할까요?", options: ["적용", "보류"],
        recommendation: "보류", requiresHuman: true, resolved: null,
      };
      const reports = [
        report("old-resolved", 100, [{ ...decision, resolved: "보류" }]),
        report("older-pending", 200, [decision]),
        report("newest", 400),
        report("recent-complete", 300),
      ];
      let writes = 0;
      cy.stubInvoke("get_round_goals", { statusCode: 200, body: [goal] });
      cy.stubInvoke("list_round_reports", (req) => req.reply({ statusCode: 200, body: reports })).as("listReports");
      cy.stubInvoke("resolve_round_decision", (req) => { writes += 1; req.reply({ statusCode: 500, body: { error: "조회 중 저장 금지" } }); });
      cy.stubInvoke("update_round_goal", (req) => { writes += 1; req.reply({ statusCode: 500, body: { error: "조회 중 변경 금지" } }); });

      cy.visitApp();
      cy.openAutomationTab();
      cy.anchor("workflows.round-goals").contains("[data-goal-id='report-order-goal'] button", "회차 상세").click();
      const modal = () => cy.get(".modal[role='dialog']").filter(":has(.round-report-modal-body[data-goal-id='report-order-goal'])");
      const item = (id: string) => modal().find(`[data-round-id='${id}']`);
      modal().should("be.visible");
      cy.get("@listReports.all").should((calls) => {
        const requests = (calls as unknown as Array<{ request: { body: { request: object } } }>).map((call) => call.request.body.request);
        expect(requests, "목표별 상세 조회").to.deep.include({ goalId: goal.id, limit: 200 });
      });
      modal().find(".round-report-details").should(($items) => {
        expect([...$items].map((el) => el.getAttribute("data-round-id")), "최신순 보고").to.deep.equal([
          "newest", "recent-complete", "older-pending", "old-resolved",
        ]);
      });
      item("newest").should("have.attr", "open");
      item("older-pending").should("have.attr", "open");
      item("older-pending").find(".round-decision-form input").should("be.visible");
      item("recent-complete").should("not.have.attr", "open");
      item("old-resolved").should("not.have.attr", "open");
      item("old-resolved").find(".round-report-body").should("not.be.visible");
      modal().find(".modal-title .round-goal-pending").should("contain.text", "결정 대기 1");

      // 입력에 따른 재렌더가 사용자의 수동 펼침·접힘을 덮어쓰지 않아야 한다.
      item("newest").children("summary").click();
      item("recent-complete").children("summary").click();
      item("older-pending").find("input").type("초안");
      item("newest").should("not.have.attr", "open");
      item("recent-complete").should("have.attr", "open");
      item("recent-complete").find(".round-report-body").should("be.visible");
      item("older-pending").find("input").should("have.value", "초안");
      modal().screenshot(`round-report-order-${label}`, { overwrite: true });
      modal().find(".modal-footer button").click();
      cy.get(".round-report-modal-body[data-goal-id='report-order-goal']").should("not.exist");
      cy.then(() => expect(writes, "조회·펼침은 저장 요청을 만들지 않음").to.equal(0));
    });
  }
});

export {};
