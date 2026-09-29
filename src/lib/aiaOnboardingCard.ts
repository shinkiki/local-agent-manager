/**
 * 온보딩 카드의 단계·입력 칸을 읽는 자리.
 *
 * 카드에서 "지금 무엇이 서 있고 무엇이 비어 있는가"를 보는 일과, 그 값으로 워크플로
 * 계약을 조립하는 일은 자라는 축이 다르다. 칸 쪽은 병렬 묶음이 붙는 규칙(W6-8)과
 * 조건부 노출이 바뀔 때마다 손보이고, 계약 쪽은 `start_chat` 계약의 뼈대가 바뀔 때
 * 손보인다. 한 파일에 있는 동안은 칸 한 줄을 고치려 해도 계약 조립을 지나쳐 읽어야
 * 했다.
 *
 * 값 읽기(`aiaOnboardingValues.ts`) 위, 계약 조립(`aiaOnboarding.ts`) 아래에 선다.
 * 의존은 한 방향이다 — 여기는 계약을 모른다. 기존 호출부가 경로를 바꾸지 않도록
 * `aiaOnboarding.ts`가 이 이름들을 그대로 다시 내보낸다.
 */
import type {
  AiaOnboardingAction,
  AiaOnboardingCard,
  AiaOnboardingField,
  AiaOnboardingStep,
  AiaOnboardingWorkflowTemplate,
} from "../types";
import type { OnboardingValues } from "./aiaOnboardingValues.ts";
import { conditionHolds } from "./aiaOnboardingValues.ts";
import { parallelFields, supportsParallel } from "./aiaOnboardingParallel.ts";

/**
 * 화면이 실제로 그리는 단계 목록. 병렬을 선언한 카드에는 앱이 병렬 실행 입력 묶음을
 * 마지막 단계 끝에 덧붙인다(W6-8) — 팩마다 같은 칸 여섯 개를 베껴 적게 두면 레인 절차가
 * 바뀔 때 고쳐야 할 자리가 팩 수만큼 생긴다.
 */
export function cardSteps(card: AiaOnboardingCard): AiaOnboardingStep[] {
  if (!supportsParallel(card)) return card.steps;
  const projectPathField = card.actions.reduce<string>(
    (found, action) => (action.kind === "registerWorkflow" ? action.workflow.projectPathField : found),
    "projectPath",
  );
  return card.steps.map((step, index) => (index === card.steps.length - 1
    ? { ...step, fields: [...step.fields, ...parallelFields(projectPathField)] }
    : step));
}

/**
 * 카드가 가진 입력 칸 전부, 단계 구분 없이.
 *
 * 칸을 찾는 자리마다 `cardSteps`를 돌고 그 안에서 `fields`를 한 번 더 도는 이중 루프를
 * 따로 적고 있었다. 단계가 무엇인지 상관하지 않는 판정(기본값 채우기, 이름으로 칸 찾기)이
 * 병렬 묶음이 붙는 규칙을 각자 다시 통과하는 모양이라, 그 규칙이 바뀌면 고쳐야 할 루프가
 * 여럿이었다. 평평하게 펴는 일을 한 줄로 둔다.
 */
export function cardFields(card: AiaOnboardingCard): AiaOnboardingField[] {
  return cardSteps(card).flatMap((step) => step.fields);
}

/** 지금 값으로 보여야 하는 입력만. 숨은 칸은 필수값 판정에서도 빠진다. */
export function visibleFields(step: AiaOnboardingStep, values: OnboardingValues): AiaOnboardingField[] {
  return step.fields.filter((field) => conditionHolds(field.visibleWhen, values));
}

/** 팩이 선언한 기본값으로 시작 상태를 만든다. */
export function initialValues(card: AiaOnboardingCard): OnboardingValues {
  const values: OnboardingValues = {};
  for (const field of cardFields(card)) {
    if (field.defaultValue !== null && field.defaultValue !== undefined) values[field.key] = field.defaultValue;
    else if (field.kind === "toggle") values[field.key] = "false";
    else values[field.key] = "";
  }
  return values;
}

/** 아직 채우지 않은 필수 입력. 보이지 않는 칸은 묻지 않는다. */
export function missingRequired(card: AiaOnboardingCard, values: OnboardingValues): AiaOnboardingField[] {
  return cardSteps(card)
    .flatMap((step) => visibleFields(step, values))
    .filter((field) => field.required && (values[field.key] ?? "").trim().length === 0);
}

/**
 * 조건이 가리키는 칸이 지금 화면에 서 있는지. 숨은 칸의 값은 사용자가 지금 고른 것이
 * 아니라 앞서 다른 갈래를 골랐을 때 남은 값이다 — 그것을 조건으로 읽으면 노션을 고른
 * 사용자에게 마크다운 폴더를 만들자고 묻게 된다.
 */
function fieldVisible(card: AiaOnboardingCard, values: OnboardingValues, key: string): boolean {
  const field = cardFields(card).find((item) => item.key === key);
  // 카드에 없는 이름은 조건 검증이 이미 막는다. 여기까지 오면 판단할 것이 없다.
  if (!field) return true;
  return conditionHolds(field.visibleWhen, values);
}

/** 지금 값으로 실제 실행될 산출물만. 조건이 맞지 않거나 숨은 칸을 가리키면 건너뛴다. */
export function activeActions(card: AiaOnboardingCard, values: OnboardingValues): AiaOnboardingAction[] {
  return card.actions.filter((action) => {
    if (!conditionHolds(action.when, values)) return false;
    return !action.when || fieldVisible(card, values, action.when.field);
  });
}

/**
 * 지금 값으로 실제 등록될 워크플로만. 산출물을 다루는 세 자리(워크플로 id 사전검사,
 * 계약 한도 검사, 절차 스킬 계획)가 모두 "활성 동작을 돌며 등록 동작이 아닌 것을 건너뛰고
 * `action.workflow`를 꺼낸다"를 각자 두 줄씩 적고 있었다. 그 두 줄은 무엇을 등록 동작으로
 * 볼지의 판정이라, 동작 종류가 늘 때 한 자리에서만 고쳐지면 그 자리만 다른 집합을 본다 —
 * 형식 오류 없이 "검사는 지나갔는데 만들 때 빠진다"로 갈린다. 고르는 일을 여기 한 벌만
 * 두고, 세 자리는 워크플로 목록만 받는다.
 *
 * `activeActions`는 그대로 남는다 — 화면은 등록 말고도 다른 동작을 함께 그린다.
 */
export function activeWorkflows(card: AiaOnboardingCard, values: OnboardingValues): AiaOnboardingWorkflowTemplate[] {
  return activeActions(card, values)
    .flatMap((action) => (action.kind === "registerWorkflow" ? [action.workflow] : []));
}
