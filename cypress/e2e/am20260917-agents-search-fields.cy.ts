/// <reference types="cypress" />
// 에이전트 목록 검색이 "무엇까지 훑는가"를 본다. 검색창 안내는 '에이전트명·설명·도구 검색'이지만
// 실제 판정(src/components/AgentsView.tsx:110 matchesAgent)은 모델명과 스킬명까지 함께 훑고,
// 검색어는 호출부에서 trim+소문자로 다듬은 뒤(src/components/AgentsView.tsx:17) 한 덩어리 부분일치로
// 본다(SkillLibraryPanel.tsx matchesNeedle). 2026-09-17 리팩토링(094c7f95)이 이 판정을 네 목록에서
// 한 함수로 모았으므로 에이전트 목록 쪽 계약을 고정해 둔다.
//
// 기존 시나리오와의 차이: qa17-agents-search-empty는 검색 0건 빈 상태 문구만,
// am20260906-agents-language는 다국어 전환만 본다. 어느 필드가 검색에 걸리는지는 아직 없다.
//
// 격리 홈에는 ~/.claude/agents가 없어 정의가 0건이므로 스냅숏의 agents 배열을 갈아 끼운다.
const AGENTS = [
  {
    name: "reviewer", description: "코드 리뷰 담당", tools: ["Read", "Grep"], model: "sonnet",
    maxTurns: null, permissionMode: null, skills: ["code-review"],
    path: "/tmp/am-agents-search/.claude/agents/reviewer.md",
  },
  {
    name: "planner", description: "구현 계획 수립", tools: ["Bash"], model: "opus",
    maxTurns: null, permissionMode: null, skills: ["parallel-development"],
    path: "/tmp/am-agents-search/.claude/agents/planner.md",
  },
  {
    name: "tester", description: "테스트 작성", tools: ["Write"], model: null,
    maxTurns: null, permissionMode: null, skills: [],
    path: "/tmp/am-agents-search/.claude/agents/tester.md",
  },
];

const view = () => cy.view("agents");

/** 검색어를 새로 넣고 남는 카드 이름을 확인한다. */
function search(term: string, expected: string[]) {
  view().find(".search-input").clear();
  if (term.length > 0) view().find(".search-input").type(term, { parseSpecialCharSequences: false });
  view().find(".toolbar-count").should("have.text", `Claude 에이전트 ${expected.length}개`);
  view().find(".agent-card").should("have.length", expected.length);
  expected.forEach((name) => view().find(".agent-card").contains(name).should("exist"));
}

describe("에이전트 목록 검색이 훑는 필드", () => {
  beforeEach(() => {
    cy.stubSnapshotField("agents", AGENTS);
    cy.visitApp();
    cy.openView("agents");
    view().find(".agent-card").should("have.length", 3);
  });

  it("도구명은 대소문자를 가리지 않고 부분일치로 걸린다", () => {
    // 도구는 "Grep"으로 저장돼 있고 검색어는 소문자다. 화면 안내가 '도구 검색'이라 적힌 만큼
    // 도구명만으로 좁혀지는 것이 계약이다.
    search("grep", ["reviewer"]);
    // 대문자로 넣어도 같은 한 건이어야 한다.
    search("GREP", ["reviewer"]);
  });

  it("모델명으로도 좁혀지고, 모델이 비어 있는 정의는 걸리지 않는다", () => {
    search("opus", ["planner"]);
    // tester는 model이 null이다. 빈 값이 어떤 검색어와도 맞지 않아야 한다.
    search("sonnet", ["reviewer"]);
  });

  it("스킬명 일부로도 좁혀진다", () => {
    search("parallel", ["planner"]);
    search("code-rev", ["reviewer"]);
  });

  it("검색어 앞뒤 공백은 무시된다", () => {
    search("   tester   ", ["tester"]);
  });

  it("공백을 포함한 검색어는 낱말 AND가 아니라 한 덩어리로 본다", () => {
    // "Read"와 "Grep"을 모두 가진 reviewer가 있지만, 판정은 각 필드값에 대한 부분일치라
    // 두 낱말을 이어 쓴 검색어는 어느 필드에도 맞지 않는다. 0건 안내가 나와야 한다.
    view().find(".search-input").type("read grep");
    view().find(".toolbar-count").should("have.text", "Claude 에이전트 0개");
    view().find(".empty-state strong").should("have.text", "검색 결과가 없습니다");
  });

  it("검색어를 지우면 세 카드가 모두 돌아온다", () => {
    search("grep", ["reviewer"]);
    search("", ["reviewer", "planner", "tester"]);
    view().find(".empty-state").should("not.exist");
  });
});
