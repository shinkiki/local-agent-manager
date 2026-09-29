import { useCallback, useRef, type MutableRefObject } from "react";
import type { ChatConnection } from "../lib/chat";
import type { ChatSessionInfo } from "../types";

/**
 * 한 화면이 채팅 연결 하나만 붙들게 하는 세대 관리.
 *
 * 복원·시작·전환·알림 전환이 같은 렌더 구간에 겹쳐 들어오면, 먼저 시작한 붙기가 늦게
 * 끝나면서 나중 시도가 세운 화면을 덮어쓴다. 그래서 시도마다 세대 번호를 하나씩 올리고,
 * 이벤트 전달과 연결 등록을 모두 "지금 세대인가"로 거른다. 이 규칙은 AIA 팝업 곳곳에
 * 흩어져 있었는데, 한 군데서 세대를 올리는 것을 빠뜨리면 증상이 화면 깜박임이나 빈
 * 대화로만 나타나 원인을 되짚기 어려웠다. 그 판단을 이 훅 한곳에 모아 둔다.
 */
export type ChatConnectionGeneration = {
  /** 지금 화면이 붙들고 있는 연결. 읽기는 물론 직접 비우는 것도 호출부가 한다. */
  connectionRef: MutableRefObject<ChatConnection | null>;
  /** 새 시도가 화면을 맡는다. 앞선 시도의 이벤트는 이 시점부터 버려진다. */
  nextGeneration: () => number;
  /** 이 시도가 아직 화면을 맡고 있는지. */
  isCurrent: (generation: number) => boolean;
  /**
   * 붙는 데 성공한 연결을 화면에 싣는다. 그 사이 뒤에 시작된 시도가 화면을 맡았으면 이
   * 연결의 이벤트는 세대 검사에서 버려지므로 붙이지 않고 정리하고 false를 돌려준다.
   * 백엔드에 남는 실행은 다음 복원이 다시 찾아 붙는다.
   */
  claim: (generation: number, connection: ChatConnection) => Promise<boolean>;
  /**
   * 지금 붙어 있는 연결을 화면에서 뗀다. 세대를 올려 이 연결에서 뒤늦게 오는 이벤트를
   * 버리게 하고 참조를 비운 뒤, 정리할 연결을 돌려준다.
   */
  take: () => ChatConnection | null;
  /**
   * 연결 작업을 순서대로 처리한다. 진행 중이라고 다음 요청을 버리면 그 사이에 무효해진
   * attach 결과를 아무도 대신 받지 못해(세대 검사에서 이벤트가 전부 버려져) 세션 정보만
   * 있고 대화는 빈 화면으로 남는다. 팝업을 처음 열 때(StrictMode의 이중 마운트·개발 HMR
   * 재마운트)가 그 경우였다.
   */
  queue: <T>(task: () => Promise<T>) => Promise<T>;
};

/**
 * 비동기 작업을 요청 순서대로 실행하는 꼬리 큐.
 *
 * 연결 복원과 채팅 전환은 앞 작업이 끝나기 전에 다음 요청이 들어올 수 있다. 두 화면이
 * 각자 같은 Promise 꼬리를 관리하면 한쪽만 오류 뒤 진행 규칙을 바꿀 수 있으므로, 성공과
 * 실패 어느 쪽 뒤에도 다음 작업을 잇는 규칙을 이 훅 한곳에 둔다.
 */
export function useSerializedTaskQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  return useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const pending = queueRef.current.then(task, task);
    queueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, []);
}

/** 전환 결과. 붙기까지 갔으면 `ok`, 도중에 터졌으면 이전 연결을 되살렸는지까지 알린다. */
type ChatSwitchOutcome =
  | { ok: true; switched: boolean }
  | { ok: false; restored: boolean; cause: unknown };

/**
 * 붙어 있던 연결을 떼고 다른 대화에 붙이는 전환의 순서와 되돌리기.
 *
 * 채팅 화면과 AIA 팝업이 같은 순서를 각자 적고 있었다. 뗀 뒤에 터졌는지 떼기도 전에
 * 터졌는지에 따라 되돌리는 방법이 달라서(뗐으면 다시 붙여야 하고, 못 뗐으면 쥐고 있던
 * 연결을 그대로 쓰면 된다), 한쪽만 고치면 실패한 전환이 화면을 빈 대화로 남긴다. 그
 * 갈래 판단을 여기 한곳에 두고, 무엇을 붙이고 어떤 문장으로 알릴지는 호출부가 정한다.
 *
 * 되돌리기가 또 실패하는 경우는 삼키고 `restored: false`로 알린다. 그때도 백엔드의
 * 실행은 살아 있어 대화 목록에서 다시 찾아 붙을 수 있으므로, 전환 실패 위에 되돌리기
 * 실패까지 겹쳐 알릴 것이 없다.
 */
export async function switchAttachedChat(steps: {
  /** 쥐고 있던 연결을 뗀다. 쥔 것이 없으면 `null`. */
  detachPrevious: (() => Promise<void>) | null;
  /** 새 대화에 붙여 화면에 싣는다. 세대가 밀려 싣지 못했으면 `false`. */
  attachNext: () => Promise<boolean>;
  /** 떼어낸 연결을 다시 붙인다. 되돌릴 대상이 없으면 `null`. */
  reattachPrevious: (() => Promise<boolean>) | null;
  /** 떼기 전에 터졌을 때 쥐고 있던 연결을 그대로 화면에 되돌린다. */
  keepPrevious?: (() => boolean) | null;
}): Promise<ChatSwitchOutcome> {
  let detached = false;
  try {
    if (steps.detachPrevious) {
      await steps.detachPrevious();
      detached = true;
    }
    return { ok: true, switched: await steps.attachNext() };
  } catch (cause) {
    let restored = false;
    if (detached && steps.reattachPrevious) {
      try {
        restored = await steps.reattachPrevious();
      } catch {
        // The previous runtime remains discoverable in the live-chat list.
      }
    } else if (!detached && steps.keepPrevious) {
      restored = steps.keepPrevious();
    }
    return { ok: false, restored, cause };
  }
}

/** `onClaim`은 화면에 실린 연결의 세션 정보를 받는다(상태 반영은 호출부 몫). */
export function useChatConnectionGeneration(onClaim: (info: ChatSessionInfo) => void): ChatConnectionGeneration {
  const connectionRef = useRef<ChatConnection | null>(null);
  const generationRef = useRef(0);
  const queue = useSerializedTaskQueue();

  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const isCurrent = useCallback((generation: number) => generation === generationRef.current, []);

  const claim = useCallback(async (generation: number, connection: ChatConnection): Promise<boolean> => {
    if (generation !== generationRef.current) {
      await connection.detach().catch(() => undefined);
      return false;
    }
    // 자동 요청·알림 전환·최초 열기가 같은 렌더 구간에 복원을 예약할 수 있다. 뒤 요청이
    // 이미 붙은 연결을 교체하더라도 이전 WebSocket 구독을 남겨 두지 않는다.
    const previous = connectionRef.current;
    connectionRef.current = connection;
    onClaim(connection.info);
    if (previous && previous !== connection) {
      await previous.detach().catch(() => undefined);
    }
    return true;
  }, [onClaim]);

  const take = useCallback((): ChatConnection | null => {
    generationRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    return connection;
  }, []);

  return { connectionRef, nextGeneration, isCurrent, claim, take, queue };
}
