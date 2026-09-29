/**
 * 데이터베이스 연결 기본도구 명령 묶음.
 *
 * 애드온 도구 넷(DB 연결·SSH 키·외부 플러그인·Cypress)이 `ipcAddons.ts` 한 파일에 함께
 * 있었다. "애드온 탭 한 화면이 쓴다"는 것이 묶어 둔 이유였는데, 실제로 그 탭은 도구마다
 * 다른 카드(`SshKeysCard`·`ExternalPluginsCard`·`CypressWorkspacePanel`)로 갈라져 있고
 * 백엔드 도메인도 서로 남남이다. 그래서 Cypress 파일 명령에 칸 하나를 더하려 해도 SSH
 * 키와 OAuth 대기 시간을 지나야 했고, 도구별 대기 상한 여섯이 한 머리말 아래 섞여 어느
 * 숫자가 어느 도구의 것인지 세어 가며 읽어야 했다. 도구별로 갈라, 파일 하나가 도구
 * 하나의 명령과 그 도구가 무엇을 기다리는지만 담게 한다.
 *
 * 도구 전체를 한 번에 읽는 카탈로그와 사용 스위치 알림은 `ipcBuiltinTools.ts`에 남는다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  DbConnectionCheckReceipt,
  DbConnectionRef,
  DbConnectionsSnapshot,
  SetDbConnectionEnabledRequest,
  SetDbConnectionRequest,
} from "../types";
import { notifyBuiltinTools } from "./builtinToolsSignal";
import { call } from "./ipcTransport";

/** 저장된 접속 정보로 한 번 붙어 보는 확인. 닿지 않는 주소는 TCP 연결이 끝날 때까지 끈다. */
const CONNECTION_CHECK_TIMEOUT_MS = 30_000;

/** 등록된 데이터베이스 연결과 화면 기본값. 비밀번호는 어느 필드에도 없다. */
export function getDbConnections(): Promise<DbConnectionsSnapshot> {
  return call<DbConnectionsSnapshot>("get_db_connections");
}

/**
 * 연결 저장. 비밀번호를 함께 받을 수 있어 호스트 화면 전용이다.
 * 이미 에이전트 사용이 켜진 연결을 고치면 `usable` 판정이 뒤집혀 "쓸 수 있는 연결"과
 * "켰지만 쓸 수 없는 연결"의 수가 달라진다.
 */
export function setDbConnection(request: SetDbConnectionRequest): Promise<DbConnectionsSnapshot> {
  return notifyBuiltinTools(call<DbConnectionsSnapshot>("set_db_connection", { request }));
}

/** 에이전트 사용 토글. 앱 데이터 안의 변경이라 원격 편집 모드에서도 쓸 수 있다. */
export function setDbConnectionEnabled(request: SetDbConnectionEnabledRequest): Promise<DbConnectionsSnapshot> {
  return notifyBuiltinTools(call<DbConnectionsSnapshot>("set_db_connection_enabled", { request }));
}

/** 연결 삭제. 보안 저장소의 비밀값도 함께 지우는 호스트 전용 작업이다. */
export function removeDbConnection(request: DbConnectionRef): Promise<DbConnectionsSnapshot> {
  return notifyBuiltinTools(call<DbConnectionsSnapshot>("remove_db_connection", { request }));
}

/** 한 번 붙어 서버 버전만 읽고 끊는 확인. 원격에서는 아무것도 바뀌지 않는다. */
export function checkDbConnection(request: DbConnectionRef): Promise<DbConnectionCheckReceipt> {
  return call<DbConnectionCheckReceipt>("check_db_connection", { request }, { timeoutMs: CONNECTION_CHECK_TIMEOUT_MS });
}
