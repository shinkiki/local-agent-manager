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
 * 도메인 작업의 HTTP 대상입니다. Tauri는 설정된 단일 loopback 백엔드를 사용하고,
 * 일반 브라우저/PWA는 현재 페이지를 제공한 백엔드를 그대로 사용합니다.
 */
export function backendHttpUrl(path: string): string {
  const nativeShell = hasNativeShell();
  return resolveBackendHttpUrl(
    path,
    nativeShell,
    window.location,
    nativeShell ? initializedBackendServicePort() : undefined,
  );
}

/** 채팅·터미널 스트림의 WebSocket 대상입니다. */
export function backendWebSocketUrl(path: string): string {
  const nativeShell = hasNativeShell();
  return resolveBackendWebSocketUrl(
    path,
    nativeShell,
    window.location,
    nativeShell ? initializedBackendServicePort() : undefined,
  );
}

export function resolveBackendHttpUrl(
  path: string,
  nativeShell: boolean,
  location: BrowserEndpoint,
  nativePort?: number,
): string {
  const origin = nativeShell
    ? `http://127.0.0.1:${validBackendServicePort(nativePort)}`
    : `${location.protocol}//${location.host}`;
  return `${origin}${normalizeBackendPath(path)}`;
}

export function resolveBackendWebSocketUrl(
  path: string,
  nativeShell: boolean,
  location: BrowserEndpoint,
  nativePort?: number,
): string {
  const origin = nativeShell
    ? `ws://127.0.0.1:${validBackendServicePort(nativePort)}`
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
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
