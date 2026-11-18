/// <reference types="cypress" />
/**
 * AM-362 — 세션 목록의 '더 보기' 렌더 구간 계약을 대량 상태에서 확인한다.
 *
 * 격리 백엔드에는 세션이 하나도 없어 지금까지의 세션 스펙(추가 필터·폴더·출처 탭)은
 * 전부 빈 목록 또는 소량 주입으로만 돌았다. 렌더 구간을 100건 단위로 잘라 두는
 * src/components/SessionsView.tsx:340(SESSION_RENDER_PAGE)·:500(필터 변경 시 구간 초기화)·
 * :501(slice)·:502(showMore)와, 그 구간을 그리는 SessionTable의 '더 보기' 버튼
 * (src/components/SessionsView.tsx:990-994)은 100건을 넘겨야만 드러나므로 화면에서
 * 확인된 적이 없다.
 *
 * 경계값으로 120건을 심어 아래를 본다.
 * 1. 첫 렌더는 정확히 100행이고, 표 머리말은 걸린 전체 수(120)를 적으며 '더 보기'가 뜬다.
 * 2. '더 보기' 한 번에 120행 전부가 그려지고 버튼이 사라진다.
 * 3. 검색어로 필터를 바꾸면 늘려 둔 구간이 100으로 되돌아간다(:500).
 * 4. 검색으로 100건 이하로 좁히면 '더 보기'가 나오지 않는다.
 */
import type { ProviderId, SessionSummary } from "../../src/types";

const META: SessionSummary["meta"] = {
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

const BASE = 1_757_000_000_000;

/**
 * 120건 중 앞 30건만 제목에 `짝수표본`을 달아 둔다. 검색으로 100건 이하까지 좁히는
 * 걸음에서 쓴다.
 */
const session = (index: number): SessionSummary => {
  const source: ProviderId = index % 2 === 0 ? "claude" : "codex";
  const marked = index < 30;
  return {
    source,
    id: `qa-more-${String(index).padStart(3, "0")}`,
    title: marked ? `짝수표본 세션 ${index}` : `대량표본 세션 ${index}`,
    sourceTitle: null,
    project: "/tmp/qa-session-load-more",
    cwd: "/tmp/qa-session-load-more",
    startedAt: BASE - index * 60_000 - 30_000,
    updatedAt: BASE - index * 60_000,
    messageCount: 3,
    tokenTotal: 100,
    tokenUsage: null,
    model: "qa-model",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 2048,
    filePath: `/tmp/qa-session-load-more/qa-more-${index}.jsonl`,
    meta: META,
    lastFailure: null,
  };
};

const SESSIONS = Array.from({ length: 120 }, (_, index) => session(index));

const rows = () => cy.get(".session-table tbody tr");
// '더 보기'는 100행 아래에 붙어 첫 화면 밖에 있다. 존재와 문구로 보고, 실제로 닿는지는
// 눌러 보는 걸음이 대신 증명한다(Cypress가 누르기 전에 스크롤해 가시성을 확인한다).
const moreButton = () => cy.get(".session-table-more button");

describe("세션 목록 '더 보기' 렌더 구간", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", SESSIONS);
    cy.visitApp();
    cy.openView("sessions").should("be.visible");
    cy.get(".session-table").should("be.visible");
  });

  it("첫 렌더는 100행만 그리고 걸린 전체 수와 함께 '더 보기'를 띄운다", () => {
    rows().should("have.length", 100);
    cy.get(".table-caption strong").should("contain.text", "120");
    moreButton().should("exist").and("contain.text", "100 / 120");
  });

  it("'더 보기'를 누르면 남은 행이 모두 그려지고 버튼이 사라진다", () => {
    moreButton().click();
    rows().should("have.length", 120);
    cy.get(".session-table-more").should("not.exist");
  });

  it("필터를 바꾸면 늘려 둔 렌더 구간이 100으로 되돌아간다", () => {
    moreButton().click();
    rows().should("have.length", 120);

    // 120건 전부에 들어 있는 낱말이라 걸리는 전체 수는 그대로 120이다.
    cy.get(".search-input").type("세션");
    rows().should("have.length", 100);
    moreButton().should("exist").and("contain.text", "100 / 120");
  });

  it("검색으로 100건 이하까지 좁히면 '더 보기'가 나오지 않는다", () => {
    cy.get(".search-input").type("짝수표본");
    rows().should("have.length", 30);
    cy.get(".table-caption strong").should("contain.text", "30");
    cy.get(".session-table-more").should("not.exist");
  });
});
