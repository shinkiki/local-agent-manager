/**
 * chatId를 열쇠로 화면에만 남는 채팅별 기억. 작성 중이던 글과 첨부, 떠날 때의 스크롤
 * 위치, 그리고 '마지막 보낸 메시지부터' 모드가 이미 옮겨 준 사용자 메시지 표시를 담는다.
 *
 * 세 가지 모두 서버에 저장되지 않고 같은 chatId가 다시 열릴 때만 쓸모가 있어 수명이
 * 하나다 — 종료했거나 재개로 새 chatId를 받은 런타임의 열쇠는 다시 나타나지 않으므로
 * 함께 지워야 쌓이지 않는다. 대화 화면에 Map 셋으로 흩어져 있으면 그 규칙이 지우는 쪽
 * 한 함수에만 적혀, 넣는 자리가 늘 때 조용히 새는 열쇠가 생긴다. 넣기·읽기·지우기를
 * 여기 한 벌로 둔다.
 */
import { useCallback, useMemo, useRef } from "react";
import type { ChatAttachmentDraft } from "./ChatAttachments";

/** 입력창에 남아 있던 글과 첨부 한 벌. 돌아올 때 그대로 입력창에 다시 올린다. */
interface ChatComposerDraft {
  text: string;
  attachments: ChatAttachmentDraft[];
}

export interface ChatLocalMemory {
  /** 채팅을 떠나기 전에 그 채팅 몫으로 초안과 스크롤 위치를 남긴다. */
  remember: (chatId: string, draft: ChatComposerDraft, scrollTop: number) => void;
  /** 다시 열릴 일이 없는 chatId가 남긴 기억을 모두 지운다. */
  forget: (chatId: string) => void;
  draftOf: (chatId: string) => ChatComposerDraft | undefined;
  scrollTopOf: (chatId: string) => number | undefined;
  /** 이 사용자 메시지 자리로 이미 화면을 옮겼는가. 같은 자리로 다시 옮기지 않으려고 본다. */
  lastUserMessageHandled: (chatId: string, messageId: string) => boolean;
  markLastUserMessageHandled: (chatId: string, messageId: string) => void;
}

export function useChatLocalMemory(): ChatLocalMemory {
  const draftsRef = useRef(new Map<string, ChatComposerDraft>());
  const scrollPositionsRef = useRef(new Map<string, number>());
  const handledLastUserMessageRef = useRef(new Map<string, string>());

  const remember = useCallback((chatId: string, draft: ChatComposerDraft, scrollTop: number) => {
    draftsRef.current.set(chatId, draft);
    scrollPositionsRef.current.set(chatId, scrollTop);
  }, []);

  const forget = useCallback((chatId: string) => {
    draftsRef.current.delete(chatId);
    scrollPositionsRef.current.delete(chatId);
    handledLastUserMessageRef.current.delete(chatId);
  }, []);

  const draftOf = useCallback((chatId: string) => draftsRef.current.get(chatId), []);
  const scrollTopOf = useCallback((chatId: string) => scrollPositionsRef.current.get(chatId), []);
  const lastUserMessageHandled = useCallback(
    (chatId: string, messageId: string) => handledLastUserMessageRef.current.get(chatId) === messageId,
    [],
  );
  const markLastUserMessageHandled = useCallback((chatId: string, messageId: string) => {
    handledLastUserMessageRef.current.set(chatId, messageId);
  }, []);

  // 묶음을 렌더마다 새로 만들면 이것을 의존성으로 적은 effect가 매 렌더 다시 돈다.
  return useMemo(
    () => ({ remember, forget, draftOf, scrollTopOf, lastUserMessageHandled, markLastUserMessageHandled }),
    [draftOf, forget, lastUserMessageHandled, markLastUserMessageHandled, remember, scrollTopOf],
  );
}
