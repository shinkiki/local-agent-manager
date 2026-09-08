import type {
  AccountSnapshot,
  ChatAttentionSnapshot,
  ManagerSnapshot,
  SchedulerSnapshot,
  SystemAutomationSnapshot,
} from "../types";
import type { AiaSkillChange } from "./aiaSkillChanges.ts";
import type { AiaSuggestionHistory, ProjectDismissalState } from "./aiaSuggestionHistory.ts";
import {
  cloneAiaSuggestionHistory,
  emptyAiaSuggestionHistory,
  isSuggestionVisible,
  resolveStaleDismissals,
} from "./aiaSuggestionHistory.ts";
import { limitProjectSuggestions } from "./aiaProjectCleanup.ts";
import { compareSuggestions, evaluateDefinition } from "./aiaSuggestionRules.ts";

/** 규칙 평가·정렬은 별도 모듈이 맡는다. 경로 정규화는 기존 호출부가 그대로 쓰도록 다시 내보낸다. */
export { normalizeProjectPath } from "./aiaProjectCleanup.ts";

/** 스킬 변경 감지는 별도 모듈이 맡는다. 기존 호출부가 그대로 쓰도록 여기서 다시 내보낸다. */
export type { AiaSkillChange, AiaSkillChangeState, AiaSkillDigest } from "./aiaSkillChanges.ts";
export {
  clearAiaSkillChange,
  emptyAiaSkillChangeState,
  observeAiaSkillChanges,
  parseAiaSkillChangeState,
  serializeAiaSkillChangeState,
} from "./aiaSkillChanges.ts";

export type AiaSuggestionKind =
  | "providerCliMissing"
  | "accountAuthError"
  /** 폐기된 종류. 이미 배포된 팩이 담고 있어도 제안으로 만들지 않는다. */
  | "accountUsageThreshold"
  | "accountAutoSwitchMissing"
  | "schedulerPaused"
  | "scheduleRunFailed"
  | "translationFailed"
  | "projectSessionCleanup"
  | "interruptedSessionReminder"
  | "skillContentChanged"
  | "featureTip";

export interface AiaSuggestionDefinition {
  id: string;
  kind: AiaSuggestionKind;
  enabled: boolean;
  severity: string;
  priority: number;
  titleTemplate: string;
  detailTemplate: string;
  promptTemplate: string;
  parameters?: Record<string, unknown>;
  rearm?: Record<string, unknown>;
}

export interface AiaSuggestionPack {
  schemaVersion?: number;
  packId: string;
  version?: string;
  displayName: string;
  source?: string;
  skillKey?: string | null;
  suggestions: AiaSuggestionDefinition[];
}

export type AiaSuggestionPackSource = "bundled" | "commonSkill" | "lastKnownGood" | string;

export interface AiaSuggestionEffectivePack {
  source: AiaSuggestionPackSource;
  skillKey: string | null;
  pack: AiaSuggestionPack;
}

export interface AiaSuggestionCatalogIssue {
  skillKey: string;
  message: string;
  usingLastKnownGood: boolean;
}

export interface AiaSuggestionCatalogDefinition {
  packId: string;
  packDisplayName: string;
  skillKey: string | null;
  definition: AiaSuggestionDefinition;
}

export interface AiaSuggestionBundledSkillTemplate {
  key: string;
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
  installed: boolean;
}

export interface AiaSuggestionCatalog {
  contentDigest: string;
  packs: AiaSuggestionEffectivePack[];
  definitions: AiaSuggestionCatalogDefinition[];
  issues: AiaSuggestionCatalogIssue[];
  bundledSkill: AiaSuggestionBundledSkillTemplate;
  /** 테스트·이전 호출자가 쓰던 콘텐츠 지문 별칭. */
  fingerprint?: string;
}

export interface AiaSuggestionFlatCatalog {
  packs: AiaSuggestionPack[];
  fingerprint?: string;
}

export interface AiaSuggestion {
  id: string;
  definitionId: string;
  fingerprint: string;
  kind: AiaSuggestionKind;
  severity: string;
  priority: number;
  title: string;
  detail: string;
  prompt: string;
  packId: string;
  packDisplayName: string;
  source: string;
  skillKey: string | null;
  targetId: string;
  stateKey: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface AiaSuggestionEvaluationInput {
  catalog: AiaSuggestionCatalog | AiaSuggestionFlatCatalog | AiaSuggestionPack[];
  manager: ManagerSnapshot;
  accounts: AccountSnapshot | null;
  scheduler: SchedulerSnapshot | null;
  automation: SystemAutomationSnapshot | null;
  attention: ChatAttentionSnapshot;
  now: number;
  history?: AiaSuggestionHistory | null;
  /** 감지된 스킬 내용 변경. 즉시 트리거는 이 목록만 보고 검토 제안을 만든다. */
  skillChanges?: AiaSkillChange[] | null;
}

export interface AiaSuggestionEvaluation {
  suggestions: AiaSuggestion[];
  allCandidates: AiaSuggestion[];
  history: AiaSuggestionHistory;
}

/** 사건 감지·발송 예산은 별도 모듈이 맡는다. 기존 호출부가 그대로 쓰도록 여기서 다시 내보낸다. */
export type {
  AiaEvent,
  AiaEventBaseline,
  AiaEventBudget,
  AiaEventKind,
  AiaEventTransitionResult,
} from "./aiaEvents.ts";
export {
  canDispatchAiaEvent,
  captureAiaEventBaseline,
  coalesceAiaEvents,
  detectAiaEvents,
  emptyAiaEventBudget,
  parseAiaEventBudget,
  recordAiaEventDispatch,
  serializeAiaEventBudget,
} from "./aiaEvents.ts";

/** 숨김 기록은 별도 모듈이 맡는다. 기존 호출부가 그대로 쓰도록 여기서 다시 내보낸다. */
export type { AiaSuggestionHistory, IncidentDismissal, ProjectDismissal } from "./aiaSuggestionHistory.ts";
export {
  dismissAiaSuggestion,
  emptyAiaSuggestionHistory,
  parseAiaSuggestionHistory,
  serializeAiaSuggestionHistory,
  suggestionFingerprint,
} from "./aiaSuggestionHistory.ts";

export function evaluateAiaSuggestions(input: AiaSuggestionEvaluationInput): AiaSuggestion[] {
  return evaluateAiaSuggestionState(input).suggestions;
}

export function evaluateAiaSuggestionState(input: AiaSuggestionEvaluationInput): AiaSuggestionEvaluation {
  const history = cloneAiaSuggestionHistory(input.history ?? emptyAiaSuggestionHistory());
  const { allCandidates, projectStates } = collectCandidates(input);

  resolveStaleDismissals(history, allCandidates, projectStates);

  const suggestions = limitProjectSuggestions(
    allCandidates.filter((suggestion) => isSuggestionVisible(suggestion, history, input.now)),
  );
  suggestions.sort(compareSuggestions);
  allCandidates.sort(compareSuggestions);
  return { suggestions, allCandidates, history };
}

/** 활성 팩의 모든 정의를 평가해 후보 제안과 프로젝트별 임계 상태를 모은다. */
function collectCandidates(input: AiaSuggestionEvaluationInput): {
  allCandidates: AiaSuggestion[];
  projectStates: Map<string, ProjectDismissalState>;
} {
  const catalogPacks = Array.isArray(input.catalog) ? input.catalog : input.catalog.packs;
  const allCandidates: AiaSuggestion[] = [];
  const projectStates = new Map<string, ProjectDismissalState>();

  for (const pack of catalogPacks.map(flattenEffectivePack)) {
    for (const definition of pack.suggestions) {
      if (!definition.enabled) continue;
      const evaluated = evaluateDefinition(pack, definition, input);
      allCandidates.push(...evaluated.suggestions);
      for (const state of evaluated.projectStates) projectStates.set(state.key, state);
    }
  }
  return { allCandidates, projectStates };
}

function flattenEffectivePack(entry: AiaSuggestionPack | AiaSuggestionEffectivePack): AiaSuggestionPack {
  if ("pack" in entry) return { ...entry.pack, source: entry.source, skillKey: entry.skillKey };
  return entry;
}

/** 제안은 전송하지 않고 현재 작성 중인 초안 뒤에 한 줄을 비워 추가한다. */
export function mergeComposerDraft(current: string, prompt: string): string {
  const addition = prompt.trim();
  if (!addition) return current;
  if (!current.trim()) return addition;
  return `${current.trimEnd()}\n\n${addition}`;
}
