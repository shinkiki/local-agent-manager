/**
 * AIA 사건의 발송 예산. `aiaEvents.ts`가 "무엇이 새로 나빠졌는가"를 정하는 동안 여기서는
 * "그것을 사용자에게 몇 번까지 알릴 것인가"만 다룬다.
 *
 * 두 관심사는 보는 것부터 다르다 — 감지는 스냅샷 두 판을 견주고, 예산은 발송 시각 목록
 * 하나만 본다. 스냅샷을 전혀 모르는 롤링 창 계산이 사건 기준선과 한 파일에 있으면,
 * 사건 종류를 하나 더할 때마다 관계없는 발송 간격·창 크기를 지나쳐 읽어야 하고 반대로
 * 발송 규칙을 손볼 때는 기준선 조립 사이에서 이 네 함수를 찾아야 한다.
 *
 * 저장 형식은 `dispatches` 배열 하나뿐이고 스키마 판 검사를 하지 않는다. 시각 목록은
 * 판이 갈릴 것이 없고, 깨진 값은 `numberList`가 항목 단위로 버린다.
 */
import { DAY, HOUR, numberList, parsePersisted } from "./aiaPrimitives.ts";

export interface AiaEventBudget {
  dispatches: number[];
}

export function emptyAiaEventBudget(): AiaEventBudget {
  return { dispatches: [] };
}

export function parseAiaEventBudget(value: string | null | undefined): AiaEventBudget {
  return parsePersisted(value, emptyAiaEventBudget, null, (parsed) => ({ dispatches: numberList(parsed.dispatches) }));
}

export function serializeAiaEventBudget(budget: AiaEventBudget): string {
  return JSON.stringify({ dispatches: [...budget.dispatches].filter(Number.isFinite).sort((a, b) => a - b) });
}

/** 지금 시각 기준으로 롤링 창 안에 있는 발송 시각만 남긴다. 미래·비수치 값은 버린다. */
function dispatchesInWindow(budget: AiaEventBudget, now: number, rollingWindowMs: number): number[] {
  return budget.dispatches.filter((at) => Number.isFinite(at) && at <= now && now - at < rollingWindowMs);
}

export function canDispatchAiaEvent(
  budget: AiaEventBudget,
  now: number,
  minimumIntervalMs = 6 * HOUR,
  maximumPerWindow = 2,
  rollingWindowMs = DAY,
): boolean {
  const dispatches = dispatchesInWindow(budget, now, rollingWindowMs);
  const latest = Math.max(Number.NEGATIVE_INFINITY, ...dispatches);
  return dispatches.length < maximumPerWindow && now - latest >= minimumIntervalMs;
}

export function recordAiaEventDispatch(budget: AiaEventBudget, now: number, rollingWindowMs = DAY): AiaEventBudget {
  return { dispatches: [...dispatchesInWindow(budget, now, rollingWindowMs), now].sort((left, right) => left - right) };
}
