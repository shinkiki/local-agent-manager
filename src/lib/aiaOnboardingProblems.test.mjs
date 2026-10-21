import assert from "node:assert/strict";
import test from "node:test";

import { isJiraProjectKey } from "./aiaOnboardingProblems.ts";

test("지라 프로젝트 키는 지라 기본 규칙대로 밑줄을 받는다", () => {
  assert.equal(isJiraProjectKey("QA_WEB"), true);
  assert.equal(isJiraProjectKey("A_1"), true);
  assert.equal(isJiraProjectKey("QA_WEB_TOO"), true);
  assert.equal(isJiraProjectKey(" QA_WEB "), true);
  assert.equal(isJiraProjectKey("_QA"), false);
  assert.equal(isJiraProjectKey("1QA"), false);
  assert.equal(isJiraProjectKey("QA_WEB_TOOLS"), false);
});
