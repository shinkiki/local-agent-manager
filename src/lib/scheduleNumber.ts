/**
 * 반복 요청 편집기의 범위가 정해진 숫자 칸(간격·시·분). 일반 반복 요청과 페이싱 회차 두
 * 편집기가 같은 칸을 갖는데, 한쪽만 이 규칙을 따르고 있어 페이싱 쪽은 칸을 비우는 순간
 * 0이 끼어들고 범위 밖 시각(25시)이 그대로 저장으로 갔다. 규칙을 한 곳에 둔다.
 */
export interface ScheduleNumberBounds {
  min: number;
  max: number;
}

// 주기 숫자 칸의 허용 범위. 백엔드가 받는 값과 같다(간격은 시간 단위, 실행 시각은 시·분) —
// 공유된 정의가 아니라 옮겨 적은 값이므로 백엔드 범위가 바뀌면 여기도 고친다.
export const INTERVAL_HOURS: ScheduleNumberBounds = { min: 1, max: 168 };
export const RUN_HOUR: ScheduleNumberBounds = { min: 0, max: 23 };
export const RUN_MINUTE: ScheduleNumberBounds = { min: 0, max: 59 };

/**
 * 숫자 칸 초안을 범위 안 정수로 되돌린다. 칸은 문자열 초안으로 들고 있다가 칸을 떠날 때와
 * 저장할 때만 여기로 자른다 — 치는 도중에 Number("")를 담으면 지운 칸에 0이 끼어들어 다시 친
 * 값이 열 배가 된다(QA #33). 빈 칸·숫자 아님은 하한으로 떨어진다.
 */
export function clampScheduleNumber(raw: string, bounds: ScheduleNumberBounds): number {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)));
}
