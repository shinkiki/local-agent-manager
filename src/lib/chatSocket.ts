import type { ChatEvent, ChatSessionInfo } from "../types";
import { backendWebSocketUrl } from "./backend.ts";
import { assertRemoteChatAccess } from "./chatAccess.ts";
import { createChatEventBatch } from "./chatEventBatch.ts";
import { BACKEND_RESTARTED_MESSAGE, chatReconnectDecision } from "./chatReconnect.ts";
import { createChatReconnectWatch } from "./chatReconnectWatch.ts";
import {
  haltChatReconnect,
  openChatSocket,
  type ChatSocketAttemptTarget,
} from "./chatSocketAttempt.ts";
import {
  writeChatSocketMessage,
  type ChatSocketCommand,
  type ChatSocketFirstMessage,
} from "./chatSocketMessages.ts";
import { getWebAccessStatus } from "./ipc.ts";

// 채팅 소켓의 수명주기 — 열기·재연결·닫기와 그동안 이어 가는 상태. 화면이 쓰는 조작
// 창구(chat.ts)는 이 모듈이 내주는 전송·해제 두 걸음만 알면 되고, 소켓이 지금 어떤
// 상태인지는 여기서만 판단한다. 한 번의 열기 시도 안에서 무엇이 연결 성립·거절·끊김인지는
// chatSocketAttempt가, 나가는 메시지의 모양은 chatSocketMessages가 맡는다. 조작 창구가
// 그 한 벌을 그대로 쓸 수 있도록 여기서 다시 내보낸다.

export { chatApproveCommand, chatSendCommand } from "./chatSocketMessages.ts";
export type { ChatSocketCommand, ChatSocketFirstMessage };

/**
 * 재연결 직전 인스턴스 확인(`/api/access`)을 기다리는 한도. 이 요청이 끝나야 다음 시도가
 * 잡히므로, 응답도 실패도 돌아오지 않는 터널에서는 재연결 루프 전체가 멈춘다. 화면 복귀
 * 시 즉시 재시도도 그동안은 동작하지 않으므로 한도를 둔다.
 */
const RECONNECT_PRECHECK_TIMEOUT_MS = 10_000;

/**
 * 한 채팅 연결이 재연결을 거치며 이어 가는 상태와 협력자. 소켓 열기·재연결·조작 창구가
 * 같은 한 벌을 보고 고치므로, 각 단계를 모듈 최상위 함수로 떼어 두고 이 기록만 넘긴다.
 * 열기 시도가 건드리는 칸은 `ChatSocketAttemptTarget`에 적혀 있고, 여기에는 재연결
 * 판단에만 쓰는 칸을 더한다.
 */
export interface ChatSocketRuntime extends ChatSocketAttemptTarget {
  /**
   * 채팅 실행은 백엔드 프로세스 메모리에만 있다. 이 값이 달라졌으면 붙어 있던 실행은
   * 사라졌으므로, 재연결이 아니라 종료로 다뤄야 한다.
   */
  backendInstanceId: string;
  /** 되살릴 수 없는 실패로 재연결을 포기한 이유. 이후 조작 시도에 이 이유를 그대로 알린다. */
  stoppedReason: string | null;
}

/**
 * 한 연결이 쓸 상태 한 벌을 만든다. 재연결 감시 콜백은 이 기록을 되짚어야 하지만, 감시가
 * 그 콜백을 부르는 것은 연결이 선 다음이므로 기록을 만드는 자리에서 함께 만들 수 있다.
 * 예전에는 빈 자리를 `null as unknown as`로 채우고 만든 뒤에 덮어썼는데, 그 사이에 감시를
 * 건드리는 줄이 하나라도 끼면 타입이 막아 주지 못한 채 런타임에서 터진다.
 */
function createChatSocketRuntime(
  backendInstanceId: string,
  onEvent: (event: ChatEvent) => void,
): ChatSocketRuntime {
  const runtime: ChatSocketRuntime = {
    url: backendWebSocketUrl("/api/chat"),
    backendInstanceId,
    socket: null,
    detached: false,
    takenOver: false,
    stoppedReason: null,
    activeChatId: null,
    lastSession: null,
    eventBatch: createChatEventBatch(onEvent),
    /**
     * 재연결 백오프와 복귀 감시. 이 연결이 아직 재시도할 자격이 있는지는 감시 쪽 상태만으로는
     * 알 수 없으므로 `canRetry`로 알려 주고, attach는 `attempt`가 맡는다.
     */
    reconnectWatch: createChatReconnectWatch({
      canRetry: () => !runtime.detached && runtime.activeChatId !== null,
      attempt: () => {
        const chatId = runtime.activeChatId;
        if (chatId) void reconnectChatSocket(runtime, chatId);
      },
    }),
  };
  return runtime;
}

/**
 * 소켓을 열고 첫 연결이 설 때까지 기다린다. 이 뒤로는 재연결 감시가 붙으므로, 실패하면
 * 이 연결에는 재연결 루프가 없다.
 */
export async function openChatRuntime(
  firstMessage: ChatSocketFirstMessage,
  onEvent: (event: ChatEvent) => void,
): Promise<{ runtime: ChatSocketRuntime; info: ChatSessionInfo }> {
  const access = await assertRemoteChatAccess();
  const runtime = createChatSocketRuntime(access.instanceId, onEvent);
  const info = await openChatSocket(runtime, firstMessage, false);
  // 연결이 선 뒤부터 감시한다. 최초 연결이 실패하면 이 연결에는 재연결 루프가 없다.
  runtime.reconnectWatch.watch();
  return { runtime, info };
}

/** 다른 화면이 이 채팅을 가져가 이 연결이 끊긴 뒤의 안내. */
const TAKEN_OVER_MESSAGE =
  "다른 화면에서 이 채팅에 연결되어 이 화면의 연결이 해제되었습니다. 채팅을 다시 열어 연결하세요.";

/** 소켓이 끊겨 있어 지금은 받을 수 없지만, 복구를 걸어 두었을 때의 안내. */
const RECONNECTING_MESSAGE = "채팅 연결을 복구하고 있습니다. 잠시 후 다시 시도하세요.";

/**
 * 지금 이 연결로 메시지를 내보낼 수 있는 소켓. 없거나 아직·이미 닫혀 있으면 null.
 *
 * 나가는 메시지는 조작 전달과 detach 통보 두 자리에서 실리는데, 같은 판정을 서로 다른
 * 모양으로 들고 있었다 — 한쪽은 `!socket || readyState !== OPEN`, 다른 쪽은
 * `socket?.readyState === OPEN`. 뒤집힌 두 조건이라 상태를 하나 더 가려야 할 때 한쪽만
 * 고치면 나머지는 예전 기준으로 남는다. 판정은 여기서만 하고, 그 결과로 무엇을 할지는
 * (거절하고 복구를 걸지, 통보를 건너뛸지) 부르는 쪽이 정한다.
 *
 * 참 거짓 대신 소켓을 돌려주는 것은 부르는 쪽이 곧바로 그 소켓에 실어야 하기 때문이다 —
 * 판정을 따로 두면 `null`이 아님이 호출부까지 따라오지 않아 단언이 필요해진다.
 */
function writableChatSocket(runtime: ChatSocketRuntime): WebSocket | null {
  const socket = runtime.socket;
  return socket && socket.readyState === WebSocket.OPEN ? socket : null;
}

/**
 * 화면이 보낸 조작 한 건을 소켓에 흘린다. 소켓이 끊겨 있으면 재연결을 걸고 이유를 알린다.
 */
export function sendChatSocketMessage(
  runtime: ChatSocketRuntime,
  message: ChatSocketCommand,
): Promise<void> {
  if (runtime.stoppedReason) {
    return Promise.reject(new Error(runtime.stoppedReason));
  }
  if (runtime.takenOver) {
    return Promise.reject(new Error(TAKEN_OVER_MESSAGE));
  }
  const socket = writableChatSocket(runtime);
  if (!socket) {
    runtime.reconnectWatch.schedule();
    return Promise.reject(new Error(RECONNECTING_MESSAGE));
  }
  writeChatSocketMessage(socket, message);
  return Promise.resolve();
}

/** 이 화면의 연결을 스스로 끊는다. 재연결 감시와 이벤트 배치까지 함께 걷는다. */
export function detachChatSocket(runtime: ChatSocketRuntime): void {
  // takenOver로 이미 detached여도 소켓·배치 정리는 마저 수행한다.
  const socket = runtime.detached ? null : writableChatSocket(runtime);
  if (socket) {
    writeChatSocketMessage(socket, { type: "detach" });
  }
  haltChatReconnect(runtime);
  closeChatSocket(runtime);
  runtime.eventBatch.dispose();
}

/** 현재 소켓을 닫고 참조를 비운다. 이미 닫혔거나 없으면 아무 일도 하지 않는다. */
function closeChatSocket(runtime: ChatSocketRuntime): void {
  runtime.socket?.close();
  runtime.socket = null;
}

/**
 * 재시도로 회복되지 않는 실패. 이유를 화면에 남기고, 마지막으로 알던 세션을 종료 상태로
 * 만들어 화면이 '응답 중'에 멈춰 있지 않게 한다.
 */
function stopReconnecting(runtime: ChatSocketRuntime, message: string): void {
  if (runtime.detached) return;
  runtime.stoppedReason = message;
  haltChatReconnect(runtime);
  runtime.eventBatch.push({ type: "error", message });
  if (runtime.lastSession) {
    runtime.eventBatch.push({
      type: "state",
      session: { ...runtime.lastSession, state: "stopped", attached: false },
    });
  }
  runtime.eventBatch.flush();
  closeChatSocket(runtime);
}

async function reconnectChatSocket(runtime: ChatSocketRuntime, chatId: string): Promise<void> {
  try {
    // attach를 보내기 전에 프로세스가 그대로인지 확인한다. 교체된 뒤에는 attach가
    // 영원히 실패하므로, 재기동을 연결 장애로 오해하고 무한히 두드리지 않는다.
    const current = await getWebAccessStatus({ timeoutMs: RECONNECT_PRECHECK_TIMEOUT_MS });
    if (current.instanceId !== runtime.backendInstanceId) {
      stopReconnecting(runtime, BACKEND_RESTARTED_MESSAGE);
      return;
    }
    await openChatSocket(runtime, { type: "attach", chatId }, true);
    runtime.reconnectWatch.reset();
  } catch (cause) {
    if (runtime.detached) return;
    const decision = chatReconnectDecision(cause);
    if (decision.terminal) {
      stopReconnecting(runtime, decision.message);
      return;
    }
    const notice = runtime.reconnectWatch.noteFailure(decision.message);
    if (notice) runtime.eventBatch.push({ type: "error", message: notice });
    runtime.reconnectWatch.schedule();
  }
}
