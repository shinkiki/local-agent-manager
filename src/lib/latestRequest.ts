/**
 * "마지막 요청만 반영한다"는 문. `begin()`이 돌려준 확인 함수는 다음 `begin()`이 불리기
 * 전까지만 참이다. 같은 읽기를 효과와 버튼이 함께 부르는 자리처럼, 효과 정리(cleanup)
 * 깃발로는 앞선 호출을 무효로 만들 수 없는 곳에서 늦게 도착한 응답을 버리는 데 쓴다.
 */
export interface LatestGate {
  begin(): () => boolean;
}

export function createLatestGate(): LatestGate {
  let current = 0;
  return {
    begin() {
      current += 1;
      const mine = current;
      return () => mine === current;
    },
  };
}
