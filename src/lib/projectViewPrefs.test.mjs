import assert from "node:assert/strict";
import test from "node:test";

import { readProjectViewPref, writeProjectViewPref } from "./projectViewPrefs.ts";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    raw: (key) => data.get(key),
  };
}

function withWindow(window, run) {
  const previous = globalThis.window;
  globalThis.window = window;
  try {
    run();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("a value is stored per project without touching other projects", () => {
  const storage = memoryStorage({ k: JSON.stringify({ "/b": ["x"] }) });
  withWindow({ localStorage: storage }, () => {
    writeProjectViewPref("k", "/a", true);
    assert.equal(readProjectViewPref("k", "/a"), true);
    assert.deepEqual(readProjectViewPref("k", "/b"), ["x"]);
    writeProjectViewPref("k", "/a", undefined);
    assert.deepEqual(JSON.parse(storage.raw("k")), { "/b": ["x"] });
  });
});

test("missing, corrupt or non-object stores read as undefined and are rewritten on write", () => {
  for (const raw of [undefined, "not json", "null", "3"]) {
    const storage = memoryStorage(raw === undefined ? {} : { k: raw });
    withWindow({ localStorage: storage }, () => {
      assert.equal(readProjectViewPref("k", "/a"), undefined);
      writeProjectViewPref("k", "/a", ["d"]);
      if (raw === "not json") assert.equal(storage.raw("k"), raw);
      else assert.deepEqual(JSON.parse(storage.raw("k")), { "/a": ["d"] });
    });
  }
});

test("blocked storage and a missing window are swallowed", () => {
  const blocked = { get localStorage() { throw new Error("SecurityError"); } };
  withWindow(blocked, () => {
    assert.equal(readProjectViewPref("k", "/a"), undefined);
    assert.doesNotThrow(() => writeProjectViewPref("k", "/a", true));
  });
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(readProjectViewPref("k", "/a"), undefined);
    assert.doesNotThrow(() => writeProjectViewPref("k", "/a", true));
  } finally {
    if (previous !== undefined) globalThis.window = previous;
  }
});
