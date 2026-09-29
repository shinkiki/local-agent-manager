import assert from "node:assert/strict";
import test from "node:test";

import { gitChangeCode, gitChangeLabelKey, groupGitStatus } from "./gitStatus.ts";

const entry = (path, indexStatus, worktreeStatus, overrides = {}) => ({
  path,
  originalPath: null,
  indexStatus,
  worktreeStatus,
  isSubmodule: false,
  unmerged: null,
  renameScore: null,
  ...overrides,
});

const paths = (entries) => entries.map((item) => item.path);

test("인덱스와 작업 트리에 모두 변경이 있는 항목은 두 묶음에 함께 선다", () => {
  const groups = groupGitStatus([
    entry("a.ts", "modified", "unmodified"),
    entry("b.ts", "unmodified", "modified"),
    entry("both.ts", "modified", "modified"),
    entry("new.ts", "added", "unmodified"),
  ]);
  assert.deepEqual(paths(groups.staged), ["a.ts", "both.ts", "new.ts"]);
  assert.deepEqual(paths(groups.unstaged), ["b.ts", "both.ts"]);
  assert.deepEqual(groups.untracked, []);
  assert.deepEqual(groups.conflicted, []);
});

test("추적 안 됨은 자기 묶음에만 서고 무시 항목은 어디에도 서지 않는다", () => {
  const groups = groupGitStatus([
    entry("c.txt", "untracked", "untracked"),
    entry("build/", "ignored", "ignored"),
  ]);
  assert.deepEqual(paths(groups.untracked), ["c.txt"]);
  assert.deepEqual(groups.staged, []);
  assert.deepEqual(groups.unstaged, []);
});

test("충돌은 다른 묶음보다 앞선다 — porcelain 코드로도, 종류로도", () => {
  const groups = groupGitStatus([
    entry("d.ts", "modified", "modified", { unmerged: "UU" }),
    entry("e.ts", "unmerged", "unmerged"),
    entry("f.ts", "added", "untracked", { unmerged: "AU" }),
  ]);
  assert.deepEqual(paths(groups.conflicted), ["d.ts", "e.ts", "f.ts"]);
  assert.deepEqual(groups.staged, []);
  assert.deepEqual(groups.unstaged, []);
  assert.deepEqual(groups.untracked, []);
});

test("한 글자 코드는 물어본 쪽의 상태를 따르고 충돌은 항상 U다", () => {
  const both = entry("x", "renamed", "modified", { originalPath: "y" });
  assert.equal(gitChangeCode(both, "index"), "R");
  assert.equal(gitChangeCode(both, "worktree"), "M");
  assert.equal(gitChangeCode(entry("n", "added", "unmodified"), "index"), "A");
  assert.equal(gitChangeCode(entry("n", "unmodified", "deleted"), "worktree"), "D");
  assert.equal(gitChangeCode(entry("n", "typeChanged", "copied"), "index"), "T");
  assert.equal(gitChangeCode(entry("n", "typeChanged", "copied"), "worktree"), "C");
  assert.equal(gitChangeCode(entry("u", "untracked", "untracked"), "worktree"), "?");
  assert.equal(gitChangeCode(entry("c", "modified", "modified", { unmerged: "UU" }), "index"), "U");
  assert.equal(gitChangeCode(entry("c", "modified", "modified", { unmerged: "UU" }), "worktree"), "U");
});

test("라벨 키는 종류마다 하나씩 안정적으로 돌아온다", () => {
  assert.equal(gitChangeLabelKey("modified"), "modified");
  assert.equal(gitChangeLabelKey("typeChanged"), "typeChanged");
  assert.equal(gitChangeLabelKey("untracked"), "untracked");
});
