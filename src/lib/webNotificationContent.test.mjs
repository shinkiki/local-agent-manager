import assert from "node:assert/strict";
import test from "node:test";
import { attentionNotificationDetail, attentionNotifications, credentialExpiryNotifications, projectNotifications } from "./webNotificationContent.ts";
import { setRuntimeLocale } from "./i18nRuntime.ts";

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

test("새로 감지된 프로젝트는 이름과 경로 태그를 갖는 기기 알림으로 변환된다", () => {
  const notifications = projectNotifications([
    { name: "내 프로젝트", path: "/Users/example/my-project" },
  ]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "새 프로젝트 감지");
  assert.equal(notifications[0].body, "내 프로젝트 · 활성 유지 또는 제외를 정하세요");
  assert.equal(notifications[0].tag, "new-project:/Users/example/my-project");
});

test("기기 알림 제목과 본문은 DOM 밖에서도 선택한 언어를 따른다", () => {
  setRuntimeLocale("en", {});
  try {
    const [notification] = attentionNotifications([round("a"), round("b")], []);
    assert.equal(notification.title, "Task completed (2)");
    assert.equal(notification.body, "에이전트 작업 완료 · a and 1 more");
    assert.deepEqual(projectNotifications([{ name: "Project", path: "/tmp/project" }])[0], {
      title: "New project detected",
      body: "Project · Keep active or exclude it",
      tag: "new-project:/tmp/project",
    });
  } finally {
    setRuntimeLocale("ko", {});
  }
});

test("pacing suggestion and round decision notifications have appropriate labels and bodies", () => {
  const pacingItem = {
    id: "pacing-1",
    chatId: "chat-1",
    source: "codex",
    kind: "pacingSuggestion",
    title: "페이싱 제안",
    detail: "요청 간격 10초 권장",
    cwd: "",
  };
  assert.equal(
    attentionNotificationDetail(pacingItem, []),
    "Codex: 요청 간격 10초 권장",
  );
  const [pacingNotification] = attentionNotifications([pacingItem], []);
  assert.equal(pacingNotification.title, "페이싱 제안");
  assert.equal(pacingNotification.body, "Codex: 요청 간격 10초 권장");

  const decisionItem = {
    id: "decision-1",
    chatId: "chat-1",
    source: "codex",
    kind: "roundDecision",
    title: "리뷰 회차 1",
    detail: "2건 대기",
    cwd: "",
  };
  assert.equal(
    attentionNotificationDetail(decisionItem, []),
    "리뷰 회차 1 · 2건 대기",
  );
  assert.equal(
    attentionNotificationDetail({ ...decisionItem, detail: "" }, []),
    "리뷰 회차 1",
  );
  const [decisionNotification] = attentionNotifications([decisionItem], []);
  assert.equal(decisionNotification.title, "회차 결정 대기");
  assert.equal(decisionNotification.body, "리뷰 회차 1 · 2건 대기");
});

test("credential expiry notifications generate correct title, body, and tag with singular and plural days in en and ko", () => {
  const accounts = [
    { id: "acc-1", displayName: "Claude Dev", days: 1 },
    { id: "acc-2", displayName: "Codex Pro", days: 3 },
  ];
  const koNotifications = credentialExpiryNotifications(accounts);
  assert.equal(koNotifications.length, 2);
  assert.equal(koNotifications[0].title, "계정 인증 만료 임박");
  assert.equal(koNotifications[0].body, "Claude Dev · 1일 뒤 만료됩니다. 미리 재인증하세요");
  assert.equal(koNotifications[0].tag, "credential-expiry:acc-1");
  assert.equal(koNotifications[1].body, "Codex Pro · 3일 뒤 만료됩니다. 미리 재인증하세요");
  assert.equal(koNotifications[1].tag, "credential-expiry:acc-2");

  setRuntimeLocale("en", {});
  try {
    const enNotifications = credentialExpiryNotifications(accounts);
    assert.equal(enNotifications[0].title, "Account authentication expiring");
    assert.equal(enNotifications[0].body, "Claude Dev · expires in 1 day. Re-authenticate now");
    assert.equal(enNotifications[1].body, "Codex Pro · expires in 3 days. Re-authenticate now");
  } finally {
    setRuntimeLocale("ko", {});
  }
});
