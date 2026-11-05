/**
 * 예산 화면의 숫자 칸 해석과 범위 보정. 화면 컴포넌트 안에 묶여 있어 시험이 닿지 않았으므로
 * 순수 함수만 여기로 옮겨 `usageBudgetFields.test.mjs`로 고정한다. 동작은 옮기기 전과 같다.
 */

/**
 * 숫자 칸 하나를 읽는다. 이 화면의 숫자 입력 다섯 자리가 "trim → 빈 값 처리 → `Number` →
 * `Number.isFinite` 확인"이라는 같은 네 줄을 각자 적고 있었고, 진짜로 다른 것은 빈 칸을
 * 무엇으로 볼지(캡 없음은 `null`, 상한 해제와 우선순위는 `0`) 하나뿐이었다. 그 하나만
 * 인자로 받고 나머지는 여기서 한 번만 적는다. 숫자가 아니면 언제나 `null`이라 호출부는
 * "고치지 않고 돌아간다"는 판단을 그대로 유지한다.
 */
export function parseNumberField(raw: string, whenEmpty: number | null): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return whenEmpty;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 백분율은 화면에서도 저장에서도 0~100 밖으로 나가지 않는다. 입력 보정과 막대 그리기가 같은 규칙을 봐야 한다. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** 빈 입력은 "캡 없음"(null), 숫자는 0~100으로 잘라 보낸다. */
export function parsePercent(raw: string): number | null {
  const value = parseNumberField(raw, null);
  return value === null ? null : clampPercent(value);
}

/**
 * 기준선 회차 수의 허용 범위. 백엔드가 1~32 밖을 거절하므로(usage_budget_policy.rs) 저장
 * 경로와 화면 보정이 같은 규칙을 봐야 한다 — 한쪽만 자르면 조용히 다른 값이 저장된다.
 */
export function clampBaselineRuns(value: number): number {
  return Math.min(32, Math.max(1, Math.round(value)));
}

/** 빈 입력은 미입력(null). 범위는 저장할 때 자르므로 여기서는 자르지 않는다. */
export function parseCount(raw: string): number | null {
  return parseNumberField(raw, null);
}
