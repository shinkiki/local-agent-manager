import assert from "node:assert/strict";
import test from "node:test";

import { skillDescriptionError, skillKeyError } from "./skillLibraryInput.ts";

const ko = (korean) => korean;

test("이름 규칙은 Rust `validate_skill_key`와 같은 값을 거절한다", () => {
  assert.equal(skillKeyError("my-skill", ko), null);
  assert.notEqual(skillKeyError("", ko), null);
  assert.notEqual(skillKeyError("-head", ko), null);
  assert.notEqual(skillKeyError("tail-", ko), null);
  assert.notEqual(skillKeyError("Upper", ko), null);
  assert.notEqual(skillKeyError("con", ko), null);
});

// AM: 상한을 재는 단위. Rust는 `chars().count()`(코드 포인트)로 세는데 화면이 `.length`
// (UTF-16 코드 단위)로 세면, 서로게이트 쌍이 섞인 입력에서 서버가 받아 줄 값을 화면이
// 먼저 거절한다. 사용자는 규칙대로 적었는데 저장 버튼이 열리지 않는다.
test("이름 길이는 코드 단위가 아니라 유니코드 문자로 센다", () => {
  // 32개의 서로게이트 쌍 = 코드 포인트 32자, UTF-16 64단위. 상한은 64자다.
  assert.equal(skillKeyError("a".repeat(64), ko), null);
  assert.notEqual(skillKeyError("a".repeat(65), ko), null);
});

test("설명 길이는 코드 단위가 아니라 유니코드 문자로 센다", () => {
  // 600개의 이모지 = 600자인데 `.length`로 세면 1200단위라 1024자 상한에 걸린다.
  assert.equal(skillDescriptionError("🚀".repeat(600), ko), null);
  assert.equal(skillDescriptionError("가".repeat(1024), ko), null);
  assert.notEqual(skillDescriptionError("🚀".repeat(1025), ko), null);
  assert.notEqual(skillDescriptionError("", ko), null);
});
