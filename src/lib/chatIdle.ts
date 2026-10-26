import type { ChatPhase, ChatSessionInfo } from "../types";
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

type TextPicker = (ko: string, en: string) => string;

export function phaseLabel(phase: ChatPhase | "connecting", text: TextPicker): string {
  return phase === "connecting" ? text("연결 중", "Connecting")
    : phase === "ready" ? text("입력 대기", "Ready")
      : phase === "running" ? text("응답 중", "Responding")
        : phase === "waitingApproval" ? text("승인 대기", "Awaiting approval")
          : phase === "stopped" ? text("종료됨", "Stopped")
            : text("오류", "Error");
}

/**
 * 단계에 유휴 시간을 덧붙인 한 줄("입력 대기 · 12m"). 단계만 적으면 방금 답을 끝낸
 * 실행과 한 시간 방치된 실행이 똑같이 "입력 대기"라, 사용자가 둘을 가르지 못하고
 * 종료된 것인지 되묻게 된다. 아직 짧은 유휴는 붙이지 않는다.
 */
export function phaseWithIdleLabel(chat: ChatSessionInfo, text: TextPicker, phase: ChatPhase | "connecting" = chat.state): string {
  const label = phaseLabel(phase, text);
  // 연결하는 중에는 아직 이 실행의 시간이 아니다. 앞선 실행의 유휴를 붙이면 막 띄운
  // 대화가 몇 시간 방치된 것처럼 보인다. 끝난 실행(종료·실패)은 유휴가 아니라 멈춘
  // 것이라 붙이지 않는다 — 머리줄 툴팁(chatLivenessTitle)도 같은 상태에서 뺀다.
  const idle = phase === "connecting" || phase === "stopped" || phase === "failed" ? null : chatIdleLabel(chat);
  return idle ? `${label} · ${idle}` : label;
}

/**
 * 목록 항목에 걸어 둘 설명. 종료된 실행은 대화가 사라진 것이 아니라 런타임만 끊긴
 * 것이므로 이어갈 수 있다고 적어 준다 — "종료됨" 석 자만 보고 기록까지 없어진 줄 아는
 * 자리였다.
 */
export function chatLivenessTitle(chat: ChatSessionInfo, text: TextPicker, phase: ChatPhase | "connecting" = chat.state): string {
  // 연결 중에는 라벨과 같은 이유로 유휴를 감춘다. 한쪽만 감추면 같은 요소에서 라벨은
  // 조용한데 말풍선만 앞선 실행의 유휴를 읊는다.
  if (phase === "connecting") return text("기존 대화에 연결하고 있습니다", "Connecting to existing conversation");
  const idle = chatIdleLabel(chat);
  // 판정은 `chat.state`가 아니라 넘겨받은 `phase`로 한다. 머리줄은 소켓의 실시간 단계를
  // 넘기는데, 목록 스냅샷의 state로 가르면 라벨은 "종료됨"인데 말풍선은 "살아 있다"고 한다.
  if (phase === "stopped" || phase === "failed") {
    return text("실행이 끝났습니다. 대화는 남아 있어 이어갈 수 있습니다", "The run has ended. The conversation remains and can be resumed");
  }
  if (!idle) return text("살아 있는 실행입니다", "This run is alive");
  return phase === "ready"
    ? text(`살아 있지만 ${idle} 동안 입력을 기다리고 있습니다`, `Alive but waiting for input for ${idle}`)
    : text(`${idle} 동안 같은 상태입니다`, `Unchanged for ${idle}`);
}
