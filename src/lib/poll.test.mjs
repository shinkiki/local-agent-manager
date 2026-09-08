import assert from "node:assert/strict";
import test from "node:test";
import { createPollLoop } from "./poll.ts";

function harness({ visible = true } = {}) {
  const pending = new Map();
  let nextHandle = 1;
  let listener = null;
  let isVisible = visible;
  return {
    get pending() { return pending; },
    timers: {
      setTimer(callback, delayMs) {
        const handle = nextHandle++;
        pending.set(handle, { callback, delayMs });
        return handle;
      },
      clearTimer(handle) { pending.delete(handle); },
    },
    visibility: {
      isVisible: () => isVisible,
      subscribe(next) { listener = next; return () => { listener = null; }; },
    },
    /** 예약된 다음 회차의 대기 시간. 예약이 없으면 null. */
    nextDelay() {
      const entry = pending.values().next().value;
      return entry ? entry.delayMs : null;
    },
    /** 예약된 타이머를 즉시 만료시킨다. */
    async fire() {
      const [handle, entry] = pending.entries().next().value ?? [];
      if (handle === undefined) return;
      pending.delete(handle);
      entry.callback();
      await flush();
    },
    async setVisible(next) {
      isVisible = next;
      listener?.();
      await flush();
    },
    hasListener: () => listener !== null,
    /** 이 하네스의 타이머·가시성을 물린 루프. 시험마다 주입 두 줄을 다시 적지 않게 한다. */
    loop(options) {
      return createPollLoop({ ...options, timers: this.timers, visibility: this.visibility });
    },
    /**
     * 회차 수만 세는 루프를 띄우고 첫 회차가 끝날 때까지 기다린다. 실행 횟수를 보는 시험들이
     * 카운터 선언·루프 주입·`start` 뒤 `flush`라는 같은 세 단계를 각자 다시 적고 있었는데,
     * 그중 한 벌에서 `flush`가 빠지면 아직 돌지 않은 것이 "돌지 않는다"로 읽혀 시험이 조용히
     * 통과한다. 시작 절차를 한 자리에 두어 그 어긋남이 생길 자리를 없앤다.
     */
    async counting(options) {
      let runs = 0;
      const loop = this.loop({ ...options, run: async () => { runs += 1; } });
      loop.start();
      await flush();
      return { loop, runs: () => runs };
    },
  };
}

/** 마이크로태스크 큐를 비운다(루프 내부 async 체인 완료 대기). */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("보이는 상태로 시작하면 즉시 한 번 실행하고 기본 간격으로 예약한다", async () => {
  const h = harness();
  const { loop, runs } = await h.counting({ intervalMs: 5_000 });

  assert.equal(runs(), 1);
  assert.equal(h.nextDelay(), 5_000);

  await h.fire();
  assert.equal(runs(), 2);
  assert.equal(h.nextDelay(), 5_000);
  loop.stop();
});

test("응답이 간격보다 오래 걸려도 요청이 겹치지 않는다", async () => {
  const h = harness();
  let started = 0;
  let release;
  const loop = h.loop({
    intervalMs: 1_000,
    run: () => { started += 1; return new Promise((resolve) => { release = resolve; }); },
  });

  loop.start();
  await flush();
  assert.equal(started, 1);
  // 진행 중에는 다음 회차가 예약되지 않는다.
  assert.equal(h.nextDelay(), null);

  // 진행 중 수동 갱신을 요청해도 새 요청을 만들지 않는다.
  void loop.refreshNow();
  await flush();
  assert.equal(started, 1);

  release();
  await flush();
  assert.equal(h.nextDelay(), 1_000);
  loop.stop();
});

test("실패는 상한까지 지수 백오프하고 성공 시 기본 간격으로 돌아온다", async () => {
  const h = harness();
  let fail = true;
  const loop = h.loop({
    intervalMs: 2_000,
    maxBackoffMs: 8_000,
    run: async () => { if (fail) throw new Error("remote down"); },
  });

  loop.start();
  await flush();
  assert.equal(h.nextDelay(), 4_000);
  await h.fire();
  assert.equal(h.nextDelay(), 8_000);
  await h.fire();
  assert.equal(h.nextDelay(), 8_000, "상한을 넘지 않는다");

  fail = false;
  await h.fire();
  assert.equal(h.nextDelay(), 2_000);
  loop.stop();
});

test("숨은 동안에는 타이머를 두지 않고 복귀 시 즉시 갱신한다", async () => {
  const h = harness();
  const { loop, runs } = await h.counting({ intervalMs: 3_000 });
  assert.equal(runs(), 1);

  await h.setVisible(false);
  assert.equal(h.nextDelay(), null, "백그라운드에서는 예약이 없다");
  assert.equal(runs(), 1);

  await h.setVisible(true);
  assert.equal(runs(), 2, "복귀 즉시 한 번 갱신한다");
  assert.equal(h.nextDelay(), 3_000);
  loop.stop();
});

test("숨은 상태로 시작하면 실행하지 않고 보일 때 처음 실행한다", async () => {
  const h = harness({ visible: false });
  const { loop, runs } = await h.counting({ intervalMs: 3_000 });
  assert.equal(runs(), 0);
  assert.equal(h.nextDelay(), null);

  await h.setVisible(true);
  assert.equal(runs(), 1);
  loop.stop();
});

test("stop은 예약과 가시성 구독을 모두 해제한다", async () => {
  const h = harness();
  const { loop, runs } = await h.counting({ intervalMs: 1_000 });
  assert.equal(h.hasListener(), true);

  loop.stop();
  assert.equal(h.nextDelay(), null);
  assert.equal(h.hasListener(), false);

  await loop.refreshNow();
  assert.equal(runs(), 1, "stop 이후에는 실행하지 않는다");
});
