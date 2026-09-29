/**
 * 보관 스킬 한 항목이 지금 어떤 동기화 상태인지. 배지 문구를 고르는 자리(`skillLibrary`)와
 * 상태 필터 축(`skillLibraryFilters`)이 같은 판정을 봐야 하므로, 두 곳 중 어느 한쪽이
 * 아니라 둘이 함께 읽는 자리에 둔다 — 한쪽에 두고 다른 쪽이 되짚으면 카드 배지와 필터
 * 칩이 같은 항목을 다른 상태로 부르게 된다.
 */
import type {
  ProviderId,
  SkillInstallView,
  SkillLibraryEntry,
  SkillProviderState,
} from "../types";

/**
 * 한 항목의 전체 동기화 상태. 카드 배지 하나로 요약할 때 쓴다.
 * `stale`과 `conflict`는 둘 다 "원본과 내용이 다르다"이지만 조치가 반대다 — 앞은 원본을
 * 다시 배포하면 끝이고, 뒤는 사본을 채택할지 버릴지 사용자가 정해야 한다. 한 이름으로
 * 부르던 동안 뒤처진 사본이 "외부 수정"으로 보여, 그 사본을 원본으로 채택하면 최신 원본을
 * 덮는 방향으로 읽혔다.
 */
export type SkillSyncState = "current" | "conflict" | "stale" | "unpublished" | "unmanaged";

/** 공급자에 실제로 배포된 상태(심볼릭 링크 또는 파일 사본)인지. */
export function isSkillProviderDeployed(state: SkillProviderState): boolean {
  return state.status === "linked" || state.status === "copy";
}

/**
 * 에이전트별 상태를 한 항목의 동기화 상태로 접는다. 외부에서 수정된 배포본이
 * 하나라도 있으면 가장 시급하므로 다른 상태보다 우선한다.
 *
 * 배포되지 않은 에이전트는 "그 에이전트에서는 사용 안 함"이라는 확정 상태이지
 * 조치가 필요한 결함이 아니다. 그래서 배포된 곳들이 모두 원본과 같으면 일부
 * 에이전트에 없어도 정상(current)으로 본다.
 */
export function skillSyncState(entry: SkillLibraryEntry): SkillSyncState {
  if (!entry.managed) return "unmanaged";
  // 방향이 섞여 있으면 판단이 필요한 쪽을 대표로 삼는다. 뒤처짐은 재배포 한 번이면
  // 끝나지만 외부 수정은 놓치면 사라지는 내용이라 먼저 눈에 띄어야 한다.
  if (entry.providers.some((state) => state.divergent && state.divergence !== "behind")) {
    return "conflict";
  }
  if (entry.providers.some((state) => state.divergent)) return "stale";
  if (!entry.common) return "unpublished";
  return entry.providers.some(isSkillProviderDeployed) ? "current" : "unpublished";
}

/** 갈라진 사용본 하나와 그 공급자. 방향 판정과 최신본 선택이 같은 모양을 본다. */
export interface SkillDivergentInstall {
  provider: ProviderId;
  install: SkillInstallView;
}

/**
 * 갈라진 자리들 중 가장 나중에 고쳐진 쪽.
 * - `source`: 보관 원본이 가장 새롭다. 갈라진 사용본에 원본을 다시 배포하면 통일된다.
 * - `install`: 어느 사용본이 가장 새롭다. 그것을 원본으로 채택하면 나머지가 따라온다.
 * - `unknown`: 시각을 모르는 자리가 섞여 있어 고를 수 없다.
 */
export type SkillLatestVersion =
  | { kind: "source" }
  | ({ kind: "install" } & SkillDivergentInstall)
  | { kind: "unknown" };

/**
 * 원본과 갈라진 사용본들 가운데 최신본을 고른다. "가장 앞선 것으로 전부 맞춘다"는 한 번의
 * 조치가 어느 방향으로 가야 하는지는 이 선택 하나로 정해진다 — 방향을 사람이 읽고 고르게
 * 두면 뒤처진 사본을 채택해 최신 원본을 덮는 실수가 그대로 남는다.
 *
 * 시각을 하나라도 모르면 `unknown`이다. 모르는 값을 0으로 깔면 그 자리는 항상 지므로,
 * 실제로는 가장 새로운 사본이 조용히 덮인다. 고르지 않는 편이 낫다.
 *
 * 같은 시각이면 원본이 이긴다. 배포는 원본의 수정 시각을 사본에 넘겨주지 않으므로 동시각은
 * 사람이 고친 흔적이 아니고, 원본을 그대로 펴는 쪽이 잃는 것이 없다.
 */
export function latestSkillVersion(
  sourceModifiedAtMs: number | null,
  divergents: readonly SkillDivergentInstall[],
): SkillLatestVersion {
  if (divergents.length === 0) return { kind: "source" };
  if (sourceModifiedAtMs === null) return { kind: "unknown" };
  let winner: SkillDivergentInstall | null = null;
  for (const candidate of divergents) {
    const modifiedAtMs = candidate.install.modifiedAtMs;
    if (modifiedAtMs === null) return { kind: "unknown" };
    if (modifiedAtMs <= sourceModifiedAtMs) continue;
    if (!winner || modifiedAtMs > (winner.install.modifiedAtMs ?? 0)) winner = candidate;
  }
  return winner ? { kind: "install", ...winner } : { kind: "source" };
}

/** 상태별 항목 수. 상단 요약 줄에 쓴다. */
export function skillSyncCounts(entries: SkillLibraryEntry[]): Record<SkillSyncState, number> {
  const counts: Record<SkillSyncState, number> = {
    current: 0,
    conflict: 0,
    stale: 0,
    unpublished: 0,
    unmanaged: 0,
  };
  for (const entry of entries) counts[skillSyncState(entry)] += 1;
  return counts;
}
