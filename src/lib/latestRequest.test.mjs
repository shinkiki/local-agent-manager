import assert from "node:assert/strict";
import test from "node:test";
import { createLatestGate, createRequestGeneration } from "./latestRequest.ts";

test("늦게 끝난 앞선 요청은 반영되지 않는다", () => {
  const gate = createLatestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(second(), true);
  assert.equal(first(), false);
});

test("새 요청이 없으면 계속 반영된다", () => {
  const gate = createLatestGate();
  const only = gate.begin();
  assert.equal(only(), true);
  assert.equal(only(), true);
});

test("문마다 순번이 따로다", () => {
  const a = createLatestGate();
  const b = createLatestGate();
  const fromA = a.begin();
  b.begin();
  assert.equal(fromA(), true);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function callbacks(events) {
  return {
    onResult: (value) => events.push(["result", value]),
    onError: (message) => events.push(["error", message]),
    onSettled: () => events.push(["settled"]),
  };
}

test("V4 요청 세대의 초기값·증가와 인스턴스 독립성을 보존한다", () => {
  const a = createRequestGeneration();
  const b = createRequestGeneration();
  assert.equal(a.current(), 0);
  assert.equal(a.open(), 1);
  assert.equal(a.open(), 2);
  assert.equal(a.current(), 2);
  assert.equal(b.current(), 0);
});

test("V4 현재 요청은 결과 뒤에 정리를 호출하며 정리 생략도 허용한다", async () => {
  const gate = createRequestGeneration();
  const events = [];
  const current = gate.open();
  await gate.latest(current, async () => 42, callbacks(events));
  await gate.latest(current, async () => 43, { onResult: (v) => events.push(["result", v]), onError: assert.fail });
  assert.deepEqual(events, [["result", 42], ["settled"], ["result", 43]]);
});

test("V4 뒤 요청이 먼저 끝나면 앞 요청의 성공과 정리를 버린다", async () => {
  const gate = createRequestGeneration();
  const events = [];
  const slow = deferred();
  const first = gate.latest(gate.open(), () => slow.promise, callbacks(events));
  await gate.latest(gate.open(), async () => "new", callbacks(events));
  slow.resolve("old");
  await first;
  assert.deepEqual(events, [["result", "new"], ["settled"]]);
});

test("V4 세대가 바뀐 앞 요청의 실패와 정리를 버린다", async () => {
  const gate = createRequestGeneration();
  const events = [];
  const slow = deferred();
  const first = gate.latest(gate.open(), () => slow.promise, callbacks(events));
  gate.open();
  slow.reject(new Error("old error"));
  await first;
  assert.deepEqual(events, []);
});

test("V4 현재 요청의 거절·동기 예외를 문자열로 바꾸고 정리한다", async () => {
  for (const work of [
    () => Promise.reject(new Error("failed")),
    () => Promise.reject("failed"),
    () => { throw new Error("failed"); },
  ]) {
    const gate = createRequestGeneration();
    const events = [];
    await gate.latest(gate.open(), work, callbacks(events));
    assert.deepEqual(events, [["error", "failed"], ["settled"]]);
  }
});

test("V4 결과 콜백이 다음 세대를 열면 이전 정리를 호출하지 않는다", async () => {
  const gate = createRequestGeneration();
  const events = [];
  await gate.latest(gate.open(), async () => "old", {
    ...callbacks(events),
    onResult: (value) => { events.push(["result", value]); gate.open(); },
  });
  assert.deepEqual(events, [["result", "old"]]);
});

test("V4 결과 콜백 예외 처리와 오류 콜백의 세대 전환을 보존한다", async () => {
  const gate = createRequestGeneration();
  const events = [];
  await gate.latest(gate.open(), async () => "ok", {
    onResult: () => { throw new Error("callback failed"); },
    onError: (message) => { events.push(["error", message]); gate.open(); },
    onSettled: () => events.push(["settled"]),
  });
  assert.deepEqual(events, [["error", "callback failed"]]);
});

test("V4 같은 세대의 후속 조회는 함께 반영하고 시작 전 낡은 조회도 실행한다", async () => {
  const gate = createRequestGeneration();
  const events = [];
  const current = gate.open();
  await Promise.all([
    gate.latest(current, async () => "child", callbacks(events)),
    gate.latest(gate.current(), async () => "page", callbacks(events)),
  ]);
  assert.equal(events.filter(([kind]) => kind === "result").length, 2);
  assert.equal(gate.current(), current);
  gate.open();
  let called = false;
  await gate.latest(current, async () => { called = true; return "stale"; }, callbacks(events));
  assert.equal(called, true);
  assert.equal(events.length, 4);
});
