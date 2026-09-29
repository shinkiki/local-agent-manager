/**
 * 제안 숨김 정책. "지금 무엇이 후보인가"와 "그중 무엇을 다시 보여줄 때가 됐는가"는
 * 다른 규칙이다. 후보를 만드는 `aiaSuggestions.ts`가 재무장 조건까지 안고 있으면 제안
 * 생성 코드를 헤집게 되므로 여기 따로 둔다.
 *
 * 저장 형식(이력이 어떤 칸으로 이루어지고 저장 문자열과 어떻게 오가는가)은
 * `aiaSuggestionHistoryFormat.ts`가 갖는다 — 칸은 저장 형식을 바꿀 때만 늘고 갈래와
 * 재무장 조건은 제안 종류가 늘 때마다 손보는데, 둘이 한 파일에 있는 동안 한쪽을 고치려면
 * 늘 다른 쪽을 지나쳐 읽어야 했다. 기존 호출부가 경로를 바꾸지 않도록 저장 형식 쪽
 * 이름은 여기서 그대로 다시 내보낸다.
 *
 * 숨김 키를 짓는 지문 자체는 `aiaFingerprint.ts`가 갖는다 — 그 규칙은 숨김을 모르는데
 * 여기 있어서, 제안을 조립하기만 하는 쪽이 지문 하나 때문에 이 모듈을 가져왔다.
 *
 * 의존 방향은 한쪽뿐이다 — 이 모듈은 제안이 어떻게 만들어지는지 모르고, 숨김 판정에
 * 필요한 최소 모양(`DismissableSuggestion`)만 본다.
 */
import { suggestionFingerprint } from "./aiaFingerprint.ts";
import { MINUTE } from "./aiaPrimitives.ts";
import type { AiaSuggestionHistory } from "./aiaSuggestionHistoryFormat.ts";
import { cloneAiaSuggestionHistory } from "./aiaSuggestionHistoryFormat.ts";
import type { SuggestionMetadata } from "./aiaSuggestionOrder.ts";
import { numberMetadata } from "./aiaSuggestionOrder.ts";

/** 저장 형식은 갈라 두었지만 호출부가 보는 자리는 그대로다. */
export type {
  AiaSuggestionHistory,
  IncidentDismissal,
  ProjectDismissal,
} from "./aiaSuggestionHistoryFormat.ts";
export {
  cloneAiaSuggestionHistory,
  emptyAiaSuggestionHistory,
  parseAiaSuggestionHistory,
  serializeAiaSuggestionHistory,
} from "./aiaSuggestionHistoryFormat.ts";

/** 숨김 판정이 보는 제안의 최소 모양. `AiaSuggestion`이 그대로 들어맞는다. */
export interface DismissableSuggestion {
  kind: string;
  fingerprint: string;
  packId: string;
  definitionId: string;
  targetId: string;
  metadata: SuggestionMetadata;
}

/** 프로젝트 정리 제안의 임계 통과 여부. 숨김 기록의 재무장 판단에 쓴다. */
export interface ProjectDismissalState {
  key: string;
  qualifies: boolean;
  unfiledCount: number;
}

/**
 * 숨김 기록이 나뉘는 세 갈래. 저장 자리(`projectDismissals`·`featureTips`·`incidentDismissals`)와
 * 재무장 규칙이 갈래마다 달라, 숨길 때·다시 보일지 볼 때·오래된 기록을 정리할 때 세 곳이
 * 각자 `kind`를 견주고 있었다. 그중 정리 쪽은 나머지 두 갈래를 부정으로 걸러 내는 문장이라
 * 갈래가 하나 늘면 조용히 사건 취급으로 흘렀다. 분류는 여기 한 벌만 두고 세 곳이 이 값을 본다.
 */
type DismissalBucket = "project" | "featureTip" | "incident";

function dismissalBucket(kind: string): DismissalBucket {
  if (kind === "projectSessionCleanup") return "project";
  if (kind === "featureTip") return "featureTip";
  return "incident";
}

/**
 * 갈래 하나가 스스로 아는 것 — 제안을 어떤 키로 알아보고, 숨길 때 어디에 무엇을 적고,
 * 다시 보일 때가 됐는지 어떻게 보는가.
 *
 * 분류는 한 벌로 모여 있었지만 그 뒤가 갈래마다 흩어져 있었다. 숨기는 쪽과 보일지 보는
 * 쪽이 각자 `switch`를 펼쳐 두고, 키를 만드는 세 함수는 파일 맨 끝에 따로 떨어져 있어
 * 갈래 하나를 더하려면 네 자리를 찾아다녀야 했다. 그중 한 자리를 빠뜨려도 형식 오류가
 * 나지 않는다 — 숨기기만 하고 판정을 더하지 않으면 그 갈래는 숨겨도 계속 보이고, 판정만
 * 더하면 영영 숨지 않는다. 갈래가 자기 네 가지를 한 줄로 갖게 두면 그 갈림이 생기지 않는다.
 */
interface DismissalRules {
  /** 숨김 기록에서 이 제안을 가리키는 키. */
  key(suggestion: DismissableSuggestion): string;
  /** 숨김 기록에 이 제안을 남긴다. 이미 복제된 기록을 그 자리에서 고친다. */
  dismiss(history: AiaSuggestionHistory, key: string, suggestion: DismissableSuggestion, now: number): void;
  /** 지금 보여줄지. 재무장된 기록은 그 자리에서 지운다. */
  visible(history: AiaSuggestionHistory, key: string, suggestion: DismissableSuggestion, now: number): boolean;
}

/**
 * 이 제안을 맡을 갈래와, 그 갈래가 이 제안을 알아보는 키. 키를 여기서 한 번만 짓는 것이
 * 요점이다 — 갈래마다 `key`를 두고도 숨기는 쪽과 보일지 보는 쪽이 같은 키 함수를 이름으로
 * 다시 불러, 갈래 하나가 자기 키를 세 자리에서 네 자리까지 되풀이해 적고 있었다. 갈래의
 * 키를 바꾸면서 그중 한 자리를 놓쳐도 형식 오류가 나지 않는다 — 두 자리가 서로 다른 키를
 * 보게 되어, 숨긴 제안이 다음 판정에서 기록을 찾지 못해 그대로 다시 뜬다(또는 재무장된
 * 기록을 지우지 못해 영영 남는다). 키를 짓는 자리를 갈래마다 한 줄로 되돌린다.
 */
function dismissalFor(suggestion: DismissableSuggestion): { rules: DismissalRules; key: string } {
  const rules = DISMISSAL_RULES[dismissalBucket(suggestion.kind)];
  return { rules, key: rules.key(suggestion) };
}

export function dismissAiaSuggestion(
  history: AiaSuggestionHistory,
  suggestion: DismissableSuggestion,
  now: number,
): AiaSuggestionHistory {
  const next = cloneAiaSuggestionHistory(history);
  const { rules, key } = dismissalFor(suggestion);
  rules.dismiss(next, key, suggestion, now);
  return next;
}

/**
 * 후보 목록에 더 이상 없는 숨김 기록을 정리한다. 프로젝트·사건 숨김은 재무장 조건을
 * 판단해야 하므로 `resolved` 표시만 남기고, 지문 숨김은 근거가 사라졌으므로 지운다.
 */
export function resolveStaleDismissals(
  history: AiaSuggestionHistory,
  allCandidates: DismissableSuggestion[],
  projectStates: Map<string, ProjectDismissalState>,
): void {
  markResolvedWhenGone(history.projectDismissals, (key) => projectStates.get(key)?.qualifies === true);

  const activeIncidentKeys = new Set(
    allCandidates
      .filter((suggestion) => dismissalBucket(suggestion.kind) === "incident")
      .map(DISMISSAL_RULES.incident.key),
  );
  markResolvedWhenGone(history.incidentDismissals, (key) => activeIncidentKeys.has(key));

  const activeFingerprints = new Set(allCandidates.map((suggestion) => suggestion.fingerprint));
  for (const fingerprint of Object.keys(history.dismissed)) {
    if (!activeFingerprints.has(fingerprint)) delete history.dismissed[fingerprint];
  }
}

/**
 * 근거가 사라진 숨김 기록에 `resolved` 표시를 남긴다. 지우지 않는 것은 재무장 조건이
 * "해소된 뒤 다시 나타났는가"를 보기 때문이다(`afterResolved`·프로젝트 임계 재통과).
 * 프로젝트·사건 두 갈래가 살아 있는지 보는 기준만 다르고 표시는 같아 판정만 받는다.
 */
function markResolvedWhenGone(
  dismissals: Record<string, { resolved: boolean }>,
  isActive: (key: string) => boolean,
): void {
  for (const [key, dismissal] of Object.entries(dismissals)) {
    if (!isActive(key)) dismissal.resolved = true;
  }
}

/** 숨김 기록에 비춰 이 제안을 지금 보여줄지 정한다. 재무장된 기록은 그 자리에서 지운다. */
export function isSuggestionVisible(suggestion: DismissableSuggestion, history: AiaSuggestionHistory, now: number): boolean {
  const { rules, key } = dismissalFor(suggestion);
  return rules.visible(history, key, suggestion, now);
}

/**
 * 숨김 기록 한 건의 재무장 판정. 기록이 없으면 판정할 것이 없어 `undefined`를 주고, 조건을
 * 넘긴 기록은 그 자리에서 지운 뒤 `true`를 준다.
 *
 * "찾고 / 없으면 보이고 / 재무장이면 지우고 보인다"는 같은 세 걸음을 갈래 셋(프로젝트 숨김·
 * 사건 숨김·지문 숨김)이 각자 펼쳐 놓고 있었다. 세 걸음 중 지우는 걸음이 갈래마다 따로
 * 적혀 있으면 한 갈래에서 그것을 빠뜨렸을 때 오류 없이 조용히 갈린다 — 기록이 영영 남아
 * 재무장 조건을 이미 넘긴 제안이 매번 다시 판정만 받고 화면에는 뜨지 않는다. 순회는 여기
 * 한 벌만 두고, 갈래마다 다른 것은 재무장 조건뿐이다.
 *
 * `undefined`로 "기록 없음"을 따로 알리는 것은 사건 갈래가 그때 지문 숨김으로 넘어가야
 * 하기 때문이다. 불리언 하나로 뭉개면 그 갈림을 호출부가 다시 조회해 확인해야 한다.
 */
function rearmedDismissal<T>(
  records: Record<string, T>,
  key: string,
  rearmed: (record: T) => boolean,
): boolean | undefined {
  const record = records[key];
  if (record === undefined) return undefined;
  if (!rearmed(record)) return false;
  delete records[key];
  return true;
}

/** 숨김 시각으로부터 설정된 냉각 시간이 지났는지 판정한다. */
function isCooldownElapsed(dismissedAt: number, cooldownMinutes: number, now: number): boolean {
  return cooldownMinutes > 0 && now - dismissedAt >= cooldownMinutes * MINUTE;
}

/** 사건 숨김이 먼저고, 없으면 지문 숨김의 냉각 시간을 본다. */
function isIncidentSuggestionVisible(
  history: AiaSuggestionHistory,
  key: string,
  suggestion: DismissableSuggestion,
  now: number,
): boolean {
  const incident = rearmedDismissal(
    history.incidentDismissals,
    key,
    (dismissal) => isCooldownElapsed(dismissal.dismissedAt, dismissal.cooldownMinutes, now)
      || (dismissal.resolved && dismissal.afterResolved),
  );
  if (incident !== undefined) return incident;

  return rearmedDismissal(history.dismissed, suggestion.fingerprint, (dismissedAt) => {
    const cooldownMinutes = numberMetadata(suggestion, "cooldownMinutes", 0);
    return isCooldownElapsed(dismissedAt, cooldownMinutes, now);
  }) ?? true;
}

/** 프로젝트 정리 제안은 임계가 풀렸거나 미정리 수가 재무장 폭만큼 늘면 다시 보인다. */
function isProjectSuggestionVisible(
  history: AiaSuggestionHistory,
  key: string,
  suggestion: DismissableSuggestion,
): boolean {
  return rearmedDismissal(history.projectDismissals, key, (dismissal) => {
    const unfiled = numberMetadata(suggestion, "unfiledCount", 0);
    return dismissal.resolved || unfiled >= dismissal.unfiledBaseline + dismissal.rearmDelta;
  }) ?? true;
}

function projectDismissalKey(suggestion: DismissableSuggestion): string {
  return projectHistoryKey(suggestion.packId, suggestion.definitionId, suggestion.targetId);
}

function featureTipKey(suggestion: DismissableSuggestion): string {
  return suggestionFingerprint(suggestion.packId, suggestion.definitionId, "feature-tip", "seen");
}

function incidentDismissalKey(suggestion: DismissableSuggestion): string {
  return suggestionFingerprint(suggestion.packId, suggestion.definitionId, suggestion.targetId, "incident-dismissal");
}

/**
 * 갈래별 규칙 한 벌. 갈래를 더하는 일은 `dismissalBucket`에 한 줄, 여기에 한 줄이다.
 *
 * 기능 소개(`featureTip`)만 저장 자리가 레코드가 아니라 문자열 배열이다 — 남길 것이
 * "봤다"뿐이라 재무장할 것이 없어 시각도 상태도 담지 않는다. 그래서 이 갈래만
 * `rearmedDismissal`을 지나지 않는다.
 */
const DISMISSAL_RULES: Record<DismissalBucket, DismissalRules> = {
  project: {
    key: projectDismissalKey,
    dismiss: (history, key, suggestion, now) => {
      history.projectDismissals[key] = {
        dismissedAt: now,
        unfiledBaseline: numberMetadata(suggestion, "unfiledCount", 0),
        rearmDelta: Math.max(1, numberMetadata(suggestion, "rearmDelta", 3)),
        resolved: false,
      };
    },
    visible: isProjectSuggestionVisible,
  },
  featureTip: {
    key: featureTipKey,
    dismiss: (history, key) => {
      if (!history.featureTips.includes(key)) history.featureTips.push(key);
    },
    visible: (history, key) => !history.featureTips.includes(key),
  },
  incident: {
    key: incidentDismissalKey,
    dismiss: (history, key, suggestion, now) => {
      history.incidentDismissals[key] = {
        dismissedAt: now,
        resolved: false,
        afterResolved: suggestion.metadata.afterResolved === true,
        cooldownMinutes: numberMetadata(suggestion, "cooldownMinutes", 0),
      };
    },
    visible: isIncidentSuggestionVisible,
  },
};

export function projectHistoryKey(packId: string, definitionId: string, targetId: string): string {
  return suggestionFingerprint(packId, definitionId, targetId, "project-dismissal");
}
