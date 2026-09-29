import assert from "node:assert/strict";
import test from "node:test";
import { displayPath } from "./displayPath.ts";

test("Windows extended drive paths are simplified for display", () => {
  assert.equal(
    displayPath("\\\\?\\C:\\Users\\example\\AppData\\Local\\nvm\\v22.12.0\\claude.cmd"),
    "C:\\Users\\example\\AppData\\Local\\nvm\\v22.12.0\\claude.cmd",
  );
});

test("Windows extended UNC paths keep their network path form", () => {
  assert.equal(displayPath("\\\\?\\UNC\\server\\share\\project"), "\\\\server\\share\\project");
  assert.equal(displayPath("\\\\?\\unc\\server\\share\\project"), "\\\\server\\share\\project");
});

test("ordinary paths are unchanged", () => {
  assert.equal(displayPath("C:\\workspace\\project"), "C:\\workspace\\project");
  assert.equal(displayPath("/workspace/project"), "/workspace/project");
  assert.equal(displayPath("\\\\server\\share\\project"), "\\\\server\\share\\project");
});
