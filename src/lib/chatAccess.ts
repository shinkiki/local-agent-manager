import { getWebAccessStatus, type WebAccessStatus } from "./ipc.ts";

/** 채팅 시작·소켓 오류 진단·첨부 전 확인이 응답 없는 요청을 계속 기다리지 않게 한다. */
const CHAT_ACCESS_TIMEOUT_MS = 10_000;

/**
 * 채팅을 시작하거나 첨부를 올리기 전에 백엔드 악수를 확인한다. 소켓 연결과 첨부 파일
 * API가 같은 관문을 지나야 하므로 두 모듈이 함께 쓰는 이곳에 둔다. 권한은 더 이상 여기서
 * 가르지 않는다 — 로그인 뒤에는 모든 채널이 같고(C20), 로그인이 없으면 악수 자체가 게이트를
 * 띄운다.
 */
export async function assertRemoteChatAccess(): Promise<WebAccessStatus> {
  return getWebAccessStatus({ timeoutMs: CHAT_ACCESS_TIMEOUT_MS });
}
