import assert from "node:assert/strict";
import test from "node:test";
import { liveStreamBoundaryMs, transcriptBeforeLiveStream } from "./transcriptOverlap.ts";

function item(index, timestamp) {
  return { index, timestamp };
}

test("라이브 경계는 리플레이된 턴 중 가장 이른 시작 시각이다", () => {
  assert.equal(liveStreamBoundaryMs([{ startedAt: 300 }, { startedAt: 100 }, { startedAt: 200 }]), 100);
});

test("라이브 스트림이 비면 경계가 없다", () => {
  assert.equal(liveStreamBoundaryMs([]), null);
});

test("시작 시각이 수치가 아닌 턴은 경계 계산에서 제외한다", () => {
  assert.equal(liveStreamBoundaryMs([{ startedAt: Number.NaN }, { startedAt: 500 }]), 500);
});

test("경계가 없으면 트랜스크립트를 그대로 돌려준다", () => {
  const items = [item(0, 10), item(1, 20)];
  assert.equal(transcriptBeforeLiveStream(items, null), items);
});

test("경계 이후 항목은 라이브 스트림이 담당하므로 잘라낸다", () => {
  const items = [item(0, 10), item(1, 20), item(2, 30), item(3, 40)];
  assert.deepEqual(transcriptBeforeLiveStream(items, 30), [item(0, 10), item(1, 20)]);
});

test("겹치는 항목이 없으면 원본 배열을 유지한다", () => {
  const items = [item(0, 10), item(1, 20)];
  assert.equal(transcriptBeforeLiveStream(items, 100), items);
});

test("경계를 넘긴 뒤의 시각 없는 항목도 함께 잘라낸다", () => {
  const items = [item(0, 10), item(1, null), item(2, 30), item(3, null)];
  assert.deepEqual(transcriptBeforeLiveStream(items, 30), [item(0, 10), item(1, null)]);
});

test("모든 항목이 라이브 구간이면 비운다", () => {
  assert.deepEqual(transcriptBeforeLiveStream([item(0, 50), item(1, 60)], 50), []);
});
