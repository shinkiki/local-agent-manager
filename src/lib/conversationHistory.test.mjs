import assert from "node:assert/strict";
import test from "node:test";
import { HISTORY_LIMIT, restoreConversation, visitConversation } from "./conversationHistory.ts";

const initial = () => ({ entries: [{ view: "sessions" }], cursor: 0 });
const a = { view: "sessions", source: "codex", sessionId: "a" };
const b = { view: "chat", source: "claude", chatId: "b", sessionId: null };

test("back/forward preserves cross-view entries and a new visit drops forward history", () => {
  const history = visitConversation(visitConversation(initial(), a), b);
  const back = restoreConversation(history, 1, a);
  assert.equal(back.cursor, 1);
  assert.deepEqual(restoreConversation(back, 2, b).entries, history.entries);
  const branch = visitConversation(back, { ...a, sessionId: "c" });
  assert.deepEqual(branch.entries, [{ view: "sessions" }, a, { ...a, sessionId: "c" }]);
});

test("polls do not duplicate visits; late session IDs refresh the terminated-chat fallback", () => {
  const history = visitConversation(initial(), b);
  assert.equal(visitConversation(history, b), history);
  const updated = visitConversation(history, { ...b, sessionId: "provider-b" });
  assert.equal(updated.entries.length, 2);
  assert.equal(updated.entries[1].sessionId, "provider-b");
  assert.equal(restoreConversation(updated, -1, a), updated);
});

test("G7 navigation is bounded and separate histories never share mutable entries", () => {
  let history = initial();
  for (let i = 0; i < 100; i++) history = visitConversation(history, { ...a, sessionId: String(i) });
  assert.equal(history.entries.length, HISTORY_LIMIT);
  assert.equal(history.cursor, HISTORY_LIMIT - 1);
  assert.deepEqual(initial(), { entries: [{ view: "sessions" }], cursor: 0 });
});
