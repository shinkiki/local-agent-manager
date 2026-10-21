import assert from "node:assert/strict";
import test from "node:test";
import { matchesNeedle } from "./menuSearch.ts";

test("검색어 판정은 빈 값을 건너뛰고 소문자 부분일치로 본다", () => {
  assert.equal(matchesNeedle([null, undefined, "Deploy Helper"], "deploy"), true);
  assert.equal(matchesNeedle([null, undefined, ""], "deploy"), false);
  assert.equal(matchesNeedle([], "deploy"), false);
  assert.equal(matchesNeedle(["배포 도우미"], "도우"), true);
});
