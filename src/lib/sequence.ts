/**
 * 배열 한 벌을 다루는 순수 규칙. 화면 여러 곳이 같은 규칙을 각자 적어 두면, 한쪽만
 * 형식을 바꿔도 어긋난 채로 조용히 도는 값이 되므로 규칙은 여기 한 곳에서 정한다.
 */

/**
 * 처음 나온 것만 남기고 순서를 지키는 중복 제거.
 *
 * 저장 전 정책 다듬기·요청 기록·세션 메타 세 곳이 각자 다른 방식으로 같은 일을 하고
 * 있었다. 그중 `indexOf` 비교는 값 개수의 제곱만큼 훑어, 프로젝트 64개·상태 9개처럼
 * 상한이 있는 목록에서도 저장 버튼을 누를 때마다 헛일을 되풀이했다. `Set`은 한 번
 * 훑으면 끝나고, 순서를 지키는 것은 삽입 순서를 유지하는 `Set`의 성질이 보장한다.
 *
 * 순서를 지키는 것이 규칙의 일부다 — 프로젝트·공급자·상태 목록은 사용자가 고른 순서가
 * 그대로 요약 문구와 저장본에 남으므로, 정렬해 버리면 화면이 흔들린다.
 */
export function uniqueInOrder<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * 열쇠가 같은 항목을 하나만 남긴다. 먼저 온 항목이 이기고, 뒤에 온 항목이 `prefers`에
 * 걸릴 때만 그 자리를 새 값으로 바꾼다. 남는 항목의 자리는 그 열쇠가 처음 나온 자리다.
 *
 * 세션 목록 중복 제거와 색인 대상 모으기가 같은 다섯 줄(지도를 세우고, 열쇠를 만들고,
 * 있는 값과 견주고, 넣고, 값만 편다)을 각자 적고 있었다. 한쪽은 남길 항목을 고르는 규칙을
 * 조건문으로 끼워 넣고 다른 한쪽은 무조건 덮어써, "열쇠가 겹칠 때 누가 남는가"가 두
 * 모양으로 흩어져 있었다 — 목록 자리를 지키는 것이 `Map` 삽입 순서에 기대는 규칙이라는
 * 설명도 한쪽에만 적혀 있었다. 열쇠와 취사선택만 호출부가 정하면, 자리를 지키는 규칙은
 * 여기 한 줄로 남는다.
 *
 * 기본값이 "먼저 온 항목이 이긴다"인 것은 규칙의 일부다 — 열쇠에서 값이 온전히 정해지는
 * 목록은 어느 쪽을 남겨도 같으므로, 고를 것이 없는 호출부가 취사선택을 적지 않게 한다.
 */
export function dedupeByKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  prefers: (candidate: T, current: T) => boolean = () => false,
): T[] {
  const kept = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    const current = kept.get(key);
    // 있는 키를 다시 설정해도 `Map`의 삽입 순서는 그대로라 최초 목록 위치를 지킨다.
    if (current === undefined || prefers(value, current)) kept.set(key, value);
  }
  return [...kept.values()];
}

/**
 * 숫자 순위표를 앞자리부터 견주는 내림차순 비교. 앞자리가 갈리면 거기서 끝내고, 같을
 * 때만 다음 자리를 본다. `Array.prototype.sort`에 그대로 넘길 수 있는 부호를 돌려준다.
 *
 * "더 최근·더 많은 쪽을 앞으로"는 목록 정렬과 중복 제거가 함께 쓰는 규칙인데, 한쪽은
 * 뺄셈을 `||`로 이어 적고 다른 쪽은 색인 루프를 손으로 돌리고 있었다. 두 벌은 같은 뜻인데
 * 자리 수를 하나 늘리는 방법이 서로 달라, 순위 기준을 손볼 때 두 모양을 각각 읽어야 했다.
 *
 * 뺄셈 대신 부등호로 가르는 것은 규칙의 일부다 — 값이 없는 자리를 `-Infinity`로 채우는
 * 호출부가 있어서, 뺄셈으로 적으면 두 자리가 모두 무한대일 때 NaN이 나와 부호가 사라진다.
 * 어느 쪽도 크지 않은 자리(같거나 비교할 수 없는 값)는 다음 자리로 넘긴다.
 */
export function compareRankDesc(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return -1;
    if (right[index] > left[index]) return 1;
  }
  return 0;
}

/**
 * 점수가 있는 항목 중 가장 큰 첫 항목. null 점수는 후보에서 제외한다.
 *
 * 최신 세션 알림과 자동정리 영수증의 대표 사유가 각각 같은 단일 순회를 적고 있었다.
 * 둘 다 동률이면 먼저 온 항목을 남겨야 하므로 정렬하지 않고, 더 큰 점수에서만 교체한다.
 */
export function maxByScore<T>(
  values: readonly T[],
  score: (value: T) => number | null,
): T | null {
  let selected: T | null = null;
  let selectedScore = 0;
  for (const value of values) {
    const candidateScore = score(value);
    if (candidateScore === null) continue;
    if (selected !== null && candidateScore <= selectedScore) continue;
    selected = value;
    selectedScore = candidateScore;
  }
  return selected;
}

/**
 * 조각 목록에서 빈 조각을 걷어내고 남은 것만 구분자로 잇는다. 넣을지 말지가 조각마다
 * 다른 문구는 조건을 조각 자리에 그대로 적어 두고(`조건 && "문구"`) 여기서 한 번에
 * 걷어내면, 무엇이 언제 보이는지가 조각과 같은 줄에 남는다.
 *
 * 정리 영수증·미리보기와 세션 참조 요약이 각자 같은 규칙을 적고 있었다. 세 곳 모두
 * "거짓값을 버리고 남은 문자열만 잇는다"는 한 문장인데, 타입 술어가 붙은 `filter` 한 줄을
 * 파일마다 다시 적고 그 이유까지 따로 적어 두어, 빈 조각의 기준을 손보려면 같은 줄을
 * 세 곳에서 찾아 고쳐야 했다.
 */
export function joinParts(
  parts: readonly (string | false | null | undefined)[],
  separator: string,
): string {
  return parts.filter((part): part is string => Boolean(part)).join(separator);
}

/**
 * 카드 한 줄 요약의 구분자. 자동정리 미리보기·영수증, 세션 참조 정책 요약, 예약 워크플로
 * 표기가 모두 이 모양으로 조각을 잇는다.
 */
export const SUMMARY_SEPARATOR = " · ";

/**
 * 조각을 이 구분자로 이어 만드는 한 줄 요약. 조건에 걸리지 않는 조각은 거짓값으로 남겨
 * 두면 빠진다.
 *
 * 같은 구분자를 세 파일이 각자 적고 있었다 — 한 곳은 상수로 두고 `joinParts`에 넘기고,
 * 한 곳은 `joinParts` 호출마다 리터럴을 적고, 한 곳은 템플릿 문자열 안에 직접 박아 두고
 * 조각이 없을 때를 삼항으로 갈랐다. 셋은 같은 화면 언어인데 모양이 달라, 구분자를 손보려면
 * 서로 다른 세 모양을 찾아 고쳐야 했고 그중 하나만 남아도 카드마다 표기가 어긋난다.
 */
export function joinSummary(parts: readonly (string | false | null | undefined)[]): string {
  return joinParts(parts, SUMMARY_SEPARATOR);
}

/**
 * 지도에서 키에 달린 값을 꺼내되, 아직 없으면 `create()`로 만들어 넣고 그것을 돌려준다.
 * 항상 값이 있으므로 호출부는 "없으면 만든다"를 매번 다시 적지 않고 값을 바로 쌓을 수 있다.
 *
 * 폴더별 세션 집합·상위별 하위 폴더 목록·최근 모델 집계 세 곳이 같은 일을 각자 다른 모양으로
 * 적고 있었다. 두 곳은 `get` → `if (!bucket)` → `new`·`set` 네 줄을 쌓았고, 한 곳은 있을 때와
 * 없을 때를 `continue`로 갈라 값 갱신을 두 갈래에 나눠 적었다. 셋은 같은 한 문장인데 모양이
 * 달라, 빈 값을 무엇으로 시작할지 같은 규칙을 손보려면 서로 다른 세 모양을 찾아야 했다.
 *
 * `get`이 `undefined`를 돌려준 것과 값이 실제로 `undefined`인 것을 섞지 않도록 `has`로 가른다 —
 * 값이 `undefined`를 담을 수 있는 지도에서도 없는 키만 새로 만든다.
 */
export function bucketFor<K, V>(buckets: Map<K, V>, key: K, create: () => V): V {
  if (buckets.has(key)) return buckets.get(key) as V;
  const created = create();
  buckets.set(key, created);
  return created;
}
