import type { FormEvent } from "react";
import type { QueuedChatMessage } from "../types";
import {
  AttachmentPicker,
  clipboardFiles,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { ChatBusyComposerActions, ChatQueueList } from "./Shared";
import { VoiceInputControl } from "./VoiceControls";

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
  onChange,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
  onQueue,
  onSteer,
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
  onChange: (value: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (draft: ChatAttachmentDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onQueue: () => void;
  onSteer: () => void;
  onInterrupt: () => void;
  onRemoveQueued: (messageId: string) => void;
  onRecallQueued: (item: QueuedChatMessage) => void;
}) {
  const hasDraft = Boolean(value.trim() || attachments.length > 0);
  return <>
    <ChatQueueList items={queue} onRemove={onRemoveQueued} onRecall={onRecallQueued} />
    <form className={`chat-composer${className ? ` ${className}` : ""}`} onSubmit={onSubmit}>
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
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
      <div className={`chat-composer-actions${busy ? " is-busy" : ""}`}>
        {busy ? <ChatBusyComposerActions
          hasDraft={hasDraft}
          sendDisabled={uploading || !hasDraft}
          sending={uploading}
          onInterrupt={onInterrupt}
          onQueue={onQueue}
          onSteer={onSteer}
        /> : <button className="button primary" type="submit" disabled={!canCompose || !hasDraft}>
          {uploading ? "첨부 중…" : "전송"}
        </button>}
      </div>
    </form>
  </>;
}
