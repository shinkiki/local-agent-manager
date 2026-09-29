import { waitWithSyncGrace } from "./sessionSyncBudget.ts";

/** 알림 카드가 열어야 할 목적지. */
export type AttentionRoute<S> =
  | { kind: "chat"; chatId: string }
  | { kind: "session"; session: S }
  | { kind: "ended" };

export interface AttentionRouteDeps<S> {
  /** 카탈로그 스냅샷에서 알림의 공급자 세션을 찾는다. */
  findIndexedSession: (sessionId: string) => S | null;
  /** 그 세션 하나를 색인하는 동기화. 실패를 스스로 처리하는 App의 syncSessionCatalog를 받는다. */
  syncSessionCatalog: () => Promise<unknown>;
  /** 공급자 세션에 매핑된 살아 있는 채팅 런타임의 chatId. 없으면 null, 확인 불가면 reject. */
  findActiveChatId: () => Promise<string | null>;
  /**
   * 목록을 거치지 않고 공급자 원본에서 읽는 세션 한 건. 색인이 끝내 세션을 올리지 못하는
   * 경우(제외 프로젝트의 무인 실행)에도 알림이 가리키는 세션을 열 수 있는 마지막 길이다.
   */
  findProviderSession: () => Promise<S | null>;
}

/**
 * 알림 카드의 목적지를 정한다. 세션이 색인돼 있으면 세션 상세가 최신 실행을 다시
 * 해석하므로 세션으로 열고, 색인 예산을 끝까지 기다리는 대신 짧은 유예만 기다려
 * 클릭이 무반응처럼 보이지 않게 한다.
 *
 * 알림의 chatId는 인메모리 런타임이라 완료 알림일수록 이미 끝났을 수 있고, 죽은
 * chatId로 채팅을 열면 chatMissing 오류만 보인다. 그래서 색인 전에는 살아 있는
 * 런타임을 먼저 찾고, 그마저 없으면 남은 색인을 기다려 세션으로 연다.
 */
export async function resolveAttentionRoute<S>(
  item: { chatId: string; providerSessionId: string | null },
  deps: AttentionRouteDeps<S>,
): Promise<AttentionRoute<S>> {
  const sessionId = item.providerSessionId;
  const chatRoute: AttentionRoute<S> = { kind: "chat", chatId: item.chatId };
  if (!sessionId) return chatRoute;

  // 색인 조회는 세 번 돌아온다 — 유예 전, 짧은 유예 뒤, 남은 색인을 끝까지 기다린 뒤.
  // 조회와 결과 변환을 각자 펼쳐 두면 목적지 모양을 바꿀 때 세 자리를 함께 고쳐야 하고,
  // 그중 하나를 빼면 같은 세션이 어느 걸음에서 찾혔느냐에 따라 다른 화면으로 열린다.
  const indexedRoute = (): AttentionRoute<S> | null => {
    const session = deps.findIndexedSession(sessionId);
    return session ? { kind: "session", session } : null;
  };

  const beforeSync = indexedRoute();
  if (beforeSync) return beforeSync;

  const sync = deps.syncSessionCatalog();
  await waitWithSyncGrace(sync);
  const afterGrace = indexedRoute();
  if (afterGrace) return afterGrace;

  let activeChatId: string | null;
  try {
    activeChatId = await deps.findActiveChatId();
  } catch {
    // 런타임 확인이 안 되는 상태(백엔드 연결 문제)면 기존 폴백을 유지한다.
    // attach가 같은 연결 오류를 사용자에게 그대로 보여준다.
    return chatRoute;
  }
  if (activeChatId) return { kind: "chat", chatId: activeChatId };

  await sync.catch(() => undefined);
  const afterSync = indexedRoute();
  if (afterSync) return afterSync;

  // 색인이 끝내 올리지 못한 세션이라도 원본이 있으면 상세는 열린다. 무인 실행은
  // 사용자가 목록에서 뺀 프로젝트에서도 돌기 때문에, 여기서 멈추면 그 회차의 결과는
  // 알림에서 영영 열리지 않는다.
  const provider = await deps.findProviderSession().catch(() => null);
  return provider ? { kind: "session", session: provider } : { kind: "ended" };
}

/**
 * 색인을 기다려 찾은 세션을 선택에 반영한다. 클릭 시점의 선택이 그대로면 찾은 세션을
 * 채택하고, 기다리는 동안 사용자가 선택을 바꿨으면(다른 세션·선택 해제) 빼앗지 않는다.
 */
export function adoptFoundSession<S>(current: S | null, atClick: S | null, found: S): S | null {
  return current === atClick ? found : current;
}
