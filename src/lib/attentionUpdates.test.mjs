import assert from "node:assert/strict";
import test from "node:test";
import { createAttentionUpdates } from "./attentionUpdates.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("V4: optimistic state precedes transport and only a settled response replaces it", async () => {
  const updates = createAttentionUpdates();
  const reply = deferred();
  const events = [];
  const before = updates.pollGuard();
  const done = updates.mutate(
    () => events.push("optimistic"),
    () => { events.push("request"); return reply.promise; },
    value => events.push(value),
  );
  assert.deepEqual(events, ["optimistic", "request"]);
  assert.equal(before(), false);
  assert.equal(updates.pollGuard()(), false);
  reply.resolve("server");
  assert.equal(await done, true);
  assert.deepEqual(events, ["optimistic", "request", "server"]);
  assert.equal(before(), false, "a poll started before the mutation remains obsolete");
  assert.equal(updates.pollGuard()(), true);
});

test("V4: both completion orders preserve the newest mutation and wait for all pending work", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const updates = createAttentionUpdates();
    const replies = [deferred(), deferred()];
    const applied = [];
    const done = replies.map((reply, i) => updates.mutate(
      () => applied.push("optimistic-" + i),
      () => reply.promise,
      value => applied.push(value),
    ));
    const guard = updates.pollGuard();
    assert.equal(guard(), false);
    const [first, second] = order;
    replies[first].resolve("server-" + first);
    assert.equal(await done[first], true);
    assert.equal(guard(), false, "the other request still blocks polling");
    replies[second].resolve("server-" + second);
    assert.equal(await done[second], true);
    assert.deepEqual(applied, ["optimistic-0", "optimistic-1", "server-1"]);
    assert.equal(guard(), true);
  }
});

test("V4: a failed newest mutation does not revive an older response and polling recovers", async () => {
  const updates = createAttentionUpdates();
  const old = deferred(), latest = deferred();
  const applied = [];
  const before = updates.pollGuard();
  const first = updates.mutate(() => applied.push("old optimistic"), () => old.promise, value => applied.push(value));
  const second = updates.mutate(() => applied.push("new optimistic"), () => latest.promise, value => applied.push(value));
  latest.reject(new Error("transport unavailable"));
  assert.equal(await second, false);
  assert.equal(updates.pollGuard()(), false);
  old.resolve("obsolete server snapshot");
  assert.equal(await first, true);
  assert.deepEqual(applied, ["old optimistic", "new optimistic"]);
  assert.equal(before(), false);
  assert.equal(updates.pollGuard()(), true);
});

test("V4: an older failure cannot overwrite the newest success or keep polling blocked", async () => {
  const updates = createAttentionUpdates();
  const old = deferred(), latest = deferred();
  const applied = [];
  const first = updates.mutate(() => {}, () => old.promise, value => applied.push(value));
  const second = updates.mutate(() => {}, () => latest.promise, value => applied.push(value));
  latest.resolve("latest");
  assert.equal(await second, true);
  old.reject(new Error("old request failed"));
  assert.equal(await first, false);
  assert.deepEqual(applied, ["latest"]);
  const guard = updates.pollGuard();
  assert.equal(guard(), true);
  const next = updates.mutate(() => {}, () => Promise.resolve("next"), value => applied.push(value));
  assert.equal(guard(), false);
  assert.equal(await next, true);
  assert.deepEqual(applied, ["latest", "next"]);
});

test("V4: separate attention centers never invalidate each other's requests", async () => {
  const first = createAttentionUpdates(), second = createAttentionUpdates();
  const untouched = second.pollGuard();
  const pending = deferred();
  const done = first.mutate(() => {}, () => pending.promise, () => {});
  assert.equal(untouched(), true);
  assert.equal(first.pollGuard()(), false);
  pending.resolve({});
  await done;
  assert.equal(first.pollGuard()(), true);
  assert.equal(untouched(), true);
});
