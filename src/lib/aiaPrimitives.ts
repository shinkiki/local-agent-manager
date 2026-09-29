/**
 * AIA 제안·사건·스킬 변경 모듈이 함께 쓰는 밑돌 — 시간 단위와, 영속 문자열을 상태로
 * 되돌릴 때의 JSON 검증 도우미.
 *
 * 이 값들은 어느 한 기능의 것이 아니라 세 모듈이 같은 규칙으로 읽어야 하는 것이라
 * 제안 평가 본문에서 떼어내 여기 모았다.
 *
 * 그 뒤 제안 메타데이터의 값 모양과 정렬 키까지 이 파일에 얹혀 있었다. 둘은 제안이라는
 * 한 기능의 것이라, 저장 되읽기만 필요한 모듈(`aiaEventBudget.ts`·`aiaSkillChanges.ts`)
 * 까지 제안 도메인을 아는 파일을 바라보게 만들었다. 밑돌이 한 기능을 알면 그 기능이
 * 자랄 때마다 밑돌을 읽는 모든 모듈이 함께 진다 — 제안의 것은 `aiaSuggestionOrder.ts`로
 * 옮겼고, 여기 남는 것은 어느 기능도 모르는 밑돌뿐이다.
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
  return mapRecord(value, (item, key) => (key ? requiredString(item) : null));
}

/**
 * 되읽기가 "없으면 항목을 버린다"로 취급하는 필수 문자열. 빈 문자열은 값이 없는 것과
 * 같게 본다 — 저장본이 빈 이름·빈 지문을 담고 있으면 그 항목은 쓸 수 없다.
 */
export function requiredString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * 되읽기가 요구하는 숫자 필드를 한 번에 확인한다. 하나라도 숫자가 아니면 null을 주므로
 * 호출부는 항목을 버리기만 하면 된다.
 *
 * 필드마다 `finiteNumber` 한 줄과 null 검사 한 줄을 쌓던 자리가 세 군데 있었고, 그중
 * 한 곳은 검사를 다섯 줄 뒤에 몰아 두어 새 필드를 더할 때 검사에서 빠뜨리기 쉬웠다.
 * 여기서는 키 목록에 이름을 더하는 것이 곧 검사에 더하는 것이다.
 */
export function requiredNumbers<K extends string>(
  entry: Record<string, unknown>,
  keys: readonly K[],
): Record<K, number> | null {
  const values = {} as Record<K, number>;
  for (const key of keys) {
    const value = finiteNumber(entry[key]);
    if (value === null) return null;
    values[key] = value;
  }
  return values;
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

