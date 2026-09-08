import type { ChatRejectionCode } from "../types";
import { errorText } from "./errorText.ts";

/**
 * 백엔드가 start·attach를 거절했음을 나르는 오류. 재연결을 포기할지는 메시지 문구가
 * 아니라 `code`로만 정하므로, 문구가 바뀌어도 판단은 달라지지 않는다.
 */
export class ChatRejectedError extends Error {
  readonly code: ChatRejectionCode;
  readonly existingChatId: string | null;

  constructor(code: ChatRejectionCode, message: string, existingChatId: string | null = null) {
    super(message);
    this.name = "ChatRejectedError";
    this.code = code;
    this.existingChatId = existingChatId;
  }
}

export interface ChatReconnectDecision {
  /** true면 이 실행은 되살릴 수 없다. 재연결을 멈추고 이유를 화면에 알려야 한다. */
  terminal: boolean;
  /** 화면에 올릴 문구. 일시적 실패에서는 재시도 안내에 끼워 넣을 사유로 쓴다. */
  message: string;
}

/** 일시적 실패가 이어질 때 사용자에게 상황을 알리는 간격(재연결 시도 횟수). */
const RECONNECT_NOTICE_INTERVAL = 5;

/** 종료 안내에 붙이는 다음 행동. 세션 상세는 다시 열면 새 실행으로 이어지고,
 *  채팅 화면은 종료된 대화에 더 보낼 수 없으므로 새 대화가 필요하다. */
const RESUME_HINT = "이어서 진행하려면 이 세션을 다시 열거나 새 대화를 시작하세요.";

/**
 * 백엔드가 교체돼 붙어 있던 실행이 사라진 경우의 안내. "찾을 수 없습니다"를 유지해
 * 오류 코드 분류가 연결 장애(APP_CONNECTION)가 아니라 부재(APP_NOT_FOUND)로 잡히게 한다.
 */
export const BACKEND_RESTARTED_MESSAGE =
  `백엔드가 재기동되어 이 대화의 실행을 찾을 수 없습니다. 진행 중이던 요청은 되살릴 수 없습니다. ${RESUME_HINT}`;

/** 재연결 시도가 실패했을 때 계속 시도할지, 포기하고 알릴지 정한다. */
export function chatReconnectDecision(cause: unknown): ChatReconnectDecision {
  if (cause instanceof ChatRejectedError && cause.code !== "unavailable") {
    const detail = cause.code === "chatMissing"
      ? `백엔드에 이 실행이 남아 있지 않아 재연결을 멈췄습니다. ${RESUME_HINT}`
      : cause.code === "sessionBusy"
        ? "같은 공급자 세션의 기존 실행에 다시 연결해야 합니다."
      : `같은 요청으로는 다시 연결할 수 없어 재연결을 멈췄습니다. ${RESUME_HINT}`;
    return { terminal: true, message: `${cause.message} ${detail}` };
  }
  return { terminal: false, message: errorText(cause) };
}

/**
 * 일시적 실패를 사용자에게 알릴 차례인지. 첫 안내 한 번으로 끝내면 몇 분째 끊긴 화면이
 * 조용해지므로, 시도가 이어지는 동안 같은 간격으로 다시 알린다.
 */
export function shouldNoticeReconnectAttempt(attempts: number): boolean {
  return attempts > 0 && attempts % RECONNECT_NOTICE_INTERVAL === 0;
}

/** 재시도 안내 문구. 몇 번 실패했는지와 마지막 실패 사유를 함께 남긴다. */
export function reconnectNoticeMessage(attempts: number, reason: string): string {
  return `원격 채팅 연결이 ${attempts}번 실패했습니다: ${reason} 같은 세션에 계속 재연결하고 있습니다.`;
}
