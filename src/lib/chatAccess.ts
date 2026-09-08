import { getWebAccessStatus, type WebAccessStatus } from "./ipc";

const REMOTE_WRITE_DISABLED_MESSAGE =
  "원격 편집이 꺼져 있어 채팅 세션을 시작할 수 없습니다. 호스트의 설정 → 백엔드 서비스에서 원격 편집 허용을 켠 뒤 다시 시도하세요.";

/**
 * 채팅을 시작하거나 첨부를 올리기 전 이 화면에 쓰기 권한이 있는지 확인한다. 소켓 연결과
 * 첨부 파일 API가 같은 관문을 지나야 하므로 두 모듈이 함께 쓰는 이곳에 둔다.
 */
export async function assertRemoteChatAccess(): Promise<WebAccessStatus> {
  const access = await getWebAccessStatus();
  if (access.remote && !access.writable) {
    throw new Error(REMOTE_WRITE_DISABLED_MESSAGE);
  }
  return access;
}
