import assert from "node:assert/strict";
import test from "node:test";

import { formatRunningElapsed, recentSessionActivity } from "./sessionActivity.ts";

const session = {
  source: "codex",
  id: "session-1",
  startedAt: 100,
  updatedAt: 200,
};

function attention(kind, createdAt, detail = null) {
  return {
    id: `${kind}-${createdAt}`,
    chatId: "chat-1",
    source: "codex",
    providerSessionId: "session-1",
    cwd: "/workspace",
    resuming: false,
    unattended: false,
    profile: "standard",
    kind,
    title: kind,
    detail,
    approvalId: null,
    preview: null,
    createdAt,
    read: false,
  };
}

test("the newest matching turn controls the recent session status", () => {
  const activity = recentSessionActivity(session, [
    attention("completed", 300),
    attention("running", 400),
    { ...attention("running", 500), providerSessionId: "other-session" },
  ]);

  assert.deepEqual(activity, { status: "running", occurredAt: 400 });
});

test("interrupted turns are cancelled while genuine failures stay failures", () => {
  assert.equal(
    recentSessionActivity(session, [attention("failed", 300, "interrupted")]).status,
    "cancelled",
  );
  assert.equal(
    recentSessionActivity(session, [attention("failed", 300, "failed")]).status,
    "failed",
  );
});

test("a catalog session without a live event is complete", () => {
  assert.deepEqual(recentSessionActivity(session, []), { status: "completed", occurredAt: 200 });
});

test("running elapsed time is readable from under a minute through multiple days", () => {
  const now = 3 * 24 * 60 * 60_000;
  assert.equal(formatRunningElapsed(now - 10_000, now), "1분 미만");
  assert.equal(formatRunningElapsed(now - 17 * 60_000, now), "17분째");
  assert.equal(formatRunningElapsed(now - 2 * 60 * 60_000, now), "2시간째");
  assert.equal(formatRunningElapsed(now - 185 * 60_000, now), "3시간 5분째");
  assert.equal(formatRunningElapsed(now - 49 * 60 * 60_000, now), "2일 1시간째");
  assert.equal(formatRunningElapsed(null, now), "시간 확인 중");
});
