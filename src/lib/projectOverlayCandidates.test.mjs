import assert from "node:assert/strict";
import test from "node:test";
import { projectOverlayCandidates } from "./projectOverlayCandidates.ts";

const entry = (path, overrides = {}) => ({
  path,
  originalPath: null,
  indexStatus: "unmodified",
  worktreeStatus: "modified",
  isSubmodule: false,
  unmerged: null,
  renameScore: null,
  ...overrides,
});

test("C19-3: unavailable or empty status has no candidates", () => {
  assert.deepEqual(projectOverlayCandidates(null), []);
  assert.deepEqual(projectOverlayCandidates({ entries: [] }), []);
});

test("C19-3: only modified worktree entries are candidates", () => {
  const kinds = ["unmodified", "typeChanged", "added", "deleted", "renamed", "copied", "untracked", "ignored", "unmerged"];
  assert.deepEqual(projectOverlayCandidates({ entries: [
    ...kinds.map((kind) => entry(kind, { worktreeStatus: kind })),
    entry("worktree.ts"),
  ] }), ["worktree.ts"]);
});

test("C19-3: conflict markers and submodules independently exclude modified entries", () => {
  assert.deepEqual(projectOverlayCandidates({ entries: [
    entry("conflict.ts", { unmerged: "UU" }),
    entry("module", { isSubmodule: true }),
    entry("ordinary.ts"),
  ] }), ["ordinary.ts"]);
});

test("C19-3: staged changes alone are excluded while staged and unstaged changes remain selectable", () => {
  assert.deepEqual(projectOverlayCandidates({ entries: [
    entry("staged.ts", { indexStatus: "modified", worktreeStatus: "unmodified" }),
    entry("both.ts", { indexStatus: "modified" }),
  ] }), ["both.ts"]);
});

test("C19-3: selection preserves path spelling, order and frozen input", () => {
  const entries = Object.freeze([
    Object.freeze(entry("z/설정 파일.ts")),
    Object.freeze(entry(".env")),
    Object.freeze(entry("a.ts")),
  ]);
  const status = Object.freeze({ entries });
  const candidates = projectOverlayCandidates(status);
  assert.deepEqual(candidates, ["z/설정 파일.ts", ".env", "a.ts"]);
  candidates.reverse();
  assert.deepEqual(projectOverlayCandidates(status), ["z/설정 파일.ts", ".env", "a.ts"]);
});
