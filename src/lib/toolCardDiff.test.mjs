import assert from "node:assert/strict";
import test from "node:test";

import { fileEditRows, toolCardDiffStats, toolCardEditPreview, toolCardFileEdits } from "./toolCardDiff.ts";

const kinds = (rows) => rows.map((row) => row.kind);

test("Claude Edit은 바꾼 조각을 줄 번호 없이 앞뒤 비교한다", () => {
  const detail = JSON.stringify({ file_path: "/w/a.ts", old_string: "a\nb\nc", new_string: "a\nB\nc" }, null, 2);
  const edits = toolCardFileEdits("Edit", detail);
  assert.deepEqual(edits, [{ kind: "replace", path: "/w/a.ts", pairs: [{ before: "a\nb\nc", after: "a\nB\nc", replaceAll: false }] }]);
  const rows = fileEditRows(edits[0]);
  assert.deepEqual(kinds(rows), ["context", "remove", "add", "context"]);
  assert.ok(rows.every((row) => row.before === null && row.after === null));
  assert.deepEqual(toolCardDiffStats(rows), { added: 1, removed: 1 });
  assert.equal(toolCardEditPreview(edits), "/w/a.ts");
});

test("MultiEdit은 편집마다 구분선을 세우고 replace_all을 표시한다", () => {
  const edits = toolCardFileEdits("MultiEdit", {
    file_path: "/w/a.ts",
    edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q", replace_all: true }],
  });
  const rows = fileEditRows(edits[0]);
  assert.deepEqual(kinds(rows), ["editBoundary", "remove", "add", "editBoundary", "remove", "add"]);
  assert.deepEqual(rows[3], { kind: "editBoundary", index: 2, total: 2, replaceAll: true });
});

test("한 조각의 긴 동일 구간은 앞뒤 3줄만 남기고 접는다", () => {
  const same = Array.from({ length: 10 }, (_, index) => `l${index}`).join("\n");
  const [edit] = toolCardFileEdits("Edit", { file_path: "/w/a", old_string: `${same}\nold`, new_string: `${same}\nnew` });
  assert.deepEqual(kinds(fileEditRows(edit)), ["skip", "context", "context", "context", "remove", "add"]);
});

test("Write는 새 내용 전부를 1번부터 번호 붙은 추가 줄로 본다", () => {
  const [edit] = toolCardFileEdits("Write", { file_path: "/w/n.md", content: "one\ntwo\n" });
  const rows = fileEditRows(edit);
  assert.deepEqual(rows.map((row) => [row.kind, row.after, row.text]), [["add", 1, "one"], ["add", 2, "two"]]);
});

test("Claude 도구라도 인자 모양이 다르면 diff가 아니다", () => {
  assert.equal(toolCardFileEdits("Edit", { file_path: "/w/a" }), null);
  assert.equal(toolCardFileEdits("Write", { file_path: "/w/a" }), null);
  assert.equal(toolCardFileEdits("MultiEdit", { file_path: "/w/a", edits: [] }), null);
  assert.equal(toolCardFileEdits("Edit", "not json"), null);
  // 다른 도구의 {file_path, content}는 이름으로 거른다.
  assert.equal(toolCardFileEdits("Read", { file_path: "/w/a", content: "x" }), null);
});

test("Codex 실행 중 카드의 changes 배열은 파일별 패치다", () => {
  const changes = [
    { path: "/w/a.rs", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n" },
    { path: "/w/b.rs", kind: { type: "add" }, diff: "fn main() {}\n" },
    { path: "/w/c.rs", kind: { type: "update", move_path: "/w/d.rs" }, diff: "@@ -1 +1 @@\n-x\n+y\n" },
  ];
  const edits = toolCardFileEdits("파일 변경", JSON.stringify(changes, null, 2));
  assert.equal(edits.length, 3);
  assert.deepEqual(kinds(fileEditRows(edits[0])), ["hunk", "context", "remove", "add"]);
  assert.deepEqual(fileEditRows(edits[1]).map((row) => [row.kind, row.after]), [["add", 1]]);
  assert.equal(edits[2].movePath, "/w/d.rs");
  assert.equal(toolCardEditPreview(edits), "/w/a.rs +2");
});

test("Codex 지난 기록의 changes 맵은 새 모양과 옛 모양을 같이 읽는다", () => {
  const edits = toolCardFileEdits("파일 변경", {
    "/w/a.rs": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: null },
    "/w/b.rs": { type: "add", content: "x\n" },
    "/w/c.rs": { delete: { content: "gone\n" } },
  });
  assert.deepEqual(edits.map((edit) => [edit.path, edit.change]), [["/w/a.rs", "update"], ["/w/b.rs", "add"], ["/w/c.rs", "delete"]]);
  assert.deepEqual(fileEditRows(edits[2]).map((row) => [row.kind, row.before]), [["remove", 1]]);
});

test("파일 변경 모양이 아닌 다른 도구 인자는 null이다", () => {
  assert.equal(toolCardFileEdits("exec", { command: "ls" }), null);
  assert.equal(toolCardFileEdits("mcp", { a: { type: "update" } }), null);
  assert.equal(toolCardFileEdits("mcp", [{ path: "/w/a" }]), null);
  assert.equal(toolCardFileEdits("mcp", []), null);
  assert.equal(toolCardFileEdits("mcp", {}), null);
});
