import assert from "node:assert/strict";
import test from "node:test";
import { navigationHelpDescription, navigationHelpViews } from "./navigationHelp.ts";
import { DEFAULT_NAVIGATION_ORDER, UNCONFIGURABLE_VIEWS } from "./navigationPreferences.ts";

const expectedViews = ["dashboard", "chat", "sessions", "docs", "instructions", "skills", "agents", "artifacts", "workflows", "addons", "storage", "settings"];

test("every main navigation view has detailed Korean and English help", () => {
  assert.deepEqual(navigationHelpViews().sort(), [...expectedViews].sort());
  // 도움말이 붙는 화면은 메뉴 순서와 순서를 정할 수 없는 화면을 합친 것과 정확히 같다.
  // 이 성질이 깨지면 새 화면이 두 목록 어디에도 없이 도움말만 갖게 된다.
  assert.deepEqual(navigationHelpViews(), [...DEFAULT_NAVIGATION_ORDER, ...UNCONFIGURABLE_VIEWS]);
  for (const view of expectedViews) {
    const korean = navigationHelpDescription(view, (ko) => ko);
    const english = navigationHelpDescription(view, (_ko, en) => en);
    assert.ok(korean.length >= 40, `${view} Korean help is too short`);
    assert.ok(english.length >= 40, `${view} English help is too short`);
  }
});
