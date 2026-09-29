/**
 * 규칙 평가의 뼈대. `aiaSuggestions.ts`가 카탈로그 순회와 이력 반영을 맡는 동안 여기서는
 * "정의 하나를 평가하는 동안 무엇이 문맥으로 주어지는가"만 다룬다.
 *
 * 종류별 생성기와 종류별 정렬은 `aiaSuggestionKinds.ts`가 갖는다. 그 둘이 여기 함께
 * 있는 동안 파일은 종류가 늘 때마다 자랐고, 종류를 모르는 것이 요점인 뼈대가 여덟 벌의
 * 생성기 사이에 파묻혀 있었다. 종류 하나에만 필요한 집계와 정렬은 다시 그 종류의
 * 모듈이 갖는다(프로젝트 정리는 `aiaProjectCleanup.ts`).
 *
 * 후보를 보이는 제안으로 조립하는 일(문구 템플릿·길이 상한·재무장 메타데이터)은
 * `aiaSuggestionTemplate.ts`가 갖는다. 여기서는 `rule.suggest`로 그 조립을 부른다.
 *
 * 타입 선언은 `aiaSuggestionTypes.ts`에 있다. 진입점(`aiaSuggestions.ts`)이 이 모듈을
 * 런타임으로 부르므로, 선언을 그쪽에서 되가져오지 않고 선언 모듈에서 바로 가져온다.
 */
import { clampedInteger, clampedNumber } from "./aiaPrimitives.ts";
import { suggestionsOfKind } from "./aiaSuggestionKinds.ts";
import type { ProjectDismissalState } from "./aiaSuggestionHistory.ts";
import type { SuggestionFields } from "./aiaSuggestionTemplate.ts";
import { makeSuggestion } from "./aiaSuggestionTemplate.ts";
import type {
  AiaSuggestion,
  AiaSuggestionDefinition,
  AiaSuggestionEvaluationInput,
  AiaSuggestionPack,
} from "./aiaSuggestionTypes.ts";

export function evaluateDefinition(
  pack: AiaSuggestionPack,
  definition: AiaSuggestionDefinition,
  input: AiaSuggestionEvaluationInput,
): { suggestions: AiaSuggestion[]; projectStates: ProjectDismissalState[] } {
  const projectStates: ProjectDismissalState[] = [];
  const rule = ruleContext(pack, definition, input, projectStates);
  return { suggestions: suggestionsOfKind(definition.kind, rule), projectStates };
}

/**
 * 규칙 하나를 평가하는 동안 바뀌지 않는 것(어느 팩의 어느 정의를, 어느 스냅샷에서)을
 * 묶어 둔다. 종류별 생성기가 저마다 `pack`·`definition`·`input` 세 인자를 받아 그대로
 * 다시 넘기던 것을 없애고, 정의 파라미터를 읽는 자리도 키와 기본값만 남긴다.
 */
export interface RuleContext {
  /** 정의 식별자. 제안 id·숨김 키를 만드는 데만 쓴다. */
  definitionId: string;
  input: AiaSuggestionEvaluationInput;
  packId: string;
  /** 이 정의가 만드는 제안 하나. 대상과 상태 키, 템플릿·메타데이터 필드만 넘긴다. */
  suggest(targetId: string, stateKey: string, fields: SuggestionFields): AiaSuggestion;
  /**
   * 제안으로는 나오지 않지만 숨김 기록이 재무장 판정에 쓰는 임계 상태를 남긴다.
   * 프로젝트 정리 한 종류만 쓰므로 반환값 대신 여기로 받는다.
   */
  projectState(state: ProjectDismissalState): void;
  /** 정의가 준 실수 파라미터를 범위로 자른 값. 숫자가 아니면 기본값. */
  number(key: string, fallback: number, minimum: number, maximum: number): number;
  /** 개수·상한처럼 정수여야 하는 파라미터. */
  integer(key: string, fallback: number, minimum: number, maximum: number): number;
  /** 재무장 설정(`rearm`)이 준 정수 파라미터. 파라미터와 읽는 규칙이 같다. */
  rearmInteger(key: string, fallback: number, minimum: number, maximum: number): number;
  /** `unit` 단위로 준 기간 파라미터를 밀리초로 읽는다. */
  duration(key: string, fallback: number, minimum: number, maximum: number, unit: number): number;
  /** 문자열 파라미터. 문자열이 아니면 기본값. */
  string(key: string, fallback: string): string;
}

function ruleContext(
  pack: AiaSuggestionPack,
  definition: AiaSuggestionDefinition,
  input: AiaSuggestionEvaluationInput,
  projectStates: ProjectDismissalState[],
): RuleContext {
  const number = (key: string, fallback: number, minimum: number, maximum: number) =>
    clampedNumber(definition.parameters, key, fallback, minimum, maximum);
  return {
    definitionId: definition.id,
    input,
    packId: pack.packId,
    suggest: (targetId, stateKey, fields) => makeSuggestion(pack, definition, targetId, stateKey, fields),
    projectState: (state) => { projectStates.push(state); },
    number,
    integer: (key, fallback, minimum, maximum) => clampedInteger(definition.parameters, key, fallback, minimum, maximum),
    rearmInteger: (key, fallback, minimum, maximum) => clampedInteger(definition.rearm, key, fallback, minimum, maximum),
    duration: (key, fallback, minimum, maximum, unit) => number(key, fallback, minimum, maximum) * unit,
    string: (key, fallback) => {
      const value = definition.parameters?.[key];
      return typeof value === "string" ? value : fallback;
    },
  };
}
