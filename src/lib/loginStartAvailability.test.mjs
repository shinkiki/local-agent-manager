import assert from "node:assert/strict";
import test from "node:test";
import { loginStartAvailability } from "./loginStartAvailability.ts";

test("데스크톱 앱에서는 이 행을 직접 바꾼다", () => {
  assert.equal(loginStartAvailability({ nativeRuntime: true, headless: false }), "manageable");
});

test("호스트 데스크톱 앱이 있는 브라우저 화면은 그쪽을 가리킨다", () => {
  assert.equal(loginStartAvailability({ nativeRuntime: false, headless: false }), "desktopOnly");
});

test("헤드리스 기동에는 가리킬 데스크톱 앱이 없어 해당 없음이다", () => {
  assert.equal(loginStartAvailability({ nativeRuntime: false, headless: true }), "notApplicable");
});

test("헤드리스 판정이 네이티브 런타임보다 먼저다", () => {
  // 두 사정이 겹치면 "저쪽에서 바꾸세요"는 존재하지 않는 화면을 가리키게 된다.
  assert.equal(loginStartAvailability({ nativeRuntime: true, headless: true }), "notApplicable");
});
