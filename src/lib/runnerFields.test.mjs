import assert from "node:assert/strict";
import test from "node:test";

import { parseWholeNumber, runnerPathKey, runnerProjectName, wholeNumberWithin } from "./runnerFields.ts";

test("parseWholeNumber accepts only whole digit strings, with surrounding whitespace", () => {
  assert.equal(parseWholeNumber("4"), 4);
  assert.equal(parseWholeNumber(" 12 "), 12);
  assert.equal(parseWholeNumber("007"), 7);
  assert.equal(parseWholeNumber("0"), 0);
});

test("parseWholeNumber refuses values the number input passes through but parseInt would truncate", () => {
  // `1e1` is 10 to the browser and 1 to parseInt — the stored value must not silently differ from what the user saw.
  for (const value of ["1e1", "3.5", "7x", "-1", "+2", ".", "", "  ", "abc", "1 2", "٣", "１"]) {
    assert.equal(parseWholeNumber(value), null, value);
  }
});

test("parseWholeNumber refuses digits beyond the safe integer range", () => {
  assert.equal(parseWholeNumber("9007199254740991"), 9007199254740991);
  assert.equal(parseWholeNumber("9007199254740992"), null);
});

test("wholeNumberWithin bounds a parsed value inclusively and is false for a non-value", () => {
  assert.equal(wholeNumberWithin("1", 1, 8), true);
  assert.equal(wholeNumberWithin("8", 1, 8), true);
  assert.equal(wholeNumberWithin("0", 1, 8), false);
  assert.equal(wholeNumberWithin("9", 1, 8), false);
  assert.equal(wholeNumberWithin("3.5", 1, 8), false);
  assert.equal(wholeNumberWithin("0", 0, 4_294_967_295), true);
});

test("runnerPathKey strips the Windows extended prefix and trailing separators only", () => {
  assert.equal(runnerPathKey("/workspace/app/"), "/workspace/app");
  assert.equal(runnerPathKey("\\\\?\\C:\\work\\app\\"), "C:\\work\\app");
  assert.equal(runnerPathKey("/workspace/app"), "/workspace/app");
});

test("runnerProjectName folds the project name into the backend's [a-z0-9._-]{1,64} shape", () => {
  assert.equal(runnerProjectName("Dead Route Game", "/workspace/dead-route-game", []), "dead-route-game");
  assert.equal(runnerProjectName("  qa_lite.v2  ", "/workspace/qa-lite", []), "qa_lite.v2");
  assert.equal(runnerProjectName("--A//B--", "/x", []), "a-b");
  const long = runnerProjectName("x".repeat(80), "/x", []);
  assert.equal(long.length, 64);
  for (const value of [runnerProjectName("Dead Route Game", "/x", []), long]) {
    assert.match(value, /^[a-z0-9._-]{1,64}$/);
  }
});

test("runnerProjectName falls back to the folder name, then to project", () => {
  assert.equal(runnerProjectName("데드 루트", "/workspace/Dead-Route/", []), "dead-route");
  assert.equal(runnerProjectName("..", "/workspace/..", []), "project");
  assert.equal(runnerProjectName("문서", "/workspace/문서", []), "project");
});

test("runnerProjectName avoids names already used by other rows", () => {
  assert.equal(runnerProjectName("app", "/a/app", ["app"]), "app-2");
  assert.equal(runnerProjectName("app", "/a/app", ["app", "app-2"]), "app-3");
  const long = "y".repeat(64);
  const next = runnerProjectName(long, "/y", [long]);
  assert.equal(next.length, 64);
  assert.ok(next.endsWith("-2"));
});
