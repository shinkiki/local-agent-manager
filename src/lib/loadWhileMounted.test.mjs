import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { loadWhileMounted } from "./loadWhileMounted.ts";

function pending() {
  return Promise.withResolvers();
}

test("V2: an active settings read forwards its result once", async () => {
  const request = pending();
  const values = [];
  const errors = [];
  const result = { port: 12345 };
  let calls = 0;
  loadWhileMounted(() => { calls += 1; return request.promise; }, value => values.push(value), error => errors.push(error));
  assert.equal(calls, 1);
  assert.deepEqual(values, []);
  request.resolve(result);
  await setImmediate();
  assert.deepEqual(values, [result]);
  assert.equal(values[0], result);
  assert.deepEqual(errors, []);
});

test("V2: an active settings read formats Error and non-Error failures", async () => {
  for (const cause of [new Error("read failed"), "read failed"]) {
    const values = [];
    const errors = [];
    loadWhileMounted(() => Promise.reject(cause), value => values.push(value), error => errors.push(error));
    await setImmediate();
    assert.deepEqual(values, []);
    assert.deepEqual(errors, ["read failed"]);
  }
});

test("V2: cleanup suppresses both successful and failed late settings reads", async () => {
  for (const rejected of [false, true]) {
    const request = pending();
    const values = [];
    const errors = [];
    const cleanup = loadWhileMounted(() => request.promise, value => values.push(value), error => errors.push(error));
    cleanup();
    cleanup();
    if (rejected) request.reject(new Error("late read"));
    else request.resolve({ port: 12345 });
    await setImmediate();
    assert.deepEqual(values, []);
    assert.deepEqual(errors, []);
  }
});

test("V2: cleanup before the next microtask suppresses an already settled result", async () => {
  const values = [];
  const cleanup = loadWhileMounted(() => Promise.resolve("cached"), value => values.push(value));
  cleanup();
  await setImmediate();
  assert.deepEqual(values, []);
});

test("V2: a disposed read cannot replace a later active settings read", async () => {
  const oldRead = pending();
  const newRead = pending();
  const values = [];
  const errors = [];
  const apply = value => values.push(value);
  const fail = error => errors.push(error);
  const leave = loadWhileMounted(() => oldRead.promise, apply, fail);
  leave();
  loadWhileMounted(() => newRead.promise, apply, fail);
  newRead.resolve("new settings");
  await setImmediate();
  oldRead.resolve("old settings");
  await setImmediate();
  assert.deepEqual(values, ["new settings"]);
  assert.deepEqual(errors, []);
});

test("V2: an omitted failure handler still consumes a failed settings read", async () => {
  const values = [];
  loadWhileMounted(() => Promise.reject(new Error("read failed")), value => values.push(value));
  await setImmediate();
  assert.deepEqual(values, []);
});

test("V2: a result callback failure follows the existing error path", async () => {
  const errors = [];
  loadWhileMounted(() => Promise.resolve("settings"), () => { throw new Error("apply failed"); }, error => errors.push(error));
  await setImmediate();
  assert.deepEqual(errors, ["apply failed"]);
});
