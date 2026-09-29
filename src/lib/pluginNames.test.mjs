import test from "node:test";
import assert from "node:assert/strict";
import { splitPluginNames } from "./pluginNames.ts";

// 9.12: 사용자가 적은 한 줄이 그대로 플러그인의 이름 목록이 된다.
test("쉼표와 줄바꿈으로 나누고 공백·빈 것·중복을 뺀다", () => {
  assert.deepEqual(splitPluginNames(" 노션, Notion ,,\n노션\n"), ["노션", "Notion"]);
  assert.deepEqual(splitPluginNames(""), []);
  assert.deepEqual(splitPluginNames("   "), []);
});
