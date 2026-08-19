import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ThemedTokenWithVariants, TokenStyles } from "@shikijs/core";
import { Download, FileText, X } from "lucide-react";
import { codeLanguageForPath, highlightCode, type CodeLanguage } from "../lib/codeHighlight";
import { formatBytes } from "../lib/format";
import type { LinkedFile } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { ErrorBanner, LoadingState } from "./Shared";

const UNSUPPORTED_PREVIEW_MESSAGE = "미리보기를 지원하지 않는 파일입니다.";

export type LinkedFilePreviewState =
  | { status: "loading"; href: string }
  | { status: "ready"; href: string; file: LinkedFile }
  | { status: "error"; href: string; message: string };

export function useLinkedFilePreview(loadFile: (href: string) => Promise<LinkedFile>) {
  const [state, setState] = useState<LinkedFilePreviewState | null>(null);
  const requestIdRef = useRef(0);

  const open = useCallback((href: string) => {
    const requestId = ++requestIdRef.current;
    setState({ status: "loading", href });
    void loadFile(href)
      .then((file) => {
        if (requestId === requestIdRef.current) {
          setState({ status: "ready", href, file });
        }
      })
      .catch((cause: unknown) => {
        if (requestId === requestIdRef.current) {
          setState({
            status: "error",
            href,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
  }, [loadFile]);

  const close = useCallback(() => {
    requestIdRef.current += 1;
    setState(null);
  }, []);

  return { state, open, close };
}

export function LinkedFilePreview({
  state,
  onClose,
  onDownload,
}: {
  state: LinkedFilePreviewState;
  onClose: () => void;
  onDownload: (href: string) => Promise<void>;
}) {
  const codeRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const file = state.status === "ready" ? state.file : null;
  const codeLanguage = useMemo(() => file ? codeLanguageForPath(file.relativePath) : null, [file]);
  const isMarkdown = codeLanguage?.id === "markdown";
  const highlightedLines = useHighlightedCode(file?.content ?? null, isMarkdown ? null : codeLanguage);
  const lines = useMemo(() => file?.content.split("\n").length ?? 0, [file]);
  const targetLine = file?.targetLine && file.targetLine <= lines ? file.targetLine : null;
  const lineNumbers = useMemo(
    () => Array.from({ length: lines }, (_, index) => String(index + 1)).join("\n"),
    [lines],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!targetLine || !codeRef.current) return;
    const lineHeight = Number.parseFloat(getComputedStyle(codeRef.current).lineHeight);
    if (!Number.isFinite(lineHeight)) return;
    codeRef.current.scrollTop = Math.max(
      0,
      (targetLine - 1) * lineHeight - codeRef.current.clientHeight / 2,
    );
  }, [file, targetLine]);

  useEffect(() => setDownloadError(null), [state.href]);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await onDownload(state.href);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="linked-file-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="linked-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="링크 문서 미리보기"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <FileText size={17} aria-hidden="true" />
            <span>
              <strong>{file?.relativePath ?? state.href}</strong>
              <small>
                {file ? `${formatBytes(file.sizeBytes)}${codeLanguage ? ` · ${codeLanguage.label}` : ""}${file.targetLine ? ` · ${file.targetLine}번째 줄` : ""}` : "읽기 전용 미리보기"}
              </small>
            </span>
          </div>
          <div className="linked-file-actions">
            <button className="button" type="button" onClick={() => void download()} disabled={downloading}>
              <Download size={14} />{downloading ? "다운로드 중…" : "다운로드"}
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="미리보기 닫기" autoFocus>
              <X size={16} />
            </button>
          </div>
        </header>
        {downloadError && <div className="linked-file-download-error"><ErrorBanner message={downloadError} /></div>}
        <div className="linked-file-body">
          {state.status === "loading" ? (
            <LoadingState label="링크 문서를 읽고 있습니다" />
          ) : state.status === "error" && state.message === UNSUPPORTED_PREVIEW_MESSAGE ? (
            <div className="state-panel"><p>{UNSUPPORTED_PREVIEW_MESSAGE}</p></div>
          ) : state.status === "error" ? (
            <ErrorBanner message={state.message} />
          ) : isMarkdown ? (
            <div className="linked-file-markdown">
              <MarkdownPreview source={state.file.content} />
            </div>
          ) : (
            <div className="linked-file-code" ref={codeRef}>
              {targetLine && <span className="linked-file-line-highlight" style={{ "--target-line": targetLine - 1 } as CSSProperties} aria-hidden="true" />}
              <pre className="linked-file-line-numbers" aria-hidden="true">{lineNumbers}</pre>
              <pre className="linked-file-source"><code>{highlightedLines ? renderHighlightedLines(highlightedLines) : state.file.content}</code></pre>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function useHighlightedCode(content: string | null, language: CodeLanguage | null) {
  const [highlighted, setHighlighted] = useState<{
    content: string;
    languageId: CodeLanguage["id"];
    lines: ThemedTokenWithVariants[][] | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    if (!content || !language) return () => { active = false; };
    void highlightCode(content, language)
      .then((result) => {
        if (active) setHighlighted({ content, languageId: language.id, lines: result });
      })
      .catch(() => {
        if (active) setHighlighted({ content, languageId: language.id, lines: null });
      });
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
    fontStyle: fontStyle & 1 ? "italic" : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecoration: tokenDecoration(fontStyle),
  } as CSSProperties;
}

function tokenDecoration(fontStyle: TokenStyles["fontStyle"]): string | undefined {
  if (!fontStyle || fontStyle < 1) return undefined;
  const decorations = [];
  if (fontStyle & 4) decorations.push("underline");
  if (fontStyle & 8) decorations.push("line-through");
  return decorations.length > 0 ? decorations.join(" ") : undefined;
}
