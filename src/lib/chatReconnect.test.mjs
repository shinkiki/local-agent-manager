import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKEND_RESTARTED_MESSAGE,
  chatReconnectDecision,
  ChatRejectedError,
  reconnectNoticeMessage,
  shouldNoticeReconnectAttempt,
} from "./chatReconnect.ts";

test("사라진 실행에 대한 거절은 재연결을 멈추고 다음 행동을 알린다", () => {
  const decision = chatReconnectDecision(
    new ChatRejectedError("chatMissing", "채팅 실행을 찾을 수 없습니다"),
  );
  assert.equal(decision.terminal, true);
  assert.match(decision.message, /채팅 실행을 찾을 수 없습니다/);
  assert.match(decision.message, /다시 열거나 새 대화/);
});

test("거절 판단은 메시지 문구가 아니라 코드만 본다", () => {
  // 같은 문구라도 일시적 코드면 재시도하고, 영구 코드면 멈춘다.
  const retryable = chatReconnectDecision(new ChatRejectedError("unavailable", "연결 실패"));
  const permanent = chatReconnectDecision(new ChatRejectedError("invalid", "연결 실패"));
  assert.equal(retryable.terminal, false);
  assert.equal(permanent.terminal, true);
});

test("동일 세션 점유 거절은 기존 chatId를 보존한다", () => {
  const error = new ChatRejectedError(
    "sessionBusy",
    "같은 세션이 실행 중입니다",
    "chat-1234567890",
  );
  assert.equal(error.existingChatId, "chat-1234567890");
  const decision = chatReconnectDecision(error);
  assert.equal(decision.terminal, true);
  assert.match(decision.message, /기존 실행/);
});

test("일반 연결 오류는 사유를 보존한 채 재시도로 남는다", () => {
  const decision = chatReconnectDecision(new Error("채팅 WebSocket에 연결하지 못했습니다"));
  assert.deepEqual(decision, {
    terminal: false,
    message: "채팅 WebSocket에 연결하지 못했습니다",
  });
});

test("재시도 안내는 한 번에 그치지 않고 같은 간격으로 다시 나온다", () => {
  assert.equal(shouldNoticeReconnectAttempt(0), false);
  assert.equal(shouldNoticeReconnectAttempt(4), false);
  assert.equal(shouldNoticeReconnectAttempt(5), true);
  assert.equal(shouldNoticeReconnectAttempt(10), true);
});

test("재시도 안내에는 실패 횟수와 실제 사유가 함께 들어간다", () => {
  const message = reconnectNoticeMessage(5, "원격 접근 상태를 확인하지 못했습니다 (502)");
  assert.match(message, /5번 실패/);
  assert.match(message, /502/);
});

test("재기동 안내는 부재로 분류되도록 '찾을 수 없습니다'를 유지한다", () => {
  assert.match(BACKEND_RESTARTED_MESSAGE, /찾을 수 없습니다/);
});
