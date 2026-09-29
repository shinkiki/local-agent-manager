import assert from "node:assert/strict";
import test from "node:test";
import { readStoredText, writeStoredText } from "./storedText.ts";
import {
  setWindow,
  useBlockedStorageWindow,
  useStorageWindow,
  useThrowingStorageWindow,
} from "./storedTextFixtures.mjs";

test("읽기는 저장된 원문을, 없으면 null을 준다", () => {
  useStorageWindow({ a: "1" });
  assert.equal(readStoredText("a"), "1");
  assert.equal(readStoredText("b"), null);
});

test("쓰기는 같은 키로 읽히는 값을 남긴다", () => {
  const store = useStorageWindow();
  writeStoredText("a", "1");
  assert.equal(store.get("a"), "1");
  assert.equal(readStoredText("a"), "1");
});

test("저장소 접근 자체가 던져도 읽기는 null, 쓰기는 무동작이다", () => {
  useBlockedStorageWindow();
  assert.equal(readStoredText("a"), null);
  assert.doesNotThrow(() => writeStoredText("a", "1"));
});

test("저장소 호출이 던져도 읽기는 null, 쓰기는 무동작이다", () => {
  useThrowingStorageWindow();
  assert.equal(readStoredText("a"), null);
  assert.doesNotThrow(() => writeStoredText("a", "1"));
});

test("window가 없는 실행에서는 저장값이 없는 것과 같다", () => {
  setWindow(undefined);
  assert.equal(readStoredText("a"), null);
  assert.doesNotThrow(() => writeStoredText("a", "1"));
});
