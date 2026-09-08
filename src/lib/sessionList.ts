/**
 * 세션 목록의 표시 순서. 어떤 순서로 볼지를 화면에서 떼어 내 테스트로 고정한다.
 */

/**
 * 즐겨찾기를 먼저 올린다. 그 안의 순서는 백엔드가 준 최신순 그대로 남기므로, 정렬 기준을
 * 한 곳에 두 번 적지 않는다(JS의 sort는 안정 정렬이다).
 */
export function orderSessionsForList<T extends { meta: { favorite: boolean } }>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => Number(right.meta.favorite) - Number(left.meta.favorite));
}
