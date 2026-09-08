import type {
  TerminalEvent,
  TerminalAccountLoginRequest,
  TerminalOpenRequest,
  TerminalSetupRequest,
  TerminalSessionInfo,
} from "../types";
import { backendWebSocketUrl } from "./backend";
import { getWebAccessStatus } from "./ipc";
import { errorText } from "./errorText";

export interface TerminalConnection {
  info: TerminalSessionInfo;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): Promise<void>;
  detach(): Promise<void>;
}

/** 열기·CLI 설정·계정 로그인은 요청 본문만 다르고 연결 절차는 같다. 호출부가 요청
 * 종류를 잘못 섞지 않도록 이름과 요청 타입만 따로 두고, 절차는 한 벌만 쓴다. */
export const connectTerminal: TerminalConnector<TerminalOpenRequest> = connectWebSocket;
export const connectSetupTerminal: TerminalConnector<TerminalSetupRequest> = connectWebSocket;
export const connectAccountLoginTerminal: TerminalConnector<TerminalAccountLoginRequest> = connectWebSocket;

type TerminalConnector<T> = (
  request: T,
  onEvent: (event: TerminalEvent) => void,
) => Promise<TerminalConnection>;

async function connectWebSocket(
  request: TerminalOpenRequest | TerminalSetupRequest | TerminalAccountLoginRequest,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalConnection> {
  const access = await getWebAccessStatus();
  if (access.remote && !access.writable) {
    throw new Error("원격 편집이 꺼져 있어 터미널을 시작할 수 없습니다. 호스트의 설정 → 백엔드 서비스에서 원격 편집 허용을 켠 뒤 다시 시도하세요.");
  }
  if (access.remote && !("sessionId" in request) && !("loginId" in request)) {
    throw new Error("CLI 설정 터미널은 백엔드 서비스가 실행 중인 로컬 컴퓨터에서만 열 수 있습니다.");
  }
  const socket = new WebSocket(backendWebSocketUrl("/api/terminal"));
  socket.binaryType = "arraybuffer";

  const info = await new Promise<TerminalSessionInfo>((resolve, reject) => {
    let settled = false;
    // 성립(state)·거절(error·타임아웃·소켓 오류·조기 종료)이 어느 경로로 오든 처리는 같다 —
    // 처음 온 것 하나만 채택하고 타임아웃을 거둔다.
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      finish();
    };
    const failWith = (message: string) => settle(() => reject(new Error(message)));
    const timer = window.setTimeout(() => settle(() => {
      socket.close();
      reject(new Error("터미널 연결 시간이 초과되었습니다"));
    }), 12_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "open", request }));
    });
    socket.addEventListener("message", (message) => {
      if (message.data instanceof ArrayBuffer) {
        onEvent({ type: "output", data: new Uint8Array(message.data) });
        return;
      }
      try {
        const event = JSON.parse(String(message.data)) as TerminalEvent;
        onEvent(event);
        if (event.type === "state") settle(() => resolve(event.session));
        else if (event.type === "error") failWith(event.message);
      } catch (cause) {
        onEvent({ type: "error", message: `터미널 응답을 읽지 못했습니다: ${errorText(cause)}` });
      }
    });
    socket.addEventListener("error", () => failWith("터미널 WebSocket에 연결하지 못했습니다"));
    socket.addEventListener("close", () => failWith("터미널 연결이 시작 전에 종료되었습니다"));
  });

  let detached = false;
  return {
    info,
    input(data) {
      sendSocket(socket, { type: "input", data });
    },
    resize(cols, rows) {
      sendSocket(socket, { type: "resize", cols, rows });
    },
    async stop() {
      sendSocket(socket, { type: "stop" });
    },
    async detach() {
      if (detached) return;
      detached = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "detach" }));
      }
      socket.close();
    },
  };
}

function sendSocket(socket: WebSocket, message: object): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
