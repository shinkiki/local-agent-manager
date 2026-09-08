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

function createMockStorage() {
  const store = new Map();
  return {
    store,
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

function withMockDom(run) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const storage = createMockStorage();
  const dataset = {};

  globalThis.window = { localStorage: storage };
  globalThis.document = {
    documentElement: {
      dataset,
    },
  };

  try {
    run({ storage, dataset });
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
}

test("theme constants expose expected values", () => {
  assert.deepEqual(THEME_MODES, ["auto", "light", "dark"]);
  assert.deepEqual(ACCENT_COLORS, ["brass", "green", "blue", "cyan", "violet"]);
  assert.equal(THEME_MODE_KEY, "agent-manager.theme-mode.v1");
  assert.equal(ACCENT_COLOR_KEY, "agent-manager.accent-color.v1");
});

test("loadThemeMode reads valid mode from storage or falls back to auto", () => {
  withMockDom(({ storage }) => {
    assert.equal(loadThemeMode(), "auto");

    storage.setItem(THEME_MODE_KEY, "light");
    assert.equal(loadThemeMode(), "light");

    storage.setItem(THEME_MODE_KEY, "dark");
    assert.equal(loadThemeMode(), "dark");

    storage.setItem(THEME_MODE_KEY, "invalid");
    assert.equal(loadThemeMode(), "auto");
  });
});

test("loadThemeMode handles storage exceptions gracefully", () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem() {
        throw new Error("SecurityError: Access is denied");
      },
    },
  };
  try {
    assert.equal(loadThemeMode(), "auto");
  } finally {
    globalThis.window = originalWindow;
  }
});

test("saveThemeMode stores the theme mode in localStorage", () => {
  withMockDom(({ storage }) => {
    saveThemeMode("dark");
    assert.equal(storage.getItem(THEME_MODE_KEY), "dark");

    saveThemeMode("light");
    assert.equal(storage.getItem(THEME_MODE_KEY), "light");
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
  withMockDom(({ storage }) => {
    assert.equal(loadAccentColor(), "brass");

    for (const color of ACCENT_COLORS) {
      storage.setItem(ACCENT_COLOR_KEY, color);
      assert.equal(loadAccentColor(), color);
    }

    storage.setItem(ACCENT_COLOR_KEY, "neon-pink");
    assert.equal(loadAccentColor(), "brass");
  });
});

test("loadAccentColor handles storage exceptions gracefully", () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem() {
        throw new Error("SecurityError: Access is denied");
      },
    },
  };
  try {
    assert.equal(loadAccentColor(), "brass");
  } finally {
    globalThis.window = originalWindow;
  }
});

test("saveAccentColor stores the accent color in localStorage", () => {
  withMockDom(({ storage }) => {
    saveAccentColor("cyan");
    assert.equal(storage.getItem(ACCENT_COLOR_KEY), "cyan");

    saveAccentColor("violet");
    assert.equal(storage.getItem(ACCENT_COLOR_KEY), "violet");
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
