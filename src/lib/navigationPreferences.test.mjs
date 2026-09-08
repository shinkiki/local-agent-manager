import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NAVIGATION_ORDER,
  firstVisibleView,
  migrateLegacyNavigationPreferences,
  moveNavigationItem,
  normalizeNavigationPreferences,
  parseNavigationPreferences,
  PREVIEW_VIEWS,
  previewView,
  setNavigationVisibility,
  UNCONFIGURABLE_VIEWS,
} from "./navigationPreferences.ts";

// 순서를 정할 수 없는 화면 목록에서 저장값을 만든다. 여기서 `"settings"`를 다시 적으면
// 그 목록이 늘었을 때 새 화면이 정규화를 통과하는지 아무도 확인하지 않는다.
test("navigation preferences reject unconfigurable views and repair duplicate or missing menu ids", () => {
  const preferences = normalizeNavigationPreferences({
    order: ["chat", ...UNCONFIGURABLE_VIEWS, "chat", "dashboard", "unknown"],
    hidden: ["docs", ...UNCONFIGURABLE_VIEWS, "docs", "unknown"],
  });

  assert.deepEqual(preferences.order.slice(0, 2), ["chat", "dashboard"]);
  assert.deepEqual([...preferences.order].sort(), [...DEFAULT_NAVIGATION_ORDER].sort());
  assert.deepEqual(preferences.hidden, ["docs"]);
});

test("configurable and unconfigurable views never overlap", () => {
  for (const view of UNCONFIGURABLE_VIEWS) {
    assert.ok(!DEFAULT_NAVIGATION_ORDER.includes(view), `${view}는 메뉴 순서에 있어서는 안 된다`);
  }
});

// 준비중 화면은 첫 실행·손상 저장값에서 숨겨진 채 시작한다. 숨김 목록이 있으면 비어 있어도
// 사용자의 결정이므로 준비중 화면을 다시 숨기지 않는다.
test("missing or invalid navigation preferences hide preview views by default", () => {
  assert.deepEqual(parseNavigationPreferences("{"), {
    order: DEFAULT_NAVIGATION_ORDER,
    hidden: PREVIEW_VIEWS,
  });
  assert.deepEqual(parseNavigationPreferences(null).hidden, PREVIEW_VIEWS);
  assert.deepEqual(normalizeNavigationPreferences({ order: ["chat"] }).hidden, PREVIEW_VIEWS);
  assert.deepEqual(normalizeNavigationPreferences({ hidden: [] }).hidden, []);
});

test("preview views are configurable menus and are recognized by id", () => {
  for (const view of PREVIEW_VIEWS) {
    assert.ok(DEFAULT_NAVIGATION_ORDER.includes(view), `${view}는 메뉴 순서에 있어야 한다`);
    assert.ok(previewView(view));
  }
  assert.ok(!previewView("dashboard"));
  assert.ok(!previewView("settings"));
});

test("legacy v1 preferences gain preview views in hidden exactly once", () => {
  const migrated = migrateLegacyNavigationPreferences(normalizeNavigationPreferences({ order: ["chat"], hidden: ["docs"] }));
  assert.deepEqual(migrated.hidden, ["docs", ...PREVIEW_VIEWS]);
  assert.deepEqual(migrateLegacyNavigationPreferences(migrated).hidden, ["docs", ...PREVIEW_VIEWS]);
  assert.deepEqual(migrated.order, normalizeNavigationPreferences({ order: ["chat"] }).order);
});

test("visibility changes are reversible without changing the configured order", () => {
  const hidden = setNavigationVisibility(normalizeNavigationPreferences({ hidden: [] }), "chat", false);
  assert.deepEqual(hidden.hidden, ["chat"]);
  assert.deepEqual(hidden.order, DEFAULT_NAVIGATION_ORDER);

  const visible = setNavigationVisibility(hidden, "chat", true);
  assert.deepEqual(visible.hidden, []);
  assert.deepEqual(visible.order, DEFAULT_NAVIGATION_ORDER);
});

test("menu items move one position and stop at the list boundary", () => {
  const defaults = normalizeNavigationPreferences(null);
  const moved = moveNavigationItem(defaults, "chat", -1);
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
