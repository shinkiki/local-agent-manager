import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_NOTICE_MS, chatIdleLabel, chatIdleMs, chatLivenessTitle, phaseWithIdleLabel } from "./chatIdle.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const chat = (fields) => ({ chatId: "c", state: "ready", startedAt: NOW, ...fields });

test("the backend measurement wins so remote screens with a skewed clock agree", () => {
  const measured = chat({ idleMs: 90 * MINUTE, lastActivityAt: NOW - MINUTE, startedAt: NOW - MINUTE });
  assert.equal(chatIdleMs(measured, NOW), 90 * MINUTE);
});

test("an older backend without the measurement is read from the activity mark", () => {
  const marked = chat({ lastActivityAt: NOW - 20 * MINUTE, startedAt: NOW - 3 * 60 * MINUTE });
  assert.equal(chatIdleMs(marked, NOW), 20 * MINUTE);
});

test("a runtime that never moved falls back to when it started", () => {
  assert.equal(chatIdleMs(chat({ startedAt: NOW - 7 * MINUTE }), NOW), 7 * MINUTE);
});

test("a clock that ran backwards reports no idle time rather than a negative one", () => {
  assert.equal(chatIdleMs(chat({ idleMs: -5000 }), NOW), 0);
  assert.equal(chatIdleMs(chat({ startedAt: NOW + 10 * MINUTE }), NOW), 0);
});

test("a runtime that just answered carries no idle label", () => {
  assert.equal(chatIdleLabel(chat({ idleMs: IDLE_NOTICE_MS - 1 }), NOW), null);
});

test("an abandoned runtime is labelled so ready no longer reads as stopped", () => {
  assert.equal(chatIdleLabel(chat({ idleMs: 12 * MINUTE }), NOW), "12m");
  assert.equal(chatIdleLabel(chat({ idleMs: 256 * MINUTE }), NOW), "4h 16m");
});

test("a run that has been responding for hours is labelled too", () => {
  assert.equal(chatIdleLabel(chat({ state: "running", idleMs: 95 * MINUTE }), NOW), "1h 35m");
});

const pick = (ko) => ko;

test("the liveness title follows the passed phase, not the snapshot state", () => {
  const stale = chat({ state: "ready", idleMs: 20 * MINUTE });
  // 머리줄은 소켓 단계가 앞서 있다. 라벨과 말풍선이 같은 단계를 말해야 한다.
  assert.equal(phaseWithIdleLabel(stale, pick, "stopped"), "종료됨");
  assert.match(chatLivenessTitle(stale, pick, "stopped"), /실행이 끝났습니다/);
  assert.match(chatLivenessTitle(stale, pick, "failed"), /실행이 끝났습니다/);
  const ended = chat({ state: "stopped", idleMs: 20 * MINUTE });
  assert.match(chatLivenessTitle(ended, pick, "running"), /동안 같은 상태입니다/);
  assert.match(chatLivenessTitle(ended, pick, "ready"), /입력을 기다리고/);
});

test("without a phase the liveness title reads the snapshot state", () => {
  assert.match(chatLivenessTitle(chat({ state: "failed" }), pick), /실행이 끝났습니다/);
  assert.equal(chatLivenessTitle(chat({ state: "ready", idleMs: 0 }), pick), "살아 있는 실행입니다");
});
