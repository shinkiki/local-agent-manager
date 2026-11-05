import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginScopes } from "./claudePluginScopes.ts";

test("V4: 플러그인마다 선택한 세 범위를 서로 섞지 않고 복원한다", () => {
  assert.deepEqual(parsePluginScopes('{"one@official":"global","two@team":"project","three@team":"branch"}'), {
    "one@official": "global", "two@team": "project", "three@team": "branch",
  });
});

test("V4: 저장값 부재와 빈 값, 손상된 JSON은 복원할 범위가 없다", () => {
  for (const stored of [null, "", "{broken", "undefined", "  "]) {
    assert.deepEqual(parsePluginScopes(stored), {}, String(stored));
  }
});

test("V4: 객체가 아닌 JSON 루트는 플러그인 범위로 읽지 않는다", () => {
  for (const stored of ["null", "true", "false", "42", '\"branch\"']) {
    assert.deepEqual(parsePluginScopes(stored), {}, stored);
  }
});

test("V4: 모르는 값과 다른 형식은 거르고 같은 저장본의 유효한 선택은 남긴다", () => {
  assert.deepEqual(parsePluginScopes(JSON.stringify({
    valid: "branch", upper: "GLOBAL", spaced: " project", unknown: "user", empty: "",
    bool: true, number: 1, absent: null, nested: {scope: "project"}, list: ["branch"],
  })), {valid: "branch"});
});

test("V4: 특수 객체 속성 이름도 플러그인 키로 보존하며 프로토타입을 바꾸지 않는다", () => {
  const restored = parsePluginScopes('{"__proto__":"branch","constructor":"project","toString":"global"}');
  assert.deepEqual(Object.entries(restored), [["__proto__", "branch"], ["constructor", "project"], ["toString", "global"]]);
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(Object.hasOwn(restored, "__proto__"), true);
});
