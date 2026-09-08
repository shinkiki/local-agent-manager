/**
 * 백엔드로 나가는 통로 그 자체 — 오류 종류, 호출 규약(`call`/`nativeCall`), 프로토콜
 * 악수, 서비스 포트·저장소 식별자 확정. `ipc.ts`는 이 통로 위에 명령 하나하나를 얹은
 * 목록이라, 통로를 고치려면 1600줄짜리 명령 목록을 헤집어야 했다. 통로만 따로 두면
 * 재연결·시간 초과·버전 판정이 한 파일 안에서 끝난다.
 *
 * 이 파일이 내보내는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는
 * 예전 그대로 `lib/ipc`다.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  assertBackendStoreIdentity,
  backendHttpUrl,
  currentBackendServicePort,
  currentBackendStoreId,
  hasNativeShell,
  LEGACY_BACKEND_SERVICE_PORT,
  setBackendServiceIdentity,
  validBackendStoreId,
  validBackendServicePort,
} from "./backend";


/** 이 UI가 요구하는 백엔드 계약. 백엔드 `REMOTE_API_PROTOCOL_VERSION`과 **정확히**
 *  같아야 하므로 한쪽만 올리면 모든 요청이 버전 불일치로 막힌다. 함께 올릴 것.
 *  9: SSH 공개키 본문 조회·키 삭제·키 메모를 지원한다.
 *  10: Antigravity 페이싱 자원의 사용량 행 조회를 지원한다. */
const EXPECTED_BACKEND_PROTOCOL_VERSION = 10;

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

/** 실패한 응답의 본문을 읽어 던질 오류를 만든다. 성공 응답에는 쓰지 않는다 —
 *  본문은 한 번만 읽을 수 있어 성공 값을 여기서 소비하면 안 된다. */
export async function responseError(response: Response, fallback: string): Promise<Error> {
  return new Error(
    errorMessageFrom(await readJsonPayload(response)) || `${fallback} (${response.status})`,
  );
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

export interface CallOptions {
  /** 응답을 기다릴 최대 시간. 지정하면 초과 시 `BackendTimeoutError`를 던진다. */
  timeoutMs?: number;
}

export async function call<T>(command: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
  await ensureBackendProtocol();
  const timeoutMs = options.timeoutMs;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller && timeoutMs
    ? setTimeout(() => { controller.abort(); }, timeoutMs)
    : null;
  let response: Response;
  try {
    response = await postJson(
      backendHttpUrl(`/api/invoke/${encodeURIComponent(command)}`),
      args,
      { signal: controller?.signal },
    );
  } catch (cause) {
    // 중단은 연결 실패가 아니라 시간 초과다. 재연결 배너 대신 재시도 가능한 오류로 알린다.
    if (controller?.signal.aborted && timeoutMs) throw new BackendTimeoutError(command, timeoutMs);
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const payload = await readJsonPayload<{ error?: string } | T>(response);
  if (!response.ok) {
    const message = errorMessageFrom(payload);
    // 503은 "지금은 다른 갱신이 돌고 있다"는 뜻이다. 오류 배너 대신 재시도로 다룬다.
    if (response.status === 503) throw new BackendBusyError(command, message || "갱신이 진행 중입니다.");
    throw new Error(message || `원격 요청에 실패했습니다 (${response.status})`);
  }
  return payload as T;
}

export function nativeCall<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!hasNativeShell()) {
    return Promise.reject(new Error("이 기능은 데스크톱 앱에서만 사용할 수 있습니다."));
  }
  return invoke<T>(command, args);
}

export interface BackendServiceSettings {
  port: number;
  storeId: string;
}

/** 서비스 설정을 다루는 네이티브 명령은 모두 같은 모양의 응답을 주고, 그 응답은
 *  포트·저장소 식별자 검증을 통과해야만 쓸 수 있다. 검증을 부르는 쪽마다 두지 않는다. */
async function backendServiceSettingsCall(
  command: string,
  args: Record<string, unknown> = {},
): Promise<BackendServiceSettings> {
  return validatedBackendServiceSettings(
    await nativeCall<BackendServiceSettings>(command, args),
  );
}

export function getBackendServiceSettings(): Promise<BackendServiceSettings> {
  return backendServiceSettingsCall("get_backend_service_settings");
}

function getActiveBackendServiceSettings(): Promise<BackendServiceSettings> {
  return backendServiceSettingsCall("get_active_backend_service_settings");
}

export function setBackendServiceSettings(port: number): Promise<BackendServiceSettings> {
  validBackendServicePort(port);
  return backendServiceSettingsCall("set_backend_service_settings", { port });
}

/** 백엔드를 가리키는 주소를 바꾼다. 주소가 바뀌면 이전 주소에서 맺은 프로토콜 악수는
 *  더 이상 이 백엔드의 것이 아니므로 함께 버린다 — 둘을 따로 두면 한쪽만 바꾼 자리가
 *  옛 악수 결과를 새 주소의 것으로 쓰게 된다. */
function useBackendIdentity(port: number, storeId: string): void {
  setBackendServiceIdentity(port, storeId);
  backendProtocolHandshake = null;
}

/** React가 도메인 API를 호출하기 전에 데스크톱 서비스 주소를 확정합니다. */
export async function initializeBackendService(): Promise<BackendServiceSettings | null> {
  if (!hasNativeShell()) return null;
  const configured = await getActiveBackendServiceSettings();
  useBackendIdentity(configured.port, configured.storeId);
  try {
    await waitForBackendProtocol(40, 125);
    return configured;
  } catch (cause) {
    // A persisted custom port can outlive an externally managed service that
    // still owns this store on the legacy deployment port. Reuse that port only
    // for a network-level miss and only after its stable storeId matches.
    if (!(cause instanceof RemoteConnectionError)
      || configured.port === LEGACY_BACKEND_SERVICE_PORT) {
      throw cause;
    }
    useBackendIdentity(LEGACY_BACKEND_SERVICE_PORT, configured.storeId);
    try {
      await waitForBackendProtocol(8, 125);
      return { ...configured, port: LEGACY_BACKEND_SERVICE_PORT };
    } catch (fallbackCause) {
      useBackendIdentity(configured.port, configured.storeId);
      if (!(fallbackCause instanceof RemoteConnectionError)) throw fallbackCause;
      throw cause;
    }
  }
}

async function waitForBackendProtocol(attempts: number, delayMs: number): Promise<WebAccessStatus> {
  let lastError: RemoteConnectionError | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await ensureBackendProtocol();
    } catch (cause) {
      if (!(cause instanceof RemoteConnectionError)) throw cause;
      lastError = cause;
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError ?? new RemoteConnectionError("응답 없음");
}

function validatedBackendServiceSettings(settings: BackendServiceSettings): BackendServiceSettings {
  if (!settings || typeof settings !== "object") {
    throw new Error("백엔드 서비스 설정 응답이 올바르지 않습니다.");
  }
  return {
    port: validBackendServicePort(settings.port),
    storeId: validBackendStoreId(settings.storeId),
  };
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

function ensureBackendProtocol(): Promise<WebAccessStatus> {
  if (!backendProtocolHandshake) {
    backendProtocolHandshake = getWebAccessStatus().catch((cause) => {
      backendProtocolHandshake = null;
      throw cause;
    });
  }
  return backendProtocolHandshake;
}

export interface WebAccessStatusOptions {
  /** 지정하면 이 시간 안에 응답이 없을 때 요청을 끊고 연결 실패로 알린다. */
  timeoutMs?: number;
}

export async function getWebAccessStatus(options: WebAccessStatusOptions = {}): Promise<WebAccessStatus> {
  const response = await remoteFetch(backendHttpUrl("/api/access"), {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs),
  });
  const payload = await readJsonPayload<Partial<WebAccessStatus> & { error?: string }>(response);
  if (!response.ok) {
    throw new Error(errorMessageFrom(payload) || `원격 접근 상태를 확인하지 못했습니다 (${response.status})`);
  }
  if (payload?.protocolVersion !== EXPECTED_BACKEND_PROTOCOL_VERSION) {
    throw new Error(`백엔드 서버 API 버전이 호환되지 않습니다 (필요 ${EXPECTED_BACKEND_PROTOCOL_VERSION}, 응답 ${String(payload?.protocolVersion ?? "없음")}). 서버를 최신 빌드로 다시 시작하세요.`);
  }
  if ((payload.mode !== "local" && payload.mode !== "tailscale")
    || typeof payload.remote !== "boolean" || typeof payload.writable !== "boolean"
    || typeof payload.instanceId !== "string" || payload.instanceId.length === 0) {
    throw new Error("원격 접근 상태 응답이 올바르지 않습니다.");
  }
  const expectedStoreId = hasNativeShell() ? currentBackendStoreId() : null;
  if (hasNativeShell() && expectedStoreId === null) {
    throw new Error("백엔드 서비스 저장소 식별자가 초기화되지 않았습니다.");
  }
  const storeId = assertBackendStoreIdentity(payload.storeId, expectedStoreId);
  const backendPort = payload.backendPort === undefined
    ? payload.mode === "tailscale"
      ? LEGACY_BACKEND_SERVICE_PORT
      : currentBackendServicePort() ?? LEGACY_BACKEND_SERVICE_PORT
    : validBackendServicePort(payload.backendPort);
  return {
    protocolVersion: payload.protocolVersion,
    storeId,
    instanceId: payload.instanceId,
    backendPort,
    mode: payload.mode,
    remote: payload.remote,
    writable: payload.writable,
  };
}
