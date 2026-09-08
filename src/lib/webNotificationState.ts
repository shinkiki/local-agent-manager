/**
 * polling 스냅샷 사이의 "새로 나타난 항목" 판정. 알림 종류마다 비교 키만 다르고
 * 기준선 보관과 차집합은 같으므로, 키 함수만 받아 한자리에서 처리한다.
 */

type AttentionStateItem = {
  id: string;
  kind: string;
};

/** 알림 상태 항목의 비교 키. 같은 ID라도 종류가 바뀌면 다른 상태로 본다. */
export function attentionStateKey(item: AttentionStateItem): string {
  return `${item.id}\u0000${item.kind}`;
}

/** 이번 스냅샷의 키 집합. 다음 호출의 기준선으로 그대로 보관한다. */
export function snapshotKeys<T>(items: readonly T[], keyOf: (item: T) => string): Set<string> {
  return new Set(items.map(keyOf));
}

/**
 * 직전 기준선에 없던 항목만. running -> completed처럼 같은 ID의 상태 전환도
 * 키가 달라지므로 새 항목으로 잡힌다.
 */
export function freshItems<T>(
  items: readonly T[],
  previous: ReadonlySet<string>,
  keyOf: (item: T) => string,
): T[] {
  return items.filter((item) => !previous.has(keyOf(item)));
}
