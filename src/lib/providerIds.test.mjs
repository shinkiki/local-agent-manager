import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PROVIDER_IDS, isProviderId } from "./providerIds.ts";

test("공급자 목록은 화면 나열 순서를 그대로 담는다", () => {
  assert.deepEqual([...PROVIDER_IDS], ["claude", "codex", "antigravity"]);
});

test("등록된 공급자만 식별자로 인정한다", () => {
  for (const provider of PROVIDER_IDS) assert.equal(isProviderId(provider), true);
  assert.equal(isProviderId("gemini"), false);
  assert.equal(isProviderId(""), false);
  assert.equal(isProviderId(null), false);
  assert.equal(isProviderId(undefined), false);
  assert.equal(isProviderId(1), false);
});
