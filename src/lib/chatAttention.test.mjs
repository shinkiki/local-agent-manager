import assert from "node:assert/strict";
import test from "node:test";
import {
  clearReadAttentionLocally,
  dismissAttentionLocally,
  markAllAttentionReadLocally,
  markAttentionReadLocally,
  recountAttention,
} from "./chatAttention.ts";

const attention = (id, profile, kind, read = false) => ({ id, profile, kind, read });
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
