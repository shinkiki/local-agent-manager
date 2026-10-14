import assert from "node:assert/strict";
import test from "node:test";
import { buildGitFileTree, collectGitFileFolderPaths } from "./gitFileTree.ts";

test("C16 파일 보기는 같은 경로 접두사를 폴더로 묶고 원래 항목을 잎에 보존한다", () => {
  const items = [
    { path: "src/components/A.tsx", marker: 1 },
    { path: "README.md", marker: 2 },
    { path: "src/lib/a.ts", marker: 3 },
  ];
  const tree = buildGitFileTree(items, (item) => item.path);

  assert.deepEqual(tree.map((node) => [node.kind, node.label]), [["folder", "src"], ["file", "README.md"]]);
  assert.equal(tree[0].count, 2);
  assert.deepEqual(tree[0].children.map((node) => [node.kind, node.label]), [["folder", "components"], ["folder", "lib"]]);
  assert.equal(tree[0].children[0].children[0].item, items[0]);
});

test("C16 폴더 경로 수집은 중첩 폴더를 빠짐없이 돌려준다", () => {
  const tree = buildGitFileTree([{ path: "a/b/one.ts" }, { path: "a/c/two.ts" }], (item) => item.path);
  assert.deepEqual(collectGitFileFolderPaths(tree), ["a", "a/b", "a/c"]);
});

test("C16 슬래시가 없는 파일과 비정상 빈 경로도 파일 잎으로 남긴다", () => {
  const items = [{ path: "top.ts" }, { path: "" }];
  const tree = buildGitFileTree(items, (item) => item.path);
  assert.deepEqual(tree.map((node) => [node.kind, node.label]), [["file", "top.ts"], ["file", ""]]);
});
