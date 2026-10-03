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
