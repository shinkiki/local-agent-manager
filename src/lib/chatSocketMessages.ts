import type { ChatApprovalDecision, ChatStartRequest } from "../types";

// 채팅 소켓으로 나가는 메시지 한 벌 — 연결을 여는 첫 메시지와 그 뒤의 조작 명령, 그리고
// 그것을 소켓에 싣는 한 걸음. 소켓에서 올라오는 이벤트를 읽는 일(chatSocketAttempt.ts)과
// 연결의 수명주기(chatSocket.ts)와는 바뀌는 이유가 다르다. 백엔드가 받는 명령이 늘거나
// 필드가 바뀔 때만 이 파일을 손댄다.
//
// 나가는 메시지가 세 자리에 서로 다른 굳기로 적혀 있었다 — 첫 메시지만 타입이 있었고,
// 조작 명령의 모양은 조작 창구(chat.ts)가 혼자 들고 있다가 소켓 경계에서 넓은 `object`로
// 풀렸으며, `detach`는 아무 데도 적히지 않은 채 수명주기 안에서 익명 객체로 만들어졌다.
// 그래서 명령 이름과 필드의 짝이 어긋나도 경계에서 알아채지 못했고, 나가는 명령이 모두
// 몇 갈래인지는 세 파일을 함께 읽어야만 알 수 있었다. 갈래는 이 한 벌에서만 늘린다.
//
// 그 한 벌을 세운 뒤에도 필드 하나가 밖으로 새 있었다 — 승인 카드의 sudo 비밀값은 조작
// 창구에서 객체 펼치기로 얹혀 나가는데, 펼친 칸은 타입 검사를 지나지 않으므로 이 한 벌에는
// 적히지 않은 채 백엔드까지 닿았다. 그래서 여기만 읽어서는 나가는 승인 명령의 모양을 알 수
// 없었다. 선택 칸과 그 칸이 비었을 때 무엇이 나가는지까지 이 파일이 정하고, 조작 창구는
// 화면이 준 값을 그대로 넘기기만 한다.

/** 소켓을 연 뒤 맨 처음 보내는 메시지. 이 한 건이 새 실행인지 기존 실행 붙기인지를 정한다. */
export type ChatSocketFirstMessage =
  | { type: "start"; request: ChatStartRequest }
  | { type: "attach"; chatId: string };

/**
 * 연결이 선 뒤 화면 조작을 소켓에 싣는 명령 모양. 조작별 필수 필드와 빈 명령을 한 벌로
 * 묶어, 백엔드로 보내는 값은 그대로 두고 짝이 어긋나는 것만 타입이 막게 한다.
 */
export type ChatSocketCommand =
  | { type: "send"; text: string; steer: boolean; attachmentIds: string[] }
  | { type: "removeQueued"; messageId: string }
  | {
    type: "approve";
    approvalId: string;
    decision: ChatApprovalDecision;
    answers: Record<string, string>;
    /**
     * C9-19. sudo 비밀번호를 요구한 SSH 승인 카드에 사용자가 입력한 값. 그 밖의 승인에서는
     * 없다. 백엔드 `ChatClientMessage::Approve`의 `secret`과 짝이며, `answers`와 갈라 두는
     * 것은 그쪽이 카드에 되비쳐 그려지는 값이기 때문이다 — 비밀값이 그 통로로 가면 화면에
     * 그대로 남는다.
     */
    secret?: string;
    /**
     * C17. 이 카드에 넣은 값을 기기 보관으로도 옮길지. 비밀값 요청 카드의 "비밀값 저장"
     * 체크박스에서만 온다. `secret`과 갈라 두는 것이 아니라 함께 가야 하는 값이다 — 저장은
     * 값이 들어오는 그 순간에만 할 수 있고, 값은 어디에도 남지 않으므로 나중에 따라갈 수 없다.
     */
    saveSecret?: boolean;
  }
  | { type: "interrupt" }
  | { type: "stop" }
  /** 이 화면만 구독을 놓는다. 실행은 백엔드에 그대로 남는다. */
  | { type: "detach" };

/**
 * 화면이 비워 둔 칸을 채워 `send` 명령 한 건을 짓는다. 어느 칸이 선택이고 비었을 때 무엇이
 * 나가는지는 명령의 모양이 정하는 것이므로, 조작 창구가 아니라 이 한 벌 옆에서 정한다.
 */
export function chatSendCommand(
  text: string,
  options?: { steer?: boolean; attachmentIds?: string[] },
): ChatSocketCommand {
  return {
    type: "send",
    text,
    steer: options?.steer ?? false,
    attachmentIds: options?.attachmentIds ?? [],
  };
}

/**
 * `approve` 명령 한 건을 짓는다. 비밀값은 실제로 입력된 때만 실어, 빈 문자열이 "빈 비밀번호를
 * 넣었다"로 백엔드에 닿지 않게 한다(백엔드는 이 칸이 없는 것과 빈 값을 다르게 다룬다).
 */
export function chatApproveCommand(
  approvalId: string,
  decision: ChatApprovalDecision,
  answers?: Record<string, string>,
  secret?: string,
  saveSecret?: boolean,
): ChatSocketCommand {
  return {
    type: "approve",
    approvalId,
    decision,
    answers: answers ?? {},
    ...(secret ? { secret } : {}),
    // 값이 실리지 않은 명령에 저장 의사만 실어 보내지 않는다 — 저장할 값이 없다.
    ...(secret && saveSecret ? { saveSecret: true } : {}),
  };
}

/** 나가는 메시지 한 건을 소켓에 싣는다. 보낼 수 있는 상태인지는 부르는 쪽이 이미 가렸다. */
export function writeChatSocketMessage(
  socket: WebSocket,
  message: ChatSocketFirstMessage | ChatSocketCommand,
): void {
  socket.send(JSON.stringify(message));
}
