/**
 * 데스크톱 셸이 어느 백엔드를 쓸지 정하는 일 — 저장된 서비스 설정 읽기·쓰기, 그 주소로
 * 갈아타고 악수가 맺힐 때까지 기다리기, 닿지 않을 때의 레거시 배포 포트 되짚기.
 *
 * 이 일은 `ipcTransport`의 통로와 다른 이유로 바뀐다. 통로는 "이미 정해진 주소로 요청을
 * 어떻게 보내고 실패를 어떻게 알리는가"이고, 여기는 "그 주소를 무엇으로 정하는가"다.
 * 한 파일에 있는 동안은 시간 초과·503 판정 사이에 포트 되짚기 규칙이 끼어 있어, 통로
 * 하나를 읽으려도 앱 기동 순서를 함께 따라가야 했다.
 *
 * 의존은 한 방향이다 — 여기가 통로를 쓰고, 통로는 여기를 모른다. 악수 결과는 통로가
 * 들고 있으므로(요청마다 그것을 기다린다) 주소를 바꿀 때 `resetBackendProtocolHandshake`로
 * 버리라고 알린다.
 *
 * 여기서 내보내는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전
 * 그대로 `lib/ipc`다.
 */
import {
  hasNativeShell,
  LEGACY_BACKEND_SERVICE_PORT,
  setBackendServiceIdentity,
  validBackendServicePort,
  validBackendStoreId,
} from "./backend";
import {
  ensureBackendProtocol,
  nativeCall,
  RemoteConnectionError,
  resetBackendProtocolHandshake,
  type WebAccessStatus,
} from "./ipcTransport";

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
  resetBackendProtocolHandshake();
}

/** 악수 재시도 간격. 저장된 포트와 레거시 포트가 같은 값을 써야 한쪽만 늘어나지 않는다. */
const HANDSHAKE_RETRY_DELAY_MS = 125;
/** 저장된 포트의 악수 시도 횟수. 앱과 함께 뜨는 백엔드를 기다리는 자리라 길게 잡는다. */
const CONFIGURED_PORT_HANDSHAKE_ATTEMPTS = 40;
/** 레거시 포트 되짚기의 시도 횟수. 이미 떠 있는 서비스를 찾는 것이라 짧게 끊는다. */
const LEGACY_PORT_HANDSHAKE_ATTEMPTS = 8;

/** 한 주소로 갈아탄 뒤 악수가 맺힐 때까지 기다린다. 주소 교체와 대기가 갈라지면 악수를
 *  맺지 않은 주소를 쓰거나 옛 주소의 악수를 새 주소의 것으로 쓰는 자리가 생긴다. */
async function handshakeOn(port: number, storeId: string, attempts: number): Promise<void> {
  useBackendIdentity(port, storeId);
  await waitForBackendProtocol(attempts, HANDSHAKE_RETRY_DELAY_MS);
}

/**
 * A persisted custom port can outlive an externally managed service that still owns this
 * store on the legacy deployment port. Reuse that port only for a network-level miss and
 * only when the configured port is not already the legacy one.
 */
function retriesOnLegacyPort(cause: unknown, configuredPort: number): boolean {
  return cause instanceof RemoteConnectionError && configuredPort !== LEGACY_BACKEND_SERVICE_PORT;
}

/**
 * 저장된 포트가 닿지 않을 때의 레거시 배포 포트 되짚기. 여기서도 닿지 않으면 주소를
 * 저장된 포트로 되돌려 놓는다 — 되짚기는 추측이므로, 실패한 추측을 주소로 남기면 이후
 * 모든 요청이 사용자가 정하지 않은 포트로 나간다. 알릴 원인도 저장된 포트의 실패
 * (`cause`)다. 되짚기가 연결 실패가 아닌 다른 이유로 깨졌다면 그쪽이 더 구체적이다.
 */
async function initializeOnLegacyPort(
  configured: BackendServiceSettings,
  cause: unknown,
): Promise<BackendServiceSettings> {
  try {
    await handshakeOn(LEGACY_BACKEND_SERVICE_PORT, configured.storeId, LEGACY_PORT_HANDSHAKE_ATTEMPTS);
    return { ...configured, port: LEGACY_BACKEND_SERVICE_PORT };
  } catch (fallbackCause) {
    useBackendIdentity(configured.port, configured.storeId);
    if (!(fallbackCause instanceof RemoteConnectionError)) throw fallbackCause;
    throw cause;
  }
}

/** React가 도메인 API를 호출하기 전에 데스크톱 서비스 주소를 확정합니다. */
export async function initializeBackendService(): Promise<BackendServiceSettings | null> {
  if (!hasNativeShell()) return null;
  const configured = await getActiveBackendServiceSettings();
  try {
    await handshakeOn(configured.port, configured.storeId, CONFIGURED_PORT_HANDSHAKE_ATTEMPTS);
    return configured;
  } catch (cause) {
    if (!retriesOnLegacyPort(cause, configured.port)) throw cause;
    return initializeOnLegacyPort(configured, cause);
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
