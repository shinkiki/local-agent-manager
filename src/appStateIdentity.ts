/**
 * 폴링이 같은 내용을 다시 가져왔을 때 state 참조를 그대로 두는 판정.
 *
 * App과 알림 센터가 함께 쓰므로 어느 한쪽에 둘 수 없다. 둘 중 한 파일이 가지고 있으면
 * 다른 쪽이 화면 조립 파일을 거꾸로 import하게 되고, 그건 참조 유지 규칙 하나를 쓰려고
 * 모듈 그래프에 고리를 만드는 일이다.
 */

// 폴링 응답 내용이 같으면 기존 state 참조를 유지해, 마운트된(숨겨진) 뷰 전체가 매 폴링마다 재조정되는 것을 막는다.
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 위 판정을 그대로 쓰는 setState 갱신자. 내용이 같으면 현재 참조를, 다르면 새 값을 올린다.
 * `replace`는 내용이 같아도 다시 그려야 하는 경우(예: 경과 시간 표시)에 쓴다.
 */
export function keepIfSame<T>(next: T, replace = false): (current: T | null) => T {
  return (current) => (current && !replace && sameJson(current, next) ? current : next);
}
