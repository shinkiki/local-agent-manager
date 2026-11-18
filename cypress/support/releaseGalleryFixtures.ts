/// <reference types="cypress" />
/// <reference path="./index.d.ts" />
/**
 * v0.3.0 공개 게시용 화면 갤러리(`cypress/e2e/release-gallery-v030.cy.ts`)의 데모 데이터와 공통 절차.
 * 실제 사람 이름·이메일·이 기계의 경로는 쓰지 않는다 — 경로는 `/workspace/...`, 주소는 `example.com`이다.
 */
import type { ProviderId, SessionSummary } from "../../src/types";
import {
  accountUsage,
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "./providerAccountFixtures";
import { seedHarnessStorage } from "./appCommands";

export const THEME_KEY = "agent-manager.theme-mode.v1";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const NOW = Date.now();

// ---------------------------------------------------------------------------
// 영어 화면용 데모 문자열

export type DemoLang = "ko" | "en";

/**
 * 갤러리 언어. 이 스위트는 `allowCypressEnv: false`라 `Cypress.env()`로 받을 수 없고, `cy.env()`는
 * 명령이라 모듈 최상단의 데모 데이터가 기다릴 수 없다. 그래서 영어 스펙(`release-gallery-en-*.cy.ts`)이
 * 한국어 스펙을 import하기 전에 `galleryLangEn.ts`로 전역 표식을 세운다. 표식이 없으면 한국어(am-030-*)다.
 */
export const LANG: DemoLang = (globalThis as { __AM_GALLERY_LANG?: string }).__AM_GALLERY_LANG === "en" ? "en" : "ko";

/** 갤러리 언어에 맞는 쪽을 고른다. 데모 문자열과 화면 문구 선택자 모두 여기를 지난다. */
export function tr<T>(ko: T, en: T): T {
  return LANG === "en" ? en : ko;
}

/** 영어 갤러리면 UI 언어를 영어로 바꿔 둔다. 백엔드 설정이라 같은 스펙 안에서는 유지된다. */
export function applyGalleryLanguage(): void {
  if (LANG !== "en") return;
  cy.visit("/", { onBeforeLoad(win) { seedHarnessStorage(win, { [THEME_KEY]: "dark" }); } });
  cy.setLanguage("en");
  cy.anchor("nav.settings").should("contain.text", "Settings");
}

/** 영어 화면에서 사용자 데이터까지 한국어로 남으면 섞여 보인다. 문자열 값을 통째로 바꾼다. */
export const DEMO_EN: Record<string, string> = {
  "v0.3.0 릴리스 노트 초안 작성": "Draft v0.3.0 release notes",
  "프로젝트 형상관리 탭에 스태시 목록 추가": "Add stash list to the project Git tab",
  "환불 API 멱등성 키 검증 로직 리뷰": "Review refund API idempotency-key checks",
  "온보딩 화면 접근성 점검": "Accessibility pass on onboarding screens",
  "웹훅 재시도 백오프 테스트 보강": "Harden webhook retry backoff tests",
  "API 레퍼런스 용어집 정리": "Tidy the API reference glossary",
  "문서 사이트 검색 인덱스 개선": "Improve docs-site search index",
  "푸시 알림 딥링크 라우팅 수정": "Fix push-notification deep-link routing",
  "다국어 문자열 누락 탐지 스크립트": "Script to detect missing i18n strings",
  "정산 배치 쿼리 성능 분석": "Profile settlement batch queries",
  "격리 E2E 시나리오 12건 추가": "Add 12 isolated E2E scenarios",
  "변경 이력 요약 초안": "Draft changelog summary",
  "v0.3.0 릴리스": "v0.3.0 release",
  "결제 도메인": "Payments",
  "리서치": "Research",
  "Claude 업무": "Claude Work",
  "Claude 실험": "Claude Lab",
  "Codex 메인": "Codex Main",
  "Codex 팀": "Codex Team",
  "의존성 보안 점검": "Dependency security audit",
  "어제 커밋으로 스탠드업 요약": "Stand-up summary from yesterday's commits",
  "문서 링크 깨짐 검사": "Broken docs link check",
  "주간 작업 보고서": "Weekly work report",
  "번역 누락 문자열 수집": "Collect missing translations",
  "불안정한 테스트 재현": "Reproduce flaky tests",
  "점검 완료 — 조치 필요 항목 없음": "Audit complete — nothing to fix",
  "5시간": "5 hours",
  "7일": "7 days",
};

export function localize<T>(value: T, lang: DemoLang): T {
  if (lang === "ko") return value;
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    if (item in DEMO_EN) return DEMO_EN[item];
    const prompt = /^(.*)을\(를\) 진행하고 결과를 요약한다\.$/.exec(item);
    return prompt && prompt[1] in DEMO_EN ? `Run "${DEMO_EN[prompt[1]]}" and summarize the result.` : item;
  }) as T;
}

// ---------------------------------------------------------------------------
// 세션

export const META: SessionSummary["meta"] = {
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

export const MODEL: Record<ProviderId, string> = {
  claude: "claude-sonnet-4-5",
  codex: "gpt-5.6-codex",
  antigravity: "gemini-3-pro",
  local: "qwen3:8b",
};

export function session(
  source: ProviderId,
  id: string,
  title: string,
  project: string,
  minutesAgo: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  const updatedAt = NOW - minutesAgo * MIN;
  const tokens = 8_000 + ((id.length * 7919) % 40_000);
  return {
    source,
    id,
    title,
    sourceTitle: null,
    project: `/workspace/${project}`,
    cwd: `/workspace/${project}`,
    startedAt: updatedAt - 40 * MIN,
    updatedAt,
    messageCount: 6 + (id.length % 20),
    tokenTotal: tokens,
    tokenUsage: { input: Math.round(tokens * 0.6), output: Math.round(tokens * 0.15), cacheRead: Math.round(tokens * 0.2), cacheWrite: Math.round(tokens * 0.05) },
    model: MODEL[source],
    gitBranch: "main",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 36_000 + tokens,
    filePath: `/workspace/.sessions/${source}/${id}.jsonl`,
    meta: META,
    lastFailure: null,
    ...overrides,
  };
}

export const SESSIONS: SessionSummary[] = localize<SessionSummary[]>([
  session("claude", "s-release", "v0.3.0 릴리스 노트 초안 작성", "agent-manager", 3, {
    meta: { ...META, favorite: true, folderIds: ["f-release"] },
  }),
  session("codex", "s-git-panel", "프로젝트 형상관리 탭에 스태시 목록 추가", "agent-manager", 14, { meta: { ...META, folderIds: ["f-release"] } }),
  session("claude", "s-refund", "환불 API 멱등성 키 검증 로직 리뷰", "payments-api", 38, { meta: { ...META, folderIds: ["f-payments"] } }),
  session("antigravity", "s-onboarding", "온보딩 화면 접근성 점검", "mobile-app", 55),
  session("codex", "s-webhook", "웹훅 재시도 백오프 테스트 보강", "payments-api", 92, { meta: { ...META, folderIds: ["f-payments"] } }),
  session("local", "s-docs-local", "API 레퍼런스 용어집 정리", "docs-site", 130),
  session("claude", "s-docs-search", "문서 사이트 검색 인덱스 개선", "docs-site", 180),
  session("codex", "s-push", "푸시 알림 딥링크 라우팅 수정", "mobile-app", 260),
  session("antigravity", "s-i18n", "다국어 문자열 누락 탐지 스크립트", "mobile-app", 420),
  session("claude", "s-ledger", "정산 배치 쿼리 성능 분석", "payments-api", 610, {
    lastFailure: null,
  }),
  session("codex", "s-e2e", "격리 E2E 시나리오 12건 추가", "agent-manager", 900, { meta: { ...META, folderIds: ["f-release"] } }),
  session("local", "s-changelog", "변경 이력 요약 초안", "docs-site", 1_300),
], LANG);

export const FOLDERS = localize([
  { id: "f-release", name: "v0.3.0 릴리스", color: "amber", sortOrder: 0, parentId: null, hidden: false, depth: 0 },
  { id: "f-payments", name: "결제 도메인", color: "green", sortOrder: 1, parentId: null, hidden: false, depth: 0 },
  { id: "f-research", name: "리서치", color: "blue", sortOrder: 2, parentId: null, hidden: false, depth: 0 },
], LANG);

export const PROVIDERS_STATUS = [
  { provider: "claude", displayName: "Claude Code", cli: { detected: true, path: "/usr/local/bin/claude" }, history: { detected: true, path: "/workspace/.claude" } },
  { provider: "codex", displayName: "OpenAI Codex", cli: { detected: true, path: "/usr/local/bin/codex" }, history: { detected: true, path: "/workspace/.codex" } },
  { provider: "antigravity", displayName: "Google Antigravity", cli: { detected: true, path: "/usr/local/bin/agy" }, history: { detected: true, path: "/workspace/.gemini" } },
  { provider: "local", displayName: "Ollama", cli: { detected: true, path: "/usr/local/bin/opencode" }, history: { detected: true, path: "/workspace/.local/share/opencode" } },
];

export function weekly() {
  const weeks = [];
  const start = NOW - 11 * 7 * DAY;
  const pattern = [
    [6, 9, 2, 0], [8, 11, 3, 1], [7, 13, 2, 2], [10, 12, 4, 1], [9, 15, 5, 3], [12, 14, 4, 2],
    [11, 18, 6, 4], [14, 16, 5, 3], [13, 20, 7, 5], [16, 19, 8, 4], [18, 22, 7, 6], [9, 12, 4, 3],
  ];
  for (let i = 0; i < 12; i += 1) {
    const [claude, codex, antigravity, local] = pattern[i];
    weeks.push({ weekStart: start + i * 7 * DAY, claude, codex, antigravity, local });
  }
  return weeks;
}

export const DASHBOARD = {
  sessionCount: 486,
  sessionsBySource: { claude: 182, codex: 221, antigravity: 51, local: 32 },
  tokens: { total: 184_300_000, claude: 71_200_000, codex: 88_900_000, antigravity: 17_400_000, local: 6_800_000 },
  disk: { total: 1_420_000_000, claude: 520_000_000, codex: 690_000_000, antigravity: 140_000_000, local: 70_000_000 },
  skillCount: 18,
  agentCount: 6,
  models: [
    { model: "gpt-5.6-codex", count: 168 },
    { model: "claude-sonnet-4-5", count: 131 },
    { model: "claude-opus-4-5", count: 51 },
    { model: "gemini-3-pro", count: 38 },
    { model: "gpt-5.6", count: 34 },
    { model: "qwen3:8b", count: 21 },
    { model: "gemini-3-flash", count: 13 },
    { model: "gpt-oss:20b", count: 11 },
  ],
  topProjects: [
    { name: "agent-manager", path: "/workspace/agent-manager", count: 164 },
    { name: "payments-api", path: "/workspace/payments-api", count: 118 },
    { name: "mobile-app", path: "/workspace/mobile-app", count: 91 },
    { name: "docs-site", path: "/workspace/docs-site", count: 57 },
    { name: "infra-terraform", path: "/workspace/infra-terraform", count: 29 },
    { name: "design-system", path: "/workspace/design-system", count: 17 },
  ],
  weekly: weekly(),
  recent: SESSIONS.slice(0, 10),
};

/** 스냅숏(전체·변경분)을 데모 값으로 덮는다. 변경분은 세션을 비워 전체에서 받은 목록을 유지한다. */
export function stubSnapshot(lang: DemoLang = LANG): void {
  const SESSIONS_L = localize(SESSIONS, lang);
  const DASHBOARD_L = localize(DASHBOARD, lang);
  const FOLDERS_L = localize(FOLDERS, lang);
  const apply = (body: Record<string, unknown>) => {
    const status = body.status as Record<string, unknown>;
    status.providers = PROVIDERS_STATUS;
    body.dashboard = DASHBOARD_L;
    body.folders = FOLDERS_L;
    body.pendingProjects = [];
  };
  cy.stubInvoke("get_manager_snapshot", (req) => {
    req.continue((res) => {
      const body = res.body as Record<string, unknown>;
      apply(body);
      body.sessions = SESSIONS_L;
    });
  });
  cy.stubInvoke("get_manager_snapshot_delta", (req) => {
    req.continue((res) => {
      const body = res.body as Record<string, unknown>;
      apply(body);
      if (body.kind === "full") body.sessions = SESSIONS_L;
      else {
        body.changedSessions = [];
        body.removedSessions = [];
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 계정·사용량

export function windows(...items: [string, number, number][]) {
  return accountUsage({
    updatedAt: NOW - 2 * MIN,
    windows: items.map(([label, usedPercent, hours]) => ({ label, usedPercent, resetsAt: NOW + hours * HOUR })),
  });
}

export const ACCOUNTS = localize([
  providerAccount({ id: "acc-claude-work", provider: "claude", displayName: "Claude 업무", providerDisplayName: "Claude 업무", providerAccountId: "claude-work", email: "dev@example.com", isActive: true, usage: windows(["5시간", 42, 3], ["7일", 58, 71]) }),
  providerAccount({ id: "acc-claude-lab", provider: "claude", displayName: "Claude 실험", providerDisplayName: "Claude 실험", providerAccountId: "claude-lab", email: "lab@example.com", isActive: false, usage: windows(["5시간", 12, 4], ["7일", 27, 120]) }),
  providerAccount({ id: "acc-codex-main", provider: "codex", displayName: "Codex 메인", providerDisplayName: "Codex 메인", providerAccountId: "codex-main", email: "dev@example.com", isActive: true, usage: windows(["5시간", 67, 2], ["7일", 74, 40]) }),
  providerAccount({ id: "acc-codex-team", provider: "codex", displayName: "Codex 팀", providerDisplayName: "Codex 팀", providerAccountId: "codex-team", email: "team@example.com", isActive: false, usage: windows(["5시간", 8, 5], ["7일", 33, 96]) }),
], LANG);

export const ANTIGRAVITY_RESOURCES = localize([
  providerAccount({ id: "ag-pro", provider: "antigravity", displayName: "Gemini Pro", providerDisplayName: "Gemini Pro", providerAccountId: "ag-pro", isActive: true, usage: windows(["7일", 46, 88]) }),
], LANG);

export function usageHistory() {
  const series: Record<string, number[]> = {
    "acc-claude-work": [62, 71, 68, 80, 77, 58],
    "acc-claude-lab": [18, 24, 31, 22, 29, 27],
    "acc-codex-main": [55, 66, 74, 83, 88, 74],
    "acc-codex-team": [0, 12, 20, 35, 41, 33],
    "ag-pro": [0, 0, 22, 38, 51, 46],
  };
  return {
    accounts: Object.entries(series).map(([accountId, percents]) => {
      const cycles = [];
      for (let m = 0; m < 6; m += 1) {
        if (percents[m] === 0) continue;
        // 달마다 7일 주기 4개. 한 달 뒤에서부터 거꾸로 센다.
        for (let w = 0; w < 4; w += 1) {
          const resetsAt = NOW - (5 - m) * 30 * DAY - (3 - w) * 7 * DAY - DAY;
          cycles.push({
            windowLabel: tr("7일", "7 days"),
            windowLengthMs: 7 * DAY,
            resetsAt,
            peakUsedPercent: Math.min(100, percents[m] + (w % 2 === 0 ? 6 : -6)),
            firstObservedAt: resetsAt - 7 * DAY,
            lastObservedAt: resetsAt - HOUR,
          });
        }
      }
      return { accountId, observedSince: NOW - 190 * DAY, cycles };
    }),
  };
}

export function stubAccounts(lang: DemoLang = LANG): void {
  stubProviderAccounts(
    [
      providerState({ provider: "claude", activeAccountId: "acc-claude-work", observedActiveAccountId: "acc-claude-work" }),
      providerState({ provider: "codex", activeAccountId: "acc-codex-main", observedActiveAccountId: "acc-codex-main" }),
    ],
    localize(ACCOUNTS, lang),
  );
  cy.stubInvoke("get_antigravity_pacing_usage", { statusCode: 200, body: ANTIGRAVITY_RESOURCES });
  cy.stubInvoke("get_antigravity_usage", { statusCode: 200, body: localize(windows(["7일", 46, 88]), LANG) });
  cy.stubInvoke("get_account_usage_history", { statusCode: 200, body: usageHistory() });
  cy.stubInvoke("get_local_llm_connection", {
    statusCode: 200,
    body: { baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "qwen3:8b", contextWindow: 32768, apiKeyConfigured: false, enabled: true },
  });
}

// ---------------------------------------------------------------------------
// 반복 일정

export function schedule(id: string, name: string, source: ProviderId, project: string, nextInMin: number, hour: number, frequency: string, enabled = true) {
  return {
    id,
    name,
    prompt: `${name}을(를) 진행하고 결과를 요약한다.`,
    source,
    accountId: "",
    useActiveAccount: true,
    cwd: `/workspace/${project}`,
    model: null,
    reasoningEffort: null,
    mode: "workspace",
    approvalMode: "manual",
    recurrence: { frequency, interval: 1, hour, minute: 0, weekday: 1, cron: null, timezone: "Asia/Seoul" },
    sessionStrategy: "newChat",
    resumeFailurePolicy: "pause",
    providerSessionId: null,
    enabled,
    workflow: null,
    activeFrom: null,
    activeUntil: null,
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - 3 * DAY,
    nextRunAt: NOW + nextInMin * MIN,
    lastRunAt: NOW + nextInMin * MIN - (frequency === "weekly" ? 7 * DAY : DAY),
    manualRunRequestedAt: null,
  };
}

export const SCHEDULES = localize([
  schedule("sch-deps", "의존성 보안 점검", "codex", "payments-api", 42, 9, "daily"),
  schedule("sch-standup", "어제 커밋으로 스탠드업 요약", "claude", "agent-manager", 95, 9, "weekdays"),
  schedule("sch-docs", "문서 링크 깨짐 검사", "local", "docs-site", 310, 14, "daily"),
  schedule("sch-weekly", "주간 작업 보고서", "claude", "agent-manager", 2_900, 17, "weekly"),
  schedule("sch-i18n", "번역 누락 문자열 수집", "antigravity", "mobile-app", 610, 20, "daily"),
  schedule("sch-flaky", "불안정한 테스트 재현", "codex", "mobile-app", 4_000, 2, "weekly", false),
], LANG);

export function run(id: string, scheduleId: string, minutesAgo: number, status: string) {
  return {
    id,
    scheduleId,
    scheduledFor: NOW - minutesAgo * MIN,
    startedAt: NOW - minutesAgo * MIN,
    finishedAt: status === "running" ? null : NOW - (minutesAgo - 6) * MIN,
    status,
    requestedAccountId: "acc-codex-main",
    actualAccountId: "acc-codex-main",
    providerSessionId: null,
    previousProviderSessionId: null,
    sessionReplaced: false,
    retryCount: 0,
    summary: status === "completed" ? tr("점검 완료 — 조치 필요 항목 없음", "Audit complete — nothing to fix") : null,
    error: null,
    lastHeartbeatAt: null,
    cancellationRequestedAt: null,
    recoveryError: null,
    manual: false,
  };
}

export const RUNS = [
  run("run-1", "sch-deps", 1_398, "completed"),
  run("run-2", "sch-standup", 1_345, "completed"),
  run("run-3", "sch-docs", 1_130, "completed"),
  run("run-4", "sch-i18n", 830, "completed"),
  run("run-5", "sch-weekly", 8_700, "completed"),
];

export function stubScheduler(lang: DemoLang = LANG): void {
  cy.stubInvoke("get_scheduler_snapshot", { statusCode: 200, body: localize({ paused: false, runnerActive: true, schedules: SCHEDULES, runs: RUNS }, lang) });
}

// ---------------------------------------------------------------------------
// 공통

/** `lang`이 "en"이면 데모 데이터의 한국어 문자열(세션 제목·폴더·계정·일정 이름)을 영어로 바꿔 세운다. */
export function stubWorkspace(lang: DemoLang = LANG): void {
  stubSnapshot(lang);
  stubAccounts(lang);
  stubScheduler(lang);
}

/** 다크 테마를 심은 채 앱을 연다. `onBeforeLoad`로 가짜 소켓 같은 창 손질을 덧붙인다. */
export function visitDark(seed: Record<string, string> = {}, onBeforeLoad?: (win: Cypress.AUTWindow) => void): void {
  cy.visit("/", {
    onBeforeLoad(win) {
      seedHarnessStorage(win, { [THEME_KEY]: "dark", ...seed });
      onBeforeLoad?.(win);
    },
  });
  cy.get("html").should("have.attr", "data-theme", "dark");
}

/** 글꼴·스피너가 가라앉은 뒤 찍는다. */
export function shoot(name: string): void {
  cy.document().its("fonts.status").should("eq", "loaded");
  cy.get(".spinner, .skeleton, [aria-busy='true']").should("not.exist");
  cy.wait(400);
  cy.screenshot(LANG === "en" ? `am-031-en-${name}` : `am-030-${name}`, { capture: "viewport", overwrite: true });
}


/** 헤드리스 Electron 창은 1280x720이라 1440x900 화면이 잘린다. 창 크기를 CDP로 넓힌다. */
export function widenHeadlessWindow(): void {
  cy.wrap(Cypress.automation("remote:debugger:protocol", {
    command: "Emulation.setDeviceMetricsOverride",
    params: { width: 2000, height: 1300, deviceScaleFactor: 1, mobile: false },
  }));
}
