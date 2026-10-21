import assert from "node:assert/strict";
import test from "node:test";
import { buildGitBranchTree, collectGitBranchFolderPaths } from "./gitBranchTree.ts";

const branch = (name, extra = {}) => ({
  name,
  sha: "0".repeat(40),
  isHead: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  committedAt: 0,
  subject: "",
  ...extra,
});

test("B4 같은 접두사 브랜치는 폴더 하나로 묶이고 잎은 마지막 조각만 보인다", () => {
  const tree = buildGitBranchTree([branch("round/lane-L02"), branch("develop"), branch("round/lane-L01")]);

  assert.deepEqual(tree.map((node) => [node.kind, node.kind === "folder" ? node.path : node.label]), [
    ["branch", "develop"],
    ["folder", "round"],
  ]);
  const round = tree[1];
  assert.equal(round.count, 2);
  assert.deepEqual(round.children.map((node) => node.label), ["lane-L02", "lane-L01"]);
});

test("B4 루트 브랜치를 먼저 모으되 같은 종류의 최근 순은 뒤집지 않는다", () => {
  const tree = buildGitBranchTree([branch("zz-newest"), branch("aa-older"), branch("ns/b"), branch("ns/a")]);

  assert.deepEqual(tree.map((node) => node.label), ["zz-newest", "aa-older", "ns"]);
  assert.deepEqual(tree[2].children.map((node) => node.label), ["b", "a"]);
});

test("B4 폴더가 먼저 들어와도 루트 브랜치 뒤로 모인다", () => {
  const tree = buildGitBranchTree([
    branch("round/lane-L02"),
    branch("develop"),
    branch("feat/login"),
    branch("main"),
    branch("round/lane-L01"),
  ]);

  assert.deepEqual(tree.map((node) => [node.kind, node.label]), [
    ["branch", "develop"],
    ["branch", "main"],
    ["folder", "round"],
    ["branch", "feat/login"],
  ]);
});

test("B4 브랜치가 하나뿐인 이름 공간은 폴더로 만들지 않는다 — 접히면 아예 안 보인다", () => {
  const tree = buildGitBranchTree([branch("origin/main")]);

  assert.deepEqual(tree.map((node) => [node.kind, node.label]), [["branch", "origin/main"]]);
  assert.deepEqual(collectGitBranchFolderPaths(tree), []);
});

test("B4 깊이 들어간 외자식도 폴더 없이 전체 이름을 가진 잎 하나로 선다", () => {
  const tree = buildGitBranchTree([branch("origin/feature/x")]);

  assert.deepEqual(tree.map((node) => [node.kind, node.label]), [["branch", "origin/feature/x"]]);
});

test("B4 브랜치 접두사는 외자식이어도 단계별 폴더로 남는다", () => {
  const tree = buildGitBranchTree([branch("origin/feature/x"), branch("origin/feature/y")]);

  assert.deepEqual([tree[0].kind, tree[0].path, tree[0].label], ["folder", "origin", "origin"]);
  assert.deepEqual(tree[0].children.map((node) => [node.kind, node.path, node.label]), [["folder", "origin/feature", "feature"]]);
  assert.deepEqual(tree[0].children[0].children.map((node) => [node.kind, node.label]), [["branch", "x"], ["branch", "y"]]);
});

test("B4 잎이 함께 있는 폴더는 이어 붙이지 않고 하위 폴더는 남은 조각만 보인다", () => {
  const tree = buildGitBranchTree([branch("origin/main"), branch("origin/feature/x"), branch("origin/feature/y")]);

  assert.deepEqual([tree[0].path, tree[0].count], ["origin", 3]);
  assert.deepEqual(tree[0].children.map((node) => [node.kind, node.label]), [["branch", "main"], ["folder", "feature"]]);
});

test("B4 폴더 안의 접두사는 브랜치 하나뿐이어도 단계별 폴더로 선다 — origin/feat/x는 origin › feat › x", () => {
  const tree = buildGitBranchTree([branch("origin/main"), branch("origin/feat/login")]);

  assert.deepEqual([tree[0].kind, tree[0].path, tree[0].count], ["folder", "origin", 2]);
  assert.deepEqual(tree[0].children.map((node) => [node.kind, node.label]), [["branch", "main"], ["folder", "feat"]]);
  const feat = tree[0].children[1];
  assert.deepEqual([feat.path, feat.count], ["origin/feat", 1]);
  assert.deepEqual(feat.children.map((node) => [node.kind, node.label]), [["branch", "login"]]);
  assert.deepEqual(collectGitBranchFolderPaths(tree), ["origin", "origin/feat"]);
});

test("B4 세 단계 접두사도 단계마다 폴더가 서고 HEAD 표식이 끝까지 올라온다", () => {
  const tree = buildGitBranchTree([
    branch("origin/main"),
    branch("origin/feat/ui/menu", { isHead: true }),
  ]);

  const feat = tree[0].children.find((node) => node.kind === "folder");
  assert.equal(feat?.label, "feat");
  const ui = feat.children[0];
  assert.deepEqual([ui.kind, ui.path, ui.label, ui.count, ui.hasHead], ["folder", "origin/feat/ui", "ui", 1, true]);
  assert.deepEqual(ui.children.map((node) => [node.kind, node.label]), [["branch", "menu"]]);
  assert.equal(tree[0].hasHead, true);
});

test("B4 HEAD가 든 폴더는 접힌 채로도 표식을 달 수 있게 hasHead가 위로 전해진다", () => {
  const tree = buildGitBranchTree([branch("round/lane-L01", { isHead: true }), branch("round/lane-L02"), branch("develop")]);

  const round = tree.find((node) => node.kind === "folder" && node.path === "round");
  assert.equal(round?.hasHead, true);
  assert.equal(tree[0].kind, "branch");
  assert.equal(tree[0].label, "develop");
});

test("B4 일괄 펴기는 중첩된 폴더 경로까지 모은다", () => {
  const tree = buildGitBranchTree([branch("a/b/one"), branch("a/b/two"), branch("a/c"), branch("top")]);

  assert.deepEqual(collectGitBranchFolderPaths(tree).sort(), ["a", "a/b"]);
});
