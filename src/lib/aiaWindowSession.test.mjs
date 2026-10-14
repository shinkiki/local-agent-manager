import assert from "node:assert/strict";
import test from "node:test";
import { enableAiaWindowSessions, forgetAiaWindowSession, ownedAiaWindowChatId, rememberAiaWindowSession, selectAiaWindowSession } from "./aiaWindowSession.ts";

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
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

test("소유 판정은 살아 있는 대화 목록과 무관하게 이 창의 핀만 본다", () => {
  const shared = storage(), local = storage();
  assert.equal(ownedAiaWindowChatId(null, { shared, local }), null, "핀이 없으면 소유를 주장하지 않는다");

  rememberAiaWindowSession(shared, local, null, "main");
  rememberAiaWindowSession(shared, local, "a", "one");
  assert.equal(ownedAiaWindowChatId(null, { shared, local }), "main");
  assert.equal(ownedAiaWindowChatId("a", { shared, local }), "one");
  assert.equal(ownedAiaWindowChatId("b", { shared, local }), null, "다른 창의 대화는 제 것이 아니다");

  // 복원과 달리 목록을 보지 않는다 — 떼어 두고 계속 도는 대화도 그 창 것이다.
  assert.equal(ownedAiaWindowChatId(null, { shared, local }), "main");
});

test("떼어 낸 대화는 그 자리에서 소유를 잃는다", () => {
  // 핀이 남아 있으면 떼어 낸 대화의 알림이 일반 목록 대신 AIA 트리거로 가고, 트리거를
  // 누르면 방금 떠난 대화로 되돌아간다.
  const shared = storage(), local = storage();
  rememberAiaWindowSession(shared, local, null, "main");
  rememberAiaWindowSession(shared, local, "a", "one");

  forgetAiaWindowSession(shared, local, null);
  assert.equal(ownedAiaWindowChatId(null, { shared, local }), null);
  assert.equal(ownedAiaWindowChatId("a", { shared, local }), "one", "다른 창의 핀은 건드리지 않는다");
  // 핀이 사라져도 구버전 복원 갈래로 되돌아가지 않는다. 되돌아가면 "살아 있는 AIA 대화
  // 아무거나" 고르므로, 세션 화면에서 재개한 남의 대화를 집어 제 것으로 다시 적는다.
  // 이 창은 창별 세션을 켠 적이 없는 기본 상태다 — 그 상태가 바로 갈래가 살아 있는 자리다.
  assert.equal(selectAiaWindowSession(chats, shared, local, null), null);
});

test("저장소가 막히면 소유를 주장하지 않는다", () => {
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => {}, removeItem: () => {} };
  assert.equal(ownedAiaWindowChatId(null, { shared: blocked, local: blocked }), null);
  // 저장소 자체가 없는 실행(node)에서도 기본 인자가 던지지 않는다.
  assert.equal(ownedAiaWindowChatId(null), null);
});
