import assert from "node:assert/strict";
import test from "node:test";
import {
  aiaChatsForProvider,
  aiaRuntimeNeedsRestart,
  aiaRuntimeProvider,
  canRunSystemAgent,
  supportsAiaSystemTools,
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
