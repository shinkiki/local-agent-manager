import { useState, type ClipboardEventHandler, type FormEvent } from "react";
import type { QueuedChatMessage } from "../types";
import {
  AttachmentPicker,
  clipboardFiles,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { submitComposerOnEnter } from "../lib/composerKeys";
import { ChatBusyComposerActions, ChatQueueList } from "./Shared";
import { VoiceInputControl } from "./VoiceControls";
import { useI18n } from "../lib/i18n";

/**
 * 작성기가 위에서 받는 초안 한 벌과 그 초안을 내보내는 네 갈래(전송·대기열·얹기·중단).
 * 일반 채팅 작성기와 AIA 팝업 작성기가 같은 목록을 각자 적고 있어, 한쪽에 손잡이를
 * 더하면 다른 쪽 타입만 조용히 뒤처졌다. 껍데기(자리 이름·행 수·안내문)는 화면마다
 * 다르므로 그대로 두고, 두 곳이 반드시 같아야 하는 이 목록만 이름 하나로 모은다.
 */
export interface ChatComposerDraftHandles {
  value: string;
  attachments: ChatAttachmentDraft[];
  uploading: boolean;
  busy: boolean;
  /** 진행 중인 작업에 메시지를 그대로 얹을 수 있는 공급자인지. */
  canDeliver: boolean;
  onChange: (value: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (draft: ChatAttachmentDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onQueue: () => void;
  onDeliver: () => void;
  onInterrupt: () => void;
}

/**
 * 붙여넣은 클립보드에 파일이 들어 있으면 첨부로 받는다. 세 입력창(채팅 작성기·AIA
 * 작성기·연결 전 첫 메시지)이 같은 세 줄을 각자 적고 있었다.
 */
export function attachPastedFiles(
  onAddFiles: (files: File[]) => void,
): ClipboardEventHandler<HTMLTextAreaElement> {
  return (event) => {
    const files = clipboardFiles(event);
    if (files.length > 0) onAddFiles(files);
  };
}

/**
 * 보내기 자리의 두 파생값. `hasDraft`는 보낼 것이 있는지이고, `sendMenuActive`는 이
 * 자리가 '보낼 방법 고르기' 메뉴를 붙든 상태인지다.
 *
 * 메뉴를 열어 두고 항목을 고르는 사이에 응답이 끝나면, 이 자리가 '전송' 버튼으로
 * 바뀌면서 열려 있던 팝오버가 통째로 사라졌다. 손가락은 이미 항목 위에 있었는데 눌린
 * 곳은 빈 화면이라 아무 일도 일어나지 않았다 — 메뉴가 열려 있는 동안에는 응답이 끝나도
 * 자리를 지켜, 고른 항목이 반드시 실행되게 한다. 두 작성기가 이 규칙을 두 벌로 들고
 * 있어 한쪽만 고치면 같은 증상이 다른 화면에서 되살아난다.
 */
export function useComposerSendState({ value, attachments, busy }: {
  value: string;
  attachments: ChatAttachmentDraft[];
  busy: boolean;
}) {
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  return {
    hasDraft: Boolean(value.trim() || attachments.length > 0),
    sendMenuActive: busy || sendMenuOpen,
    setSendMenuOpen,
  };
}

export function ChatComposer({
  className = "",
  ariaLabel,
  value,
  attachments,
  uploading,
  busy,
  canCompose,
  rows,
  placeholder,
  queue,
  canDeliver,
  onChange,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
  onQueue,
  onDeliver,
  onInterrupt,
  onRemoveQueued,
  onRecallQueued,
}: ChatComposerDraftHandles & {
  className?: string;
  ariaLabel: string;
  canCompose: boolean;
  rows: number;
  placeholder: string;
  queue: QueuedChatMessage[];
  onRemoveQueued: (messageId: string) => void;
  onRecallQueued: (item: QueuedChatMessage) => void;
}) {
  const { text } = useI18n();
  const { hasDraft, sendMenuActive: showSendActions, setSendMenuOpen } = useComposerSendState({ value, attachments, busy });
  return <>
    <ChatQueueList items={queue} onRemove={onRemoveQueued} onRecall={onRecallQueued} />
    <form className={`chat-composer${className ? ` ${className}` : ""}`} onSubmit={onSubmit}>
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={submitComposerOnEnter}
        onPaste={attachPastedFiles(onAddFiles)}
        rows={rows}
        placeholder={placeholder}
        disabled={!canCompose}
      />
      <VoiceInputControl value={value} disabled={!canCompose} onChange={onChange} />
      <AttachmentPicker drafts={attachments} disabled={!canCompose} onAdd={onAddFiles} onRemove={onRemoveAttachment} />
      <div className={`chat-composer-actions${showSendActions ? " is-busy" : ""}`}>
        {showSendActions ? <ChatBusyComposerActions
          hasDraft={hasDraft}
          sendDisabled={uploading || !hasDraft}
          sending={uploading}
          canDeliver={canDeliver}
          onOpenChange={setSendMenuOpen}
          onInterrupt={onInterrupt}
          onQueue={onQueue}
          onDeliver={onDeliver}
        /> : <button className="button primary" type="submit" disabled={!canCompose || !hasDraft}>
          {uploading ? text("첨부 중…", "Attaching…") : text("전송", "Send")}
        </button>}
      </div>
    </form>
  </>;
}
