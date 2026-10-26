import assert from "node:assert/strict";
import test from "node:test";
import { resolveSelectedProjectPath, selectableProjects } from "./projectSelection.ts";

const active = [{ path: "/tmp/amproj/alpha" }, { path: "/tmp/amproj/beta" }];

test("a stored path that is still active is kept", () => {
  assert.equal(resolveSelectedProjectPath(active, "/tmp/amproj/beta"), "/tmp/amproj/beta");
});

test("a stored path that left the active list falls back to the first project", () => {
  // 제외됐거나 폴더가 사라진 프로젝트는 목록에 없다. 저장값을 고집하면 화면이 빈 프로젝트를
  // 가리키므로 첫 활성 프로젝트로 떨어진다.
  assert.equal(resolveSelectedProjectPath(active, "/tmp/amproj/gone"), "/tmp/amproj/alpha");
});

test("no stored path selects the first project", () => {
  assert.equal(resolveSelectedProjectPath(active, null), "/tmp/amproj/alpha");
});

test("no active project resolves to nothing regardless of the stored path", () => {
  assert.equal(resolveSelectedProjectPath([], "/tmp/amproj/alpha"), null);
  assert.equal(resolveSelectedProjectPath([], null), null);
});

test("only active projects whose folder exists are selectable, in registry order", () => {
  const entries = [
    { path: "/tmp/amproj/excluded", active: false, exists: true },
    { path: "/tmp/amproj/beta", active: true, exists: true },
    { path: "/tmp/amproj/missing", active: true, exists: false },
    { path: "/tmp/amproj/alpha", active: true, exists: true },
  ];
  assert.deepEqual(selectableProjects(entries).map((entry) => entry.path), ["/tmp/amproj/beta", "/tmp/amproj/alpha"]);
  // 첫 선택도 걸러진 목록 기준이다 — 제외된 첫 줄로 떨어지지 않는다.
  assert.equal(resolveSelectedProjectPath(selectableProjects(entries), null), "/tmp/amproj/beta");
});

test("a registry that has not loaded yet has nothing selectable", () => {
  assert.deepEqual(selectableProjects(null), []);
});
