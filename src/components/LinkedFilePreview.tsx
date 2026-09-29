import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ThemedTokenWithVariants, TokenStyles } from "@shikijs/core";
import { Download, FileText } from "lucide-react";
import { codeLanguageForPath, highlightCode, type CodeLanguage } from "../lib/codeHighlight";
import { formatBytes } from "../lib/format";
import type { LinkedFile } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { DialogCloseButton, DialogSurface, ErrorBanner, LoadingState, useBusyAction, useEscapeToClose } from "./Shared";
import { useRequestGeneration } from "./DocumentTreePane";

const UNSUPPORTED_PREVIEW_MESSAGE = "미리보기를 지원하지 않는 파일입니다.";

const TOKEN_FONT_STYLE = {
  italic: 1,
  bold: 2,
  underline: 4,
  lineThrough: 8,
} as const;

export type LinkedFilePreviewState =
  | { status: "loading"; href: string }
  | { status: "ready"; href: string; file: LinkedFile }
  | { status: "error"; href: string; message: string };

export function useLinkedFilePreview(loadFile: (href: string) => Promise<LinkedFile>) {
  const [state, setState] = useState<LinkedFilePreviewState | null>(null);
  const generation = useRequestGeneration();

  const open = useCallback((href: string) => {
    const requestId = generation.open();
    setState({ status: "loading", href });
    // 최신 요청일 때만 상태에 정착한다. 닫힌 미리보기를 늦은 응답이 되살리는 일을 막는다.
    void generation.latest(
      requestId,
      () => loadFile(href),
      {
        onResult: (file) => setState({ status: "ready", href, file }),
        onError: (message) => setState({ status: "error", href, message }),
      },
    );
  }, [generation, loadFile]);

  const close = useCallback(() => {
    generation.open();
    setState(null);
  }, [generation]);

  return { state, open, close };
}

/**
 * 겹쳐 뜬 연결 문서 판. 배경·판·닫기 단추는 이미 공용 껍데기(`DialogSurface`·
 * `DialogCloseButton`)가 들고 있는 것과 같은 모양인데도 이 자리만 손으로 다시 적어,
 * `role="presentation"`·`aria-modal`·배경 클릭 멈춤·닫기 단추의 아이콘 크기가 다른
 * 판들과 따로 굴러갔다. 확대보기 판(`MermaidBlock`)이 이미 그 껍데기를 쓰므로 같은
 * 모양으로 맞춘다 — 배경 클릭으로 닫히는 판이라 `aria-modal`은 예전처럼 켜진다.
 */
export function LinkedFilePreview({
  state,
  onClose,
  onDownload,
  linkImports = false,
  onOpenLocalLink,
}: {
  state: LinkedFilePreviewState;
  onClose: () => void;
  onDownload: (href: string) => Promise<void>;
  /** 지침 문서의 `@경로` 가져오기를 링크로 보여준다. */
  linkImports?: boolean;
  /** 미리보기 안의 로컬 링크를 다시 열어 연결 문서를 이어 볼 수 있게 한다. */
  onOpenLocalLink?: (href: string) => void;
}) {
  const file = state.status === "ready" ? state.file : null;
  const codeLanguage = useMemo(() => file ? codeLanguageForPath(file.relativePath) : null, [file]);
  const isMarkdown = codeLanguage?.id === "markdown";
  const download = useLinkedFileDownload(state.href, onDownload);

  useEscapeToClose(onClose);

  return (
    <DialogSurface
      backdropClassName="linked-file-backdrop"
      className="linked-file-dialog"
      label="링크 문서 미리보기"
      onBackdropClose={onClose}
    >
      <LinkedFilePreviewHeader
        file={file}
        href={state.href}
        codeLanguage={codeLanguage}
        downloading={download.downloading}
        onDownload={() => void download.run()}
        onClose={onClose}
      />
      {download.error && <div className="linked-file-download-error"><ErrorBanner message={download.error} /></div>}
      <div className="linked-file-body">
        <LinkedFilePreviewBody
          state={state}
          isMarkdown={isMarkdown}
          codeLanguage={codeLanguage}
          linkImports={linkImports}
          onOpenLocalLink={onOpenLocalLink}
        />
      </div>
    </DialogSurface>
  );
}

/**
 * 연결 문서 다운로드의 진행·오류 상태와 실행 순서를 한 벌로 다룬다. 미리보기 컴포넌트는
 * 대화상자 조립만 맡고, 링크가 바뀔 때 이전 오류를 지우는 수명주기도 이 훅 안에서 끝낸다.
 *
 * 진행 표시와 실패 문구를 다루던 열 줄은 앱 공용 봉투(`useBusyAction`)와 같은 모양이라 그
 * 한 벌을 쓴다. 이 훅에 남는 것은 그 봉투가 일부러 맡지 않는 두 가지 — 돌고 있는 동안 다시
 * 누르는 것을 막는 일과, 보는 링크가 바뀌면 앞 링크의 실패 문구를 지우는 일뿐이다.
 */
function useLinkedFileDownload(href: string, onDownload: (href: string) => Promise<void>) {
  const { busy, error, setError, run } = useBusyAction();

  useEffect(() => setError(null), [href, setError]);

  const start = async () => {
    if (busy) return;
    await run("download", () => onDownload(href));
  };

  return { downloading: busy !== null, error, run: start };
}

function LinkedFilePreviewHeader({
  file,
  href,
  codeLanguage,
  downloading,
  onDownload,
  onClose,
}: {
  file: LinkedFile | null;
  href: string;
  codeLanguage: CodeLanguage | null;
  downloading: boolean;
  onDownload: () => void;
  onClose: () => void;
}) {
  return (
    <header>
      <div>
        <FileText size={17} aria-hidden="true" />
        <span>
          <strong>{file?.relativePath ?? href}</strong>
          <small>{linkedFileSubtitle(file, codeLanguage)}</small>
        </span>
      </div>
      <div className="linked-file-actions">
        <button className="button" type="button" onClick={onDownload} disabled={downloading}>
          <Download size={14} />{downloading ? "다운로드 중…" : "다운로드"}
        </button>
        <DialogCloseButton label="미리보기 닫기" onClose={onClose} autoFocus />
      </div>
    </header>
  );
}

function linkedFileSubtitle(file: LinkedFile | null, codeLanguage: CodeLanguage | null): string {
  if (!file) return "읽기 전용 미리보기";
  const parts = [formatBytes(file.sizeBytes)];
  if (codeLanguage) parts.push(codeLanguage.label);
  if (file.targetLine) parts.push(`${file.targetLine}번째 줄`);
  return parts.join(" · ");
}

function LinkedFilePreviewBody({
  state,
  isMarkdown,
  codeLanguage,
  linkImports,
  onOpenLocalLink,
}: {
  state: LinkedFilePreviewState;
  isMarkdown: boolean;
  codeLanguage: CodeLanguage | null;
  linkImports: boolean;
  onOpenLocalLink?: (href: string) => void;
}) {
  if (state.status === "loading") {
    return <LoadingState label="링크 문서를 읽고 있습니다" />;
  }

  if (state.status === "error") {
    return state.message === UNSUPPORTED_PREVIEW_MESSAGE ? (
      <div className="state-panel"><p>{UNSUPPORTED_PREVIEW_MESSAGE}</p></div>
    ) : (
      <ErrorBanner message={state.message} />
    );
  }

  if (isMarkdown) {
    return (
      <div className="linked-file-markdown">
        <MarkdownPreview source={state.file.content} linkImports={linkImports} onOpenLocalLink={onOpenLocalLink} />
      </div>
    );
  }

  return (
    <HighlightedCodeBlock
      content={state.file.content}
      language={codeLanguage}
      targetLine={state.file.targetLine ?? null}
    />
  );
}

/**
 * 하이라이팅한 소스를 줄 번호와 함께 보여주는 읽기 전용 코드 블록. 링크 문서 미리보기와
 * 문서 파일 창이 같은 마크업·같은 하이라이팅 절차를 쓰므로 여기 한 벌만 둔다.
 *
 * 가리킨 줄을 다루는 일(범위를 벗어난 줄 버리기·강조 띠·그 줄로 스크롤)은 모두 여기서
 * 끝낸다. 예전에는 미리보기 화면이 줄 수를 따로 세어 줄 번호를 거르고, 스크롤을 맞추려고
 * 스크롤 상자의 ref를 만들어 본문 컴포넌트를 거쳐 이 블록까지 내려보냈다. 스크롤 상자는
 * 이 블록이 그리는 div 하나뿐이라, 그 ref는 바깥을 한 바퀴 돌아 제자리로 오는 값이었다.
 */
export function HighlightedCodeBlock({
  content,
  language,
  className,
  ariaLabel,
  targetLine: requestedLine = null,
}: {
  content: string;
  language: CodeLanguage | null;
  className?: string;
  ariaLabel?: string;
  /** 가리킬 줄(1부터). 본문 줄 수를 넘는 값은 없는 것으로 본다. */
  targetLine?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightedLines = useHighlightedCode(content, language);
  const lineCount = useMemo(() => countLines(content), [content]);
  const lineNumbers = useMemo(() => generateLineNumbers(lineCount), [lineCount]);
  const targetLine = requestedLine && requestedLine <= lineCount ? requestedLine : null;

  // 가리킨 줄을 화면 한가운데로 올린다. 줄 높이를 읽지 못하면(테스트 환경처럼 계산된
  // 스타일이 비어 있으면) 스크롤을 건드리지 않고 맨 위에 둔다.
  useEffect(() => {
    if (!targetLine || !containerRef.current) return;
    const lineHeight = Number.parseFloat(getComputedStyle(containerRef.current).lineHeight);
    if (!Number.isFinite(lineHeight)) return;
    containerRef.current.scrollTop = Math.max(
      0,
      (targetLine - 1) * lineHeight - containerRef.current.clientHeight / 2,
    );
  }, [content, targetLine]);

  return (
    <div
      className={className ? `linked-file-code ${className}` : "linked-file-code"}
      ref={containerRef}
      aria-label={ariaLabel}
    >
      {targetLine && <span className="linked-file-line-highlight" style={{ "--target-line": targetLine - 1 } as CSSProperties} aria-hidden="true" />}
      <pre className="linked-file-line-numbers" aria-hidden="true">{lineNumbers}</pre>
      <pre className="linked-file-source"><code>{highlightedLines ? renderHighlightedLines(highlightedLines) : content}</code></pre>
    </div>
  );
}

function useHighlightedCode(content: string, language: CodeLanguage | null) {
  const [highlighted, setHighlighted] = useState<{
    content: string;
    languageId: CodeLanguage["id"];
    lines: ThemedTokenWithVariants[][] | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    if (!content || !language) return () => { active = false; };

    // 성공과 폴백이 같은 요청 식별값을 각각 조립하지 않게 한다. 늦게 끝난 요청을 버리는
    // 조건도 이 한 자리에서 적용되어, 어느 결말이든 현재 요청에만 정착한다.
    const settle = (lines: ThemedTokenWithVariants[][] | null) => {
      if (active) setHighlighted({ content, languageId: language.id, lines });
    };
    void highlightCode(content, language)
      .then(settle)
      .catch(() => settle(null));
    return () => { active = false; };
  }, [content, language]);

  return highlighted?.content === content && highlighted.languageId === language?.id
    ? highlighted.lines
    : null;
}

function renderHighlightedLines(lines: ThemedTokenWithVariants[][]): ReactNode[] {
  return lines.flatMap((line, lineIndex) => [
    ...line.map((token, tokenIndex) => (
      <span
        className="linked-file-shiki-token"
        style={tokenStyle(token)}
        key={`${lineIndex}-${tokenIndex}`}
      >
        {token.content}
      </span>
    )),
    lineIndex < lines.length - 1 ? "\n" : null,
  ]);
}

function tokenStyle(token: ThemedTokenWithVariants): CSSProperties {
  const light = token.variants.light ?? {};
  const dark = token.variants.dark ?? light;
  const fontStyle = light.fontStyle && light.fontStyle > 0 ? light.fontStyle : 0;
  return {
    color: light.color,
    "--shiki-dark": dark.color ?? light.color,
    fontStyle: hasTokenFontStyle(fontStyle, TOKEN_FONT_STYLE.italic) ? "italic" : undefined,
    fontWeight: hasTokenFontStyle(fontStyle, TOKEN_FONT_STYLE.bold) ? 700 : undefined,
    textDecoration: tokenDecoration(fontStyle),
  } as CSSProperties;
}

function tokenDecoration(fontStyle: TokenStyles["fontStyle"]): string | undefined {
  if (!fontStyle || fontStyle < 1) return undefined;
  const decorations = [];
  if (hasTokenFontStyle(fontStyle, TOKEN_FONT_STYLE.underline)) decorations.push("underline");
  if (hasTokenFontStyle(fontStyle, TOKEN_FONT_STYLE.lineThrough)) decorations.push("line-through");
  return decorations.length > 0 ? decorations.join(" ") : undefined;
}

/** Shiki의 비트 플래그에 특정 글꼴 스타일이 들어 있는지 판정한다. */
function hasTokenFontStyle(fontStyle: number, target: number): boolean {
  return (fontStyle & target) !== 0;
}

/** 텍스트의 총 줄 수를 센다. */
function countLines(text: string): number {
  return text.split("\n").length;
}

/** 줄 번호 영역에 표시할 1부터 N까지의 줄 번호 문자열을 만든다. */
function generateLineNumbers(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
}
