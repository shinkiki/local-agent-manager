/**
 * AIA 제안·사건·스킬 변경 모듈이 함께 쓰는 밑돌 — 시간 단위와, 영속 문자열을 상태로
 * 되돌릴 때의 JSON 검증 도우미.
 *
 * 이 값들은 어느 한 기능의 것이 아니라 세 모듈이 같은 규칙으로 읽어야 하는 것이라
 * 제안 평가 본문에서 떼어내 여기 모았다.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * 영속 문자열을 상태로 되돌리는 세 파서(제안 이력·스킬 변경·이벤트 예산)의 공통 껍데기.
 *
 * 빈 값, 깨진 JSON, 레코드가 아닌 최상위, 맞지 않는 스키마 판은 모두 빈 상태로 떨어뜨리고
 * `read`는 필드 검증만 맡는다. `schemaVersion`이 null이면 판 검사를 건너뛴다.
 */
export function parsePersisted<T>(
  value: string | null | undefined,
  empty: () => T,
  schemaVersion: number | null,
  read: (parsed: Record<string, unknown>) => T,
): T {
  if (!value) return empty();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return empty();
    if (schemaVersion !== null && parsed.schemaVersion !== schemaVersion) return empty();
    return read(parsed);
  } catch {
    return empty();
  }
}

/**
 * 되읽기 도우미 여섯 벌이 각자 펼쳐 놓던 순회를 모은 두 벌. 레코드든 배열이든 하는 일이
 * "최상위 모양을 확인하고, 항목마다 옮겨 보고, 옮겨지지 않은 항목을 버린다"로 같았고
 * 다른 것은 항목 하나를 어떻게 옮기는지뿐이었다. 순회가 여섯 벌로 흩어져 있으면
 * 빈 키·비배열 입력 같은 가장자리 처리가 한쪽에서만 고쳐진다.
 *
 * `read`는 옮길 수 없는 항목에 null을 준다. 키를 함께 받는 것은 문자열 레코드가 빈 키를
 * 버리기 때문이다 — 그 판단까지 순회로 끌어올리면 나머지 레코드의 동작이 바뀐다.
 */
function mapRecord<T>(value: unknown, read: (item: unknown, key: string) => T | null): Record<string, T> {
  if (!isRecord(value)) return {};
  const result: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = read(item, key);
    if (parsed !== null) result[key] = parsed;
  }
  return result;
}

function mapList<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const item of value) {
    const parsed = read(item);
    if (parsed !== null) result.push(parsed);
  }
  return result;
}

/** 레코드의 각 항목을 `read`로 검증해 null이 아닌 것만 남긴다. */
export function validatedRecord<T>(value: unknown, read: (entry: Record<string, unknown>) => T | null): Record<string, T> {
  return mapRecord(value, (item) => (isRecord(item) ? read(item) : null));
}

/** 배열의 각 항목을 `read`로 검증해 null이 아닌 것만 순서대로 남긴다. */
export function validatedList<T>(value: unknown, read: (entry: Record<string, unknown>) => T | null): T[] {
  return mapList(value, (item) => (isRecord(item) ? read(item) : null));
}

export function numberList(value: unknown): number[] {
  return mapList(value, finiteNumber);
}

export function uniqueStrings(value: unknown): string[] {
  return [...new Set(mapList(value, (item) => (typeof item === "string" ? item : null)))];
}

export function stringRecord(value: unknown): Record<string, string> {
  return mapRecord(value, (item, key) => (key && typeof item === "string" && item ? item : null));
}

export function numericRecord(value: unknown): Record<string, number> {
  return mapRecord(value, finiteNumber);
}

/**
 * 정의가 준 값이 숫자가 아니면 기본값을, 숫자면 허용 범위로 자른 값을 준다. 규칙 평가와
 * 프로젝트 정리 규칙이 같은 파라미터 읽기 규칙을 써야 하므로 여기 한 벌만 둔다.
 */
export function clampedNumber(
  source: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = finiteNumber(source?.[key]);
  return value === null ? fallback : Math.min(maximum, Math.max(minimum, value));
}

/** 개수·상한처럼 정수여야 하는 값. 범위로 자른 뒤 소수를 버린다. */
export function clampedInteger(
  source: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.floor(clampedNumber(source, key, fallback, minimum, maximum));
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
