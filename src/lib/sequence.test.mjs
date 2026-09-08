import assert from "node:assert/strict";
import test from "node:test";
import { uniqueInOrder } from "./sequence.ts";

test("uniqueInOrder는 처음 나온 것만 남기고 순서를 지킨다", () => {
  assert.deepEqual(uniqueInOrder(["codex", "claude", "codex", "antigravity"]), [
    "codex",
    "claude",
    "antigravity",
  ]);
  assert.deepEqual(uniqueInOrder([]), []);
});

test("uniqueInOrder는 원본을 고치지 않고 새 배열을 돌려준다", () => {
  const values = ["a", "a", "b"];

  const unique = uniqueInOrder(values);

  assert.notEqual(unique, values);
  assert.deepEqual(values, ["a", "a", "b"]);
});
