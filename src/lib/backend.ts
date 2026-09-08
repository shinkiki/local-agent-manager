export const DEFAULT_BACKEND_SERVICE_PORT = 54_178;
export const LEGACY_BACKEND_SERVICE_PORT = 4_178;
export const MIN_BACKEND_SERVICE_PORT = 1024;
export const MAX_BACKEND_SERVICE_PORT = 65_535;

let backendServicePort: number | null = null;
let backendStoreId: string | null = null;

const BACKEND_STORE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface BrowserEndpoint {
  protocol: string;
  host: string;
}

/** Tauri가 제공하는 창·대화상자 같은 OS 기능을 사용할 수 있는지 여부입니다. */
export function hasNativeShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 네이티브 설정에서 읽은 endpoint와 app-data identity를 현재 런타임에 고정합니다. */
export function setBackendServiceIdentity(port: number, storeId: string): void {
  const validPort = validBackendServicePort(port);
  const validStoreId = validBackendStoreId(storeId);
  backendServicePort = validPort;
  backendStoreId = validStoreId;
}

/** 현재 페이지가 실제로 연결하는 백엔드 포트입니다. 초기화 전/알 수 없는 scheme은 null입니다. */
export function currentBackendServicePort(): number | null {
  if (backendServicePort !== null) return backendServicePort;
  if (typeof window === "undefined") return null;
  if (window.location.port) {
    const port = Number(window.location.port);
    return Number.isInteger(port) && port >= 1 && port <= MAX_BACKEND_SERVICE_PORT ? port : null;
  }
  if (window.location.protocol === "http:") return 80;
  if (window.location.protocol === "https:") return 443;
  return null;
}

/** Tauri 시작 시 고정한 app-data identity입니다. 브라우저/PWA에는 기대값이 없습니다. */
export function currentBackendStoreId(): string | null {
  return backendStoreId;
}

export function validBackendServicePort(port: unknown): number {
  if (typeof port !== "number"
    || !Number.isInteger(port)
    || port < MIN_BACKEND_SERVICE_PORT
    || port > MAX_BACKEND_SERVICE_PORT) {
    throw new Error(
      `백엔드 서비스 포트는 ${MIN_BACKEND_SERVICE_PORT}~${MAX_BACKEND_SERVICE_PORT} 범위의 정수여야 합니다.`,
    );
  }
  return port;
}

export function validBackendStoreId(storeId: unknown): string {
  if (typeof storeId !== "string" || !BACKEND_STORE_ID_PATTERN.test(storeId)) {
    throw new Error("백엔드 서비스 저장소 식별자가 올바르지 않습니다.");
  }
  return storeId;
}

/**
 * `/api/access` identity를 검증합니다. Browser/PWA는 expectedStoreId를 전달하지
 * 않아 same-origin 응답 형식만 확인하고, Tauri는 시작 시 고정한 값과 일치해야 합니다.
 */
export function assertBackendStoreIdentity(
  actualStoreId: unknown,
  expectedStoreId: string | null,
): string {
  const actual = validBackendStoreId(actualStoreId);
  if (expectedStoreId !== null && actual !== validBackendStoreId(expectedStoreId)) {
    throw new Error(
      "현재 앱 데이터와 다른 백엔드 서비스가 이 포트를 사용하고 있습니다. 다른 Agent Manager 인스턴스를 종료한 뒤 다시 시작하세요.",
    );
  }
  return actual;
}

/**
 * 백엔드 대상 URL의 규약. 규약 이름만 다르고 origin을 고르는 규칙은 HTTP와 WebSocket이
 * 같아서, 규칙을 두 벌로 두면 한쪽만 고쳐져 두 대상이 서로 다른 백엔드를 가리키게 된다.
 */
interface BackendScheme {
  /** loopback 백엔드에 직접 붙을 때 쓰는 규약. */
  loopback: string;
  /** 현재 페이지 규약에서 이 대상의 규약을 정한다. */
  fromPage: (pageProtocol: string) => string;
}

const HTTP_SCHEME: BackendScheme = {
  loopback: "http:",
  fromPage: (pageProtocol) => pageProtocol,
};

/** https 페이지에서 ws로 열면 브라우저가 혼합 콘텐츠로 막으므로 페이지 규약을 따라간다. */
const WEB_SOCKET_SCHEME: BackendScheme = {
  loopback: "ws:",
  fromPage: (pageProtocol) => (pageProtocol === "https:" ? "wss:" : "ws:"),
};

/**
 * 도메인 작업의 HTTP 대상입니다. Tauri는 설정된 단일 loopback 백엔드를 사용하고,
 * 일반 브라우저/PWA는 현재 페이지를 제공한 백엔드를 그대로 사용합니다.
 */
export function backendHttpUrl(path: string): string {
  return currentBackendUrl(HTTP_SCHEME, path);
}

/** 채팅·터미널 스트림의 WebSocket 대상입니다. */
export function backendWebSocketUrl(path: string): string {
  return currentBackendUrl(WEB_SOCKET_SCHEME, path);
}

export function resolveBackendHttpUrl(
  path: string,
  nativeShell: boolean,
  location: BrowserEndpoint,
  nativePort?: number,
): string {
  return resolveBackendUrl(HTTP_SCHEME, path, nativeShell, location, nativePort);
}

export function resolveBackendWebSocketUrl(
  path: string,
  nativeShell: boolean,
  location: BrowserEndpoint,
  nativePort?: number,
): string {
  return resolveBackendUrl(WEB_SOCKET_SCHEME, path, nativeShell, location, nativePort);
}

/** 지금 실행 중인 환경(네이티브 셸 여부와 시작 시 고정한 포트)으로 대상 URL을 만듭니다. */
function currentBackendUrl(scheme: BackendScheme, path: string): string {
  const nativeShell = hasNativeShell();
  return resolveBackendUrl(
    scheme,
    path,
    nativeShell,
    window.location,
    nativeShell ? initializedBackendServicePort() : undefined,
  );
}

function resolveBackendUrl(
  scheme: BackendScheme,
  path: string,
  nativeShell: boolean,
  location: BrowserEndpoint,
  nativePort?: number,
): string {
  const origin = nativeShell
    ? `${scheme.loopback}//127.0.0.1:${validBackendServicePort(nativePort)}`
    : `${scheme.fromPage(location.protocol)}//${location.host}`;
  return `${origin}${normalizeBackendPath(path)}`;
}

function initializedBackendServicePort(): number {
  if (backendServicePort === null) {
    throw new Error("백엔드 서비스 포트가 초기화되지 않았습니다.");
  }
  return backendServicePort;
}

function normalizeBackendPath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}
