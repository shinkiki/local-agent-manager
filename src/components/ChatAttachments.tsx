import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileText, Image as ImageIcon, Maximize2, Paperclip, X } from "lucide-react";
import type { ChatInputFile } from "../types";
import { directChatInputFileUrl, readChatInputFile, removeChatInputFile, uploadChatInputFile } from "../lib/chat";
import { codeLanguageForPath } from "../lib/codeHighlight";
import { ErrorBanner, LoadingState, useEscapeToClose } from "./Shared";
import { errorText } from "../lib/errorText";

export const MAX_CHAT_ATTACHMENT_COUNT = 8;
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ChatAttachmentDraft {
  key: string;
  file: File | null;
  uploaded: ChatInputFile | null;
  ownedUpload: boolean;
  /** 업로드된 파일이 속한 채팅. 로컬 파일만 있는 드래프트에서는 null이다. */
  chatId: string | null;
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
    chatId: null,
  }));
  return { drafts: [...current, ...next], error: null };
}

/**
 * 첨부를 더하는 자리는 모두 "현재 목록에 붙여 보고, 한도를 넘었으면 화면에 이유를 띄우고
 * 목록은 그대로 둔다"는 같은 모양이었다. 상태 갱신 함수 안에서 오류만 밖으로 흘리는 이
 * 껍데기가 세 벌 있었으므로 여기 한 벌로 모은다. 붙인 결과를 별도 ref에도 옮겨 두는 자리는
 * 반환값을 그대로 쓰면 되므로 그 부분은 호출부에 남긴다.
 */
export function addAttachmentDrafts(
  current: ChatAttachmentDraft[],
  files: Iterable<File>,
  onError: (message: string) => void,
): ChatAttachmentDraft[] {
  const result = appendAttachmentDrafts(current, files);
  if (result.error) onError(result.error);
  return result.drafts;
}

/**
 * 목록에서 뺀 드래프트가 이 화면이 올린 파일이면 서버에 남은 업로드도 지운다. 화면에서는
 * 이미 사라진 뒤라 실패를 되돌릴 자리가 없으므로 결과를 기다리지 않고 삼킨다. 채팅이 아직
 * 없거나 남이 올린 파일이면 지울 것이 없다.
 */
export function releaseAttachmentDraftUpload(draft: ChatAttachmentDraft, chatId: string | null | undefined): void {
  if (!draft.uploaded || !draft.ownedUpload || !chatId) return;
  void removeChatInputFile(chatId, draft.uploaded.id).catch(() => undefined);
}

export function queuedAttachmentsToDrafts(files: ChatInputFile[], chatId: string | null): ChatAttachmentDraft[] {
  return files.map((uploaded) => ({ key: uploaded.id, file: null, uploaded, ownedUpload: false, chatId }));
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
  const [preview, setPreview] = useState<ChatAttachmentPreviewTarget | null>(null);
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
            const target = draftPreviewTarget(draft);
            return (
              <span className="chat-attachment-draft" key={draft.key} title={`${name} · ${formatFileSize(size)}`}>
                {target && <button type="button" className="chat-attachment-zoom" aria-label={`${name} 확대보기`} title="확대보기" onClick={() => setPreview(target)}><Maximize2 size={13} /></button>}
                {image ? <ImageIcon size={14} /> : <FileText size={14} />}
                <span>{name}</span>
                <button type="button" aria-label={`${name} 첨부 제거`} onClick={() => onRemove(draft)} disabled={disabled}><X size={13} /></button>
              </span>
            );
          })}
        </div>
      )}
      {preview && <ChatAttachmentPreviewModal target={preview} onClose={() => setPreview(null)} />}
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
  const [preview, setPreview] = useState<ChatAttachmentPreviewTarget | null>(null);
  if (files.length === 0) return null;
  return (
    <div className="chat-message-attachments" aria-label="첨부 파일">
      {files.map((file) => file.kind === "image" && chatId
        ? <ChatImageAttachment chatId={chatId} file={file} onZoom={() => setPreview(uploadedPreviewTarget(chatId, file))} key={file.id} />
        : <span className="chat-file-attachment" title={`${file.name} · ${formatFileSize(file.sizeBytes)}`} key={file.id}>
            {chatId && <button type="button" className="chat-attachment-zoom" aria-label={`${file.name} 확대보기`} title="확대보기" onClick={() => setPreview(uploadedPreviewTarget(chatId, file))}><Maximize2 size={13} /></button>}
            <FileText size={14} />
            <span>{file.name}</span>
          </span>)}
      {preview && <ChatAttachmentPreviewModal target={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ChatImageAttachment({ chatId, file, onZoom }: { chatId: string; file: ChatInputFile; onZoom: () => void }) {
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
      {url && !failed
        ? <button type="button" className="chat-image-attachment-thumb" title="확대보기" aria-label={`${file.name} 확대보기`} onClick={onZoom}><img src={url} alt="" onError={() => setFailed(true)} /></button>
        : <ImageIcon size={22} aria-label="이미지 미리보기를 표시할 수 없음" />}
      <span className="chat-image-attachment-caption">
        <button type="button" className="chat-attachment-zoom" aria-label={`${file.name} 확대보기`} title="확대보기" onClick={onZoom}><Maximize2 size={13} /></button>
        <span>{file.name}</span>
      </span>
    </span>
  );
}

export interface ChatAttachmentPreviewTarget {
  name: string;
  sizeBytes: number;
  mediaType: string;
  image: boolean;
  load: () => Promise<Blob>;
}

function draftPreviewTarget(draft: ChatAttachmentDraft): ChatAttachmentPreviewTarget | null {
  const { file } = draft;
  if (file) {
    return {
      name: file.name,
      sizeBytes: file.size,
      mediaType: file.type || "application/octet-stream",
      image: file.type.startsWith("image/"),
      load: () => Promise.resolve(file),
    };
  }
  if (draft.uploaded && draft.chatId) return uploadedPreviewTarget(draft.chatId, draft.uploaded);
  return null;
}

function uploadedPreviewTarget(chatId: string, file: ChatInputFile): ChatAttachmentPreviewTarget {
  return {
    name: file.name,
    sizeBytes: file.sizeBytes,
    mediaType: file.mediaType,
    image: file.kind === "image",
    load: () => readChatInputFile(chatId, file),
  };
}

const TEXT_PREVIEW_BYTE_LIMIT = 512 * 1024;
const TEXT_PREVIEW_MEDIA = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|x-sh|javascript|typescript))/;
const TEXT_PREVIEW_EXTENSIONS = new Set(["txt", "log", "csv", "tsv", "ini", "conf", "cfg", "properties"]);

function textPreviewable(target: ChatAttachmentPreviewTarget): boolean {
  if (TEXT_PREVIEW_MEDIA.test(target.mediaType)) return true;
  if (codeLanguageForPath(target.name) !== null) return true;
  const extension = target.name.includes(".") ? target.name.slice(target.name.lastIndexOf(".") + 1).toLowerCase() : "";
  return TEXT_PREVIEW_EXTENSIONS.has(extension);
}

type PreviewContent =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; text: string | null; truncated: boolean };

export function ChatAttachmentPreviewModal({ target, onClose }: { target: ChatAttachmentPreviewTarget; onClose: () => void }) {
  useEscapeToClose(onClose);
  const [content, setContent] = useState<PreviewContent>({ status: "loading" });
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setContent({ status: "loading" });
    void target.load().then(async (blob) => {
      const text = !target.image && textPreviewable(target)
        ? await blob.slice(0, TEXT_PREVIEW_BYTE_LIMIT).text()
        : null;
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setContent({ status: "ready", url: objectUrl, text, truncated: text !== null && blob.size > TEXT_PREVIEW_BYTE_LIMIT });
    }).catch((cause: unknown) => {
      if (active) setContent({ status: "error", message: errorText(cause) });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target]);
  // 첨부 칩은 composer·메시지 어디에나 있어 겹침 문제가 없도록 최상위 레이어에 띄운다.
  return createPortal(
    <div className="chat-attachment-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="chat-attachment-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${target.name} 확대보기`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            {target.image ? <ImageIcon size={17} aria-hidden="true" /> : <FileText size={17} aria-hidden="true" />}
            <span>
              <strong>{target.name}</strong>
              <small>{target.mediaType} · {formatFileSize(target.sizeBytes)}</small>
            </span>
          </div>
          <div className="chat-attachment-preview-actions">
            {content.status === "ready" && <a className="button" href={content.url} download={target.name}><Download size={14} aria-hidden="true" />다운로드</a>}
            <button className="icon-button" type="button" onClick={onClose} aria-label="확대보기 닫기" autoFocus><X size={16} /></button>
          </div>
        </header>
        <div className="chat-attachment-preview-body">
          {content.status === "loading" ? <LoadingState label="첨부 파일을 읽고 있습니다" />
            : content.status === "error" ? <ErrorBanner message={content.message} />
            : target.image ? <img src={content.url} alt={target.name} />
            : content.text !== null ? <pre>{content.text}{content.truncated ? `\n… 파일이 커서 처음 ${formatFileSize(TEXT_PREVIEW_BYTE_LIMIT)}까지만 표시합니다.` : ""}</pre>
            : <div className="state-panel"><p>미리보기를 지원하지 않는 형식입니다. 다운로드해 확인해 주세요.</p></div>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
