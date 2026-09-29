import assert from "node:assert/strict";
import test from "node:test";

import { formatRunningElapsed } from "./sessionActivityText.ts";

test("running elapsed time is readable from under a minute through multiple days", () => {
  const now = 3 * 24 * 60 * 60_000;
  assert.equal(formatRunningElapsed(now - 10_000, now), "1분 미만");
  assert.equal(formatRunningElapsed(now - 17 * 60_000, now), "17분째");
  assert.equal(formatRunningElapsed(now - 2 * 60 * 60_000, now), "2시간째");
  assert.equal(formatRunningElapsed(now - 185 * 60_000, now), "3시간 5분째");
  assert.equal(formatRunningElapsed(now - 49 * 60 * 60_000, now), "2일 1시간째");
  assert.equal(formatRunningElapsed(null, now), "시간 확인 중");
});
