import assert from "node:assert/strict";
import test from "node:test";
import { enableAiaWindowSessions, rememberAiaWindowSession, selectAiaWindowSession } from "./aiaWindowSession.ts";

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const chats = [{ chatId: "main", state: "ready" }, { chatId: "one", state: "ready" }, { chatId: "two", state: "waitingApproval" }];

test("main and independent windows restore only their own conversations", () => {
  const shared = storage(), local = storage();
  rememberAiaWindowSession(shared, local, null, "main");
  enableAiaWindowSessions(shared);
  rememberAiaWindowSession(shared, local, "a", "one");
  rememberAiaWindowSession(shared, local, "b", "two");
  assert.equal(selectAiaWindowSession(chats, shared, local, null)?.chatId, "main");
  assert.equal(selectAiaWindowSession(chats, shared, local, "a")?.chatId, "one");
  assert.equal(selectAiaWindowSession(chats, shared, local, "b")?.chatId, "two");
  assert.equal(selectAiaWindowSession(chats, shared, local, "new"), null);
  assert.equal(selectAiaWindowSession(chats.filter((c) => c.chatId !== "one"), shared, local, "a"), null);
});

test("legacy main restoration stops once independent windows are enabled", () => {
  const shared = storage(), local = storage();
  assert.equal(selectAiaWindowSession(chats, shared, local, null)?.chatId, "two");
  assert.equal(selectAiaWindowSession(chats, shared, local, "new"), null);
  enableAiaWindowSessions(shared);
  assert.equal(selectAiaWindowSession(chats, shared, local, null), null);
});

test("storage failures never cause a fallback to another conversation", () => {
  const broken = { getItem() { throw new Error("storage denied"); } };
  assert.equal(selectAiaWindowSession(chats, broken, broken, null), null);
  assert.equal(selectAiaWindowSession(chats, broken, broken, "a"), null);
});
