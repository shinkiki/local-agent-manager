import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileText, Image as ImageIcon, Maximize2, X } from "lucide-react";
import type { ChatInputFile } from "../types";
import { readChatInputFile } from "../lib/chat";
import { codeLanguageForPath } from "../lib/codeHighlight";
import { ErrorBanner, LoadingState, useEscapeToClose } from "./Shared";
import { errorText } from "../lib/errorText";

/**
 * 확대보기가 첨부에 대해 알아야 하는 전부 — 표시할 이름·크기·형식과, 내용을 내려받는 한
 * 손잡이. 아직 올리지 않은 로컬 파일과 이미 올라간 첨부는 읽는 길이 다를 뿐 확대보기가
 * 하는 일은 같으므로, 그 차이는 `load`를 만드는 쪽에서만 끝낸다.
 */
export interface ChatAttachmentPreviewTarget {
  name: string;
  sizeBytes: number;
  mediaType: string;
  image: boolean;
  load: () => Promise<Blob>;
}

export function uploadedPreviewTarget(chatId: string, file: ChatInputFile): ChatAttachmentPreviewTarget {
  return {
    name: file.name,
    sizeBytes: file.sizeBytes,
    mediaType: file.mediaType,
    image: file.kind === "image",
    load: () => readChatInputFile(chatId, file),
  };
}

/** 첨부 확대보기 버튼. 드래프트 칩·메시지 파일 칩·이미지 캡션 세 곳에서 공통으로 쓴다. */
export function AttachmentZoomButton({ name, onZoom }: { name: string; onZoom: () => void }) {
  return (
    <button
      type="button"
      className="chat-attachment-zoom"
      aria-label={`${name} 확대보기`}
      title="확대보기"
      onClick={onZoom}
    >
      <Maximize2 size={13} />
    </button>
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 첨부 한 칸에 마우스를 올렸을 때 뜨는 제목. 드래프트 칩·메시지 파일 칩·이미지 칩 셋이
 * 같은 서식을 각자 적고 있어, 한 곳만 고치면 같은 파일이 화면마다 다르게 설명됐다.
 */
export function attachmentTitle(name: string, sizeBytes: number): string {
  return `${name} · ${formatFileSize(sizeBytes)}`;
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

/**
 * 첨부를 읽어 화면이 쓸 object URL로 바꾸는 동안의 수명 관리 한 벌.
 *
 * 확대보기 모달과 이미지 썸네일이 같은 세 가지를 각각 적고 있었다 — 읽기가 끝나기 전에
 * effect가 걷히면 결과를 버리고, 만든 URL은 벗어날 때 반드시 되돌리고, 실패는 화면에만
 * 알린다. 셋 중 하나만 빠져도 새는 자리가 되는데 두 벌로 두면 한쪽만 고쳐질 수 있어
 * 여기 모은다. `prepare`는 URL을 만들기 **전에** blob에서 더 읽어야 하는 것(본문 텍스트)을
 * 위한 자리다. 무엇을 화면에 넣을지는 호출부가 그대로 쥔다.
 *
 * 반환값은 effect의 정리 함수로 그대로 쓴다.
 */
export function loadAttachmentObjectUrl<T>(
  load: () => Promise<Blob>,
  prepare: (blob: Blob) => Promise<T>,
  onReady: (url: string, prepared: T) => void,
  onFailed: (cause: unknown) => void,
): () => void {
  let active = true;
  let objectUrl: string | null = null;
  void load()
    .then(async (blob) => {
      const prepared = await prepare(blob);
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      onReady(objectUrl, prepared);
    })
    .catch((cause: unknown) => {
      if (active) onFailed(cause);
    });
  return () => {
    active = false;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

type PreviewContent =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; text: string | null; truncated: boolean };

/** 확대보기 모달의 상태별 본문 렌더링. */
function AttachmentPreviewBody({ target, content }: { target: ChatAttachmentPreviewTarget; content: PreviewContent }) {
  if (content.status === "loading") {
    return <LoadingState label="첨부 파일을 읽고 있습니다" />;
  }
  if (content.status === "error") {
    return <ErrorBanner message={content.message} />;
  }
  if (target.image) {
    return <img src={content.url} alt={target.name} />;
  }
  if (content.text !== null) {
    return (
      <pre>
        {content.text}
        {content.truncated ? `\n… 파일이 커서 처음 ${formatFileSize(TEXT_PREVIEW_BYTE_LIMIT)}까지만 표시합니다.` : ""}
      </pre>
    );
  }
  return (
    <div className="state-panel">
      <p>미리보기를 지원하지 않는 형식입니다. 다운로드해 확인해 주세요.</p>
    </div>
  );
}

export function ChatAttachmentPreviewModal({ target, onClose }: { target: ChatAttachmentPreviewTarget; onClose: () => void }) {
  useEscapeToClose(onClose);
  const [content, setContent] = useState<PreviewContent>({ status: "loading" });
  useEffect(() => {
    setContent({ status: "loading" });
    return loadAttachmentObjectUrl(
      () => target.load(),
      async (blob) => {
        const text = !target.image && textPreviewable(target)
          ? await blob.slice(0, TEXT_PREVIEW_BYTE_LIMIT).text()
          : null;
        return { text, truncated: text !== null && blob.size > TEXT_PREVIEW_BYTE_LIMIT };
      },
      (url, { text, truncated }) => setContent({ status: "ready", url, text, truncated }),
      (cause) => setContent({ status: "error", message: errorText(cause) }),
    );
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
          <AttachmentPreviewBody target={target} content={content} />
        </div>
      </section>
    </div>,
    document.body,
  );
}
