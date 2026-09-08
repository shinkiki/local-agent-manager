import type { ProjectRegistryEntry } from "../types";

/** 이름·경로 부분일치 검색. 빈 검색어면 전체를 그대로 돌려준다. */
export function filterProjectRegistry(entries: ProjectRegistryEntry[], query: string): ProjectRegistryEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(needle) || entry.path.toLocaleLowerCase().includes(needle),
  );
}

/**
 * 설정에서 제외한 프로젝트인지. 목록을 나누는 쪽과 경로 집합을 만드는 쪽이 `active`를
 * 각자 부정하고 있었는데, 제외의 뜻이 넓어질 때(예: 사라진 경로도 제외로 볼 때) 한쪽만
 * 고쳐지면 카드에서는 제외로 접혀 있는 프로젝트가 스킬 출처 칩에는 계속 남는다.
 */
function excluded(entry: ProjectRegistryEntry): boolean {
  return !entry.active;
}

export interface ProjectRegistrySummary {
  active: number;
  inactive: number;
  pending: number;
}

/**
 * 활성/제외 분할과 요약 수치(활성·제외·결정 대기)를 한 번의 순회로 함께 만든다.
 *
 * 이 합친 결과는 내보내지 않는다. 화면은 목록과 수치를 각각의 `useMemo`로 받으므로
 * 공개 진입점은 아래 둘이면 충분하고, 합친 모양까지 내보내 두면 실제 호출자는 없이
 * 자기 테스트만 부르는 표면이 하나 더 늘어난다.
 */
function partitionProjectRegistry(entries: ProjectRegistryEntry[]): {
  active: ProjectRegistryEntry[];
  inactive: ProjectRegistryEntry[];
  summary: ProjectRegistrySummary;
} {
  const active: ProjectRegistryEntry[] = [];
  const inactive: ProjectRegistryEntry[] = [];
  let pending = 0;
  for (const entry of entries) {
    if (excluded(entry)) {
      inactive.push(entry);
    } else {
      active.push(entry);
    }
    if (entry.pending) pending += 1;
  }
  return {
    active,
    inactive,
    summary: { active: active.length, inactive: inactive.length, pending },
  };
}

/**
 * 활성/제외 프로젝트를 나눈다. 설정 카드는 활성 목록을 펼쳐 보이고 제외 목록은 기본 접힌
 * 상태로 아래에 둔다 — 제외한 프로젝트는 되돌릴 일이 드물어 화면을 차지하지 않게 한다.
 */
export function splitProjectRegistry(entries: ProjectRegistryEntry[]): {
  active: ProjectRegistryEntry[];
  inactive: ProjectRegistryEntry[];
} {
  const { active, inactive } = partitionProjectRegistry(entries);
  return { active, inactive };
}

/** 설정에서 제외한 프로젝트 경로 집합. 스킬 출처 칩처럼 프런트가 직접 걸러야 하는 곳에 쓴다. */
export function excludedProjectPaths(entries: ProjectRegistryEntry[]): Set<string> {
  return new Set(entries.filter(excluded).map((entry) => entry.path));
}

export function projectRegistrySummary(entries: ProjectRegistryEntry[]): ProjectRegistrySummary {
  return partitionProjectRegistry(entries).summary;
}

/**
 * 결정 대기 집합의 식별 키. "나중에"로 닫은 집합을 기억해 같은 집합이면 다시 띄우지 않고,
 * 프로젝트가 더 감지되면(키가 바뀌면) 다시 띄우기 위해 순서에 무관하게 만든다.
 */
export function pendingProjectsKey(entries: ProjectRegistryEntry[]): string {
  return entries
    .map((entry) => entry.path)
    .sort()
    .join("\n");
}
