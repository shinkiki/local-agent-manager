import type { ChatAttentionItem } from "../types";

/**
 * 기기 알림을 눌렀을 때 앱이 열 대상.
 *
 * 알림 한 건은 인앱 알림 한 건(`attentionId`)에서 나온다. 그 알림이 클릭 시점에 이미
 * 지워졌을 수 있으므로 채팅 ID를 함께 실어, 알림을 못 찾아도 대화 자체는 열 수 있게 한다.
 * 묶음 알림(같은 대화·회차 여러 건)은 대표 항목 하나만 싣는다.
 */
export interface NotificationOpenTarget {
  attentionId: string;
  /** 계정 전환처럼 채팅에 묶이지 않은 알림은 빈 문자열이다. */
  chatId: string;
}

/**
 * 서비스워커가 이미 떠 있는 창에 보내는 메시지 종류. `public/sw.js`와 같은 값이어야 한다.
 *
 * 이름은 이 파일 밖으로 내보내지 않는다. 짝을 맞춰야 하는 상대는 앱 코드가 아니라
 * 서비스워커라, 이 상수를 가져다 쓰는 자리가 늘어도 그 짝이 확인되지는 않는다 — 실제로
 * 부르던 것은 자기 테스트뿐이었고, 그 시험이 상수를 가져다 쓰면 모듈과 시험이 함께
 * 틀려도 통과한다. 아래 주소 쿼리 이름 둘과 같은 자리에 두고, 시험은 `sw.js`에 적힌
 * 글자를 그대로 적어 짝을 짚는다.
 */
const NOTIFICATION_OPEN_MESSAGE = "agent-manager.open-attention";

/** 창이 없을 때 서비스워커가 새 창 주소에 싣는 쿼리 이름. `public/sw.js`와 같은 값이어야 한다. */
const OPEN_ATTENTION_PARAM = "open-attention";
const OPEN_CHAT_PARAM = "open-chat";

/**
 * 식별자에 허용하는 글자. 서비스워커가 실어 보낸 값은 알림 저장소를 거쳐 오므로 여기서
 * 한 번 좁힌다.
 *
 * 같은 글자 집합이 두 패턴에 손으로 적혀 있었다. 둘은 반드시 같아야 한다 — 한쪽만
 * 넓어지면 같은 형식의 식별자가 알림 ID로는 통과하고 채팅 ID로는 막혀(또는 그 반대로),
 * 알림을 눌렀을 때 대화가 열리지 않는 일이 값의 모양에 따라서만 드러난다. 두 패턴이
 * 실제로 다른 것은 최소 길이뿐이라, 다른 그 한 가지만 각자 적는다.
 */
const ID_CHARACTER = "[A-Za-z0-9:._-]";
const ATTENTION_ID_PATTERN = new RegExp(`^${ID_CHARACTER}{1,200}$`);
/** 채팅에 묶이지 않은 알림은 채팅 ID가 빈 문자열이므로 0자를 받는다. */
const CHAT_ID_PATTERN = new RegExp(`^${ID_CHARACTER}{0,200}$`);

function toTarget(attentionId: unknown, chatId: unknown): NotificationOpenTarget | null {
  if (typeof attentionId !== "string" || typeof chatId !== "string") return null;
  if (!ATTENTION_ID_PATTERN.test(attentionId) || !CHAT_ID_PATTERN.test(chatId)) return null;
  return { attentionId, chatId };
}

/** 서비스워커가 보낸 메시지에서 열 대상을 꺼낸다. 다른 메시지·손상된 값은 null. */
export function parseNotificationOpenMessage(data: unknown): NotificationOpenTarget | null {
  if (!data || typeof data !== "object") return null;
  const message = data as { type?: unknown; target?: unknown };
  if (message.type !== NOTIFICATION_OPEN_MESSAGE) return null;
  const target = message.target as { attentionId?: unknown; chatId?: unknown } | null | undefined;
  return target && typeof target === "object" ? toTarget(target.attentionId, target.chatId) : null;
}

/** 새 창으로 열렸을 때 주소 쿼리에서 열 대상을 꺼낸다. */
export function parseNotificationOpenSearch(search: string): NotificationOpenTarget | null {
  const params = new URLSearchParams(search);
  return toTarget(params.get(OPEN_ATTENTION_PARAM), params.get(OPEN_CHAT_PARAM));
}

/**
 * 열 대상 쿼리를 뗀 주소. 새로고침·즐겨찾기가 같은 알림을 다시 열지 않도록 앱이 대상을
 * 읽은 직후 주소를 이 값으로 바꾼다. 다른 쿼리·해시는 그대로 둔다.
 */
export function stripNotificationOpenSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(OPEN_ATTENTION_PARAM);
  params.delete(OPEN_CHAT_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * 열 대상을 현재 알림 목록에서 찾는다. 알림 ID가 우선이고, 이미 지워졌으면 같은 채팅의
 * 다른 알림도 없으므로 null을 돌려 호출부가 채팅 ID로 대화만 열게 한다.
 */
export function findNotificationOpenItem(
  target: NotificationOpenTarget,
  items: readonly ChatAttentionItem[],
): ChatAttentionItem | null {
  return items.find((item) => item.id === target.attentionId) ?? null;
}
