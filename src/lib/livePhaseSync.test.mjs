import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyLivePhaseSnapshot } from "./livePhaseSync.ts";

const base = {
  requestedAt: 2_000,
  lastStateEventAt: 1_000,
  localPhase: "ready",
  snapshotPhase: "running",
  busyLocally: false,
};

test("a fresher snapshot corrects a missed running state", () => {
  assert.equal(shouldApplyLivePhaseSnapshot(base), true);
});

test("a fresher snapshot also corrects a stuck running display", () => {
  assert.equal(
    shouldApplyLivePhaseSnapshot({ ...base, localPhase: "running", snapshotPhase: "ready" }),
    true,
  );
});

test("a snapshot taken before the newest state event is discarded", () => {
  // 턴이 끝나기 직전에 뜬 스냅숏이 뒤늦게 도착해 '응답 중'을 되살리던 경우.
  assert.equal(
    shouldApplyLivePhaseSnapshot({ ...base, lastStateEventAt: 2_500 }),
    false,
  );
  // 같은 밀리초는 순서를 가릴 수 없어 적용하지 않는다.
  assert.equal(
    shouldApplyLivePhaseSnapshot({ ...base, lastStateEventAt: 2_000 }),
    false,
  );
});

test("an unchanged phase needs no correction", () => {
  assert.equal(shouldApplyLivePhaseSnapshot({ ...base, snapshotPhase: "ready" }), false);
});

test("a chat missing from the snapshot is left alone", () => {
  assert.equal(shouldApplyLivePhaseSnapshot({ ...base, snapshotPhase: null }), false);
});

test("local transitions own the phase while they run", () => {
  assert.equal(shouldApplyLivePhaseSnapshot({ ...base, busyLocally: true }), false);
  assert.equal(shouldApplyLivePhaseSnapshot({ ...base, localPhase: "connecting" }), false);
});

test("a first poll with no state event yet is trusted", () => {
  assert.equal(shouldApplyLivePhaseSnapshot({ ...base, lastStateEventAt: 0 }), true);
});
