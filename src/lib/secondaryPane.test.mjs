import assert from "node:assert/strict";
import test from "node:test";

import {
  readSecondaryPaneOpen,
  SECONDARY_PANE_COLLAPSE_MEDIA_QUERY,
  writeSecondaryPaneOpen,
} from "./secondaryPane.ts";

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

/**
 * 전역 `window`를 잠시 갈아 끼우고 반드시 되돌린다. 이 파일의 모든 준비가 결국 같은
 * 교체·복원 한 쌍이라, 각 테스트가 try/finally를 따로 적으면 한 곳만 복원을 빠뜨려도
 * 다음 테스트가 남의 window 위에서 돌게 된다.
 */
function withWindow(value, run) {
  const originalWindow = globalThis.window;
  if (value === undefined) delete globalThis.window;
  else globalThis.window = value;
  try {
    return run();
  } finally {
    globalThis.window = originalWindow;
  }
}

function withMockWindow({ storage = createMockStorage(), matches = false } = {}, run) {
  let queriedQuery = null;
  const mock = {
    localStorage: storage,
    matchMedia(query) {
      queriedQuery = query;
      return { matches };
    },
  };
  return withWindow(mock, () => run({ storage, getQueriedQuery: () => queriedQuery }));
}

/** 저장소 접근이 막힌 브라우저. 읽기·쓰기 중 지정한 쪽만 던지게 해 예외 경로를 고른다. */
function withBrokenStorage(method, run) {
  return withWindow({
    localStorage: {
      [method]() {
        throw new Error("SecurityError: Access is denied");
      },
    },
    matchMedia() {
      return { matches: false };
    },
  }, run);
}

test("SECONDARY_PANE_COLLAPSE_MEDIA_QUERY matches expected 760px breakpoint", () => {
  assert.equal(SECONDARY_PANE_COLLAPSE_MEDIA_QUERY, "(max-width: 760px)");
});

test("readSecondaryPaneOpen returns true when window is undefined", () => {
  withWindow(undefined, () => {
    assert.equal(readSecondaryPaneOpen("test-key"), true);
  });
});

test("readSecondaryPaneOpen honours stored open and closed states", () => {
  withMockWindow({ matches: true }, ({ storage }) => {
    storage.setItem("key-1", "open");
    assert.equal(readSecondaryPaneOpen("key-1"), true);

    storage.setItem("key-2", "closed");
    assert.equal(readSecondaryPaneOpen("key-2"), false);
  });
});

test("readSecondaryPaneOpen falls back to viewport width when not stored", () => {
  withMockWindow({ matches: false }, ({ getQueriedQuery }) => {
    // 넓은 화면(!matches): 기본 열림(true)
    assert.equal(readSecondaryPaneOpen("unstored-wide"), true);
    assert.equal(getQueriedQuery(), SECONDARY_PANE_COLLAPSE_MEDIA_QUERY);
  });

  withMockWindow({ matches: true }, ({ getQueriedQuery }) => {
    // 좁은 화면(matches): 기본 닫힘(false)
    assert.equal(readSecondaryPaneOpen("unstored-narrow"), false);
    assert.equal(getQueriedQuery(), SECONDARY_PANE_COLLAPSE_MEDIA_QUERY);
  });
});

test("readSecondaryPaneOpen handles localStorage exceptions gracefully", () => {
  withBrokenStorage("getItem", () => {
    assert.equal(readSecondaryPaneOpen("error-key"), true);
  });
});

test("writeSecondaryPaneOpen does nothing when window is undefined", () => {
  withWindow(undefined, () => {
    assert.doesNotThrow(() => writeSecondaryPaneOpen("test-key", true));
  });
});

test("writeSecondaryPaneOpen stores open or closed string in localStorage", () => {
  withMockWindow({}, ({ storage }) => {
    writeSecondaryPaneOpen("pane-key", true);
    assert.equal(storage.getItem("pane-key"), "open");

    writeSecondaryPaneOpen("pane-key", false);
    assert.equal(storage.getItem("pane-key"), "closed");
  });
});

test("writeSecondaryPaneOpen silently absorbs storage errors", () => {
  withBrokenStorage("setItem", () => {
    assert.doesNotThrow(() => writeSecondaryPaneOpen("key", true));
  });
});
