import assert from "node:assert/strict";
import test from "node:test";
import { attentionNotificationDetail } from "./webNotificationContent.ts";

const item = {
  source: "codex",
  providerSessionId: "session-1",
  cwd: "/Users/example/agent-manager-tauri",
  title: "에이전트 작업 완료",
};

test("mobile notification detail uses the matching session title", () => {
  assert.equal(
    attentionNotificationDetail(item, [
      { source: "codex", id: "session-1", title: "PWA 알림 제목 표시" },
    ]),
    "PWA 알림 제목 표시 · agent-manager-tauri",
  );
});

test("session matching includes the provider source", () => {
  assert.equal(
    attentionNotificationDetail(item, [
      { source: "claude", id: "session-1", title: "다른 제공자 세션" },
    ]),
    "에이전트 작업 완료 · agent-manager-tauri",
  );
});

test("notification detail falls back when the session is not cataloged", () => {
  assert.equal(
    attentionNotificationDetail({ ...item, providerSessionId: null }, []),
    "에이전트 작업 완료 · agent-manager-tauri",
  );
});
