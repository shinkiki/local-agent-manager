/// <reference types="cypress" />
// 긴 답변 하나가 화면 몇 개 분량이면 다 읽기 전에 다음 질문을 보내게 되고, 그때 화면이
// 새 요청 자리로 옮겨 가 읽던 자리를 잃는다. 그 자리를 표시해 두고 되돌아가는 '읽던 자리'를
// 세션 상세 대화 탭에서 화면으로 본다.
//
// 앵커가 마크다운 원문 줄(`data-md-line`)로 적히는지, 그 자리로 실제로 이동해 강조가 붙는지,
// 그리고 앱을 다시 띄워도 남는지(=저장한 `SessionMeta.bookmarks`를 새 화면이 다시 읽는지)를
// 함께 본다. 세션은 스냅샷 스텁으로만 있어 격리 백엔드 카탈로그에는 없고,
// `patch_session_meta`는 카탈로그에 없는 세션의 메타를 적지 않는다(`ensure_session_known`,
// 2026-09-27). 그래서 메타 읽기·쓰기를 스펙 안의 저장소로 받는다 — 그 저장소는 다시 띄운
// 화면에도 남으므로 "껐다 켜도 남는다"는 화면이 저장한 목록을 새로 읽어 오는지로 본다.

import type { SessionBookmark, SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";
import { openStoppedChat, stoppedChat, stubLiveChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-reading-bookmark-session",
  title: "읽던 자리 표본",
  sourceTitle: null,
  project: "/tmp/qa-reading-bookmark",
  cwd: "/tmp/qa-reading-bookmark",
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
  filePath: "/tmp/qa-reading-bookmark/session.jsonl",
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

/** 스크롤이 생길 만큼 긴 답변. 문단마다 원문 줄 번호가 달라 앵커가 문단 단위로 잡힌다. */
const LONG_ANSWER = Array.from({ length: 40 }, (_, index) => `QA 문단 ${index} 본문입니다.`).join("\n\n");

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

const body = () => cy.get(".drawer-body");
const toggle = () => cy.get(".reading-bookmark-toggle");
const panel = () => cy.get(".reading-bookmark-panel");

function openConversationTab(): void {
  cy.openView("sessions");
  cy.contains(".session-table tbody tr", SESSION.title).click();
  cy.wait("@detail");
  cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
    .contains('[role="tab"]', "대화")
    .click()
    .should("have.attr", "aria-selected", "true");
}

describe("세션 상세 대화 탭의 읽던 자리", () => {
  let saved: SessionBookmark[];

  beforeEach(() => {
    saved = [];
    cy.stubInvoke("get_session_meta", (request) => request.reply({ statusCode: 200, body: { ...SESSION.meta, bookmarks: saved } }));
    cy.stubInvoke("patch_session_meta", (request) => {
      const body = request.body as { request: { id: string; patch: { bookmarks?: SessionBookmark[] } } };
      expect(body.request.id).to.equal(SESSION.id);
      if (body.request.patch.bookmarks) saved = body.request.patch.bookmarks;
      request.reply({ statusCode: 200, body: { ...SESSION.meta, bookmarks: saved } });
    });
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
    openConversationTab();
  });

  it("책갈피 버튼은 스크롤 컨트롤 묶음 안에서 맨 위 버튼보다 위에 선다", () => {
    body().scrollTo(0, 700);
    // 같은 묶음 안에 있어야 스크롤 버튼이 사라지는 대화에서도 따로 떠 있지 않는다.
    cy.get(".chat-scroll-controls .reading-bookmark-toggle").should("exist");
    // 맨 위·맨 아래 버튼과 같은 동그란 모양을 쓴다. 되돌아가기도 같은 규칙
    // (`.reading-controls > button`)을 받는 형제라 함께 지켜진다.
    toggle().should("have.css", "border-radius", "50%");
    toggle().should("have.css", "width", "32px");
    toggle().then(($toggle) => {
      const mark = $toggle[0].getBoundingClientRect();
      cy.get('.chat-scroll-controls > button[title="맨 위"]').then(($top) => {
        const top = $top[0].getBoundingClientRect();
        expect(mark.bottom).to.be.at.most(top.top + 1);
        expect(Math.abs(mark.right - top.right)).to.be.lessThan(2);
      });
    });
  });

  it("읽던 자리를 표시하면 마크다운 원문 줄로 적히고 그 자리로 되돌아간다", () => {
    // 답변 중간까지 읽은 상태를 만든다.
    body().scrollTo(0, 700);
    body().find("[data-md-line]").should("exist");

    // 화면에 실제로 보이는 첫 문단. 경계에 걸쳐 이미 지나간 문단이 아니라 이것이
    // 표시되어야 한다 — 한때는 그 바로 위 문단이 표시됐다(사용자 보고).
    body().then(($body) => {
      const view = $body[0].getBoundingClientRect();
      const reading = Array.from($body[0].querySelectorAll<HTMLElement>("[data-md-line]"))
        .find((block) => block.getBoundingClientRect().bottom > view.top + 24);
      cy.wrap(reading?.textContent?.trim() ?? "").as("reading");
    });

    toggle().click();
    panel().contains("button", "여기 표시").click();

    // 목록에 선 표시는 그 자리 본문을 이름 대신 보여준다.
    panel().find(".reading-bookmark-list li").should("have.length", 1);
    panel().find(".reading-bookmark-jump strong").invoke("text").should("match", /QA 문단 \d+/);
    cy.get("@reading").then((reading) => {
      panel().find(".reading-bookmark-jump strong").should("have.text", String(reading));
    });

    // 목록에서 고르면 표시한 블록이 화면 맨 위에 선다. 한때는 표시할 때 잘려 있던
    // 만큼까지 되살려, 표시한 자리가 아니라 그 아래 글부터 보였다(사용자 보고).
    const marked = panel().find(".reading-bookmark-jump strong").invoke("text");
    body().scrollTo(0, 0);
    panel().find(".reading-bookmark-jump").click();
    cy.get(".is-reading-target").should("exist");
    body().invoke("scrollTop").should("be.greaterThan", 100);
    // 부드럽게 움직이는 동안은 아직 도착 전이라, 멈출 때까지 다시 보는 단언으로 확인한다.
    marked.then((label) => {
      cy.contains(".drawer-body [data-md-line]", String(label)).should(($target) => {
        const target = $target[0].getBoundingClientRect();
        const view = Cypress.$(".drawer-body")[0].getBoundingClientRect();
        // 블록 첫 줄이 화면 위로 잘리지 않고, 아래로 밀려나 있지도 않다.
        expect(target.top - view.top).to.be.within(-2, 40);
      });
    });
  });

  it("표시한 자리는 앱을 다시 띄워도 남는다", () => {
    body().scrollTo(0, 700);
    toggle().click();
    panel().contains("button", "여기 표시").click();
    panel().find(".reading-bookmark-list li").should("have.length", 1);
    panel().find(".reading-bookmark-jump strong").invoke("text").as("marked");

    // 저장소까지 갔는지는 새로 띄운 화면이 같은 목록을 읽어 오는지로 본다.
    cy.visitApp();
    openConversationTab();
    toggle().click();
    panel().find(".reading-bookmark-list li").should("have.length", 1);
    cy.get("@marked").then((marked) => {
      panel().find(".reading-bookmark-jump strong").should("have.text", String(marked));
    });
  });

  it("맨 위 자리에서는 되돌아갈 곳이 없어 되돌아가기 버튼이 서지 않는다", () => {
    // 되돌아가기는 화면이 실제로 옮겨 갔을 때만 뜬다. 옮겨 간 적이 없으면 눌러도 지금
    // 보는 자리로 가는 버튼이라, 자리를 적어 두는 것과 버튼을 보여주는 것을 갈라 두었다.
    cy.get(".reading-return").should("not.exist");
    body().scrollTo(0, 700);
    cy.get(".reading-return").should("not.exist");
  });

  it("이름을 붙이면 본문 대신 그 이름이 목록에 선다", () => {
    body().scrollTo(0, 700);
    toggle().click();
    panel().contains("button", "여기 표시").click();
    panel().find('[aria-label="이름 바꾸기"]').click();
    panel().find(".reading-bookmark-rename").type("결론 문단{enter}");
    panel().find(".reading-bookmark-jump strong").should("have.text", "결론 문단");

    panel().find('[aria-label="읽던 자리 삭제"]').click();
    panel().find(".reading-bookmark-list").should("not.exist");
  });
});

describe("막 시작한 채팅의 대화 창", () => {
  it("스크롤 버튼이 서지 않는 대화에는 책갈피 버튼도 함께 서지 않는다", () => {
    // 대화가 화면 하나에 다 들어오면 맨 위·맨 아래 버튼은 서지 않는다. 그 옆에 따로
    // 띄우던 시절의 책갈피 버튼만 허공에 남아 있었다(사용자 보고, 2026-09-19).
    const chat = stoppedChat();
    stubLiveChat(chat);
    visitWithFakeChatSocket(chat);
    openStoppedChat();

    cy.get(".chat-stream").should("exist");
    cy.get(".reading-return").should("not.exist");
    // 스크롤 묶음이 서지 않는 화면에는 책갈피 버튼도 없고, 서더라도 그 안에 있다.
    // 둘 중 어느 쪽이든 버튼 하나만 허공에 남는 일은 없다.
    cy.get("body").then(($body) => {
      const nav = $body.find(".chat-scroll-controls");
      const marks = $body.find(".reading-bookmark-toggle");
      if (nav.length === 0) expect(marks).to.have.length(0);
      else expect(nav.find(".reading-bookmark-toggle")).to.have.length(marks.length);
    });
  });
});
