/**
 * 정본 목록에 들어 있는 값인지 묻는 판정을 만든다.
 *
 * 좁은 목록(공급자 식별자·화면 이름·팝아웃 종류)에 바깥에서 온 값이 들어 있는지 물으려면
 * 목록을 문자열로 한 번 넓혀 두어야 한다. 좁은 타입의 집합에 `unknown`을 그대로 물으면
 * 타입이 서지 않고, 물어보려던 값에 단언(`as T`)을 붙이면 판정이 무엇을 좁히는지가
 * 문장에서 사라진다 — 이미 맞다고 적어 둔 값을 다시 확인하는 꼴이 된다.
 *
 * 그 "문자열 집합으로 한 번 넓힌 뒤 단언 없이 조회한다"는 한 가지 요령이 세 자리에
 * 각각 적혀 있었다(`providerIds`·`navigationViews`·`popout`). 셋 다 같은 이유로 그 모양이고
 * 실제로 서로를 가리키는 주석까지 달려 있었는데, 그렇게 이유를 주석으로 묶어 두면 한 자리가
 * 요령을 바꿔도(예: 조회 전에 `typeof` 검사를 빠뜨려도) 나머지는 그대로 남는다. 요령을
 * 여기 한 벌만 두면 판정을 만드는 쪽은 정본 목록과 좁힐 타입만 적으면 된다.
 *
 * 좁힐 타입은 호출부가 이름으로 적는다. 목록에서 추론하지 않는 것은 팝아웃 종류처럼 목록이
 * `Object.keys`에서 오는 자리 때문이다 — 추론을 쓰려면 그 키 배열에 단언을 붙여야 하고,
 * 그러면 이 함수가 없애려던 단언이 호출부로 자리만 옮긴다. 이름을 적는 것은 지금도 각
 * 자리가 `value is T`로 하던 일과 같다.
 */
export function memberGuard<T extends string>(values: Iterable<string>): (value: unknown) => value is T {
  const members = new Set<string>(values);
  return (value: unknown): value is T => typeof value === "string" && members.has(value);
}
