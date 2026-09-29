import type { ChatAttentionItem, SessionSummary } from "../types";
import { maxByScore } from "./sequence.ts";

/**
 * 최근 세션 하나가 지금 어떤 상태인가를 알림 목록에서 읽어 내는 판정.
 *
 * 그 상태를 얼마나 오래 이어 왔는지 말해 주는 문구는 `sessionActivityText.ts`가 맡고,
 * 대시보드 카드 하나가 둘을 함께 쓰므로 그 문구는 여기서 다시 내보낸다.
 */

export { formatRunningElapsed } from "./sessionActivityText.ts";

type RecentSessionStatus = "running" | "completed" | "cancelled" | "failed";

export interface RecentSessionActivity {
  status: RecentSessionStatus;
  occurredAt: number | null;
}

type SessionTarget = Pick<SessionSummary, "source" | "id">;

/** 승인 요청을 제외하고 같은 세션을 가리키는 실행 알림인지 판정한다. */
function isSessionAttentionItem(item: ChatAttentionItem, session: SessionTarget): boolean {
  return item.source === session.source
    && item.providerSessionId === session.id
    && item.kind !== "approval";
}

/** 알림 목록에서 세션에 해당하는 가장 최신 실행 이벤트를 단일 순회로 찾는다. */
function findLatestAttentionItem(
  session: SessionTarget,
  items: readonly ChatAttentionItem[],
): ChatAttentionItem | null {
  return maxByScore(items, (item) => (
    isSessionAttentionItem(item, session) ? item.createdAt : null
  ));
}

/** 실행 알림의 종류와 세부 사유를 최근 세션 상태로 바꾼다. */
function statusFromAttentionItem(item: ChatAttentionItem): RecentSessionStatus {
  if (item.kind === "running") return "running";
  if (item.kind === "completed") return "completed";
  return item.detail === "interrupted" ? "cancelled" : "failed";
}

/**
 * 최근 세션과 같은 공급자 세션 ID를 가진 가장 최신 실행 이벤트를 찾는다.
 * 알림이 이미 정리된 과거 세션은 카탈로그에 남은 정상 종료 세션으로 표시한다.
 */
export function recentSessionActivity(
  session: Pick<SessionSummary, "source" | "id" | "startedAt" | "updatedAt">,
  items: ChatAttentionItem[],
): RecentSessionActivity {
  const latest = findLatestAttentionItem(session, items);
  if (!latest) {
    return { status: "completed", occurredAt: session.updatedAt ?? session.startedAt };
  }
  return {
    status: statusFromAttentionItem(latest),
    occurredAt: latest.createdAt,
  };
}
