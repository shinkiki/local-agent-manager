import assert from "node:assert/strict";
import test from "node:test";
import {
  adapterSummary,
  isSkillProviderDeployed,
  latestSkillVersion,
  matchesSkillQuery,
  publishHadFailure,
  publishSummary,
  skillDescriptionError,
  skillDivergenceHint,
  skillDivergenceLabel,
  skillKeyError,
  skillStatusModifier,
  skillSyncCounts,
  skillSyncLabel,
  skillSyncState,
  sortSkillEntries,
} from "./skillLibrary.ts";
import { entry, providerState } from "./skillLibraryFixtures.mjs";

const text = (ko) => ko;
const translate = (ko) => ko;

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

test("공급자 배포 상태는 심볼릭 링크나 사본일 때만 참이다", () => {
  assert.equal(isSkillProviderDeployed(providerState({ status: "linked" })), true);
  assert.equal(isSkillProviderDeployed(providerState({ status: "copy" })), true);
  assert.equal(isSkillProviderDeployed(providerState({ status: "missing" })), false);
  assert.equal(isSkillProviderDeployed(providerState({ status: "unsupported" })), false);
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
  assert.equal(counts.stale, 0);
  assert.equal(counts.unmanaged, 1);
  assert.equal(counts.unpublished, 0);
});

test("상태 칩 수식자는 갈라짐을 따로 표시한다", () => {
  assert.equal(skillStatusModifier(providerState({ status: "copy" })), "copy");
  assert.equal(skillStatusModifier(providerState({ status: "copy", divergent: true })), "divergent");
  assert.equal(skillStatusModifier(providerState({ status: "unsupported" })), "unsupported");
});

// 지문만 보면 뒤처진 사본과 손으로 고친 사본이 같은 "갈라짐"이다. 둘을 한 이름으로 부르면
// 뒤처진 사본에 "외부 수정"이 붙고, 그 사본을 새 원본으로 채택하는 쪽이 유일한 출구로
// 보인다 — 누르면 최신 원본이 옛 내용으로 덮인다.
test("뒤처진 사본은 외부 수정과 다른 상태로 보고된다", () => {
  const stale = entry({
    providers: [
      providerState({ provider: "claude", status: "copy", divergent: true, divergence: "behind" }),
      providerState({ provider: "codex", status: "missing" }),
    ],
  });
  assert.equal(skillSyncState(stale), "stale");
  assert.equal(skillSyncLabel("stale", translate), "뒤처짐");
  assert.equal(skillStatusModifier(stale.providers[0]), "stale");
});

test("한 항목에 두 방향이 섞이면 판단이 필요한 외부 수정을 대표로 삼는다", () => {
  const mixed = entry({
    providers: [
      providerState({ provider: "claude", status: "copy", divergent: true, divergence: "behind" }),
      providerState({ provider: "codex", status: "copy", divergent: true, divergence: "edited" }),
    ],
  });
  assert.equal(skillSyncState(mixed), "conflict");
});

test("방향을 모르면 어느 쪽이 새 내용인지 단정하지 않는다", () => {
  const unknown = entry({
    providers: [providerState({ status: "copy", divergent: true, divergence: "unknown" })],
  });
  assert.equal(skillSyncState(unknown), "conflict");
  assert.equal(skillDivergenceLabel("unknown", translate), "원본과 다름");
  assert.match(skillDivergenceHint("unknown", translate), /변경 내용으로 확인/);
});

test("방향별 다음 조치를 문구로 알려 준다", () => {
  assert.match(skillDivergenceHint("behind", translate), /다시 배포/);
  assert.match(skillDivergenceHint("edited", translate), /채택/);
});

// "가장 앞선 것으로 전부 맞춘다"가 어느 방향으로 갈지는 수정 시각 하나가 정한다.
const divergent = (provider, modifiedAtMs) => ({
  provider,
  install: { skillId: `${provider}-install`, modifiedAtMs, divergent: true, divergence: null },
});

test("원본이 가장 새로우면 최신본은 원본이다", () => {
  const latest = latestSkillVersion(2_000, [divergent("codex", 1_000), divergent("claude", 1_500)]);
  assert.deepEqual(latest, { kind: "source" });
});

test("사용본이 원본보다 새로우면 그중 가장 나중 것을 고른다", () => {
  const latest = latestSkillVersion(2_000, [divergent("codex", 3_000), divergent("claude", 4_000)]);
  assert.equal(latest.kind, "install");
  assert.equal(latest.provider, "claude");
});

test("같은 시각이면 원본이 이긴다", () => {
  // 배포는 원본의 수정 시각을 사본에 넘기지 않는다. 동시각은 사람이 고친 흔적이 아니다.
  assert.deepEqual(latestSkillVersion(2_000, [divergent("codex", 2_000)]), { kind: "source" });
});

test("시각을 모르는 자리가 하나라도 있으면 고르지 않는다", () => {
  // 모르는 값을 0으로 깔면 그 자리가 늘 지고, 실제로 가장 새로운 사본이 조용히 덮인다.
  assert.deepEqual(latestSkillVersion(2_000, [divergent("codex", null)]), { kind: "unknown" });
  assert.deepEqual(latestSkillVersion(null, [divergent("codex", 3_000)]), { kind: "unknown" });
  assert.deepEqual(latestSkillVersion(null, []), { kind: "source" });
});
