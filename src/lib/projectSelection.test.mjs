import assert from "node:assert/strict";
import test from "node:test";
import { resolveSelectedProjectPath } from "./projectSelection.ts";

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
