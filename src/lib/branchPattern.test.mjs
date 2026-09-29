import assert from "node:assert/strict";
import test from "node:test";

import { branchMatches } from "./branchPattern.ts";

test("정확한 이름은 앞머리가 같은 다른 브랜치에 걸리지 않는다", () => {
  assert.equal(branchMatches("main", "main"), true);
  assert.equal(branchMatches("main", "maintenance"), false);
  assert.equal(branchMatches("main", null), false);
});

test("별표는 슬래시를 포함해 아무 글자에나 맞는다", () => {
  assert.equal(branchMatches("feature/*", "feature/login"), true);
  assert.equal(branchMatches("feature/*", "feature/a/b"), true);
  assert.equal(branchMatches("feature/*", "hotfix/login"), false);
  assert.equal(branchMatches("*", "anything"), true);
  assert.equal(branchMatches("*-wip", "login-wip"), true);
  assert.equal(branchMatches("*-wip", "login-wip-2"), false);
  assert.equal(branchMatches("release/*/rc", "release/3/rc"), true);
  assert.equal(branchMatches("release/**/rc", "release/3/rc"), true);
  assert.equal(branchMatches("*ab*ab", "ab-ab"), true);
  assert.equal(branchMatches("*ab*ab", "ab-a"), false);
});
