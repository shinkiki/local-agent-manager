import type { ProviderId } from "../types";

/**
 * 세션 하나를 가리키는 지도·집합 키. 공급자마다 세션 ID 공간이 따로라 `source`를 함께
 * 봐야 하고, 이어 붙이는 구분자는 어느 공급자의 ID에도 들어갈 수 없는 NUL이라야 서로 다른
 * 두 세션이 같은 키로 겹치지 않는다.
 *
 * 목록 중복 제거·정리폴더 세션 수·색인 포기 목록이 각자 같은 문자열을 만들어 쓰고 있었다.
 * 한쪽만 형식을 바꾸면 어긋난 채로 조용히 도는 값이라 여기 한 곳에서 정한다.
 */
export function sessionKey(source: ProviderId, id: string): string {
  return `${source}\u0000${id}`;
}
