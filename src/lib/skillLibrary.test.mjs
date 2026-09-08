import assert from "node:assert/strict";
import test from "node:test";
import {
  adapterSummary,
  filterSkillEntries,
  isProjectOriginFilter,
  matchesSkillOrigin,
  matchesSkillQuery,
  publishHadFailure,
  publishSummary,
  skillDescriptionError,
  skillFilterCounts,
  skillKeyError,
  skillOriginProjects,
  skillStatusModifier,
  skillSyncCounts,
  skillSyncLabel,
  skillSyncState,
  sortSkillEntries,
} from "./skillLibrary.ts";

const text = (ko) => ko;
const translate = (ko) => ko;

const providerState = (overrides = {}) => ({
  provider: "claude",
  status: "missing",
  installs: [],
  scope: null,
  origin: null,
  skillId: null,
  path: null,
  directory: null,
  targetDirectory: "/home/user/.claude/skills/demo",
  readOnly: false,
  contentDigest: null,
  divergent: false,
  note: null,
  ...overrides,
});

const commonSource = (overrides = {}) => ({
  id: "skill-1",
  key: "demo",
  name: "demo",
  description: "Demo skill",
  path: "/home/user/.agents/skills/demo/SKILL.md",
  directory: "/home/user/.agents/skills/demo",
  contentDigest: "aaa",
  fileCount: 2,
  totalBytes: 100,
  ...overrides,
});

const entry = (overrides = {}) => ({
  key: "demo",
  createdAtMs: null,
  origin: null,
  autoSync: false,
  name: "demo",
  description: "Demo skill",
  originKind: "common",
  common: commonSource(),
  managed: true,
  directoryName: "demo",
  providers: [
    providerState({ provider: "claude", status: "copy", contentDigest: "aaa" }),
    providerState({ provider: "codex", status: "copy", contentDigest: "aaa" }),
    providerState({ provider: "antigravity", status: "unsupported", readOnly: true, targetDirectory: null }),
  ],
  linkedCount: 0,
  installedCount: 2,
  missingCount: 0,
  ...overrides,
});

test("스킬 키 검증은 경로 탈출과 예약 이름을 막는다", () => {
  assert.equal(skillKeyError("review-notes", text), null);
  assert.notEqual(skillKeyError("", text), null);
  assert.notEqual(skillKeyError("../escape", text), null);
  assert.notEqual(skillKeyError("a/b", text), null);
  assert.notEqual(skillKeyError("Upper", text), null);
  assert.notEqual(skillKeyError(".hidden", text), null);
  assert.notEqual(skillKeyError("trailing-", text), null);
  assert.notEqual(skillKeyError("con", text), null);
  assert.notEqual(skillKeyError("a".repeat(65), text), null);
});

test("설명 검증은 빈 값과 과도한 길이를 막는다", () => {
  assert.equal(skillDescriptionError("실제 설명", text), null);
  assert.notEqual(skillDescriptionError("   ", text), null);
  assert.notEqual(skillDescriptionError("x".repeat(1025), text), null);
});

test("배포된 곳이 모두 원본과 같으면 동기화 상태다", () => {
  assert.equal(skillSyncState(entry()), "current");
  assert.equal(skillSyncLabel("current", translate), "동기화됨");
});

test("갈라진 사본은 다른 상태보다 먼저 충돌로 보고된다", () => {
  const conflicted = entry({
    providers: [
      providerState({ provider: "claude", status: "copy", divergent: true }),
      providerState({ provider: "codex", status: "missing" }),
      providerState({ provider: "antigravity", status: "unsupported", readOnly: true }),
    ],
  });
  assert.equal(skillSyncState(conflicted), "conflict");
});

test("배포 안 한 에이전트가 있어도 결함이 아니라 정상 상태다", () => {
  // 배포되지 않은 에이전트는 "사용 안 함"이라는 확정 상태다. 삭제로 배포를
  // 내린 스킬이 영구히 경고로 남으면 안 된다.
  const partiallyDeployed = entry({
    providers: [
      providerState({ provider: "claude", status: "copy" }),
      providerState({ provider: "codex", status: "missing" }),
      providerState({ provider: "antigravity", status: "unsupported", readOnly: true }),
    ],
  });
  assert.equal(skillSyncState(partiallyDeployed), "current");
});

test("미지원 공급자는 게시 완료 판정에서 제외된다", () => {
  // Antigravity는 사용자 스킬 루트가 없어 영원히 게시되지 않는다. 이 때문에
  // 최신 상태가 되지 못하면 사용자는 고칠 수 없는 경고를 계속 보게 된다.
  const onlySupported = entry({
    providers: [
      providerState({ provider: "claude", status: "copy" }),
      providerState({ provider: "codex", status: "linked" }),
      providerState({ provider: "antigravity", status: "unsupported", readOnly: true }),
    ],
  });
  assert.equal(skillSyncState(onlySupported), "current");
});

test("공통 원본이 없는 공급자 전용 스킬은 미게시다", () => {
  const providerOnly = entry({ originKind: "provider", common: null });
  assert.equal(skillSyncState(providerOnly), "unpublished");
});

test("읽기 전용 에이전트 소유 스킬은 관리 대상이 아니다", () => {
  const owned = entry({ managed: false, common: null, originKind: "provider" });
  assert.equal(skillSyncState(owned), "unmanaged");
  assert.equal(skillSyncLabel("unmanaged", translate), "에이전트 스킬");
});

test("게시 결과 요약은 결과 종류별 개수를 보여준다", () => {
  const receipt = {
    key: "demo",
    sourceDigest: "aaa",
    results: [
      { provider: "claude", outcome: "published", directory: "/a", message: null },
      { provider: "codex", outcome: "skipped", directory: "/b", message: "이미 있습니다" },
    ],
    report: { key: "demo", sourceDigest: "aaa", fileCount: 1, totalBytes: 1, providers: [], issues: [] },
  };
  assert.equal(publishSummary(receipt, translate), "적용 1 · 건너뜀 1");
  assert.equal(publishHadFailure(receipt), false);

  const failed = { ...receipt, results: [{ provider: "claude", outcome: "failed", directory: null, message: "오류" }] };
  assert.equal(publishHadFailure(failed), true);
  assert.equal(publishSummary(failed, translate), "실패 1");
});

test("어댑터 요약은 게시 가능 경로나 불가 이유를 알려준다", () => {
  assert.equal(
    adapterSummary(
      { provider: "codex", displayName: "OpenAI Codex", installableRoot: "/home/user/.codex/skills", roots: [], supportsCommonSource: true, note: null },
      translate,
    ),
    "/home/user/.codex/skills",
  );
  assert.equal(
    adapterSummary(
      { provider: "antigravity", displayName: "Google Antigravity", installableRoot: null, roots: [], supportsCommonSource: false, note: "루트 없음" },
      translate,
    ),
    "루트 없음",
  );
});

test("정렬은 생성순이며 생성 시각을 모르면 마지막에 이름순이다", () => {
  const entries = [
    entry({ key: "c-newest", createdAtMs: 3000 }),
    entry({ key: "b-unknown", createdAtMs: null }),
    entry({ key: "a-oldest", createdAtMs: 1000 }),
    entry({ key: "d-middle", createdAtMs: 2000 }),
    entry({ key: "a-unknown", createdAtMs: null }),
  ];
  assert.deepEqual(
    sortSkillEntries(entries).map((item) => item.key),
    ["a-oldest", "d-middle", "c-newest", "a-unknown", "b-unknown"],
  );
});

test("검색은 이름·키·설명과 공급자 경로를 함께 본다", () => {
  const target = entry({
    key: "deploy",
    name: "배포 도우미",
    description: "릴리스 절차",
    providers: [providerState({ provider: "codex", status: "copy", directory: "/home/user/.codex/skills/deploy" })],
  });
  assert.equal(matchesSkillQuery(target, ""), true);
  assert.equal(matchesSkillQuery(target, "deploy"), true);
  assert.equal(matchesSkillQuery(target, "배포"), true);
  assert.equal(matchesSkillQuery(target, "릴리스"), true);
  assert.equal(matchesSkillQuery(target, ".codex"), true);
  assert.equal(matchesSkillQuery(target, "없는값"), false);
});

test("상태별 개수를 집계한다", () => {
  const counts = skillSyncCounts([
    entry({ key: "a" }),
    entry({ key: "b", providers: [providerState({ status: "copy", divergent: true })] }),
    entry({ key: "c", managed: false, common: null }),
  ]);
  assert.equal(counts.current, 1);
  assert.equal(counts.conflict, 1);
  assert.equal(counts.unmanaged, 1);
  assert.equal(counts.unpublished, 0);
});

test("상태 칩 수식자는 갈라짐을 따로 표시한다", () => {
  assert.equal(skillStatusModifier(providerState({ status: "copy" })), "copy");
  assert.equal(skillStatusModifier(providerState({ status: "copy", divergent: true })), "divergent");
  assert.equal(skillStatusModifier(providerState({ status: "unsupported" })), "unsupported");
});

const projectOrigin = (path, name) => ({
  provider: "claude",
  scope: "project",
  projectPath: path,
  projectName: name,
  archivedAtMs: null,
});

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
