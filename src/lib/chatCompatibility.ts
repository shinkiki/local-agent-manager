import type { ChatEvent, ChatInputFile } from "../types";

interface AttachmentPayload {
  attachments: ChatInputFile[];
}

/** 구형·잘못된 이벤트의 배열 필드는 빈 배열로 맞춘다. */
function arrayOrEmpty<Item>(value: Item[] | null | undefined): Item[] {
  return Array.isArray(value) ? value : [];
}

/** 이전 백엔드가 첨부 필드를 생략했거나 잘못 보낸 경우 빈 배열로 맞춘다. */
function normalizeAttachments<Item extends AttachmentPayload>(item: Item): Item {
  return {
    ...item,
    attachments: arrayOrEmpty(item.attachments),
  };
}

/**
 * 실행 중인 채팅은 서버 재빌드 뒤에도 살아 있을 수 있으므로, 새 프론트가
 * 첨부 필드 도입 전 이벤트를 재연결로 받을 때도 안전하게 렌더링한다.
 */
export function normalizeChatEvent(event: ChatEvent): ChatEvent {
  if (event.type === "userInput") {
    return normalizeAttachments(event);
  }
  if (event.type === "queue") {
    return {
      ...event,
      items: arrayOrEmpty(event.items).map(normalizeAttachments),
    };
  }
  return event;
}
