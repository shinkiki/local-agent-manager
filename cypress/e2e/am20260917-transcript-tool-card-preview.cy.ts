/// <reference types="cypress" />
// 세션 상세 '작업 로그' 탭이 그리는 도구 카드(ChatToolCard.tsx)의 요약 한 줄 계약을 처음 본다.
// 기존 트랜스크립트 시나리오는 접힌 작업 로그의 개수 세기(AM-278 계열)와 항목 필터별 분리만
// 봤고, 카드 자체가 판정하는 세 갈래 — 빈 JSON 리터럴(`{}`·`[]`·`null`)이면 펼칠 것이 없는
// 압축 카드가 되는지(ChatToolCard.tsx:10,49), 인자 JSON에서 미리보기로 뽑는 키의 우선순위와
// 값이 문자열이 아닐 때의 건너뜀(ChatToolCard.tsx:11,60), JSON이 아닌 인자의 공백 접기와
// 76자 자르기(ChatToolCard.tsx:70) — 는 어느 시나리오도 확인하지 않았다.
import type { ContentBlock, SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-tool-card-session",
  title: "도구 카드 요약 표본",
  sourceTitle: null,
  project: "/tmp/qa-tool-card",
  cwd: "/tmp/qa-tool-card",
  startedAt: 1_757_200_000_000,
  updatedAt: 1_757_200_060_000,
  messageCount: 7,
  tokenTotal: 120,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 1024,
  filePath: "/tmp/qa-tool-card/session.jsonl",
  meta: {
    favorite: false,
    hidden: false,
    note: null,
    customTitle: null,
    folderIds: [],
    reasoningEffort: null,
    mode: null,
    approvalMode: null,
    creationAccountId: null,
    boundAccountId: null,
    pinnedAccountId: null,
  },
  lastFailure: null,
};

// 76자 경계를 넘기는 비-JSON 인자. 줄바꿈·연속 공백이 한 칸으로 접힌 뒤 잘려야 한다.
const LONG_PLAIN = `  첫 줄\n\n\t둘째 줄   ${"가".repeat(90)}  `;
const COLLAPSED_LONG = `첫 줄 둘째 줄 ${"가".repeat(90)}`;

const BLOCKS: ContentBlock[] = [
  // 0. 빈 객체 인자 — 펼칠 본문이 없다.
  { kind: "tool_use", name: "EmptyObject", inputJson: "{}" },
  // 1. 빈 배열 인자.
  { kind: "tool_use", name: "EmptyArray", inputJson: "  []  " },
  // 2. null 결과 — 결과 갈래에서도 같은 판정을 쓴다.
  { kind: "tool_result", text: "null", isError: false },
  // 3. 미리보기 키가 네 개 다 있는 인자 — 표 순서상 file_path가 이긴다.
  { kind: "tool_use", name: "Read", inputJson: '{"query":"QA_QUERY","command":"QA_COMMAND","path":"QA_PATH","file_path":"QA_FILE_PATH"}' },
  // 4. 앞선 키의 값이 문자열이 아니면 건너뛰고 다음 키로 내려간다.
  { kind: "tool_use", name: "Grep", inputJson: '{"file_path":12,"path":null,"cmd":"QA_CMD","query":"QA_QUERY_LAST"}' },
  // 5. 미리보기 키가 하나도 없으면 JSON 원문이 요약이 된다.
  { kind: "tool_use", name: "NoPreviewKey", inputJson: '{"other":"QA_OTHER"}' },
  // 6. JSON이 아닌 인자 — 공백을 접고 76자에서 자른다.
  { kind: "tool_use", name: "PlainText", inputJson: LONG_PLAIN },
  // 7. 오류 결과 — 이름과 상태가 함께 바뀐다.
  { kind: "tool_result", text: "QA_ERROR_OUTPUT", isError: true },
];

const transcript: TranscriptItem[] = BLOCKS.map((block, index) => ({
  index,
  turnId: "turn-1",
  role: "assistant",
  timestamp: index + 1,
  model: null,
  typeLabel: null,
  blocks: [block],
  usage: null,
}));

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const cards = () => cy.get(".activity-turn .chat-tool");
const card = (index: number) => cards().eq(index);
// 539927cb 이후 도구 카드 본문은 펼쳐져 있을 때만 그린다. 본문을 볼 시험은 먼저 펼친다.
const openCard = (index: number) => {
  card(index).find("summary").click();
  return card(index);
};

describe("작업 로그 도구 카드의 요약 한 줄과 압축 갈래", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.wait("@detail");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
      .contains('[role="tab"]', "작업 로그")
      .click()
      .should("have.attr", "aria-selected", "true");
    cards().should("have.length", BLOCKS.length);
  });

  it("빈 JSON 리터럴 인자·결과는 펼침 없는 압축 카드가 된다", () => {
    for (const index of [0, 1, 2]) {
      card(index).should("have.class", "chat-tool-compact");
      card(index).should("not.match", "details");
      card(index).find("pre").should("not.exist");
      // 압축 카드에도 이름과 상태 라벨은 남는다.
      card(index).find(".chat-tool-title small").should("not.exist");
      card(index).find("em").should("have.text", "완료");
    }
    card(0).find(".chat-tool-title b").should("have.text", "EmptyObject");
    card(2).find(".chat-tool-title b").should("have.text", "도구 결과");
  });

  it("미리보기 키는 표 순서대로 고르고 문자열이 아닌 값은 건너뛴다", () => {
    card(3).find(".chat-tool-title small").should("have.text", "QA_FILE_PATH");
    card(4).find(".chat-tool-title small").should("have.text", "QA_CMD");
    // 원문 전체는 펼친 본문에만 있고 요약 줄에 흘러나오지 않는다.
    card(3).find(".chat-tool-title small").should("not.contain.text", "QA_COMMAND");
    openCard(3).find("pre").should("contain.text", "QA_COMMAND");
  });

  it("미리보기 키가 없으면 JSON 원문이 요약으로 남는다", () => {
    card(5).find(".chat-tool-title small").should("have.text", '{"other":"QA_OTHER"}');
  });

  it("JSON이 아닌 인자는 공백을 한 칸으로 접고 76자에서 자른다", () => {
    card(6).find(".chat-tool-title small").invoke("text").should((text: string) => {
      expect(text).to.have.length(76);
      expect(text).to.equal(COLLAPSED_LONG.slice(0, 76));
      expect(text).to.not.match(/\s\s/);
    });
    // 잘린 것은 요약뿐이다. 펼친 본문에는 다듬긴 원문이 그대로 있다.
    openCard(6).find("pre").should("have.text", LONG_PLAIN.trim());
  });

  it("오류 결과는 이름·상태 점·라벨이 함께 실패로 바뀐다", () => {
    card(7).find(".chat-tool-title b").should("have.text", "도구 오류");
    card(7).find("em").should("have.text", "실패");
    card(7).find(".chat-tool-state").should("have.class", "chat-tool-state-failed");
    openCard(7).find("pre.chat-tool-output").should("have.text", "QA_ERROR_OUTPUT");
  });

  it("카드는 기본으로 접혀 있고 클릭하면 그 카드만 펼쳐진다", () => {
    card(3).should("not.have.attr", "open");
    card(3).find("summary").click();
    card(3).should("have.attr", "open");
    card(4).should("not.have.attr", "open");
  });
});
