import assert from "node:assert/strict";
import test from "node:test";
import { closesTopEscapeLayer, createEscapeLayerStack } from "./escapeLayers.ts";

test("Esc만 겹침 UI를 닫는다", () => {
  assert.equal(closesTopEscapeLayer({ key: "Escape" }), true);
  assert.equal(closesTopEscapeLayer({ key: "Enter" }), false);
  assert.equal(closesTopEscapeLayer({ key: "esc" }), false);
});

test("조합 중이거나 이미 소비된 Esc는 무시한다", () => {
  assert.equal(closesTopEscapeLayer({ key: "Escape", isComposing: true }), false);
  assert.equal(closesTopEscapeLayer({ key: "Escape", defaultPrevented: true }), false);
});

test("가장 나중에 뜬 겹부터 닫는다", () => {
  const closed = [];
  const stack = createEscapeLayerStack();
  const removeDrawer = stack.push(() => closed.push("drawer"));
  const removeModal = stack.push(() => closed.push("modal"));

  stack.top()();
  assert.deepEqual(closed, ["modal"]);

  removeModal();
  stack.top()();
  assert.deepEqual(closed, ["modal", "drawer"]);

  removeDrawer();
  assert.equal(stack.top(), null);
  assert.equal(stack.size(), 0);
});

test("중간 겹이 먼저 닫혀도 나머지 순서는 그대로다", () => {
  const closed = [];
  const stack = createEscapeLayerStack();
  stack.push(() => closed.push("drawer"));
  const removeMenu = stack.push(() => closed.push("menu"));
  stack.push(() => closed.push("modal"));

  removeMenu();
  assert.equal(stack.size(), 2);
  stack.top()();
  assert.deepEqual(closed, ["modal"]);
});

test("같은 겹을 두 번 내려도 다른 겹을 지우지 않는다", () => {
  const stack = createEscapeLayerStack();
  const removeFirst = stack.push(() => {});
  stack.push(() => {});

  removeFirst();
  removeFirst();
  assert.equal(stack.size(), 1);
});

test("닫기 함수가 같아도 겹은 따로 센다", () => {
  const close = () => {};
  const stack = createEscapeLayerStack();
  const removeFirst = stack.push(close);
  stack.push(close);

  removeFirst();
  assert.equal(stack.size(), 1);
  assert.equal(stack.top(), close);
});
