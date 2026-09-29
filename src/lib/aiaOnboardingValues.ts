/**
 * 온보딩 카드가 모은 값 자체를 다루는 밑돌 — 칸 하나를 어떻게 읽고, 문구의 `{{key}}`를
 * 어떻게 채우고, 보임 조건을 어떻게 견주는가.
 *
 * 이 셋은 카드가 무엇을 묻는지도, 마지막에 무엇이 만들어지는지도 모른다. 그런데
 * 조립(`aiaOnboarding.ts`)과 병렬 실행 입력(`aiaOnboardingParallel.ts`) 양쪽이 모두
 * 이 셋을 쓰므로, 한쪽에 두면 다른 쪽이 그 쪽 모듈을 통째로 바라보게 되고 두 모듈이
 * 서로를 가리키는 참조가 생긴다. 어느 쪽도 모르는 밑돌만 여기 따로 세운다.
 */
import type { AiaOnboardingCondition } from "../types";

/** 카드가 모은 값. 모든 입력은 문자열로 들고 있다가 조립할 때만 형을 맞춘다. */
export type OnboardingValues = Record<string, string>;

/**
 * 모은 값 하나를 앞뒤 공백을 걷어 읽는다. 비어 있으면 기본값이고, 기본값을 주지 않으면
 * 빈 문자열이다 — 칸이 없는 것과 비워 둔 것을 가르지 않는다(둘 다 "적지 않았다"다).
 */
export function textValue(values: OnboardingValues, key: string, fallback = ""): string {
  return (values[key] ?? "").trim() || fallback;
}

/** `{{key}}` 자리를 모은 값으로 바꾼다. 로드에서 이미 검증한 이름만 남아 있다(W6-4). */
export function fillTemplate(template: string, values: OnboardingValues): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

/** 조건이 없으면 늘 보인다. 있으면 등가 비교 하나뿐이다. */
export function conditionHolds(condition: AiaOnboardingCondition | null | undefined, values: OnboardingValues): boolean {
  if (!condition) return true;
  return (values[condition.field] ?? "") === condition.equals;
}

/**
 * 회차가 따를 절차를 가리키는 문구. 이름과 **절대 경로**를 함께 적는다 — 만들어진 원본은
 * 아직 어느 공급자에도 배포돼 있지 않아, 이름만으로는 실행 환경에서 찾을 수 없다.
 *
 * 계약 조립과 레인 서문이 둘 다 같은 문구를 적으므로 두 모듈이 함께 보는 밑돌에 둔다.
 */
export function skillPointer(key: string, skillsRoot: string): string {
  return skillsRoot ? `${key} 스킬(${skillsRoot}/${key}/SKILL.md)` : `${key} 스킬`;
}
