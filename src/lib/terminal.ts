import type {
  TerminalEvent,
  TerminalAccountLoginRequest,
  TerminalOpenRequest,
  TerminalSetupRequest,
  TerminalSessionInfo,
} from "../types";
import { backendWebSocketUrl } from "./backend";
import { getWebAccessStatus } from "./ipc";

export interface TerminalConnection {
  info: TerminalSessionInfo;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): Promise<void>;
  detach(): Promise<void>;
}

export async function connectTerminal(
  request: TerminalOpenRequest,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalConnection> {
  return connectWebSocket(request, onEvent);
}

export async function connectSetupTerminal(
  request: TerminalSetupRequest,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalConnection> {
  return connectWebSocket(request, onEvent);
}

export async function connectAccountLoginTerminal(
  request: TerminalAccountLoginRequest,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalConnection> {
  return connectWebSocket(request, onEvent);
}

async function connectWebSocket(
  request: TerminalOpenRequest | TerminalSetupRequest | TerminalAccountLoginRequest,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalConnection> {
  const access = await getWebAccessStatus();
  if (access.remote && !access.writable) {
    throw new Error("원격 write 모드가 꺼져 있어 터미널을 시작할 수 없습니다.");
  }
  if (access.remote && !("sessionId" in request) && !("loginId" in request)) {
    throw new Error("CLI 설정 터미널은 백엔드 서비스가 실행 중인 로컬 컴퓨터에서만 열 수 있습니다.");
  }
  const socket = new WebSocket(backendWebSocketUrl("/api/terminal"));
  socket.binaryType = "arraybuffer";

  const info = await new Promise<TerminalSessionInfo>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        reject(new Error("터미널 연결 시간이 초과되었습니다"));
      }
    }, 12_000);

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
        if (!settled && event.type === "state") {
          settled = true;
          window.clearTimeout(timer);
          resolve(event.session);
        } else if (!settled && event.type === "error") {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(event.message));
        }
      } catch (cause) {
        onEvent({ type: "error", message: `터미널 응답을 읽지 못했습니다: ${errorMessage(cause)}` });
      }
    });
    socket.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        reject(new Error("터미널 WebSocket에 연결하지 못했습니다"));
      }
    });
    socket.addEventListener("close", () => {
      window.clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error("터미널 연결이 시작 전에 종료되었습니다"));
      }
    });
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
