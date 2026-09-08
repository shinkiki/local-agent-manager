import assert from "node:assert/strict";
import test from "node:test";
import { collapseUnchanged, diffLines, diffStats } from "./textDiff.ts";

const kinds = (lines) => lines.map((line) => `${line.kind}:${line.text}`);

test("identical inputs produce only same lines with matching numbers", () => {
  const lines = diffLines("a\nb\nc\n", "a\nb\nc\n");
  assert.deepEqual(kinds(lines), ["same:a", "same:b", "same:c"]);
  assert.deepEqual(lines.map((line) => [line.before, line.after]), [[1, 1], [2, 2], [3, 3]]);
});

test("insertion, deletion and replacement are attributed to the right side", () => {
  assert.deepEqual(kinds(diffLines("a\nc\n", "a\nb\nc\n")), ["same:a", "add:b", "same:c"]);
  assert.deepEqual(kinds(diffLines("a\nb\nc\n", "a\nc\n")), ["same:a", "remove:b", "same:c"]);
  const replaced = diffLines("a\nold\nc\n", "a\nnew\nc\n");
  assert.deepEqual(kinds(replaced), ["same:a", "remove:old", "add:new", "same:c"]);
  assert.deepEqual(replaced.map((line) => [line.before ?? null, line.after ?? null]), [[1, 1], [2, null], [null, 2], [3, 3]]);
});

test("trailing newline presence shows up as a last-line change, not a phantom line", () => {
  assert.deepEqual(kinds(diffLines("a\nb\n", "a\nb")), ["same:a", "same:b"]);
  assert.deepEqual(kinds(diffLines("", "x\n")), ["add:x"]);
  assert.deepEqual(kinds(diffLines("x\n", "")), ["remove:x"]);
});

test("stats count added and removed lines", () => {
  assert.deepEqual(diffStats(diffLines("a\nb\n", "a\nc\nd\n")), { added: 2, removed: 1 });
});

test("collapseUnchanged keeps context around changes and folds the rest", () => {
  const before = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
  const after = before.replace("l6", "L6");
  const rows = collapseUnchanged(diffLines(before, after), 2);
  assert.deepEqual(
    rows.map((row) => (row.kind === "skip" ? `skip:${row.count}` : `${row.kind}:${row.text}`)),
    ["skip:3", "same:l4", "same:l5", "remove:l6", "add:L6", "same:l7", "same:l8", "skip:4"],
  );
  // 변경이 없으면 전부 접힌다.
  assert.deepEqual(collapseUnchanged(diffLines("a\nb\n", "a\nb\n")), [{ kind: "skip", count: 2 }]);
});
