import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCENT_COLOR_KEY,
  ACCENT_COLORS,
  applyAccentColor,
  applyThemeMode,
  loadAccentColor,
  loadThemeMode,
  saveAccentColor,
  saveThemeMode,
  THEME_MODE_KEY,
  THEME_MODES,
} from "./theme.ts";
import { setWindow, useStorageWindow, useThrowingStorageWindow } from "./storedTextFixtures.mjs";

/**
 * 저장소와 문서 루트를 함께 흉내 낸다. 저장소 흉내는 공용 한 벌을 쓰고, 여기서 더하는
 * 것은 `dataset`을 가진 문서 루트뿐이다 — 이 모듈만 속성을 붙였다 지운다.
 */
function withMockDom(run) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const store = useStorageWindow();
  const dataset = {};
  globalThis.document = { documentElement: { dataset } };
  try {
    run({ store, dataset });
  } finally {
    setWindow(originalWindow);
    globalThis.document = originalDocument;
  }
}

/** 저장소가 던져도 고른 값이 아니라 기본값으로 떨어지는지. 두 설정이 같은 규칙을 쓴다. */
function assertFallbackOnStorageFailure(load, fallback) {
  const previous = useThrowingStorageWindow();
  try {
    assert.equal(load(), fallback);
  } finally {
    setWindow(previous);
  }
}

test("theme constants expose expected values", () => {
  assert.deepEqual(THEME_MODES, ["auto", "light", "dark"]);
  assert.deepEqual(ACCENT_COLORS, ["brass", "green", "blue", "cyan", "violet"]);
  assert.equal(THEME_MODE_KEY, "agent-manager.theme-mode.v1");
  assert.equal(ACCENT_COLOR_KEY, "agent-manager.accent-color.v1");
});

test("loadThemeMode reads valid mode from storage or falls back to auto", () => {
  withMockDom(({ store }) => {
    assert.equal(loadThemeMode(), "auto");

    store.set(THEME_MODE_KEY, "light");
    assert.equal(loadThemeMode(), "light");

    store.set(THEME_MODE_KEY, "dark");
    assert.equal(loadThemeMode(), "dark");

    store.set(THEME_MODE_KEY, "invalid");
    assert.equal(loadThemeMode(), "auto");
  });
});

test("loadThemeMode handles storage exceptions gracefully", () => {
  assertFallbackOnStorageFailure(loadThemeMode, "auto");
});

test("saveThemeMode stores the theme mode in localStorage", () => {
  withMockDom(({ store }) => {
    saveThemeMode("dark");
    assert.equal(store.get(THEME_MODE_KEY), "dark");

    saveThemeMode("light");
    assert.equal(store.get(THEME_MODE_KEY), "light");
  });
});

test("applyThemeMode sets dataset.theme or removes it for auto", () => {
  withMockDom(({ dataset }) => {
    applyThemeMode("dark");
    assert.equal(dataset.theme, "dark");

    applyThemeMode("light");
    assert.equal(dataset.theme, "light");

    applyThemeMode("auto");
    assert.equal("theme" in dataset, false);
  });
});

test("loadAccentColor reads valid accent color or falls back to brass", () => {
  withMockDom(({ store }) => {
    assert.equal(loadAccentColor(), "brass");

    for (const color of ACCENT_COLORS) {
      store.set(ACCENT_COLOR_KEY, color);
      assert.equal(loadAccentColor(), color);
    }

    store.set(ACCENT_COLOR_KEY, "neon-pink");
    assert.equal(loadAccentColor(), "brass");
  });
});

test("loadAccentColor handles storage exceptions gracefully", () => {
  assertFallbackOnStorageFailure(loadAccentColor, "brass");
});

test("saveAccentColor stores the accent color in localStorage", () => {
  withMockDom(({ store }) => {
    saveAccentColor("cyan");
    assert.equal(store.get(ACCENT_COLOR_KEY), "cyan");

    saveAccentColor("violet");
    assert.equal(store.get(ACCENT_COLOR_KEY), "violet");
  });
});

test("applyAccentColor sets dataset.accent or removes it for default brass", () => {
  withMockDom(({ dataset }) => {
    applyAccentColor("blue");
    assert.equal(dataset.accent, "blue");

    applyAccentColor("green");
    assert.equal(dataset.accent, "green");

    applyAccentColor("brass");
    assert.equal("accent" in dataset, false);
  });
});
