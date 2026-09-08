import assert from "node:assert/strict";
import test from "node:test";

import { errorText } from "./errorText.ts";

test("Error는 메시지만 남긴다", () => {
  assert.equal(errorText(new Error("백엔드에 연결하지 못했습니다")), "백엔드에 연결하지 못했습니다");
});

test("fallback이 없으면 Error가 아닌 값을 문자열로 바꾼다", () => {
  assert.equal(errorText("문자열 거절"), "문자열 거절");
  assert.equal(errorText(null), "null");
  assert.equal(errorText(undefined), "undefined");
});

test("fallback은 Error가 아닌 값에만 쓰인다", () => {
  assert.equal(errorText(new Error("원문"), "대체"), "원문");
  assert.equal(errorText("문자열 거절", "대체"), "대체");
  assert.equal(errorText(undefined, "대체"), "대체");
});
