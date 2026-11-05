import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSkillEntries,
  isProjectOriginFilter,
  matchesSkillAgent,
  matchesSkillFilters,
  matchesSkillKind,
  matchesSkillOrigin,
  matchesSkillState,
  parseStoredSkillFilters,
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

test("보관 구분(kind) 필터는 공통 원본 존재 여부를 정확히 판정한다", () => {
  const shared = entry({ key: "shared-item", common: { sourceDigest: "d1", archivedAt: "2026-10-30" } });
  const agentOnly = entry({ key: "agent-item", common: null });

  assert.equal(matchesSkillKind(shared, "all"), true);
  assert.equal(matchesSkillKind(shared, "shared"), true);
  assert.equal(matchesSkillKind(shared, "agent"), false);

  assert.equal(matchesSkillKind(agentOnly, "all"), true);
  assert.equal(matchesSkillKind(agentOnly, "shared"), false);
  assert.equal(matchesSkillKind(agentOnly, "agent"), true);
});

test("동기화 상태(state) 필터는 conflict, stale, undeployed 상태를 정확히 판정한다", () => {
  const conflict = entry({
    key: "conflict-item",
    providers: [providerState({ status: "copy", divergent: true, divergence: "edited" })],
  });
  const stale = entry({
    key: "stale-item",
    providers: [providerState({ status: "copy", divergent: true, divergence: "behind" })],
  });
  const undeployed = entry({
    key: "undeployed-item",
    providers: [providerState({ status: "missing" })],
  });
  const upToDate = entry({
    key: "synced-item",
    providers: [providerState({ status: "copy" })],
  });

  assert.equal(matchesSkillState(conflict, "all"), true);
  assert.equal(matchesSkillState(conflict, "conflict"), true);
  assert.equal(matchesSkillState(conflict, "stale"), false);
  assert.equal(matchesSkillState(conflict, "undeployed"), false);

  assert.equal(matchesSkillState(stale, "stale"), true);
  assert.equal(matchesSkillState(stale, "conflict"), false);
  assert.equal(matchesSkillState(stale, "undeployed"), false);

  assert.equal(matchesSkillState(undeployed, "undeployed"), true);
  assert.equal(matchesSkillState(undeployed, "conflict"), false);
  assert.equal(matchesSkillState(undeployed, "stale"), false);

  assert.equal(matchesSkillState(upToDate, "conflict"), false);
  assert.equal(matchesSkillState(upToDate, "stale"), false);
  assert.equal(matchesSkillState(upToDate, "undeployed"), false);
});

test("에이전트(agent) 필터는 공급자별 배포 여부를 판정하며 local을 포함한다", () => {
  const antigravity = entry({
    key: "antigravity-skill",
    providers: [providerState({ provider: "antigravity", status: "copy" })],
  });
  const claude = entry({
    key: "claude-skill",
    providers: [providerState({ provider: "claude", status: "copy" })],
  });
  const local = entry({
    key: "local-skill",
    providers: [providerState({ provider: "local", status: "linked" })],
  });

  assert.equal(matchesSkillAgent(antigravity, "all"), true);
  assert.equal(matchesSkillAgent(antigravity, "antigravity"), true);
  assert.equal(matchesSkillAgent(antigravity, "claude"), false);
  assert.equal(matchesSkillAgent(antigravity, "local"), false);

  assert.equal(matchesSkillAgent(local, "local"), true);
  assert.equal(matchesSkillAgent(local, "claude"), false);

  const filters = { kind: "all", state: "all", agent: "antigravity", origin: "all" };
  assert.deepEqual(
    filterSkillEntries([antigravity, claude, local], filters).map((item) => item.key),
    ["antigravity-skill"],
  );
  assert.equal(
    skillFilterCounts([antigravity, claude, local], filters, ["all"]).agent.antigravity,
    1,
  );
});

test("matchesSkillFilters는 모든 축 조건을 종합 판정한다", () => {
  const target = entry({
    key: "target-skill",
    common: { sourceDigest: "d1", archivedAt: "2026-10-30" },
    origin: projectOrigin("/repos/alpha", "alpha"),
    providers: [providerState({ provider: "antigravity", status: "copy" })],
  });

  assert.equal(matchesSkillFilters(target, {
    kind: "shared",
    state: "all",
    agent: "antigravity",
    origin: "project:/repos/alpha",
  }), true);

  assert.equal(matchesSkillFilters(target, {
    kind: "agent",
    state: "all",
    agent: "antigravity",
    origin: "project:/repos/alpha",
  }), false);

  assert.equal(matchesSkillFilters(target, {
    kind: "shared",
    state: "conflict",
    agent: "antigravity",
    origin: "project:/repos/alpha",
  }), false);
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

test("저장된 필터 복원은 아는 값만 받고 나머지는 전부 all로 떨어뜨린다", () => {
  const all = { kind: "all", state: "all", agent: "all", origin: "all" };
  assert.deepEqual(parseStoredSkillFilters(null), all);
  assert.deepEqual(parseStoredSkillFilters(["shared"]), all);
  assert.deepEqual(parseStoredSkillFilters("shared"), all);
  assert.deepEqual(
    parseStoredSkillFilters({ kind: "shared", state: "undeployed", agent: "local", origin: "project:/repos/alpha" }),
    { kind: "shared", state: "undeployed", agent: "local", origin: "project:/repos/alpha" },
  );
  for (const origin of ["personal", "project"]) {
    assert.equal(parseStoredSkillFilters({ origin }).origin, origin);
  }
  assert.deepEqual(
    parseStoredSkillFilters({ kind: "common", state: "unpublished", agent: "gemini", origin: "projects/alpha" }),
    all,
  );
  assert.deepEqual(parseStoredSkillFilters({ kind: 1, state: null, agent: ["claude"], origin: 7 }), all);
});
