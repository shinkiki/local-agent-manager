import assert from "node:assert/strict";
import test from "node:test";
import { untranslatableUiProperNoun } from "./uiProperNouns.ts";

test("낱말 하나로 그려진 제품 이름은 번역 카탈로그에 싣지 않는다", () => {
  assert.equal(untranslatableUiProperNoun("AIA"), true);
  assert.equal(untranslatableUiProperNoun(" AIA "), true);
  assert.equal(untranslatableUiProperNoun("Agent Manager"), true);
});

test("이름이 섞인 문장은 번역 대상으로 남는다", () => {
  assert.equal(untranslatableUiProperNoun("AIA 열기"), false);
  assert.equal(untranslatableUiProperNoun("AIA 시스템 도구"), false);
  assert.equal(untranslatableUiProperNoun("대시보드"), false);
});
