import { useMemo, type ReactNode } from "react";
import { Download, Eye, File, FileWarning, SquarePen } from "lucide-react";
import { hasNativeShell } from "../lib/backend";
import { codeLanguageForPath } from "../lib/codeHighlight";
import { formatBytes, formatDate } from "../lib/format";
import { documentFileName } from "../lib/documentWorkspace";
import { useI18n } from "../lib/i18n";
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

type DocumentFileHeaderProps = Pick<
  DocumentFilePaneProps,
  | "file"
  | "editing"
  | "dirty"
  | "saving"
  | "downloading"
  | "headerLeading"
  | "onEditingChange"
  | "onSave"
  | "onDownload"
>;

type DocumentFileBodyProps = Pick<
  DocumentFilePaneProps,
  "file" | "draft" | "editing" | "onDraftChange" | "onOpenLocalLink"
>;

/**
 * 머리말과 본문은 이 창이 받은 칸의 부분집합만 읽고, 무엇을 읽는지는 위의 두 `Pick`이
 * 이미 적고 있다. 그런데도 창이 그 열넷을 손으로 다시 나열해, 칸이 하나 늘면 계약 한
 * 자리(props)와 전달 두 자리를 함께 고쳐야 했다 — 실제로 `onOpenLocalLink`가 늘었을 때
 * 본문 전달에 그 한 줄을 더하는 일이 따로 남아 있었다. 문서 화면의 다른 자리(트리 창의
 * `DocumentTreeView`, 사이드바의 `rootList`·`newFile`·`tree`)가 이미 그러듯 받은 묶음을
 * 그대로 넘겨, 칸이 느는 자리를 계약 하나로 모은다.
 */
export function DocumentFilePane(props: DocumentFilePaneProps) {
  return (
    <>
      <DocumentFileHeader {...props} />
      <DocumentFileBody {...props} />
    </>
  );
}

/**
 * 문서 파일 창 머리말. 파일 정보(이름, 상대 경로, 크기, 수정 일시)와 조작 액션(다운로드,
 * 미리보기/편집 토글, 저장 버튼)을 표시한다.
 */
function DocumentFileHeader({
  file,
  editing,
  dirty,
  saving,
  downloading,
  headerLeading,
  onEditingChange,
  onSave,
  onDownload,
}: DocumentFileHeaderProps) {
  const { text } = useI18n();
  // 편집·저장 버튼이 붙는 조건은 Markdown인지 하나뿐이다. 본문도 같은 조건으로 갈리므로
  // 한 값으로 두어 머리말과 본문이 어긋날 수 없게 한다.
  const markdown = file.kind === "markdown";
  const downloadLabel = text("파일 다운로드", "Download file");
  const editingToggleLabel = editing ? text("미리보기", "Preview") : text("편집", "Edit");

  return (
    <header className="doc-header document-file-header">
      <div className="doc-header-leading">
        {headerLeading}
        <div className="doc-header-title">
          <strong>{documentFileName(file.relativePath)}</strong>
          <span>{file.relativePath} · {formatBytes(file.sizeBytes)} · {formatDate(file.modifiedAt)}</span>
        </div>
      </div>
      <div className="doc-header-actions">
        {downloadableHere(file) && (
          <button
            className="icon-button"
            type="button"
            disabled={downloading}
            onClick={() => void onDownload()}
            aria-label={downloadLabel}
            title={downloadLabel}
          >
            <Download size={15} />
          </button>
        )}
        {markdown && (
          <button
            className={editing ? "icon-button active" : "icon-button"}
            type="button"
            onClick={() => onEditingChange(!editing)}
            aria-label={editingToggleLabel}
            title={editingToggleLabel}
          >
            {editing ? <Eye size={15} /> : <SquarePen size={15} />}
          </button>
        )}
        {markdown && editing && (
          <button className="button primary" type="button" disabled={saving || !dirty} onClick={() => void onSave()}>
            {saving ? text("저장 중…", "Saving…") : text("저장", "Save")}
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * 파일 종류에 따른 본문 표시. Markdown(편집/미리보기)·일반 텍스트·미지원(크기 초과/바이너리)의
 * 분기를 깔끔한 가드로 갈라 다단 삼항식을 걷어낸다.
 */
function DocumentFileBody({
  file,
  draft,
  editing,
  onDraftChange,
  onOpenLocalLink,
}: DocumentFileBodyProps) {
  if (file.kind === "markdown") {
    return editing ? (
      <textarea
        className="doc-editor"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        spellCheck={false}
      />
    ) : (
      <MarkdownPreview source={draft} onOpenLocalLink={onOpenLocalLink} />
    );
  }

  if (file.kind === "text") {
    return <DocumentTextPreview file={file} />;
  }

  return <DocumentUnavailablePreview file={file} />;
}

function DocumentTextPreview({ file }: { file: DocumentFile }) {
  const { text } = useI18n();
  const language = useMemo(() => codeLanguageForPath(file.relativePath), [file.relativePath]);

  return (
    <HighlightedCodeBlock
      content={file.content ?? ""}
      language={language}
      className="document-file-code"
      ariaLabel={text("읽기 전용 텍스트 미리보기", "Read-only text preview")}
    />
  );
}

/**
 * 이 셸에서 이 파일을 내려받을 수 있는가. 백엔드가 보내는 `downloadable`은 파일 전체를
 * 응답 본문에 싣는 브라우저 경로의 한도(100MB)를 말한다. 데스크톱 셸은 바이트를 웹뷰로
 * 나르지 않고 Rust가 곧장 복사하므로 그 한도가 없다.
 */
function downloadableHere(file: DocumentFile): boolean {
  return file.downloadable || hasNativeShell();
}

/** 크기 초과 또는 바이너리 파일의 안내 화면. 다운로드 가능 여부 안내 문구를 한곳으로 모은다. */
function DocumentUnavailablePreview({ file }: { file: DocumentFile }) {
  const { text } = useI18n();
  // 파일 종류 하나로 함께 정해지는 아이콘과 제목을 한 갈래에서 만든다. 둘을 따로
  // 분기하면 새 미지원 종류를 더할 때 서로 다른 상태를 설명할 수 있다(QA #58).
  const presentation = file.kind === "tooLarge"
    ? {
      icon: <FileWarning size={24} aria-hidden="true" />,
      title: text("미리보기 크기 제한을 초과했습니다.", "This file exceeds the preview size limit."),
    }
    : {
      icon: <File size={24} aria-hidden="true" />,
      title: text("바이너리 파일은 미리보기를 지원하지 않습니다.", "Binary files cannot be previewed."),
    };
  const detail = downloadableHere(file)
    ? text("파일을 다운로드해 확인할 수 있습니다.", "Download the file to view it.")
    : text("이 파일은 다운로드할 수 없습니다.", "This file cannot be downloaded.");

  return (
    <div className="state-panel document-file-unavailable">
      {presentation.icon}
      <p>{presentation.title}</p>
      <small>{detail}</small>
    </div>
  );
}
