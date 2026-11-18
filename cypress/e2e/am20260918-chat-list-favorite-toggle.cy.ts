/// <reference types="cypress" />
// 채팅 목록 행에 즐겨찾기 토글이 생겼다(새 창 열기 왼쪽). 즐겨찾기는 세션 메타에 달리므로
// 공급자 세션이 아직 없는 채팅에는 걸 수 없고, 그때는 버튼이 비활성으로 서고 사유를
// 툴팁에 남긴다. 기존 채팅 목록 스펙(am20260916-chat-close-confirm-suppress)은 X 버튼만
// 봤고, 즐겨찾기 토글은 세션 서랍에서만 검증돼 있었다.
//
// 격리 백엔드에는 채팅도 세션도 없으므로 get_live_chats와 스냅숏의 sessions를 함께 갈아
// 끼운다. 저장은 patch_session_meta를 가로채 낙관 갱신이 응답으로 굳는지까지 본다.

import type { SessionMeta, SessionSummary } from "../../src/types";
import { stoppedChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";

const SESSION_ID = "qa-chat-favorite-session";

const META: SessionMeta = {
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
  origin: { kind: "user" },
};

const SESSION: SessionSummary = {
  source: "codex",
  id: SESSION_ID,
  title: "QA_CHAT_FAVORITE_SESSION",
  // 메타가 바뀌면 제목은 customTitle ?? sourceTitle로 다시 지어진다. 원제목을 비워 두면
  // 즐겨찾기를 누른 순간 목록 행 제목이 "(제목 없음)"으로 바뀌어 행을 찾지 못한다.
  sourceTitle: "QA_CHAT_FAVORITE_SESSION",
  project: "/tmp/qa-chat-favorite",
  cwd: "/tmp/qa-chat-favorite",
  startedAt: 1_757_300_000_000,
  updatedAt: 1_757_300_100_000,
  messageCount: 2,
  tokenTotal: 90,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 512,
  filePath: `/tmp/qa-chat-favorite/${SESSION_ID}.jsonl`,
  meta: META,
  lastFailure: null,
};

// 세션이 있는 채팅과 아직 없는 채팅을 나란히 둔다 — 버튼의 두 상태를 같은 화면에서 본다.
const LINKED_CHAT = stoppedChat({
  chatId: "qa-chat-favorite-linked",
  providerSessionId: SESSION_ID,
  cwd: "/tmp/qa-chat-favorite",
});
const UNLINKED_CHAT = stoppedChat({
  chatId: "qa-chat-favorite-unlinked",
  providerSessionId: null,
  cwd: "/tmp/qa-chat-favorite-new",
});

const FAVORITE = ".chat-runtime-list-favorite";
const linkedShell = () => cy.get(".chat-runtime-list-item-shell").eq(0);
const unlinkedShell = () => cy.get(".chat-runtime-list-item-shell").eq(1);

describe("채팅 목록 행의 즐겨찾기 토글", () => {
  beforeEach(() => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [LINKED_CHAT, UNLINKED_CHAT] });
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        (res.body as { sessions: unknown[] }).sessions = [SESSION];
      });
    });
    // 10초 폴링의 변경분이 스텁한 세션을 지우지 않게 빈 변경분으로 고정한다.
    cy.stubInvoke("get_manager_snapshot_delta", (req) => {
      req.continue((res) => {
        const body = res.body as { kind?: string; sessions?: unknown[]; changedSessions?: unknown[]; removedSessions?: unknown[] };
        if (body.kind === "full") body.sessions = [SESSION];
        else { body.changedSessions = []; body.removedSessions = []; }
      });
    });
    visitWithFakeChatSocket(LINKED_CHAT);
    cy.openView("chat");
    cy.get(".chat-runtime-list-item-shell").should("have.length", 2);
  });

  it("손잡이는 즐겨찾기·새 창 열기·닫기 차례로 서고, 세션이 없는 채팅은 즐겨찾기가 비활성이다", () => {
    linkedShell().find(".chat-runtime-list-item-actions > button").should("have.length", 3);
    linkedShell().find(".chat-runtime-list-item-actions > button").eq(0).should("have.class", "chat-runtime-list-favorite");
    linkedShell().find(".chat-runtime-list-item-actions > button").eq(1).should("have.class", "chat-runtime-list-popout");
    linkedShell().find(".chat-runtime-list-item-actions > button").eq(2).should("have.class", "chat-runtime-list-close");

    linkedShell().find(FAVORITE).should("not.be.disabled").and("have.attr", "aria-pressed", "false")
      .and("have.attr", "title", "즐겨찾기 추가");
    unlinkedShell().find(FAVORITE).should("be.disabled")
      .and("have.attr", "title", "세션이 만들어진 뒤 즐겨찾기할 수 있습니다");
  });

  it("누르면 별이 차고 저장된 메타가 그대로 굳는다", () => {
    cy.stubInvoke("patch_session_meta", { statusCode: 200, body: { ...META, favorite: true } }).as("patch");

    linkedShell().find(FAVORITE).click();
    cy.wait("@patch").its("request.body.request.patch").should("deep.equal", { favorite: true });

    linkedShell().find(FAVORITE).should("have.class", "active")
      .and("have.attr", "aria-pressed", "true")
      .and("have.attr", "title", "즐겨찾기 해제");
    // 같은 세션을 쓰는 세션 목록도 함께 바뀐다 — 화면 두 곳이 갈라지지 않아야 한다.
    cy.openView("sessions").should("be.visible");
    cy.contains(".session-table tbody tr", SESSION.title).find(".favorite-star").should("exist");
  });

  it("저장이 거절되면 별이 되돌아가고 사유가 뜬다", () => {
    cy.stubInvoke("patch_session_meta", { statusCode: 500, body: { error: "QA_FAVORITE_SAVE_FAILED" } }).as("patch");

    linkedShell().find(FAVORITE).click();
    cy.wait("@patch");

    linkedShell().find(FAVORITE).should("not.have.class", "active").and("have.attr", "aria-pressed", "false");
    cy.get(".error-banner").should("contain.text", "QA_FAVORITE_SAVE_FAILED");
  });
});
