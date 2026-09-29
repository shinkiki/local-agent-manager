import type { ChatEvent, ChatSessionInfo } from "../types";
import { assertRemoteChatAccess } from "./chatAccess.ts";
import { normalizeChatEvent } from "./chatCompatibility.ts";
import { type ChatEventBatch } from "./chatEventBatch.ts";
import { ChatRejectedError } from "./chatReconnect.ts";
import { type ChatReconnectWatch } from "./chatReconnectWatch.ts";
import { writeChatSocketMessage, type ChatSocketFirstMessage } from "./chatSocketMessages.ts";
import { errorText } from "./errorText.ts";

// 소켓 한 번 열기 — 첫 메시지를 보내고 연결 성립·거절·끊김 중 하나로 결론이 날 때까지.
// 연결의 수명주기(chatSocket.ts)는 이 시도를 되풀이하는 쪽이고, 한 번의 시도 안에서
// 무엇이 결론이 되는지는 여기서만 판단한다. 나가는 메시지의 모양은
// chatSocketMessages.ts가 정한다.

/** 첫 연결이 서기를 기다리는 한도. 넘으면 소켓을 닫고 열기 실패로 끝낸다. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * 한 번의 열기 시도가 읽고 고치는 연결 상태. 수명주기 쪽 기록(`ChatSocketRuntime`)이 이
 * 모양을 그대로 만족하므로 그 기록을 넘기면 되고, 대신 시도가 실제로 건드리는 칸이
 * 여기 적힌 것뿐임이 타입으로 드러난다. 재연결 판단에만 쓰는 칸(백엔드 인스턴스 id,
 * 포기 사유)은 시도가 보지 않으므로 넣지 않는다.
 */
export interface ChatSocketAttemptTarget {
  url: string;
  socket: WebSocket | null;
  detached: boolean;
  takenOver: boolean;
  activeChatId: string | null;
  lastSession: ChatSessionInfo | null;
  eventBatch: ChatEventBatch;
  reconnectWatch: ChatReconnectWatch;
}

/**
 * 이 시도의 결론을 짓는 창구. 결론이 날 수 있는 갈래는 셋(첫 `state`로 연결 성립, 거절,
 * 시간 초과·소켓 오류·시작 전 끊김)인데, 저마다 "처음 짓는 쪽인지 가리고, 다시 결론이
 * 나지 않게 못 박고, 대기 타이머를 걷고, 약속을 끝낸다"를 조금씩 다른 모양으로 들고
 * 있었다 — 성공·거절은 `settle`을, 시간 초과와 소켓 오류는 `claimAttempt` 뒤에 날
 * `reject`를 직접 썼다. 창구가 둘이라 약속을 끝내는 쪽(`reject`)이 이벤트를 거는
 * 함수까지 따라 내려가야 했고, 한 갈래에 걸음을 더해도 나머지는 예전 걸음 수로 남았다.
 */
interface ChatSocketConclusion {
  /** 이미 결론이 난 시도인지. 아직이면 첫 `state`가 연결 성립이 된다. */
  done(): boolean;
  /** 결론을 짓는다. 이미 끝난 시도면 아무 일도 하지 않는다. */
  settle(result: { session: ChatSessionInfo } | { error: unknown }): void;
  /**
   * 실패로 끝낼 자리를 먼저 잡아 둔다. 잡았으면 이유를 넘길 함수를, 이미 결론이 났으면
   * null을 돌려준다. 시간 초과는 소켓을 닫은 뒤에, 소켓 오류는 실제 이유를 비동기로
   * 알아낸 뒤에 이유가 정해지므로, 그 사이 다른 갈래가 끼어들지 못하게 자리부터 잡는다.
   */
  claimFailure(): ((error: unknown) => void) | null;
}

/**
 * 이 시도의 결론 창구와 대기 타이머를 함께 만든다. 약속·타이머·"한 번만 끝낸다"는 규칙이
 * 한곳에 모여 있어야, 걸음을 하나 더해도 세 갈래가 함께 따라간다.
 */
function createChatSocketConclusion(
  socket: WebSocket,
  resolve: (session: ChatSessionInfo) => void,
  reject: (reason?: unknown) => void,
): ChatSocketConclusion {
  let settled = false;
  let timer = 0;

  const claimFailure = (): ((error: unknown) => void) | null => {
    if (settled) return null;
    settled = true;
    window.clearTimeout(timer);
    return reject;
  };

  timer = window.setTimeout(() => {
    const fail = claimFailure();
    if (!fail) return;
    socket.close();
    fail(new Error("구조화 채팅 연결 시간이 초과되었습니다"));
  }, CONNECT_TIMEOUT_MS);

  return {
    done: () => settled,
    settle(result) {
      const fail = claimFailure();
      if (!fail) return;
      if ("session" in result) resolve(result.session);
      else fail(result.error);
    },
    claimFailure,
  };
}

/**
 * 한 번의 소켓 열기 시도. 재시도마다 새로 만든다.
 *
 * 예전에는 이 기록이 시도 안에서만 바뀌는 칸 셋만 들고 있었고, 그 칸을 읽는 함수들은
 * 함께 봐야 하는 나머지 셋(고칠 연결 상태 · 이 시도의 소켓 · 결론 창구)을 매개변수로
 * 나란히 받아 다시 넘겼다. 여섯 함수가 같은 묶음을 조금씩 다른 순서로 줄 세우고 있어,
 * 걸음을 하나 더하거나 새 함수를 끼울 때마다 그 묶음을 손으로 다시 엮어야 했고 순서가
 * 어긋나도 같은 타입끼리는 타입 검사가 막아 주지 않는다.
 *
 * 한 시도가 보는 것이 무엇인지는 이 타입 하나가 정하고, 각 함수는 그 시도에 더해 자기가
 * 다루는 것(이벤트 한 건, 원문 한 건, 첫 메시지)만 받는다.
 */
interface ChatSocketAttempt {
  /** 시도가 읽고 고치는 연결 상태. */
  target: ChatSocketAttemptTarget;
  /** 이 시도가 연 소켓. 수명주기 쪽 `target.socket`은 그 사이 다른 소켓으로 바뀔 수 있다. */
  socket: WebSocket;
  /** 이 시도의 결론을 짓는 창구. */
  conclusion: ChatSocketConclusion;
  reconnecting: boolean;
  connected: boolean;
  resetSent: boolean;
  /**
   * 연결이 서기 전에 백엔드가 보낸 마지막 오류 문구. 기동이 실패하면 백엔드는 이유를
   * 담은 `error` 이벤트를 보내고 곧바로 소켓을 닫는데, 닫힘만 보고 결론을 내면 그 이유가
   * 일반 문구에 덮여 사라진다(로컬 ACP 기동 실패가 한결같이 "시작 전에 종료되었습니다"로
   * 보이던 원인). 닫힘 때 이 값이 있으면 그것을 실패 사유로 올린다.
   */
  preConnectError: string | null;
}

/**
 * 이 연결을 더 이상 되살리지 않기로 한다. 스스로 끊기·되살릴 수 없는 실패·다른 화면에
 * 뺏김이 저마다 같은 두 줄(`detached` 표시와 감시 걷기)을 들고 있어, 한쪽만 고치면
 * 나머지 갈래에 예약된 재시도가 남아 이미 끝난 연결을 계속 두드렸다. 뺏김은 시도 안에서,
 * 나머지 둘은 수명주기 쪽에서 판정하므로 두 모듈이 함께 쓰는 이곳에 둔다.
 */
export function haltChatReconnect(target: ChatSocketAttemptTarget): void {
  target.detached = true;
  target.reconnectWatch.stop();
}

/** 재연결 리플레이를 받기 시작할 때 기존 스트림을 한 번만 비운다. */
function resetReplayedEvents(attempt: ChatSocketAttempt): void {
  if (!attempt.reconnecting || attempt.resetSent) return;
  attempt.resetSent = true;
  attempt.target.eventBatch.push({ type: "replayReset" });
}

/**
 * 소켓에서 올라온 이벤트 한 건을 처리한다. 첫 `state`가 연결 성립이고, `rejected`는
 * 실패다. 둘 중 하나로 결론이 나면 결론 창구를 통해 열기 약속을 끝낸다.
 */
function handleChatSocketEvent(attempt: ChatSocketAttempt, event: ChatEvent): void {
  const { target, conclusion } = attempt;
  if (event.type === "rejected") {
    // 최초 연결 거절은 지금까지처럼 오류로 올린다(호출자가 문구를 보여주지 않는
    // 화면도 있다). 재연결 거절은 stopReconnecting이 다음 행동까지 함께 알린다.
    if (!attempt.reconnecting) target.eventBatch.push({ type: "error", message: event.message });
    conclusion.settle({
      error: new ChatRejectedError(event.code, event.message, event.existingChatId ?? null),
    });
    return;
  }
  if (event.type === "takenOver") {
    // 백엔드는 이제 화면마다 구독을 따로 유지하므로 이 이벤트를 보내지 않는다.
    // 업데이트 전 백엔드가 계속 실행 중인 경우에만 도착한다. 그때 재연결하면
    // 두 화면이 서로 구독을 뺏는 핑퐁이 되므로 이 연결은 조용히 멈춘다.
    target.takenOver = true;
    haltChatReconnect(target);
  }
  // 재연결 attach는 백엔드가 과거 이벤트를 통째로 리플레이하므로,
  // 첫 이벤트 전에 쌓인 스트림을 비워 같은 답변이 중복 표시되지 않게 한다.
  resetReplayedEvents(attempt);
  if (event.type === "error" && !conclusion.done()) attempt.preConnectError = event.message;
  if (event.type === "state") target.lastSession = event.session;
  target.eventBatch.push(event);
  if (!conclusion.done() && event.type === "state") {
    attempt.connected = true;
    target.activeChatId = event.session.chatId;
    conclusion.settle({ session: event.session });
  }
}

/** 소켓에서 올라온 원문 한 건을 이벤트로 읽는다. 읽지 못하면 그 사실만 화면에 알린다. */
function handleChatSocketMessage(attempt: ChatSocketAttempt, data: unknown): void {
  try {
    handleChatSocketEvent(attempt, normalizeChatEvent(JSON.parse(String(data)) as ChatEvent));
  } catch (cause) {
    attempt.target.eventBatch.push({
      type: "error",
      message: `채팅 응답을 읽지 못했습니다: ${errorText(cause)}`,
    });
  }
}

/**
 * 소켓이 닫혔다. 아직 결론이 없으면 열기 실패이고, 연결까지 갔던 소켓이 끊긴 것이면
 * 재연결을 예약한다. 스스로 끊은(detached) 연결은 다시 붙지 않는다.
 */
function handleChatSocketClose(attempt: ChatSocketAttempt): void {
  const { target, socket, conclusion } = attempt;
  target.eventBatch.flush();
  // 대기 타이머는 결론을 짓는 창구가 걷는다. 아직 결론이 없으면 바로 아래 settle이,
  // 이미 있으면 그때 걷혔다.
  if (target.socket === socket) target.socket = null;
  if (!conclusion.done()) {
    conclusion.settle({
      error: new Error(attempt.preConnectError ?? "채팅 연결이 시작 전에 종료되었습니다"),
    });
  } else if (attempt.connected && !target.detached) {
    target.reconnectWatch.schedule();
  }
}

/**
 * 한 번의 연결 시도에 필요한 소켓 이벤트를 묶어 단다. 약속과 타이머를 만드는 쪽은 시도
 * 자체의 수명만 정하고, 이벤트별 처리는 이 함수가 기존 전용 처리기에 연결한다.
 */
function bindChatSocketAttempt(
  attempt: ChatSocketAttempt,
  firstMessage: ChatSocketFirstMessage,
): void {
  const { socket, conclusion } = attempt;
  socket.addEventListener("open", () => {
    writeChatSocketMessage(socket, firstMessage);
  });
  socket.addEventListener("message", (message) => {
    handleChatSocketMessage(attempt, message.data);
  });
  socket.addEventListener("error", () => {
    // 실패 이유는 비동기로 알아내지만, 그 사이 close가 다른 이유로 약속을 끝내지
    // 않도록 끝낼 자리는 지금 잡아 둔다.
    const fail = conclusion.claimFailure();
    if (!fail) return;
    void chatWebSocketConnectionError().then(fail);
  });
  socket.addEventListener("close", () => {
    handleChatSocketClose(attempt);
  });
}

export function openChatSocket(
  target: ChatSocketAttemptTarget,
  firstMessage: ChatSocketFirstMessage,
  reconnecting: boolean,
): Promise<ChatSessionInfo> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.url);
    target.socket = socket;
    bindChatSocketAttempt({
      target,
      socket,
      conclusion: createChatSocketConclusion(socket, resolve, reject),
      reconnecting,
      connected: false,
      resetSent: false,
      preConnectError: null,
    }, firstMessage);
  });
}

async function chatWebSocketConnectionError(): Promise<Error> {
  try {
    await assertRemoteChatAccess();
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  return new Error("채팅 WebSocket에 연결하지 못했습니다");
}
