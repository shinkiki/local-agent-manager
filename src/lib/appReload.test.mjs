import assert from "node:assert/strict";
import test from "node:test";
import {
  STALE_SHELL_RELOAD_KEY,
  STALE_SHELL_RELOAD_WINDOW_MS,
  isStaleChunkError,
  shouldReloadForStaleShell,
} from "./appReload.ts";

const store = (initial = null, { readFails = false, writeFails = false } = {}) => {
  let value = initial;
  return {
    getItem(key) {
      assert.equal(key, STALE_SHELL_RELOAD_KEY);
      if (readFails) throw new Error("blocked");
      return value;
    },
    setItem(key, next) {
      assert.equal(key, STALE_SHELL_RELOAD_KEY);
      if (writeFails) throw new Error("blocked");
      value = next;
    },
    read: () => value,
  };
};

test("동적 import 실패 문구는 브라우저별로 모두 낡은 셸로 본다", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: http://127.0.0.1:4178/assets/ChatView-old.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Failed to load module script: Expected a JavaScript module script",
    "Unable to preload CSS for /assets/index-old.css",
  ]) {
    assert.equal(isStaleChunkError(new Error(message)), true, message);
  }
});

test("일반 렌더 오류는 낡은 셸로 보지 않는다", () => {
  assert.equal(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'value')")), false);
  assert.equal(isStaleChunkError("네트워크 요청이 실패했습니다"), false);
  assert.equal(isStaleChunkError(null), false);
});

test("첫 청크 실패는 새로고침하고 시각을 남긴다", () => {
  const session = store();
  assert.equal(shouldReloadForStaleShell(session, 1_000), true);
  assert.equal(session.read(), "1000");
});

test("창 안에서 다시 실패하면 새로고침을 반복하지 않는다", () => {
  const session = store(String(1_000));
  assert.equal(shouldReloadForStaleShell(session, 1_000 + STALE_SHELL_RELOAD_WINDOW_MS - 1), false);
});

test("창이 지난 뒤의 실패는 다시 새로고침한다", () => {
  const session = store(String(1_000));
  assert.equal(shouldReloadForStaleShell(session, 1_000 + STALE_SHELL_RELOAD_WINDOW_MS), true);
  assert.equal(session.read(), String(1_000 + STALE_SHELL_RELOAD_WINDOW_MS));
});

test("깨진 기록은 첫 실패로 취급한다", () => {
  const session = store("nope");
  assert.equal(shouldReloadForStaleShell(session, 500), true);
});

test("저장소를 쓸 수 없으면 새로고침하지 않고 오류 화면을 남긴다", () => {
  assert.equal(shouldReloadForStaleShell(null, 500), false);
  assert.equal(shouldReloadForStaleShell(store(null, { readFails: true }), 500), false);
  assert.equal(shouldReloadForStaleShell(store(null, { writeFails: true }), 500), false);
});
