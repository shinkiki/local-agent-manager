import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRIGGER_COOLDOWN_MS,
  DEFAULT_TRIGGER_DEBOUNCE_MS,
  buildDocumentTriggerInput,
  draftFromTrigger,
  isChatActionKind,
  isSkillActionKind,
  patternLines,
} from "./documentTriggerInput.ts";

/** 화면이 저장 직전에 들고 있는 초안의 기본 모양. 시험마다 바뀌는 칸만 덮어쓴다. */
function draft(overrides = {}) {
  return {
    name: "  문서 검토  ",
    rootId: "root-1",
    include: "**/*.md\n\n  docs/**  \n",
    exclude: "",
    changeKinds: ["create", "modify"],
    actionKind: "startChat",
    targetId: "",
    source: "codex",
    accountId: "",
    model: "  ",
    reasoningEffort: "",
    mode: "workspace",
    approvalMode: "autoReview",
    fullAccessAcknowledged: true,
    prompt: "변경 파일을 검토해줘",
    skillId: "",
    ...overrides,
  };
}

/** 저장된 트리거 한 벌. 실행 간격은 기본값과 다른 값을 둬 보존 여부가 드러나게 한다. */
function storedTrigger(action, overrides = {}) {
  return {
    id: "trigger-1",
    status: "watching",
    statusReason: null,
    createdAt: 1,
    updatedAt: 2,
    name: "저장된 트리거",
    rootId: "root-2",
    include: ["src/**", "docs/**"],
    exclude: ["node_modules/**"],
    changeKinds: ["delete"],
    enabled: false,
    debounceMs: 500,
    cooldownMs: 90000,
    action,
    ...overrides,
  };
}

test("pattern lines drop blank rows and surrounding whitespace, keeping order", () => {
  assert.deepEqual(patternLines("**/*.md\n\n  docs/**  \n"), ["**/*.md", "docs/**"]);
  assert.deepEqual(patternLines(""), []);
  assert.deepEqual(patternLines("   \n\t\n"), []);
});

test("action kind predicates agree with the stored shape", () => {
  assert.deepEqual(["runSchedule", "startChat", "runSkill", "executeWorkflow"].map(isChatActionKind), [false, true, true, false]);
  assert.deepEqual(["runSchedule", "startChat", "runSkill", "executeWorkflow"].map(isSkillActionKind), [false, false, true, false]);
});

test("a new trigger starts enabled with the default intervals and a trimmed name", () => {
  const input = buildDocumentTriggerInput(draft(), null);
  assert.equal(input.name, "문서 검토");
  assert.equal(input.rootId, "root-1");
  assert.deepEqual(input.include, ["**/*.md", "docs/**"]);
  assert.deepEqual(input.exclude, []);
  assert.deepEqual(input.changeKinds, ["create", "modify"]);
  assert.equal(input.enabled, true);
  assert.equal(input.debounceMs, DEFAULT_TRIGGER_DEBOUNCE_MS);
  assert.equal(input.cooldownMs, DEFAULT_TRIGGER_COOLDOWN_MS);
});

test("re-saving an existing trigger keeps its enabled flag and intervals", () => {
  const editing = storedTrigger({ type: "runSchedule", scheduleId: "schedule-1" });
  const input = buildDocumentTriggerInput(draft({ actionKind: "runSchedule", targetId: "schedule-9" }), editing);
  assert.equal(input.enabled, false);
  assert.equal(input.debounceMs, 500);
  assert.equal(input.cooldownMs, 90000);
  assert.deepEqual(input.action, { type: "runSchedule", scheduleId: "schedule-9" });
});

test("chat actions blank out empty optional fields and fold an unsupported approval mode", () => {
  const input = buildDocumentTriggerInput(draft({ source: "claude", approvalMode: "autoReview" }), null, { id: "skill-1", label: "s", detail: null, contentDigest: "abc" });
  assert.deepEqual(input.action, {
    type: "startChat",
    source: "claude",
    accountId: null,
    model: null,
    reasoningEffort: null,
    mode: "workspace",
    approvalMode: "manual",
    prompt: "변경 파일을 검토해줘",
    settings: {},
    skill: null,
  });
  const codex = buildDocumentTriggerInput(draft({ accountId: "acc-1", model: " gpt-5 ", reasoningEffort: "high" }), null);
  assert.equal(codex.action.approvalMode, "autoReview");
  assert.equal(codex.action.accountId, "acc-1");
  assert.equal(codex.action.model, "gpt-5");
  assert.equal(codex.action.reasoningEffort, "high");
});

test("a skill run pins the selected skill's digest; without a selection it saves no skill", () => {
  const selected = { id: "skill-1", label: "리뷰", detail: null, contentDigest: "digest-1" };
  const pinned = buildDocumentTriggerInput(draft({ actionKind: "runSkill", skillId: "skill-1" }), null, selected);
  assert.deepEqual(pinned.action.skill, { skillId: "skill-1", contentDigest: "digest-1" });
  const missingDigest = buildDocumentTriggerInput(draft({ actionKind: "runSkill" }), null, { ...selected, contentDigest: null });
  assert.deepEqual(missingDigest.action.skill, { skillId: "skill-1", contentDigest: "" });
  const unselected = buildDocumentTriggerInput(draft({ actionKind: "runSkill" }), null, undefined);
  assert.equal(unselected.action.skill, null);
});

test("a workflow action pins the catalog version and falls back to 0 when it is unknown", () => {
  const known = buildDocumentTriggerInput(draft({ actionKind: "executeWorkflow", targetId: "wf-1" }), null, undefined, { id: "wf-1", label: "w", detail: null, version: 3 });
  assert.deepEqual(known.action, { type: "executeWorkflow", workflowId: "wf-1", approvedVersion: 3, arguments: {} });
  const unknown = buildDocumentTriggerInput(draft({ actionKind: "executeWorkflow", targetId: "wf-1" }), null);
  assert.equal(unknown.action.approvedVersion, 0);
});

test("loading a stored chat trigger fills every chat field and resets the full-access acknowledgement", () => {
  const current = draft({ fullAccessAcknowledged: true, source: "codex" });
  const loaded = draftFromTrigger(storedTrigger({
    type: "startChat", source: "claude", accountId: "acc-2", model: "opus", reasoningEffort: "low",
    mode: "fullAccess", approvalMode: "never", prompt: "요약해줘", skill: { skillId: "skill-2", contentDigest: "d" },
  }), current);
  assert.equal(loaded.name, "저장된 트리거");
  assert.equal(loaded.rootId, "root-2");
  assert.equal(loaded.include, "src/**\ndocs/**");
  assert.equal(loaded.exclude, "node_modules/**");
  assert.deepEqual(loaded.changeKinds, ["delete"]);
  assert.equal(loaded.actionKind, "runSkill");
  assert.equal(loaded.targetId, "");
  assert.equal(loaded.source, "claude");
  assert.equal(loaded.accountId, "acc-2");
  assert.equal(loaded.model, "opus");
  assert.equal(loaded.reasoningEffort, "low");
  assert.equal(loaded.mode, "fullAccess");
  assert.equal(loaded.approvalMode, "never");
  assert.equal(loaded.prompt, "요약해줘");
  assert.equal(loaded.skillId, "skill-2");
  assert.equal(loaded.fullAccessAcknowledged, false);
  const plainChat = draftFromTrigger(storedTrigger({ type: "startChat", source: "codex", mode: "workspace", approvalMode: "manual", prompt: "p", skill: null }), current);
  assert.equal(plainChat.actionKind, "startChat");
  assert.equal(plainChat.accountId, "");
  assert.equal(plainChat.model, "");
  assert.equal(plainChat.reasoningEffort, "");
  assert.equal(plainChat.skillId, "");
});

test("loading a schedule or workflow trigger keeps the chat fields the screen already holds", () => {
  const current = draft({ source: "claude", accountId: "acc-keep", model: "keep", prompt: "keep", skillId: "keep" });
  const schedule = draftFromTrigger(storedTrigger({ type: "runSchedule", scheduleId: "schedule-3" }), current);
  assert.equal(schedule.actionKind, "runSchedule");
  assert.equal(schedule.targetId, "schedule-3");
  assert.equal(schedule.source, "claude");
  assert.equal(schedule.accountId, "acc-keep");
  assert.equal(schedule.model, "keep");
  assert.equal(schedule.prompt, "keep");
  assert.equal(schedule.skillId, "keep");
  const workflow = draftFromTrigger(storedTrigger({ type: "executeWorkflow", workflowId: "wf-3", approvedVersion: 2 }), current);
  assert.equal(workflow.actionKind, "executeWorkflow");
  assert.equal(workflow.targetId, "wf-3");
});

test("a stored chat trigger survives the load-then-save round trip without changing its intervals", () => {
  const stored = storedTrigger({
    type: "startChat", source: "codex", accountId: "acc-2", model: "gpt-5", reasoningEffort: "high",
    mode: "workspace", approvalMode: "granular", prompt: "검토", skill: null, settings: {},
  });
  const loaded = draftFromTrigger(stored, draft());
  const saved = buildDocumentTriggerInput(loaded, stored);
  const { id: _id, status: _s, statusReason: _r, createdAt: _c, updatedAt: _u, ...expected } = stored;
  assert.deepEqual(saved, expected);
});
