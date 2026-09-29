import { sourceName } from "./format.ts";
import type { Translate } from "./skillLocaleText.ts";
import type { SkillSyncState } from "./skillSyncState.ts";
import type {
  SkillAdapterView,
  SkillDivergence,
  SkillLibraryEntry,
  SkillProviderState,
  SkillProviderStatus,
  SkillPublishOutcome,
  SkillPublishReceipt,
} from "../types";

/**
 * 화면이 보는 입구는 이 모듈 하나다. 동기화 상태 판정·필터 축 기계·저장 폼 입력 검증은
 * 서로 읽을 것이 없어 따로 두었지만, 스킬관리 화면이 넷 중 무엇이 어디로 갔는지 알아야 할
 * 이유는 없다 — 나눈 쪽의 사정이 화면의 import 목록으로 새어 나가면 다음에 다시 나눌 때마다
 * 화면을 함께 고쳐야 한다.
 */
export {
  skillDescriptionError,
  skillKeyError,
} from "./skillLibraryInput.ts";
export {
  isSkillProviderDeployed,
  latestSkillVersion,
  skillSyncCounts,
  skillSyncState,
  type SkillDivergentInstall,
  type SkillLatestVersion,
  type SkillSyncState,
} from "./skillSyncState.ts";
export {
  filterSkillEntries,
  isProjectOriginFilter,
  matchesSkillOrigin,
  skillFilterCounts,
  skillOriginProjects,
  SKILL_AGENT_VALUES,
  SKILL_KIND_VALUES,
  SKILL_STATE_VALUES,
  type SkillAgentFilter,
  type SkillFilterCounts,
  type SkillKindFilter,
  type SkillLibraryFilters,
  type SkillStateFilter,
} from "./skillLibraryFilters.ts";

/**
 * 표의 한 칸. 지금 언어를 고르는 손잡이를 받아 문구를 만든다 — 표가 React 바깥에 서 있어
 * `text`를 미리 부를 수 없고, 짝을 `["한국어", "English"]` 자료로만 적어 두면 번역 카탈로그가
 * 소스에서 거두지 못한다(카탈로그는 `text(ko, en)` 호출만 읽는다).
 */
type LabelSpec = (text: Translate) => string;

/**
 * 원본과 갈라진 배포본. 항목 배지(`conflict`·`stale`)와 공급자 칩(`divergent`)은 같은
 * 사실을 다른 자리에서 부르는 것이라 문구도 한 벌만 둔다 — 두 벌이면 한쪽만 고쳐도 같은
 * 화면에 두 문구가 함께 보인다. 방향까지 나누는 것은 뒤처진 사본에 "외부 수정"이라고
 * 써 두면 사용자가 그 사본을 새 원본으로 채택해 최신 내용을 덮기 때문이다.
 *
 * 배지 문구(`label`)와 다음 조치 안내(`hint`)를 한 칸에 둔다. 둘은 같은 방향을 한 화면의
 * 위아래에서 말하는 것이라 언제나 함께 바뀌는데, 안내만 방향별 `if` 사슬로 따로 적혀
 * 있었다. 그러면 방향이 하나 늘 때 표만 채워도 빌드가 통과하고, 그 방향은 배지에서는
 * 제 이름으로 불리면서 안내에서는 사슬 끝의 "어느 쪽이 새 내용인지 모른다"로 조용히
 * 떨어진다 — 뒤처진 사본에 그 안내가 붙으면 사용자는 낡은 사본을 원본으로 채택한다.
 * `Record`가 열거형의 모든 값을 요구하게 두면 그 누락이 타입에서 걸린다.
 */
const DIVERGENT_TEXTS: Record<SkillDivergence, { label: LabelSpec; hint: LabelSpec }> = {
  behind: {
    label: (text) => text("뒤처짐", "Out of date"),
    hint: (text) => text(
      "이 사용본이 보관 원본보다 오래됐습니다. 원본을 다시 배포하면 맞춰집니다.",
      "This install is older than the archived source. Redeploy the source to catch it up.",
    ),
  },
  edited: {
    label: (text) => text("외부 수정 감지", "Externally edited"),
    hint: (text) => text(
      "이 사용본이 보관 원본보다 나중에 수정됐습니다. 채택하거나 원본을 다시 배포해 덮으세요.",
      "This install was edited after the archived source. Adopt it, or redeploy the source over it.",
    ),
  },
  unknown: {
    label: (text) => text("원본과 다름", "Differs from source"),
    hint: (text) => text(
      "이 사용본이 보관 원본과 다릅니다. 수정 시각을 읽지 못해 어느 쪽이 새 내용인지는 변경 내용으로 확인하세요.",
      "This install differs from the archived source. Modification times are unavailable, so compare the changes to see which side is newer.",
    ),
  },
};

/**
 * 방향을 아직 받지 못한 응답이 쓰는 칸. 두 함수가 각자 `?? "unknown"`을 적으면 한쪽만
 * 고쳐도 같은 항목의 배지와 안내가 다른 방향을 말하게 된다.
 */
function divergenceTexts(divergence: SkillDivergence | null): { label: LabelSpec; hint: LabelSpec } {
  return DIVERGENT_TEXTS[divergence ?? "unknown"];
}

/** 방향을 모르는 자리(항목 배지 등)에서 쓰는 기본 문구. */
const DIVERGENT_LABEL: LabelSpec = DIVERGENT_TEXTS.edited.label;

/** 갈라진 방향 문구. 방향을 아직 받지 못한 응답은 "원본과 다름"으로 부른다. */
export function skillDivergenceLabel(
  divergence: SkillDivergence | null,
  text: Translate,
): string {
  return divergenceTexts(divergence).label(text);
}

/**
 * 상태별 문구. 갈래마다 다른 것은 문구 한 짝뿐이라 `switch`가 아니라 표로 둔다.
 * `Record`가 열거형의 모든 값을 요구하므로 값이 늘면 표를 채우지 않고는 통과하지 않는다.
 */
const SKILL_SYNC_LABELS: Record<SkillSyncState, LabelSpec> = {
  current: (text) => text("동기화됨", "Synced"),
  conflict: DIVERGENT_LABEL,
  stale: DIVERGENT_TEXTS.behind.label,
  unpublished: (text) => text("미사용", "Not in use"),
  unmanaged: (text) => text("에이전트 스킬", "Agent skill"),
};

export function skillSyncLabel(state: SkillSyncState, text: Translate): string {
  return SKILL_SYNC_LABELS[state](text);
}

const SKILL_PROVIDER_STATUS_LABELS: Record<SkillProviderStatus, LabelSpec> = {
  linked: (text) => text("링크", "Linked"),
  copy: (text) => text("사본", "Copy"),
  missing: (text) => text("사용 안 함", "Not used"),
  unsupported: (text) => text("미지원", "Unsupported"),
};

/** 갈라짐은 배포 상태보다 앞선다 — 링크로 남아 있어도 내용이 달라진 쪽이 급하다. */
export function skillProviderStatusLabel(
  state: SkillProviderState,
  text: Translate,
): string {
  if (state.divergent) return skillDivergenceLabel(state.divergence, text);
  return SKILL_PROVIDER_STATUS_LABELS[state.status](text);
}

/**
 * 게시 결과별 문구. 이웃한 두 표(`SKILL_SYNC_LABELS`·`SKILL_PROVIDER_STATUS_LABELS`)와
 * 달리 이 표만 결과 값을 스스로 늘어놓은 목록이라, 결과가 하나 늘어도 표를 채우지 않고
 * 빌드가 통과했다 — 그 결과는 요약 줄에서 조용히 빠져 "적용 1"만 보이고 방금 일어난
 * 일은 사라진다. `Record`가 열거형의 모든 값을 요구하게 두면 그 누락이 타입에서 걸린다.
 * 요약에 늘어놓는 차례는 이 표에 적은 순서 그대로다.
 */
const PUBLISH_OUTCOME_LABELS: Record<SkillPublishOutcome, LabelSpec> = {
  published: (text) => text("적용", "enabled"),
  replaced: (text) => text("교체", "replaced"),
  unchanged: (text) => text("변경 없음", "unchanged"),
  skipped: (text) => text("건너뜀", "skipped"),
  failed: (text) => text("실패", "failed"),
};

/** 게시 결과 한 줄 요약. 결과가 섞여 있어도 사용자가 무슨 일이 있었는지 알 수 있게 만든다. */
export function publishSummary(
  receipt: Pick<SkillPublishReceipt, "results">,
  text: Translate,
): string {
  const counts = new Map<SkillPublishOutcome, number>();
  for (const result of receipt.results) {
    counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [outcome, label] of Object.entries(PUBLISH_OUTCOME_LABELS) as [SkillPublishOutcome, LabelSpec][]) {
    const count = counts.get(outcome);
    if (count) parts.push(`${label(text)} ${count}`);
  }
  if (parts.length === 0) return text("게시할 대상이 없습니다.", "No publish targets.");
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
  text: Translate,
): string {
  if (!adapter.supportsCommonSource) {
    return adapter.note ?? text("사용자 스킬 루트가 없습니다.", "No user skill root.");
  }
  return adapter.installableRoot ?? text("게시 대상 경로를 찾지 못했습니다.", "No publish target found.");
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
  const contains = (value: string | null | undefined): boolean => (
    typeof value === "string" && value.toLowerCase().includes(needle)
  );
  const targets = [
    entry.key,
    entry.name,
    entry.description,
    entry.common?.directory,
    ...entry.providers.flatMap((state) => [state.directory, state.origin, state.scope]),
  ];
  return targets.some(contains);
}

/**
 * 공급자 표시 이름. 표는 `format`이 `Record<ProviderId, string>`으로 하나만 가지므로
 * 여기서는 그 이름을 스킬 화면의 말로 다시 불러 쓸 뿐이다 — 두 벌을 두면 공급자가
 * 하나 늘 때 한쪽만 빠져도 빌드가 통과하고, 같은 공급자가 화면마다 다른 이름으로 보인다.
 */
export const providerLabel = sourceName;

/** 상태 칩에 붙일 CSS 수식자. 뒤처진 사본은 경고색이 아니라 낡음색으로 세운다. */
export function skillStatusModifier(
  state: SkillProviderState,
): SkillProviderStatus | "divergent" | "stale" {
  if (!state.divergent) return state.status;
  return state.divergence === "behind" ? "stale" : "divergent";
}

/**
 * 갈라진 사본을 어떻게 해야 하는지 한 문장. 배지 문구는 상태만 말하므로, 방향을 처음 보는
 * 사용자가 반대로 읽지 않도록 다음 조치까지 붙여 둔다.
 */
export function skillDivergenceHint(
  divergence: SkillDivergence | null,
  text: Translate,
): string {
  return divergenceTexts(divergence).hint(text);
}
