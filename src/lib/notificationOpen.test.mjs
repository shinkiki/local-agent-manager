import assert from "node:assert/strict";
import test from "node:test";
import {
  findNotificationOpenItem,
  parseNotificationOpenMessage,
  parseNotificationOpenSearch,
  stripNotificationOpenSearch,
} from "./notificationOpen.ts";

/**
 * `public/sw.js`의 `OPEN_ATTENTION_MESSAGE`에 적힌 글자 그대로. 모듈이 들고 있는 값을
 * 가져다 쓰면 둘이 함께 틀려도 통과하므로, 짝을 맞춰야 하는 쪽의 문자열을 여기 적는다.
 */
const NOTIFICATION_OPEN_MESSAGE = "agent-manager.open-attention";

test("service worker open message yields the target", () => {
  assert.deepEqual(
    parseNotificationOpenMessage({ type: NOTIFICATION_OPEN_MESSAGE, target: { attentionId: "att-1", chatId: "chat-1" } }),
    { attentionId: "att-1", chatId: "chat-1" },
  );
});

test("other messages and malformed targets are ignored", () => {
  assert.equal(parseNotificationOpenMessage({ type: "agent-manager.stale-shell" }), null);
  assert.equal(parseNotificationOpenMessage({ type: NOTIFICATION_OPEN_MESSAGE }), null);
  assert.equal(parseNotificationOpenMessage({ type: NOTIFICATION_OPEN_MESSAGE, target: { attentionId: 1, chatId: "c" } }), null);
  assert.equal(parseNotificationOpenMessage({ type: NOTIFICATION_OPEN_MESSAGE, target: { attentionId: "a b", chatId: "c" } }), null);
  assert.equal(parseNotificationOpenMessage({ type: NOTIFICATION_OPEN_MESSAGE, target: { attentionId: "", chatId: "c" } }), null);
  // 계정 전환 알림은 채팅이 없다. 빈 채팅 ID는 유효한 대상이다.
  assert.deepEqual(
    parseNotificationOpenMessage({ type: NOTIFICATION_OPEN_MESSAGE, target: { attentionId: "account-switch:codex:1", chatId: "" } }),
    { attentionId: "account-switch:codex:1", chatId: "" },
  );
  assert.equal(parseNotificationOpenMessage(null), null);
});

test("new-window search carries the same target and can be stripped", () => {
  const search = "?open-attention=att-1&open-chat=chat-1&theme=dark";
  assert.deepEqual(parseNotificationOpenSearch(search), { attentionId: "att-1", chatId: "chat-1" });
  assert.equal(stripNotificationOpenSearch(search), "?theme=dark");
  assert.equal(stripNotificationOpenSearch("?open-attention=att-1&open-chat=chat-1"), "");
  assert.equal(parseNotificationOpenSearch("?open-attention=att-1"), null);
  assert.equal(parseNotificationOpenSearch(""), null);
});

test("target resolves to the attention item by id, or null once it is gone", () => {
  const items = [{ id: "att-1", chatId: "chat-1" }, { id: "att-2", chatId: "chat-1" }];
  assert.equal(findNotificationOpenItem({ attentionId: "att-2", chatId: "chat-1" }, items), items[1]);
  assert.equal(findNotificationOpenItem({ attentionId: "att-9", chatId: "chat-1" }, items), null);
});
