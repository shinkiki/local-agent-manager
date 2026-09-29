import assert from "node:assert/strict";
import test from "node:test";

import { MAX_HIGHLIGHT_CHARACTERS, highlightCode } from "./codeHighlight.ts";

// 하이라이터 한 벌의 수명과 다룰 수 있는 원문 크기만 본다. 어떤 언어를 아는지와 파일명에서
// 언어를 고르는 규칙은 codeLanguages.test.mjs가 맡는다 — 모듈이 갈라진 경계와 같다.

test("MAX_HIGHLIGHT_CHARACTERS is 1,000,000", () => {
  assert.equal(MAX_HIGHLIGHT_CHARACTERS, 1_000_000);
});

test("highlightCode returns null when content exceeds MAX_HIGHLIGHT_CHARACTERS", async () => {
  const hugeContent = "x".repeat(MAX_HIGHLIGHT_CHARACTERS + 1);
  const lang = { id: "rust", label: "Rust" };
  const tokens = await highlightCode(hugeContent, lang);
  assert.equal(tokens, null);
});

test("highlightCode tokenizes simple code snippet", async () => {
  const code = 'const greeting = "hello";';
  const lang = { id: "typescript", label: "TypeScript" };
  const tokens = await highlightCode(code, lang);
  assert.ok(Array.isArray(tokens));
  assert.ok(tokens.length > 0);
  assert.ok(Array.isArray(tokens[0]));
});
