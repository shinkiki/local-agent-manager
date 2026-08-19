import type {
  ChatApprovalDecision,
  ChatEvent,
  ChatInputFile,
  ChatSessionInfo,
  ChatStartRequest,
} from "../types";
import { backendHttpUrl, backendWebSocketUrl, hasNativeShell } from "./backend";
import { normalizeChatEvent } from "./chatCompatibility";
import { createChatEventBatch } from "./chatEventBatch";
import { getWebAccessStatus } from "./ipc";

export interface ChatSendOptions {
  /** 응답 중이면 현재 턴을 중단하고 이 메시지를 대기열 맨 앞에서 바로 이어간다. */
  steer?: boolean;
  attachmentIds?: string[];
}

export interface ChatConnection {
  info: ChatSessionInfo;
  send(text: string, options?: ChatSendOptions): Promise<void>;
  removeQueued(messageId: string): Promise<void>;
  approve(approvalId: string, decision: ChatApprovalDecision): Promise<void>;
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

type ChatSocketFirstMessage =
  | { type: "start"; request: ChatStartRequest }
  | { type: "attach"; chatId: string };

async function connectWebSocket(
  firstMessage: ChatSocketFirstMessage,
  onEvent: (event: ChatEvent) => void,
): Promise<ChatConnection> {
  await assertRemoteChatAccess();
  const url = backendWebSocketUrl("/api/chat");
  let socket: WebSocket | null = null;
  let detached = false;
  let takenOver = false;
  let activeChatId: string | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  const eventBatch = createChatEventBatch(onEvent);

  const scheduleReconnect = () => {
    if (detached || reconnectTimer !== null || !activeChatId) return;
    const delay = Math.min(1_000 * 2 ** reconnectAttempts, 15_000);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      const chatId = activeChatId;
      if (!chatId || detached) return;
      openSocket({ type: "attach", chatId }, true)
        .then(() => { reconnectAttempts = 0; })
        .catch(() => {
          reconnectAttempts += 1;
          if (reconnectAttempts === 5) {
            eventBatch.push({ type: "error", message: "원격 채팅 연결이 불안정합니다. 동일 세션에 계속 재연결하고 있습니다." });
          }
          scheduleReconnect();
        });
    }, delay);
  };

  const openSocket = (
    firstMessage: ChatSocketFirstMessage,
    reconnecting: boolean,
  ): Promise<ChatSessionInfo> => new Promise((resolve, reject) => {
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    let settled = false;
    let connected = false;
    let resetSent = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      nextSocket.close();
      reject(new Error("구조화 채팅 연결 시간이 초과되었습니다"));
    }, 30_000);
    nextSocket.addEventListener("open", () => {
      nextSocket.send(JSON.stringify(firstMessage));
    });
    nextSocket.addEventListener("message", (message) => {
      try {
        const event = normalizeChatEvent(JSON.parse(String(message.data)) as ChatEvent);
        if (event.type === "takenOver") {
          // 다른 화면이 이 채팅을 가져갔다. 여기서 재연결하면 두 화면이
          // 서로 구독을 뺏는 핑퐁이 되므로 이 연결은 조용히 멈춘다.
          detached = true;
          takenOver = true;
          if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
        }
        if (!(reconnecting && !connected && event.type === "error")) {
          // 재연결 attach는 백엔드가 과거 이벤트를 통째로 리플레이하므로,
          // 첫 이벤트 전에 쌓인 스트림을 비워 같은 답변이 중복 표시되지 않게 한다.
          if (reconnecting && !resetSent) {
            resetSent = true;
            eventBatch.push({ type: "replayReset" });
          }
          eventBatch.push(event);
        }
        if (!settled && event.type === "state") {
          settled = true;
          connected = true;
          activeChatId = event.session.chatId;
          window.clearTimeout(timer);
          resolve(event.session);
        } else if (!settled && event.type === "error") {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(event.message));
        }
      } catch (cause) {
        eventBatch.push({ type: "error", message: `채팅 응답을 읽지 못했습니다: ${errorMessage(cause)}` });
      }
    });
    nextSocket.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        void chatWebSocketConnectionError().then(reject);
      }
    });
    nextSocket.addEventListener("close", () => {
      eventBatch.flush();
      window.clearTimeout(timer);
      if (socket === nextSocket) socket = null;
      if (!settled) {
        settled = true;
        reject(new Error("채팅 연결이 시작 전에 종료되었습니다"));
      } else if (connected && !detached) {
        scheduleReconnect();
      }
    });
  });

  const info = await openSocket(firstMessage, false);

  const send = (message: object): Promise<void> => {
    if (takenOver) {
      return Promise.reject(new Error("다른 화면에서 이 채팅에 연결되어 이 화면의 연결이 해제되었습니다. 채팅을 다시 열어 연결하세요."));
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      scheduleReconnect();
      return Promise.reject(new Error("채팅 연결을 복구하고 있습니다. 잠시 후 다시 시도하세요."));
    }
    socket.send(JSON.stringify(message));
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
    approve(approvalId, decision) {
      return send({ type: "approve", approvalId, decision });
    },
    interrupt() {
      return send({ type: "interrupt" });
    },
    stop() {
      return send({ type: "stop" });
    },
    async detach() {
      // takenOver로 이미 detached여도 소켓·배치 정리는 마저 수행한다.
      if (!detached && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "detach" }));
      }
      detached = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
      eventBatch.dispose();
    },
  };
}

export async function uploadChatInputFile(chatId: string, file: File): Promise<ChatInputFile> {
  const headers = {
    "x-chat-id": encodeURIComponent(chatId),
    "x-file-name": encodeURIComponent(file.name),
    "x-file-type": encodeURIComponent(file.type || "application/octet-stream"),
  };
  await assertRemoteChatAccess();
  const response = await fetch(backendHttpUrl("/api/chat-attachment"), {
    method: "POST",
    headers,
    body: file,
  });
  const payload = await response.json().catch(() => null) as (ChatInputFile & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error || `첨부 파일을 올리지 못했습니다 (${response.status})`);
  if (!payload?.id) throw new Error("첨부 파일 응답이 올바르지 않습니다");
  return payload;
}

export async function readChatInputFile(chatId: string, file: ChatInputFile): Promise<Blob> {
  const response = await fetch(
    backendHttpUrl(`/api/chat-attachment/${encodeURIComponent(chatId)}/${encodeURIComponent(file.id)}`),
    { cache: "no-store" },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `첨부 파일을 읽지 못했습니다 (${response.status})`);
  }
  return response.blob();
}

export function directChatInputFileUrl(chatId: string, file: ChatInputFile): string | null {
  // Tauri CSP는 loopback 이미지를 직접 삽입하지 않습니다. 백엔드에서 읽은 Blob URL을 사용합니다.
  if (hasNativeShell()) return null;
  return backendHttpUrl(`/api/chat-attachment/${encodeURIComponent(chatId)}/${encodeURIComponent(file.id)}`);
}

export async function removeChatInputFile(chatId: string, attachmentId: string): Promise<void> {
  const args = { request: { chatId, attachmentId } };
  const response = await fetch(backendHttpUrl("/api/invoke/remove_chat_input_file"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `첨부 파일을 삭제하지 못했습니다 (${response.status})`);
  }
}

const REMOTE_WRITE_DISABLED_MESSAGE =
  "원격 write 모드가 꺼져 있어 채팅 세션을 시작할 수 없습니다. 호스트에서 원격 write 모드를 켠 뒤 다시 시도하세요.";

async function assertRemoteChatAccess(): Promise<void> {
  const access = await getWebAccessStatus();
  if (access.remote && !access.writable) {
    throw new Error(REMOTE_WRITE_DISABLED_MESSAGE);
  }
}

async function chatWebSocketConnectionError(): Promise<Error> {
  try {
    await assertRemoteChatAccess();
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  return new Error("채팅 WebSocket에 연결하지 못했습니다");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
