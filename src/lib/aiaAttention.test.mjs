import assert from "node:assert/strict";
import test from "node:test";
import { selectAiaAttention, withoutAiaAttention } from "./aiaAttention.ts";

const attention = (id, profile, kind, read = false) => ({ id, profile, kind, read });

test("AIA attention is removed from the general notification snapshot", () => {
  const snapshot = withoutAiaAttention({
    items: [
      attention("aia-approval", "aia", "approval"),
      attention("standard-completed", "standard", "completed"),
      attention("standard-approval", "standard", "approval"),
      attention("standard-read", "standard", "completed", true),
    ],
    unreadCount: 3,
    pendingCount: 2,
  });

  assert.deepEqual(snapshot.items.map((item) => item.id), [
    "standard-completed",
    "standard-approval",
    "standard-read",
  ]);
  assert.equal(snapshot.unreadCount, 2);
  assert.equal(snapshot.pendingCount, 1);
});

test("pending AIA approval takes priority over a completed response", () => {
  const selected = selectAiaAttention([
    attention("completed", "aia", "completed"),
    attention("approval", "aia", "approval"),
  ]);

  assert.equal(selected?.id, "approval");
});

test("AIA label ignores running and already read terminal items", () => {
  assert.equal(selectAiaAttention([
    attention("running", "aia", "running"),
    attention("read", "aia", "completed", true),
  ]), null);
  assert.equal(selectAiaAttention([
    attention("standard", "standard", "approval"),
    attention("failed", "aia", "failed"),
  ])?.id, "failed");
});
