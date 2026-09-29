import type { SessionReadPolicy } from "../types";

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

/**
 * 정책이 직접 들고 있는 숫자 항목의 이름. 새 정책을 만들 때 채울 값과 저장 전에 자를 값이
 * 같은 목록이므로 여기 한 벌만 둔다.
 *
 * 두 자리가 세 이름을 각자 손으로 적고 있었다. 기본값 쪽은 `SESSION_READ_DEFAULTS.X`를
 * 세 줄, 자르기 쪽은 `clampSessionReadCount(policy.X, "X")`를 세 줄 늘어놓아, 항목이 하나
 * 늘면 두 곳을 같은 순서로 고쳐야 했다. 자르기 쪽만 빠뜨리면 상한을 넘는 값이 그대로 저장
 * 요청에 실려 나가는데, 서버가 다시 자르므로 화면에는 아무 표시가 남지 않는다 — 저장한
 * 값과 다시 읽은 값이 다른 것을 사용자가 눈으로 발견해야 드러난다.
 *
 * 기간에 딸린 숫자(`recentDays`·`relativeCount`)는 여기 없다. 그 둘은 정책이 아니라 기간
 * 종류가 들고 있어 `clampSessionReadPeriod`가 종류별로 자른다.
 */
export const SESSION_READ_COUNT_KEYS = [
  "maxSessions",
  "maxTurnsPerSession",
  "pageSize",
] as const satisfies readonly (keyof SessionReadPolicy & keyof typeof SESSION_READ_DEFAULTS)[];

export type SessionReadCountKey = (typeof SESSION_READ_COUNT_KEYS)[number];

type SessionReadCounts = Record<SessionReadCountKey, number>;

/** 목록의 이름마다 값을 하나씩 정해 한 벌로 묶는다. 표를 편 결과가 목록을 모두 덮는다. */
function mapCountKeys(pick: (key: SessionReadCountKey) => number): SessionReadCounts {
  return Object.fromEntries(
    SESSION_READ_COUNT_KEYS.map((key) => [key, pick(key)]),
  ) as SessionReadCounts;
}

/** 새 정책이 시작할 숫자 한 벌. 상한은 기본값 쪽이 이미 지키므로 여기서 자르지 않는다. */
export function defaultSessionReadCounts(): SessionReadCounts {
  return mapCountKeys((key) => SESSION_READ_DEFAULTS[key]);
}

/** 저장 전에 상한을 맞춘 숫자 한 벌. 항목마다 자기 이름의 상한과 기본값을 본다. */
export function clampSessionReadCounts(counts: SessionReadCounts): SessionReadCounts {
  return mapCountKeys((key) => clampSessionReadCount(counts[key], key));
}
