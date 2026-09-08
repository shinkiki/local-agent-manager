/**
 * 세션 참조 정책의 숫자 규칙 한 벌. 상한·기본값·자르기가 한 자리에 모여 있어야, 상한을
 * 읽는 쪽(정책 전체 다듬기)과 기간 선택지를 다듬는 쪽이 같은 규칙을 나눠 쓰면서도 서로를
 * 거쳐 가지 않는다 — 두 쪽이 서로를 import 하면 순환이 된다.
 */

/** 저장 가능한 상한. Rust MAX_SESSION_READ_* 와 같은 값이다. */
export const SESSION_READ_LIMITS = {
  maxSessions: 500,
  maxTurnsPerSession: 200,
  pageSize: 50,
  projects: 64,
  recentDays: 365,
  relativeCount: 24,
} as const;

/**
 * 값을 정하지 못했을 때 쓰는 숫자. 새 정책의 기본값이자, 저장된 값이 못 쓸 값일 때
 * 되돌아갈 자리이자, 기간 선택지를 바꿀 때 물려받을 값이 없으면 채우는 값이다.
 *
 * 세 자리가 같은 숫자를 각자 적어 두고 있었다. 셋은 같은 뜻인데 한 곳만 고치면 어긋난
 * 채로 조용히 돈다 — 예컨대 기본 최근 일수를 바꾸면 새 정책은 새 값으로 시작하는데,
 * 못 쓸 값이 저장돼 있던 정책과 `최근 N일`로 바꾼 정책만 옛 값으로 떨어졌다.
 */
export const SESSION_READ_DEFAULTS = {
  maxSessions: 50,
  maxTurnsPerSession: 40,
  pageSize: 20,
  recentDays: 7,
  relativeCount: 1,
} as const;

/**
 * 상한을 넘지 않는 1 이상의 정수로 맞춘다. 못 읽을 값은 같은 이름의 기본값으로 되돌리되,
 * 기본값도 상한을 넘지 않게 다시 한 번 자른다.
 */
export function clampSessionReadCount(
  value: number,
  name: keyof typeof SESSION_READ_DEFAULTS,
): number {
  const max = SESSION_READ_LIMITS[name];
  if (!Number.isFinite(value) || value <= 0) return Math.min(SESSION_READ_DEFAULTS[name], max);
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
