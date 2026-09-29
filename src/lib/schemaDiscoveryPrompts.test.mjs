import assert from "node:assert/strict";
import test from "node:test";
import { catalogResetPrompt, schemaDiscoveryPrompt } from "./schemaDiscoveryPrompts.ts";

test("재조사 요청문은 모델과 추론 수준 조사까지 지시한다", () => {
  const prompt = schemaDiscoveryPrompt(["claude", "codex"]);
  assert.match(prompt, /claude, codex/);
  assert.match(prompt, /propose_chat_settings_schema/);
  assert.match(prompt, /models/);
  assert.match(prompt, /reasoningEfforts/);
  assert.match(prompt, /생략하면 기존 제안을 유지/);
  assert.match(prompt, /빈 배열로 보내면 fields 제안만 제거/);
});

test("되돌리기 요청문은 빈 배열로 제안만 제거하도록 지시한다", () => {
  const prompt = catalogResetPrompt(["claude"]);
  assert.match(prompt, /models: \[\], reasoningEfforts: \[\]/);
  assert.match(prompt, /fields는 넘기지 마세요/);
});
