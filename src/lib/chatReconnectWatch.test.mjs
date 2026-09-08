import assert from "node:assert/strict";
import test from "node:test";
import { createChatReconnectWatch } from "./chatReconnectWatch.ts";

function fixture({ canRetry = () => true } = {}) {
  const delays = [];
  const attempts = [];
  const timers = new Map();
  let nextHandle = 1;
  let reachable = true;
  let onResume = null;
  let disposals = 0;

  const environment = {
    setTimer(callback, delayMs) {
      const handle = nextHandle++;
      timers.set(handle, callback);
      delays.push(delayMs);
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    canReachBackend: () => reachable,
    watchResume(callback) {
      onResume = callback;
      return () => {
        onResume = null;
        disposals += 1;
      };
    },
  };

  const state = {
    delays,
    attempts,
    environment,
    get pending() {
      return timers.size;
    },
    get watching() {
      return onResume !== null;
    },
    get disposals() {
      return disposals;
    },
    setReachable(value) {
      reachable = value;
    },
    fireTimer() {
      const [handle, callback] = timers.entries().next().value;
      timers.delete(handle);
      callback();
    },
    resume() {
      onResume?.();
    },
  };

  state.watch = createChatReconnectWatch(
    { canRetry, attempt: () => attempts.push(state.pending) },
    environment,
  );
  return state;
}

test("재시도 간격은 실패마다 두 배로 늘고 15초에서 멈춘다", () => {
  const it = fixture();

  it.watch.schedule();
  for (let round = 0; round < 5; round += 1) {
    it.fireTimer();
    it.watch.noteFailure("사유");
    it.watch.schedule();
  }

  assert.deepEqual(it.delays, [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
});

test("연결에 성공하면 다음 재시도 간격이 처음으로 돌아온다", () => {
  const it = fixture();

  it.watch.noteFailure("사유");
  it.watch.noteFailure("사유");
  it.watch.reset();
  it.watch.schedule();

  assert.deepEqual(it.delays, [1_000]);
});

test("이미 예약돼 있으면 다시 예약하지 않는다", () => {
  const it = fixture();

  it.watch.schedule();
  it.watch.schedule();

  assert.equal(it.pending, 1);
  assert.deepEqual(it.delays, [1_000]);
});

test("재시도할 수 없는 연결은 예약도 시도도 하지 않는다", () => {
  let retryable = true;
  const it = fixture({ canRetry: () => retryable });

  it.watch.schedule();
  retryable = false;
  it.fireTimer();

  assert.deepEqual(it.attempts, []);

  it.watch.schedule();
  assert.equal(it.pending, 0);
});

test("도달할 수 없는 동안의 실패는 알림 집계에 넣지 않는다", () => {
  const it = fixture();

  it.setReachable(false);
  for (let round = 0; round < 5; round += 1) {
    assert.equal(it.watch.noteFailure("사유"), null);
  }

  it.setReachable(true);
  const notices = [];
  for (let round = 0; round < 5; round += 1) {
    notices.push(it.watch.noteFailure("연결이 거부되었습니다."));
  }

  assert.deepEqual(notices.slice(0, 4), [null, null, null, null]);
  assert.equal(
    notices[4],
    "원격 채팅 연결이 5번 실패했습니다: 연결이 거부되었습니다. 같은 세션에 계속 재연결하고 있습니다.",
  );
});

test("화면 복귀는 예약이 걸려 있을 때만 즉시 시도하고 백오프를 되돌린다", () => {
  const it = fixture();
  it.watch.watch();

  // 예약이 없는 동안의 복귀 이벤트는 무시한다.
  it.resume();
  assert.deepEqual(it.attempts, []);

  it.watch.noteFailure("사유");
  it.watch.noteFailure("사유");
  it.watch.schedule();
  assert.deepEqual(it.delays, [4_000]);

  it.resume();
  // 예약을 걷고 곧바로 한 번 시도한다.
  assert.deepEqual(it.attempts, [0]);
  assert.equal(it.pending, 0);

  it.watch.schedule();
  assert.deepEqual(it.delays, [4_000, 1_000]);
});

test("도달할 수 없는 상태의 복귀 이벤트는 예약을 그대로 둔다", () => {
  const it = fixture();
  it.watch.watch();
  it.watch.schedule();

  it.setReachable(false);
  it.resume();

  assert.deepEqual(it.attempts, []);
  assert.equal(it.pending, 1);
});

test("중단은 예약된 재시도와 복귀 감시를 함께 걷는다", () => {
  const it = fixture();
  it.watch.watch();
  it.watch.schedule();

  it.watch.stop();

  assert.equal(it.pending, 0);
  assert.equal(it.watching, false);
  assert.equal(it.disposals, 1);

  // 두 번째 중단은 감시를 다시 걷지 않는다.
  it.watch.stop();
  assert.equal(it.disposals, 1);
});
