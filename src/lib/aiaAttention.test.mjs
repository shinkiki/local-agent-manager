import assert from "node:assert/strict";
import test from "node:test";
import { aiaAttentionBubble, aiaAttentionForChat, aiaAttentionTargetAction, selectAiaAttention, shouldShowAiaAttentionBubble, withoutAiaAttention } from "./aiaAttention.ts";

const OWN = "own-chat";
const attention = (id, profile, kind, read = false, chatId = OWN) => ({ id, profile, kind, read, chatId });

test("AIA attention is removed from the general notification snapshot", () => {
  const snapshot = withoutAiaAttention({
    items: [
      attention("aia-approval", "aia", "approval"),
      attention("standard-completed", "standard", "completed"),
      attention("standard-approval", "standard", "approval"),
      attention("standard-read", "standard", "completed", true),
    ],
    unreadCount: 3,
    pendingCount: 2,
  }, OWN);

  assert.deepEqual(snapshot.items.map((item) => item.id), [
    "standard-completed",
    "standard-approval",
    "standard-read",
  ]);
  assert.equal(snapshot.unreadCount, 2);
  assert.equal(snapshot.pendingCount, 1);
});

test("pending AIA approval takes priority over a completed response", () => {
  const selected = selectAiaAttention([
    attention("completed", "aia", "completed"),
    attention("failed", "aia", "failed"),
    attention("standard-approval", "standard", "approval"),
    attention("approval", "aia", "approval"),
  ], OWN);

  assert.equal(selected?.id, "approval");
});

test("AIA approval이 없으면 첫 미확인 완료·실패 항목을 유지한다", () => {
  const selected = selectAiaAttention([
    attention("read", "aia", "completed", true),
    attention("first-unread", "aia", "failed"),
    attention("second-unread", "aia", "completed"),
  ], OWN);

  assert.equal(selected?.id, "first-unread");
});

test("AIA label ignores running and already read terminal items", () => {
  assert.equal(selectAiaAttention([
    attention("running", "aia", "running"),
    attention("read", "aia", "completed", true),
  ], OWN), null);
  assert.equal(selectAiaAttention([
    attention("standard", "standard", "approval"),
    attention("failed", "aia", "failed"),
  ], OWN)?.id, "failed");
});

test("AIA 메시지 미리보기는 클릭해 닫아도 다음 미확인 메시지에서 다시 열린다", () => {
  assert.equal(shouldShowAiaAttentionBubble(false, "attention:first", null), true);
  assert.equal(shouldShowAiaAttentionBubble(false, "attention:first", "attention:first"), false);
  assert.equal(shouldShowAiaAttentionBubble(false, "attention:second", "attention:first"), true);
  assert.equal(shouldShowAiaAttentionBubble(true, "attention:second", "attention:first"), false);
});

const bubbleItem = (kind, extra = {}) => ({
  id: "aia", profile: "aia", kind, read: false, title: "제목", detail: null, preview: null, ...extra,
});

test("완료 알림은 요청과 응답을 말풍선 두 줄로 옮긴다", () => {
  const bubble = aiaAttentionBubble(bubbleItem("completed", {
    preview: { request: "실행 중인\n세션 알려줘", response: "지금 실행 중인 세션은 두 개입니다." },
  }));

  assert.deepEqual(bubble, { request: "실행 중인 세션 알려줘", response: "지금 실행 중인 세션은 두 개입니다." });
});

test("승인 대기는 응답 대신 승인 요청 내용을 띄운다", () => {
  assert.deepEqual(aiaAttentionBubble(bubbleItem("approval", { title: "권한 승인", detail: "  " })), {
    request: null,
    response: "권한 승인",
  });
  assert.equal(aiaAttentionBubble(bubbleItem("approval", { detail: "rm -rf 실행 허용" }))?.response, "rm -rf 실행 허용");
});

test("긴 응답은 말줄임표로 끊고 띄울 내용이 없으면 말풍선을 만들지 않는다", () => {
  const response = aiaAttentionBubble(bubbleItem("completed", { preview: { request: null, response: "가".repeat(260) } }))?.response;
  assert.equal([...response].length, 121);
  assert.ok(response.endsWith("…"));
  assert.equal(aiaAttentionBubble(bubbleItem("completed", { preview: { request: "요청만 있음", response: null } })), null);
  assert.equal(aiaAttentionBubble(null), null);
});

test("상한을 넘긴 미리보기는 낱말·문장을 끊지 않는 자리에서 마무리한다", () => {
  const sentences = `${"세션을 확인했습니다. ".repeat(12)}남은 작업은 없습니다.`;
  const response = aiaAttentionBubble(bubbleItem("completed", { preview: { request: null, response: sentences } }))?.response;
  assert.ok(response.endsWith("확인했습니다.…"), response);

  const words = `${"확인한세션 ".repeat(20)}끝`;
  const clamped = aiaAttentionBubble(bubbleItem("completed", { preview: { request: null, response: words } }))?.response;
  assert.ok(clamped.endsWith("확인한세션…"), clamped);
});

test("알림 전환은 팝업이 열려 있고 CLI가 연결됐고 전환 중이 아닐 때만 실행한다", () => {
  assert.equal(aiaAttentionTargetAction(true, true, false), "switch");
});

test("CLI 미연결이면 알림 대상을 실패로 소비해 무반응을 없앤다", () => {
  assert.equal(aiaAttentionTargetAction(true, false, false), "reject");
  assert.equal(aiaAttentionTargetAction(true, false, true), "reject");
});

test("팝업이 닫혀 있거나 전환 중이면 대상을 유지하고 기다린다", () => {
  assert.equal(aiaAttentionTargetAction(false, true, false), "wait");
  assert.equal(aiaAttentionTargetAction(false, false, false), "wait");
  assert.equal(aiaAttentionTargetAction(true, true, true), "wait");
});

test("버린 대화의 알림만 걷는다 — 다른 대화와 일반 프로필은 남긴다", () => {
  const items = [
    { id: "old-completed", profile: "aia", kind: "completed", read: false, chatId: "old" },
    { id: "old-approval", profile: "aia", kind: "approval", read: true, chatId: "old" },
    { id: "new-completed", profile: "aia", kind: "completed", read: false, chatId: "new" },
    { id: "standard-old", profile: "standard", kind: "completed", read: false, chatId: "old" },
  ];

  assert.deepEqual(aiaAttentionForChat(items, "old").map((item) => item.id), ["old-completed", "old-approval"]);
  assert.deepEqual(aiaAttentionForChat(items, "missing"), []);
});

test("이 창이 소유하지 않은 AIA 대화는 트리거가 가져가지 않는다", () => {
  // 세션 화면에서 AIA 작업공간 세션을 재개하면 백엔드가 프로필을 Aia 로 되살린다
  // (chat.rs::effective_chat_profile). 프로필만 보고 고르면 그 대화가 AIA 창으로 끌려
  // 들어가, 사용자가 세션 화면에서 이어 보려던 대화를 팝업이 빼앗는다.
  const items = [
    attention("resumed-approval", "aia", "approval", false, "resumed-elsewhere"),
    attention("resumed-done", "aia", "completed", false, "resumed-elsewhere"),
  ];

  assert.equal(selectAiaAttention(items, OWN), null);
  assert.equal(selectAiaAttention(items, "resumed-elsewhere")?.id, "resumed-approval");
  // 소유한 대화가 없을 때도 남의 대화를 집지 않는다.
  assert.equal(selectAiaAttention(items, null), null);
});

test("소유하지 않은 AIA 알림은 일반 알림 목록에 남아 세션 화면으로 갈 수 있다", () => {
  // 트리거가 맡지 않는 알림까지 일반 목록에서 빼면 그 대화의 턴이 끝난 것을 어디에서도
  // 알 수 없다. ↻ 로 떼어 두고 계속 도는 대화가 정확히 그 자리다.
  const snapshot = withoutAiaAttention({
    items: [
      attention("own", "aia", "completed"),
      attention("detached-still-running", "aia", "completed", false, "left-running"),
      attention("standard", "standard", "completed"),
    ],
    unreadCount: 3,
    pendingCount: 0,
  }, OWN);

  assert.deepEqual(snapshot.items.map((item) => item.id), ["detached-still-running", "standard"]);
  assert.equal(snapshot.unreadCount, 2);
});
