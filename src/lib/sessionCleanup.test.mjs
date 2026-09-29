import assert from "node:assert/strict";
import test from "node:test";
import {
  CLEANUP_CONDITION_KEYS,
  canClearTombstones,
  canRunCleanup,
  cleanupBlockedReason,
  formatBytes,
  hasAnyCondition,
  receiptFailed,
} from "./sessionCleanup.ts";
import {
  NO_CLEANUP_CONDITIONS,
  cleanupPolicy,
  cleanupReceipt,
  cleanupStatus,
} from "./sessionCleanupFixtures.mjs";

test("조건이 하나도 없으면 실행을 막고 이유를 말한다", () => {
  const empty = cleanupStatus({ policy: cleanupPolicy(NO_CLEANUP_CONDITIONS) });
  assert.equal(hasAnyCondition(empty.policy), false);
  assert.equal(canRunCleanup(empty, { writable: true }), false);
  assert.equal(
    cleanupBlockedReason(empty, { writable: true }),
    "정리 조건을 하나 이상 켜야 실행할 수 있습니다.",
  );
});

test("정리 조건 키 중 어느 하나라도 켜져 있으면 조건 활성으로 본다", () => {
  // 조건을 모두 끈 재료가 곧 이 목록이어야 한다 — 어긋나면 "조건 없음"을 만드는 시험이
  // 실제로는 조건 하나를 켜 둔 채로 통과한다.
  assert.deepEqual([...CLEANUP_CONDITION_KEYS].sort(), Object.keys(NO_CLEANUP_CONDITIONS).sort());
  for (const key of CLEANUP_CONDITION_KEYS) {
    assert.equal(hasAnyCondition(cleanupPolicy({ ...NO_CLEANUP_CONDITIONS, [key]: 10 })), true);
  }
});

test("원격 변경이 꺼져 있으면 조건과 무관하게 막힌다", () => {
  const ready = cleanupStatus();
  assert.equal(canRunCleanup(ready, { writable: false }), false);
  assert.equal(cleanupBlockedReason(ready, { writable: false }), "원격 변경이 비활성화되어 있습니다.");
  assert.equal(canRunCleanup(ready, { writable: true }), true);
  assert.equal(cleanupBlockedReason(ready, { writable: true }), null);
});

test("정리 기록이 없으면 되돌리기 버튼을 열지 않는다", () => {
  assert.equal(canClearTombstones(cleanupStatus(), { writable: true }), false);
  assert.equal(canClearTombstones(cleanupStatus({ tombstoneCount: 2146 }), { writable: true }), true);
  assert.equal(canClearTombstones(cleanupStatus({ tombstoneCount: 2146 }), { writable: false }), false);
});

test("영수증 성패는 예외가 아니라 실패 건수로 가른다", () => {
  assert.equal(receiptFailed(cleanupReceipt({ tombstonedCount: 2146, removedCount: 396 })), false);
  assert.equal(receiptFailed(cleanupReceipt({ tombstonedCount: 10, failedCount: 3 })), true);
});

test("카드가 함께 쓰는 문구는 이 모듈을 거쳐도 같은 값이다", () => {
  // 문구는 `sessionCleanupText.ts`가 정하고 여기서 다시 내보낸다 — 화면 하나가 판정과
  // 문구를 함께 부르므로, 다시 내보내기가 끊기면 카드가 통째로 컴파일되지 않는다.
  assert.equal(formatBytes(1536), "1.5KB");
});
