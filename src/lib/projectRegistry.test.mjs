import assert from "node:assert/strict";
import test from "node:test";
import {
  excludedProjectPaths,
  filterProjectRegistry,
  pendingProjectsKey,
  projectRegistrySummary,
  splitProjectRegistry,
} from "./projectRegistry.ts";

function entry(overrides) {
  return {
    path: "/repos/alpha",
    name: "alpha",
    sessionCount: 1,
    hiddenSessionCount: 0,
    updatedAt: null,
    providers: ["codex"],
    active: true,
    pending: false,
    exists: true,
    ...overrides,
  };
}

test("검색은 이름과 경로를 대소문자 구분 없이 부분일치로 찾는다", () => {
  const entries = [
    entry({ path: "/repos/alpha", name: "Alpha" }),
    entry({ path: "/work/beta", name: "beta" }),
  ];
  assert.deepEqual(filterProjectRegistry(entries, ""), entries);
  assert.deepEqual(filterProjectRegistry(entries, "  "), entries);
  assert.deepEqual(filterProjectRegistry(entries, "ALPHA").map((item) => item.name), ["Alpha"]);
  assert.deepEqual(filterProjectRegistry(entries, "/work").map((item) => item.name), ["beta"]);
  assert.deepEqual(filterProjectRegistry(entries, "gamma"), []);
});

test("제외 경로 집합과 요약은 활성·제외·결정 대기를 나눠 센다", () => {
  const entries = [
    entry({ path: "/repos/alpha" }),
    entry({ path: "/repos/beta", active: false }),
    entry({ path: "/repos/gamma", pending: true }),
  ];
  assert.deepEqual([...excludedProjectPaths(entries)], ["/repos/beta"]);
  assert.deepEqual(projectRegistrySummary(entries), { active: 2, inactive: 1, pending: 1 });
  assert.deepEqual(projectRegistrySummary([]), { active: 0, inactive: 0, pending: 0 });
});

test("활성·제외 목록은 순서를 유지한 채 나뉜다", () => {
  const a = entry({ path: "/repos/a" });
  const b = entry({ path: "/repos/b", active: false });
  const c = entry({ path: "/repos/c" });
  const d = entry({ path: "/repos/d", active: false });
  const split = splitProjectRegistry([a, b, c, d]);
  assert.deepEqual(split.active.map((item) => item.path), ["/repos/a", "/repos/c"]);
  assert.deepEqual(split.inactive.map((item) => item.path), ["/repos/b", "/repos/d"]);
  assert.deepEqual(splitProjectRegistry([]), { active: [], inactive: [] });
});

// 목록을 나누는 쪽과 경로 집합을 만드는 쪽이 같은 제외 판정을 쓰는지. 두 표면이 같은
// 항목을 가리켜야 카드에서 접힌 프로젝트가 스킬 출처 칩에서도 함께 빠진다.
test("제외 목록과 제외 경로 집합은 같은 항목을 가리킨다", () => {
  const entries = [
    entry({ path: "/repos/a" }),
    entry({ path: "/repos/b", active: false }),
    entry({ path: "/repos/c", active: false, pending: true }),
  ];
  const { inactive } = splitProjectRegistry(entries);
  assert.deepEqual(inactive.map((item) => item.path), [...excludedProjectPaths(entries)]);
});

test("결정 대기 키는 순서와 무관하고 항목이 늘면 달라진다", () => {
  const a = entry({ path: "/repos/a" });
  const b = entry({ path: "/repos/b" });
  assert.equal(pendingProjectsKey([a, b]), pendingProjectsKey([b, a]));
  assert.notEqual(pendingProjectsKey([a]), pendingProjectsKey([a, b]));
  assert.equal(pendingProjectsKey([]), "");
});
