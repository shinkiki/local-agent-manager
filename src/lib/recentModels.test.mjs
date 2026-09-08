import assert from "node:assert/strict";
import test from "node:test";
import { collectRecentModels, recentModelsFor } from "./recentModels.ts";

function session(source, model, updatedAt, hidden = false) {
  return { source, model, updatedAt, meta: { hidden } };
}

test("공급자와 모델이 같은 세션은 하나로 묶고 최신순으로 돌려준다", () => {
  const models = collectRecentModels([
    session("claude", "claude-opus-5", 10),
    session("claude", "claude-opus-5", 30),
    session("claude", "claude-fable-5", 20),
    session("codex", "claude-opus-5", 40),
  ]);
  assert.deepEqual(models, [
    { source: "codex", model: "claude-opus-5", count: 1, updatedAt: 40 },
    { source: "claude", model: "claude-opus-5", count: 2, updatedAt: 30 },
    { source: "claude", model: "claude-fable-5", count: 1, updatedAt: 20 },
  ]);
});

test("모델이 없거나 숨긴 세션은 선택지에서 제외한다", () => {
  const models = collectRecentModels([
    session("claude", null, 10),
    session("claude", "claude-opus-5", 20, true),
    session("claude", "claude-fable-5", 30),
  ]);
  assert.deepEqual(models.map((option) => option.model), ["claude-fable-5"]);
});

test("공급자별로 걸러 해당 공급자에서 쓴 모델만 남긴다", () => {
  const sessions = [
    session("claude", "claude-fable-5", 30),
    session("codex", "gpt-5.6-sol", 20),
  ];
  assert.deepEqual(recentModelsFor(sessions, "claude").map((option) => option.model), ["claude-fable-5"]);
  assert.deepEqual(recentModelsFor(sessions, "antigravity"), []);
});
