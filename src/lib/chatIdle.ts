import type { ChatSessionInfo } from "../types";
import { formatCountdown } from "./format.ts";

/**
 * 유휴를 적어 보이기 시작하는 길이. 답을 막 끝낸 실행마다 "0m"을 달면 목록이 숫자로
 * 덮이고, 정작 갈라 봐야 할 "오래 멈춰 있는 실행"이 묻힌다. 응답을 주고받는 보통의
 * 간격보다는 길고, 사람이 자리를 비운 것으로 읽기 시작하는 길이보다는 짧게 잡았다.
 */
export const IDLE_NOTICE_MS = 5 * 60_000;

/**
 * 이 실행이 마지막으로 움직인 뒤 흐른 시간(ms).
 *
 * 백엔드가 응답을 만들 때 재 둔 `idleMs`를 그대로 쓴다 — 원격 화면은 호스트와 시계가
 * 어긋날 수 있어, 화면이 제 시계로 다시 빼면 같은 실행이 기기마다 다른 유휴로 보인다.
 * 그 값을 실을 줄 모르는 이전 버전 백엔드에서만 가진 시각으로 되짚고, 그마저 없으면
 * 실행을 시작한 시각으로 메운다.
 */
export function chatIdleMs(chat: ChatSessionInfo, now: number = Date.now()): number {
  if (typeof chat.idleMs === "number") return Math.max(0, chat.idleMs);
  return Math.max(0, now - (chat.lastActivityAt ?? chat.startedAt));
}

/**
 * 상태 옆에 덧붙일 유휴 표기("12m", "4h 16m"). 아직 짧으면 null이라 아무것도 붙지 않는다.
 *
 * 응답 중인 실행도 멈춰 있을 수 있어 단계로 거르지 않는다 — 한 시간째 "응답 중"인 실행은
 * 입력 대기로 한 시간 방치된 실행만큼이나 사용자가 알아야 할 상태다.
 */
export function chatIdleLabel(chat: ChatSessionInfo, now: number = Date.now()): string | null {
  const idle = chatIdleMs(chat, now);
  return idle >= IDLE_NOTICE_MS ? formatCountdown(idle) : null;
}
