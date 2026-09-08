/// <reference types="cypress" />
// QA #17. 에이전트 화면의 빈 상태는 "정의가 하나도 없다"와 "정의는 있는데 검색으로 0건이 됐다"를
// 갈라 말해야 한다(src/components/AgentsView.tsx). 격리 홈에는 ~/.claude/agents가 없어 정의가
// 0건이므로, 정의가 있는 상태는 get_manager_snapshot 응답의 agents 배열만 갈아 끼워 만든다.
const AGENTS = [
  { name: "reviewer", description: "코드 리뷰 담당", tools: ["Read", "Grep"], model: "sonnet", maxTurns: null, permissionMode: null, skills: [], path: "/tmp/qa17/.claude/agents/reviewer.md" },
  { name: "planner", description: "구현 계획 수립", tools: ["Read"], model: null, maxTurns: null, permissionMode: null, skills: [], path: "/tmp/qa17/.claude/agents/planner.md" },
  { name: "tester", description: "테스트 작성", tools: ["Bash"], model: null, maxTurns: null, permissionMode: null, skills: [], path: "/tmp/qa17/.claude/agents/tester.md" },
];

function seedAgents(agents: unknown[]) {
  cy.stubInvoke("get_manager_snapshot", (req) => {
    req.continue((res) => {
      (res.body as { agents: unknown[] }).agents = agents;
    });
  });
}

const view = () => cy.view("agents");

describe("에이전트 화면의 검색 0건 빈 상태", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("정의 3건을 검색으로 0건으로 좁히면 '검색 결과 없음'과 전체 개수를 알리고, 지우면 카드가 돌아온다", () => {
    seedAgents(AGENTS);
    cy.visitApp();
    cy.openView("agents");
    view().find(".agent-card").should("have.length", 3);
    view().find(".toolbar-count").should("have.text", "Claude 에이전트 3개");

    // 1) 검색으로 0건: 탐지 경로 안내가 아니라 검색을 되돌리라는 안내가 나온다.
    view().find(".search-input").type("zzz-no-such-agent");
    view().find(".toolbar-count").should("have.text", "Claude 에이전트 0개");
    view().find(".empty-state strong").should("have.text", "검색 결과가 없습니다");
    view().find(".empty-state p").should("have.text", "검색어를 지우거나 다른 낱말로 찾아보세요. (전체 3개)");
    view().find(".empty-state").should("not.contain.text", "~/.claude/agents");

    // 2) 검색어를 지우면 카드 3장이 되돌아온다.
    view().find(".search-input").clear();
    view().find(".agent-card").should("have.length", 3);
    view().find(".empty-state").should("not.exist");
  });

  it("정의가 하나도 없으면 검색어가 있어도 탐지 경로 안내가 남는다", () => {
    cy.visitApp();
    cy.openView("agents");
    view().find(".empty-state strong").should("have.text", "에이전트 정의가 없습니다");
    view().find(".search-input").type("zzz-no-such-agent");
    // 검색으로 좁힐 원본이 없으므로 '검색 결과 없음'으로 바꾸지 않는다. 원인은 정의 파일이 없는 것이다.
    view().find(".empty-state strong").should("have.text", "에이전트 정의가 없습니다");
    view().find(".empty-state p").should("contain.text", "~/.claude/agents");
  });

  it("영어에서도 검색 0건 안내가 영어 계약값으로 나온다", () => {
    seedAgents(AGENTS);
    cy.visitApp();
    cy.setLanguage("en");
    cy.openView("agents");
    view().find(".search-input").type("zzz-no-such-agent");
    view().find(".empty-state strong").should("have.text", "No matching agents");
    view().find(".empty-state p").should("have.text", "Clear the search or try another term. (3 total)");
    view().find(".empty-state").invoke("text").should("not.match", /[가-힣]/);
  });
});
