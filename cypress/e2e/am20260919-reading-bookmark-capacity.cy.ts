/// <reference types="cypress" />
// 읽던 자리는 한 대화에 50개까지만 담긴다(`src/lib/readingAnchor.ts:40`). 한도에 닿았을 때
// '여기 표시'가 잠기고 그 이유가 마우스 오버 문구로 서는지, 한 자리를 지우면 다시 열리는지를
// 화면으로 본다. 기존 am20260918 스펙은 빈 목록에서 추가·복원·이름 붙이기를 보므로
// 이 경계값과 삭제 경로는 아직 화면으로 확인된 적이 없다.
//
// 목록은 `get_session_meta`를 가로채 한도만큼 채운다 — 실제 저장소에 50번 눌러 채우면
// 검증하려는 경계가 아니라 저장 왕복을 재게 된다.

import type { SessionBookmark, SessionDetail, SessionMeta, SessionSummary, TranscriptItem } from "../../src/types";

const BASE_META: SessionMeta = {
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
};

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-reading-capacity-session",
  title: "읽던 자리 한도 표본",
  sourceTitle: null,
  project: "/tmp/qa-reading-capacity",
  cwd: "/tmp/qa-reading-capacity",
  startedAt: 1_757_200_000_000,
  updatedAt: 1_757_200_060_000,
  messageCount: 2,
  tokenTotal: 120,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 4096,
  filePath: "/tmp/qa-reading-capacity/session.jsonl",
  meta: BASE_META,
  lastFailure: null,
};

const LONG_ANSWER = Array.from({ length: 40 }, (_, index) => `한도 문단 ${index} 본문입니다.`).join("\n\n");

const transcript: TranscriptItem[] = [
  { index: 0, turnId: "turn-1", role: "user", timestamp: 1, model: null, typeLabel: null, blocks: [{ kind: "text", text: "긴 답변을 주세요" }], usage: null },
  { index: 1, turnId: "turn-1", role: "assistant", timestamp: 2, model: null, typeLabel: null, blocks: [{ kind: "text", text: LONG_ANSWER }], usage: null },
];

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

/** 한도만큼 채운 목록. 앵커는 본문에 실제로 있는 문단을 가리킨다. */
function filledBookmarks(count: number): SessionBookmark[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `qa-bookmark-${index}`,
    label: `표시 ${index}`,
    snippet: `한도 문단 ${index} 본문입니다.`,
    anchor: { messageKey: "1", markdownLine: index * 2, offset: 0 },
    createdAt: 1_757_200_000_000 + index,
  }));
}

const toggle = () => cy.get(".reading-bookmark-toggle");
const panel = () => cy.get(".reading-bookmark-panel");
const markHere = () => panel().contains("button", "여기 표시");

function openConversationTab(): void {
  cy.openView("sessions");
  cy.contains(".session-table tbody tr", SESSION.title).click();
  cy.wait("@detail");
  cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
    .contains('[role="tab"]', "대화")
    .click()
    .should("have.attr", "aria-selected", "true");
}

describe("읽던 자리 저장 한도", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
  });

  it("한도까지 채우면 '여기 표시'가 잠기고 이유가 문구로 선다", () => {
    cy.stubInvoke("get_session_meta", { statusCode: 200, body: { ...BASE_META, bookmarks: filledBookmarks(50) } });
    cy.visitApp();
    openConversationTab();

    // 담긴 수가 버튼에 그대로 보인다.
    toggle().find(".reading-bookmark-count").should("have.text", "50");
    toggle().click();
    panel().should("exist");
    markHere()
      .should("be.disabled")
      .should("have.attr", "title", "이 대화에 저장할 수 있는 자리를 모두 썼습니다");
    panel().find(".reading-bookmark-row").should("have.length", 50);
  });

  it("한 자리를 지우면 목록이 줄고 '여기 표시'가 다시 열린다", () => {
    const filled = filledBookmarks(50);
    cy.stubInvoke("get_session_meta", { statusCode: 200, body: { ...BASE_META, bookmarks: filled } });
    cy.stubInvoke("patch_session_meta", { statusCode: 200, body: { ...BASE_META, bookmarks: filled.slice(1) } }).as("patch");
    cy.visitApp();
    openConversationTab();

    toggle().click();
    panel().find(".reading-bookmark-row").first().find('[aria-label="읽던 자리 삭제"]').click();
    cy.wait("@patch");

    panel().find(".reading-bookmark-row").should("have.length", 49);
    markHere().should("not.be.disabled");
    toggle().find(".reading-bookmark-count").should("have.text", "49");
  });

  it("저장이 실패하면 지운 자리가 되살아나고 오류가 안내된다", () => {
    const filled = filledBookmarks(50);
    cy.stubInvoke("get_session_meta", { statusCode: 200, body: { ...BASE_META, bookmarks: filled } });
    cy.stubInvoke("patch_session_meta", { statusCode: 500, body: { error: "읽던 자리를 저장하지 못했습니다" } }).as("patch");
    cy.visitApp();
    openConversationTab();

    toggle().click();
    panel().find(".reading-bookmark-row").first().find('[aria-label="읽던 자리 삭제"]').click();
    cy.wait("@patch");

    // 화면에만 지워진 채로 두면 다음에 열었을 때 있던 자리가 사라진 것처럼 보인다.
    panel().find(".reading-bookmark-row").should("have.length", 50);
    cy.get(".reading-notice").should("exist");

    // 여기서 안내가 목록 패널에 완전히 가려진다. `.reading-notice`와
    // `.reading-bookmark-panel`이 같은 `right:0; bottom:100%` 자리를 쓰고 패널이 뒤에
    // 그려져 위에 선다(`src/App.css:2264`,`:2275`). 고치기 전까지 가려진 사실 자체를
    // 기록해 둔다 — 고치면 이 단언이 실패하므로 그때 `be.visible`로 바꾼다.
    cy.get(".reading-notice").then(($notice) => {
      const notice = $notice[0].getBoundingClientRect();
      panel().then(($panel) => {
        const covering = $panel[0].getBoundingClientRect();
        expect(covering.top, "패널이 안내를 덮는다(결함)").to.be.at.most(notice.top);
        expect(covering.bottom).to.be.at.least(notice.bottom);
      });
    });
    cy.screenshot("am20260919-notice-covered-by-panel");
  });
});
