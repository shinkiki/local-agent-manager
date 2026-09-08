import assert from "node:assert/strict";
import test from "node:test";
import { attentionNotificationDetail, attentionNotifications } from "./webNotificationContent.ts";

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

test("account switch detail is the backend transition text, not a folder", () => {
  assert.equal(
    attentionNotificationDetail(
      { ...item, providerSessionId: null, cwd: "", kind: "accountSwitch", title: "계정 자동전환", detail: "A → B · 사용량 100% 도달" },
      [],
    ),
    "Codex: A → B · 사용량 100% 도달",
  );
  assert.equal(
    attentionNotificationDetail(
      { ...item, providerSessionId: null, cwd: "", kind: "accountSwitch", title: "계정 자동전환", detail: null },
      [],
    ),
    "Codex: 계정 자동전환",
  );
});

test("notification detail falls back when the session is not cataloged", () => {
  assert.equal(
    attentionNotificationDetail({ ...item, providerSessionId: null }, []),
    "에이전트 작업 완료 · agent-manager-tauri",
  );
});

const round = (id) => ({
  ...item,
  id,
  chatId: id,
  providerSessionId: null,
  cwd: `/Users/example/rounds/${id}`,
  kind: "completed",
  read: false,
  origin: { kind: "workflow", workflowId: "wf-1", executionId: `execution-${id}`, consumerId: "schedule-1" },
});

test("한 회차에서 한꺼번에 끝난 건은 기기 알림 하나로 접힌다", () => {
  const notifications = attentionNotifications([round("a"), round("b"), round("c")], []);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "작업 완료 3건");
  assert.equal(notifications[0].body, "에이전트 작업 완료 · a 외 2건");
});

test("같은 묶음의 다음 회차는 같은 tag로 앞 알림을 갈아 끼운다", () => {
  const [first] = attentionNotifications([round("a")], []);
  const [second] = attentionNotifications([round("b")], []);
  assert.equal(first.tag, second.tag);
  // 낱개일 때는 문구가 종전과 같다.
  assert.equal(first.title, "작업 완료");
});

test("진행 중은 기기 알림 대상이 아니라 묶음에서도 빠진다", () => {
  assert.deepEqual(attentionNotifications([{ ...round("a"), kind: "running" }], []), []);
});
