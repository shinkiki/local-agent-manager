import assert from "node:assert/strict";
import test from "node:test";

import { memberGuard } from "./memberGuard.ts";

test("정본 목록에 있는 값만 통과시킨다", () => {
  const isFruit = memberGuard(["apple", "pear"]);
  assert.equal(isFruit("apple"), true);
  assert.equal(isFruit("pear"), true);
  assert.equal(isFruit("plum"), false);
  assert.equal(isFruit(""), false);
});

test("문자열이 아닌 값은 목록을 보지 않고 거른다", () => {
  const isFruit = memberGuard(["apple"]);
  for (const value of [null, undefined, 0, 1, {}, ["apple"], Symbol("apple")]) {
    assert.equal(isFruit(value), false);
  }
});

test("빈 목록은 어떤 값도 통과시키지 않는다", () => {
  const never = memberGuard([]);
  assert.equal(never("apple"), false);
});

test("만든 뒤에 목록이 바뀌어도 판정은 만든 시점의 목록을 본다", () => {
  const values = ["apple"];
  const isFruit = memberGuard(values);
  values.push("pear");
  assert.equal(isFruit("pear"), false);
});
