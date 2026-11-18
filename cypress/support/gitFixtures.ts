/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 프로젝트 화면 · 형상관리 탭(ProjectGitPanel)을 보는 스펙이 쓰는 고정값과 조회 스텁.
// 백엔드 계약(`src/types.ts`의 Git*)의 필드를 전부 채운 기본 모양을 여기 한 벌만 두고,
// 스펙은 바꿀 칸만 덮어쓴다. 변경 명령(stage·commit·push·…)은 스펙이 직접 `cy.stubInvoke`로
// 영수증을 세우고 요청 본문을 본다 — 어떤 명령이 어떤 인자로 나가는지가 스펙의 주장이므로
// 여기서 뭉뚱그리지 않는다.
import type {
  GitActionReceipt,
  GitBranch,
  GitBranchComparison,
  GitCommit,
  GitCommitFile,
  GitCommitFiles,
  GitDiff,
  GitLog,
  GitOverview,
  GitRepositoryInfo,
  GitStatus,
  GitStatusEntry,
} from "../../src/types";

export const GIT_PROJECT_PATH = "/tmp/amproj/alpha";

export function gitBranch(name: string, overrides: Partial<GitBranch> = {}): GitBranch {
  return {
    name,
    sha: "0123456789abcdef0123456789abcdef01234567",
    isHead: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    committedAt: 1_758_000_000,
    subject: `${name} 마지막 커밋`,
    ...overrides,
  };
}

export function gitRepository(overrides: Partial<GitRepositoryInfo> = {}): GitRepositoryInfo {
  return {
    repositoryRoot: GIT_PROJECT_PATH,
    gitDir: `${GIT_PROJECT_PATH}/.git`,
    isLinkedWorktree: false,
    head: { branch: "main", detached: false, unborn: false, sha: "0123456789abcdef0123456789abcdef01234567", shortSha: "0123456" },
    upstream: { name: "origin/main", ahead: 1, behind: 2, gone: false },
    localBranches: [
      gitBranch("main", { isHead: true, upstream: "origin/main", ahead: 1, behind: 2 }),
      gitBranch("feature", { sha: "abcdef0123456789abcdef0123456789abcdef01" }),
    ],
    remoteBranches: [gitBranch("origin/main", { sha: "fedcba9876543210fedcba9876543210fedcba98" })],
    branchesTruncated: false,
    remotes: [{ name: "origin", url: "https://example.invalid/alpha.git", auth: { transport: "https", host: "example.invalid", method: "credentialHelper", tokenSecret: null } }],
    worktrees: [{ path: GIT_PROJECT_PATH, head: "0123456789abcdef0123456789abcdef01234567", branch: "main", detached: false, bare: false, locked: false, prunable: false, isCurrent: true }],
    inProgress: null,
    stashes: [{ index: 0, sha: "1111111111111111111111111111111111111111", message: "WIP on main: 작업 중", createdAt: 1_758_000_000 }],
    stashesTruncated: false,
    gitVersion: "2.45.0",
    ...overrides,
  };
}

/** 개요. `repository`를 통째로 바꾸려면 `overrides.repository`, 한 칸만 바꾸려면 `gitRepository({...})`를 넣는다. */
export function gitOverview(overrides: Partial<GitOverview> = {}): GitOverview {
  return {
    projectPath: GIT_PROJECT_PATH,
    repository: gitRepository(),
    unavailableReason: null,
    unavailableDetail: null,
    ...overrides,
  };
}

export function gitEntry(path: string, overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return {
    path,
    originalPath: null,
    indexStatus: "unmodified",
    worktreeStatus: "unmodified",
    isSubmodule: false,
    unmerged: null,
    renameScore: null,
    ...overrides,
  };
}

/** 기본 네 항목: a.ts 인덱스 수정, b.ts 작업 트리 수정, c.txt 추적 안 됨, d.ts 충돌. */
export function gitStatusEntries(): GitStatusEntry[] {
  return [
    gitEntry("a.ts", { indexStatus: "modified" }),
    gitEntry("b.ts", { worktreeStatus: "modified" }),
    gitEntry("c.txt", { indexStatus: "untracked", worktreeStatus: "untracked" }),
    gitEntry("d.ts", { indexStatus: "unmerged", worktreeStatus: "unmerged", unmerged: "UU" }),
  ];
}

export function gitStatus(entries: GitStatusEntry[] = gitStatusEntries()): GitStatus {
  const conflicted = entries.filter((entry) => entry.unmerged !== null);
  const untracked = entries.filter((entry) => entry.unmerged === null && entry.worktreeStatus === "untracked");
  const staged = entries.filter((entry) => entry.unmerged === null && entry.worktreeStatus !== "untracked" && entry.indexStatus !== "unmodified");
  const unstaged = entries.filter((entry) => entry.unmerged === null && entry.worktreeStatus !== "untracked" && entry.worktreeStatus !== "unmodified");
  return {
    projectPath: GIT_PROJECT_PATH,
    head: { branch: "main", detached: false, unborn: false, sha: "0123456789abcdef0123456789abcdef01234567", shortSha: "0123456" },
    upstream: { name: "origin/main", ahead: 1, behind: 2, gone: false },
    entries,
    truncated: false,
    conflictedCount: conflicted.length,
    stagedCount: staged.length,
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
  };
}

export const TWO_HUNK_PATCH = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "@@ -10,2 +10,3 @@",
  " export {};",
  "+export const d = 5;",
  " // end",
  "",
].join("\n");

export function gitDiff(overrides: Partial<GitDiff> = {}): GitDiff {
  return {
    projectPath: GIT_PROJECT_PATH,
    path: "a.ts",
    staged: true,
    kind: "text",
    patch: TWO_HUNK_PATCH,
    truncated: false,
    ...overrides,
  };
}

export function gitCommit(shortSha: string, subject: string, overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    sha: `${shortSha}${"0".repeat(40 - shortSha.length)}`,
    shortSha,
    parents: ["9999999999999999999999999999999999999999"],
    authorName: "tester",
    authorEmail: "tester@example.invalid",
    authoredAt: 1_758_000_000,
    committerName: "tester",
    committedAt: 1_758_000_000,
    refs: [],
    subject,
    body: "",
    ...overrides,
  };
}

/** 커밋 하나가 바꾼 파일 목록. `shortSha`는 `gitCommit`과 같은 규칙으로 40자로 늘린다. */
export function gitCommitFiles(shortSha: string, files: GitCommitFile[]): GitCommitFiles {
  return { projectPath: GIT_PROJECT_PATH, sha: `${shortSha}${"0".repeat(40 - shortSha.length)}`, files, truncated: false };
}

export function gitLog(commits: GitCommit[], hasMore: boolean): GitLog {
  return { projectPath: GIT_PROJECT_PATH, reference: "HEAD", commits, hasMore };
}

/**
 * B6/B8. 현재 브랜치와 upstream의 차이를 방향으로 가른 비교. 기본값은 `gitRepository()`의
 * upstream(`origin/main`, 수신 2 · 송신 1)과 앞뒤가 맞는 모양이다 — 둘이 어긋나면 스펙이
 * 화면에서 읽는 숫자가 어느 쪽에서 왔는지 알 수 없게 된다.
 */
export function gitBranchComparison(overrides: Partial<GitBranchComparison> = {}): GitBranchComparison {
  return {
    projectPath: GIT_PROJECT_PATH,
    branch: "main",
    upstream: "origin/main",
    noUpstream: false,
    incoming: [gitCommit("bbbbbbb", "수신 커밋"), gitCommit("ccccccc", "수신 커밋 2")],
    outgoing: [gitCommit("ddddddd", "송신 커밋")],
    incomingCount: 2,
    outgoingCount: 1,
    incomingTruncated: false,
    outgoingTruncated: false,
    incomingFiles: [{ path: "a.ts", originalPath: null, status: "modified" }],
    outgoingFiles: [{ path: "b.ts", originalPath: null, status: "modified" }],
    incomingFilesTruncated: false,
    outgoingFilesTruncated: false,
    diverged: true,
    lastFetchedAt: 1_758_000_000,
    ...overrides,
  };
}

export function gitReceipt(overrides: Partial<GitActionReceipt> = {}): GitActionReceipt {
  return {
    action: "stage",
    succeeded: true,
    outcome: "completed",
    message: "완료했습니다.",
    headBefore: "0123456789abcdef0123456789abcdef01234567",
    headAfter: "0123456789abcdef0123456789abcdef01234567",
    conflictedFiles: [],
    blockedFiles: [],
    droppedStashSha: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    ...overrides,
  };
}

export interface GitReadStubs {
  overview?: GitOverview;
  status?: GitStatus;
  diff?: GitDiff;
  /** 값이면 매 요청 같은 페이지, 함수면 요청의 `skip`으로 페이지를 고른다. */
  log?: GitLog | ((skip: number) => GitLog);
  comparison?: GitBranchComparison;
}

/**
 * 다섯 조회를 한 번에 세운다. 별칭은 `@gitOverview`·`@gitStatus`·`@gitDiff`·`@gitLog`·
 * `@gitBranchComparison`. 나중에 다시 부르면 새 가로채기가 앞선다(Cypress는 마지막 등록을
 * 먼저 맞춘다).
 *
 * 2026-10-04: 비교(`get_project_branch_comparison`)가 빠져 있었다. B8이 ProjectGitPanel에
 * 그 호출을 더했는데 — head 브랜치에 upstream이 있으면 조건 없이 나간다 — 여기에 스텁이
 * 없어 거절로 끝났고, 형상관리 탭을 여는 스펙이 전부 `.error-banner`를 띄운 채 돌았다.
 * 기본 픽스처의 upstream이 `origin/main`이므로 이 호출은 **언제나** 나간다. 조회 하나가
 * 늘면 여기도 늘어야 한다는 것이 이 함수가 존재하는 이유다.
 */
export function stubGitReads(stubs: GitReadStubs = {}): void {
  const overview = stubs.overview ?? gitOverview();
  const status = stubs.status ?? gitStatus();
  const diff = stubs.diff ?? gitDiff();
  const log = stubs.log ?? gitLog([gitCommit("aaaaaaa", "첫 커밋")], false);
  const comparison = stubs.comparison ?? gitBranchComparison();
  cy.stubInvoke("get_project_git_overview", overview).as("gitOverview");
  cy.stubInvoke("get_project_git_status", status).as("gitStatus");
  cy.stubInvoke("get_project_git_diff", diff).as("gitDiff");
  cy.stubInvoke("get_project_git_log", (req) => {
    const skip = Number((req.body as { request?: { skip?: number } })?.request?.skip ?? 0);
    req.reply(typeof log === "function" ? log(skip) : log);
  }).as("gitLog");
  cy.stubInvoke("get_project_branch_comparison", comparison).as("gitBranchComparison");
}
