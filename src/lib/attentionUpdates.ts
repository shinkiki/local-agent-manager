/**
 * V4. 알림 목록의 낙관적 조작과 폴링이 공유하는 갱신 순서.
 * 조작 전에 시작한 폴링과 뒤늦게 끝난 이전 조작은 화면을 되돌리지 않는다.
 * 실패한 조작은 롤백하지 않고 다음 폴링이 서버 상태로 맞추게 둔다.
 */
export function createAttentionUpdates() {
  let revision = 0;
  let pending = 0;

  return {
    pollGuard() {
      const captured = revision;
      return () => pending === 0 && revision === captured;
    },
    mutate<T>(
      optimistic: () => void,
      request: () => Promise<T>,
      apply: (next: T) => void,
    ): Promise<boolean> {
      revision += 1;
      pending += 1;
      const captured = revision;
      optimistic();
      return request()
        .then((next) => {
          if (revision === captured) apply(next);
          return true;
        })
        .catch(() => false)
        .finally(() => { pending -= 1; });
    },
  };
}
