import assert from "node:assert/strict";
import test from "node:test";
import { replayReached } from "./chatReplayProgress.ts";

const states = ["ready", "running", "waitingApproval", "stopped", "failed"];

test("V2: no socket progress cannot finish replay for any listed state", () => {
  for (const state of states) {
    assert.equal(replayReached(null, { turnCount: 4, state }), false, state);
  }
});

test("V2: earlier turns cannot finish replay even when their response has ended", () => {
  for (const targetState of states) {
    for (const progressState of states) {
      assert.equal(replayReached(
        { turnCount: 3, state: progressState },
        { turnCount: 4, state: targetState },
      ), false, `${progressState} -> ${targetState}`);
    }
  }
});

test("V2: equal turn counts distinguish an unfinished last response from live targets", () => {
  // 행은 목록 상태, 열은 소켓의 ready/running/waitingApproval/stopped/failed 상태다.
  // A finished target still needs the last answer; a live target only needs its turn to start.
  const expected = [
    [true, false, false, true, true],
    [true, true, true, true, true],
    [true, true, true, true, true],
    [true, false, false, true, true],
    [true, false, false, true, true],
  ];
  states.forEach((targetState, row) => states.forEach((progressState, column) => {
    assert.equal(replayReached(
      { turnCount: 4, state: progressState },
      { turnCount: 4, state: targetState },
    ), expected[row][column], `${progressState} -> ${targetState}`);
  }));
});

test("V2: a newer turn has passed the listed target regardless of its current phase", () => {
  for (const targetState of states) {
    for (const progressState of states) {
      assert.equal(replayReached(
        { turnCount: 5, state: progressState },
        { turnCount: 4, state: targetState },
      ), true, `${progressState} -> ${targetState}`);
    }
  }
});

test("V2: a completed chat stays covered through the start of its last replayed turn", () => {
  const target = { turnCount: 40, state: "ready" };
  const replay = [
    { turnCount: 0, state: "ready" },
    { turnCount: 39, state: "ready" },
    { turnCount: 40, state: "running" },
    { turnCount: 40, state: "waitingApproval" },
    { turnCount: 40, state: "ready" },
  ];
  assert.deepEqual(replay.map(progress => replayReached(progress, target)), [
    false, false, false, false, true,
  ]);
});
