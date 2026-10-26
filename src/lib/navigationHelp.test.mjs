import assert from "node:assert/strict";
import test from "node:test";
import { navigationHelpEmphasis, navigationHelpParagraphs, navigationHelpViews } from "./navigationHelp.ts";
import { DEFAULT_NAVIGATION_ORDER, UNCONFIGURABLE_VIEWS } from "./navigationViews.ts";

const expectedViews = ["dashboard", "chat", "sessions", "docs", "projects", "instructions", "skills", "agents", "artifacts", "workflows", "addons", "storage", "settings"];

test("every main navigation view has detailed Korean and English help", () => {
  assert.deepEqual(navigationHelpViews().sort(), [...expectedViews].sort());
  // 도움말이 붙는 화면은 메뉴 순서와 순서를 정할 수 없는 화면을 합친 것과 정확히 같다.
  // 이 성질이 깨지면 새 화면이 두 목록 어디에도 없이 도움말만 갖게 된다.
  assert.deepEqual(navigationHelpViews(), [...DEFAULT_NAVIGATION_ORDER, ...UNCONFIGURABLE_VIEWS]);
  for (const view of expectedViews) {
    const korean = navigationHelpParagraphs(view, (ko) => ko).join("\n");
    const english = navigationHelpParagraphs(view, (_ko, en) => en).join("\n");
    assert.ok(korean.length >= 40, `${view} Korean help is too short`);
    assert.ok(english.length >= 40, `${view} English help is too short`);
  }
});

test("the files view warns that registered folders join every chat workspace", () => {
  // 등록 폴더가 모든 채팅의 작업 범위에 들어가는 것은 화면을 쓰기 전에 알아야 하므로
  // 본문이 아니라 강조 문단에 있어야 한다. 강조는 두 언어가 함께 있을 때만 나온다.
  const korean = navigationHelpEmphasis("docs", (ko) => ko);
  const english = navigationHelpEmphasis("docs", (_ko, en) => en);
  assert.match(korean, /등록한 폴더는 모든 채팅/);
  assert.match(english, /every chat's workspace/);
  assert.equal(navigationHelpEmphasis("storage", (ko) => ko), null);
});

test("settings view help explains channel login authority instead of obsolete remote read-only mode", () => {
  // G11·C20: 로그인 요구가 충족되면 모든 채널이 데스크톱과 같은 권한을 가지므로,
  // 낡은 원격 읽기 전용 안내가 없어야 하고 로그인 설정과 동등 권한을 안내해야 한다.
  const korean = navigationHelpParagraphs("settings", (ko) => ko).join("\n");
  const english = navigationHelpParagraphs("settings", (_ko, en) => en).join("\n");

  assert.doesNotMatch(korean, /읽기 전용으로 표시/);
  assert.doesNotMatch(english, /read-only according to host permissions/);

  assert.match(korean, /로그인 설정/);
  assert.match(korean, /이 기기와 같은 권한/);
  assert.match(english, /Sign-in settings/);
  assert.match(english, /same (?:permissions|authority)/);
});
