import assert from "node:assert/strict";
import test from "node:test";
import {
  isSkillProviderDeployed,
  skillSyncCounts,
  skillSyncState,
} from "./skillSyncState.ts";

/**
 * 보관 스킬 한 항목의 동기화 상태와 "가장 앞선 것으로 맞추기"의 방향 판정. 배지 문구와
 * 필터 칩이 같은 판정을 나눠 쓰고, 방향은 사람이 아니라 이 함수가 정하므로 — 뒤처진
 * 사본을 원본으로 채택하면 최신 원본이 그대로 덮인다 — 경계를 시험으로 붙잡아 둔다.
 */

function providerState(overrides = {}) {
  return {
    provider: "claude",
    status: "linked",
    scope: "personal",
    origin: null,
    skillId: "demo",
    path: null,
    directory: null,
    targetDirectory: null,
    readOnly: false,
    contentDigest: null,
    divergent: false,
    divergence: null,
    modifiedAtMs: null,
    note: null,
    installs: [],
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    key: "demo",
    createdAtMs: null,
    origin: null,
    autoSync: false,
    platforms: [],
    active: true,
    migrationRequired: false,
    activeVariant: null,
    name: "demo",
    description: "",
    originKind: "common",
    common: { modifiedAtMs: 100 },
    managed: true,
    directoryName: "demo",
    providers: [],
    linkedCount: 0,
    installedCount: 0,
    missingCount: 0,
    ...overrides,
  };
}

function install(overrides = {}) {
  return {
    scope: "personal",
    projectPath: null,
    projectName: null,
    skillId: "demo",
    directory: "d",
    contentDigest: null,
    divergent: true,
    divergence: "edited",
    modifiedAtMs: null,
    readOnly: false,
    ...overrides,
  };
}

test("배포 판정은 링크와 사본만 참이다", () => {
  assert.equal(isSkillProviderDeployed(providerState({ status: "linked" })), true);
  assert.equal(isSkillProviderDeployed(providerState({ status: "copy" })), true);
  for (const status of ["missing", "unsupported"]) {
    assert.equal(isSkillProviderDeployed(providerState({ status })), false);
  }
});

test("관리 대상이 아니면 다른 어떤 신호보다 먼저 unmanaged다", () => {
  const value = entry({
    managed: false,
    providers: [providerState({ divergent: true, divergence: "edited" })],
  });
  assert.equal(skillSyncState(value), "unmanaged");
});

test("방향이 섞이면 조치가 필요한 외부 수정이 대표가 된다", () => {
  // 뒤처짐은 재배포 한 번이면 끝나고 외부 수정은 놓치면 사라진다. 한 이름으로 부르면
  // 뒤처진 사본을 원본으로 채택하는 방향으로 읽힌다.
  const mixed = entry({
    providers: [
      providerState({ provider: "claude", divergent: true, divergence: "behind" }),
      providerState({ provider: "codex", divergent: true, divergence: "edited" }),
    ],
  });
  assert.equal(skillSyncState(mixed), "conflict");

  const behindOnly = entry({
    providers: [providerState({ divergent: true, divergence: "behind" })],
  });
  assert.equal(skillSyncState(behindOnly), "stale");

  // 방향을 모르는 자리는 사람이 정해야 하므로 뒤처짐이 아니라 외부 수정 쪽이다.
  const unknownDirection = entry({
    providers: [providerState({ divergent: true, divergence: "unknown" })],
  });
  assert.equal(skillSyncState(unknownDirection), "conflict");
});

test("배포되지 않은 에이전트는 결함이 아니고, 배포가 하나도 없으면 미게시다", () => {
  const partial = entry({
    providers: [
      providerState({ provider: "claude", status: "linked" }),
      providerState({ provider: "codex", status: "missing" }),
    ],
  });
  assert.equal(skillSyncState(partial), "current");

  const nowhere = entry({ providers: [providerState({ status: "missing" })] });
  assert.equal(skillSyncState(nowhere), "unpublished");

  const noSource = entry({ common: null, providers: [providerState({ status: "linked" })] });
  assert.equal(skillSyncState(noSource), "unpublished");
});

test("상태별 항목 수는 다섯 갈래를 모두 들고 시작한다", () => {
  const counts = skillSyncCounts([
    entry({ providers: [providerState({ status: "linked" })] }),
    entry({ managed: false }),
  ]);
  assert.deepEqual(counts, {
    current: 1,
    conflict: 0,
    stale: 0,
    unpublished: 0,
    unmanaged: 1,
  });
});
