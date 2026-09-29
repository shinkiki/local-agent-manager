import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NAVIGATION_ORDER,
  PREVIEW_VIEWS,
  previewView,
  UNCONFIGURABLE_VIEWS,
} from "./navigationViews.ts";

/**
 * 화면 목록 자체의 성질 — 어떤 화면이 있고, 그중 무엇을 사용자가 정할 수 있고, 무엇이
 * 준비중인가. 이 셋은 저장 세대·마이그레이션과 아무 값도 나누지 않는데
 * `navigationPreferences`의 시험에 얹혀 그 모듈의 재내보내기를 지나고 있었다. 목록이
 * 어디 사는지가 시험에서만 흐려지던 자리라, 소유 모듈 옆으로 옮겨 둔다.
 */

test("configurable and unconfigurable views never overlap", () => {
  for (const view of UNCONFIGURABLE_VIEWS) {
    assert.ok(!DEFAULT_NAVIGATION_ORDER.includes(view), `${view}는 메뉴 순서에 있어서는 안 된다`);
  }
});

test("preview views are configurable menus and are recognized by id", () => {
  for (const view of PREVIEW_VIEWS) {
    assert.ok(DEFAULT_NAVIGATION_ORDER.includes(view), `${view}는 메뉴 순서에 있어야 한다`);
    assert.ok(previewView(view));
  }
  assert.ok(!previewView("dashboard"));
  assert.ok(!previewView("settings"));
});

// 준비중 태그가 붙는 화면이 지금은 없다. 태그와 기본 숨김 기계는 남겨 두었으므로 목록만
// 비어 있어야 하고, 어떤 화면도 태그를 달지 않아야 한다.
test("no menu is marked as a preview view", () => {
  assert.deepEqual(PREVIEW_VIEWS, []);
  for (const view of DEFAULT_NAVIGATION_ORDER) assert.ok(!previewView(view), `${view}에는 준비중 태그가 붙지 않는다`);
  assert.ok(!previewView("settings"));
});
