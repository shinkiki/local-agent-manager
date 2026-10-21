/**
 * 백엔드 응답 본문을 JSON으로 읽는다. 본문이 비었거나 JSON이 아니면 null이다 — 오류
 * 응답은 문구 없이 상태 코드만 줄 수 있고, 그때 부르는 쪽이 기본 문구로 떨어진다.
 *
 * 단 **제한시간 중단은 null이 아니다.** 헤더가 온 뒤 본문을 읽는 사이에 신호가 끊기면
 * `json()`은 중단 오류로 거절되는데, 그것까지 null로 삼키면 시간 초과가 "본문 없는
 * 성공"이 된다 — 명령 POST는 `null`을 성공 값으로 돌려주고, 접근 상태 조회는 버전이
 * 없는 응답으로 읽어 "API 버전이 호환되지 않습니다"라는 엉뚱한 원인을 띄웠다. 그래서
 * 신호가 끊긴 경우에는 원래 오류를 다시 던지고, 무엇으로 알릴지는 호출부가 정한다.
 */
export async function readJsonPayload<T>(response: Response, signal?: AbortSignal): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return null;
  }
}
