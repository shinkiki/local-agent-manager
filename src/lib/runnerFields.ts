/**
 * 실행기 편집기의 숫자 칸(동시 자리 수·브라우저 자리 수)이 함께 쓰는 판정.
 *
 * 둘 다 `type="number"` 칸이지만 브라우저는 `1e1`·`3.5` 같은 값을 그대로 넘긴다. `parseInt` 로
 * 받으면 `1e1`(=10)은 1, `3.5` 는 3 으로 저장돼 사용자가 본 값과 저장된 값이 달라진다.
 * 그래서 공백을 뺀 자리 전체가 숫자일 때만 값으로 받고, 그 밖에는 null 이다.
 */
export function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `parseWholeNumber` 가 받은 값이 `[min, max]` 안에 있는지. 값이 아니면 false 다. */
export function wholeNumberWithin(value: string, min: number, max: number): boolean {
  const parsed = parseWholeNumber(value);
  return parsed !== null && parsed >= min && parsed <= max;
}
