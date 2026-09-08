import { useState, type FormEvent } from "react";
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
}: {
  className?: string;
  ariaLabel: string;
  value: string;
  attachments: ChatAttachmentDraft[];
  uploading: boolean;
  busy: boolean;
  canCompose: boolean;
  rows: number;
  placeholder: string;
  queue: QueuedChatMessage[];
  /** 진행 중인 작업에 메시지를 그대로 얹을 수 있는 공급자인지. */
  canDeliver: boolean;
  onChange: (value: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (draft: ChatAttachmentDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onQueue: () => void;
  onDeliver: () => void;
  onInterrupt: () => void;
  onRemoveQueued: (messageId: string) => void;
  onRecallQueued: (item: QueuedChatMessage) => void;
}) {
  const { text } = useI18n();
  const hasDraft = Boolean(value.trim() || attachments.length > 0);
  /**
   * 메뉴를 열어 두고 항목을 고르는 사이에 응답이 끝나면, 이 자리가 '전송' 버튼으로
   * 바뀌면서 열려 있던 팝오버가 통째로 사라졌다. 손가락은 이미 항목 위에 있었는데
   * 눌린 곳은 빈 화면이라 아무 일도 일어나지 않았다 — 메뉴가 열려 있는 동안에는
   * 응답이 끝나도 자리를 지켜, 고른 항목이 반드시 실행되게 한다.
   */
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const showSendActions = busy || sendMenuOpen;
  return <>
    <ChatQueueList items={queue} onRemove={onRemoveQueued} onRecall={onRecallQueued} />
    <form className={`chat-composer${className ? ` ${className}` : ""}`} onSubmit={onSubmit}>
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={submitComposerOnEnter}
        onPaste={(event) => {
          const files = clipboardFiles(event);
          if (files.length > 0) onAddFiles(files);
        }}
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
