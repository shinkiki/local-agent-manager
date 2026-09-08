/**
 * 제안 숨김 기록. "지금 무엇이 후보인가"와 "그중 무엇을 다시 보여줄 때가 됐는가"는
 * 다른 규칙인데, 저장 형식·재무장 조건·숨김 키를 만드는 지문이 한 덩어리로 움직인다.
 * 후보를 만드는 `aiaSuggestions.ts`가 이 규칙까지 안고 있으면 저장 형식을 손볼 때마다
 * 제안 생성 코드를 헤집게 되므로 여기 따로 둔다.
 *
 * 의존 방향은 한쪽뿐이다 — 이 모듈은 제안이 어떻게 만들어지는지 모르고, 숨김 판정에
 * 필요한 최소 모양(`DismissableSuggestion`)만 본다.
 */
import {
  MINUTE,
  finiteNumber,
  numericRecord,
  parsePersisted,
  uniqueStrings,
  validatedRecord,
} from "./aiaPrimitives.ts";

/** 숨김 판정이 보는 제안의 최소 모양. `AiaSuggestion`이 그대로 들어맞는다. */
export interface DismissableSuggestion {
  kind: string;
  fingerprint: string;
  packId: string;
  definitionId: string;
  targetId: string;
  metadata: Record<string, string | number | boolean | null>;
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

export interface ProjectDismissal {
  dismissedAt: number;
  unfiledBaseline: number;
  rearmDelta: number;
  resolved: boolean;
}

export interface IncidentDismissal {
  dismissedAt: number;
  resolved: boolean;
  afterResolved: boolean;
  cooldownMinutes: number;
}

export interface AiaSuggestionHistory {
  schemaVersion: 1;
  dismissed: Record<string, number>;
  incidentDismissals: Record<string, IncidentDismissal>;
  projectDismissals: Record<string, ProjectDismissal>;
  featureTips: string[];
}

/** 프로젝트 정리 제안의 임계 통과 여부. 숨김 기록의 재무장 판단에 쓴다. */
export interface ProjectDismissalState {
  key: string;
  qualifies: boolean;
  unfiledCount: number;
}

/**
 * 제안을 숨김 기록에서 알아보는 지문. 팩·정의·대상·상태를 길이 접두사로 이어 붙여
 * 구분자 충돌을 없앤 뒤 두 방향으로 해싱한다. 제안의 `fingerprint` 필드와 프로젝트·사건
 * 숨김 키가 모두 이 함수 하나로 만들어진다.
 */
export function suggestionFingerprint(packId: string, definitionId: string, targetId: string, stateKey: string): string {
  const source = [packId, definitionId, targetId, stateKey].map(encodeFingerprintPart).join(":");
  return `aia1-${hash32(source)}${hash32([...source].reverse().join(""))}`;
}

function encodeFingerprintPart(value: string): string {
  return `${value.length}.${value}`;
}

function hash32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function emptyAiaSuggestionHistory(): AiaSuggestionHistory {
  return { schemaVersion: 1, dismissed: {}, incidentDismissals: {}, projectDismissals: {}, featureTips: [] };
}

export function parseAiaSuggestionHistory(value: string | null | undefined): AiaSuggestionHistory {
  return parsePersisted(value, emptyAiaSuggestionHistory, 1, (parsed) => ({
    schemaVersion: 1,
    dismissed: numericRecord(parsed.dismissed),
    incidentDismissals: validatedRecord<IncidentDismissal>(parsed.incidentDismissals, (entry) => {
      const dismissedAt = finiteNumber(entry.dismissedAt);
      const cooldownMinutes = finiteNumber(entry.cooldownMinutes);
      if (dismissedAt === null || cooldownMinutes === null) return null;
      return {
        dismissedAt,
        resolved: entry.resolved === true,
        afterResolved: entry.afterResolved === true,
        cooldownMinutes: Math.max(0, cooldownMinutes),
      };
    }),
    projectDismissals: validatedRecord<ProjectDismissal>(parsed.projectDismissals, (entry) => {
      const dismissedAt = finiteNumber(entry.dismissedAt);
      const unfiledBaseline = finiteNumber(entry.unfiledBaseline);
      const rearmDelta = finiteNumber(entry.rearmDelta);
      if (dismissedAt === null || unfiledBaseline === null || rearmDelta === null) return null;
      return {
        dismissedAt,
        unfiledBaseline,
        rearmDelta: Math.max(1, rearmDelta),
        resolved: entry.resolved === true,
      };
    }),
    featureTips: uniqueStrings(parsed.featureTips),
  }));
}

export function serializeAiaSuggestionHistory(history: AiaSuggestionHistory): string {
  return JSON.stringify({
    schemaVersion: 1,
    dismissed: numericRecord(history.dismissed),
    incidentDismissals: history.incidentDismissals,
    projectDismissals: history.projectDismissals,
    featureTips: [...new Set(history.featureTips)].sort(),
  });
}

export function dismissAiaSuggestion(
  history: AiaSuggestionHistory,
  suggestion: DismissableSuggestion,
  now: number,
): AiaSuggestionHistory {
  const next = cloneAiaSuggestionHistory(history);
  switch (dismissalBucket(suggestion.kind)) {
    case "project": {
      const unfiledBaseline = numberMetadata(suggestion, "unfiledCount", 0);
      const rearmDelta = numberMetadata(suggestion, "rearmDelta", 3);
      next.projectDismissals[projectDismissalKey(suggestion)] = {
        dismissedAt: now,
        unfiledBaseline,
        rearmDelta: Math.max(1, rearmDelta),
        resolved: false,
      };
      break;
    }
    case "featureTip": {
      const key = featureTipKey(suggestion);
      if (!next.featureTips.includes(key)) next.featureTips.push(key);
      break;
    }
    case "incident":
      next.incidentDismissals[incidentDismissalKey(suggestion)] = {
        dismissedAt: now,
        resolved: false,
        afterResolved: suggestion.metadata.afterResolved === true,
        cooldownMinutes: numberMetadata(suggestion, "cooldownMinutes", 0),
      };
      break;
  }
  return next;
}

export function cloneAiaSuggestionHistory(history: AiaSuggestionHistory): AiaSuggestionHistory {
  return {
    schemaVersion: 1,
    dismissed: { ...history.dismissed },
    incidentDismissals: Object.fromEntries(
      Object.entries(history.incidentDismissals ?? {}).map(([key, value]) => [key, { ...value }]),
    ),
    projectDismissals: Object.fromEntries(
      Object.entries(history.projectDismissals).map(([key, value]) => [key, { ...value }]),
    ),
    featureTips: [...history.featureTips],
  };
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
  for (const [key, dismissal] of Object.entries(history.projectDismissals)) {
    if (!projectStates.get(key)?.qualifies) dismissal.resolved = true;
  }

  const activeIncidentKeys = new Set(
    allCandidates
      .filter((suggestion) => dismissalBucket(suggestion.kind) === "incident")
      .map(incidentDismissalKey),
  );
  for (const [key, dismissal] of Object.entries(history.incidentDismissals)) {
    if (!activeIncidentKeys.has(key)) dismissal.resolved = true;
  }

  const activeFingerprints = new Set(allCandidates.map((suggestion) => suggestion.fingerprint));
  for (const fingerprint of Object.keys(history.dismissed)) {
    if (!activeFingerprints.has(fingerprint)) delete history.dismissed[fingerprint];
  }
}

/** 숨김 기록에 비춰 이 제안을 지금 보여줄지 정한다. 재무장된 기록은 그 자리에서 지운다. */
export function isSuggestionVisible(suggestion: DismissableSuggestion, history: AiaSuggestionHistory, now: number): boolean {
  switch (dismissalBucket(suggestion.kind)) {
    case "featureTip":
      return !history.featureTips.includes(featureTipKey(suggestion));
    case "project":
      return isProjectSuggestionVisible(suggestion, history);
    case "incident":
      return isIncidentSuggestionVisible(suggestion, history, now);
  }
}

/** 사건 숨김이 먼저고, 없으면 지문 숨김의 냉각 시간을 본다. */
function isIncidentSuggestionVisible(suggestion: DismissableSuggestion, history: AiaSuggestionHistory, now: number): boolean {
  const incidentKey = incidentDismissalKey(suggestion);
  const incident = history.incidentDismissals[incidentKey];
  if (incident) {
    const rearmed = (incident.cooldownMinutes > 0 && now - incident.dismissedAt >= incident.cooldownMinutes * MINUTE)
      || (incident.resolved && incident.afterResolved);
    if (rearmed) delete history.incidentDismissals[incidentKey];
    return rearmed;
  }

  const dismissedAt = history.dismissed[suggestion.fingerprint];
  if (dismissedAt === undefined) return true;
  const cooldownMinutes = numberMetadata(suggestion, "cooldownMinutes", 0);
  if (cooldownMinutes > 0 && now - dismissedAt >= cooldownMinutes * MINUTE) {
    delete history.dismissed[suggestion.fingerprint];
    return true;
  }
  return false;
}

/** 프로젝트 정리 제안은 임계가 풀렸거나 미정리 수가 재무장 폭만큼 늘면 다시 보인다. */
function isProjectSuggestionVisible(suggestion: DismissableSuggestion, history: AiaSuggestionHistory): boolean {
  const key = projectDismissalKey(suggestion);
  const dismissal = history.projectDismissals[key];
  if (!dismissal) return true;
  const unfiled = numberMetadata(suggestion, "unfiledCount", 0);
  if (dismissal.resolved || unfiled >= dismissal.unfiledBaseline + dismissal.rearmDelta) {
    delete history.projectDismissals[key];
    return true;
  }
  return false;
}

export function numberMetadata(suggestion: DismissableSuggestion, key: string, fallback: number): number {
  return finiteNumber(suggestion.metadata[key]) ?? fallback;
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

export function projectHistoryKey(packId: string, definitionId: string, targetId: string): string {
  return suggestionFingerprint(packId, definitionId, targetId, "project-dismissal");
}
