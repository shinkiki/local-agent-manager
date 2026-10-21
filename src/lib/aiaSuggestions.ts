/**
 * 제안 평가의 진입점. 카탈로그를 펼쳐 정의마다 평가 문맥을 짓고
 * (`aiaSuggestionRules.ts`), 종류별 생성기가 만든 후보를(`aiaSuggestionKinds.ts`)
 * 숨김 기록에 비춰(`aiaSuggestionHistory.ts`) 보여줄 목록을 정한다.
 *
 * 타입 선언은 `aiaSuggestionTypes.ts`가 갖는다. 구현 모듈이 선언을 이 파일에서
 * 되가져오면 참조가 양방향으로 걸려, 종류를 하나 더할 때 선언과 구현을 오가며
 * 고쳐야 했다. 기존 호출부가 경로를 바꾸지 않도록 여기서 그대로 다시 내보낸다.
 */
import type { ProjectDismissalState } from "./aiaSuggestionHistory.ts";
import {
  cloneAiaSuggestionHistory,
  emptyAiaSuggestionHistory,
  isSuggestionVisible,
  resolveStaleDismissals,
} from "./aiaSuggestionHistory.ts";
import { limitProjectSuggestions } from "./aiaProjectCleanup.ts";
import { compareSuggestions } from "./aiaSuggestionKinds.ts";
import { evaluateDefinition } from "./aiaSuggestionRules.ts";
import type {
  AiaSuggestion,
  AiaSuggestionEffectivePack,
  AiaSuggestionEvaluation,
  AiaSuggestionEvaluationInput,
  AiaSuggestionPack,
} from "./aiaSuggestionTypes.ts";

/**
 * 타입 선언은 `aiaSuggestionTypes.ts`가 갖는다. 여기서는 호출부가 실제로 이 진입점을
 * 지나 쓰는 이름만 다시 내보낸다 — 카탈로그 안쪽 모양(정의·팩·출처·검증 문제)은
 * 카탈로그를 읽고 쓰는 모듈만 보므로 선언 모듈에서 바로 가져간다.
 */
export type {
  AiaSuggestion,
  AiaSuggestionCatalog,
  AiaSuggestionKind,
} from "./aiaSuggestionTypes.ts";

/** 규칙 평가·정렬은 별도 모듈이 맡는다. 경로 정규화는 기존 호출부가 그대로 쓰도록 다시 내보낸다. */
export { normalizeProjectPath } from "./aiaProjectCleanup.ts";

/** 스킬 변경 감지는 별도 모듈이 맡는다. 기존 호출부가 그대로 쓰도록 여기서 다시 내보낸다. */
export type { AiaSkillChangeState } from "./aiaSkillChanges.ts";
export {
  clearAiaSkillChange,
  emptyAiaSkillChangeState,
  observeAiaSkillChanges,
  parseAiaSkillChangeState,
  serializeAiaSkillChangeState,
} from "./aiaSkillChanges.ts";

/** 사건 감지는 별도 모듈이 맡는다. 기존 호출부가 그대로 쓰도록 여기서 다시 내보낸다. */
export type { AiaEvent, AiaEventBaseline, AiaEventKind } from "./aiaEvents.ts";
export {
  captureAiaEventBaseline,
  coalesceAiaEvents,
  detectAiaEvents,
} from "./aiaEvents.ts";

/** 사건 발송 예산도 마찬가지다. 감지와 갈라 둔 모듈이지만 호출부가 보는 자리는 그대로다. */
export {
  canDispatchAiaEvent,
  emptyAiaEventBudget,
  parseAiaEventBudget,
  recordAiaEventDispatch,
  serializeAiaEventBudget,
} from "./aiaEventBudget.ts";

/** 숨김 기록은 별도 모듈이 맡는다. 기존 호출부가 그대로 쓰도록 여기서 다시 내보낸다. */
export type { AiaSuggestionHistory } from "./aiaSuggestionHistory.ts";
export {
  dismissAiaSuggestion,
  emptyAiaSuggestionHistory,
  parseAiaSuggestionHistory,
  serializeAiaSuggestionHistory,
} from "./aiaSuggestionHistory.ts";

/** 제안 지문은 숨김과 무관한 규칙이라 따로 선다. 호출부가 보는 자리는 그대로다. */
export { suggestionFingerprint } from "./aiaFingerprint.ts";

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

/**
 * 전송이 끝난 뒤 작성창에 남길 글. 전송(첨부 업로드·재시작 포함)이 도는 동안에도 작성창은
 * 열려 있어 사용자가 글을 더 쓰거나 제안을 끼워 넣을 수 있다. 작성창이 아직 보낸 그 글
 * 그대로일 때만 비우고, 그사이 바뀌었으면 보내지 않은 글이므로 그대로 둔다.
 */
export function composerAfterSend(current: string, sent: string): string {
  if (current === sent) return "";
  // 보낸 글 뒤에 이어 쓴 경우(제안 끼워 넣기도 이 모양이다)는 이미 보낸 앞부분만 걷는다.
  // 다시 보내면 같은 글이 두 번 간다.
  if (sent.trim() && current.startsWith(sent)) return current.slice(sent.length).trimStart();
  return current;
}
