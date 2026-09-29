/**
 * AIA 제안·사건·스킬 변경 시험이 함께 쓰는 스냅샷 재료.
 *
 * 평가 입력 하나를 만들려면 관리자·계정·반복 요청·자동화 스냅샷을 모두 갖춰야 해서,
 * 시험 파일이 모듈별로 갈리면 이 재료가 파일마다 한 벌씩 복제된다. 스냅샷 모양은
 * `types.ts`를 따라 움직이므로 복제본이 생기면 필드가 하나 늘 때 어느 한 벌만 고쳐지고,
 * 그 파일의 시험만 조용히 옛 모양으로 통과한다. 재료는 여기 한 벌만 둔다.
 *
 * `.test.mjs`가 아니므로 시험 실행기(`src/lib/*.test.mjs`)가 이 파일을 직접 돌리지
 * 않는다. 시험이 아니라 시험의 재료다.
 */

export const NOW = Date.UTC(2026, 7, 21, 3);

export function definition(kind, overrides = {}) {
  return {
    id: kind,
    kind,
    enabled: true,
    severity: "info",
    priority: 10,
    titleTemplate: "{projectName}{sessionTitle}{providerName}{scheduleName}{translationTarget}{featureName}",
    detailTemplate: "detail {usagePercent}",
    promptTemplate: "prompt {projectPath}",
    parameters: {},
    rearm: {},
    ...overrides,
  };
}

export function catalog(...definitions) {
  return {
    fingerprint: "catalog-fingerprint",
    packs: [{
      packId: "default-pack",
      version: "1.0.0",
      displayName: "기본 제안",
      source: "bundled",
      skillKey: null,
      suggestions: definitions,
    }],
  };
}

export function session(id, overrides = {}) {
  return {
    source: "claude",
    id,
    title: id,
    sourceTitle: id,
    project: "alpha",
    cwd: "/work/alpha",
    startedAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    messageCount: 2,
    tokenTotal: null,
    tokenUsage: null,
    model: null,
    gitBranch: null,
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    lastFailure: null,
    sizeBytes: 1,
    filePath: `/${id}.jsonl`,
    meta: { favorite: false, hidden: false, note: null, customTitle: null, folderIds: [] },
    ...overrides,
  };
}

export function manager(sessions = [], providers = []) {
  return {
    schemaVersion: 1,
    sessionCatalogRevision: 1,
    resourceCatalogRevision: 1,
    status: { schemaVersion: 1, platform: "macos", architecture: "arm64", providers },
    dashboard: { recent: [] },
    sessions,
    folders: [],
    skills: [],
    agents: [],
    artifacts: [],
  };
}

export function attention(items = []) {
  return { items, unreadCount: items.filter((item) => !item.read).length, pendingCount: 0 };
}

export function evaluation(overrides = {}) {
  return {
    catalog: catalog(),
    manager: manager(),
    accounts: null,
    scheduler: null,
    automation: null,
    attention: attention(),
    now: NOW,
    ...overrides,
  };
}

export function attentionItem(id, overrides = {}) {
  return {
    id,
    chatId: `chat-${id}`,
    source: "claude",
    providerSessionId: `provider-${id}`,
    cwd: "/work/alpha",
    resuming: false,
    unattended: false,
    profile: "standard",
    kind: "failed",
    title: `세션 ${id}`,
    detail: "interrupted",
    approvalId: null,
    preview: null,
    createdAt: NOW - 31 * 60_000,
    read: true,
    ...overrides,
  };
}

export function translationStatus(overrides = {}) {
  return {
    phase: "complete",
    total: 1,
    completed: 1,
    failed: 0,
    pending: 0,
    cached: 0,
    segmentTotal: 1,
    segmentCompleted: 1,
    segmentFailed: 0,
    segmentCached: 0,
    currentField: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

export function automation(overrides = {}) {
  const ok = translationStatus();
  return {
    revision: 1,
    resourceCatalogRevision: 1,
    settings: { systemProvider: "claude" },
    pendingLanguage: null,
    uiTranslation: ok,
    uiMessages: {},
    providers: [],
    skills: ok,
    agents: ok,
    artifacts: ok,
    ...overrides,
  };
}

export function account(id, overrides = {}) {
  return {
    id,
    provider: "claude",
    displayName: id,
    email: null,
    organization: null,
    providerAccountId: id,
    isActive: false,
    isDefault: false,
    isPendingDefault: false,
    disabled: false,
    autoSwitch: false,
    authStatus: "ready",
    usage: { status: "ok", windows: [{ label: "weekly", usedPercent: 10, resetsAt: null }], updatedAt: NOW, error: null },
    note: null,
    ...overrides,
  };
}

export function skillDigest(key, digest, name = key) {
  return { key, name, contentDigest: digest };
}

/** 계정 스냅샷 한 장. 시험이 실제로 보는 것은 `accounts`뿐이라 나머지는 고정값이다. */
export function accountSnapshot(...accounts) {
  return { accounts, providers: [], autoSwitchResume: false };
}

/** 반복 요청 스냅샷 한 장. 멈춤 여부와 회차 목록만 시험이 바꾼다. */
export function schedulerSnapshot(paused, runs = [], schedules = []) {
  return { paused, runnerActive: !paused, schedules, runs };
}
