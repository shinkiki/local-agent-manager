/**
 * 로컬 LLM 연결 명령 묶음.
 *
 * 계정도 CLI 설치도 없는 공급자라 계정·CLI 명령 어느 묶음에도 붙지 않는다. 연결 한 벌을
 * 읽고 쓰는 것과 주소를 찔러 보는 것, 셋뿐이라 도구별로 가르는 `ipcDbConnections`와 같은
 * 규칙으로 파일 하나를 둔다. 이름은 `ipc.ts`가 그대로 다시 내보내므로 화면 쪽 import
 * 경로는 `lib/ipc`다.
 */
import type {
  LocalLlmConnection,
  LocalLlmConnections,
  LocalLlmConnectionEntry,
  LocalLlmProbeResult,
  SetLocalLlmConnectionRequest,
  UpsertLocalLlmConnectionRequest,
} from "../types";
import { call } from "./ipcTransport";

/**
 * 주소를 찔러 보는 대기 상한. 백엔드는 5초에서 끊지만, 그 응답이 돌아오는 시간까지
 * 여유를 둔다 — 여기서 먼저 끊으면 화면이 "닿지 않음" 대신 통신 오류를 보게 된다.
 */
const PROBE_TIMEOUT_MS = 15_000;

/** 저장된 연결 한 벌. API 키는 값이 아니라 `apiKeyConfigured` 여부로만 온다. */
export function getLocalLlmConnection(): Promise<LocalLlmConnection> {
  return call<LocalLlmConnection>("get_local_llm_connection");
}

/** 연결 저장. API 키를 함께 받을 수 있어 편집 권한이 있는 화면에서만 쓴다. */
export function setLocalLlmConnection(
  request: SetLocalLlmConnectionRequest,
): Promise<LocalLlmConnection> {
  return call<LocalLlmConnection>("set_local_llm_connection", { request });
}

/** 연결 목록과 기본 연결 id(M7 7.1). 비밀값은 어느 칸에도 없다. */
export function getLocalLlmConnections(): Promise<LocalLlmConnections> {
  return call<LocalLlmConnections>("get_local_llm_connections");
}

/** 연결 추가·편집. id 가 없으면 새로 만든다. API 키를 받을 수 있어 편집 권한 화면 전용. */
export function upsertLocalLlmConnection(
  request: UpsertLocalLlmConnectionRequest,
): Promise<LocalLlmConnectionEntry> {
  return call<LocalLlmConnectionEntry>("upsert_local_llm_connection", { request });
}

/** 연결 삭제. 마지막 하나는 거절되고, 기본 연결을 지우면 남은 첫 연결이 기본이 된다. */
export function removeLocalLlmConnection(id: string): Promise<LocalLlmConnections> {
  return call<LocalLlmConnections>("remove_local_llm_connection", { request: { id } });
}

/** 기본 연결 지정. 연결 id 를 적지 않은 옛 채팅·반복요청이 이 연결을 쓴다. */
export function setDefaultLocalLlmConnection(id: string): Promise<LocalLlmConnections> {
  return call<LocalLlmConnections>("set_default_local_llm_connection", { request: { id } });
}

/**
 * 아직 저장하지 않은 주소를 그대로 확인한다. 저장본을 읽지도 쓰지도 않으므로 연결 카드가
 * 입력 중인 값을 바로 시험할 수 있다.
 */
export function probeLocalLlmConnection(baseUrl: string): Promise<LocalLlmProbeResult> {
  return call<LocalLlmProbeResult>("probe_local_llm_connection", { baseUrl }, {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}
