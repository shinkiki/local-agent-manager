/**
 * 백엔드로 나가는 통로 그 자체 — 오류 종류, 호출 규약(`call`/`nativeCall`), 프로토콜
 * 악수와 그 응답의 계약 판정. `ipc.ts`는 이 통로 위에 명령 하나하나를 얹은 목록이라,
 * 통로를 고치려면 1600줄짜리 명령 목록을 헤집어야 했다. 통로만 따로 두면 재연결·
 * 시간 초과·버전 판정이 한 파일 안에서 끝난다.
 *
 * 그 통로가 **어느 주소로** 나가는지 정하는 일은 `ipcBackendService`가 가진다. 저장된
 * 서비스 설정과 레거시 포트 되짚기는 앱 기동 순서의 문제고, 여기 함께 두는 동안은
 * 시간 초과·503 판정 사이에 포트 규칙이 끼어 있었다. 의존은 한 방향이라 이 파일은
 * 저쪽을 모른다.
 *
 * 이 파일이 내보내는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는
 * 예전 그대로 `lib/ipc`다.
 */
import { invoke } from "@tauri-apps/api/core";
import { backendError } from "./backendErrors";
import {
  assertBackendStoreIdentity,
  backendHttpUrl,
  currentBackendServicePort,
  currentBackendStoreId,
  hasNativeShell,
  LEGACY_BACKEND_SERVICE_PORT,
  validBackendServicePort,
} from "./backend";


/** 이 UI가 요구하는 백엔드 계약. 백엔드 `REMOTE_API_PROTOCOL_VERSION`과 **정확히**
 *  같아야 하므로 한쪽만 올리면 모든 요청이 버전 불일치로 막힌다. 함께 올릴 것.
 *  9: SSH 공개키 본문 조회·키 삭제·키 메모를 지원한다.
 *  10: Antigravity 페이싱 자원의 사용량 행 조회를 지원한다. */
const EXPECTED_BACKEND_PROTOCOL_VERSION = 11;

/** 단일 백엔드까지 요청이 도달하지 못한 네트워크 수준 실패. */
export class RemoteConnectionError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Agent Manager 백엔드 서비스에 연결하지 못했습니다. 서비스가 실행 중인지 확인하세요.");
    this.name = "RemoteConnectionError";
    this.cause = cause;
  }
}

/** 백엔드 오류 응답 본문에서 사용자에게 보일 문구를 꺼낸다. 본문이 JSON이 아니거나
 *  `error` 필드가 비어 있으면 null이고, 부르는 쪽이 상태 코드를 담은 기본 문구를 쓴다. */
function errorMessageFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
  const message = (payload as { error?: unknown }).error;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/** 실패한 응답에서 던질 오류. 본문이 문구를 담고 있으면 그것을 쓰고, 없으면 상태 코드를
 *  붙인 기본 문구로 떨어진다. 명령 호출·접근 상태 조회·파일 다운로드가 각자 이 조립을
 *  들고 있으면 한 자리만 상태 코드를 빠뜨려도 원인을 알 수 없는 오류가 화면에 남는다.
 *
 *  본문이 안정 코드를 함께 보냈으면 문구는 화면이 고른다(`backendErrors.ts`) — 백엔드
 *  문장은 한국어뿐이라 다른 언어에서는 그대로 쓸 수 없다. */
function failedResponseError(payload: unknown, status: number, fallback: string): Error {
  return backendError(payload, errorMessageFrom(payload) || `${fallback} (${status})`);
}

/** 실패한 응답의 본문을 읽어 던질 오류를 만든다. 성공 응답에는 쓰지 않는다 —
 *  본문은 한 번만 읽을 수 있어 성공 값을 여기서 소비하면 안 된다. */
export async function responseError(response: Response, fallback: string): Promise<Error> {
  return failedResponseError(await readJsonPayload(response), response.status, fallback);
}

export async function remoteFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    throw new RemoteConnectionError(cause);
  }
}

/** 백엔드로 나가는 JSON 본문 POST. 요청 조립(메서드·헤더·직렬화)이 호출·다운로드
 *  양쪽에 흩어져 있으면 헤더 하나를 바꿀 때 빠뜨리는 자리가 생긴다. */
export function postJson(
  url: string,
  body: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  return remoteFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

/** 응답 본문을 JSON으로 읽되 본문이 비었거나 JSON이 아니면 null. 성공·실패 응답
 *  모두 같은 방식으로 읽으므로 본문을 두 번 소비하지 않도록 한 번만 부른다. */
async function readJsonPayload<T>(response: Response): Promise<T | null> {
  return await response.json().catch(() => null) as T | null;
}

/** 다른 갱신이 진행 중이어서 백엔드가 받지 않은 요청(503). 오류가 아니라 재시도 신호다. */
export class BackendBusyError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = "BackendBusyError";
    this.command = command;
  }
}

/** 백엔드가 제한 시간 안에 응답하지 않은 요청. 무한 대기 대신 재시도할 수 있게 한다. */
export class BackendTimeoutError extends Error {
  readonly command: string;

  constructor(command: string, timeoutMs: number) {
    super(`요청이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다 (${command}). 잠시 후 다시 시도하세요.`);
    this.name = "BackendTimeoutError";
    this.command = command;
  }
}

/**
 * 제한시간을 걸 수 있는 요청의 선택지. 명령 POST(`call`)와 접근 상태 조회
 * (`getWebAccessStatus`)가 같은 모양을 `CallOptions`·`WebAccessStatusOptions`라는 다른
 * 이름으로 각자 들고 있었다. 필드도 뜻도 하나뿐인데 이름이 둘이라, 제한시간에 칸을 하나
 * 더할 때 어느 쪽이 정본인지 정하는 일부터 해야 했고 실제로 두 선언의 주석이 서로 다른
 * 실패를 약속하고 있었다.
 *
 * 초과했을 때 **무엇으로 알릴지는 호출부가 계속 정한다** — 명령 POST는 재시도 가능한
 * `BackendTimeoutError`로, 접근 상태 조회는 연결 실패(`RemoteConnectionError`)로 알린다.
 * 여기 모으는 것은 "이 시간 안에 끊는다"는 선택지 자체뿐이다.
 */
export interface RequestTimeoutOptions {
  /** 응답을 기다릴 최대 시간. 지정하지 않으면 끊지 않고 기다린다. */
  timeoutMs?: number;
}

/**
 * 제한시간이 있는 요청의 중단 신호. 값을 주지 않으면(또는 0이면) 신호 없이 기다린다.
 *
 * 명령 POST는 `AbortController`와 `setTimeout`·`clearTimeout`을 손으로 엮고, 접근 상태
 * 조회는 `AbortSignal.timeout`을 쓰고 있었다. 같은 "이 시간 안에 끊는다"가 두 벌이라
 * 한쪽만 고치면 제한시간의 뜻이 갈라지고, 손으로 엮은 쪽은 타이머 해제를 빠뜨릴 자리도
 * 남는다. 신호를 세우는 일은 여기 한 벌만 두고, 중단을 무엇으로 알릴지는 그 뜻을 아는
 * 호출부가 계속 정한다 — 명령 POST는 재시도 가능한 시간 초과로, 접근 상태 조회는 연결
 * 실패로 알린다.
 */
function requestTimeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
}

/** 명령 POST의 제한시간 수명주기. 응답 해석과 503 판정은 호출 계약을 아는 `call`이 맡는다. */
async function remoteCommandResponse(
  command: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Response> {
  const signal = requestTimeoutSignal(timeoutMs);
  try {
    return await postJson(
      backendHttpUrl(`/api/invoke/${encodeURIComponent(command)}`),
      args,
      { signal },
    );
  } catch (cause) {
    // 중단은 연결 실패가 아니라 시간 초과다. 재연결 배너 대신 재시도 가능한 오류로 알린다.
    if (signal?.aborted && timeoutMs) throw new BackendTimeoutError(command, timeoutMs);
    throw cause;
  }
}

export async function call<T>(command: string, args: Record<string, unknown> = {}, options: RequestTimeoutOptions = {}): Promise<T> {
  await ensureBackendProtocol();
  const response = await remoteCommandResponse(command, args, options.timeoutMs);
  const payload = await readJsonPayload<{ error?: string } | T>(response);
  if (!response.ok) {
    // 503은 "지금은 다른 갱신이 돌고 있다"는 뜻이다. 오류 배너 대신 재시도로 다룬다.
    if (response.status === 503) {
      throw new BackendBusyError(command, errorMessageFrom(payload) || "갱신이 진행 중입니다.");
    }
    throw failedResponseError(payload, response.status, "원격 요청에 실패했습니다");
  }
  return payload as T;
}

export function nativeCall<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!hasNativeShell()) {
    return Promise.reject(new Error("이 기능은 데스크톱 앱에서만 사용할 수 있습니다."));
  }
  return invoke<T>(command, args);
}

export interface WebAccessStatus {
  protocolVersion: number;
  storeId: string;
  /**
   * 백엔드 프로세스의 실행 식별자. 재기동하면 값이 바뀐다. 실행 중인 채팅은 그 프로세스
   * 메모리에만 있으므로, 이 값이 달라졌으면 붙어 있던 대화는 되살릴 수 없다.
   */
  instanceId: string;
  backendPort: number;
  mode: "local" | "tailscale";
  remote: boolean;
  writable: boolean;
}

let backendProtocolHandshake: Promise<WebAccessStatus> | null = null;

/**
 * 맺어 둔 악수를 버린다. 백엔드를 가리키는 주소가 바뀌면 이전 주소에서 맺은 결과는 더
 * 이상 이 백엔드의 것이 아니다. 주소를 정하는 쪽(`ipcBackendService`)이 부른다 — 악수
 * 결과를 들고 있는 것은 요청마다 그것을 기다리는 이 통로이므로, 값 자체는 여기 남는다.
 */
export function resetBackendProtocolHandshake(): void {
  backendProtocolHandshake = null;
}

export function ensureBackendProtocol(): Promise<WebAccessStatus> {
  if (!backendProtocolHandshake) {
    backendProtocolHandshake = getWebAccessStatus().catch((cause) => {
      backendProtocolHandshake = null;
      throw cause;
    });
  }
  return backendProtocolHandshake;
}

/** 제한시간을 넘기면 요청을 끊고 연결 실패(`RemoteConnectionError`)로 알린다 — 악수를
 *  기다리는 쪽에는 "이 주소는 닿지 않는다"가 곧 결론이라 재시도 신호와 구분하지 않는다. */
export async function getWebAccessStatus(options: RequestTimeoutOptions = {}): Promise<WebAccessStatus> {
  const response = await remoteFetch(backendHttpUrl("/api/access"), {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: requestTimeoutSignal(options.timeoutMs),
  });
  const payload = await readJsonPayload<WebAccessPayload>(response);
  if (!response.ok) {
    throw failedResponseError(payload, response.status, "원격 접근 상태를 확인하지 못했습니다");
  }
  return validatedWebAccessStatus(payload);
}

/** 악수 응답의 원본. 필드가 다 있는지는 아직 모른다. */
type WebAccessPayload = Partial<WebAccessStatus> & { error?: string };

/** 필수 필드가 모두 제 모양으로 온 악수 응답. 확정 단계는 이 모양만 읽는다. */
type CheckedWebAccessPayload =
  WebAccessPayload & Pick<WebAccessStatus, "mode" | "remote" | "writable" | "instanceId">;

function hasRequiredWebAccessFields(payload: WebAccessPayload): payload is CheckedWebAccessPayload {
  return (payload.mode === "local" || payload.mode === "tailscale")
    && typeof payload.remote === "boolean"
    && typeof payload.writable === "boolean"
    && typeof payload.instanceId === "string" && payload.instanceId.length > 0;
}

/**
 * 응답이 이 UI가 읽을 수 있는 계약인지. 버전이 다르면 나머지 필드의 뜻을 보장할 수 없으므로
 * 버전을 먼저 보고, 그다음 필수 필드가 제 모양으로 왔는지 본다.
 */
function checkedWebAccessPayload(payload: WebAccessPayload | null): CheckedWebAccessPayload {
  if (payload?.protocolVersion !== EXPECTED_BACKEND_PROTOCOL_VERSION) {
    throw new Error(`백엔드 서버 API 버전이 호환되지 않습니다 (필요 ${EXPECTED_BACKEND_PROTOCOL_VERSION}, 응답 ${String(payload?.protocolVersion ?? "없음")}). 서버를 최신 빌드로 다시 시작하세요.`);
  }
  if (!hasRequiredWebAccessFields(payload)) {
    throw new Error("원격 접근 상태 응답이 올바르지 않습니다.");
  }
  return payload;
}

/** 응답의 저장소 식별자를 대조할 기준. 네이티브 셸이 아니면 대조할 것이 없어 null이다. */
function expectedBackendStoreId(): string | null {
  if (!hasNativeShell()) return null;
  const storeId = currentBackendStoreId();
  if (storeId === null) throw new Error("백엔드 서비스 저장소 식별자가 초기화되지 않았습니다.");
  return storeId;
}

/**
 * 이 백엔드가 실제로 듣고 있는 포트. `backendPort`가 없는 응답은 옛 백엔드이므로 그때만
 * 셸이 아는 포트로 떨어뜨리고, tailscale 경유는 셸의 포트가 이 백엔드의 것이 아니라
 * 배포 포트다.
 */
function resolvedBackendPort(port: number | undefined, mode: WebAccessStatus["mode"]): number {
  if (port !== undefined) return validBackendServicePort(port);
  if (mode === "tailscale") return LEGACY_BACKEND_SERVICE_PORT;
  return currentBackendServicePort() ?? LEGACY_BACKEND_SERVICE_PORT;
}

/**
 * 악수 응답을 이 UI가 쓸 수 있는 값으로 확정한다. 판정 넷(계약 버전·필수 필드·저장소
 * 식별자·포트)은 각자 실패 문구와 대체값 규칙을 가지는데, 한 함수 안에 늘어놓으면 어느
 * 줄이 어느 판정에 속하는지 세어 가며 읽어야 했다. 판정마다 이름을 주고, 여기에는
 * "확인된 응답을 그대로 옮긴다"만 남긴다.
 */
function validatedWebAccessStatus(payload: WebAccessPayload | null): WebAccessStatus {
  const checked = checkedWebAccessPayload(payload);
  return {
    protocolVersion: EXPECTED_BACKEND_PROTOCOL_VERSION,
    storeId: assertBackendStoreIdentity(checked.storeId, expectedBackendStoreId()),
    instanceId: checked.instanceId,
    backendPort: resolvedBackendPort(checked.backendPort, checked.mode),
    mode: checked.mode,
    remote: checked.remote,
    writable: checked.writable,
  };
}
