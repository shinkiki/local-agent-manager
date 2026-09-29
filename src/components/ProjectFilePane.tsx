import { File, FileWarning } from "lucide-react";
import { codeLanguageForPath } from "../lib/codeLanguages";
import { documentFileName } from "../lib/documentWorkspace";
import { formatBytes, formatDate } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { ProjectFileView } from "../types";
import { HighlightedCodeBlock } from "./LinkedFilePreview";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * 프로젝트 화면의 파일 뷰어. 문서 화면의 `DocumentFilePane`과 머리말 모양은 같지만 편집·저장·
 * 다운로드가 없다 — 프로젝트 폴더는 에이전트가 일하는 곳이고 이 화면은 그 결과를 읽는 자리라,
 * 편집 갈래를 여기 붙이면 `DocumentFilePane`의 초안·편집 상태를 통째로 끌어와야 한다. 그
 * 창을 일반화하는 대신 읽기 갈래만 따로 둔다.
 */
export function ProjectFilePane({ file }: { file: ProjectFileView }) {
  const { text } = useI18n();
  const name = documentFileName(file.relativePath);
  return (
    <>
      <header className="doc-header project-file-header">
        <div className="doc-header-leading">
          <div className="doc-header-title">
            <strong data-user-content>{name}</strong>
            <span data-user-content>{file.relativePath} · {formatBytes(file.sizeBytes)} · {formatDate(file.modifiedAt)}</span>
          </div>
        </div>
        <div className="doc-header-actions">
          <span className="project-file-readonly">{text("읽기 전용", "Read-only")}</span>
        </div>
      </header>
      <ProjectFileBody file={file} />
    </>
  );
}

function ProjectFileBody({ file }: { file: ProjectFileView }) {
  const { text } = useI18n();
  if (file.kind === "markdown") return <MarkdownPreview source={file.content ?? ""} />;
  if (file.kind === "text") {
    return (
      <HighlightedCodeBlock
        content={file.content ?? ""}
        language={codeLanguageForPath(file.relativePath)}
        className="document-file-code"
        ariaLabel={text("읽기 전용 텍스트 미리보기", "Read-only text preview")}
      />
    );
  }
  // 문서 화면의 안내 문구를 그대로 쓴다. 차이는 내려받기 갈래가 없다는 것뿐이라, 그 자리에
  // 이 화면이 읽기 전용임을 적는다.
  const presentation = file.kind === "tooLarge"
    ? {
      icon: <FileWarning size={24} aria-hidden="true" />,
      title: text("미리보기 크기 제한을 초과했습니다.", "This file exceeds the preview size limit."),
    }
    : {
      icon: <File size={24} aria-hidden="true" />,
      title: text("바이너리 파일은 미리보기를 지원하지 않습니다.", "Binary files cannot be previewed."),
    };
  return (
    <div className="state-panel document-file-unavailable">
      {presentation.icon}
      <p>{presentation.title}</p>
      <small>{text("이 화면은 읽기 전용이라 파일을 내려받거나 고칠 수 없습니다.", "This view is read-only; the file cannot be downloaded or edited here.")}</small>
    </div>
  );
}
