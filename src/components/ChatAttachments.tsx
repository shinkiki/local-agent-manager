import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import type { ChatInputFile } from "../types";
import { directChatInputFileUrl, readChatInputFile, removeChatInputFile, uploadChatInputFile, type ChatConnection, type ChatSendOptions } from "../lib/chat";
import {
  AttachmentZoomButton,
  ChatAttachmentPreviewModal,
  attachmentTitle,
  formatFileSize,
  loadAttachmentObjectUrl,
  uploadedPreviewTarget,
  type ChatAttachmentPreviewTarget,
} from "./ChatAttachmentPreview";

const MAX_CHAT_ATTACHMENT_COUNT = 8;
const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ChatAttachmentDraft {
  key: string;
  file: File | null;
  uploaded: ChatInputFile | null;
  ownedUpload: boolean;
  /** 업로드된 파일이 속한 채팅. 로컬 파일만 있는 드래프트에서는 null이다. */
  chatId: string | null;
}

function appendAttachmentDrafts(
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
 * 목록은 그대로 둔다"는 같은 모양이었다. 상태 갱신 함수 안에서 결과만 밖으로 흘리는 이
 * 껍데기가 세 벌 있었으므로 여기 한 벌로 모은다. 붙인 결과를 별도 ref에도 옮겨 두는 자리는
 * 반환값을 그대로 쓰면 되므로 그 부분은 호출부에 남긴다.
 *
 * `onOutcome`은 **성공도 함께** 받는다(거절 없이 담겼으면 `null`). 실패만 흘리면 한 번 뜬
 * 거절 안내가 뒤이은 정상 첨부에도 그대로 남아, 목록에는 파일이 담겼는데 화면은 계속
 * 거절을 말하는 자리가 된다. 안내 자리를 첨부 전용으로 쓰는 호출부는 이 값을 그대로
 * 상태에 넣고, 다른 오류와 배너를 공유하는 호출부는 메시지가 있을 때만 넣는다.
 */
export function addAttachmentDrafts(
  current: ChatAttachmentDraft[],
  files: Iterable<File>,
  onOutcome: (message: string | null) => void,
): ChatAttachmentDraft[] {
  const result = appendAttachmentDrafts(current, files);
  onOutcome(result.error);
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

/**
 * 대화를 새로 시작하거나 전환할 때 작성창의 첨부를 새 대화 몫으로 정돈한다.
 *
 * 업로드는 대화별이라 로컬 파일이 남아 있는 것만 다시 올릴 수 있고,
 * 이전 대화에만 올라가 있던 것(대기열에서 되돌린 첨부 등)은 새 대화로
 * 옮길 수 없으므로 제외된 개수를 함께 돌려준다 — 조용히 사라지면 보낸 줄 알게 된다.
 */
export function movableAttachmentDrafts(drafts: ChatAttachmentDraft[]): { drafts: ChatAttachmentDraft[]; dropped: number } {
  const movable = drafts.filter((draft) => draft.file);
  return {
    drafts: movable.map((draft) => ({ ...draft, uploaded: null, ownedUpload: true, chatId: null })),
    dropped: drafts.length - movable.length,
  };
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

/**
 * 초안을 올린 뒤 그 메시지를 보낸다.
 *
 * 첨부를 실어 보내는 자리는 모두 "채팅에 초안을 올리고, 올라간 것에서 ID만 추려 전송에
 * 싣는다"는 같은 두 단계였는데, 추리는 줄을 자리마다 따로 적고 있었다. 업로드에 실패해
 * 로컬에만 남은 초안을 어떻게 다룰지가 한 자리만 고쳐도 조용히 갈라지는 모양이라
 * 여기 한 벌로 모은다.
 *
 * 무엇을 보낼지(인계 문맥을 앞에 실을지)와 언제 보낼지(진행 중인 턴에 얹을지)는 옮기지
 * 않았다. 그건 화면마다 다른 판단이라 상태를 쥔 쪽에 남는다.
 */
export async function sendWithAttachmentDrafts(
  connection: Pick<ChatConnection, "info" | "send">,
  text: string,
  drafts: ChatAttachmentDraft[],
  onProgress: (drafts: ChatAttachmentDraft[]) => void,
  options?: Omit<ChatSendOptions, "attachmentIds">,
): Promise<void> {
  const uploaded = await uploadAttachmentDrafts(connection.info.chatId, drafts, onProgress);
  await connection.send(text, {
    ...options,
    attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []),
  });
}

export function clipboardFiles(event: React.ClipboardEvent): File[] {
  return [...event.clipboardData.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** 드래프트에서 표시 이름·크기·이미지 여부를 일관되게 추출한다. */
function draftMeta(draft: ChatAttachmentDraft): { name: string; sizeBytes: number; image: boolean } {
  const name = draft.file?.name ?? draft.uploaded?.name ?? "파일";
  const sizeBytes = draft.file?.size ?? draft.uploaded?.sizeBytes ?? 0;
  const image = Boolean(draft.file?.type.startsWith("image/") || draft.uploaded?.kind === "image");
  return { name, sizeBytes, image };
}

/**
 * 첨부 칸 한 벌 — 확대보기 버튼, 종류 아이콘, 이름, 그리고 칸마다 다른 꼬리 조각.
 * 보낼 첨부 칩과 보낸 첨부 칩이 같은 네 겹을 각자 적고 있어 한쪽에만 손대면 같은 파일이
 * 작성기와 대화에서 다른 모양으로 섰다. 확대보기를 열 수 없는 칸은 `onZoom`을 주지 않는다.
 */
function AttachmentChip({ className, name, sizeBytes, image, onZoom, children }: {
  className: string;
  name: string;
  sizeBytes: number;
  image?: boolean;
  onZoom?: () => void;
  children?: ReactNode;
}) {
  return (
    <span className={className} title={attachmentTitle(name, sizeBytes)}>
      {onZoom && <AttachmentZoomButton name={name} onZoom={onZoom} />}
      {image ? <ImageIcon size={14} /> : <FileText size={14} />}
      <span>{name}</span>
      {children}
    </span>
  );
}

function AttachmentDraftChip({
  draft,
  disabled,
  onZoom,
  onRemove,
}: {
  draft: ChatAttachmentDraft;
  disabled?: boolean;
  onZoom: (target: ChatAttachmentPreviewTarget) => void;
  onRemove: (draft: ChatAttachmentDraft) => void;
}) {
  const { name, sizeBytes, image } = draftMeta(draft);
  const target = draftPreviewTarget(draft);
  return (
    <AttachmentChip
      className="chat-attachment-draft"
      name={name}
      sizeBytes={sizeBytes}
      image={image}
      onZoom={target ? () => onZoom(target) : undefined}
    >
      <button type="button" aria-label={`${name} 첨부 제거`} onClick={() => onRemove(draft)} disabled={disabled}>
        <X size={13} />
      </button>
    </AttachmentChip>
  );
}

/** 첨부 선택기와 전송된 첨부 목록이 함께 쓰는 확대보기 상태와 모달 배선. */
function useAttachmentPreview() {
  const [target, setTarget] = useState<ChatAttachmentPreviewTarget | null>(null);
  return {
    open: setTarget,
    dialog: target
      ? <ChatAttachmentPreviewModal target={target} onClose={() => setTarget(null)} />
      : null,
  };
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
  const preview = useAttachmentPreview();
  return (
    <div className="chat-attachment-picker">
      {drafts.length > 0 && (
        <div className="chat-attachment-drafts" aria-label="보낼 첨부 파일">
          {drafts.map((draft) => (
            <AttachmentDraftChip
              key={draft.key}
              draft={draft}
              disabled={disabled}
              onZoom={preview.open}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
      {preview.dialog}
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
  const preview = useAttachmentPreview();
  if (files.length === 0) return null;
  return (
    <div className="chat-message-attachments" aria-label="첨부 파일">
      {files.map((file) => file.kind === "image" && chatId
        ? <ChatImageAttachment chatId={chatId} file={file} onZoom={() => preview.open(uploadedPreviewTarget(chatId, file))} key={file.id} />
        : <AttachmentChip
            className="chat-file-attachment"
            name={file.name}
            sizeBytes={file.sizeBytes}
            onZoom={chatId ? () => preview.open(uploadedPreviewTarget(chatId, file)) : undefined}
            key={file.id}
          />)}
      {preview.dialog}
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
    return loadAttachmentObjectUrl(
      () => readChatInputFile(chatId, file),
      () => Promise.resolve(null),
      (url) => setUrl(url),
      () => setUrl(null),
    );
  }, [chatId, directUrl, file]);
  return (
    <span className="chat-image-attachment" title={attachmentTitle(file.name, file.sizeBytes)}>
      {url && !failed
        ? <button type="button" className="chat-image-attachment-thumb" title="확대보기" aria-label={`${file.name} 확대보기`} onClick={onZoom}><img src={url} alt="" onError={() => setFailed(true)} /></button>
        : <ImageIcon size={22} aria-label="이미지 미리보기를 표시할 수 없음" />}
      <span className="chat-image-attachment-caption">
        <AttachmentZoomButton name={file.name} onZoom={onZoom} />
        <span>{file.name}</span>
      </span>
    </span>
  );
}

/**
 * 작성 중인 첨부를 확대보기가 읽을 수 있는 모양으로 바꾼다. 확대보기 자체는
 * `ChatAttachmentPreview`에 있지만 이 변환은 드래프트의 생김새를 알아야 해서 여기 남는다
 * — 반대로 두면 확대보기가 드래프트를 도로 읽어 두 모듈이 서로를 부르게 된다.
 */
function draftPreviewTarget(draft: ChatAttachmentDraft): ChatAttachmentPreviewTarget | null {
  const { file } = draft;
  if (file) {
    const meta = draftMeta(draft);
    return {
      name: meta.name,
      sizeBytes: meta.sizeBytes,
      mediaType: file.type || "application/octet-stream",
      image: meta.image,
      load: () => Promise.resolve(file),
    };
  }
  if (draft.uploaded && draft.chatId) return uploadedPreviewTarget(draft.chatId, draft.uploaded);
  return null;
}
