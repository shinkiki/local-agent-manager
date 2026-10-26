import assert from "node:assert/strict";
import test from "node:test";
import { layoutGitGraph } from "./gitGraph.ts";

const commit = (sha, parents = []) => ({ sha, parents });

test("C16-7 직선 이력은 같은 레인과 색을 유지한다", () => {
  const graph = layoutGitGraph([
    commit("three", ["two"]),
    commit("two", ["one"]),
    commit("one"),
  ]);

  assert.equal(graph.columns, 1);
  assert.deepEqual(graph.rows.map(({ lane, color }) => [lane, color]), [[0, 0], [0, 0], [0, 0]]);
});

test("C16-7 병합 이력은 옆 레인을 만들고 공통 부모에서 다시 합친다", () => {
  const graph = layoutGitGraph([
    commit("merge", ["main", "side"]),
    commit("main", ["root"]),
    commit("side", ["root"]),
    commit("root"),
  ]);

  assert.equal(graph.columns, 2);
  assert.deepEqual(graph.rows.map(({ lane, color }) => [lane, color]), [[0, 0], [0, 0], [1, 1], [0, 0]]);
  assert.deepEqual(
    graph.rows[0].segments.map(({ from, to, start, color }) => [from, to, start, color]),
    [[0, 0, "node", 0], [0, 1, "node", 1]],
  );
  assert.deepEqual(graph.rows[1].tails, [{ lane: 0, color: 0 }, { lane: 1, color: 1 }]);
  assert.deepEqual(graph.rows[2].tails, [{ lane: 0, color: 0 }]);
  assert.deepEqual(
    graph.rows[2].segments.map(({ from, to, start, color }) => [from, to, start, color]),
    [[0, 0, "top", 0], [1, 0, "node", 0]],
  );
});

test("C16-7 커밋 목록이 비었으면 행과 열 모두 0이다", () => {
  const graph = layoutGitGraph([]);
  assert.equal(graph.columns, 0);
  assert.deepEqual(graph.rows, []);
});

test("C16-7 동일한 부모가 중복되어도 합류선 세그먼트는 한 번만 생성된다", () => {
  const graph = layoutGitGraph([
    commit("child", ["parent", "parent"]),
    commit("parent"),
  ]);

  assert.equal(graph.columns, 1);
  assert.deepEqual(
    graph.rows[0].segments.map(({ from, to, start, color }) => [from, to, start, color]),
    [[0, 0, "node", 0]],
    "중복 부모여도 node 세그먼트는 한 번만 남아야 한다",
  );
});

test("C16-7 3개 이상의 부모를 가진 병합 커밋(옥토퍼스)도 모든 부모 레인으로 선을 연결한다", () => {
  const graph = layoutGitGraph([
    commit("octopus", ["p1", "p2", "p3"]),
    commit("p1"),
    commit("p2"),
    commit("p3"),
  ]);

  assert.equal(graph.columns, 3);
  assert.deepEqual(
    graph.rows[0].segments.map(({ from, to, start, color }) => [from, to, start, color]),
    [[0, 0, "node", 0], [0, 1, "node", 1], [0, 2, "node", 2]],
  );
});

