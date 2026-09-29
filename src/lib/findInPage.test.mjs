import assert from "node:assert/strict";
import test from "node:test";
import { clampMatchIndex, findMatches, isFindShortcut, stepMatchIndex, topmostSurfaceIndex } from "./findInPage.ts";

test("Cmd+F on macOS and Ctrl+F elsewhere open find", () => {
  assert.equal(isFindShortcut({ key: "f", metaKey: true }), true);
  assert.equal(isFindShortcut({ key: "F", metaKey: true }), true);
  assert.equal(isFindShortcut({ key: "f", ctrlKey: true }), true);
});

test("a bare f, other keys, and extra modifiers are not the shortcut", () => {
  assert.equal(isFindShortcut({ key: "f" }), false);
  assert.equal(isFindShortcut({ key: "g", metaKey: true }), false);
  assert.equal(isFindShortcut({ key: "f", metaKey: true, shiftKey: true }), false);
  assert.equal(isFindShortcut({ key: "f", ctrlKey: true, altKey: true }), false);
  // 둘 다 눌린 조합은 어느 플랫폼의 찾기도 아니다.
  assert.equal(isFindShortcut({ key: "f", ctrlKey: true, metaKey: true }), false);
});

test("matches are collected per text chunk, ignoring case", () => {
  assert.deepEqual(findMatches(["Hello hello", "world"], "hello"), [
    { nodeIndex: 0, start: 0, end: 5 },
    { nodeIndex: 0, start: 6, end: 11 },
  ]);
  assert.deepEqual(findMatches(["대화 내용", "다른 대화"], "대화"), [
    { nodeIndex: 0, start: 0, end: 2 },
    { nodeIndex: 1, start: 3, end: 5 },
  ]);
});

test("an empty or blank query matches nothing", () => {
  assert.deepEqual(findMatches(["Hello"], ""), []);
  assert.deepEqual(findMatches(["Hello"], "   "), []);
});

test("a word split across chunks is not matched", () => {
  assert.deepEqual(findMatches(["he", "llo"], "hello"), []);
});

test("overlapping occurrences advance past the match", () => {
  assert.deepEqual(findMatches(["aaaa"], "aa"), [
    { nodeIndex: 0, start: 0, end: 2 },
    { nodeIndex: 0, start: 2, end: 4 },
  ]);
});

test("a chunk whose lowercase changes length stays case-sensitive", () => {
  // "İ".toLowerCase() 는 두 글자라 소문자 기준 자리 번호가 원문과 어긋난다.
  const chunk = "İstanbul code";
  assert.notEqual(chunk.toLowerCase().length, chunk.length);
  const [match] = findMatches([chunk], "code");
  assert.deepEqual(chunk.slice(match.start, match.end), "code");
  assert.deepEqual(findMatches([chunk], "CODE"), []);
});

test("stepping wraps around both ends", () => {
  assert.equal(stepMatchIndex(0, 3, 1), 1);
  assert.equal(stepMatchIndex(2, 3, 1), 0);
  assert.equal(stepMatchIndex(0, 3, -1), 2);
  assert.equal(stepMatchIndex(0, 0, 1), 0);
});

test("the shortcut goes to the topmost surface that is on screen", () => {
  const chatView = { priority: 10, available: true };
  const drawer = { priority: 20, available: true };
  const popup = { priority: 30, available: true };
  assert.equal(topmostSurfaceIndex([chatView, drawer, popup]), 2);
  assert.equal(topmostSurfaceIndex([chatView, drawer, { ...popup, available: false }]), 1);
  assert.equal(topmostSurfaceIndex([{ ...chatView, available: false }]), -1);
  assert.equal(topmostSurfaceIndex([]), -1);
});

test("equal priorities go to the surface registered last", () => {
  assert.equal(topmostSurfaceIndex([
    { priority: 30, available: true },
    { priority: 30, available: true },
  ]), 1);
});

test("the index stays inside the current match count", () => {
  assert.equal(clampMatchIndex(5, 3), 2);
  assert.equal(clampMatchIndex(1, 3), 1);
  assert.equal(clampMatchIndex(2, 0), 0);
  assert.equal(clampMatchIndex(-1, 3), 0);
});
