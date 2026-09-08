import assert from "node:assert/strict";
import test from "node:test";

import { adoptFoundSession, resolveAttentionRoute } from "./attentionRoute.ts";

const item = { chatId: "chat-1", providerSessionId: "sess-1" };

const deps = (overrides = {}) => ({
  findIndexedSession: () => null,
  syncSessionCatalog: () => Promise.resolve(),
  findActiveChatId: () => Promise.resolve(null),
  ...overrides,
});

test("공급자 세션 기록이 없는 알림은 붙어 있는 채팅으로 바로 연다", async () => {
  let syncCalls = 0;
  const route = await resolveAttentionRoute({ chatId: "chat-1", providerSessionId: null }, deps({
    syncSessionCatalog: () => { syncCalls += 1; return Promise.resolve(); },
  }));
  assert.deepEqual(route, { kind: "chat", chatId: "chat-1" });
  assert.equal(syncCalls, 0);
});

test("색인된 세션이 있으면 동기화 없이 세션 화면으로 연다", async () => {
  const session = { id: "sess-1" };
  let syncCalls = 0;
  const route = await resolveAttentionRoute(item, deps({
    findIndexedSession: () => session,
    syncSessionCatalog: () => { syncCalls += 1; return Promise.resolve(); },
  }));
  assert.deepEqual(route, { kind: "session", session });
  assert.equal(syncCalls, 0);
});

test("유예 안에 색인되면 세션 화면으로 연다", async () => {
  const session = { id: "sess-1" };
  let lookups = 0;
  const route = await resolveAttentionRoute(item, deps({
    findIndexedSession: () => ((lookups += 1) >= 2 ? session : null),
  }));
  assert.deepEqual(route, { kind: "session", session });
});

test("색인 전이라도 살아 있는 런타임이 있으면 그 채팅으로 연다", async () => {
  const route = await resolveAttentionRoute(item, deps({
    findActiveChatId: () => Promise.resolve("chat-live"),
  }));
  assert.deepEqual(route, { kind: "chat", chatId: "chat-live" });
});

test("런타임 확인이 실패하면 기존대로 알림의 채팅으로 연다", async () => {
  const route = await resolveAttentionRoute(item, deps({
    findActiveChatId: () => Promise.reject(new Error("백엔드 연결 실패")),
  }));
  assert.deepEqual(route, { kind: "chat", chatId: "chat-1" });
});

test("런타임이 없으면 색인 예산을 끝까지 기다려 세션으로 연다", async () => {
  const session = { id: "sess-1" };
  let synced = false;
  const route = await resolveAttentionRoute(item, deps({
    findIndexedSession: () => (synced ? session : null),
    // 유예(300ms)를 넘겨 끝나는 동기화. 유예만 기다렸다면 세션을 찾지 못한다.
    syncSessionCatalog: () => new Promise((resolve) => {
      setTimeout(() => { synced = true; resolve(undefined); }, 320);
    }),
  }));
  assert.deepEqual(route, { kind: "session", session });
});

test("런타임도 색인도 없으면 실행 종료로 안내한다", async () => {
  const route = await resolveAttentionRoute(item, deps());
  assert.deepEqual(route, { kind: "ended" });
});

test("클릭 시점의 선택이 유지됐으면 찾은 세션을 채택한다", () => {
  const atClick = { id: "before" };
  const found = { id: "sess-1" };
  assert.equal(adoptFoundSession(atClick, atClick, found), found);
  assert.equal(adoptFoundSession(null, null, found), found);
});

test("기다리는 동안 선택을 바꿨으면(다른 세션·선택 해제) 빼앗지 않는다", () => {
  const other = { id: "other" };
  assert.equal(adoptFoundSession(other, { id: "before" }, { id: "sess-1" }), other);
  assert.equal(adoptFoundSession(null, { id: "before" }, { id: "sess-1" }), null);
});
