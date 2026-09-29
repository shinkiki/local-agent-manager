/**
 * 세션 목록의 표시 순서. 어떤 순서로 볼지를 화면에서 떼어 내 테스트로 고정한다.
 */

/**
 * 즐겨찾기를 먼저 올린다. 두 묶음에 들어온 순서대로 담아 백엔드가 준 최신순을 그대로
 * 남기고, 즐겨찾기 여부만으로 전체 목록을 비교 정렬하지 않는다.
 */
export function orderSessionsForList<T extends { meta: { favorite: boolean } }>(sessions: readonly T[]): T[] {
  const favorites: T[] = [];
  const others: T[] = [];
  for (const session of sessions) {
    (session.meta.favorite ? favorites : others).push(session);
  }
  return favorites.concat(others);
}
