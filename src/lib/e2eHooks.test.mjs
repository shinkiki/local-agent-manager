import assert from "node:assert/strict";
import test from "node:test";
import { E2E_HOOKS_KEY, e2eHooksEnabled, installE2eHooks } from "./e2eHooks.ts";

function storageWith(entries) {
  return { getItem: (key) => (key in entries ? entries[key] : null) };
}

test("플래그가 정확히 \"1\"일 때만 켜진다", () => {
  assert.equal(e2eHooksEnabled(storageWith({ [E2E_HOOKS_KEY]: "1" })), true);
  assert.equal(e2eHooksEnabled(storageWith({ [E2E_HOOKS_KEY]: "true" })), false);
  assert.equal(e2eHooksEnabled(storageWith({ [E2E_HOOKS_KEY]: "0" })), false);
  assert.equal(e2eHooksEnabled(storageWith({})), false);
});

test("storage 접근이 예외를 내면 꺼진 것으로 본다", () => {
  const throwing = { getItem() { throw new Error("SecurityError"); } };
  assert.equal(e2eHooksEnabled(throwing), false);
  // 기본 인자는 window.localStorage인데 Node에는 window가 없다 — ReferenceError도 false로 삼킨다.
  assert.equal(e2eHooksEnabled(), false);
});

test("설치하면 window에 붙고 제거 함수가 떼어 낸다", () => {
  const target = {};
  const hooks = { showUiGuide: async () => true, answerAiaUiQuery() {}, performAiaUiClick() {} };
  const remove = installE2eHooks(target, hooks);
  assert.equal(target.__agentManagerE2E, hooks);
  remove();
  assert.equal("__agentManagerE2E" in target, false);
});

test("다른 훅으로 바뀐 뒤의 늦은 제거는 새 훅을 건드리지 않는다", () => {
  const target = {};
  const first = { showUiGuide: async () => true, answerAiaUiQuery() {}, performAiaUiClick() {} };
  const second = { ...first };
  const removeFirst = installE2eHooks(target, first);
  installE2eHooks(target, second);
  removeFirst();
  assert.equal(target.__agentManagerE2E, second);
});
