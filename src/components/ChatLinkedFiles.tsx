import { useCallback } from "react";

import { downloadChatLinkedFile, getChatLinkedFile } from "../lib/ipc";
import { useLinkedFilePreview } from "./LinkedFilePreview";

/**
 * 채팅이 남긴 링크를 그 채팅에 매달아 열고 내려받는다.
 *
 * 링크 본문은 채팅 작업 폴더 기준으로만 해석되므로 조회에는 언제나 채팅 ID가 따라붙어야
 * 하고, 붙어 있는 채팅이 없으면 어느 쪽도 성립하지 않는다. 본 채팅 화면과 AIA 팝업이
 * 같은 조합을 각자 들고 있어 여기 한 곳에 모았다 — 두 화면에서 다른 것은 채팅이 없을 때
 * 보여 줄 문장뿐이라 그것만 인자로 받는다.
 */
export function useChatLinkedFiles(activeChatId: string | null, missingChatMessage: string) {
  const requireChatId = useCallback(<T,>(read: (chatId: string) => Promise<T>): Promise<T> => (
    activeChatId ? read(activeChatId) : Promise.reject(new Error(missingChatMessage))
  ), [activeChatId, missingChatMessage]);

  const loadLinkedFile = useCallback(
    (href: string) => requireChatId((chatId) => getChatLinkedFile(chatId, href)),
    [requireChatId],
  );
  const downloadLinkedFile = useCallback(
    (href: string) => requireChatId((chatId) => downloadChatLinkedFile(chatId, href)),
    [requireChatId],
  );

  return { loadLinkedFile, downloadLinkedFile, linkedFilePreview: useLinkedFilePreview(loadLinkedFile) };
}
