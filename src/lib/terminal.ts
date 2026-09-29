import type {
  TerminalEvent,
  TerminalAccountLoginRequest,
  TerminalOpenRequest,
  TerminalSetupRequest,
  TerminalSessionInfo,
  TerminalSshRequest,
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

type TerminalRequest =
  | TerminalOpenRequest
  | TerminalSetupRequest
  | TerminalAccountLoginRequest
  | TerminalSshRequest;

type TerminalConnector<T> = (
  request: T,
  onEvent: (event: TerminalEvent) => void,
) => Promise<TerminalConnection>;

/**
 * 터미널 갈래. 요청 본문은 갈래마다 다르지만 연결 절차는 같고, 다른 것은 원격 화면에서
 * 열 수 있는지 하나뿐이다. 그 판정을 요청 본문의 필드 유무로 되짚지 않고 갈래를 그대로
 * 받는다 — 필드로 되짚으면 요청 타입에 필드가 하나 늘어나는 것만으로 호스트 전용
 * 터미널이 조용히 원격에 열린다.
 */
type TerminalKind = "session" | "setup" | "accountLogin" | "ssh";

/**
 * 원격(웹) 화면에서 열 수 없는 갈래와 그 이유. 백엔드도 같은 판정으로 거절하지만,
 * 소켓을 열기 전에 같은 문구로 알려 헛되이 연결을 시도하지 않게 한다. 표에 없는
 * 갈래는 원격에서도 연다.
 */
const HOST_ONLY_TERMINALS: Partial<Record<TerminalKind, string>> = {
  ssh: "SSH 터미널은 백엔드 서비스가 실행 중인 로컬 컴퓨터에서만 열 수 있습니다.",
  setup: "CLI 설정 터미널은 백엔드 서비스가 실행 중인 로컬 컴퓨터에서만 열 수 있습니다.",
};

/** 호출부가 요청 종류를 잘못 섞지 않도록 이름과 요청 타입만 따로 두고, 절차는 한 벌만 쓴다. */
function terminalConnector<T extends TerminalRequest>(kind: TerminalKind): TerminalConnector<T> {
  return (request, onEvent) => connectWebSocket(kind, request, onEvent);
}

export const connectTerminal = terminalConnector<TerminalOpenRequest>("session");
export const connectSetupTerminal = terminalConnector<TerminalSetupRequest>("setup");
export const connectAccountLoginTerminal = terminalConnector<TerminalAccountLoginRequest>("accountLogin");
export const connectSshTerminal = terminalConnector<TerminalSshRequest>("ssh");

/**
 * 원격(웹) 화면에서 열 수 없는 요청인지 먼저 가른다. 소켓을 열기 전에 거절해야 하는 것은
 * 두 가지다 — 원격 편집이 꺼져 있는 상태와 호스트 전용 갈래. 백엔드도 같은 판정을 하지만
 * 여기서 먼저 걸러 헛된 연결과 그만큼 늦게 오는 오류 문구를 없앤다.
 */
async function assertTerminalAllowed(kind: TerminalKind): Promise<void> {
  const access = await getWebAccessStatus();
  if (!access.remote) return;
  if (!access.writable) {
    throw new Error("원격 편집이 꺼져 있어 터미널을 시작할 수 없습니다. 호스트의 설정 → 백엔드 서비스에서 원격 편집 허용을 켠 뒤 다시 시도하세요.");
  }
  const hostOnly = HOST_ONLY_TERMINALS[kind];
  if (hostOnly) throw new Error(hostOnly);
}

/**
 * 소켓이 열리고 세션이 성립할 때까지. 성립 전후로 이벤트 처리가 달라지는 곳은 여기뿐이라
 * (성립·거절 중 처음 온 것 하나만 채택한다) 성립 뒤의 조작과 떼어 둔다. 성립한 뒤에도
 * 계속 오는 출력·상태 이벤트는 이 리스너가 그대로 `onEvent`로 흘려보낸다.
 */
function terminalHandshake(
  socket: WebSocket,
  request: TerminalRequest,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalSessionInfo> {
  return new Promise<TerminalSessionInfo>((resolve, reject) => {
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
}

/**
 * 성립한 세션을 조작하는 손잡이. 소켓이 이미 닫혔을 때 보내려는 시도는 모두 `sendSocket`이
 * 삼키고, 끊기는 두 번 불러도 한 번만 나가게 `detached`로 막는다.
 */
function terminalConnection(socket: WebSocket, info: TerminalSessionInfo): TerminalConnection {
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

/**
 * 터미널 한 벌을 연다. 절차는 갈래와 무관하게 셋으로 나뉜다 — 이 화면에서 열어도 되는지,
 * 소켓을 열어 세션이 성립할 때까지 기다리기, 성립한 세션의 손잡이 만들기.
 */
async function connectWebSocket(
  kind: TerminalKind,
  request: TerminalRequest,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalConnection> {
  await assertTerminalAllowed(kind);
  const socket = new WebSocket(backendWebSocketUrl("/api/terminal"));
  socket.binaryType = "arraybuffer";
  const info = await terminalHandshake(socket, request, onEvent);
  return terminalConnection(socket, info);
}

function sendSocket(socket: WebSocket, message: object): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
