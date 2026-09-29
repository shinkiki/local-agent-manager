import assert from "node:assert/strict";
import test from "node:test";

import {
  firstVisibleView,
  loadNavigationPreferences,
  moveNavigationItem,
  setNavigationVisibility,
} from "./navigationPreferences.ts";
// 화면 목록은 목록을 소유한 모듈에서 직접 가져온다. 저장 규칙 모듈의 재내보내기를 지나면
// 목록이 어디 사는지가 시험에서만 흐려지고, 그 통로를 걷어낼 때 시험이 먼저 막힌다.
import { DEFAULT_NAVIGATION_ORDER, PREVIEW_VIEWS, UNCONFIGURABLE_VIEWS } from "./navigationViews.ts";

const CURRENT_KEY = "agent-manager.navigation-preferences.v3";
const LEGACY_KEY = "agent-manager.navigation-preferences.v2";
const OLDER_LEGACY_KEY = "agent-manager.navigation-preferences.v1";

function withStoredNavigationPreferences(values, run) {
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
    },
  };
  try {
    return run();
  } finally {
    globalThis.window = previousWindow;
  }
}

/**
 * 저장값 하나를 그 세대의 키에 심고 읽는다. 정규화·옛 값 옮기기·원문 해석은 모듈 안에만
 * 있으므로, 그 규칙을 확인하는 자리는 화면이 실제로 지나는 경로(저장값 → 설정)와 같다.
 * 원문을 그대로 받는 것은 깨진 JSON도 같은 자리에서 확인하기 위해서다.
 */
function storedPreferences(key, raw) {
  return withStoredNavigationPreferences(new Map([[key, raw]]), loadNavigationPreferences);
}

function currentPreferences(value) {
  return storedPreferences(CURRENT_KEY, JSON.stringify(value));
}

function legacyPreferences(value) {
  return storedPreferences(LEGACY_KEY, JSON.stringify(value));
}

// 순서를 정할 수 없는 화면 목록에서 저장값을 만든다. 여기서 `"settings"`를 다시 적으면
// 그 목록이 늘었을 때 새 화면이 정규화를 통과하는지 아무도 확인하지 않는다.
test("navigation preferences reject unconfigurable views and repair duplicate or missing menu ids", () => {
  const preferences = currentPreferences({
    order: ["chat", ...UNCONFIGURABLE_VIEWS, "chat", "dashboard", "unknown"],
    hidden: ["docs", ...UNCONFIGURABLE_VIEWS, "docs", "unknown"],
  });

  assert.deepEqual(preferences.order.slice(0, 2), ["chat", "dashboard"]);
  assert.deepEqual([...preferences.order].sort(), [...DEFAULT_NAVIGATION_ORDER].sort());
  assert.deepEqual(preferences.hidden, ["docs"]);
});

// 준비중 화면은 첫 실행·손상 저장값에서 숨겨진 채 시작한다(지금은 준비중 화면이 없어 모두
// 보인다). 숨김 목록이 있으면 비어 있어도 사용자의 결정이므로 준비중 화면을 다시 숨기지 않는다.
test("missing or invalid navigation preferences hide preview views by default", () => {
  assert.deepEqual(storedPreferences(CURRENT_KEY, "{"), {
    order: DEFAULT_NAVIGATION_ORDER,
    hidden: PREVIEW_VIEWS,
  });
  assert.deepEqual(withStoredNavigationPreferences(new Map(), loadNavigationPreferences).hidden, PREVIEW_VIEWS);
  assert.deepEqual(currentPreferences({ order: ["chat"] }).hidden, PREVIEW_VIEWS);
  assert.deepEqual(currentPreferences({ hidden: [] }).hidden, []);
});

test("legacy preferences gain preview views in hidden exactly once", () => {
  const migrated = legacyPreferences({ order: ["chat"], hidden: ["docs"] });
  assert.deepEqual(migrated.hidden, ["docs", ...PREVIEW_VIEWS]);
  // 옮긴 값이 다시 옛 키에 남아 있어도(마이그레이션 뒤 저장 전에 앱이 꺼진 기기) 준비중
  // 화면이 두 번 들어가지 않는다.
  assert.deepEqual(legacyPreferences(migrated).hidden, ["docs", ...PREVIEW_VIEWS]);
  assert.deepEqual(migrated.order, currentPreferences({ order: ["chat"] }).order);
});

// 애드온은 준비중이던 때 저장값의 hidden에 기본으로 들어갔다. 준비중이 풀렸으니 옛 키에서
// 넘어올 때 그 흔적을 걷어내야 그 시절에 앱을 켜 본 기기에서도 메뉴가 보인다. 사용자가
// 직접 숨긴 다른 화면은 그대로 남는다. 현재 키의 같은 값은 사용자의 결정이라 그대로 둔다.
test("released preview views lose their default hidden mark when legacy values migrate", () => {
  const stored = { order: ["chat"], hidden: ["docs", "addons"] };
  assert.deepEqual(legacyPreferences(stored).hidden, ["docs"]);
  assert.deepEqual(currentPreferences(stored).hidden, ["docs", "addons"]);
});

test("저장 세대는 현재 키를 우선하고 빈 현재 값이면 최신 레거시 키를 마이그레이션한다", () => {
  const current = JSON.stringify({ order: ["chat"], hidden: ["addons"] });
  const legacy = JSON.stringify({ order: ["skills"], hidden: ["docs", "addons"] });
  const olderLegacy = JSON.stringify({ order: ["sessions"], hidden: ["storage", "addons"] });

  const selectedCurrent = withStoredNavigationPreferences(new Map([
    [CURRENT_KEY, current],
    [LEGACY_KEY, legacy],
    [OLDER_LEGACY_KEY, olderLegacy],
  ]), loadNavigationPreferences);
  assert.equal(selectedCurrent.order[0], "chat");
  assert.deepEqual(selectedCurrent.hidden, ["addons"]);

  const migratedLegacy = withStoredNavigationPreferences(new Map([
    [CURRENT_KEY, ""],
    [LEGACY_KEY, legacy],
    [OLDER_LEGACY_KEY, olderLegacy],
  ]), loadNavigationPreferences);
  assert.equal(migratedLegacy.order[0], "skills");
  assert.deepEqual(migratedLegacy.hidden, ["docs"]);
});

test("visibility changes are reversible without changing the configured order", () => {
  const hidden = setNavigationVisibility({ order: DEFAULT_NAVIGATION_ORDER, hidden: [] }, "chat", false);
  assert.deepEqual(hidden.hidden, ["chat"]);
  assert.deepEqual(hidden.order, DEFAULT_NAVIGATION_ORDER);

  const visible = setNavigationVisibility(hidden, "chat", true);
  assert.deepEqual(visible.hidden, []);
  assert.deepEqual(visible.order, DEFAULT_NAVIGATION_ORDER);
});

// 한 축만 바꾸는 함수는 넘어온 값을 먼저 정규화한다. 옛 버전이 저장한 모양(순서가 빠진 값)을
// 그대로 넘겨도 기본 순서로 보완된 뒤에 자리가 바뀐다.
test("menu items move one position and stop at the list boundary", () => {
  const moved = moveNavigationItem({ order: [], hidden: [] }, "chat", -1);
  assert.deepEqual(moved.order.slice(0, 3), ["chat", "dashboard", "sessions"]);
  assert.deepEqual(moveNavigationItem(moved, "chat", -1), moved);
});

// QA #22 — 복원 폴백은 고정값 대시보드가 아니라 메뉴에 보이는 첫 화면이다.
test("firstVisibleView follows the user order and skips hidden menus", () => {
  assert.equal(firstVisibleView({ order: DEFAULT_NAVIGATION_ORDER, hidden: [] }), "dashboard");
  assert.equal(firstVisibleView({ order: DEFAULT_NAVIGATION_ORDER, hidden: ["dashboard", "chat"] }), "sessions");
  assert.equal(firstVisibleView({ order: ["skills"], hidden: ["dashboard"] }), "skills");
});

test("firstVisibleView falls back to the fixed settings menu when every configurable menu is hidden", () => {
  assert.equal(firstVisibleView({ order: DEFAULT_NAVIGATION_ORDER, hidden: [...DEFAULT_NAVIGATION_ORDER] }), "settings");
});

test("firstVisibleView normalizes stale stored preferences before choosing", () => {
  // 순서에 없는 메뉴는 기본 순서 뒤에 보완되고, 알 수 없는 값은 버려진다.
  assert.equal(firstVisibleView({ order: ["nowhere"], hidden: ["dashboard"] }), "chat");
});
