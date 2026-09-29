import assert from "node:assert/strict";
import test from "node:test";

import { parseUnifiedDiff, unifiedDiffStats } from "./unifiedDiff.ts";

const HEADER = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
];

const kinds = (rows) => rows.map((row) => row.kind);
const numbers = (rows) => rows.map((row) => [row.before, row.after]);

test("한 hunk의 줄 번호는 머리말의 시작 줄부터 양쪽을 따로 센다", () => {
  const patch = [...HEADER, "@@ -3,4 +3,4 @@", " ctx", "-old", "+new", " tail"].join("\n") + "\n";
  const rows = parseUnifiedDiff(patch);
  assert.deepEqual(kinds(rows), ["meta", "meta", "meta", "meta", "hunk", "context", "remove", "add", "context"]);
  assert.deepEqual(numbers(rows.slice(5)), [[3, 3], [4, null], [null, 4], [5, 5]]);
  assert.equal(rows[6].text, "old");
  assert.equal(rows[7].text, "new");
  assert.equal(rows[4].text, "@@ -3,4 +3,4 @@");
});

test("두 번째 hunk는 자기 머리말의 번호로 다시 시작한다", () => {
  const patch = [
    ...HEADER,
    "@@ -1,2 +1,2 @@",
    "-a",
    "+A",
    " b",
    "@@ -10,2 +10,3 @@",
    " x",
    "+y",
    " z",
  ].join("\n");
  const rows = parseUnifiedDiff(patch);
  const second = rows.slice(rows.findIndex((row, index) => row.kind === "hunk" && index > 4) + 1);
  assert.deepEqual(numbers(second), [[10, 10], [null, 11], [11, 12]]);
});

test("개수가 빠진 머리말(`@@ -1 +1 @@`)은 한 줄로 읽고, 그 뒤 파일 머리말은 메타로 돌아간다", () => {
  const patch = [
    ...HEADER,
    "@@ -1 +1 @@",
    "-one",
    "+uno",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const rows = parseUnifiedDiff(patch);
  assert.deepEqual(kinds(rows).slice(4), ["hunk", "remove", "add", "meta", "meta", "meta", "hunk", "remove", "add"]);
  assert.deepEqual(numbers(rows).slice(5, 7), [[1, null], [null, 1]]);
});

test("끝 개행 없음 표식은 별도 행이 되고 줄 번호를 먹지 않는다", () => {
  const patch = [...HEADER, "@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+a", "\\ No newline at end of file"].join("\n");
  const rows = parseUnifiedDiff(patch);
  assert.deepEqual(kinds(rows).slice(4), ["hunk", "remove", "noNewline", "add", "noNewline"]);
  assert.equal(rows[6].text, "No newline at end of file");
  assert.deepEqual(numbers(rows).slice(5), [[1, null], [null, null], [null, 1], [null, null]]);
});

test("통계는 추가·삭제 행만 센다", () => {
  const patch = [...HEADER, "@@ -1,3 +1,4 @@", " a", "-b", "+B", "-c", "+C", "+D"].join("\n");
  assert.deepEqual(unifiedDiffStats(parseUnifiedDiff(patch)), { added: 3, removed: 2 });
  assert.deepEqual(unifiedDiffStats(parseUnifiedDiff("")), { added: 0, removed: 0 });
});

test("충돌 파일의 combined diff(@@@)는 두 칸 접두를 읽어 추가·삭제 행으로 선다", () => {
  const patch = [
    "diff --cc a.txt",
    "index 1111,2222..0000",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@@ -1,2 -1,2 +1,6 @@@",
    "  one",
    "++<<<<<<< HEAD",
    " +main",
    "++=======",
    "+ feature",
    "++>>>>>>> feature",
    "- gone",
  ].join("\n");
  const rows = parseUnifiedDiff(patch);
  assert.deepEqual(kinds(rows).slice(4), ["hunk", "context", "add", "add", "add", "add", "add", "remove"]);
  assert.equal(rows[6].text, "<<<<<<< HEAD");
  assert.deepEqual(numbers(rows).slice(5, 7), [[1, 1], [null, 2]]);
});
