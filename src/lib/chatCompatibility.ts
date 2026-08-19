import type { ChatEvent } from "../types";

/**
 * 실행 중인 채팅은 서버 재빌드 뒤에도 살아 있을 수 있으므로, 새 프론트가
 * 첨부 필드 도입 전 이벤트를 재연결로 받을 때도 안전하게 렌더링한다.
 */
export function normalizeChatEvent(event: ChatEvent): ChatEvent {
  if (event.type === "userInput") {
    return {
      ...event,
      attachments: Array.isArray(event.attachments) ? event.attachments : [],
    };
  }
  if (event.type === "queue") {
    return {
      ...event,
      items: Array.isArray(event.items)
        ? event.items.map((item) => ({
          ...item,
          attachments: Array.isArray(item.attachments) ? item.attachments : [],
        }))
        : [],
    };
  }
  return event;
}
