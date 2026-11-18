/// <reference types="cypress" />
// 애드온 → 자동화의 "회차 목표"(`RoundGoalsPanel.tsx`)는 모든 목표의 회차 보고를 카드 아래에
// 펼쳐 쌓고 미결 결정은 상단에 목표 구분 없이 모았다. 2026-09-30 사용자 결정으로 둘 다 걷어내고
// 카드의 "회차 상세" 버튼이 여는 모달(`RoundReportsModal.tsx`) 한 곳에서 그 목표의 보고를 읽고
// 결정을 답한다. 카드에는 "결정 대기 N" 배지만 남는다.
//
// 격리 백엔드에는 목표도 보고도 없으므로 셋을 스텁으로 세운다. 답한 뒤 목록 재조회가 해결된
// 결정을 돌려주는지까지 한 흐름으로 본다.
describe("애드온 → 자동화 · 회차 상세 모달", () => {
  const goal = {
    id: "goal-1", title: "계획 프로토콜 굳히기", goal: "로컬 모델의 계획 프로토콜을 파인튜닝으로 굳힌다.",
    targetPath: "/tmp/round-goal", verification: "", cadence: "auto", status: "active",
    skillKey: "plan-protocol-round", workflowId: null, scheduleId: "sched-1", notes: "",
    createdAt: 1_790_000_000_000, updatedAt: 1_790_000_000_000,
  };
  const question = "레인 수를 4로 올릴까요?";
  const report = (resolved: string | null) => ({
    id: "report-1", goalId: goal.id, scheduleId: goal.scheduleId, runId: null, sessionId: null, source: null,
    title: "회차 3", outcome: "partial", summary: "두 레인 중 하나가 시험을 통과했다.",
    measures: [{ label: "통과율", before: "40%", after: "55%" }],
    failureKinds: [{ kind: "timeout", before: 3, after: 1 }],
    fixes: ["재시도 간격 조정"], commits: ["abc1234"], reverted: [], next: ["레인 수 결정 뒤 재실행"],
    decisions: [{ question, options: ["올린다", "유지"], recommendation: "올린다", resolved }],
    recordedAt: 1_790_000_100_000,
  });

  it("카드 배지가 결정 대기를 알리고, 모달에서 보고를 읽고 답하면 배지가 사라진다", () => {
    let resolved: string | null = null;
    cy.stubInvoke("get_round_goals", { statusCode: 200, body: [goal] });
    cy.stubInvoke("list_round_reports", (req) => { req.reply({ statusCode: 200, body: [report(resolved)] }); }).as("list");
    cy.stubInvoke("resolve_round_decision", (req) => {
      resolved = (req.body as { request: { answer: string } }).request.answer;
      req.reply({ statusCode: 200, body: report(resolved) });
    }).as("resolve");

    cy.visitApp();
    cy.openAutomationTab();

    // 1) 카드에는 보고 본문이 없고 "결정 대기 1" 배지와 "회차 상세 (1)" 버튼만 있다.
    cy.anchor("workflows.round-goals").as("card");
    cy.get("@card").find(".round-report-table").should("not.exist");
    cy.get("@card").find("[data-goal-id='goal-1'] .round-goal-pending").should("contain.text", "결정 대기 1");
    cy.get("@card").contains("[data-goal-id='goal-1'] button", "회차 상세 (1)").click();

    // 2) 모달은 이 목표만 조회하고, 보고 본문·측정표·미결 결정 선택지를 보여준다.
    // 패널이 처음에 전체 목록(goalId 없음)을 한 번 부르므로, 목표 id 를 실은 호출이 따로 있는지 본다.
    cy.get("@list.all").should((calls) => {
      const goalIds = (calls as unknown as Array<{ request: { body: { request: { goalId?: string } } } }>).map((call) => call.request.body.request.goalId);
      expect(goalIds, "list_round_reports goalIds").to.include(goal.id);
    });
    cy.get(".modal[role='dialog']").as("modal");
    cy.get("@modal").find(".modal-title").should("contain.text", goal.title).and("contain.text", "회차 보고 1건").and("contain.text", "결정 대기 1");
    cy.get("@modal").find("[data-round-id='report-1']").should("have.attr", "open");
    cy.get("@modal").find(".round-report-table td").first().should("have.text", "통과율");
    cy.get("@modal").find(".round-decision p").should("have.text", question);
    cy.get("@modal").contains(".round-decision button", "올린다 (추천)").should("have.class", "primary");
    cy.get("@modal").screenshot("round-report-detail-modal", { overwrite: true });

    // 3) 추천을 고르면 그 답이 저장되고, 모달은 해결된 결정으로, 카드는 배지 없이 다시 선다.
    cy.get("@modal").contains(".round-decision button", "올린다 (추천)").click();
    cy.wait("@resolve").its("request.body.request").should("deep.equal", { id: "report-1", index: 0, answer: "올린다" });
    cy.get("@modal").find(".round-decision").should("not.exist");
    cy.get("@modal").find(".round-report-body").should("contain.text", `결정: ${question} → 올린다`);
    cy.get("@modal").find(".modal-title .round-goal-pending").should("not.exist");
    cy.get("@card").find("[data-goal-id='goal-1'] .round-goal-pending").should("not.exist");
    cy.get("@card").contains("[data-goal-id='goal-1'] button", "회차 상세").should("not.contain.text", "(1)");

    // 4) 푸터 닫기로 모달이 사라진다.
    cy.get("@modal").find(".modal-footer button").click();
    cy.get(".modal").should("not.exist");
  });

  it("결정 방식 select: 추천적용이면 카드 배지는 사람 결정만 세고, 바꾸면 그 값으로 저장한다", () => {
    const recommendedGoal = { ...goal, decisionMode: "recommended" };
    const mixed = {
      ...report(null),
      decisions: [
        { question, options: ["올린다", "유지"], recommendation: "올린다", resolved: null },
        { question: "운영 호스트에 배포할까요?", options: ["배포", "보류"], recommendation: "보류", resolved: null, requiresHuman: true },
      ],
    };
    cy.stubInvoke("get_round_goals", { statusCode: 200, body: [recommendedGoal] });
    cy.stubInvoke("list_round_reports", { statusCode: 200, body: [mixed] });
    cy.stubInvoke("update_round_goal", (req) => {
      const patch = (req.body as { request: { patch: { decisionMode: string } } }).request.patch;
      req.reply({ statusCode: 200, body: { ...recommendedGoal, decisionMode: patch.decisionMode } });
    }).as("update");

    cy.visitApp();
    cy.openAutomationTab();
    cy.anchor("workflows.round-goals").as("card");

    cy.get("@card").find("[data-goal-id='goal-1'] .round-goal-pending").should("contain.text", "결정 대기 1");
    cy.get("@card").contains("[data-goal-id='goal-1'] button", "회차 상세").click();
    cy.get(".modal[role='dialog']").as("modal");
    cy.get("@modal").find(".round-auto-decision-toggle select").should("have.value", "recommended");
    cy.get("@modal").find(".modal-title .round-goal-pending").should("contain.text", "결정 대기 1");
    cy.get("@modal").find(".round-auto-decision-notice").should("contain.text", "1건");
    cy.get("@modal").find(".round-decision-human").should("have.length", 1).and("contain.text", "사람 결정");

    cy.get("@modal").find(".round-auto-decision-toggle select").select("manual");
    cy.wait("@update").its("request.body.request.patch").should("deep.equal", { decisionMode: "manual" });
    cy.get("@modal").find(".round-auto-decision-notice").should("not.exist");
    cy.get("@modal").find(".modal-title .round-goal-pending").should("contain.text", "결정 대기 2");
  });

  // 2026-10-24 사용자: 결정문이 에이전트용이라 고르기 어렵다. 회차 스킬은 질문을 다섯 줄(무슨 일·왜 지금·
  // 선택지별 결과·추천 이유·근거)로 쓰고, 모달은 첫 줄만 굵게, 근거 줄은 흐리게 따로 세운다.
  it("여러 줄 결정 질문은 줄마다 나뉘고, 근거 줄은 흐리게, 선택지와 다른 추천 글은 따로 한 줄로 보인다", () => {
    const lines = ["구현 회차가 사람이 정할 질문에 스스로 답했어요.", "그대로 두면 배포 같은 질문도 혼자 정해요.", "바꾸면 사람 결정만 기다려요.", "추천은 바꾸기예요."];
    const evidence = "근거: round-fd6de8c1 · 10-23 22:23Z";
    const multi = {
      ...report(null),
      decisions: [
        { question: [...lines, evidence].join("\n"), options: ["바꾼다", "보류"], recommendation: "바꾼다", resolved: null, requiresHuman: true },
        { question: "예전 한 줄 질문", options: ["적용: update_round_goal {}", "보류"], recommendation: "적용 — 설명 글로 적힌 예전 추천", resolved: null },
      ],
    };
    cy.stubInvoke("get_round_goals", { statusCode: 200, body: [goal] });
    cy.stubInvoke("list_round_reports", { statusCode: 200, body: [multi] });

    cy.visitApp();
    cy.openAutomationTab();
    cy.anchor("workflows.round-goals").contains("[data-goal-id='goal-1'] button", "회차 상세").click();
    cy.get(".modal[role='dialog'] .round-decision").as("decisions").should("have.length", 2);

    cy.get("@decisions").eq(0).within(() => {
      cy.get("p.round-decision-lead").should("contain.text", lines[0]).and("contain.text", "사람 결정").and("have.css", "font-weight", "600");
      cy.get("p:not(.round-decision-lead)").should("have.length", 3).each((p, i) => {
        expect(p.text()).to.equal(lines[i + 1]);
        expect(p.css("font-weight")).to.equal("400");
      });
      cy.get(".round-decision-evidence").should("have.text", evidence);
      cy.get("p").should("not.contain.text", "근거:");
      cy.contains("button", "바꾼다 (추천)").should("have.class", "primary");
      cy.get(".round-decision-recommendation").should("not.exist");
    });

    cy.get("@decisions").eq(1).within(() => {
      cy.get("p").should("have.length", 1).and("have.text", "예전 한 줄 질문");
      cy.get(".round-decision-evidence").should("not.exist");
      cy.get(".round-decision-recommendation").should("have.text", "추천: 적용 — 설명 글로 적힌 예전 추천");
      cy.get("button.primary").should("not.exist");
    });
    cy.get(".modal[role='dialog']").screenshot("round-report-decision-question-lines", { overwrite: true });
  });

  // 2026-10-25 사용자 화면(폰 폭): 제목 칸의 "회차 보고 200건"·"결정 대기 1" 배지가 줄어들며 잘렸고,
  // 보고 카드는 제목이 길면 ▸ 만 윗줄에 남고 짧으면 배지가 제목 옆에 붙어 줄 모양이 카드마다 달랐다.
  it("폰 폭에서 제목 배지는 잘리지 않고, 보고 카드는 제목 줄 아래 배지 줄로 똑같이 선다", () => {
    cy.viewport(390, 844);
    const longGoal = { ...goal, title: "Agent Manager 코드리뷰·리팩토링 회차" };
    const titles = [
      "비밀값·DB 연결 화면 연결 코드의 낡은 '호스트 전용' 설명과 틀린 규칙 번호 바로잡기",
      "다이어그램 확대 보기의 배율 계산을 떼어 내 시험으로 고정",
    ];
    const reports = titles.map((title, i) => ({ ...report(i === 0 ? null : "올린다"), id: `report-${i}`, title, outcome: "pass", recordedAt: 1_790_000_100_000 - i }));
    cy.stubInvoke("get_round_goals", { statusCode: 200, body: [longGoal] });
    cy.stubInvoke("list_round_reports", { statusCode: 200, body: reports });

    cy.visitApp();
    cy.openAutomationTab();
    cy.anchor("workflows.round-goals").contains("[data-goal-id='goal-1'] button", "회차 상세").click();
    cy.get(".modal[role='dialog']").as("modal");

    cy.get("@modal").find(".modal-title .db-badge").should("have.length", 2).each((badge) => {
      const el = badge[0];
      expect(el.scrollWidth, `${el.textContent} 배지 폭`).to.be.at.most(el.clientWidth + 1);
    });
    cy.get("@modal").find(".modal-title > span:not(.db-badge)").should(($title) => {
      expect($title[0].getBoundingClientRect().width, "제목 글 폭").to.be.greaterThan(150);
    });

    cy.get("@modal").find(".round-report-details > summary").should("have.length", 2).each((summary) => {
      const strong = summary.find("> strong")[0].getBoundingClientRect();
      const meta = summary.find("> .round-report-meta")[0].getBoundingClientRect();
      expect(meta.top, "배지 줄은 제목 아래").to.be.at.least(strong.bottom - 1);
      expect(Math.round(meta.left), "배지 줄은 제목과 같은 들여쓰기").to.equal(Math.round(strong.left));
    });
    cy.get("@modal").screenshot("round-report-detail-modal-phone", { overwrite: true });
  });
});

export {};
