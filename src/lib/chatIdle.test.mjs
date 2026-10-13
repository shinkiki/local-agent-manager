import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_NOTICE_MS, chatIdleLabel, chatIdleMs } from "./chatIdle.ts";

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
