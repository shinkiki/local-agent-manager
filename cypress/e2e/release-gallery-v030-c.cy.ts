/// <reference types="cypress" />
import { applyGalleryLanguage, shoot, stubWorkspace, tr, visitDark, widenHeadlessWindow, NOW, MIN, HOUR, DAY, SCHEDULES, RUNS, run, schedule } from "../support/releaseGalleryFixtures";
import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";
import { gitBranch, gitCommit, gitEntry, gitRepository, gitOverview, gitStatus, gitDiff, gitLog, gitCommitFiles, stubGitReads } from "../support/gitFixtures";
import { workflowSummary, workflowDetail, WORKFLOW_LIMITS } from "../support/workflowFixtures";
import { pacingAccount, pacingAccountOverview, pacingConsumer, usageBudget } from "../support/usageBudgetFixtures";

// ---------------------------------------------------------------------------
// 프로젝트 (파일·형상관리)

const AM = "/workspace/agent-manager";
const GC_PROJECTS = [
  projectEntry("agent-manager", { path: AM, sessionCount: 164, providers: ["claude", "codex", "local"], updatedAt: NOW - 3 * MIN }),
  projectEntry("payments-api", { path: "/workspace/payments-api", sessionCount: 118, providers: ["claude", "codex"], updatedAt: NOW - 38 * MIN }),
  projectEntry("mobile-app", { path: "/workspace/mobile-app", sessionCount: 91, providers: ["codex", "antigravity"], updatedAt: NOW - 55 * MIN }),
  projectEntry("docs-site", { path: "/workspace/docs-site", sessionCount: 57, providers: ["claude", "local"], updatedAt: NOW - 130 * MIN }),
  projectEntry("infra-terraform", { path: "/workspace/infra-terraform", sessionCount: 29, providers: ["codex"], updatedAt: NOW - 2 * DAY }),
  projectEntry("design-system", { path: "/workspace/design-system", sessionCount: 17, providers: ["claude"], updatedAt: NOW - 4 * DAY }),
];

type Entry = { name: string; relativePath: string; parentPath: string; sizeBytes: number; modifiedAt: number; isDirectory: boolean; previewKind: string | null };
function fe(name: string, parentPath: string, kind: string | null, size = 2_400, minutesAgo = 90): Entry {
  return {
    name,
    relativePath: parentPath ? `${parentPath}/${name}` : name,
    parentPath,
    sizeBytes: kind === null ? 0 : size,
    modifiedAt: NOW - minutesAgo * MIN,
    isDirectory: kind === null,
    previewKind: kind,
  };
}
const dir = (name: string, parent: string, minutesAgo = 60) => fe(name, parent, null, 0, minutesAgo);

const GC_TREE: Record<string, Entry[]> = {
  "": [
    dir(".github", "", 3_000),
    dir("crates", "", 14),
    dir("cypress", "", 40),
    dir("docs", "", 200),
    dir("scripts", "", 900),
    dir("src", "", 3),
    dir("src-tauri", "", 1_200),
    fe(".gitignore", "", "text", 612, 20_000),
    fe("AGENTS.md", "", "markdown", 18_400, 300),
    fe("Cargo.lock", "", "text", 142_000, 1_400),
    fe("Cargo.toml", "", "text", 1_180, 1_400),
    fe("LICENSE", "", "text", 1_070, 90_000),
    fe("README.md", "", "markdown", 7_900, 25),
    fe("package.json", "", "text", 2_310, 180),
    fe("tsconfig.json", "", "text", 640, 20_000),
    fe("vite.config.ts", "", "text", 1_020, 8_000),
  ],
  src: [
    dir("components", "src", 3),
    dir("lib", "src", 14),
    dir("styles", "src", 260),
    fe("App.tsx", "src", "text", 21_300, 50),
    fe("main.tsx", "src", "text", 820, 12_000),
    fe("types.ts", "src", "text", 96_400, 14),
  ],
  crates: [dir("agent-manager-core", "crates", 14), dir("agent-manager-server", "crates", 300)],
};

const README = [
  "# Agent Manager",
  "",
  "One desktop app to run, resume and supervise **Claude Code**, **Codex**, **Antigravity** and local models side by side.",
  "",
  "## Highlights",
  "",
  "- Unified session catalog across every provider and account",
  "- Per-account credential isolation for parallel runs",
  "- Recurring requests and usage-paced rounds",
  "- Project view with files and a git panel",
  "- Remote access over a loopback backend",
  "",
  "## Getting started",
  "",
  "```sh",
  "npm install",
  "npm run tauri dev",
  "```",
  "",
  "## Layout",
  "",
  "| Path | Owns |",
  "| --- | --- |",
  "| `src/` | UI rendering and typed IPC calls |",
  "| `src-tauri/` | windows, dialogs, packaging |",
  "| `crates/agent-manager-core/` | domain logic, providers, indexing |",
  "| `crates/agent-manager-server/` | loopback HTTP/WebSocket backend |",
  "",
].join("\n");

function stubProjectFiles(): void {
  cy.stubInvoke("list_project_entries", (req) => {
    const parent = ((req.body as { request: { parentPath?: string } }).request.parentPath) ?? "";
    const entries = GC_TREE[parent] ?? [];
    req.reply({ entries, nextCursor: null, total: entries.length });
  });
  cy.stubInvoke("read_project_file", (req) => {
    const { projectPath, relativePath } = (req.body as { request: { projectPath: string; relativePath: string } }).request;
    const base = { projectPath, relativePath, sizeBytes: 7_900, modifiedAt: NOW - 25 * MIN };
    req.reply(relativePath.endsWith(".md") ? { ...base, kind: "markdown", content: README } : { ...base, kind: "text", content: "{}\n" });
  });
}

const SHA = (s: string) => `${s}${"0".repeat(40 - s.length)}`;
const sec = (minutesAgo: number) => Math.floor((NOW - minutesAgo * MIN) / 1000);
const HEAD = { branch: "feature/release-0.3", detached: false, unborn: false, sha: SHA("4f1c9a2"), shortSha: "4f1c9a2" };
const UPSTREAM = { name: "origin/feature/release-0.3", ahead: 2, behind: 1, gone: false };

const GC_REPO = gitRepository({
  repositoryRoot: AM,
  gitDir: `${AM}/.git`,
  head: HEAD,
  upstream: UPSTREAM,
  localBranches: [
    gitBranch("feature/release-0.3", { isHead: true, sha: SHA("4f1c9a2"), upstream: "origin/feature/release-0.3", ahead: 2, behind: 1, committedAt: sec(12), subject: tr("feat(projects): 스태시 목록과 적용·버리기 버튼", "feat(projects): stash list with apply and drop buttons") }),
    gitBranch("main", { sha: SHA("a81e03d"), upstream: "origin/main", committedAt: sec(2 * 1440), subject: "chore(release): v0.2.4" }),
    gitBranch("fix/schedule-timezone", { sha: SHA("c07b5e1"), upstream: "origin/fix/schedule-timezone", ahead: 1, committedAt: sec(1_900), subject: tr("fix(scheduler): 서머타임 경계에서 다음 실행 계산", "fix(scheduler): next-run calculation across DST boundaries") }),
    gitBranch("docs/remote-access", { sha: SHA("9d24f60"), committedAt: sec(5 * 1440), subject: tr("docs: 원격 접속 설정 안내 보강", "docs: expand the remote access setup guide") }),
  ],
  remoteBranches: [
    gitBranch("origin/main", { sha: SHA("a81e03d"), committedAt: sec(2 * 1440), subject: "chore(release): v0.2.4" }),
    gitBranch("origin/feature/release-0.3", { sha: SHA("e5b7d19"), committedAt: sec(45), subject: tr("test(e2e): 형상관리 탭 시나리오", "test(e2e): git tab scenarios") }),
  ],
  remotes: [{ name: "origin", url: "https://github.com/example/agent-manager.git", auth: { transport: "https", host: "github.com", method: "token", tokenSecret: "GITHUB_TOKEN" } }],
  worktrees: [{ path: AM, head: SHA("4f1c9a2"), branch: "feature/release-0.3", detached: false, bare: false, locked: false, prunable: false, isCurrent: true }],
  stashes: [
    { index: 0, sha: SHA("77ab310"), message: tr("On feature/release-0.3: 대시보드 차트 색상 실험", "On feature/release-0.3: dashboard chart color experiment"), createdAt: sec(180) },
    { index: 1, sha: SHA("1be94c2"), message: tr("WIP on main: README 스크린샷 교체", "WIP on main: replace README screenshots"), createdAt: sec(3 * 1440) },
  ],
});

const GC_STATUS_ENTRIES = [
  gitEntry("src/components/ProjectGitPanel.tsx", { indexStatus: "modified" }),
  gitEntry("src/lib/ipcProjects.ts", { indexStatus: "modified" }),
  gitEntry("crates/agent-manager-core/src/project_git.rs", { indexStatus: "modified", worktreeStatus: "modified" }),
  gitEntry("src/styles/projects.css", { worktreeStatus: "modified" }),
  gitEntry("README.md", { worktreeStatus: "modified" }),
  gitEntry("docs/releases/v0.3.0.md", { indexStatus: "untracked", worktreeStatus: "untracked" }),
  gitEntry("cypress/e2e/projects-git-stash.cy.ts", { indexStatus: "untracked", worktreeStatus: "untracked" }),
];

function gcStatus() {
  return { ...gitStatus(GC_STATUS_ENTRIES), projectPath: AM, head: HEAD, upstream: UPSTREAM };
}

const AUTHOR = { authorName: "Dev Team", authorEmail: "dev@example.com", committerName: "Dev Team" };
const GC_COMMITS = [
  gitCommit("4f1c9a2", tr("feat(projects): 스태시 목록과 적용·버리기 버튼", "feat(projects): stash list with apply and drop buttons"), { ...AUTHOR, authoredAt: sec(12), committedAt: sec(12), refs: ["HEAD -> feature/release-0.3"] }),
  gitCommit("b3d80e7", tr("fix(git): 첫 커밋 전 저장소에서 스테이지 해제가 실패하던 문제", "fix(git): unstaging failed in a repository with no commits yet"), { ...AUTHOR, authoredAt: sec(28), committedAt: sec(28) }),
  gitCommit("e5b7d19", tr("test(e2e): 형상관리 탭 시나리오", "test(e2e): git tab scenarios"), { ...AUTHOR, authoredAt: sec(45), committedAt: sec(45), refs: ["origin/feature/release-0.3"] }),
  gitCommit("2a6f4c8", tr("feat(projects): 파일 탭 트리와 읽기 전용 미리보기", "feat(projects): files tab tree with read-only preview"), { ...AUTHOR, authoredAt: sec(26 * 60), committedAt: sec(26 * 60) }),
  gitCommit("8c1d5e3", tr("refactor(core): git 실행을 project_git 모듈로 모음", "refactor(core): move git execution into the project_git module"), { ...AUTHOR, authoredAt: sec(30 * 60), committedAt: sec(30 * 60) }),
  gitCommit("d49a7b0", tr("feat(pacing): 회차 스프린트와 완료조건", "feat(pacing): round sprints and completion conditions"), { ...AUTHOR, authoredAt: sec(2 * 1440 - 60), committedAt: sec(2 * 1440 - 60) }),
  gitCommit("a81e03d", "chore(release): v0.2.4", { ...AUTHOR, authoredAt: sec(2 * 1440), committedAt: sec(2 * 1440), refs: ["tag: v0.2.4", "origin/main", "main"] }),
  gitCommit("f02c6b9", tr("fix(chat): 승인 카드가 만료 후에도 남던 문제", "fix(chat): approval cards lingered after expiry"), { ...AUTHOR, authoredAt: sec(3 * 1440), committedAt: sec(3 * 1440) }),
];

const TS_PATCH = [
  "diff --git a/src/lib/ipcProjects.ts b/src/lib/ipcProjects.ts",
  "index 3c1e2a9..8f04b71 100644",
  "--- a/src/lib/ipcProjects.ts",
  "+++ b/src/lib/ipcProjects.ts",
  "@@ -78,12 +78,24 @@ export function switchProjectGitBranch(request: ProjectGitSwitchRequest): Promise<GitActionReceipt> {",
  "   return call<GitActionReceipt>(\"switch_project_git_branch\", { request });",
  " }",
  " ",
  "-export function stashProjectGit(request: ProjectGitStashRequest): Promise<GitActionReceipt> {",
  "-  return call<GitActionReceipt>(\"stash_project_git\", { request });",
  "+/**",
  tr("+ * 스태시 push·pop·apply·drop. drop은 버린 커밋 SHA를 영수증에 싣는다(C16-6) —", "+ * Stash push/pop/apply/drop. A drop records the discarded commit SHA on the receipt (C16-6) —"),
  tr("+ * 화면은 그 값으로 되살리는 명령을 안내한다.", "+ * the UI uses it to show the command that restores the entry."),
  "+ */",
  "+export function stashProjectGit(request: ProjectGitStashRequest): Promise<GitActionReceipt> {",
  "+  if (request.action !== \"push\" && request.expectedSha === undefined) {",
  "+    return Promise.reject(new Error(\"stash entry requires expectedSha\"));",
  "+  }",
  "+  return call<GitActionReceipt>(\"stash_project_git\", { request });",
  " }",
  " ",
  "+export function listProjectGitStashes(projectPath: string): Promise<GitStashEntry[]> {",
  "+  return call<GitStashEntry[]>(\"list_project_git_stashes\", { projectPath });",
  "+}",
  "+",
  " export function rebaseProjectGit(request: ProjectGitRebaseRequest): Promise<GitActionReceipt> {",
  "   return call<GitActionReceipt>(\"rebase_project_git\", { request });",
  " }",
  "",
].join("\n");

function stubGitWorkspace(): void {
  stubProjectRegistry(GC_PROJECTS);
  stubGitReads({
    overview: gitOverview({ projectPath: AM, repository: GC_REPO }),
    status: gcStatus() as ReturnType<typeof gitStatus>,
    diff: gitDiff({ projectPath: AM, path: "src/lib/ipcProjects.ts", staged: true, patch: TS_PATCH }),
    log: (skip: number) => ({ ...gitLog(skip === 0 ? GC_COMMITS : [], false), projectPath: AM }),
  });
  cy.stubInvoke("get_project_git_commit_files", {
    ...gitCommitFiles("4f1c9a2", [
      { path: "src/components/ProjectGitPanel.tsx", originalPath: null, status: "modified" },
      { path: "src/lib/ipcProjects.ts", originalPath: null, status: "modified" },
      { path: "src/components/GitStashList.tsx", originalPath: null, status: "added" },
      { path: "crates/agent-manager-core/src/project_git.rs", originalPath: null, status: "modified" },
      { path: "src/styles/projects.css", originalPath: "src/styles/git.css", status: "renamed" },
    ]),
    projectPath: AM,
  });
}

// ---------------------------------------------------------------------------
// 워크플로·페이싱

const WF_ROUND = workflowSummary({
  id: "refactor-round",
  displayName: tr("리팩토링 회차", "Refactoring round"),
  description: tr("동작을 바꾸지 않는 구조 개선을 회차당 한 주제만 골라 검증·커밋까지 끝낸다.", "Picks one behavior-preserving structural improvement per round and carries it through verification and commit."),
  version: 4,
  risk: "mutating",
  computedRisk: "mutating",
  contractDigest: "9f2c41ab77e0d3c5",
  requiredOperations: ["start_chat"],
  inputSchema: {
    projectPath: { type: "string", required: true, label: tr("대상 저장소", "Target repository"), defaultValue: `${AM}` },
    focus: { type: "enum", required: false, label: tr("우선 영역", "Focus area"), values: ["frontend", "core", "server", "any"], defaultValue: "any" },
  },
  pacingCapable: true,
  pacingEnabled: true,
});

const WF_QA = workflowSummary({
  id: "qa-round",
  displayName: tr("QA 회차", "QA round"),
  description: tr("신규 테스트 패턴 1건을 격리 E2E로 수행하고 오류 티켓 1건을 바로 고친다.", "Runs one new test pattern as an isolated E2E and fixes one bug ticket right away."),
  version: 2,
  contractDigest: "41be09c2aa1f7d60",
  requiredOperations: ["start_chat"],
  pacingCapable: true,
  pacingEnabled: true,
});

const WF_DEPS = workflowSummary({
  id: "dependency-report",
  displayName: tr("의존성 점검 보고", "Dependency check report"),
  description: tr("등록된 프로젝트의 의존성 경고를 모아 한 장의 보고서로 정리한다.", "Collects dependency warnings across registered projects into a one-page report."),
  version: 3,
  risk: "readOnly",
  computedRisk: "readOnly",
  contractDigest: "c0de5a1b2e3f4071",
  requiredOperations: ["get_project_registry", "start_chat"],
});

const WF_CLEAN = workflowSummary({
  id: "session-tidy",
  displayName: tr("오래된 세션 정리", "Tidy old sessions"),
  description: tr("30일 넘은 세션을 폴더별로 정리하고 숨김 후보를 제안한다.", "Sorts sessions older than 30 days into folders and suggests ones to hide."),
  version: 1,
  contractDigest: "77aa01bc3de45f98",
  requiredOperations: ["list_sessions", "set_session_folder"],
});

const WF_DOCS = workflowSummary({
  id: "release-notes",
  displayName: tr("릴리스 노트 초안", "Release notes draft"),
  description: tr("마지막 태그 이후 커밋을 읽어 한국어·영어 릴리스 노트 초안을 쓴다.", "Reads commits since the last tag and drafts release notes in Korean and English."),
  version: 2,
  risk: "readOnly",
  computedRisk: "readOnly",
  contractDigest: "5b6c7d8e9f001122",
  requiredOperations: ["start_chat"],
});

function execution(minutesAgo: number, version: number, succeeded = true) {
  return {
    executionId: `exec-${minutesAgo}`,
    version,
    startedAt: NOW - minutesAgo * MIN,
    finishedAt: NOW - (minutesAgo - 7) * MIN,
    succeeded,
    failedStepId: null,
    stepStatuses: [{ stepId: "s01", status: "succeeded", iterations: 1 }],
  };
}

const WF_LIST = [
  { ...WF_ROUND, paced: true, pacingMode: "envelope", requiredSkills: ["agent-manager-refactor-round"], missingSkills: [], lastExecution: execution(34, 4) },
  { ...WF_QA, paced: true, pacingMode: "envelope", requiredSkills: ["agent-manager-qa"], missingSkills: [], lastExecution: execution(120, 2) },
  { ...WF_DEPS, lastExecution: execution(1_400, 3) },
  { ...WF_DOCS, lastExecution: execution(3 * 1440, 2) },
  { ...WF_CLEAN, lastExecution: null },
];

function roundContract(version: number) {
  return {
    id: WF_ROUND.id,
    displayName: WF_ROUND.displayName,
    description: WF_ROUND.description,
    risk: "mutating",
    version,
    paced: true,
    requiredSkills: ["agent-manager-refactor-round"],
    inputSchema: WF_ROUND.inputSchema,
    chatRuntime: { mode: "workspace", approvalMode: "never" },
    steps: [{
      id: "s01",
      operation: "start_chat",
      arguments: {
        request: {
          chat: { source: { $run: "source" }, accountId: { $run: "accountId" }, cwd: { $input: "projectPath" }, model: { $run: "model" } },
          message: { $format: tr("리팩토링 회차 {run.round}: {input.focus} 영역에서 주제 1건", "Refactoring round {run.round}: one topic in the {input.focus} area") },
          idempotencyKey: { $idempotencyKey: true },
        },
      },
      forEach: null,
      condition: null,
      expect: null,
    }],
  };
}

function stubWorkflows(): void {
  cy.stubInvoke("get_system_workflows", { limits: WORKFLOW_LIMITS, workflows: WF_LIST });
  cy.stubInvoke("get_system_workflow", (req) => {
    const id = (req.body as { workflowId?: string }).workflowId;
    const summary = WF_LIST.find((w) => w.id === id) ?? WF_LIST[0];
    const detail = workflowDetail(summary as Parameters<typeof workflowDetail>[0]);
    if (summary.id === WF_ROUND.id) {
      req.reply({
        ...detail,
        contract: roundContract(4),
        versions: [1, 2, 3, 4].map((v) => ({ version: v, registeredAt: NOW - (5 - v) * 6 * DAY, computedRisk: "mutating", requiredOperations: ["start_chat"], contract: roundContract(v) })),
      });
    } else {
      req.reply(detail);
    }
  });
}

function pacedSchedule(id: string, name: string, workflowId: string, nextInMin: number, maxRuns: number, enabled = true) {
  return {
    ...schedule(id, name, "claude", "agent-manager", nextInMin, 0, "auto", enabled),
    recurrence: { frequency: "auto", interval: 1, hour: 0, minute: 0, weekday: 1, cron: null, timezone: "Asia/Seoul" },
    workflow: { workflowId, approvedVersion: workflowId === "refactor-round" ? 4 : 2, arguments: { projectPath: AM }, pacing: { maxRuns } },
  };
}

const PACED_SCHEDULES = [
  pacedSchedule("round-refactor", tr("리팩토링 회차 · agent-manager", "Refactoring round · agent-manager"), "refactor-round", 18, 3),
  pacedSchedule("round-qa", tr("QA 회차 · agent-manager", "QA round · agent-manager"), "qa-round", 64, 1),
  pacedSchedule("round-docs", tr("문서 번역 회차 · docs-site", "Docs translation round · docs-site"), "refactor-round", 240, 2, false),
];

const STANDUP_PROMPT = [
  tr("어제 오전 9시 이후 agent-manager 저장소의 커밋과 병합된 PR을 읽고 스탠드업 메모를 써 줘.", "Read the commits and merged PRs in the agent-manager repository since 9 AM yesterday and write a stand-up note."),
  tr("- 완료한 일 / 진행 중인 일 / 막힌 일 세 칸으로 나눈다", "- Split it into three columns: done / in progress / blocked"),
  tr("- 커밋 해시는 짧게, 사람 이름 대신 영역(core·ui·server)으로 묶는다", "- Use short commit hashes and group by area (core, ui, server) rather than by person"),
  tr("- 결과는 docs/standup/ 아래 날짜 파일로 남긴다", "- Save the result as a dated file under docs/standup/"),
].join("\n");

const ACCOUNT_BY_SOURCE: Record<string, string | null> = { claude: "acc-claude-work", codex: "acc-codex-main", antigravity: "ag-pro", local: null };

/** 기본 실행 기록을 공급자에 맞는 계정으로 고치고, 이전 실행과 지금 도는 실행을 덧댄다. */
function scheduleRuns() {
  const base = [
    { ...run("run-10", "sch-i18n", 4, "running"), summary: null },
    ...RUNS,
    run("run-6", "sch-deps", 2_838, "completed"),
    run("run-7", "sch-deps", 4_278, "completed"),
    run("run-8", "sch-standup", 2_785, "completed"),
    run("run-9", "sch-docs", 2_570, "completed"),
    run("run-11", "sch-flaky", 11_000, "completed"),
  ];
  return base.map((item) => {
    const source = [...SCHEDULES, ...PACED_SCHEDULES].find((entry) => entry.id === item.scheduleId)?.source ?? "codex";
    const accountId = ACCOUNT_BY_SOURCE[source];
    return { ...item, requestedAccountId: accountId, actualAccountId: accountId };
  });
}

function stubPacedScheduler(): void {
  const runs = [
    ...scheduleRuns(),
    { ...run("run-r1", "round-refactor", 34, "completed"), summary: tr("회차 12 — chat.rs 승인 경로 분리, 테스트 461건 통과, 커밋 3건", "Round 12 — split the chat.rs approval path, 461 tests pass, 3 commits") },
    { ...run("run-r2", "round-refactor", 5, "running"), summary: null },
    { ...run("run-q1", "round-qa", 120, "completed"), summary: tr("QA #88 등록 — 스케줄 편집기 시간대 전환 시나리오", "QA #88 filed — schedule editor time-zone switch scenario") },
  ];
  const schedules = [...SCHEDULES, ...PACED_SCHEDULES].map((item) => (item.id === "sch-standup" ? { ...item, prompt: STANDUP_PROMPT } : item));
  cy.stubInvoke("get_scheduler_snapshot", { statusCode: 200, body: { paused: false, runnerActive: true, schedules, runs } });
  cy.stubInvoke("get_scheduled_request_detail", (req) => {
    const id = (req.body as { id?: string }).id;
    req.reply({ statusCode: 200, body: schedules.find((item) => item.id === id) ?? schedules[0] });
  });
}

const accountRuns = (accountId: string, provider: string, percentPerRun: number, tokensPerRun: number | null, runs: number) => ({ accountId, provider, percentPerRun, tokensPerRun, runs });

function stubBudget(): void {
  const budget = usageBudget({
    activeConsumers: ["round-refactor", "round-qa"],
    pacingWorkflowIds: ["refactor-round", "qa-round"],
    accounts: [
      pacingAccount({ accountId: "acc-claude-work", email: "dev@example.com", displayName: tr("Claude 업무", "Claude Work"), provider: "claude", pacingEnabled: true, overview: pacingAccountOverview({ usedPercent: 58, targetPercent: 95, resetsAt: NOW + 71 * HOUR }) }),
      pacingAccount({ accountId: "acc-claude-lab", email: "lab@example.com", displayName: tr("Claude 실험", "Claude Lab"), provider: "claude", pacingEnabled: true, overview: pacingAccountOverview({ usedPercent: 27, targetPercent: 95, resetsAt: NOW + 120 * HOUR }) }),
      pacingAccount({ accountId: "acc-codex-main", email: "dev@example.com", displayName: tr("Codex 메인", "Codex Main"), provider: "codex", pacingEnabled: true, overview: pacingAccountOverview({ usedPercent: 74, targetPercent: 90, resetsAt: NOW + 40 * HOUR }) }),
      pacingAccount({ accountId: "acc-codex-team", email: "team@example.com", displayName: tr("Codex 팀", "Codex Team"), provider: "codex", pacingEnabled: true, overview: pacingAccountOverview({ usedPercent: 33, targetPercent: 95, resetsAt: NOW + 96 * HOUR }) }),
      pacingAccount({ accountId: "ag-pro", email: "Gemini Pro", displayName: "Gemini Pro", provider: "antigravity", pacingEnabled: false, overview: pacingAccountOverview({ usedPercent: 46, targetPercent: 95, inPool: false, resetsAt: NOW + 88 * HOUR }) }),
    ],
    consumers: [
      pacingConsumer({
        scheduleId: "round-refactor",
        name: tr("리팩토링 회차 · agent-manager", "Refactoring round · agent-manager"),
        workflowId: "refactor-round",
        priority: 70,
        sprint: false,
        completedRuns: 41,
        completionCondition: tr("리팩토링 백로그 비우기", "Empty the refactoring backlog"),
        completionConditionEnabled: true,
        costs: {
          perProvider: { claude: { percentPerRun: 1.8, observationWeight: 12 }, codex: { percentPerRun: 2.4, observationWeight: 9 } },
          perAccount: [
            accountRuns("acc-claude-work", "claude", 1.9, 182_000, 14),
            accountRuns("acc-claude-lab", "claude", 1.6, 164_000, 8),
            accountRuns("acc-codex-main", "codex", 2.4, null, 11),
            accountRuns("acc-codex-team", "codex", 2.2, null, 8),
          ],
          recordedRuns: 41,
          savings: {},
        },
        nextRun: {
          runs: [
            { accountId: "acc-claude-lab", email: "lab@example.com", provider: "claude", model: "claude-sonnet-4-5", reasoningEffort: "high", reasoningEffortSource: "auto", headroomRunsPerRound: 6.2, count: 2 },
            { accountId: "acc-codex-team", email: "team@example.com", provider: "codex", model: "gpt-5.6-codex", reasoningEffort: "medium", reasoningEffortSource: "auto", headroomRunsPerRound: 3.1, count: 1 },
          ],
          note: null,
        },
      }),
      pacingConsumer({
        scheduleId: "round-qa",
        name: tr("QA 회차 · agent-manager", "QA round · agent-manager"),
        workflowId: "qa-round",
        priority: 50,
        sprint: true,
        completedRuns: 17,
        costs: {
          perProvider: { claude: { percentPerRun: 2.6, observationWeight: 6 } },
          perAccount: [accountRuns("acc-claude-work", "claude", 2.6, 240_000, 17)],
          recordedRuns: 17,
          savings: {},
        },
        nextRun: {
          runs: [{ accountId: "acc-claude-work", email: "dev@example.com", provider: "claude", model: "claude-opus-4-5", reasoningEffort: "high", reasoningEffortSource: "fixed", headroomRunsPerRound: null, count: 1 }],
          note: null,
        },
      }),
      pacingConsumer({ scheduleId: "round-docs", name: tr("문서 번역 회차 · docs-site", "Docs translation round · docs-site"), workflowId: "refactor-round", scheduleEnabled: false, priority: 30, completedRuns: 9 }),
    ],
  });
  cy.stubInvoke("get_usage_budget", budget);
}

/** 선택이 부드럽게 스크롤한 화면을 맨 위로 되돌린다. */
function scrollAncestorsToTop(selector: string): void {
  cy.get(selector).then(($el) => {
    let node: HTMLElement | null = $el[0];
    while (node) {
      if (node.scrollTop > 0) node.scrollTop = 0;
      node = node.parentElement;
    }
  });
}

// ---------------------------------------------------------------------------

describe("gallery c", () => {
  before(() => { widenHeadlessWindow(); applyGalleryLanguage(); });
  beforeEach(() => { cy.viewport(1440, 900); stubWorkspace(); });

  it("projects-files", () => {
    stubProjectRegistry(GC_PROJECTS);
    stubProjectFiles();
    visitDark();
    cy.openProjectsView("files");
    cy.anchor("projects.selector").find("select").should("have.value", AM);
    const row = (name: string) => cy.get(".project-files-layout .tree-row").contains("strong", name).closest(".tree-row");
    row("src").click();
    row("App.tsx").should("exist");
    row("README.md").click();
    cy.get(".project-files-layout .markdown-preview").should("contain.text", "Getting started");
    shoot("projects-files");
  });

  it("projects-git", () => {
    stubGitWorkspace();
    visitDark();
    cy.openProjectsView("git");
    cy.get(".git-panel-shell .git-branch-name").should("contain", "feature/release-0.3");
    cy.get(".git-panel-shell .git-log-row").should("have.length", GC_COMMITS.length);
    cy.get(".git-panel-shell .git-change-group[data-group=\"untracked\"]").should("contain", "docs/releases/v0.3.0.md");
    shoot("projects-git");
  });

  it("projects-git-diff", () => {
    stubGitWorkspace();
    visitDark();
    cy.openProjectsView("git");
    cy.get(".git-panel-shell .git-change-group[data-group=\"staged\"] .git-change-path").contains("src/lib/ipcProjects.ts").click();
    cy.get(".modal .git-diff-modal-body .skill-diff.git-diff .add").should("have.length.greaterThan", 5);
    shoot("projects-git-diff");
  });

  it("projects-git-history", () => {
    stubGitWorkspace();
    visitDark();
    cy.openProjectsView("git");
    cy.get(".git-panel-shell .git-log-row").first().find(".git-log-toggle").click();
    cy.get(".git-panel-shell .git-log-row.expanded .git-commit-file").should("have.length", 5);
    cy.get(".git-panel-shell .git-branch-row").first().scrollIntoView({ offset: { top: -60, left: 0 } });
    shoot("projects-git-history");
  });

  it("workflows", () => {
    stubPacedScheduler();
    stubWorkflows();
    visitDark();
    cy.openView("workflows");
    cy.selectWorkflow(tr("리팩토링 회차", "Refactoring round"));
    cy.anchor("workflows.procedure-diagram").find(".diagram-viewer-canvas svg", { timeout: 20_000 }).should("exist");
    cy.wait(900);
    scrollAncestorsToTop(".workflow-workspace");
    shoot("workflows");
  });

  it("schedules", () => {
    stubPacedScheduler();
    stubWorkflows();
    visitDark();
    cy.openView("chat");
    cy.anchor("chat.tab.schedules").click().should("have.class", "active");
    cy.get(".schedule-card").should("have.length.greaterThan", 4);
    shoot("schedules");
  });

  it("schedule-editor", () => {
    stubPacedScheduler();
    stubWorkflows();
    visitDark();
    cy.openView("chat");
    cy.anchor("chat.tab.schedules").click().should("have.class", "active");
    cy.contains(".schedule-card", tr("어제 커밋으로 스탠드업 요약", "Stand-up summary from yesterday's commits")).contains("button", tr("수정", "Edit")).click();
    cy.get(".schedule-editor").should("be.visible");
    shoot("schedule-editor");
  });

  it("pacing", () => {
    stubPacedScheduler();
    stubWorkflows();
    stubBudget();
    visitDark();
    cy.openPacingTab();
    cy.get(".usage-budget-card").should("have.length.greaterThan", 1);
    shoot("pacing");
  });

  it("pacing-rounds", () => {
    stubPacedScheduler();
    stubWorkflows();
    stubBudget();
    visitDark();
    cy.openPacingTab();
    cy.anchor("workflows.usage-budget").contains("h3, h2, strong", tr("페이싱 회차", "Paced rounds")).scrollIntoView({ offset: { top: -90, left: 0 } });
    shoot("pacing-rounds");
  });
});
