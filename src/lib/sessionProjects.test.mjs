import assert from "node:assert/strict";
import test from "node:test";
import { collectSessionProjectOptions, linkableProjectOptions, sessionInProject } from "./sessionProjects.ts";

function session(id, cwd, extra = {}) {
  return { id, cwd, project: cwd ? cwd.split("/").pop() : null, relatedProjects: undefined, ...extra };
}

test("작업 경로 밖에서 손댄 프로젝트도 그 프로젝트 필터에 잡힌다", () => {
  const aia = session("aia", "/data/aia-workspace", { aiaWorkspace: true, project: "AIA 작업공간", relatedProjects: ["/repo/app"] });
  assert.equal(sessionInProject(aia, "/repo/app"), true);
  assert.equal(sessionInProject(aia, "/data/aia-workspace"), true);
  assert.equal(sessionInProject(aia, "/repo/other"), false);
  assert.equal(sessionInProject(session("plain", "/repo/app"), "/repo/app"), true);
});

test("프로젝트 개수는 관련 프로젝트로 잡힌 세션까지 세고 이름은 그 경로 세션에서 딴다", () => {
  const options = collectSessionProjectOptions([
    session("aia", "/data/aia-workspace", { project: "AIA 작업공간", relatedProjects: ["/repo/app", "/repo/app"] }),
    session("a1", "/repo/app"),
    session("a2", "/repo/app", { relatedProjects: ["/repo/app"] }),
  ]);
  assert.deepEqual(options, [
    { path: "/repo/app", label: "app", count: 3 },
    { path: "/data/aia-workspace", label: "AIA 작업공간", count: 1 },
  ]);
});

test("관련 프로젝트 경로의 세션이 목록에 없으면 경로 끝 조각을 이름으로 쓴다", () => {
  const options = collectSessionProjectOptions([
    session("aia", "/data/aia-workspace", { project: "AIA 작업공간", relatedProjects: ["/repo/hidden-app/"] }),
  ]);
  assert.deepEqual(options.find((option) => option.path === "/repo/hidden-app/"), { path: "/repo/hidden-app/", label: "hidden-app", count: 1 });
});

test("직접 이어 둘 후보에서 앱 작업공간과 자기 작업 경로를 뺀다", () => {
  const current = session("aia", "/data/aia-workspace", { aiaWorkspace: true });
  const options = linkableProjectOptions([
    current,
    session("d", "/data/default-workspace", { defaultWorkspace: true }),
    session("b", "/repo/beta"),
    session("a", "/repo/alpha"),
  ], current);
  assert.deepEqual(options.map((option) => option.path), ["/repo/alpha", "/repo/beta"]);
});
