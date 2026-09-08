import type { ChatAttentionItem, ChatAttentionSnapshot, ChatProfile } from "../types";

/**
 * 알림 목록의 집계값을 다시 센다. 백엔드 `ChatAttentionStore::snapshot`과 같은 식이어야
 * 낙관 갱신한 배지 숫자가 다음 폴링에서 튀지 않는다.
 */
export function recountAttention(items: ChatAttentionItem[]): ChatAttentionSnapshot {
  return {
    items,
    unreadCount: items.filter((item) => !item.read || item.kind === "approval").length,
    pendingCount: items.filter((item) => item.kind === "approval").length,
  };
}

/** 알림 하나를 읽음으로 바꾼다. 승인 대기는 서버와 같게 읽음 처리하지 않는다. */
export function markAttentionReadLocally(
  snapshot: ChatAttentionSnapshot,
  id: string,
): ChatAttentionSnapshot {
  const target = snapshot.items.find((item) => item.id === id);
  if (!target || target.read || target.kind === "approval") return snapshot;
  return recountAttention(snapshot.items.map((item) =>
    item.id === id ? { ...item, read: true } : item));
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
  const items = snapshot.items.map((item) =>
    item.read || item.kind === "approval" || excludeProfiles.includes(item.profile)
      ? item
      : { ...item, read: true });
  return recountAttention(items);
}

/**
 * 읽은 종료 알림만 지운다. 실행 중과 승인 대기는 읽음 표시와 무관하게 남긴다.
 * 서버 `clear_read_chat_attention`과 같은 규칙이다.
 */
export function clearReadAttentionLocally(snapshot: ChatAttentionSnapshot): ChatAttentionSnapshot {
  return recountAttention(snapshot.items.filter((item) =>
    !item.read || item.kind === "running" || item.kind === "approval"));
}

/** 알림 하나를 목록에서 뺀다. 승인 대기는 서버가 거절하므로 화면에서도 남긴다. */
export function dismissAttentionLocally(
  snapshot: ChatAttentionSnapshot,
  id: string,
): ChatAttentionSnapshot {
  const target = snapshot.items.find((item) => item.id === id);
  if (!target || target.kind === "approval") return snapshot;
  return recountAttention(snapshot.items.filter((item) => item.id !== id));
}
