import type { ChatAttentionItem, SessionSummary } from "../types";

export type RecentSessionStatus = "running" | "completed" | "cancelled" | "failed";

export interface RecentSessionActivity {
  status: RecentSessionStatus;
  occurredAt: number | null;
}

/**
 * 최근 세션과 같은 공급자 세션 ID를 가진 가장 최신 실행 이벤트를 찾는다.
 * 알림이 이미 정리된 과거 세션은 카탈로그에 남은 정상 종료 세션으로 표시한다.
 */
export function recentSessionActivity(
  session: Pick<SessionSummary, "source" | "id" | "startedAt" | "updatedAt">,
  items: ChatAttentionItem[],
): RecentSessionActivity {
  const latest = items
    .filter((item) => item.source === session.source
      && item.providerSessionId === session.id
      && item.kind !== "approval")
    .reduce<ChatAttentionItem | null>((current, item) => (
      current === null || item.createdAt > current.createdAt ? item : current
    ), null);

  if (!latest) {
    return { status: "completed", occurredAt: session.updatedAt ?? session.startedAt };
  }
  if (latest.kind === "running") {
    return { status: "running", occurredAt: latest.createdAt };
  }
  if (latest.kind === "completed") {
    return { status: "completed", occurredAt: latest.createdAt };
  }
  return {
    status: latest.detail === "interrupted" ? "cancelled" : "failed",
    occurredAt: latest.createdAt,
  };
}

/** 진행 중 배지에 표시할 경과 시간. 초 단위 흔들림 없이 분 단위로 갱신한다. */
export function formatRunningElapsed(startedAt: number | null, nowMs: number): string {
  if (startedAt === null || !Number.isFinite(startedAt)) return "시간 확인 중";
  const minutes = Math.floor(Math.max(0, nowMs - startedAt) / 60_000);
  if (minutes < 1) return "1분 미만";
  if (minutes < 60) return `${minutes}분째`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}시간째` : `${hours}시간 ${rest}분째`;
  const days = Math.floor(hours / 24);
  const hourRest = hours % 24;
  return hourRest === 0 ? `${days}일째` : `${days}일 ${hourRest}시간째`;
}
