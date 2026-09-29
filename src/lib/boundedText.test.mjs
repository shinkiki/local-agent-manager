import assert from "node:assert/strict";
import test from "node:test";

import { collapseWhitespace, countTextCharacters, textCharacters } from "./boundedText.ts";

test("문자 수는 코드 단위가 아니라 유니코드 문자로 센다", () => {
  // UTF-16 코드 단위로 세면 4가 나온다. Rust `text_limit.rs`의 `chars()` 기준은 2다.
  assert.equal("👩‍🚀".length > 2, true);
  assert.equal(countTextCharacters("🚀🚀"), 2);
  assert.equal(textCharacters("🚀가").length, 2);
});

test("값이 없으면 0자로 센다", () => {
  assert.equal(countTextCharacters(null), 0);
  assert.equal(countTextCharacters(undefined), 0);
  assert.equal(countTextCharacters(""), 0);
});

test("공백 접기는 앞뒤를 걷고 연속 공백·줄바꿈을 한 칸으로 만든다", () => {
  assert.equal(collapseWhitespace("  두   칸\n\n줄바꿈 \t탭  "), "두 칸 줄바꿈 탭");
  assert.equal(collapseWhitespace("한줄"), "한줄");
});

test("공백뿐이거나 값이 없으면 빈 문자열이다", () => {
  assert.equal(collapseWhitespace("   \n\t "), "");
  assert.equal(collapseWhitespace(null), "");
  assert.equal(collapseWhitespace(undefined), "");
});
