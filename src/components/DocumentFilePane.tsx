import { useMemo, type ReactNode } from "react";
import { Download, Eye, File, FileWarning, SquarePen } from "lucide-react";
import { codeLanguageForPath } from "../lib/codeHighlight";
import { formatBytes, formatDate } from "../lib/format";
import { documentFileName } from "../lib/documentWorkspace";
import type { DocumentFile } from "../types";
import { HighlightedCodeBlock } from "./LinkedFilePreview";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * 문서 작업대의 파일 창. 부르는 자리는 문서 화면 하나뿐이고, 그 자리는 파일을 고른 뒤에만
 * 이 창을 그리며 초안·편집·저장 콜백을 언제나 함께 넘긴다. 그래서 칸은 모두 필수다 —
 * 선택으로 두면 여기서 다시 없는 경우를 다뤄야 하는데 그 갈래에는 닿을 길이 없다.
 * `headerLeading`만 값이 없을 수 있다(사이드바가 열려 있으면 되살리기 버튼이 없다).
 */
export interface DocumentFilePaneProps {
  file: DocumentFile;
  draft: string;
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  downloading: boolean;
  headerLeading: ReactNode;
  onEditingChange: (editing: boolean) => void;
  onDraftChange: (draft: string) => void;
  onSave: () => void | Promise<void>;
  onDownload: () => void | Promise<void>;
  onOpenLocalLink: (href: string) => void;
}

export function DocumentFilePane({
  file,
  draft,
  editing,
  dirty,
  saving,
  downloading,
  headerLeading,
  onEditingChange,
  onDraftChange,
  onSave,
  onDownload,
  onOpenLocalLink,
}: DocumentFilePaneProps) {
  // 편집·저장 버튼이 붙는 조건은 Markdown인지 하나뿐이다. 본문도 같은 조건으로 갈리므로
  // 한 값으로 두어 머리말과 본문이 어긋날 수 없게 한다.
  const markdown = file.kind === "markdown";

  return (
    <>
      <header className="doc-header document-file-header">
        <div className="doc-header-leading">
          {headerLeading}
          <div className="doc-header-title">
            <strong>{documentFileName(file.relativePath)}</strong>
            <span>{file.relativePath} · {formatBytes(file.sizeBytes)} · {formatDate(file.modifiedAt)}</span>
          </div>
        </div>
        <div className="doc-header-actions">
          {file.downloadable && (
            <button
              className="icon-button"
              type="button"
              disabled={downloading}
              onClick={() => void onDownload()}
              aria-label="파일 다운로드"
              title="파일 다운로드"
            >
              <Download size={15} />
            </button>
          )}
          {markdown && (
            <button
              className={editing ? "icon-button active" : "icon-button"}
              type="button"
              onClick={() => onEditingChange(!editing)}
              aria-label={editing ? "미리보기" : "편집"}
              title={editing ? "미리보기" : "편집"}
            >
              {editing ? <Eye size={15} /> : <SquarePen size={15} />}
            </button>
          )}
          {markdown && editing && (
            <button className="button primary" type="button" disabled={saving || !dirty} onClick={() => void onSave()}>
              {saving ? "저장 중…" : "저장"}
            </button>
          )}
        </div>
      </header>
      {markdown ? (
        editing ? (
          <textarea
            className="doc-editor"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            spellCheck={false}
          />
        ) : (
          <MarkdownPreview source={draft} onOpenLocalLink={onOpenLocalLink} />
        )
      ) : file.kind === "text" ? (
        <DocumentTextPreview file={file} />
      ) : file.kind === "tooLarge" ? (
        <DocumentUnavailableState
          icon={<FileWarning size={24} aria-hidden="true" />}
          title="미리보기 크기 제한을 초과했습니다."
          detail={file.downloadable ? "파일을 다운로드해 확인할 수 있습니다." : "이 파일은 다운로드할 수 없습니다."}
        />
      ) : (
        <DocumentUnavailableState
          icon={<File size={24} aria-hidden="true" />}
          title="바이너리 파일은 미리보기를 지원하지 않습니다."
          detail={file.downloadable ? "파일을 다운로드해 확인할 수 있습니다." : "이 파일은 다운로드할 수 없습니다."}
        />
      )}
    </>
  );
}

function DocumentTextPreview({ file }: { file: DocumentFile }) {
  const language = useMemo(() => codeLanguageForPath(file.relativePath), [file.relativePath]);

  return (
    <HighlightedCodeBlock
      content={file.content ?? ""}
      language={language}
      className="document-file-code"
      ariaLabel="읽기 전용 텍스트 미리보기"
    />
  );
}

function DocumentUnavailableState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="state-panel document-file-unavailable">{icon}<p>{title}</p><small>{detail}</small></div>;
}
