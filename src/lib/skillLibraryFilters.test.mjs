import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSkillEntries,
  isProjectOriginFilter,
  matchesSkillOrigin,
  skillFilterCounts,
  skillOriginProjects,
} from "./skillLibraryFilters.ts";
import { entry, projectOrigin, providerState } from "./skillLibraryFixtures.mjs";

test("출처 필터는 프로젝트 전체와 개별 프로젝트를 따로 가린다", () => {
  const personal = entry({ key: "personal" });
  const alpha = entry({ key: "alpha", origin: projectOrigin("/repos/alpha", "alpha") });
  const beta = entry({ key: "beta", origin: projectOrigin("/repos/beta", "beta") });

  assert.equal(matchesSkillOrigin(personal, "personal"), true);
  assert.equal(matchesSkillOrigin(personal, "project"), false);
  assert.equal(matchesSkillOrigin(alpha, "project"), true);
  assert.equal(matchesSkillOrigin(alpha, "project:/repos/alpha"), true);
  assert.equal(matchesSkillOrigin(alpha, "project:/repos/beta"), false);
  assert.equal(matchesSkillOrigin(beta, "all"), true);

  assert.equal(isProjectOriginFilter("project"), true);
  assert.equal(isProjectOriginFilter("project:/repos/alpha"), true);
  assert.equal(isProjectOriginFilter("personal"), false);
  assert.equal(isProjectOriginFilter("all"), false);

  const filters = { kind: "all", state: "all", agent: "all", origin: "project:/repos/beta" };
  assert.deepEqual(filterSkillEntries([personal, alpha, beta], filters).map((item) => item.key), ["beta"]);
});

test("Antigravity에 게시한 스킬을 에이전트 필터로 찾는다", () => {
  const antigravity = entry({
    key: "antigravity-skill",
    providers: [providerState({ provider: "antigravity", status: "copy" })],
  });
  const claude = entry({
    key: "claude-skill",
    providers: [providerState({ provider: "claude", status: "copy" })],
  });
  const filters = { kind: "all", state: "all", agent: "antigravity", origin: "all" };

  assert.deepEqual(
    filterSkillEntries([antigravity, claude], filters).map((item) => item.key),
    ["antigravity-skill"],
  );
  assert.equal(
    skillFilterCounts([antigravity, claude], filters, ["all"]).agent.antigravity,
    1,
  );
});

test("출처 프로젝트 목록은 중복 없이 이름순으로 나온다", () => {
  const projects = skillOriginProjects([
    entry({ key: "b", origin: projectOrigin("/repos/beta", "beta") }),
    entry({ key: "a", origin: projectOrigin("/repos/alpha", "alpha") }),
    entry({ key: "a2", origin: projectOrigin("/repos/alpha", "alpha") }),
    entry({ key: "p" }),
  ]);
  assert.deepEqual(projects, [
    { path: "/repos/alpha", name: "alpha" },
    { path: "/repos/beta", name: "beta" },
  ]);
});

test("설정에서 제외한 프로젝트는 출처 칩에서 숨긴다", () => {
  const projects = skillOriginProjects(
    [
      entry({ key: "b", origin: projectOrigin("/repos/beta", "beta") }),
      entry({ key: "a", origin: projectOrigin("/repos/alpha", "alpha") }),
    ],
    new Set(["/repos/beta"]),
  );
  assert.deepEqual(projects, [{ path: "/repos/alpha", name: "alpha" }]);
});

test("필터 칩 개수는 자기 축의 선택을 빼고 센다", () => {
  const archivedPersonal = entry({ key: "archived-personal" });
  const archivedProject = entry({ key: "archived-project", origin: projectOrigin("/repos/alpha", "alpha") });
  const unarchivedProject = entry({
    key: "unarchived-project",
    common: null,
    origin: projectOrigin("/repos/alpha", "alpha"),
  });
  const entries = [archivedPersonal, archivedProject, unarchivedProject];
  const originValues = ["all", "personal", "project", "project:/repos/alpha"];

  const counts = skillFilterCounts(
    entries,
    { kind: "shared", state: "all", agent: "all", origin: "personal" },
    originValues,
  );
  // 보관 축 개수는 출처(개인) 선택만 반영한다.
  assert.equal(counts.kind.all, 1);
  assert.equal(counts.kind.shared, 1);
  assert.equal(counts.kind.agent, 0);
  // 출처 축 개수는 보관 선택만 반영한다.
  assert.equal(counts.origin.all, 2);
  assert.equal(counts.origin.personal, 1);
  assert.equal(counts.origin.project, 1);
  assert.equal(counts.origin["project:/repos/alpha"], 1);
});

test("두 축에서 걸린 항목은 어느 축의 칩 개수에도 들지 않는다", () => {
  // 보관 축(공통 원본 없음)과 출처 축(프로젝트)에서 함께 걸린다.
  const twoAxisMiss = entry({ key: "two-axis-miss", common: null, origin: projectOrigin("/repos/alpha", "alpha") });
  // 출처 축에서만 걸린다 — 출처 칩에만 들어야 한다.
  const originOnlyMiss = entry({ key: "origin-only-miss", origin: projectOrigin("/repos/alpha", "alpha") });
  const passing = entry({ key: "passing" });
  const originValues = ["all", "personal", "project", "project:/repos/alpha"];

  const counts = skillFilterCounts(
    [twoAxisMiss, originOnlyMiss, passing],
    { kind: "shared", state: "all", agent: "all", origin: "personal" },
    originValues,
  );
  assert.equal(counts.kind.all, 1);
  assert.equal(counts.kind.agent, 0);
  assert.equal(counts.origin.all, 2);
  assert.equal(counts.origin.project, 1);
  assert.equal(counts.origin["project:/repos/alpha"], 1);
  assert.equal(counts.state.all, 1);
});
