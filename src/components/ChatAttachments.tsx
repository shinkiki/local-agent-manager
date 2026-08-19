import { useEffect, useId, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import type { ChatInputFile } from "../types";
import { directChatInputFileUrl, readChatInputFile, uploadChatInputFile } from "../lib/chat";

export const MAX_CHAT_ATTACHMENT_COUNT = 8;
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ChatAttachmentDraft {
  key: string;
  file: File | null;
  uploaded: ChatInputFile | null;
  ownedUpload: boolean;
}

export function appendAttachmentDrafts(
  current: ChatAttachmentDraft[],
  files: Iterable<File>,
): { drafts: ChatAttachmentDraft[]; error: string | null } {
  const additions = [...files];
  if (current.length + additions.length > MAX_CHAT_ATTACHMENT_COUNT) {
    return { drafts: current, error: `첨부 파일은 한 메시지에 최대 ${MAX_CHAT_ATTACHMENT_COUNT}개까지 보낼 수 있습니다.` };
  }
  for (const file of additions) {
    const limit = file.type.startsWith("image/") ? MAX_CHAT_IMAGE_BYTES : MAX_CHAT_FILE_BYTES;
    if (file.size === 0) return { drafts: current, error: `${file.name}: 빈 파일은 첨부할 수 없습니다.` };
    if (file.size > limit) return { drafts: current, error: `${file.name}: ${formatFileSize(limit)} 이하 파일만 첨부할 수 있습니다.` };
  }
  const next = additions.map((file) => ({
    key: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    file,
    uploaded: null,
    ownedUpload: true,
  }));
  return { drafts: [...current, ...next], error: null };
}

export function queuedAttachmentsToDrafts(files: ChatInputFile[]): ChatAttachmentDraft[] {
  return files.map((uploaded) => ({ key: uploaded.id, file: null, uploaded, ownedUpload: false }));
}

export async function uploadAttachmentDrafts(
  chatId: string,
  drafts: ChatAttachmentDraft[],
  onProgress: (drafts: ChatAttachmentDraft[]) => void,
): Promise<ChatAttachmentDraft[]> {
  const next = [...drafts];
  for (let index = 0; index < next.length; index += 1) {
    const draft = next[index];
    if (draft.uploaded) continue;
    if (!draft.file) throw new Error("첨부할 로컬 파일을 찾을 수 없습니다");
    const uploaded = await uploadChatInputFile(chatId, draft.file);
    next[index] = { ...draft, uploaded };
    onProgress([...next]);
  }
  return next;
}

export function clipboardFiles(event: React.ClipboardEvent): File[] {
  return [...event.clipboardData.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function AttachmentPicker({
  drafts,
  disabled,
  onAdd,
  onRemove,
}: {
  drafts: ChatAttachmentDraft[];
  disabled?: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (draft: ChatAttachmentDraft) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className="chat-attachment-picker"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        onAdd([...event.dataTransfer.files]);
      }}
    >
      {drafts.length > 0 && (
        <div className="chat-attachment-drafts" aria-label="보낼 첨부 파일">
          {drafts.map((draft) => {
            const name = draft.file?.name ?? draft.uploaded?.name ?? "파일";
            const size = draft.file?.size ?? draft.uploaded?.sizeBytes ?? 0;
            const image = draft.file?.type.startsWith("image/") || draft.uploaded?.kind === "image";
            return (
              <span className="chat-attachment-draft" key={draft.key} title={`${name} · ${formatFileSize(size)}`}>
                {image ? <ImageIcon size={14} /> : <FileText size={14} />}
                <span>{name}</span>
                <button type="button" aria-label={`${name} 첨부 제거`} onClick={() => onRemove(draft)} disabled={disabled}><X size={13} /></button>
              </span>
            );
          })}
        </div>
      )}
      <input
        id={inputId}
        ref={inputRef}
        className="chat-attachment-input"
        type="file"
        multiple
        onChange={(event) => {
          onAdd([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <button
        className="chat-attachment-button"
        type="button"
        title="이미지 또는 파일 첨부"
        aria-label="이미지 또는 파일 첨부"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || drafts.length >= MAX_CHAT_ATTACHMENT_COUNT}
      >
        <Paperclip size={17} />
      </button>
    </div>
  );
}

export function ChatAttachmentList({ chatId, files }: { chatId: string | null; files: ChatInputFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="chat-message-attachments" aria-label="첨부 파일">
      {files.map((file) => file.kind === "image" && chatId
        ? <ChatImageAttachment chatId={chatId} file={file} key={file.id} />
        : <span className="chat-file-attachment" title={`${file.name} · ${formatFileSize(file.sizeBytes)}`} key={file.id}><FileText size={14} /><span>{file.name}</span></span>)}
    </div>
  );
}

function ChatImageAttachment({ chatId, file }: { chatId: string; file: ChatInputFile }) {
  const directUrl = directChatInputFileUrl(chatId, file);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (directUrl) {
      setUrl(directUrl);
      return undefined;
    }
    let active = true;
    let objectUrl: string | null = null;
    void readChatInputFile(chatId, file).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => setUrl(null));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [chatId, directUrl, file]);
  return (
    <span className="chat-image-attachment" title={`${file.name} · ${formatFileSize(file.sizeBytes)}`}>
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <ImageIcon size={22} aria-label="이미지 미리보기를 표시할 수 없음" />}
      <span>{file.name}</span>
    </span>
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
