import assert from "node:assert/strict";
import test from "node:test";
import {
  canDispatchAiaEvent,
  captureAiaEventBaseline,
  clearAiaSkillChange,
  coalesceAiaEvents,
  detectAiaEvents,
  dismissAiaSuggestion,
  emptyAiaEventBudget,
  emptyAiaSkillChangeState,
  emptyAiaSuggestionHistory,
  evaluateAiaSuggestionState,
  evaluateAiaSuggestions,
  mergeComposerDraft,
  normalizeProjectPath,
  observeAiaSkillChanges,
  parseAiaEventBudget,
  parseAiaSkillChangeState,
  parseAiaSuggestionHistory,
  recordAiaEventDispatch,
  serializeAiaEventBudget,
  serializeAiaSkillChangeState,
  serializeAiaSuggestionHistory,
} from "./aiaSuggestions.ts";

const NOW = Date.UTC(2026, 7, 21, 3);

function definition(kind, overrides = {}) {
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

function catalog(...definitions) {
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

function session(id, overrides = {}) {
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

function manager(sessions = [], providers = []) {
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

function attention(items = []) {
  return { items, unreadCount: items.filter((item) => !item.read).length, pendingCount: 0 };
}

function evaluation(overrides = {}) {
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

function attentionItem(id, overrides = {}) {
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

function translationStatus(overrides = {}) {
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

function automation(overrides = {}) {
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

function account(id, overrides = {}) {
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

test("project cleanup groups normalized cwd across providers and applies exact default thresholds", () => {
  const sessions = Array.from({ length: 8 }, (_, index) => session(`s${index}`, {
    source: index % 2 ? "codex" : "claude",
    cwd: index % 2 ? "/work/alpha/./" : "/work/alpha",
    meta: { favorite: false, hidden: false, note: null, customTitle: null, folderIds: index < 5 ? [] : ["folder"] },
  }));
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager(sessions),
  }));
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].targetId, "/work/alpha");
  assert.equal(suggestions[0].metadata.sessionCount, 8);
  assert.equal(suggestions[0].metadata.unfiledCount, 5);

  sessions[4].meta.folderIds = ["folder"];
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager(sessions),
  })).length, 0);
});

test("project cleanup excludes hidden, archived, unreadable, subagent and AIA workspace sessions", () => {
  const included = Array.from({ length: 7 }, (_, index) => session(`included-${index}`));
  const excluded = [
    session("hidden", { meta: { favorite: false, hidden: true, note: null, customTitle: null, folderIds: [] } }),
    session("archived", { archived: true }),
    session("unreadable", { readable: false }),
    session("subagent", { isSubagent: true }),
    session("aia", { aiaWorkspace: true }),
  ];
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager([...included, ...excluded]),
  })).length, 0);
});

test("project cleanup returns at most three projects sorted by unfiled count then recency", () => {
  const sessions = [];
  const specs = [
    ["alpha", 6, NOW - 50],
    ["beta", 7, NOW - 500],
    ["charlie", 6, NOW - 10],
    ["delta", 5, NOW],
  ];
  for (const [name, unfiled, updatedAt] of specs) {
    for (let index = 0; index < 8; index += 1) {
      sessions.push(session(`${name}-${index}`, {
        project: name,
        cwd: `/work/${name}`,
        updatedAt,
        meta: { favorite: false, hidden: false, note: null, customTitle: null, folderIds: index < unfiled ? [] : ["folder"] },
      }));
    }
  }
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager(sessions),
  }));
  assert.deepEqual(suggestions.map((item) => item.targetId), ["/work/beta", "/work/charlie", "/work/alpha"]);
});

test("project dismissal rearms after three more unfiled sessions or resolve and recross", () => {
  const projectDefinition = definition("projectSessionCleanup");
  const original = Array.from({ length: 8 }, (_, index) => session(`original-${index}`));
  const initial = evaluateAiaSuggestionState(evaluation({ catalog: catalog(projectDefinition), manager: manager(original) }));
  const dismissed = dismissAiaSuggestion(initial.history, initial.suggestions[0], NOW);

  const plusTwo = [...original, session("nine"), session("ten")];
  assert.equal(evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(plusTwo), history: dismissed,
  })).suggestions.length, 0);

  const plusThree = [...plusTwo, session("eleven")];
  assert.equal(evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(plusThree), history: dismissed,
  })).suggestions.length, 1);

  const resolvedSessions = original.map((item) => ({
    ...item,
    meta: { ...item.meta, folderIds: ["folder"] },
  }));
  const resolved = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(resolvedSessions), history: dismissed,
  }));
  assert.equal(Object.values(resolved.history.projectDismissals)[0].resolved, true);
  assert.equal(evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(original), history: resolved.history,
  })).suggestions.length, 1);
});

test("interrupted reminders honor delay, expiry, actual interruption and attended standard profile", () => {
  const interruptedDefinition = definition("interruptedSessionReminder");
  const valid = attentionItem("valid");
  const items = [
    valid,
    attentionItem("too-soon", { createdAt: NOW - 29 * 60_000 }),
    attentionItem("expired", { createdAt: NOW - 8 * 24 * 60 * 60_000 }),
    attentionItem("unattended", { unattended: true }),
    attentionItem("scheduled", { profile: "scheduled" }),
    attentionItem("aia", { profile: "aia_system" }),
    attentionItem("mere-failure", { detail: "network" }),
  ];
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(interruptedDefinition), attention: attention(items),
  }));
  assert.deepEqual(suggestions.map((item) => item.targetId), [valid.id]);
});

test("a newer running or completed item suppresses an interrupted reminder by chat or provider session", () => {
  const interruptedDefinition = definition("interruptedSessionReminder");
  const byChat = attentionItem("by-chat");
  const byProvider = attentionItem("by-provider");
  const items = [
    byChat,
    byProvider,
    attentionItem("resume-chat", { chatId: byChat.chatId, providerSessionId: "different", kind: "running", createdAt: byChat.createdAt + 1 }),
    attentionItem("resume-provider", { chatId: "different", providerSessionId: byProvider.providerSessionId, kind: "completed", createdAt: byProvider.createdAt + 1 }),
  ];
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(interruptedDefinition), attention: attention(items),
  })).length, 0);
});

test("operational definitions evaluate CLI, account, scheduler and translation facts", () => {
  const definitions = [
    definition("providerCliMissing"),
    definition("accountAuthError"),
    definition("accountAutoSwitchMissing"),
    definition("schedulerPaused"),
    definition("scheduleRunFailed"),
    definition("translationFailed"),
    definition("featureTip", { parameters: { featureName: "voice" } }),
  ];
  const accounts = {
    accounts: [
      account("broken", { authStatus: "error", isActive: true, usage: { status: "ok", windows: [{ label: "weekly", usedPercent: 91, resetsAt: null }], updatedAt: NOW, error: null } }),
      account("standby"),
      account("standby-2"),
    ],
    providers: [],
    autoSwitchResume: false,
  };
  const scheduler = {
    paused: true,
    runnerActive: false,
    schedules: [{ id: "schedule", name: "Daily report" }],
    runs: [{ id: "run", scheduleId: "schedule", status: "failed", scheduledFor: NOW - 1, startedAt: NOW - 1, finishedAt: NOW, recoveryError: null }],
  };
  const provider = { provider: "claude", displayName: "Claude", cli: { detected: false, path: null }, history: { detected: true, path: "/history" } };
  const auto = automation({ providers: [provider], skills: translationStatus({ phase: "error", failed: 1 }) });
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(...definitions), manager: manager([], [provider]), accounts, scheduler, automation: auto,
  }));
  assert.deepEqual(new Set(suggestions.map((item) => item.kind)), new Set(definitions.map((item) => item.kind)));
});

test("retired usage definitions produce no suggestion even above the threshold", () => {
  const accounts = {
    accounts: [account("hot", {
      isActive: true,
      usage: { status: "ok", windows: [{ label: "weekly", usedPercent: 99, resetsAt: null }], updatedAt: NOW, error: null },
    })],
    providers: [],
    autoSwitchResume: false,
  };
  const usage = definition("accountUsageThreshold", { parameters: { thresholdPercent: 70 } });
  assert.equal(evaluateAiaSuggestions(evaluation({ catalog: catalog(usage), accounts })).length, 0);
});

test("fingerprints ignore pack version and presentation copy", () => {
  const first = definition("featureTip", { titleTemplate: "First" });
  const firstSuggestion = evaluateAiaSuggestions(evaluation({ catalog: catalog(first) }))[0];
  const changedCatalog = catalog(definition("featureTip", { titleTemplate: "Changed", promptTemplate: "Changed prompt" }));
  changedCatalog.packs[0].version = "99.0.0";
  const changedSuggestion = evaluateAiaSuggestions(evaluation({ catalog: changedCatalog }))[0];
  assert.equal(firstSuggestion.fingerprint, changedSuggestion.fingerprint);
});

test("the evaluator accepts the nested effective-pack shape returned by core", () => {
  const nested = {
    contentDigest: "digest",
    packs: [{
      source: "commonSkill",
      skillKey: "my-pack",
      pack: catalog(definition("featureTip")).packs[0],
    }],
    definitions: [],
    issues: [],
  };
  const suggestion = evaluateAiaSuggestions(evaluation({ catalog: nested }))[0];
  assert.equal(suggestion.source, "commonSkill");
  assert.equal(suggestion.skillKey, "my-pack");
});

test("feature tips and ordinary dismissed fingerprints persist without unsafe data", () => {
  const defs = [definition("featureTip"), definition("schedulerPaused")];
  const state = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(...defs), scheduler: { paused: true, runnerActive: false, schedules: [], runs: [] },
  }));
  let history = emptyAiaSuggestionHistory();
  for (const suggestion of state.suggestions) history = dismissAiaSuggestion(history, suggestion, NOW);
  const restored = parseAiaSuggestionHistory(serializeAiaSuggestionHistory(history));
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(...defs), scheduler: { paused: true, runnerActive: false, schedules: [], runs: [] }, history: restored,
  })).length, 0);
  const authSuggestion = evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("accountAuthError")),
    accounts: { accounts: [account("private-account-id", { authStatus: "error" })], providers: [], autoSwitchResume: false },
  }))[0];
  const privateHistory = dismissAiaSuggestion(emptyAiaSuggestionHistory(), authSuggestion, NOW);
  assert.equal(serializeAiaSuggestionHistory(privateHistory).includes("private-account-id"), false);
  assert.deepEqual(parseAiaSuggestionHistory("not json"), emptyAiaSuggestionHistory());
});

test("ordinary dismissal rearms only after resolution when the pack enables it", () => {
  const paused = definition("schedulerPaused", { rearm: { afterResolved: true } });
  const activeInput = evaluation({
    catalog: catalog(paused), scheduler: { paused: true, runnerActive: false, schedules: [], runs: [] },
  });
  const suggestion = evaluateAiaSuggestions(activeInput)[0];
  const dismissed = dismissAiaSuggestion(emptyAiaSuggestionHistory(), suggestion, NOW);
  const resolved = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(paused), scheduler: { paused: false, runnerActive: true, schedules: [], runs: [] }, history: dismissed,
  }));
  assert.equal(Object.values(resolved.history.incidentDismissals)[0].resolved, true);
  assert.equal(evaluateAiaSuggestions({ ...activeInput, history: resolved.history }).length, 1);

  const cooldownDefinition = definition("schedulerPaused", { rearm: { afterResolved: true, cooldownMinutes: 60 } });
  const cooldownInput = evaluation({
    catalog: catalog(cooldownDefinition), scheduler: { paused: true, runnerActive: false, schedules: [], runs: [] },
  });
  const cooldownSuggestion = evaluateAiaSuggestions(cooldownInput)[0];
  const cooldownHistory = dismissAiaSuggestion(emptyAiaSuggestionHistory(), cooldownSuggestion, NOW);
  assert.equal(evaluateAiaSuggestions({ ...cooldownInput, now: NOW + 59 * 60_000, history: cooldownHistory }).length, 0);
  assert.equal(evaluateAiaSuggestions({ ...cooldownInput, now: NOW + 60 * 60_000, history: cooldownHistory }).length, 1);
});

test("state changes do not bypass dismissal and afterResolved false stays dismissed", () => {
  const authDefinition = definition("accountAuthError", { rearm: { afterResolved: false } });
  const missingInput = evaluation({
    catalog: catalog(authDefinition),
    accounts: { accounts: [account("private-account", { authStatus: "missing" })], providers: [], autoSwitchResume: false },
  });
  const suggestion = evaluateAiaSuggestions(missingInput)[0];
  const dismissed = dismissAiaSuggestion(emptyAiaSuggestionHistory(), suggestion, NOW);

  const errorInput = {
    ...missingInput,
    accounts: { accounts: [account("private-account", { authStatus: "error" })], providers: [], autoSwitchResume: false },
    history: dismissed,
  };
  assert.equal(evaluateAiaSuggestions(errorInput).length, 0);

  const resolved = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(authDefinition),
    accounts: { accounts: [account("private-account")], providers: [], autoSwitchResume: false },
    history: dismissed,
  }));
  assert.equal(Object.values(resolved.history.incidentDismissals)[0].resolved, true);
  assert.equal(evaluateAiaSuggestions({ ...missingInput, history: resolved.history }).length, 0);
});

test("initial baseline produces no events and later operational transitions do", () => {
  const goodProvider = { provider: "claude", displayName: "Claude", cli: { detected: true, path: "/cli" }, history: { detected: true, path: "/history" } };
  const goodInput = {
    manager: manager([], [goodProvider]),
    accounts: { accounts: [account("primary")], providers: [], autoSwitchResume: false },
    scheduler: { paused: false, runnerActive: true, schedules: [], runs: [] },
    automation: automation({ providers: [goodProvider] }),
  };
  const baseline = captureAiaEventBaseline(goodInput);
  assert.deepEqual(detectAiaEvents(baseline, { ...goodInput, now: NOW }).events, []);

  const missingProvider = { ...goodProvider, cli: { detected: false, path: null } };
  const bad = {
    manager: manager([], [missingProvider]),
    accounts: { accounts: [account("primary", { authStatus: "missing" })], providers: [], autoSwitchResume: false },
    scheduler: { paused: false, runnerActive: true, schedules: [], runs: [{ id: "run", scheduleId: "schedule", status: "failed", scheduledFor: NOW, recoveryError: "restore failed" }] },
    automation: automation({ providers: [missingProvider], artifacts: translationStatus({ failed: 2 }) }),
    now: NOW,
  };
  const transition = detectAiaEvents(baseline, bad);
  assert.deepEqual(new Set(transition.events.map((event) => event.kind)), new Set([
    "cliLost", "accountAuthError", "scheduleRecoveryError", "translationFailed",
  ]));
  assert.deepEqual(detectAiaEvents(transition.baseline, bad).events, []);
});

test("coalescing waits 30 seconds and selects the highest priority event", () => {
  const events = [
    { id: "low", kind: "translationFailed", targetId: "skills", priority: 10, observedAt: NOW, summary: "low" },
    { id: "high", kind: "cliLost", targetId: "claude", priority: 100, observedAt: NOW + 10_000, summary: "high" },
  ];
  assert.equal(coalesceAiaEvents(events, NOW + 29_999), null);
  const selected = coalesceAiaEvents(events, NOW + 30_000);
  assert.equal(selected.id, "high");
  assert.equal(selected.coalescedCount, 2);
});

test("AI event budget enforces six hours and two dispatches per rolling day", () => {
  let budget = emptyAiaEventBudget();
  assert.equal(canDispatchAiaEvent(budget, NOW), true);
  budget = recordAiaEventDispatch(budget, NOW);
  assert.equal(canDispatchAiaEvent(budget, NOW + 6 * 60 * 60_000 - 1), false);
  assert.equal(canDispatchAiaEvent(budget, NOW + 6 * 60 * 60_000), true);
  budget = recordAiaEventDispatch(budget, NOW + 6 * 60 * 60_000);
  assert.equal(canDispatchAiaEvent(budget, NOW + 13 * 60 * 60_000), false);
  assert.equal(canDispatchAiaEvent(budget, NOW + 24 * 60 * 60_000), true);
  assert.deepEqual(parseAiaEventBudget(serializeAiaEventBudget(budget)), budget);
});

function skillDigest(key, digest, name = key) {
  return { key, name, contentDigest: digest };
}

test("skill change detection seeds a baseline first and then reports only real content changes", () => {
  const digests = [skillDigest("review", "d1"), skillDigest("release", "r1")];
  const seeded = observeAiaSkillChanges(emptyAiaSkillChangeState(), digests, NOW);
  assert.deepEqual(seeded.changes, []);
  assert.deepEqual(seeded.digests, { review: "d1", release: "r1" });

  // 내용이 그대로면 변경으로 보지 않는다.
  assert.deepEqual(observeAiaSkillChanges(seeded, digests, NOW + 1_000).changes, []);

  const changed = observeAiaSkillChanges(seeded, [skillDigest("review", "d2"), skillDigest("release", "r1")], NOW + 2_000);
  assert.equal(changed.changes.length, 1);
  assert.deepEqual(changed.changes[0], {
    key: "review", name: "review", previousDigest: "d1", digest: "d2", detectedAt: NOW + 2_000,
  });

  // 감지된 변경은 사용자가 내리기 전까지 같은 감지 시각으로 유지된다.
  const held = observeAiaSkillChanges(changed, [skillDigest("review", "d2"), skillDigest("release", "r1")], NOW + 3_000);
  assert.deepEqual(held.changes, changed.changes);

  // 연달아 바뀌면 검토 범위가 끊기지 않도록 첫 변경 이전 지문을 유지한다.
  const again = observeAiaSkillChanges(held, [skillDigest("review", "d3"), skillDigest("release", "r1")], NOW + 4_000);
  assert.equal(again.changes[0].previousDigest, "d1");
  assert.equal(again.changes[0].digest, "d3");

  // 만료된 변경과 사라진 스킬은 목록에서 내린다.
  assert.deepEqual(observeAiaSkillChanges(again, [skillDigest("review", "d3")], NOW + 4_000 + 24 * 60 * 60_000 + 1).changes, []);
  assert.deepEqual(observeAiaSkillChanges(again, [skillDigest("release", "r1")], NOW + 5_000).changes, []);

  assert.deepEqual(parseAiaSkillChangeState(serializeAiaSkillChangeState(again)), again);
  assert.deepEqual(parseAiaSkillChangeState("{\"schemaVersion\":2}"), emptyAiaSkillChangeState());
});

test("skill change trigger proposes a review immediately and honors limits and dismissal", () => {
  const changes = [
    { key: "review", name: "코드 검토", previousDigest: "d1", digest: "d2", detectedAt: NOW - 1_000 },
    { key: "release", name: "배포", previousDigest: "r1", digest: "r2", detectedAt: NOW - 2_000 },
    { key: "old", name: "만료", previousDigest: "o1", digest: "o2", detectedAt: NOW - 25 * 60 * 60_000 },
  ];
  const input = evaluation({
    catalog: catalog(definition("skillContentChanged", {
      titleTemplate: "{skillName} 스킬 내용이 바뀌었습니다",
      detailTemplate: "검토할 수 있습니다",
      promptTemplate: "{skillName} 변경을 검토해줘",
      parameters: { expiresHours: 24, maxResults: 3 },
      rearm: { afterResolved: true },
    })),
    skillChanges: changes,
  });

  const suggestions = evaluateAiaSuggestions(input);
  // 임계값이나 지연 없이 최신 변경부터 바로 제안하고, 만료된 변경은 제외한다.
  assert.deepEqual(suggestions.map((suggestion) => suggestion.targetId), ["review", "release"]);
  assert.equal(suggestions[0].title, "코드 검토 스킬 내용이 바뀌었습니다");
  assert.equal(suggestions[0].prompt, "코드 검토 변경을 검토해줘");

  const limited = evaluateAiaSuggestions({
    ...input,
    catalog: catalog(definition("skillContentChanged", { parameters: { maxResults: 1 } })),
  });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].targetId, "review");

  // 숨기기는 그 스킬의 감지 항목만 지우고 기준선은 남긴다.
  const cleared = clearAiaSkillChange({ schemaVersion: 1, digests: { review: "d2" }, changes }, "review");
  assert.deepEqual(cleared.changes.map((change) => change.key), ["release", "old"]);
  assert.deepEqual(cleared.digests, { review: "d2" });
  assert.equal(clearAiaSkillChange(cleared, "review"), cleared);

  // 이력 기반 숨기기도 같은 변경으로는 다시 뜨지 않게 막는다.
  const dismissed = dismissAiaSuggestion(emptyAiaSuggestionHistory(), suggestions[0], NOW);
  const remaining = evaluateAiaSuggestions({ ...input, history: dismissed });
  assert.deepEqual(remaining.map((suggestion) => suggestion.targetId), ["release"]);
});

test("composer merge appends with one blank line and never manufactures content", () => {
  assert.equal(mergeComposerDraft("", "  제안 명령  "), "제안 명령");
  assert.equal(mergeComposerDraft("기존 초안\n\n", "제안 명령"), "기존 초안\n\n제안 명령");
  assert.equal(mergeComposerDraft("기존 초안", "   "), "기존 초안");
});

test("path normalization is lexical and deterministic", () => {
  assert.equal(normalizeProjectPath(" /work/alpha/../beta/ "), "/work/beta");
  assert.equal(normalizeProjectPath("C:\\Work\\Alpha\\"), "c:/Work/Alpha");
  assert.equal(normalizeProjectPath(""), null);
});
