/**
 * 제안 평가 진입점(`aiaSuggestions.ts`)이 스스로 맡는 것만 검사한다 — 카탈로그 모양을
 * 받아들이는 일과 초안 병합.
 *
 * 규칙 평가·숨김 기록·사건 감지·발송 예산·스킬 변경·프로젝트 정리는 각자 모듈로 갈라져
 * 있고 시험도 그 경계를 따른다. 스냅샷 재료는 `aiaSuggestionFixtures.mjs`가 갖는다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAiaSuggestions, mergeComposerDraft } from "./aiaSuggestions.ts";
import { catalog, definition, evaluation } from "./aiaSuggestionFixtures.mjs";

test("the evaluator accepts the nested effective-pack shape returned by core", () => {
  const nested = {
    contentDigest: "digest",
    packs: [{
      source: "commonSkill",
      skillKey: "my-pack",
      pack: catalog(definition("featureTip")).packs[0],
    }],
    definitions: [],
    issues: [],
  };
  const suggestion = evaluateAiaSuggestions(evaluation({ catalog: nested }))[0];
  assert.equal(suggestion.source, "commonSkill");
  assert.equal(suggestion.skillKey, "my-pack");
});

test("composer merge appends with one blank line and never manufactures content", () => {
  assert.equal(mergeComposerDraft("", "  제안 명령  "), "제안 명령");
  assert.equal(mergeComposerDraft("기존 초안\n\n", "제안 명령"), "기존 초안\n\n제안 명령");
  assert.equal(mergeComposerDraft("기존 초안", "   "), "기존 초안");
});
