import { formatDate } from "./format.ts";

/** 반복 요청이 예약 실행을 내보내는 절대 구간. 둘 다 비면 제한이 없다. */
export interface ActiveWindow {
  activeFrom?: number | null;
  activeUntil?: number | null;
}

/**
 * datetime-local 입력이 쓰는 로컬 시각 문자열로 바꾼다. 저장값은 절대 시각(epoch ms)
 * 이고 입력은 브라우저 로컬 시간대로 읽히므로, 시간대 차이를 빼고 ISO 앞부분만 남긴다.
 */
export function toDatetimeLocalValue(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return "";
  const local = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** datetime-local 입력값을 절대 시각으로 되돌린다. 비어 있으면 제한 없음이다. */
export function fromDatetimeLocalValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** 활성 창 한 줄 요약. 창을 쓰지 않는 반복 요청은 null이다. */
export function describeActiveWindow(window: ActiveWindow): string | null {
  const from = window.activeFrom ?? null;
  const until = window.activeUntil ?? null;
  if (from === null && until === null) return null;
  if (from !== null && until !== null) return `${formatDate(from)} ~ ${formatDate(until)}`;
  if (from !== null) return `${formatDate(from)}부터`;
  return `${formatDate(until)}까지`;
}

/**
 * 활성 종료가 지났는지. 지난 반복 요청은 예약 실행이 더 나가지 않지만 백엔드가
 * enabled를 끄지는 않는다 — 사용자가 종료를 미루면 그대로 다시 돈다.
 */
export function activeWindowEnded(window: ActiveWindow, now: number = Date.now()): boolean {
  const until = window.activeUntil ?? null;
  return until !== null && now > until;
}
