import type {
  ProviderId,
  SkillAdapterView,
  SkillLibraryEntry,
  SkillProviderState,
  SkillProviderStatus,
  SkillPublishReceipt,
} from "../types";

/** 스킬 키 규칙. Rust 쪽 `validate_skill_key`와 같은 규칙을 화면에서 미리 알린다. */
const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SKILL_KEY_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * 새 통합 스킬 이름을 화면에서 먼저 검증한다. 서버가 최종 판정을 하지만, 같은
 * 규칙을 미리 알려 주면 사용자가 저장 실패로 되돌아오지 않는다.
 * 문제가 없으면 `null`을 돌려준다.
 */
export function skillKeyError(key: string, translate: (ko: string, en: string) => string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return translate("스킬 이름을 입력하세요.", "Enter a skill name.");
  if (trimmed.length > MAX_SKILL_KEY_CHARS) {
    return translate(
      `스킬 이름은 ${MAX_SKILL_KEY_CHARS}자까지 쓸 수 있습니다.`,
      `Skill names may be up to ${MAX_SKILL_KEY_CHARS} characters.`,
    );
  }
  if (!SKILL_KEY_PATTERN.test(trimmed)) {
    return translate(
      "영소문자·숫자·하이픈만 쓸 수 있고 영소문자나 숫자로 시작해야 합니다.",
      "Use only lowercase letters, digits, and hyphens, starting with a letter or digit.",
    );
  }
  if (trimmed.endsWith("-")) {
    return translate("하이픈으로 끝날 수 없습니다.", "It cannot end with a hyphen.");
  }
  if (WINDOWS_RESERVED.has(trimmed.split(".")[0])) {
    return translate(
      `'${trimmed}'은 Windows 예약 이름입니다.`,
      `'${trimmed}' is a reserved name on Windows.`,
    );
  }
  return null;
}

export function skillDescriptionError(
  description: string,
  translate: (ko: string, en: string) => string,
): string | null {
  const trimmed = description.trim();
  if (!trimmed) {
    return translate(
      "설명을 입력하세요. 공급자는 설명으로 스킬을 찾습니다.",
      "Enter a description. Providers discover skills by description.",
    );
  }
  if (trimmed.length > MAX_DESCRIPTION_CHARS) {
    return translate(
      `설명은 ${MAX_DESCRIPTION_CHARS}자까지 쓸 수 있습니다.`,
      `Descriptions may be up to ${MAX_DESCRIPTION_CHARS} characters.`,
    );
  }
  return null;
}

/** 한 항목의 전체 동기화 상태. 카드 배지 하나로 요약할 때 쓴다. */
export type SkillSyncState = "current" | "conflict" | "unpublished" | "unmanaged";

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
  if (entry.providers.some((state) => state.divergent)) return "conflict";
  if (!entry.common) return "unpublished";
  const present = entry.providers.filter(
    (state) => state.status === "linked" || state.status === "copy",
  );
  return present.length === 0 ? "unpublished" : "current";
}

export function skillSyncLabel(state: SkillSyncState, translate: (ko: string, en: string) => string): string {
  switch (state) {
    case "current":
      return translate("동기화됨", "Synced");
    case "conflict":
      return translate("외부 수정 감지", "Externally edited");
    case "unpublished":
      return translate("미사용", "Not in use");
    case "unmanaged":
      return translate("에이전트 스킬", "Agent skill");
  }
}

export function skillProviderStatusLabel(
  state: SkillProviderState,
  translate: (ko: string, en: string) => string,
): string {
  if (state.divergent) return translate("외부 수정 감지", "Externally edited");
  switch (state.status) {
    case "linked":
      return translate("링크", "Linked");
    case "copy":
      return translate("사본", "Copy");
    case "missing":
      return translate("사용 안 함", "Not used");
    case "unsupported":
      return translate("미지원", "Unsupported");
  }
}

/** 게시 결과 한 줄 요약. 결과가 섞여 있어도 사용자가 무슨 일이 있었는지 알 수 있게 만든다. */
export function publishSummary(
  receipt: Pick<SkillPublishReceipt, "results">,
  translate: (ko: string, en: string) => string,
): string {
  const counts = new Map<string, number>();
  for (const result of receipt.results) {
    counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  }
  const parts: string[] = [];
  const push = (outcome: string, ko: string, en: string) => {
    const count = counts.get(outcome);
    if (count) parts.push(`${translate(ko, en)} ${count}`);
  };
  push("published", "적용", "enabled");
  push("replaced", "교체", "replaced");
  push("unchanged", "변경 없음", "unchanged");
  push("skipped", "건너뜀", "skipped");
  push("failed", "실패", "failed");
  if (parts.length === 0) return translate("게시할 대상이 없습니다.", "No publish targets.");
  return parts.join(" · ");
}

/** 게시 결과에 실패가 하나라도 있는지. 있으면 화면에서 오류로 강조한다. */
export function publishHadFailure(receipt: Pick<SkillPublishReceipt, "results">): boolean {
  return receipt.results.some((result) => result.outcome === "failed");
}

/**
 * 공급자 어댑터가 공통 원본을 게시할 수 있는지와 그 이유. 게시 불가 공급자를 화면에서
 * 조용히 감추지 않고 이유를 함께 보여주기 위해 쓴다.
 */
export function adapterSummary(
  adapter: SkillAdapterView,
  translate: (ko: string, en: string) => string,
): string {
  if (!adapter.supportsCommonSource) {
    return adapter.note ?? translate("사용자 스킬 루트가 없습니다.", "No user skill root.");
  }
  return adapter.installableRoot ?? translate("게시 대상 경로를 찾지 못했습니다.", "No publish target found.");
}

/**
 * 목록 정렬. 생성순(먼저 만든 스킬이 위)으로 고정해 편집·상태 변화로 순서가
 * 뒤바뀌지 않게 한다. 생성 시각을 모르는 항목은 마지막에 이름순으로 둔다.
 */
export function sortSkillEntries(entries: SkillLibraryEntry[]): SkillLibraryEntry[] {
  return [...entries].sort((left, right) => {
    const l = left.createdAtMs ?? Number.MAX_SAFE_INTEGER;
    const r = right.createdAtMs ?? Number.MAX_SAFE_INTEGER;
    if (l !== r) return l - r;
    return left.key.localeCompare(right.key);
  });
}

/** 검색어로 항목을 걸러낸다. 이름·키·설명·공급자 경로를 함께 본다. */
export function matchesSkillQuery(entry: SkillLibraryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.key,
    entry.name,
    entry.description,
    entry.common?.directory,
    ...entry.providers.flatMap((state) => [state.directory, state.origin, state.scope]),
  ];
  return haystack.some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}

/** 상태별 항목 수. 상단 요약 줄에 쓴다. */
export function skillSyncCounts(entries: SkillLibraryEntry[]): Record<SkillSyncState, number> {
  const counts: Record<SkillSyncState, number> = {
    current: 0,
    conflict: 0,
    unpublished: 0,
    unmanaged: 0,
  };
  for (const entry of entries) counts[skillSyncState(entry)] += 1;
  return counts;
}

export function providerLabel(provider: ProviderId): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "antigravity":
      return "Antigravity";
    default:
      return provider;
  }
}

/** 상태 칩에 붙일 CSS 수식자. */
export function skillStatusModifier(state: SkillProviderState): SkillProviderStatus | "divergent" {
  return state.divergent ? "divergent" : state.status;
}

/** 보관 여부 필터. 저장 호환을 위해 내부 값은 shared/agent를 유지한다. */
export type SkillKindFilter = "all" | "shared" | "agent";
/** 상태 필터. 조치가 필요한 외부 수정 감지와 사용처 없는 보관 원본을 걸러 본다. */
export type SkillStateFilter = "all" | "conflict" | "undeployed";
export type SkillAgentFilter = "all" | "claude" | "codex" | "antigravity";

export const SKILL_KIND_VALUES: readonly SkillKindFilter[] = ["all", "shared", "agent"];
export const SKILL_STATE_VALUES: readonly SkillStateFilter[] = ["all", "conflict", "undeployed"];
export const SKILL_AGENT_VALUES: readonly SkillAgentFilter[] = ["all", "claude", "codex", "antigravity"];

export interface SkillLibraryFilters {
  kind: SkillKindFilter;
  state: SkillStateFilter;
  agent: SkillAgentFilter;
  /** "all" | "personal" | "project" | `project:<경로>` */
  origin: string;
}

export interface SkillFilterCounts {
  kind: Record<SkillKindFilter, number>;
  state: Record<SkillStateFilter, number>;
  agent: Record<SkillAgentFilter, number>;
  /** 출처는 프로젝트별 값이 목록에 따라 늘어나므로 키가 고정되지 않는다. */
  origin: Record<string, number>;
}

function matchesSkillKind(entry: SkillLibraryEntry, kind: string): boolean {
  if (kind === "shared") return Boolean(entry.common);
  if (kind === "agent") return !entry.common;
  return true;
}

function matchesSkillState(entry: SkillLibraryEntry, state: string): boolean {
  if (state === "conflict") return skillSyncState(entry) === "conflict";
  if (state === "undeployed") return skillSyncState(entry) === "unpublished";
  return true;
}

function matchesSkillAgent(entry: SkillLibraryEntry, agent: string): boolean {
  if (agent === "all") return true;
  return entry.providers.some(
    (item) => item.provider === agent && (item.status === "linked" || item.status === "copy"),
  );
}

/**
 * 출처 필터. `project`는 프로젝트 출처 전체, `project:<경로>`는 그 프로젝트만
 * 본다. 프로젝트 이름 값은 프로젝트 출처를 고른 뒤에만 화면에 나온다.
 */
export function matchesSkillOrigin(entry: SkillLibraryEntry, origin: string): boolean {
  if (origin === "personal") return entry.origin?.scope !== "project";
  if (origin === "project") return entry.origin?.scope === "project";
  if (origin.startsWith("project:")) {
    return entry.origin?.scope === "project"
      && (entry.origin.projectPath ?? "") === origin.slice("project:".length);
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
 * 축 이름과 그 축의 판정자를 한 곳에 묶는다. 걸러내기와 칩 개수 세기가 같은 표를
 * 보게 해서, 축을 늘릴 때 한쪽만 고쳐 두 화면이 어긋나는 일을 막는다.
 */
const SKILL_FILTER_AXES: Record<
  SkillFilterAxis,
  (entry: SkillLibraryEntry, value: string) => boolean
> = {
  kind: matchesSkillKind,
  state: matchesSkillState,
  agent: matchesSkillAgent,
  origin: matchesSkillOrigin,
};

const SKILL_FILTER_AXIS_NAMES = Object.keys(SKILL_FILTER_AXES) as SkillFilterAxis[];

/** 모든 축을 통과하는지. `except` 축 하나만 빼고 볼 수도 있다(칩 개수용). */
function matchesSkillFilters(
  entry: SkillLibraryEntry,
  filters: SkillLibraryFilters,
  except?: SkillFilterAxis,
): boolean {
  return SKILL_FILTER_AXIS_NAMES.every(
    (axis) => axis === except || SKILL_FILTER_AXES[axis](entry, filters[axis]),
  );
}

export function filterSkillEntries(
  entries: SkillLibraryEntry[],
  filters: SkillLibraryFilters,
): SkillLibraryEntry[] {
  return entries.filter((entry) => matchesSkillFilters(entry, filters));
}

/**
 * 필터 칩에 붙일 개수. 자기 축의 선택은 빼고 센다. 그래서 다른 축을 좁힌
 * 상태에서도 "여기를 누르면 몇 개가 남는지"가 눌러 보기 전에 보인다.
 */
export function skillFilterCounts(
  entries: SkillLibraryEntry[],
  filters: SkillLibraryFilters,
  originValues: readonly string[],
): SkillFilterCounts {
  const tally = <T extends string>(axis: SkillFilterAxis, values: readonly T[]) => {
    const scoped = entries.filter((entry) => matchesSkillFilters(entry, filters, axis));
    const matches = SKILL_FILTER_AXES[axis];
    return Object.fromEntries(
      values.map((value) => [value, scoped.filter((entry) => matches(entry, value)).length]),
    ) as Record<T, number>;
  };
  return {
    kind: tally("kind", SKILL_KIND_VALUES),
    state: tally("state", SKILL_STATE_VALUES),
    agent: tally("agent", SKILL_AGENT_VALUES),
    origin: tally("origin", originValues),
  };
}
