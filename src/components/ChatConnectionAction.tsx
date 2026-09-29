import type { ChatConnection } from "../lib/chat";
import { errorText } from "../lib/errorText";

/**
 * 현재 연결에서 짧은 UI 액션 하나를 실행하고 실패 문구만 화면에 남긴다.
 *
 * 승인·대기열 제거·중단은 채팅과 AIA에서 같은 실패 경계를 쓰지만, 오류를 미리 지우는
 * 시점은 각 화면의 상호작용에 속한다. 그래서 연결 유무 확인과 예외 변환만 이곳에 모으고
 * 오류 초기화는 호출부에 그대로 둔다.
 */
export async function runChatConnectionAction(
  connection: ChatConnection | null,
  action: (connection: ChatConnection) => Promise<unknown>,
  onError: (message: string) => void,
): Promise<void> {
  if (!connection) return;
  try {
    await action(connection);
  } catch (cause) {
    onError(errorText(cause));
  }
}

/** 되돌릴 것이 없는 연결 정리는 대상 유무와 실패 무시 규칙을 함께 쓴다. */
async function runConnectionCleanupQuietly(
  connection: ChatConnection | null,
  cleanup: (connection: ChatConnection) => Promise<unknown>,
): Promise<void> {
  if (!connection) return;
  try {
    await cleanup(connection);
  } catch {
    // 실행이 이미 사라졌다면 정리 요청 실패는 원하던 상태와 같다.
  }
}

/**
 * detach는 이미 끝난 프로세스의 이벤트 구독을 끊는 뒷정리라, 실패해도 되돌릴 것이 없고
 * 사용자에게 알릴 것도 없다. 호출부마다 같은 문장을 다르게 적기보다 여기서 한 번 삼킨다.
 */
export async function detachQuietly(connection: ChatConnection | null): Promise<void> {
  await runConnectionCleanupQuietly(connection, (current) => current.detach());
}

/** 종료 실패를 알릴 자리가 없는 정리 경로에서만 쓴다 — 프로세스가 이미 없을 수 있다. */
export async function stopQuietly(connection: ChatConnection | null): Promise<void> {
  await runConnectionCleanupQuietly(connection, (current) => current.stop());
}

/**
 * 화면에서 뗀 실행을 정리한다. 이미 멈췄거나 떨어져 있어도 남은 단계를 막지 않도록 두
 * 단계 모두 실패를 삼킨다.
 */
export async function shutdownConnection(connection: ChatConnection | null): Promise<void> {
  if (!connection) return;
  await stopQuietly(connection);
  await detachQuietly(connection);
}
