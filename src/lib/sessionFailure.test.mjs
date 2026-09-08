import assert from "node:assert/strict";
import test from "node:test";

import { sessionFailureTitle } from "./sessionFailure.ts";

test("usage-limit failures lead with the limit explanation and keep the provider message", () => {
  const title = sessionFailureTitle({ kind: "usageLimit", occurredAt: null, message: "You've hit your session limit · resets 2pm" });
  assert.match(title, /^마지막 요청이 사용량 한도에 걸려 실패했습니다\n/);
  assert.match(title, /session limit/);
});

test("other failures say the request ended in an error and include the time when known", () => {
  const title = sessionFailureTitle({ kind: "error", occurredAt: Date.UTC(2026, 8, 5, 0, 0), message: "  " });
  assert.match(title, /^마지막 요청이 오류로 끝났습니다 \(/);
  assert.equal(title.includes("\n"), false);
});
