import type { ChatAttentionItem } from "../types";

/**
 * 알림 묶음의 기준. 한 화면에 같은 사건이 여러 줄로 쌓이는 세 경우를 접는다.
 *
 * - `chat` 한 대화가 턴마다 남긴 알림(동일건)
 * - `schedule` 한 반복 요청이 회차마다 남긴 알림(반복건)
 * - `workflow` 반복 요청 없이 돌린 워크플로가 실행마다 남긴 알림
 * - `account` 한 공급자의 계정 자동전환. 대화가 없어 대화 기준으로는 묶이지 않는다.
 *
 * 사용량 페이싱이 한 회차를 여러 갈래로 동시에 띄우면(`pacing.maxRuns`) 실행 id는
 * 갈래마다 달라지고 소비자 id만 같다. 그래서 워크플로 병렬 실행을 한 묶음으로 접는
 * 기준은 실행 id가 아니라 소비자 id다.
 */
export type AttentionGroupReason = "chat" | "schedule" | "workflow" | "account";

export interface AttentionGroup {
  key: string;
  reason: AttentionGroupReason;
  /** 묶음을 대표하는 가장 새로운 항목. 묶음이 한 건이면 그 항목 자신이다. */
  lead: ChatAttentionItem;
  /** 새로운 것부터. 원래 목록의 순서를 그대로 물려받는다. */
  items: ChatAttentionItem[];
  /** 읽지 않은 건수. 승인 대기는 읽음 여부와 무관하게 항상 센다(`recountAttention`과 같은 규칙). */
  unreadCount: number;
  /** 승인 대기가 하나도 없을 때만 통째로 지울 수 있다. 서버가 승인 대기 삭제를 거절한다. */
  dismissable: boolean;
  /** 묶음에 든 작업 경로의 마지막 조각들. 처음 나온 순서대로, 중복 없이. */
  folders: string[];
}

/** 묶음의 범위. 공급자와 종류는 아이콘·배지가 묶음마다 하나뿐이라 늘 키에 함께 넣는다. */
function groupScope(item: ChatAttentionItem): { reason: AttentionGroupReason; scope: string } {
  if (item.kind === "accountSwitch") return { reason: "account", scope: "account" };
  const origin = item.origin;
  const consumerId = origin?.consumerId ?? origin?.scheduleId ?? null;
  if (consumerId) {
    // 소비자 id는 반복 요청이 있으면 그 id, 없으면 워크플로 id다. 반복 요청이 워크플로를
    // 돌린 회차는 둘 다 있으므로 반복 요청 쪽을 이름으로 삼는다 — 사용자가 만들고 멈추는
    // 것이 그쪽이다. 출처 종류로 고르면 같은 회차의 알림이 어느 단계에서 났는지에 따라
    // 이름이 흔들린다.
    return { reason: origin?.scheduleId ? "schedule" : "workflow", scope: `consumer:${consumerId}` };
  }
  if (origin?.workflowId) return { reason: "workflow", scope: `workflow:${origin.workflowId}` };
  return { reason: "chat", scope: `chat:${item.chatId}` };
}

/** 경로의 마지막 조각. 알림 줄에 이미 쓰는 표기와 같다. */
export function attentionFolderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/**
 * 알림 목록을 묶음 목록으로 옮긴다. 묶음은 가장 새로운 구성원이 있던 자리에 서므로
 * 목록 전체의 시간 순서는 그대로다. 한 건짜리 묶음도 그대로 만들어, 화면은 건수만
 * 보고 접힌 줄과 낱개 줄을 고르면 된다.
 */
export function groupAttentionItems(items: ChatAttentionItem[]): AttentionGroup[] {
  const groups: AttentionGroup[] = [];
  const byKey = new Map<string, AttentionGroup>();
  for (const item of items) {
    const { reason, scope } = groupScope(item);
    const key = `${scope}\u0000${item.source}\u0000${item.kind}`;
    const unread = !item.read || item.kind === "approval" ? 1 : 0;
    const folder = attentionFolderName(item.cwd);
    const existing = byKey.get(key);
    if (!existing) {
      const group: AttentionGroup = {
        key,
        reason,
        lead: item,
        items: [item],
        unreadCount: unread,
        dismissable: item.kind !== "approval",
        folders: folder ? [folder] : [],
      };
      byKey.set(key, group);
      groups.push(group);
      continue;
    }
    existing.items.push(item);
    existing.unreadCount += unread;
    existing.dismissable &&= item.kind !== "approval";
    if (folder && !existing.folders.includes(folder)) existing.folders.push(folder);
  }
  return groups;
}

/**
 * 접힌 줄의 둘째 줄에 쓸 작업 경로 요약. 앞의 두 곳만 이름으로 적고 나머지는 수로
 * 줄인다. 병렬 회차는 갈래마다 경로가 달라, 이 줄이 몇 갈래가 돌았는지를 알려 준다.
 *
 * 꼬리("외 N곳")는 UI 언어를 타므로 호출부가 언어별 문장으로 준다. 수와 단위를 따로 그리면
 * 정적 치환기가 단위만 바꿔 "2items"처럼 붙어 나오므로, 꼬리는 반드시 한 문장으로 받는다.
 */
export function attentionFolderSummary(folders: string[], more: (count: number) => string = (count) => `외 ${count}곳`): string {
  if (folders.length === 0) return "";
  if (folders.length <= 2) return folders.join(", ");
  return `${folders.slice(0, 2).join(", ")} ${more(folders.length - 2)}`;
}
