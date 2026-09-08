import { groupAttentionItems } from "./attentionGroups.ts";
import type { ChatAttentionItem, SessionSummary } from "../types";

type NotificationAttention = Pick<
  ChatAttentionItem,
  "source" | "providerSessionId" | "cwd" | "title"
> & Partial<Pick<ChatAttentionItem, "kind" | "detail">>;

type NotificationSession = Pick<SessionSummary, "source" | "id" | "title">;

export function attentionNotificationDetail(
  item: NotificationAttention,
  sessions: NotificationSession[],
): string {
  // 계정 전환은 세션·폴더가 없다. 어느 공급자의 일인지 앞에 붙이고, 백엔드가 만든
  // "A → B · 사유" 문구를 본문으로 쓴다.
  if (item.kind === "accountSwitch") {
    const provider = item.source === "codex" ? "Codex" : item.source === "claude" ? "Claude" : item.source;
    return `${provider}: ${item.detail?.trim() || item.title}`;
  }
  const session = item.providerSessionId
    ? sessions.find((candidate) => (
      candidate.source === item.source && candidate.id === item.providerSessionId
    ))
    : null;
  const sessionTitle = session?.title.trim() || item.title;
  const folder = item.cwd.split(/[\\/]/).filter(Boolean).pop() ?? item.source;
  return `${sessionTitle} · ${folder}`;
}

/** 표출할 알림 한 건. 어떤 런타임으로 나가든 필요한 정보는 이 셋뿐이다. */
export interface DeviceNotification {
  title: string;
  body: string;
  /** 웹 알림에서 같은 대상의 알림을 겹쳐 쓰는 키. native는 쓰지 않는다. */
  tag: string;
}

const KIND_LABELS: Partial<Record<ChatAttentionItem["kind"], string>> = {
  approval: "승인 필요",
  completed: "작업 완료",
  failed: "작업 실패",
  accountSwitch: "계정 자동전환",
};

/**
 * 새로 뜬 알림들을 기기 알림 문구로 옮긴다. 인앱 알림창과 같은 기준으로 묶어
 * (동일 대화·반복 요청·워크플로 회차) 묶음마다 한 건만 내보낸다. 회차 하나를 스무
 * 갈래로 돌리면 그러지 않고서는 기기가 스무 번 울린다.
 *
 * 묶음 키를 그대로 `tag`로 쓰므로, 다음 회차의 알림은 새로 쌓이지 않고 같은 자리의
 * 알림을 갈아 끼운다. 한 반복 요청은 기기에 한 줄만 차지한다. 알린 내역이 필요하면
 * 인앱 알림창이 언제나 기준이다.
 */
export function attentionNotifications(
  fresh: ChatAttentionItem[],
  sessions: NotificationSession[],
): DeviceNotification[] {
  return groupAttentionItems(fresh).flatMap((group) => {
    const label = KIND_LABELS[group.lead.kind];
    if (!label) return [];
    const detail = attentionNotificationDetail(group.lead, sessions);
    return [{
      title: group.items.length > 1 ? `${label} ${group.items.length}건` : label,
      body: group.items.length > 1 ? `${detail} 외 ${group.items.length - 1}건` : detail,
      tag: group.key,
    }];
  });
}
