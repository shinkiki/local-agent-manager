import assert from "node:assert/strict";
import test from "node:test";
import { parseStoredRuntimeLocale } from "./i18nRuntime.ts";

test("런타임 언어 캐시의 언어와 문구를 함께 복원한다", () => {
  assert.deepEqual(
    parseStoredRuntimeLocale(JSON.stringify({ locale: "ja", messages: { "대시보드": "ダッシュボード" } })),
    { locale: "ja", messages: { "대시보드": "ダッシュボード" } },
  );
});

test("비었거나 손상된 런타임 언어 캐시는 무시한다", () => {
  assert.equal(parseStoredRuntimeLocale(null), null);
  assert.equal(parseStoredRuntimeLocale("{"), null);
  assert.equal(parseStoredRuntimeLocale(JSON.stringify({ locale: "en" })), null);
  assert.equal(parseStoredRuntimeLocale(JSON.stringify({ messages: {} })), null);
});
