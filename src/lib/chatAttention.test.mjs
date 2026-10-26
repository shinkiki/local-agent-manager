import assert from "node:assert/strict";
import test from "node:test";
import {
  clearReadAttentionLocally,
  dismissAttentionLocally,
  markAllAttentionReadLocally,
  markAttentionReadLocally,
  recountAttention,
} from "./chatAttention.ts";

const attention = (id, profile, kind, read = false, chatId = id) => ({ id, profile, kind, read, chatId });
const snapshot = (items) => recountAttention(items);

test("counts treat approvals as unread and pending", () => {
  const counted = recountAttention([
    attention("a", "standard", "approval", true),
    attention("b", "standard", "completed"),
    attention("c", "standard", "completed", true),
  ]);
  assert.equal(counted.unreadCount, 2);
  assert.equal(counted.pendingCount, 1);
});

test("marking all read skips approvals and excluded profiles", () => {
  const next = markAllAttentionReadLocally(snapshot([
    attention("standard-unread", "standard", "completed"),
    attention("standard-failed", "standard", "failed"),
    attention("standard-approval", "standard", "approval"),
    attention("aia-unread", "aia", "completed"),
  ]), ["aia"]);

  assert.deepEqual(
    next.items.filter((item) => item.read).map((item) => item.id),
    ["standard-unread", "standard-failed"],
  );
  // 남은 미읽음은 AIA 하나, 승인 대기는 읽음 여부와 무관하게 미읽음으로 센다.
  assert.equal(next.unreadCount, 2);
  assert.equal(next.pendingCount, 1);
});

test("marking all read without exclusions covers every profile", () => {
  const next = markAllAttentionReadLocally(snapshot([
    attention("aia-unread", "aia", "completed"),
    attention("standard-unread", "standard", "completed"),
  ]));
  assert.deepEqual(next.items.map((item) => item.read), [true, true]);
  assert.equal(next.unreadCount, 0);
  assert.equal(markAllAttentionReadLocally(next), next);
});

test("marking all read skips only the hidden AIA chat", () => {
  const next = markAllAttentionReadLocally(snapshot([
    attention("hidden-aia", "aia", "completed"),
    attention("visible-aia", "aia", "completed"),
  ]), [], ["hidden-aia"]);
  assert.deepEqual(next.items.map((item) => item.read), [false, true]);
  assert.equal(next.unreadCount, 1);
});

test("숨긴 대화의 알림은 id 가 새로 생겨도 함께 보존된다", () => {
  // 마지막 폴링 뒤에 끝난 턴은 `turn:<대화>:<턴>` 꼴의 새 알림 id 를 달고 나온다. 알림
  // id 로 거르던 동안에는 그 알림이 목록에 보이지도 않은 채 읽음 처리돼, 트리거 말풍선이
  // 영영 뜨지 않았다. 대화 id 는 그 사이에 바뀌지 않는다.
  const next = markAllAttentionReadLocally(snapshot([
    attention("turn:own:latest", "aia", "completed", false, "own-chat"),
    attention("turn:other:latest", "aia", "completed", false, "other-chat"),
  ]), [], ["own-chat"]);
  assert.deepEqual(next.items.map((item) => item.read), [false, true]);
  assert.equal(next.unreadCount, 1);
});

test("marking one read leaves the rest and returns the same snapshot when nothing changes", () => {
  const current = snapshot([
    attention("target", "standard", "completed"),
    attention("other", "standard", "completed"),
  ]);
  const next = markAttentionReadLocally(current, "target");
  assert.deepEqual(next.items.map((item) => item.read), [true, false]);
  assert.equal(next.unreadCount, 1);

  assert.equal(markAttentionReadLocally(next, "target"), next);
  assert.equal(markAttentionReadLocally(next, "missing"), next);
  assert.equal(
    markAttentionReadLocally(snapshot([attention("ap", "standard", "approval")]), "ap").items[0].read,
    false,
  );
});

test("clearing read keeps unread, running and approval items", () => {
  const next = clearReadAttentionLocally(snapshot([
    attention("read-completed", "standard", "completed", true),
    attention("read-failed", "standard", "failed", true),
    attention("read-running", "standard", "running", true),
    attention("read-approval", "standard", "approval", true),
    attention("unread", "standard", "completed"),
  ]));

  assert.deepEqual(next.items.map((item) => item.id), ["read-running", "read-approval", "unread"]);
  assert.equal(next.unreadCount, 2);
  assert.equal(next.pendingCount, 1);

  // 지울 것이 없으면 같은 스냅숏을 그대로 돌려준다(다른 갈래와 같은 규칙).
  assert.equal(clearReadAttentionLocally(next), next);
});

test("clearing read keeps a read round decision like the server does", () => {
  // 서버 clear_read 는 열린 종류(running·approval·roundDecision)를 남긴다. 화면이 먼저
  // 걷어내면 답할 결정이 응답이 올 때까지 사라졌다가 다시 나타난다.
  const next = clearReadAttentionLocally(snapshot([
    attention("read-decision", "standard", "roundDecision", true, ""),
    attention("read-switch", "standard", "accountSwitch", true, ""),
  ]));

  assert.deepEqual(next.items.map((item) => item.id), ["read-decision"]);
});

test("dismiss removes one item but refuses approvals and unknown ids", () => {
  const current = snapshot([
    attention("completed", "standard", "completed"),
    attention("approval", "standard", "approval"),
  ]);

  const next = dismissAttentionLocally(current, "completed");
  assert.deepEqual(next.items.map((item) => item.id), ["approval"]);
  assert.equal(next.unreadCount, 1);

  assert.equal(dismissAttentionLocally(current, "approval"), current);
  assert.equal(dismissAttentionLocally(current, "missing"), current);
});
