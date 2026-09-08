import type {
  ChatApprovalDecision,
  ChatEvent,
  ChatSessionInfo,
  ChatStartRequest,
  ProviderId,
} from "../types";
import { backendWebSocketUrl } from "./backend";
import { assertRemoteChatAccess } from "./chatAccess";
import { normalizeChatEvent } from "./chatCompatibility";
import { createChatEventBatch, type ChatEventBatch } from "./chatEventBatch";
import {
  BACKEND_RESTARTED_MESSAGE,
  chatReconnectDecision,
  ChatRejectedError,
} from "./chatReconnect";
import { createChatReconnectWatch, type ChatReconnectWatch } from "./chatReconnectWatch";
import { getWebAccessStatus } from "./ipc";
import { errorText } from "./errorText";

// 첨부 파일 API는 chatAttachments로 옮겼다. 화면들이 채팅 창구 하나만 알면 되도록 여기서 다시 내보낸다.
export {
  directChatInputFileUrl,
  readChatInputFile,
  removeChatInputFile,
  uploadChatInputFile,
} from "./chatAttachments";

export interface ChatSendOptions {
  /** 응답 중이면 현재 턴을 중단하지 않고 그 턴에 이 메시지를 바로 얹는다. */
  steer?: boolean;
  attachmentIds?: string[];
}

/**
 * 진행 중인 턴에 메시지를 그대로 얹을 수 있는 공급자. Claude CLI는 stream-json
 * 입력을 현재 턴으로 흡수하고 Codex는 turn/steer로 같은 턴에 이어 붙인다.
 * Antigravity CLI는 턴마다 프로세스를 새로 띄우므로 대기열만 쓸 수 있다.
 */
export function supportsDeliveryDuringTurn(source: ProviderId): boolean {
  return source === "claude" || source === "codex";
}

export interface ChatConnection {
  info: ChatSessionInfo;
  send(text: string, options?: ChatSendOptions): Promise<void>;
  removeQueued(messageId: string): Promise<void>;
  /** `answers`는 질의응답 카드에서 고른 답(질문 원문 -> 답). 그 밖의 승인에서는 생략한다. */
  approve(approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  detach(): Promise<void>;
}

export async function connectChat(
  request: ChatStartRequest,
  onEvent: (event: ChatEvent) => void,
): Promise<ChatConnection> {
  return connectWebSocket({ type: "start", request }, onEvent);
}

export async function attachChat(
  chatId: string,
  onEvent: (event: ChatEvent) => void,
): Promise<ChatConnection> {
  return connectWebSocket({ type: "attach", chatId }, onEvent);
}

/**
 * 재연결 직전 인스턴스 확인(`/api/access`)을 기다리는 한도. 이 요청이 끝나야 다음 시도가
 * 잡히므로, 응답도 실패도 돌아오지 않는 터널에서는 재연결 루프 전체가 멈춘다. 화면 복귀
 * 시 즉시 재시도도 그동안은 동작하지 않으므로 한도를 둔다.
 */
const RECONNECT_PRECHECK_TIMEOUT_MS = 10_000;

type ChatSocketFirstMessage =
  | { type: "start"; request: ChatStartRequest }
  | { type: "attach"; chatId: string };

/**
 * 한 채팅 연결이 재연결을 거치며 이어 가는 상태와 협력자. 소켓 열기·재연결·조작 창구가
 * 같은 한 벌을 보고 고치므로, 각 단계를 모듈 최상위 함수로 떼어 두고 이 기록만 넘긴다.
 */
interface ChatSocketRuntime {
  url: string;
  /**
   * 채팅 실행은 백엔드 프로세스 메모리에만 있다. 이 값이 달라졌으면 붙어 있던 실행은
   * 사라졌으므로, 재연결이 아니라 종료로 다뤄야 한다.
   */
  backendInstanceId: string;
  socket: WebSocket | null;
  detached: boolean;
  takenOver: boolean;
  /** 되살릴 수 없는 실패로 재연결을 포기한 이유. 이후 조작 시도에 이 이유를 그대로 알린다. */
  stoppedReason: string | null;
  activeChatId: string | null;
  lastSession: ChatSessionInfo | null;
  eventBatch: ChatEventBatch;
  reconnectWatch: ChatReconnectWatch;
}

/** 소켓 열기 약속의 결론을 짓는 창구. 성공이면 세션, 실패면 이유를 넘긴다. */
type ChatSocketSettle = (result: { session: ChatSessionInfo } | { error: unknown }) => void;

/** 한 번의 소켓 열기 시도에만 사는 값. 재시도마다 새로 만든다. */
interface ChatSocketAttempt {
  reconnecting: boolean;
  settled: boolean;
  connected: boolean;
  resetSent: boolean;
  timer: number;
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
  runtime.detached = true;
  runtime.stoppedReason = message;
  runtime.reconnectWatch.stop();
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

/**
 * 소켓에서 올라온 이벤트 한 건을 처리한다. 첫 `state`가 연결 성립이고, `rejected`는
 * 실패다. 둘 중 하나로 결론이 나면 `settle`을 통해 열기 약속을 끝낸다.
 */
function handleChatSocketEvent(
  runtime: ChatSocketRuntime,
  attempt: ChatSocketAttempt,
  event: ChatEvent,
  settle: ChatSocketSettle,
): void {
  if (event.type === "rejected") {
    // 최초 연결 거절은 지금까지처럼 오류로 올린다(호출자가 문구를 보여주지 않는
    // 화면도 있다). 재연결 거절은 stopReconnecting이 다음 행동까지 함께 알린다.
    if (!attempt.reconnecting) runtime.eventBatch.push({ type: "error", message: event.message });
    settle({ error: new ChatRejectedError(event.code, event.message, event.existingChatId ?? null) });
    return;
  }
  if (event.type === "takenOver") {
    // 백엔드는 이제 화면마다 구독을 따로 유지하므로 이 이벤트를 보내지 않는다.
    // 업데이트 전 백엔드가 계속 실행 중인 경우에만 도착한다. 그때 재연결하면
    // 두 화면이 서로 구독을 뺏는 핑퐁이 되므로 이 연결은 조용히 멈춘다.
    runtime.detached = true;
    runtime.takenOver = true;
    runtime.reconnectWatch.stop();
  }
  // 재연결 attach는 백엔드가 과거 이벤트를 통째로 리플레이하므로,
  // 첫 이벤트 전에 쌓인 스트림을 비워 같은 답변이 중복 표시되지 않게 한다.
  if (attempt.reconnecting && !attempt.resetSent) {
    attempt.resetSent = true;
    runtime.eventBatch.push({ type: "replayReset" });
  }
  if (event.type === "state") runtime.lastSession = event.session;
  runtime.eventBatch.push(event);
  if (!attempt.settled && event.type === "state") {
    attempt.connected = true;
    runtime.activeChatId = event.session.chatId;
    settle({ session: event.session });
  }
}

/** 소켓에서 올라온 원문 한 건을 이벤트로 읽는다. 읽지 못하면 그 사실만 화면에 알린다. */
function handleChatSocketMessage(
  runtime: ChatSocketRuntime,
  attempt: ChatSocketAttempt,
  data: unknown,
  settle: ChatSocketSettle,
): void {
  try {
    handleChatSocketEvent(
      runtime,
      attempt,
      normalizeChatEvent(JSON.parse(String(data)) as ChatEvent),
      settle,
    );
  } catch (cause) {
    runtime.eventBatch.push({
      type: "error",
      message: `채팅 응답을 읽지 못했습니다: ${errorText(cause)}`,
    });
  }
}

/**
 * 소켓이 닫혔다. 아직 결론이 없으면 열기 실패이고, 연결까지 갔던 소켓이 끊긴 것이면
 * 재연결을 예약한다. 스스로 끊은(detached) 연결은 다시 붙지 않는다.
 */
function handleChatSocketClose(
  runtime: ChatSocketRuntime,
  attempt: ChatSocketAttempt,
  socket: WebSocket,
  settle: ChatSocketSettle,
): void {
  runtime.eventBatch.flush();
  window.clearTimeout(attempt.timer);
  if (runtime.socket === socket) runtime.socket = null;
  if (!attempt.settled) {
    settle({ error: new Error("채팅 연결이 시작 전에 종료되었습니다") });
  } else if (attempt.connected && !runtime.detached) {
    runtime.reconnectWatch.schedule();
  }
}

function openChatSocket(
  runtime: ChatSocketRuntime,
  firstMessage: ChatSocketFirstMessage,
  reconnecting: boolean,
): Promise<ChatSessionInfo> {
  return new Promise((resolve, reject) => {
    const nextSocket = new WebSocket(runtime.url);
    runtime.socket = nextSocket;
    const attempt: ChatSocketAttempt = {
      reconnecting,
      settled: false,
      connected: false,
      resetSent: false,
      timer: window.setTimeout(() => {
        if (attempt.settled) return;
        attempt.settled = true;
        nextSocket.close();
        reject(new Error("구조화 채팅 연결 시간이 초과되었습니다"));
      }, 30_000),
    };
    /** 열기 약속을 한 번만 끝낸다. 이미 끝났으면 아무 일도 하지 않는다. */
    const settle: ChatSocketSettle = (result) => {
      if (attempt.settled) return;
      attempt.settled = true;
      window.clearTimeout(attempt.timer);
      if ("session" in result) resolve(result.session);
      else reject(result.error);
    };
    nextSocket.addEventListener("open", () => {
      nextSocket.send(JSON.stringify(firstMessage));
    });
    nextSocket.addEventListener("message", (message) => {
      handleChatSocketMessage(runtime, attempt, message.data, settle);
    });
    nextSocket.addEventListener("error", () => {
      if (attempt.settled) return;
      // 실패 이유는 비동기로 알아내지만, 그 사이 close가 다른 이유로 약속을 끝내지
      // 않도록 결론은 지금 못 박는다.
      attempt.settled = true;
      window.clearTimeout(attempt.timer);
      void chatWebSocketConnectionError().then(reject);
    });
    nextSocket.addEventListener("close", () => {
      handleChatSocketClose(runtime, attempt, nextSocket, settle);
    });
  });
}

/** 화면이 쓰는 조작 창구. 소켓이 끊겨 있으면 재연결을 걸고 이유를 알린다. */
function chatConnection(runtime: ChatSocketRuntime, info: ChatSessionInfo): ChatConnection {
  const send = (message: object): Promise<void> => {
    if (runtime.stoppedReason) {
      return Promise.reject(new Error(runtime.stoppedReason));
    }
    if (runtime.takenOver) {
      return Promise.reject(new Error("다른 화면에서 이 채팅에 연결되어 이 화면의 연결이 해제되었습니다. 채팅을 다시 열어 연결하세요."));
    }
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) {
      runtime.reconnectWatch.schedule();
      return Promise.reject(new Error("채팅 연결을 복구하고 있습니다. 잠시 후 다시 시도하세요."));
    }
    runtime.socket.send(JSON.stringify(message));
    return Promise.resolve();
  };
  return {
    info,
    send(text, options) {
      return send({ type: "send", text, steer: options?.steer ?? false, attachmentIds: options?.attachmentIds ?? [] });
    },
    removeQueued(messageId) {
      return send({ type: "removeQueued", messageId });
    },
    approve(approvalId, decision, answers) {
      return send({ type: "approve", approvalId, decision, answers: answers ?? {} });
    },
    interrupt() {
      return send({ type: "interrupt" });
    },
    stop() {
      return send({ type: "stop" });
    },
    async detach() {
      // takenOver로 이미 detached여도 소켓·배치 정리는 마저 수행한다.
      if (!runtime.detached && runtime.socket?.readyState === WebSocket.OPEN) {
        runtime.socket.send(JSON.stringify({ type: "detach" }));
      }
      runtime.detached = true;
      runtime.reconnectWatch.stop();
      closeChatSocket(runtime);
      runtime.eventBatch.dispose();
    },
  };
}

async function connectWebSocket(
  firstMessage: ChatSocketFirstMessage,
  onEvent: (event: ChatEvent) => void,
): Promise<ChatConnection> {
  const access = await assertRemoteChatAccess();
  const runtime: ChatSocketRuntime = {
    url: backendWebSocketUrl("/api/chat"),
    backendInstanceId: access.instanceId,
    socket: null,
    detached: false,
    takenOver: false,
    stoppedReason: null,
    activeChatId: null,
    lastSession: null,
    eventBatch: createChatEventBatch(onEvent),
    // 아래에서 바로 채운다. 감시 콜백이 runtime을 되짚어야 해서 순서를 이렇게 둔다.
    reconnectWatch: null as unknown as ChatReconnectWatch,
  };
  /**
   * 재연결 백오프와 복귀 감시. 이 연결이 아직 재시도할 자격이 있는지는 감시 쪽 상태만으로는
   * 알 수 없으므로 `canRetry`로 알려 주고, attach는 `attempt`가 맡는다.
   */
  runtime.reconnectWatch = createChatReconnectWatch({
    canRetry: () => !runtime.detached && runtime.activeChatId !== null,
    attempt: () => {
      const chatId = runtime.activeChatId;
      if (chatId) void reconnectChatSocket(runtime, chatId);
    },
  });

  const info = await openChatSocket(runtime, firstMessage, false);
  // 연결이 선 뒤부터 감시한다. 최초 연결이 실패하면 이 연결에는 재연결 루프가 없다.
  runtime.reconnectWatch.watch();
  return chatConnection(runtime, info);
}

async function chatWebSocketConnectionError(): Promise<Error> {
  try {
    await assertRemoteChatAccess();
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  return new Error("채팅 WebSocket에 연결하지 못했습니다");
}
