/**
 * 무인 실행 완료 알림을 눌렀을 때, 그 세션이 **세션 목록에 없을 때**의 두 갈래.
 *
 * 목록에서 제외한 프로젝트에서 돈 회차는 카탈로그가 일부러 걸러 내므로 아무리 기다려도
 * 목록에 나타나지 않는다. 예전에는 그 자리에서 색인 예산만 다 쓰고 "요청을 처리하지
 * 못했습니다 · APP_RUNTIME" 실패 배너를 세웠다 — 실패가 아닌데 실패로 읽혔고, 배너를
 * 거두는 폴링이 몇 초 만에 지워 읽을 수도 없었다.
 *
 * 지금은 원본에서 세션을 직접 찾아 열고(1), 원본조차 없을 때만 실패 배너가 아닌 토스트
 * 안내를 남긴다(2).
 */
const SESSION_ID = "e2e-unlisted-session";

const attentionItem = {
  approvalId: null,
  chatId: "e2e-unlisted-chat",
  createdAt: Date.now(),
  cwd: "/tmp/e2e-excluded-project",
  detail: "completed",
  id: "turn:e2e-unlisted-chat:e2e-turn",
  kind: "completed",
  origin: null,
  preview: null,
  profile: "standard",
  providerSessionId: SESSION_ID,
  read: false,
  resuming: false,
  source: "codex",
  title: "에이전트 작업 완료",
  unattended: true,
};

const unlistedSession = {
  source: "codex",
  id: SESSION_ID,
  title: "제외 프로젝트 무인 회차",
  sourceTitle: "제외 프로젝트 무인 회차",
  project: "excluded-project",
  cwd: "/tmp/e2e-excluded-project",
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  messageCount: 2,
  tokenTotal: null,
  tokenUsage: null,
  model: null,
  gitBranch: null,
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 1024,
  filePath: "/tmp/e2e-excluded-project/session.jsonl",
  lastFailure: null,
  meta: {
    approvalMode: "never",
    boundAccountId: null,
    creationAccountId: null,
    customTitle: null,
    favorite: false,
    folderIds: [],
    hidden: false,
    mode: "workspace",
    note: null,
    reasoningEffort: null,
  },
};

function openAttentionItem(): void {
  cy.stubInvoke("get_chat_attention_snapshot", {
    statusCode: 200,
    body: { items: [attentionItem], unreadCount: 1, pendingCount: 0 },
  });
  // 색인은 이 세션을 끝내 올리지 못한다 — 제외 프로젝트의 회차가 그렇다.
  cy.stubInvoke("refresh_session_catalog", { statusCode: 200, body: { revision: 1, changed: false } });
  cy.visitApp();
  cy.anchor("topbar.attention").click();
  cy.get(".attention-item").first().click();
}

describe("목록에 없는 무인 실행 세션 열기", () => {
  it("색인이 올리지 못해도 원본에 기록이 있으면 세션 화면이 그 세션으로 열린다", () => {
    cy.stubInvoke("get_session_summary", { statusCode: 200, body: unlistedSession });
    cy.stubInvoke("get_session_detail", {
      statusCode: 200,
      body: { session: unlistedSession, transcript: [], truncated: false, skippedLines: 0, unavailableReason: null },
    });
    openAttentionItem();

    cy.get(".drawer .drawer-title", { timeout: 20_000 }).should("contain.text", "제외 프로젝트 무인 회차");
    cy.get(".error-banner").should("not.exist");
    cy.get(".app-toast").should("not.exist");
  });

  it("원본에도 기록이 없으면 실패 배너가 아니라 토스트 안내를 남긴다", () => {
    cy.stubInvoke("get_session_summary", { statusCode: 404, body: { error: "세션을 찾을 수 없습니다" } });
    openAttentionItem();

    cy.get(".app-toast", { timeout: 20_000 }).should("be.visible")
      .and("contain.text", "세션 화면에서 다시 확인하세요");
    // 실패 머리말과 오류코드는 붙지 않는다.
    cy.get(".error-banner").should("not.exist");
    cy.get(".app-toast").should("not.contain.text", "APP_RUNTIME");
    cy.screenshot("attention-notice-toast", { overwrite: true });

    cy.get(".app-toast-close").click();
    cy.get(".app-toast").should("not.exist");
  });
});
