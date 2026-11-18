/// <reference types="cypress" />
// 에이전트 상세 드로워는 정의 파일에 적히지 않은 메타데이터를 빈칸으로 두지 않고 뜻이 있는 말로
// 대체해 보여야 한다(src/components/AgentsView.tsx:88). 모델을 적지 않으면 "상속", 도구를 적지
// 않으면 "전체"이며 이 둘은 뜻이 정반대다 — 빈칸으로 두면 사용자가 "도구가 없다"로 읽는다.
// 격리 홈에는 ~/.claude/agents가 없으므로 목록은 스냅샷 필드로, 상세는 get_agent_detail 응답으로 만든다.
const FULL = {
  name: "reviewer",
  description: "코드 리뷰 담당",
  tools: ["Read", "Grep"],
  model: "sonnet",
  maxTurns: 8,
  permissionMode: "acceptEdits",
  skills: ["code-review"],
  path: "/tmp/am20260914/.claude/agents/reviewer.md",
};
const MINIMAL = {
  name: "sparse",
  description: "",
  tools: [],
  model: null,
  maxTurns: null,
  permissionMode: null,
  skills: [],
  path: "/tmp/am20260914/.claude/agents/sparse.md",
};

const view = () => cy.view("agents");
const drawer = () => cy.get(".drawer");
const field = (label: string) => drawer().find(".definition-list > div").contains("span", label).parent().find("strong");

function seed() {
  cy.stubSnapshotField("agents", [FULL, MINIMAL]);
  cy.stubInvoke("get_agent_detail", (req) => {
    const name = (req.body as { name?: string }).name;
    const definition = name === FULL.name ? FULL : MINIMAL;
    req.reply({
      statusCode: 200,
      body: { definition, body: name === FULL.name ? "# 리뷰어\n변경분을 읽고 결함을 찾는다." : "" },
    });
  });
}

function openAgent(name: string) {
  view().find(".agent-card").contains("strong", name).click();
  drawer().should("be.visible");
}

describe("에이전트 상세 드로워의 미지정 메타데이터 대체 표기", () => {
  beforeEach(() => {
    seed();
    cy.visitApp();
    cy.openView("agents");
    view().find(".agent-card").should("have.length", 2);
  });

  it("메타데이터를 적지 않은 정의는 빈칸 대신 상속·기본·전체로 읽히고 본문 없음을 알린다", () => {
    openAgent(MINIMAL.name);
    field("모델").should("have.text", "상속");
    field("최대 턴").should("have.text", "–");
    field("권한 모드").should("have.text", "기본");
    // 도구를 적지 않은 정의는 "전체 도구"다. 빈칸이면 정반대 뜻으로 읽힌다.
    field("도구").should("have.text", "전체");
    field("스킬").should("have.text", "–");
    field("파일").should("have.text", MINIMAL.path);
    drawer().find("pre.markdown-source").should("have.text", "(본문 없음)");
    drawer().find(".state-panel").should("not.exist");
    drawer().find(".error-banner").should("not.exist");
  });

  it("드로워를 닫고 다른 에이전트를 열면 앞서 본 대체 표기가 남지 않는다", () => {
    openAgent(MINIMAL.name);
    field("모델").should("have.text", "상속");
    cy.get("body").type("{esc}");
    drawer().should("not.exist");

    openAgent(FULL.name);
    field("모델").should("have.text", "sonnet");
    field("최대 턴").should("have.text", "8");
    field("권한 모드").should("have.text", "acceptEdits");
    field("도구").should("have.text", "Read, Grep");
    field("스킬").should("have.text", "code-review");
    drawer().find("pre.markdown-source").should("contain.text", "변경분을 읽고 결함을 찾는다.");
    drawer().should("not.contain.text", "상속");
  });

  it("상세를 읽지 못하면 로딩에 머무르지 않고 오류를 알린다", () => {
    cy.stubInvoke("get_agent_detail", { statusCode: 500, body: { error: "에이전트 정의를 읽지 못했습니다." } });
    openAgent(MINIMAL.name);
    drawer().find(".error-banner").should("contain.text", "에이전트 정의를 읽지 못했습니다.");
    drawer().find(".state-panel").should("not.exist");
  });
});
