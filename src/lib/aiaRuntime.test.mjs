import assert from "node:assert/strict";
import test from "node:test";
import {
  AIA_RUNTIME_DEFAULTS,
  aiaChatsForProvider,
  aiaRuntimeNeedsRestart,
  aiaRuntimeProvider,
  aiaRuntimeSettings,
  aiaStaleSendAction,
  canRunSystemAgent,
  sameAiaRuntimeSettings,
  supportsAiaSystemTools,
  systemAgentRuntimePatch,
} from "./aiaRuntime.ts";

const automation = (systemProvider) => ({ settings: { systemProvider } });

/**
 * 실행설정 한 벌. 일곱 칸을 모두 갖춘 객체를 시험 여섯 자리가 각자 손으로 적고 있었다.
 * 그중 다섯 자리는 한두 칸만 달랐는데도 나머지를 함께 베껴 두어, 무엇을 보려는
 * 시험인지가 같은 줄 일곱 개에 묻혔다. 칸이 하나 늘면 여섯 자리를 함께 고쳐야 하고,
 * 그중 하나를 빠뜨리면 `deepEqual`이 그 시험에서만 깨져 새 칸과 무관한 자리가 붉어진다.
 *
 * 기본값에서 시작해 이 시험이 실제로 보는 칸만 덮어쓴다. 동적 설정은 매번 새로 떠서
 * 기본값 객체가 시험 사이로 새지 않게 한다 — `aiaRuntimeSettings`가 지키는 규칙과 같다.
 *
 * 기본값 자체를 못박는 시험(아래 "a provider without stored run settings...")만은 일곱
 * 칸을 그대로 적어 둔다. 그 자리가 이 도우미를 쓰면 기본값이 바뀌어도 늘 통과한다.
 */
const runtime = (overrides = {}) => ({ ...AIA_RUNTIME_DEFAULTS, settings: {}, ...overrides });

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
    localConnectionId: null,
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
  assert.deepEqual(aiaRuntimeSettings(runtimes, "claude"), runtime({
    model: "claude-opus-5",
    reasoningEffort: null,
    mode: "plan",
    approvalMode: "never",
    decisionPolicy: "recommended",
    settings: { fallbackModel: "claude-sonnet-5" },
  }));
  // 저장하지 않은 공급자는 다른 공급자의 모델·동적 설정을 물려받지 않는다.
  assert.deepEqual(aiaRuntimeSettings(runtimes, "codex"), runtime());
});

test("saving one provider keeps the other provider's run settings", () => {
  const runtimes = { codex: { mode: "workspace", approvalMode: "autoReview", model: null, reasoningEffort: "high", decisionPolicy: "ask", settings: {} } };
  const next = systemAgentRuntimePatch(runtimes, "claude", runtime({
    model: "  claude-opus-5  ",
    reasoningEffort: null,
    mode: "plan",
    decisionPolicy: "recommended",
    settings: { fallbackModel: " claude-sonnet-5 ", blank: "   " },
  }));
  assert.deepEqual(next.codex, runtimes.codex);
  assert.deepEqual(next.claude, runtime({
    model: "claude-opus-5",
    reasoningEffort: null,
    mode: "plan",
    decisionPolicy: "recommended",
    settings: { fallbackModel: "claude-sonnet-5" },
  }));
});

test("an empty model or dynamic value means the provider default", () => {
  const next = systemAgentRuntimePatch({}, "claude", runtime({ model: "   " }));
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

test("a request never goes into a runtime started with other settings", () => {
  assert.equal(aiaStaleSendAction(false, "ready"), "send");
  assert.equal(aiaStaleSendAction(false, "running"), "send");
  // 어긋난 대화는 보내는 그 자리에서 정지하고 새 설정으로 다시 시작한다.
  assert.equal(aiaStaleSendAction(true, "ready"), "restart");
  assert.equal(aiaStaleSendAction(true, "connecting"), "restart");
  assert.equal(aiaStaleSendAction(true, "stopped"), "restart");
  assert.equal(aiaStaleSendAction(true, "failed"), "restart");
});

test("an in-flight turn or a pending approval is neither cut off nor written into", () => {
  assert.equal(aiaStaleSendAction(true, "running"), "blocked");
  assert.equal(aiaStaleSendAction(true, "waitingApproval"), "blocked");
});
