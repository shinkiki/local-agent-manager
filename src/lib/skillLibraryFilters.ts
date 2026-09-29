/**
 * 스킬관리 목록의 축 기반 필터 — 어떤 축이 있고, 축마다 고를 수 있는 값이 무엇이며,
 * 항목이 그 값에 맞는지. 걸러내기(`filterSkillEntries`)와 칩 개수(`skillFilterCounts`)가
 * 한 표를 보게 묶어 둔 덩어리라, 목록 문구·게시 요약·정렬과는 서로 읽을 것이 없다.
 * 그래서 화면이 보는 입구(`skillLibrary`)와 나눠 이 축 기계만 따로 둔다.
 */
import { isSkillProviderDeployed, skillSyncState, type SkillSyncState } from "./skillSyncState.ts";
import type { SkillLibraryEntry } from "../types";

/**
 * 축마다 고를 수 있는 값. 유니언과 값 목록을 따로 적으면 값이 하나 늘 때 한쪽만 고쳐도
 * 빌드가 통과한다 — 유니언만 늘리면 그 값의 칩이 화면에 나오지 않고, 목록만 늘리면
 * 저장값 복원(`includes`)이 통과시킨 값을 걸러내기가 모르는 값으로 받는다. 목록 하나를
 * 두고 유니언을 거기서 파생해 두 벌이 어긋날 자리를 없앤다.
 */
/** 보관 여부 필터. 저장 호환을 위해 내부 값은 shared/agent를 유지한다. */
export const SKILL_KIND_VALUES = ["all", "shared", "agent"] as const;
export type SkillKindFilter = (typeof SKILL_KIND_VALUES)[number];
/**
 * 상태 필터. 판단이 필요한 외부 수정, 재배포만 하면 되는 뒤처짐, 사용처 없는 보관 원본을
 * 각각 걸러 본다. 앞의 둘을 한 칩에 묶으면 "지금 봐야 할 것"을 고르지 못한다.
 */
export const SKILL_STATE_VALUES = ["all", "conflict", "stale", "undeployed"] as const;
export type SkillStateFilter = (typeof SKILL_STATE_VALUES)[number];
/** 스킬을 자기 루트에 게시하는 공급자. 로컬도 전용 루트를 갖는다(`.config/opencode/skill`). */
export const SKILL_AGENT_VALUES = ["all", "claude", "codex", "antigravity", "local"] as const;
export type SkillAgentFilter = (typeof SKILL_AGENT_VALUES)[number];

export interface SkillLibraryFilters {
  kind: SkillKindFilter;
  state: SkillStateFilter;
  agent: SkillAgentFilter;
  /** "all" | "personal" | "project" | `project:<경로>` */
  origin: string;
}

/**
 * 필터 칩에 붙일 축별 개수. 어떤 축이 있고 그 축이 어떤 값을 가질 수 있는지는
 * `SkillLibraryFilters`가 이미 선언하므로 여기서 다시 늘어놓지 않고 그 선언을 그대로
 * 뒤집는다 — 두 벌로 적으면 축이 하나 늘 때 개수 쪽만 빠뜨려도 빌드가 통과하고,
 * 그 칩에만 개수가 붙지 않는다. 출처는 선언부터 `string`이라 키가 고정되지 않는다.
 */
export type SkillFilterCounts = {
  [Axis in SkillFilterAxis]: Record<SkillLibraryFilters[Axis], number>;
};

function matchesSkillKind(entry: SkillLibraryEntry, kind: string): boolean {
  if (kind === "shared") return Boolean(entry.common);
  if (kind === "agent") return !entry.common;
  return true;
}

/**
 * 상태 칩이 고른 값 하나가 요구하는 동기화 상태. 칩 값과 동기화 상태의 이름이 한 곳
 * (`undeployed` ↔ `unpublished`)에서 어긋나 있어 사슬로 적혀 있었는데, 값 목록
 * (`SKILL_STATE_VALUES`)과 그 사슬이 따로 놀면 값을 하나 늘릴 때 목록만 채워도 빌드가
 * 통과하고 그 칩은 아무것도 걸러내지 않는 채 화면에 선다. `Record`가 `all`을 뺀 모든
 * 값을 요구하게 두면 그 누락이 타입에서 걸린다.
 */
const SKILL_STATE_SYNC: Record<Exclude<SkillStateFilter, "all">, SkillSyncState> = {
  conflict: "conflict",
  stale: "stale",
  undeployed: "unpublished",
};

function matchesSkillState(entry: SkillLibraryEntry, state: string): boolean {
  const required = SKILL_STATE_SYNC[state as Exclude<SkillStateFilter, "all">] as SkillSyncState | undefined;
  return required === undefined || skillSyncState(entry) === required;
}

function matchesSkillAgent(entry: SkillLibraryEntry, agent: string): boolean {
  if (agent === "all") return true;
  return entry.providers.some(
    (item) => item.provider === agent && isSkillProviderDeployed(item),
  );
}

/**
 * 출처 필터. `project`는 프로젝트 출처 전체, `project:<경로>`는 그 프로젝트만
 * 본다. 프로젝트 이름 값은 프로젝트 출처를 고른 뒤에만 화면에 나온다.
 */
export function matchesSkillOrigin(entry: SkillLibraryEntry, origin: string): boolean {
  const isProject = entry.origin?.scope === "project";
  if (origin === "personal") return !isProject;
  if (origin === "project") return isProject;
  if (origin.startsWith("project:")) {
    return isProject && (entry.origin?.projectPath ?? "") === origin.slice("project:".length);
  }
  return true;
}

/** 출처 필터가 프로젝트 축을 고른 상태인지. 하위 프로젝트 칩 노출 판단에 쓴다. */
export function isProjectOriginFilter(origin: string): boolean {
  return origin === "project" || origin.startsWith("project:");
}

/**
 * 출처 필터에 노출할 프로젝트. 보관 스킬 출처에 등장한 프로젝트만 이름순으로 주고, 설정에서
 * 제외한 프로젝트(`excluded`)는 숨긴다. 출처 표시 자체는 이력이라 항목에 남는다.
 */
export function skillOriginProjects(
  entries: SkillLibraryEntry[],
  excluded: ReadonlySet<string> = new Set(),
): { path: string; name: string }[] {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.origin?.scope === "project" && entry.origin.projectPath && !excluded.has(entry.origin.projectPath)) {
      map.set(entry.origin.projectPath, entry.origin.projectName ?? entry.origin.projectPath);
    }
  }
  return [...map.entries()]
    .map(([path, name]) => ({ path, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

type SkillFilterAxis = keyof SkillLibraryFilters;

/**
 * 축 하나가 아는 것 — 항목이 그 값에 맞는지 보는 판정과, 칩에 늘어놓을 값 목록.
 * 걸러내기와 칩 개수 세기가 같은 표를 보게 해서, 축을 늘릴 때 한쪽만 고쳐 두 화면이
 * 어긋나는 일을 막는다.
 *
 * 값 목록을 판정과 같은 칸에 두는 이유는 둘을 따로 넘기면 어긋나도 드러나지 않기
 * 때문이다 — 축 이름과 값 목록을 각각 받는 자리에서는 `kind` 축에 상태 값 목록을
 * 짝지어도 타입이 통과하고, 칩의 개수만 조용히 틀린다.
 *
 * 출처만 고정 목록이 없다(`null`). 프로젝트별 값이 지금 목록에 따라 늘어나므로
 * 그때의 값은 호출부가 준다.
 */
const SKILL_FILTER_AXES: {
  [Axis in SkillFilterAxis]: {
    matches: (entry: SkillLibraryEntry, value: string) => boolean;
    values: readonly SkillLibraryFilters[Axis][] | null;
  };
} = {
  kind: { matches: matchesSkillKind, values: SKILL_KIND_VALUES },
  state: { matches: matchesSkillState, values: SKILL_STATE_VALUES },
  agent: { matches: matchesSkillAgent, values: SKILL_AGENT_VALUES },
  origin: { matches: matchesSkillOrigin, values: null },
};

const SKILL_FILTER_AXIS_NAMES = Object.keys(SKILL_FILTER_AXES) as SkillFilterAxis[];

/** 모든 축을 통과하는지. */
function matchesSkillFilters(entry: SkillLibraryEntry, filters: SkillLibraryFilters): boolean {
  return SKILL_FILTER_AXIS_NAMES.every(
    (axis) => SKILL_FILTER_AXES[axis].matches(entry, filters[axis]),
  );
}

export function filterSkillEntries(
  entries: SkillLibraryEntry[],
  filters: SkillLibraryFilters,
): SkillLibraryEntry[] {
  return entries.filter((entry) => matchesSkillFilters(entry, filters));
}

/** 칩에 늘어놓을 값. 고정 목록이 없는 축(출처)만 지금 화면의 값을 쓴다. */
function skillFilterAxisValues(axis: SkillFilterAxis, originValues: readonly string[]): readonly string[] {
  return SKILL_FILTER_AXES[axis].values ?? originValues;
}

/**
 * 필터 칩에 붙일 개수. 자기 축의 선택은 빼고 센다. 그래서 다른 축을 좁힌
 * 상태에서도 "여기를 누르면 몇 개가 남는지"가 눌러 보기 전에 보인다.
 *
 * 축마다 "자기 축을 뺀 나머지"로 목록을 한 번씩 걸러 내고 있었다. 축이 넷이면 같은 항목의
 * 축 판정이 항목당 열여섯 번까지 되풀이되는데, 상태 축의 판정은 항목의 공급자 목록을
 * 매번 다시 접는 일(`skillSyncState`)이라 그 되풀이가 그대로 목록 렌더에 걸린다.
 *
 * 되풀이를 걷어내는 근거는 "항목 하나가 걸린 축이 무엇인가" 하나다 — 두 축 이상에서
 * 걸리면 어느 축을 빼도 범위에 들지 않고, 한 축에서만 걸리면 그 축의 개수에만 들며,
 * 어디에도 걸리지 않으면 모든 축의 개수에 든다. 그래서 항목마다 축 판정을 한 벌만 구하고
 * 그 답으로 네 축의 개수를 함께 채운다.
 */
export function skillFilterCounts(
  entries: SkillLibraryEntry[],
  filters: SkillLibraryFilters,
  originValues: readonly string[],
): SkillFilterCounts {
  const counts = Object.fromEntries(SKILL_FILTER_AXIS_NAMES.map((axis) => [
    axis,
    Object.fromEntries(skillFilterAxisValues(axis, originValues).map((value) => [value, 0])),
  ])) as Record<SkillFilterAxis, Record<string, number>>;

  for (const entry of entries) {
    const failed = SKILL_FILTER_AXIS_NAMES.filter(
      (axis) => !SKILL_FILTER_AXES[axis].matches(entry, filters[axis]),
    );
    if (failed.length > 1) continue;
    for (const axis of SKILL_FILTER_AXIS_NAMES) {
      // 걸린 축이 하나면 그 축의 개수에만 든다 — 다른 축을 빼도 이 항목은 여전히 걸린다.
      if (failed.length === 1 && failed[0] !== axis) continue;
      const { matches } = SKILL_FILTER_AXES[axis];
      for (const value of skillFilterAxisValues(axis, originValues)) {
        if (matches(entry, value)) counts[axis][value] += 1;
      }
    }
  }
  return counts as SkillFilterCounts;
}
