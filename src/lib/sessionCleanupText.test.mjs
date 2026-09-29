import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBytes,
  previewSummary,
  reasonHint,
  receiptSummary,
  shrinkFactor,
} from "./sessionCleanupText.ts";
import { cleanupPreview, cleanupReceipt } from "./sessionCleanupFixtures.mjs";

// 문장 짓는 함수들은 지금 언어를 고르는 손잡이를 받는다. 두 손잡이로 같은 입력을 불러
// 한국어·영어 양쪽 표기를 확인한다 — 손잡이를 넘기지 않으면 한국어다.
const en = (ko, english) => english;

test("미리보기는 실체 회수와 목록에서만 내리는 몫을 갈라 말한다", () => {
  const summary = previewSummary(
    cleanupPreview({ targetCount: 2146, removableCount: 396, removableBytes: 490 * 1024 * 1024 }),
  );
  assert.match(summary, /세션 2,146건/);
  assert.match(summary, /실체 회수 396건 490MB/);
  assert.match(summary, /목록에서만 내림 1,750건/);
});

test("미리보기는 영어 손잡이를 받으면 영어 한 줄을 짓는다", () => {
  const summary = previewSummary(
    cleanupPreview({ targetCount: 2146, removableCount: 396, removableBytes: 490 * 1024 * 1024 }),
    en,
  );
  assert.match(summary, /2,146 sessions/);
  assert.match(summary, /reclaims 396 490MB/);
  assert.match(summary, /list-only removal 1,750/);
  assert.equal(previewSummary(cleanupPreview(), en), "No sessions match the current conditions.");
});

test("조건에 걸리는 것이 없으면 그렇다고 말한다", () => {
  assert.equal(previewSummary(cleanupPreview()), "지금 조건에 걸리는 세션이 없습니다.");
});

test("적중 0건인 조건은 지금 일하지 않는다고 분명히 말한다", () => {
  // 보존 기간은 켜 두면 뭔가 하는 줄 알기 쉬운 조건이라 0건을 숨기지 않는다.
  const hit = cleanupPreview({
    byReason: [
      { reason: "emptySession", label: "빈 세션", count: 874 },
      { reason: "retention", label: "보존 기간 경과", count: 0 },
    ],
  });
  assert.equal(reasonHint(hit, "emptySession"), "현재 데이터에서 874건이 해당됩니다.");
  assert.equal(reasonHint(hit, "retention"), "현재 데이터에서는 해당되는 세션이 없습니다.");
  assert.equal(reasonHint(hit, "providerCap"), "현재 데이터에서는 해당되는 세션이 없습니다.");
  assert.equal(reasonHint(hit, "emptySession", en), "874 sessions match right now.");
  assert.equal(reasonHint(hit, "retention", en), "No sessions match this condition right now.");
});

test("축소 배수는 남는 것이 있을 때만 말한다", () => {
  assert.equal(shrinkFactor(cleanupPreview({ targetCount: 2146, remainingCount: 720 })), 2866 / 720);
  assert.equal(shrinkFactor(cleanupPreview({ targetCount: 0, remainingCount: 720 })), null);
  assert.equal(shrinkFactor(cleanupPreview({ targetCount: 100, remainingCount: 0 })), null);
});

test("영수증 한 줄은 내린 몫·회수한 몫·실패를 갈라 말한다", () => {
  const ok = cleanupReceipt({ tombstonedCount: 2146, removedCount: 396, bytesFreed: 1024 * 1024 });
  assert.match(receiptSummary(ok), /목록에서 2,146건 내림/);
  assert.match(receiptSummary(ok), /실체 396건 회수 1MB/);
  assert.match(receiptSummary(cleanupReceipt({ tombstonedCount: 10, failedCount: 3 })), /실패 3건/);
  assert.match(receiptSummary(ok, en), /removed 2,146 from the list/);
  assert.match(receiptSummary(ok, en), /reclaimed 396 · 1MB/);
  assert.match(receiptSummary(cleanupReceipt({ tombstonedCount: 10, failedCount: 3 }), en), /3 failed/);
});

test("건너뛴 이유를 가진 영수증은 가장 흔한 사유를 함께 말한다", () => {
  // 건수만 보여 주면 남은 세션이 왜 남았는지 알 수 없다.
  const withReasons = cleanupReceipt({
    tombstonedCount: 5,
    skippedCount: 12,
    skippedReasons: [
      { reason: "반복 요청이 이어갈 세션이어서 건너뛰었습니다", count: 9 },
      { reason: "관리 채팅이 실행 중이어서 건너뛰었습니다", count: 3 },
    ],
  });
  assert.match(receiptSummary(withReasons), /보호로 건너뜀 12건\(주로 반복 요청이 이어갈 세션이어서 건너뛰었습니다\)/);
  // 사유가 없으면 건수만 말한다(옛 영수증).
  assert.match(receiptSummary(cleanupReceipt({ skippedCount: 4 })), /보호로 건너뜀 4건$/);
});

test("건너뛴 사유가 같은 건수로 맞서면 먼저 온 사유를 말한다", () => {
  // 사유 고르기가 정렬에서 단일 순회로 바뀌어도 먼저 온 것을 남기는 규칙은 그대로다.
  const tied = cleanupReceipt({
    skippedCount: 6,
    skippedReasons: [
      { reason: "앞선 사유", count: 3 },
      { reason: "뒤이은 사유", count: 3 },
    ],
  });
  assert.match(receiptSummary(tied), /보호로 건너뜀 6건\(주로 앞선 사유\)$/);
});

test("바이트 표기는 단위를 올려 가며 읽는다", () => {
  assert.equal(formatBytes(0), "0B");
  assert.equal(formatBytes(-1), "0B");
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(1536), "1.5KB");
  assert.equal(formatBytes(490 * 1024 * 1024), "490MB");
});
