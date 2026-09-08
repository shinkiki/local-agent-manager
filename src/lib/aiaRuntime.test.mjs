import assert from "node:assert/strict";
import test from "node:test";
import {
  AIA_RUNTIME_DEFAULTS,
  aiaChatsForProvider,
  aiaRuntimeNeedsRestart,
  aiaRuntimeProvider,
  aiaRuntimeSettings,
  canRunSystemAgent,
  sameAiaRuntimeSettings,
  supportsAiaSystemTools,
  systemAgentRuntimePatch,
} from "./aiaRuntime.ts";

const automation = (systemProvider) => ({ settings: { systemProvider } });

test("the AIA runtime follows the selected system agent", () => {
  assert.equal(aiaRuntimeProvider(automation("claude")), "claude");
  assert.equal(aiaRuntimeProvider(automation("codex")), "codex");
});

test("an unset system agent disables AIA instead of picking a runtime", () => {
  assert.equal(aiaRuntimeProvider(automation(null)), null);
  assert.equal(aiaRuntimeProvider(null), null);
});

test("a stored Antigravity selection disables AIA instead of running it there", () => {
  assert.equal(aiaRuntimeProvider(automation("antigravity")), null);
});

test("Antigravity cannot be offered as a system agent", () => {
  assert.equal(canRunSystemAgent("codex"), true);
  assert.equal(canRunSystemAgent("claude"), true);
  assert.equal(canRunSystemAgent("antigravity"), false);
});

test("only runtimes with per-run MCP configuration expose AIA system tools", () => {
  assert.equal(supportsAiaSystemTools("codex"), true);
  assert.equal(supportsAiaSystemTools("claude"), true);
  assert.equal(supportsAiaSystemTools("antigravity"), false);
});

test("restoring ignores AIA chats left on another provider", () => {
  const chats = [
    { chatId: "old", source: "codex" },
    { chatId: "current", source: "claude" },
  ];
  assert.deepEqual(
    aiaChatsForProvider(chats, "claude").map((chat) => chat.chatId),
    ["current"],
  );
  assert.deepEqual(aiaChatsForProvider(chats, "antigravity"), []);
});

test("a live runtime on the wrong provider must be restarted", () => {
  assert.equal(aiaRuntimeNeedsRestart({ source: "codex" }, "claude"), true);
  assert.equal(aiaRuntimeNeedsRestart({ source: "claude" }, "claude"), false);
  assert.equal(aiaRuntimeNeedsRestart(null, "claude"), false);
});

test("a live runtime started with other run settings must be restarted", () => {
  const stored = aiaRuntimeSettings(undefined, "codex");
  const session = { source: "codex", aiaRuntime: stored };
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", stored), false);
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", { ...stored, mode: "fullAccess" }), true);
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", { ...stored, approvalMode: "autoReview" }), true);
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", { ...stored, decisionPolicy: "recommended" }), true);
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", { ...stored, model: "gpt-5.6-sol" }), true);
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", { ...stored, reasoningEffort: "high" }), true);
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", { ...stored, settings: { fallbackModel: "gpt-5.6" } }), true);
});

test("the cursor click policy is read per click, so it never restarts the conversation", () => {
  const stored = aiaRuntimeSettings(undefined, "codex");
  const session = { source: "codex", aiaRuntime: stored };
  assert.equal(aiaRuntimeNeedsRestart(session, "codex", { ...stored, uiClickPolicy: "all" }), false);
  // 저장 버튼은 그대로 이 항목의 변경을 알아봐야 한다.
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, uiClickPolicy: "all" }), false);
});

test("a conversation started before run settings were recorded is left alone", () => {
  const stored = aiaRuntimeSettings(undefined, "codex");
  assert.equal(aiaRuntimeNeedsRestart({ source: "codex" }, "codex", { ...stored, mode: "fullAccess" }), false);
  // 비교할 저장본을 넘기지 않으면 공급자만 따진다.
  assert.equal(aiaRuntimeNeedsRestart({ source: "codex", aiaRuntime: stored }, "codex"), false);
});

test("restoring skips AIA chats started with stale run settings", () => {
  const stored = aiaRuntimeSettings(undefined, "codex");
  const chats = [
    { chatId: "stale", source: "codex", aiaRuntime: { ...stored, mode: "fullAccess" } },
    { chatId: "current", source: "codex", aiaRuntime: stored },
  ];
  assert.deepEqual(aiaChatsForProvider(chats, "codex", stored).map((chat) => chat.chatId), ["current"]);
  assert.deepEqual(aiaChatsForProvider(chats, "codex").map((chat) => chat.chatId), ["stale", "current"]);
});

test("a provider without stored run settings keeps the previous AIA defaults", () => {
  assert.deepEqual(aiaRuntimeSettings(undefined, "claude"), {
    model: null,
    reasoningEffort: "medium",
    mode: "workspace",
    approvalMode: "manual",
    decisionPolicy: "ask",
    uiClickPolicy: "openers",
    settings: {},
  });
  assert.deepEqual(aiaRuntimeSettings({}, "codex"), aiaRuntimeSettings(undefined, "codex"));
  // 기본값 객체를 그대로 넘겨주면 편집 상태가 공유되므로 매번 새 객체여야 한다.
  assert.notEqual(aiaRuntimeSettings(undefined, "codex").settings, AIA_RUNTIME_DEFAULTS.settings);
});

test("stored run settings are read per provider and may fall back to provider defaults", () => {
  const runtimes = {
    claude: { model: "claude-opus-5", reasoningEffort: null, mode: "plan", approvalMode: "never", decisionPolicy: "recommended", settings: { fallbackModel: "claude-sonnet-5" } },
  };
  assert.deepEqual(aiaRuntimeSettings(runtimes, "claude"), {
    model: "claude-opus-5",
    reasoningEffort: null,
    mode: "plan",
    approvalMode: "never",
    decisionPolicy: "recommended",
    uiClickPolicy: "openers",
    settings: { fallbackModel: "claude-sonnet-5" },
  });
  // 저장하지 않은 공급자는 다른 공급자의 모델·동적 설정을 물려받지 않는다.
  assert.deepEqual(aiaRuntimeSettings(runtimes, "codex"), {
    model: null,
    reasoningEffort: "medium",
    mode: "workspace",
    approvalMode: "manual",
    decisionPolicy: "ask",
    uiClickPolicy: "openers",
    settings: {},
  });
});

test("saving one provider keeps the other provider's run settings", () => {
  const runtimes = { codex: { mode: "workspace", approvalMode: "autoReview", model: null, reasoningEffort: "high", decisionPolicy: "ask", settings: {} } };
  const next = systemAgentRuntimePatch(runtimes, "claude", {
    model: "  claude-opus-5  ",
    reasoningEffort: null,
    mode: "plan",
    approvalMode: "manual",
    decisionPolicy: "recommended",
    uiClickPolicy: "openers",
    settings: { fallbackModel: " claude-sonnet-5 ", blank: "   " },
  });
  assert.deepEqual(next.codex, runtimes.codex);
  assert.deepEqual(next.claude, {
    model: "claude-opus-5",
    reasoningEffort: null,
    mode: "plan",
    approvalMode: "manual",
    decisionPolicy: "recommended",
    uiClickPolicy: "openers",
    settings: { fallbackModel: "claude-sonnet-5" },
  });
});

test("an empty model or dynamic value means the provider default", () => {
  const next = systemAgentRuntimePatch({}, "claude", {
    model: "   ",
    reasoningEffort: "medium",
    mode: "workspace",
    approvalMode: "manual",
    decisionPolicy: "ask",
    uiClickPolicy: "openers",
    settings: {},
  });
  assert.equal(next.claude.model, null);
  assert.deepEqual(next.claude.settings, {});
});

test("only a real change enables saving the run settings", () => {
  const stored = aiaRuntimeSettings(undefined, "claude");
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, settings: {} }), true);
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, model: "  " }), true);
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, settings: { fallbackModel: "   " } }), true);
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, mode: "plan" }), false);
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, reasoningEffort: null }), false);
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, decisionPolicy: "recommended" }), false);
  assert.equal(sameAiaRuntimeSettings(stored, { ...stored, settings: { fallbackModel: "claude-sonnet-5" } }), false);
});

test("a saved runtime from before the decision option keeps asking the user", () => {
  const runtimes = { claude: { model: null, reasoningEffort: "high", mode: "fullAccess", approvalMode: "never", settings: {} } };
  assert.equal(aiaRuntimeSettings(runtimes, "claude").decisionPolicy, "ask");
});
