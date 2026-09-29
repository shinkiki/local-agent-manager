/**
 * SSH 인증키 기본도구 명령 묶음. 갈라 둔 이유는 `ipcDbConnections.ts` 머리말에 적는다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  GenerateSshKeyRequest,
  SetSshKeyEndpointRequest,
  SetSshKeyNoteRequest,
  SshEndpointCheckReceipt,
  SshKeyDeletionReceipt,
  SshKeyRef,
  SshKeyView,
  SshKeysSnapshot,
  SshPublicKeyView,
} from "../types";
import { notifyBuiltinTools } from "./builtinToolsSignal";
import { call } from "./ipcTransport";

/** 저장된 접속 지점으로 한 번 붙어 보는 확인. 닿지 않는 주소는 TCP 연결이 끝날 때까지 끈다. */
const ENDPOINT_CHECK_TIMEOUT_MS = 30_000;
/** 키 생성은 ~/.ssh 파일 쓰기까지 포함하지만 로컬 작업이라 연결 확인보다 조금만 길게 잡는다. */
const SSH_KEY_GENERATE_TIMEOUT_MS = 45_000;

/** 로컬 ~/.ssh 공개키의 비밀 없는 메타데이터. 개인키 파일은 열지 않는다. */
export function getSshKeys(): Promise<SshKeysSnapshot> {
  return call<SshKeysSnapshot>("get_ssh_keys");
}

/** 기존 파일을 덮어쓰지 않는 호스트 전용 Ed25519 키 생성. */
export function generateSshKey(request: GenerateSshKeyRequest): Promise<SshKeyView> {
  return call<SshKeyView>("generate_ssh_key", { request }, { timeoutMs: SSH_KEY_GENERATE_TIMEOUT_MS });
}

/** 고른 공개키의 본문 한 줄. 공개키라 비밀값이 아니며 개인키는 열지 않는다. */
export function readSshPublicKey(request: SshKeyRef): Promise<SshPublicKeyView> {
  return call<SshPublicKeyView>("read_ssh_public_key", { request });
}

/**
 * 키 쌍을 ~/.ssh 안 휴지통으로 옮기는 호스트 전용 삭제. 파일을 되옮기면 복구된다.
 * 지문에 묶인 접속 서버도 함께 사라지므로(C9-9) 기본도구 접근 상세가 세던 수가 달라진다.
 */
export function deleteSshKey(request: SshKeyRef): Promise<SshKeyDeletionReceipt> {
  return notifyBuiltinTools(call<SshKeyDeletionReceipt>("delete_ssh_key", { request }));
}

/** 지문에 묶인 기기 단위 메모. 빈 문자열은 메모 삭제다. */
export function setSshKeyNote(request: SetSshKeyNoteRequest): Promise<SshKeysSnapshot> {
  return call<SshKeysSnapshot>("set_ssh_key_note", { request });
}

/** 인증키별 접속 지점과 에이전트 사용 여부. 앱 데이터에만 쓰는 호스트 전용 설정이다. */
export function setSshKeyEndpoint(request: SetSshKeyEndpointRequest): Promise<SshKeysSnapshot> {
  return notifyBuiltinTools(call<SshKeysSnapshot>("set_ssh_key_endpoint", { request }));
}

/** 저장된 접속 지점으로 한 번 붙어 보는 호스트 전용 확인. 원격에서는 아무것도 바꾸지 않는다. */
export function checkSshEndpoint(request: SshKeyRef): Promise<SshEndpointCheckReceipt> {
  return call<SshEndpointCheckReceipt>("check_ssh_endpoint", { request }, { timeoutMs: ENDPOINT_CHECK_TIMEOUT_MS });
}
