import { selectAiaChat } from "./aiaChatSelection.ts";
import type { ChatSessionInfo } from "../types";

const SCOPED_KEY = "agent-manager.aia-window-sessions.v1";
const CHAT_KEY = "agent-manager.aia-chat.v1";

/** 새 창은 다른 창의 최근 대화를 자동으로 가져오지 않는다. 저장소 장애 때도 새 대화만 연다. */
export function enableAiaWindowSessions(shared: Storage): void {
  shared.setItem(SCOPED_KEY, "1");
}

/**
 * 이 창의 대화 id를 남기는 자리 — 어느 저장소의 어느 키인가. 창 ID를 가진 팝아웃은 자기
 * 세션 저장소에 창별 키로 남기고, 메인 창은 창을 여러 개 쓰기 전부터 있던 공유 저장소의
 * 단일 키를 그대로 쓴다.
 *
 * 저장소와 키를 고르는 판정이 남길 때와 읽을 때 두 벌로 펼쳐져 있었다. 두 곳이 같은 자리를
 * 가리켜야만 복원이 성립하는데, 한쪽만 고치면 남긴 대화를 아무도 읽지 않아 팝아웃이 늘 새
 * 대화로 열린다 — 오류 없이 조용히 어긋나는 갈래라 여기 한 벌만 둔다.
 */
function windowChatSlot(
  shared: Storage,
  local: Storage,
  windowId: string | null,
): { storage: Storage; key: string } {
  return windowId
    ? { storage: local, key: `${CHAT_KEY}.${windowId}` }
    : { storage: shared, key: CHAT_KEY };
}

export function rememberAiaWindowSession(shared: Storage, local: Storage, windowId: string | null, chatId: string): void {
  const { storage, key } = windowChatSlot(shared, local, windowId);
  storage.setItem(key, chatId);
}

/**
 * 이 창의 대화 핀을 지운다. ↻ 로 대화를 떼어 낼 때 그 자리에서 부른다.
 *
 * 소유를 내려놓는 시점이 "새 대화가 붙을 때"면 늦다. 핀이 떼어 낸 대화를 계속 가리키는
 * 동안 그 대화의 완료·승인 알림은 일반 목록 대신 AIA 트리거로 가고, 트리거를 누르면 방금
 * 떠난 대화로 되돌아간다 — 새 대화 시작이 실패하면 그 상태가 영영 남는다. 다음 대화가
 * 붙으면 `rememberAiaWindowSession`이 다시 적는다.
 */
export function forgetAiaWindowSession(shared: Storage, local: Storage, windowId: string | null): void {
  const { storage, key } = windowChatSlot(shared, local, windowId);
  storage.removeItem(key);
  // 핀을 비운 창은 구버전 복원 갈래로 돌아가지 않는다. 그 갈래는 "핀이 없으면 살아 있는
  // AIA 대화 아무거나 고른다"이므로, 방금 대화를 놓은 창이 세션 화면에서 재개한 남의 대화를
  // 집어 제 것으로 다시 적게 된다 — 이 판이 막으려던 바로 그 가로채기다. 첫 업그레이드
  // 한 번을 위한 갈래이고 이 창은 이미 제 대화를 가져 봤으므로 여기서 닫는다.
  enableAiaWindowSessions(shared);
}

/** 웹 저장소 두 자리. 테스트가 가짜 저장소를 넘길 수 있게 모양만 받는다. */
export interface AiaWindowStorages {
  shared: Storage;
  local: Storage;
}

/**
 * 기본 저장소 짝. `window.localStorage`는 **닿는 것만으로** 던질 수 있어(쿠키 전면 차단)
 * 그 접근까지 여기서 감싼다 — `storedText`와 같은 규칙이다. 호출부가 `window.localStorage`를
 * 인자로 적으면 그 접근이 함수 밖에서 일어나 안쪽 try 가 닿지 않고, 렌더 중에 던지면 앱
 * 셸이 통째로 오류 경계로 떨어진다. 저장소가 없는 실행(node 테스트)도 같은 뜻으로 null이다.
 */
function defaultAiaWindowStorages(): AiaWindowStorages | null {
  try {
    return typeof window === "undefined" ? null : { shared: window.localStorage, local: window.sessionStorage };
  } catch {
    return null;
  }
}

/**
 * 이 창이 마지막으로 붙은 AIA 대화 id. 없으면 null이다.
 *
 * 복원(`selectAiaWindowSession`)과 달리 살아 있는 대화 목록을 보지 않는다. 묻는 것이
 * "지금 붙을 대화가 있는가"가 아니라 **"이 알림이 이 창 것인가"**이기 때문이다. AIA 프로필
 * 대화는 팝업에서만 생기지 않는다 — 세션 화면에서 AIA 작업공간 세션을 재개하면 백엔드가
 * 프로필을 Aia 로 되살리므로(`chat.rs::effective_chat_profile`, 지시문·작업공간 루트·도구를
 * 그대로 잇기 위한 의도된 동작이다), 프로필만 보고 알림을 고르면 사용자가 세션 화면에서
 * 이어 보려고 재개한 대화를 AIA 창이 빼앗는다.
 */
export function ownedAiaWindowChatId(
  windowId: string | null,
  storages: AiaWindowStorages | null = defaultAiaWindowStorages(),
): string | null {
  if (!storages) return null;
  try {
    const { storage, key } = windowChatSlot(storages.shared, storages.local, windowId);
    return storage.getItem(key);
  } catch {
    // 저장소가 막히면 이 창은 소유를 주장하지 않는다. 남의 대화를 가져가는 쪽보다 낫다.
    return null;
  }
}

export function selectAiaWindowSession(
  chats: ChatSessionInfo[], shared: Storage, local: Storage, windowId: string | null,
): ChatSessionInfo | null {
  try {
    const { storage, key } = windowChatSlot(shared, local, windowId);
    const chatId = storage.getItem(key);
    if (chatId) return chats.find((chat) => chat.chatId === chatId) ?? null;
    // 첫 업그레이드 때만 기존 모달의 복원 규칙을 따른다. 다중 창 사용 뒤에는 각 창의 ID만 복원한다.
    return !windowId && !shared.getItem(SCOPED_KEY) ? selectAiaChat(chats) : null;
  } catch {
    return null;
  }
}
