import assert from "node:assert/strict";
import test from "node:test";

import {
  chatSecretMinutesLeft,
  chatSecretNameIssue,
  chatSecretPurposeIssue,
  chatSecretValueIssue,
  normalizeChatSecretName,
} from "./chatSecrets.ts";

test("이름은 대문자화되고 공백·하이픈은 밑줄이 된다", () => {
  assert.equal(normalizeChatSecretName("  my api-key "), "MY_API_KEY");
  assert.equal(normalizeChatSecretName("openai_key"), "OPENAI_KEY");
  assert.equal(normalizeChatSecretName("a".repeat(80)).length, 64);
});

test("이름 규칙은 백엔드와 같다: 대문자로 시작, 대문자·숫자·밑줄만, 1~64자", () => {
  assert.equal(chatSecretNameIssue("A"), null);
  assert.equal(chatSecretNameIssue("API_KEY_2"), null);
  assert.equal(chatSecretNameIssue("A".repeat(64)), null);
  assert.equal(chatSecretNameIssue(""), "empty");
  assert.equal(chatSecretNameIssue("A".repeat(65)), "tooLong");
  assert.equal(chatSecretNameIssue("1KEY"), "leadingLetter");
  assert.equal(chatSecretNameIssue("_KEY"), "leadingLetter");
  assert.equal(chatSecretNameIssue("api_key"), "leadingLetter");
  assert.equal(chatSecretNameIssue("API-KEY"), "charset");
  assert.equal(chatSecretNameIssue("API KEY"), "charset");
});

test("용도는 1~200자, 값은 1~4096자", () => {
  assert.equal(chatSecretPurposeIssue("  "), "empty");
  assert.equal(chatSecretPurposeIssue("배포 토큰"), null);
  assert.equal(chatSecretPurposeIssue("x".repeat(201)), "tooLong");
  assert.equal(chatSecretValueIssue(""), "empty");
  assert.equal(chatSecretValueIssue(" "), null);
  assert.equal(chatSecretValueIssue("x".repeat(4096)), null);
  assert.equal(chatSecretValueIssue("x".repeat(4097)), "tooLong");
});

test("남은 분은 올림이고, 살아 있는 값은 최소 1분, 지난 값은 0분", () => {
  assert.equal(chatSecretMinutesLeft(1_000, 0), 1);
  assert.equal(chatSecretMinutesLeft(90_000, 0), 2);
  assert.equal(chatSecretMinutesLeft(600_000, 0), 10);
  assert.equal(chatSecretMinutesLeft(0, 0), 0);
  assert.equal(chatSecretMinutesLeft(5, 10), 0);
});
