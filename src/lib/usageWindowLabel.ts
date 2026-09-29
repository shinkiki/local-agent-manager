/**
 * 사용량 창 라벨의 문법. 공급자는 창 라벨을 "7일", "Fable 7일", "5시간"처럼 실제 창
 * 길이로 만들므로(Codex Team은 primary가 7일일 수 있다) 고정 문자열이 아니라 라벨 끝의
 * `N일`·`N시간`·`N분`·`N주`로 읽는다. 백엔드 `usage_budget_policy::window_label_minutes`와
 * 같은 규칙이라 이력의 주기 길이와 현재 창의 길이가 같은 단위로 맞는다.
 *
 * 이 문법을 아는 곳은 여기 하나다 — 주기 단위를 보는 곳(계정별 주간 행)과 길이를 재는
 * 곳(월 구간 누적 소비율)이 각자 정규식을 들고 있으면 공급자가 라벨 모양을 바꿀 때
 * 한쪽만 따라가게 된다. 그 두 쓰임이 서로 읽을 것이 없어 모듈이 갈린 뒤에도 문법만은
 * 한 벌로 남아야 하므로, 어느 한쪽에 얹지 않고 둘이 함께 읽는 자리에 둔다.
 *
 * 백엔드와 갈라져 있던 세 자리를 맞췄다. 백엔드는 꼬리의 비숫자를 통째로 단위로 떼어
 * `trim`한 뒤 읽으므로 `주`와 `7 일`처럼 사이가 벌어진 라벨을 모두 받고, 값이 0이면
 * 아예 창으로 세지 않는다. 창 라벨은 예산 화면에서 사용자가 손으로 적는 자유 입력이라
 * (`UsageBudgetPanel`) 세 모양 모두 실제로 저장된다. 프런트만 못 읽으면 백엔드가 주기로
 * 세는 창이 주간 행에서 사라지고 월 누적 소비율의 현재 창에서도 빠지는데, 화면에는
 * 아무 표시가 남지 않는다.
 */

/**
 * 숫자와 단위 사이의 공백을 허용한다. 백엔드는 꼬리의 비숫자를 단위로 떼어 `trim`하므로
 * `7 일`을 7일로 읽는다. 여기서 공백을 빼면 같은 라벨이 프런트에서만 없는 창이 된다.
 */
const USAGE_WINDOW_LABEL_PATTERN = /(\d+)\s*(일|시간|분|주)$/u;

/** 단위별 길이(ms). 백엔드 `window_label_minutes`가 아는 네 단위와 같은 목록이다. */
export const USAGE_WINDOW_UNIT_MS = {
  일: 86_400_000,
  시간: 3_600_000,
  분: 60_000,
  주: 7 * 86_400_000,
} as const;

type UsageWindowUnit = keyof typeof USAGE_WINDOW_UNIT_MS;

/** 하루 단위로 리셋되는 창의 단위. 5시간 창은 여기서 빠진다. */
const DAY_SCALE_UNITS: readonly UsageWindowUnit[] = ["일", "주"];

/**
 * 라벨에서 개수와 단위를 읽는다. 백엔드처럼 0 이하는 창으로 세지 않으므로 여기서 함께
 * 떨어뜨린다 — 주간 창인지 묻는 쪽과 길이를 묻는 쪽이 0을 다르게 판정하면, 주간 행에는
 * 서는데 누적 소비율에서는 빠지는 창이 생긴다.
 */
function parseUsageWindowLabel(label: string): { count: number; unit: UsageWindowUnit } | null {
  const match = USAGE_WINDOW_LABEL_PATTERN.exec(label.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  return { count, unit: match[2] as UsageWindowUnit };
}

/** 일 단위로 초기화되는 사용량 창인지. 5시간 창은 여기서 빠진다. */
export function isWeeklyUsageWindow(label: string): boolean {
  const unit = parseUsageWindowLabel(label)?.unit;
  return unit !== undefined && DAY_SCALE_UNITS.includes(unit);
}

/** 창 라벨에서 주기 길이(ms)를 읽는다. 길이가 0 이하면 주기로 쓸 수 없어 null이다. */
export function usageWindowLengthMs(label: string): number | null {
  const parsed = parseUsageWindowLabel(label);
  if (!parsed) return null;
  return parsed.count * USAGE_WINDOW_UNIT_MS[parsed.unit];
}
