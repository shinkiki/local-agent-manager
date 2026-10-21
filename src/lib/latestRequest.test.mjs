import assert from "node:assert/strict";
import test from "node:test";
import { createLatestGate } from "./latestRequest.ts";

test("늦게 끝난 앞선 요청은 반영되지 않는다", () => {
  const gate = createLatestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(second(), true);
  assert.equal(first(), false);
});

test("새 요청이 없으면 계속 반영된다", () => {
  const gate = createLatestGate();
  const only = gate.begin();
  assert.equal(only(), true);
  assert.equal(only(), true);
});

test("문마다 순번이 따로다", () => {
  const a = createLatestGate();
  const b = createLatestGate();
  const fromA = a.begin();
  b.begin();
  assert.equal(fromA(), true);
});
