import type { ChatAttentionItem, ChatAttentionSnapshot, ChatProfile } from "../types";

/**
 * 승인 대기 알림인지 확인한다. 승인 대기는 백엔드 규칙상 로컬에서 읽음 처리하거나
 * 삭제(dismiss)할 수 없으며, 항상 미읽음 및 보류 상태로 집계된다.
 */
function isApprovalAttention(item: Pick<ChatAttentionItem, "kind">): boolean {
  return item.kind === "approval";
}

/** 로컬에서 읽음으로 전환 가능한 알림인지 확인한다. 승인 대기이거나 이미 읽은 알림은 제외된다. */
function canMarkAttentionReadLocally(item: Pick<ChatAttentionItem, "read" | "kind">): boolean {
  return !item.read && !isApprovalAttention(item);
}

/**
 * 읽은 알림 정리 시 유지할 알림인지 확인한다.
 * 읽지 않은 알림, 실행 중인 알림, 승인 대기 알림은 읽음 표시와 무관하게 보존한다.
 */
function shouldKeepOnClearRead(item: Pick<ChatAttentionItem, "read" | "kind">): boolean {
  return !item.read || item.kind === "running" || isApprovalAttention(item);
}

/**
 * 알림 목록의 집계값을 다시 센다. 백엔드 `ChatAttentionStore::snapshot`과 같은 식이어야
 * 낙관 갱신한 배지 숫자가 다음 폴링에서 튀지 않는다. 단일 순회로 unread와 pending을 계산한다.
 */
export function recountAttention(items: ChatAttentionItem[]): ChatAttentionSnapshot {
  let unreadCount = 0;
  let pendingCount = 0;

  for (const item of items) {
    const approval = isApprovalAttention(item);
    if (approval) pendingCount += 1;
    if (approval || !item.read) unreadCount += 1;
  }

  return {
    items,
    unreadCount,
    pendingCount,
  };
}

/** 두 항목 벌이 같은지. 고치는 쪽이 바꾼 원소가 하나도 없으면 두 배열의 원소가 그대로 겹친다. */
function sameAttentionItems(left: ChatAttentionItem[], right: ChatAttentionItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * 항목 한 벌을 고치고 집계까지 다시 맞춘다. 네 갈래(하나 읽음·모두 읽음·읽은 것 정리·
 * 하나 지우기)가 저마다 "대상을 id로 찾아 확인하고, 고친 뒤 다시 센다"를 조금씩 다른
 * 모양으로 들고 있어, 한 갈래의 규칙을 고치면 나머지가 조용히 어긋났다(모두 읽음만
 * 바뀐 게 없을 때 원래 스냅숏을 돌려주고 나머지는 매번 새 객체를 냈다).
 *
 * 바뀐 게 없으면 원래 스냅숏을 그대로 돌려 화면이 같은 값으로 다시 그리지 않게 한다.
 * 집계는 항목에서만 나오므로(백엔드 `ChatAttentionStore::snapshot`과 같은 식) 항목이
 * 그대로면 다시 세도 같은 값이다.
 */
function withAttentionItems(
  snapshot: ChatAttentionSnapshot,
  next: (items: ChatAttentionItem[]) => ChatAttentionItem[],
): ChatAttentionSnapshot {
  const items = next(snapshot.items);
  return sameAttentionItems(snapshot.items, items) ? snapshot : recountAttention(items);
}

/** 고른 알림을 읽음으로 바꾼다. 승인 대기와 이미 읽은 알림은 고름과 무관하게 그대로 둔다. */
function markAttentionRead(
  snapshot: ChatAttentionSnapshot,
  selected: (item: ChatAttentionItem) => boolean,
): ChatAttentionSnapshot {
  return withAttentionItems(snapshot, (items) => items.map((item) =>
    canMarkAttentionReadLocally(item) && selected(item) ? { ...item, read: true } : item));
}

/** 알림 하나를 읽음으로 바꾼다. 승인 대기는 서버와 같게 읽음 처리하지 않는다. */
export function markAttentionReadLocally(
  snapshot: ChatAttentionSnapshot,
  id: string,
): ChatAttentionSnapshot {
  return markAttentionRead(snapshot, (item) => item.id === id);
}

/**
 * 승인 대기와 `excludeProfiles`에 든 프로필을 뺀 나머지를 읽음으로 바꾼다.
 * 서버 `mark_all_chat_attention_read`와 같은 규칙이라, 왕복을 기다리지 않고
 * 이 결과를 먼저 화면에 올려도 응답이 오면 그대로 겹친다.
 */
export function markAllAttentionReadLocally(
  snapshot: ChatAttentionSnapshot,
  excludeProfiles: ChatProfile[] = [],
): ChatAttentionSnapshot {
  const excluded = new Set(excludeProfiles);
  return markAttentionRead(snapshot, (item) => !excluded.has(item.profile));
}

/**
 * 읽은 종료 알림만 지운다. 실행 중과 승인 대기는 읽음 표시와 무관하게 남긴다.
 * 서버 `clear_read_chat_attention`과 같은 규칙이다.
 */
export function clearReadAttentionLocally(snapshot: ChatAttentionSnapshot): ChatAttentionSnapshot {
  return withAttentionItems(snapshot, (items) => items.filter(shouldKeepOnClearRead));
}

/** 알림 하나를 목록에서 뺀다. 승인 대기는 서버가 거절하므로 화면에서도 남긴다. */
export function dismissAttentionLocally(
  snapshot: ChatAttentionSnapshot,
  id: string,
): ChatAttentionSnapshot {
  return withAttentionItems(snapshot, (items) =>
    items.filter((item) => item.id !== id || isApprovalAttention(item)));
}
