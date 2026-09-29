import { groupAttentionItems } from "./attentionGroups.ts";
import { sourceName } from "./format.ts";
import type { ChatAttentionItem, ProjectRegistryEntry, SessionSummary } from "../types";
import type { NotificationOpenTarget } from "./notificationOpen.ts";
import { runtimeText } from "./i18nRuntime.ts";

type NotificationAttention = Pick<
  ChatAttentionItem,
  "source" | "providerSessionId" | "cwd" | "title"
> & Partial<Pick<ChatAttentionItem, "kind" | "detail" | "id" | "chatId">>;

type NotificationSession = Pick<SessionSummary, "source" | "id" | "title">;

export function attentionNotificationDetail(
  item: NotificationAttention,
  sessions: NotificationSession[],
): string {
  // 계정 전환과 페이싱 제안은 세션·폴더가 없다. 어느 공급자의 일인지 앞에 붙이고,
  // 백엔드가 만든 문구("A → B · 사유", 관측 요약)를 본문으로 쓴다.
  if (item.kind === "accountSwitch" || item.kind === "pacingSuggestion") {
    return `${sourceName(item.source)}: ${item.detail?.trim() || item.title}`;
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
  /** 알림을 눌렀을 때 열 대상. 없으면 앱만 앞으로 가져온다. native는 아직 쓰지 않는다. */
  open?: NotificationOpenTarget;
}

type NotifiableAttentionKind = Exclude<ChatAttentionItem["kind"], "running">;

/**
 * 기기 알림으로 내보낼 상태와 제목. `running`은 진행 표시일 뿐 알림 대상이
 * 아니므로 키에서 빼고, 나머지 상태는 `Record`가 모두 채우게 한다. 상태가 늘어났는데
 * 연속 조건문에 제목을 더하지 않아 알림이 조용히 사라지는 일을 타입으로 막는다.
 *
 * 값은 문구 짝이 아니라 **문구를 만드는 호출**이다. 짝을 표에 적고 `runtimeText(...짝)`로
 * 펼치면 정적 감사·카탈로그 수집이 그 문구를 `runtimeText` 인자로 보지 못해, 감싸지 않은
 * 한국어로 세고 영어 짝을 카탈로그에서 떨어뜨린다. 언어는 호출 시점에 정해져야 하므로
 * 표에는 값이 아니라 호출을 담는다.
 */
const ATTENTION_LABELS: Record<NotifiableAttentionKind, () => string> = {
  approval: () => runtimeText("승인 필요", "Approval required"),
  completed: () => runtimeText("작업 완료", "Task completed"),
  failed: () => runtimeText("작업 실패", "Task failed"),
  accountSwitch: () => runtimeText("계정 자동전환", "Automatic account switch"),
  pacingSuggestion: () => runtimeText("페이싱 제안", "Pacing suggestion"),
};

function kindLabel(kind: ChatAttentionItem["kind"]): string | undefined {
  return kind === "running" ? undefined : ATTENTION_LABELS[kind]();
}

/** 묶음 크기에 맞춰 단건·복수건 알림 문구를 만든다. */
function groupedAttentionNotification(
  label: string,
  detail: string,
  count: number,
  tag: string,
  open: NotificationOpenTarget,
): DeviceNotification {
  if (count === 1) return { title: label, body: detail, tag, open };
  return {
    title: runtimeText(`${label} ${count}건`, `${label} (${count})`),
    body: runtimeText(`${detail} 외 ${count - 1}건`, `${detail} and ${count - 1} more`),
    tag,
    open,
  };
}

/**
 * 새로 뜬 알림들을 기기 알림 문구로 옮긴다. 인앱 알림창과 같은 기준으로 묶어
 * (동일 대화·반복 요청·워크플로 회차) 묶음마다 한 건만 내보낸다. 회차 하나를 스무
 * 갈래로 돌리면 그러지 않고서는 기기가 스무 번 울린다.
 *
 * 묶음 키를 그대로 `tag`로 쓰므로, 다음 회차의 알림은 새로 쌓이지 않고 같은 자리의
 * 알림을 갈아 끼운다. 한 반복 요청은 기기에 한 줄만 차지한다. 알린 내역이 필요하면
 * 인앱 알림창이 언제나 기준이다.
 *
 * 누르면 여는 대상은 묶음의 대표 항목이다. 인앱 알림창에서 묶음 머리줄을 누르는 것과
 * 같은 곳으로 간다.
 */
export function attentionNotifications(
  fresh: ChatAttentionItem[],
  sessions: NotificationSession[],
): DeviceNotification[] {
  return groupAttentionItems(fresh).flatMap((group) => {
    const label = kindLabel(group.lead.kind);
    if (!label) return [];
    const detail = attentionNotificationDetail(group.lead, sessions);
    const open = { attentionId: group.lead.id, chatId: group.lead.chatId };
    return [groupedAttentionNotification(label, detail, group.items.length, group.key, open)];
  });
}

/**
 * 새로 감지된 프로젝트들을 기기 알림 문구로 옮긴다.
 * 각 프로젝트 경로를 태그로 삼아 같은 프로젝트의 알림이 중복 누적되지 않고 갈아 끼운다.
 */
export function projectNotifications(
  fresh: readonly Pick<ProjectRegistryEntry, "name" | "path">[],
): DeviceNotification[] {
  return fresh.map((project) => ({
    title: runtimeText("새 프로젝트 감지", "New project detected"),
    body: runtimeText(`${project.name} · 활성 유지 또는 제외를 정하세요`, `${project.name} · Keep active or exclude it`),
    tag: `new-project:${project.path}`,
  }));
}

/**
 * 만료가 사흘 앞으로 다가온 계정을 기기 알림 문구로 옮긴다. 만료되고 나면 재인증
 * 말고는 되살릴 길이 없으므로, 본문은 남은 기간과 해야 할 일을 함께 적는다.
 *
 * 태그는 계정별로 하나다. 이 알림은 사슬마다 한 번만 나가지만, 같은 계정의 이전 만료
 * 알림이 화면에 남아 있다면 새 알림이 그 자리를 갈아 끼우는 편이 맞다.
 */
export function credentialExpiryNotifications(
  fresh: readonly { id: string; displayName: string; days: number }[],
): DeviceNotification[] {
  return fresh.map((account) => ({
    title: runtimeText("계정 인증 만료 임박", "Account authentication expiring"),
    body: runtimeText(
      `${account.displayName} · ${account.days}일 뒤 만료됩니다. 미리 재인증하세요`,
      `${account.displayName} · expires in ${account.days} day${account.days === 1 ? "" : "s"}. Re-authenticate now`,
    ),
    tag: `credential-expiry:${account.id}`,
  }));
}
