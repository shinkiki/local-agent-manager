/// <reference types="cypress" />
import type { SessionDetail, TranscriptItem } from "../../src/types";
import { applyGalleryLanguage, shoot, stubWorkspace, tr, visitDark, widenHeadlessWindow, NOW, MIN, SESSIONS } from "../support/releaseGalleryFixtures";

// ---------------------------------------------------------------------------
// 세션 상세 트랜스크립트

const RELEASE_SESSION = SESSIONS[0];

function tItem(index: number, turnId: string, role: string, minutesAgo: number, blocks: TranscriptItem["blocks"]): TranscriptItem {
  return { index, turnId, role, timestamp: NOW - minutesAgo * MIN, model: role === "assistant" ? "claude-sonnet-4-5" : null, typeLabel: null, blocks, usage: null };
}

const TRANSCRIPT: TranscriptItem[] = [
  tItem(0, "t1", "user", 42, [{ kind: "text", text: tr("v0.2.0 태그 이후 커밋을 훑어서 v0.3.0 릴리스 노트 초안을 CHANGELOG.md 맨 위에 써 줘. 사용자에게 보이는 변화 위주로.", "Go through the commits since the v0.2.0 tag and draft v0.3.0 release notes at the top of CHANGELOG.md. Focus on user-visible changes.") }]),
  tItem(2, "t1", "assistant", 41, [{ kind: "tool_use", name: "Bash", inputJson: JSON.stringify({ command: "git log v0.2.0..HEAD --oneline --no-merges | wc -l" }) }]),
  tItem(3, "t1", "assistant", 41, [{ kind: "tool_result", text: "214", isError: false }]),
  tItem(4, "t1", "assistant", 40, [{ kind: "tool_use", name: "Read", inputJson: JSON.stringify({ file_path: "/workspace/agent-manager/CHANGELOG.md", limit: 40 }) }]),
  tItem(5, "t1", "assistant", 40, [{ kind: "tool_result", text: tr("# Changelog\n\n## v0.2.0 — 2026-08-12\n- 통합 세션 목록과 폴더\n- 반복 일정 ...", "# Changelog\n\n## v0.2.0 — 2026-08-12\n- Unified session list and folders\n- Recurring schedules ..."), isError: false }]),
  tItem(6, "t1", "assistant", 39, [{ kind: "tool_use", name: "Edit", inputJson: JSON.stringify({ file_path: "/workspace/agent-manager/CHANGELOG.md", old_string: "# Changelog\n", new_string: "# Changelog\n\n## v0.3.0\n..." }) }]),
  tItem(7, "t1", "assistant", 39, [{ kind: "tool_result", text: "The file /workspace/agent-manager/CHANGELOG.md has been updated.", isError: false }]),
  tItem(8, "t1", "assistant", 38, [{
    kind: "text",
    text: tr([
      "태그 이후 커밋 **214건**을 훑어 `CHANGELOG.md` 맨 위에 초안을 넣었습니다.",
      "",
      "### 주요 변화",
      "- **로컬 모델 공급자** — Ollama 등 OpenAI 호환 서버를 네 번째 공급자로 연결",
      "- **프로젝트 형상관리 탭** — 상태·차이·커밋·스태시·리베이스를 앱 안에서",
      "- **계정별 자격증명 격리** — 여러 계정으로 동시에 요청",
      "- **알림 센터** — 완료·승인 대기·실패를 한 곳에서 묶어 보기",
      "",
      "### 확인이 필요한 부분",
      "1. Windows 설치본 항목에 서명 여부를 적을지",
      "2. 내부 리팩터링 커밋(71건)은 생략했습니다",
      "",
      "```md",
      "## v0.3.0 — 2026-09-30",
      "### 새 기능",
      "- 로컬 LLM 공급자 (Ollama, LM Studio)",
      "- 프로젝트 파일·형상관리 화면",
      "```",
    ], [
      "I went through **214 commits** since the tag and put a draft at the top of `CHANGELOG.md`.",
      "",
      "### Highlights",
      "- **Local model provider** — connect Ollama or any OpenAI-compatible server as a fourth provider",
      "- **Project git tab** — status, diff, commit, stash and rebase inside the app",
      "- **Per-account credential isolation** — send requests from several accounts at once",
      "- **Notification center** — completions, pending approvals and failures in one place",
      "",
      "### Needs your call",
      "1. Whether to mention signing for the Windows installer",
      "2. I left out the 71 internal refactoring commits",
      "",
      "```md",
      "## v0.3.0 — 2026-09-30",
      "### New",
      "- Local LLM provider (Ollama, LM Studio)",
      "- Project files and git screens",
      "```",
    ]).join("\n"),
  }]),
  tItem(9, "t2", "user", 12, [{ kind: "text", text: tr("좋아. 영어 버전도 같은 구조로 README 릴리스 섹션에 추가해 줘.", "Great. Add a short summary with the same structure to the README releases section too.") }]),
  tItem(10, "t2", "assistant", 11, [{ kind: "tool_use", name: "Grep", inputJson: JSON.stringify({ pattern: "## Releases", path: "/workspace/agent-manager/README.md" }) }]),
  tItem(11, "t2", "assistant", 11, [{ kind: "tool_result", text: "README.md:88:## Releases", isError: false }]),
  tItem(12, "t2", "assistant", 10, [{ kind: "tool_use", name: "Edit", inputJson: JSON.stringify({ file_path: "/workspace/agent-manager/README.md" }) }]),
  tItem(13, "t2", "assistant", 10, [{ kind: "tool_result", text: "The file /workspace/agent-manager/README.md has been updated.", isError: false }]),
  tItem(14, "t2", "assistant", 9, [{
    kind: "text",
    text: [
      tr("README의 `## Releases` 아래에 영어 요약을 추가했습니다.", "Added a summary under `## Releases` in the README."),
      "",
      "- **Local model provider** — connect Ollama or any OpenAI-compatible server",
      "- **Project git tab** — status, diff, commit, stash and rebase in the app",
      "- **Per-account credential isolation** — run several accounts in parallel",
      "",
      tr("두 문서의 항목 순서를 맞춰 두었으니 한 번 훑어보시면 됩니다.", "Both documents list the items in the same order — give it a quick look."),
    ].join("\n"),
  }]),
];

const DETAIL: SessionDetail = {
  session: RELEASE_SESSION,
  transcript: TRANSCRIPT,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
} as SessionDetail;

// ---------------------------------------------------------------------------
// 채팅

function chatInfo(overrides: Record<string, unknown>) {
  return {
    chatId: "chat-main",
    startedAt: NOW - 25 * MIN,
    source: "claude",
    accountId: "acc-claude-work",
    resuming: false,
    providerSessionId: "s-git-panel-live",
    cwd: "/workspace/agent-manager",
    model: "claude-sonnet-4-5",
    localConnectionId: null,
    reasoningEffort: "high",
    mode: "workspace",
    approvalMode: "manual",
    state: "ready",
    turnCount: 2,
    lastTurnStatus: "completed",
    replayTruncated: false,
    unattended: false,
    origin: null,
    attached: false,
    interactiveApprovals: true,
    profile: "standard",
    systemTools: false,
    contextUsedTokens: 48_200,
    contextWindowTokens: 200_000,
    ...overrides,
  };
}

const LIVE_CHATS = [
  chatInfo({}),
  chatInfo({ chatId: "chat-codex", source: "codex", accountId: "acc-codex-main", providerSessionId: "p-codex", cwd: "/workspace/payments-api", model: "gpt-5.6-codex", state: "running", lastTurnStatus: "started", startedAt: NOW - 8 * MIN, turnCount: 1 }),
  chatInfo({ chatId: "chat-ag", source: "antigravity", accountId: null, providerSessionId: "p-ag", cwd: "/workspace/mobile-app", model: "gemini-3-pro", state: "ready", startedAt: NOW - 70 * MIN, turnCount: 4 }),
];

const AIA_CHAT = chatInfo({ chatId: "chat-aia", profile: "aia", source: "codex", accountId: "acc-codex-main", model: "gpt-5.6-codex", systemTools: true, cwd: "", providerSessionId: "p-aia", reasoningEffort: "medium", turnCount: 1 });

interface GalleryHandles {
  __gallerySockets: Record<string, EventTarget>;
}

/** `/api/chat` 가짜 소켓. 첫 메시지(start·attach)를 보고 맞는 세션 state를 돌려준다. */
function fakeChatSockets(chats: Array<Record<string, unknown>> = [...LIVE_CHATS, AIA_CHAT]) {
  return (win: Cypress.AUTWindow) => installFakeChatSockets(win, chats);
}

function installFakeChatSockets(win: Cypress.AUTWindow, chats: Array<Record<string, unknown>>): void {
  const handles = win as unknown as GalleryHandles;
  handles.__gallerySockets = {};
  const RealWebSocket = win.WebSocket;
  class FakeChatSocket extends win.EventTarget {
    readyState = 0;
    url: string;
    first = true;
    constructor(url: string) {
      super();
      this.url = url;
      win.setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new win.Event("open"));
      }, 0);
    }
    send(data: string): void {
      if (!this.first) return;
      this.first = false;
      const message = JSON.parse(String(data)) as { type: string; chatId?: string; request?: { profile?: string } };
      let chat: Record<string, unknown> | undefined;
      if (message.type === "attach") chat = chats.find((item) => item.chatId === message.chatId);
      else if (message.request?.profile === "aia") chat = chats.find((item) => item.profile === "aia");
      if (!chat) chat = chats[0];
      handles.__gallerySockets[String(chat.chatId)] = this;
      win.setTimeout(() => {
        this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "state", session: chat }) }));
      }, 0);
    }
    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new win.CloseEvent("close"));
    }
  }
  win.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args: [string, ...unknown[]]) {
      if (String(args[0]).includes("/api/chat")) return new FakeChatSocket(args[0]);
      return new (target as unknown as new (...rest: unknown[]) => WebSocket)(...args);
    },
  }) as typeof WebSocket;
}

function emit(chatId: string, events: object[]) {
  cy.window().its(`__gallerySockets.${chatId}`).should("exist");
  cy.window().then((win) => {
    const socket = (win as unknown as GalleryHandles).__gallerySockets[chatId];
    for (const event of events) socket.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
  });
}

function blurFocus() {
  cy.document().then((doc) => (doc.activeElement as HTMLElement | null)?.blur?.());
}

const delta = (id: string, text: string) => ({ type: "messageDelta", id, role: "assistant", kind: "text", delta: text });

const CHAT_EVENTS: object[] = [
  { type: "turn", id: "turn-1", status: "started", timestamp: NOW - 20 * MIN },
  { type: "userInput", id: "u-1", text: tr("프로젝트 형상관리 탭에 스태시 목록을 추가하고 싶어. 먼저 현재 테스트가 통과하는지 확인해 줘.", "I want to add a stash list to the project Git tab. First check that the current tests pass."), attachments: [] },
  { type: "tool", id: "tool-read", name: "Read", status: "completed", detail: "src/components/ProjectGitView.tsx", output: "  1 import { useEffect, useState } from \"react\";\n  2 import { getProjectGitOverview } from \"../lib/ipcProjects\";\n  ... (412 lines)", append: false },
  { type: "tool", id: "tool-test", name: "Bash", status: "completed", detail: "npm test -- --reporter=dot", output: "> agent-manager@0.3.0 test\n> node --test src/lib/*.test.mjs\n\n..........................................\n\n✔ tests 418  ✔ pass 418  ✖ fail 0\nduration_ms 612", append: false },
  delta("a-1", [
    tr("테스트 **418건이 모두 통과**했습니다. 스태시 목록은 다음 순서로 붙이면 됩니다.", "All **418 tests pass**. Here is how I would add the stash list:"),
    "",
    tr("### 계획", "### Plan"),
    tr("1. `project_git.rs`에 `stash list --format` 읽기 추가", "1. Add a `stash list --format` read to `project_git.rs`"),
    tr("2. `ProjectGitView`에 스태시 패널과 적용·삭제 버튼", "2. A stash panel with Apply and Drop buttons in `ProjectGitView`"),
    tr("3. 삭제 영수증에 `droppedStashSha`를 남겨 복구 가능하게 유지", "3. Keep drops recoverable by recording `droppedStashSha` on the receipt"),
    "",
    "```ts",
    "export interface GitStashEntry {",
    "  index: number;",
    "  sha: string;",
    "  message: string;",
    "  createdAt: number;",
    "}",
    "```",
  ].join("\n")),
  { type: "turn", id: "turn-1", status: "completed", timestamp: NOW - 19 * MIN },
  { type: "turn", id: "turn-2", status: "started", timestamp: NOW - 6 * MIN },
  { type: "userInput", id: "u-2", text: tr("좋아, 그 계획대로 진행해 줘.", "Sounds good, go ahead with that plan."), attachments: [] },
  { type: "tool", id: "tool-edit", name: "Edit", status: "completed", detail: "src/components/ProjectGitView.tsx", output: "+ <GitStashPanel entries={overview.stashes} onApply={applyStash} onDrop={dropStash} />", append: false },
  { type: "tool", id: "tool-test-2", name: "Bash", status: "completed", detail: "cargo test -q -p agent-manager-core --lib project_git::", output: "running 24 tests\n........................\ntest result: ok. 24 passed; 0 failed; 0 ignored", append: false },
  delta("a-2", tr([
    "스태시 패널을 추가했고 `project_git::` 테스트 24건이 통과했습니다.",
    "",
    "- 목록은 최신순, 메시지와 생성 시각 표시",
    "- **적용**은 `stash apply`, **삭제**는 확인 뒤 `stash drop`",
    "- 삭제한 항목의 SHA는 영수증에 남아 `git stash apply <sha>`로 되살릴 수 있습니다",
  ], [
    "Added the stash panel, and all 24 `project_git::` tests pass.",
    "",
    "- Newest first, with message and creation time",
    "- **Apply** runs `stash apply`; **Drop** runs `stash drop` after a confirmation",
    "- A dropped entry's SHA stays on the receipt, so `git stash apply <sha>` brings it back",
  ]).join("\n")),
  { type: "turn", id: "turn-2", status: "completed", timestamp: NOW - 5 * MIN },
];

// ---------------------------------------------------------------------------
// 알림

function attention(id: string, kind: string, title: string, minutesAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    chatId: `chat-${id}`,
    source: "claude",
    providerSessionId: null,
    cwd: "/workspace/agent-manager",
    resuming: false,
    unattended: false,
    profile: "standard",
    origin: null,
    kind,
    title,
    detail: null,
    approvalId: null,
    preview: null,
    createdAt: NOW - minutesAgo * MIN,
    read: false,
    ...overrides,
  };
}

const ATTENTION = {
  items: [
    attention("n-approval", "approval", tr("실행 승인을 기다립니다", "Waiting for approval"), 1, { source: "codex", cwd: "/workspace/payments-api", approvalId: "apv-1", detail: "Bash · npm run build" }),
    attention("n-done", "completed", tr("작업이 끝났습니다", "Task finished"), 4, { chatId: "chat-main" }),
    attention("n-failed", "failed", tr("작업이 실패했습니다", "Task failed"), 26, { source: "antigravity", cwd: "/workspace/mobile-app", detail: tr("빌드 단계에서 타입 오류 3건", "3 type errors in the build step") }),
    attention("n-pacing", "pacingSuggestion", tr("페이싱 제안", "Pacing suggestion"), 48, { source: "codex", chatId: "", cwd: "", detail: tr("Codex 메인 7일 창이 74%입니다. 남은 회차를 Codex 팀으로 넘기면 주간 한도 안에서 끝납니다.", "Codex Main is at 74% of its 7-day window. Moving the remaining rounds to Codex Team finishes them within the weekly limit.") }),
    attention("n-done-2", "completed", tr("작업이 끝났습니다", "Task finished"), 95, { source: "local", cwd: "/workspace/docs-site", read: true }),
  ],
  unreadCount: 4,
  pendingCount: 1,
};

// ---------------------------------------------------------------------------

describe("gallery a", () => {
  before(() => { widenHeadlessWindow(); applyGalleryLanguage(); });
  beforeEach(() => {
    cy.viewport(1440, 900);
    stubWorkspace();
    cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: ATTENTION });
  });

  it("sessions", () => {
    visitDark();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", RELEASE_SESSION.title).should("exist");
    blurFocus();
    shoot("sessions");
  });

  it("session-transcript", () => {
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    visitDark();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", RELEASE_SESSION.title).click();
    cy.wait("@detail");
    cy.get(`[role="tablist"][aria-label="${tr("세션 상세 보기", "Session details")}"]`).contains('[role="tab"]', tr("대화", "Conversation")).click();
    cy.get(".turn-activity-toggle").first().click();
    cy.contains(tr("주요 변화", "Highlights")).should("exist");
    cy.contains(tr("v0.2.0 태그 이후 커밋을", "Go through the commits since")).scrollIntoView({ offset: { top: -100, left: 0 } });
    blurFocus();
    shoot("session-transcript");
  });

  it("chat", () => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: LIVE_CHATS });
    visitDark({}, fakeChatSockets(LIVE_CHATS));
    cy.openView("chat");
    cy.get(".chat-runtime-list-item").first().click();
    emit("chat-main", CHAT_EVENTS);
    cy.contains(tr("스태시 패널을 추가했고", "Added the stash panel")).should("exist");
    cy.get(".turn-activity-toggle").first().click();
    cy.contains("details.chat-tool summary", "npm test").click();
    blurFocus();
    cy.contains(tr("프로젝트 형상관리 탭에 스태시 목록을", "I want to add a stash list")).scrollIntoView({ offset: { top: -40, left: 0 } });
    shoot("chat");
  });

  it("chat-approval", () => {
    const chats = [chatInfo({ state: "waitingApproval", lastTurnStatus: "started" }), ...LIVE_CHATS.slice(1)];
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: chats });
    visitDark({}, fakeChatSockets(chats));
    cy.openView("chat");
    cy.get(".chat-runtime-list-item").first().click();
    emit("chat-main", [
      ...CHAT_EVENTS,
      { type: "turn", id: "turn-3", status: "started", timestamp: NOW - 1 * MIN },
      { type: "userInput", id: "u-3", text: tr("브랜치를 원격에 올려서 PR 만들 준비해 줘.", "Push the branch and get it ready for a pull request."), attachments: [] },
      { type: "tool", id: "tool-status", name: "Bash", status: "completed", detail: "git status --short --branch", output: "## feature/git-stash-panel\n M crates/agent-manager-core/src/project_git.rs\n M src/components/ProjectGitView.tsx", append: false },
      {
        type: "approval",
        id: "approval-push",
        kind: "permission",
        title: tr("Claude 권한 확인 · Bash", "Claude permission request · Bash"),
        detail: JSON.stringify({ tool: "Bash", description: "Push the feature branch to origin", input: { command: "git push -u origin feature/git-stash-panel" } }, null, 2),
        options: ["accept", "acceptForSession", "decline", "cancel"],
        interactive: true,
      },
    ]);
    cy.get(".chat-approval").should("exist");
    shoot("chat-approval");
  });

  it("chat-plan", () => {
    const chats = [chatInfo({ mode: "plan", state: "waitingApproval", lastTurnStatus: "started" }), ...LIVE_CHATS.slice(1)];
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: chats });
    visitDark({}, fakeChatSockets(chats));
    cy.openView("chat");
    cy.get(".chat-runtime-list-item").first().click();
    emit("chat-main", [
      { type: "turn", id: "turn-p", status: "started", timestamp: NOW - 2 * MIN },
      { type: "userInput", id: "u-p", text: tr("결제 웹훅 재시도 간격을 지수 백오프로 바꾸는 계획을 세워 줘. 코드는 아직 건드리지 마.", "Plan how to switch payment webhook retries to exponential backoff. Don't touch the code yet."), attachments: [] },
      { type: "tool", id: "tool-grep", name: "Grep", status: "completed", detail: "retryDelay", output: "src/webhooks/dispatcher.ts:42:  const retryDelay = 30_000;\nsrc/webhooks/dispatcher.test.ts:18:  expect(retryDelay).toBe(30_000);", append: false },
      { type: "tool", id: "tool-read-p", name: "Read", status: "completed", detail: "src/webhooks/dispatcher.ts", output: "export async function dispatch(event: WebhookEvent) { ... }", append: false },
      {
        type: "approval",
        id: "approval-plan",
        kind: "plan",
        title: tr("Claude 실행 계획 검토", "Review Claude's plan"),
        detail: tr([
          "## 웹훅 재시도 지수 백오프",
          "",
          "1. `dispatcher.ts`의 고정 지연(30초)을 `backoff(attempt)`로 교체 — 기본 5초, 배수 2, 상한 15분",
          "2. 지터(±20%)를 넣어 동시 재시도가 한꺼번에 몰리지 않게 한다",
          "3. 최대 8회 뒤에는 `dead_letter` 큐로 넘기고 알림을 남긴다",
          "4. `dispatcher.test.ts`에 시도 횟수별 지연과 상한 테스트 추가",
        ], [
          "## Exponential backoff for webhook retries",
          "",
          "1. Replace the fixed 30s delay in `dispatcher.ts` with `backoff(attempt)` — base 5s, factor 2, capped at 15 min",
          "2. Add ±20% jitter so simultaneous retries don't arrive in a burst",
          "3. After 8 attempts, move the event to the `dead_letter` queue and raise a notification",
          "4. Add tests in `dispatcher.test.ts` for per-attempt delays and the cap",
        ]).join("\n"),
        options: ["accept", "acceptForSession", "acceptAll", "decline", "cancel"],
        interactive: true,
      },
    ]);
    cy.get(".chat-approval").should("exist");
    shoot("chat-plan");
  });

  it("aia", () => {
    cy.stubInvoke("get_system_automation_snapshot", (req) => {
      req.continue((res) => {
        res.body.settings.systemProvider = "codex";
        res.body.settings.catalogAutoDiscovery = false;
      });
    });
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [AIA_CHAT] });
    cy.stubInvoke("get_aia_suggestion_catalog", {
      statusCode: 200,
      body: { contentDigest: "gallery", packs: [], definitions: [], issues: [], bundledSkill: { key: "aia-suggestions", name: tr("AIA 선제 제안 팩", "AIA suggestion pack"), description: "", files: [], installed: true } },
    });
    visitDark({}, fakeChatSockets([AIA_CHAT]));
    cy.openView("dashboard");
    cy.anchor("topbar.aia").click();
    cy.get(".aia-chat-popup.open").should("exist");
    emit("chat-aia", [
      { type: "turn", id: "aia-1", status: "started", timestamp: NOW - 3 * MIN },
      { type: "userInput", id: "aia-u1", text: tr("이번 주 Codex 사용량이 얼마나 남았어? 주간 보고서 일정도 확인해 줘.", "How much Codex usage is left this week? Also check the weekly report schedule."), attachments: [] },
      { type: "tool", id: "aia-t1", name: "get_provider_accounts", status: "completed", detail: "aia_system", output: "2 accounts", append: false },
      { type: "tool", id: "aia-t2", name: "get_scheduler_snapshot", status: "completed", detail: "aia_system", output: "6 schedules", append: false },
      delta("aia-a1", tr([
        "**Codex 사용량**",
        "- Codex 메인: 7일 창 74% 사용, 약 40시간 뒤 초기화",
        "- Codex 팀: 7일 창 33% 사용",
        "",
        "**주간 작업 보고서** 일정은 금요일 17:00에 Claude로 실행됩니다. 메인 계정 여유가 적으니 이번 주 Codex 회차는 팀 계정으로 돌리는 것을 권합니다.",
      ], [
        "**Codex usage**",
        "- Codex Main: 74% of the 7-day window used, resets in about 40 hours",
        "- Codex Team: 33% of the 7-day window used",
        "",
        "The **Weekly work report** schedule runs on Claude every Friday at 17:00. Codex Main has little headroom left, so I suggest running this week's Codex rounds on the team account.",
      ]).join("\n")),
      { type: "turn", id: "aia-1", status: "completed", timestamp: NOW - 2 * MIN },
    ]);
    cy.contains(".aia-chat-popup", tr("주간 작업 보고서", "Weekly work report")).should("exist");
    shoot("aia");
  });

  it("notifications", () => {
    visitDark();
    cy.openView("dashboard");
    cy.anchor("topbar.attention").click();
    cy.get(".attention-popover").should("exist");
    shoot("notifications");
  });
});
