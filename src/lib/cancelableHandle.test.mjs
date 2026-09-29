import assert from "node:assert/strict";
import test from "node:test";
import { createCancelableHandle } from "./cancelableHandle.ts";
import { createHandleRegistry } from "./cancelableHandleFixtures.mjs";

function fixture() {
  const registry = createHandleRegistry();
  return {
    handle: createCancelableHandle(registry.start, registry.stop),
    armed: registry.handles,
    stopped: registry.stopped,
    fire: registry.fire,
  };
}

test("예약이 걸려 있는 동안에는 다시 걸지 않는다", () => {
  const { handle, armed } = fixture();
  let ran = 0;
  handle.arm(() => { ran += 1; });
  handle.arm(() => { ran += 1; });
  assert.equal(armed.size, 1);
  assert.equal(handle.pending(), true);
  assert.equal(ran, 0);
});

test("예약이 터지면 손잡이가 비고, 실행 중에 다시 걸 수 있다", () => {
  const { handle, armed, fire } = fixture();
  const order = [];
  handle.arm(() => {
    order.push("run");
    assert.equal(handle.pending(), false);
    handle.arm(() => order.push("again"));
  });
  fire();
  assert.deepEqual(order, ["run"]);
  assert.equal(armed.size, 1);
  fire();
  assert.deepEqual(order, ["run", "again"]);
});

test("걷으면 실행되지 않고 손잡이가 빈다", () => {
  const { handle, stopped } = fixture();
  let ran = 0;
  handle.arm(() => { ran += 1; });
  handle.cancel();
  assert.deepEqual(stopped, [1]);
  assert.equal(handle.pending(), false);
  assert.equal(ran, 0);
});

test("예약이 없을 때 걷어도 아무 일도 하지 않는다", () => {
  const { handle, stopped, fire } = fixture();
  handle.cancel();
  handle.arm(() => {});
  fire();
  handle.cancel();
  assert.deepEqual(stopped, []);
});
