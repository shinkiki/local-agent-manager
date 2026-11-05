import { errorText } from "./errorText.ts";

/**
 * 화면을 떠난 뒤 늦게 도착한 응답은 버리는 조회 한 건.
 *
 * 설정 화면의 카드들은 상태 조회마다 `let disposed = false`를 세우고, then·catch 양쪽에서
 * 그 깃발을 확인하고, effect 정리에서 내리는 껍데기를 똑같이 되풀이했다. 껍데기만 여기로
 * 모은다 — 무엇을 읽고 어디에 적을지, 실패를 어느 자리에 남길지는 부르는 쪽이 그대로 정한다.
 *
 * 돌려주는 함수가 그 깃발을 내리는 정리 함수라 `useEffect`가 그대로 반환하면 된다. 조회를
 * 여러 건 걸었으면 반환받은 함수들을 모아 한 번에 부른다.
 */
export function loadWhileMounted<T>(
  fetchStatus: () => Promise<T>,
  apply: (value: T) => void,
  fail?: (message: string) => void,
): () => void {
  let disposed = false;
  void fetchStatus()
    .then((next) => { if (!disposed) apply(next); })
    .catch((cause) => { if (!disposed) fail?.(errorText(cause)); });
  return () => { disposed = true; };
}
