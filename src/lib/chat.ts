import type {
  ChatApprovalDecision,
  ChatEvent,
  ChatSessionInfo,
  ChatStartRequest,
  ProviderId,
} from "../types";
import {
  chatApproveCommand,
  chatSendCommand,
  detachChatSocket,
  openChatRuntime,
  sendChatSocketMessage,
  type ChatSocketCommand,
  type ChatSocketFirstMessage,
  type ChatSocketRuntime,
} from "./chatSocket.ts";

// 첨부 파일 API는 chatAttachments로, 소켓 수명주기는 chatSocket으로 옮겼다. 화면들이
// 채팅 창구 하나만 알면 되도록 첨부 API는 여기서 다시 내보낸다.
export {
  directChatInputFileUrl,
  readChatInputFile,
  removeChatInputFile,
  uploadChatInputFile,
} from "./chatAttachments.ts";

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
  /**
   * 승인 카드에 답한다. `answers`는 질의응답 카드에서 고른 답(질문 원문 -> 답)이고 그 밖의
   * 승인에서는 생략한다. `secret`은 C9-19의 sudo 비밀번호 전용 통로다 — `answers`는 카드에
   * 그대로 되비쳐 그려지므로 비밀값을 실을 수 없다. `saveSecret`은 C17의 "비밀값 저장"
   * 체크박스이며, 값이 실린 명령에서만 뜻이 있다.
   */
  approve(approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>, secret?: string, saveSecret?: boolean): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  detach(): Promise<void>;
}

/** 공급자가 공식 fork를 제공하는지. 백엔드 `validate_fork_request`와 같은 목록이다. */
export function supportsSessionFork(source: ProviderId): boolean {
  return source === "codex" || source === "claude";
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

async function connectWebSocket(
  firstMessage: ChatSocketFirstMessage,
  onEvent: (event: ChatEvent) => void,
): Promise<ChatConnection> {
  const { runtime, info } = await openChatRuntime(firstMessage, onEvent);
  return chatConnection(runtime, info);
}

/** 화면이 쓰는 조작 창구. 각 조작을 소켓 메시지 한 건으로 옮기는 일만 한다. */
function chatConnection(runtime: ChatSocketRuntime, info: ChatSessionInfo): ChatConnection {
  const send = (message: ChatSocketCommand) => sendChatSocketMessage(runtime, message);
  return {
    info,
    send(text, options) {
      return send(chatSendCommand(text, options));
    },
    removeQueued(messageId) {
      return send({ type: "removeQueued", messageId });
    },
    approve(approvalId, decision, answers, secret, saveSecret) {
      return send(chatApproveCommand(approvalId, decision, answers, secret, saveSecret));
    },
    interrupt() {
      return send({ type: "interrupt" });
    },
    stop() {
      return send({ type: "stop" });
    },
    detach() {
      detachChatSocket(runtime);
      return Promise.resolve();
    },
  };
}
