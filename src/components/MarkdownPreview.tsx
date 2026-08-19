import { Fragment, memo, type ReactNode } from "react";
import { markdownSectionAtLine } from "../lib/copyPayload";
import { CopyAction } from "./CopyAction";

type LocalLinkHandler = (href: string) => void;

// 렌더마다 소스 전체를 라인 단위로 재파싱하므로, 입력이 같으면 결과를 재사용하도록 memo한다.
export const MarkdownPreview = memo(function MarkdownPreview({
  source,
  compact = false,
  copyable = false,
  onOpenLocalLink,
}: {
  source: string;
  compact?: boolean;
  copyable?: boolean;
  onOpenLocalLink?: LocalLinkHandler;
}) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const codeText = code.join("\n");
      blocks.push(copyable
        ? <div className="markdown-code-block-shell" key={`code-${index}`}>
          <CopyAction value={codeText} kind="code" className="markdown-code-copy" />
          <pre className="markdown-code-block"><code data-language={fence[1] || undefined}>{codeText}</code></pre>
        </div>
        : <pre className="markdown-code-block" key={`code-${index}`}><code data-language={fence[1] || undefined}>{codeText}</code></pre>);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const section = copyable && level <= 3 ? markdownSectionAtLine(source, index) : "";
      blocks.push(renderHeading(level, heading[2], `heading-${index}`, onOpenLocalLink, section));
      index += 1;
      continue;
    }

    if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      const alignments = splitTableRow(lines[index + 1]).map(tableAlignment);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table><thead><tr>{headers.map((cell, cellIndex) => <th style={{ textAlign: alignments[cellIndex] }} key={cellIndex}>{renderInline(cell, "inline", onOpenLocalLink)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td style={{ textAlign: alignments[cellIndex] }} key={cellIndex}>{renderInline(row[cellIndex] ?? "", "inline", onOpenLocalLink)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!match) break;
        const task = match[1].match(/^\[([ xX])\]\s+(.*)$/);
        items.push(task
          ? <li className="markdown-task" key={index}><input type="checkbox" checked={task[1].toLowerCase() === "x"} readOnly tabIndex={-1} /><span>{renderInline(task[2], "inline", onOpenLocalLink)}</span></li>
          : <li key={index}>{renderInline(match[1], "inline", onOpenLocalLink)}</li>);
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`}>{items}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(<li key={index}>{renderInline(match[1], "inline", onOpenLocalLink)}</li>);
        index += 1;
      }
      blocks.push(<ol key={`ordered-${index}`}>{items}</ol>);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*>\s?(.*)$/);
        if (!match) break;
        quote.push(match[1]);
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{renderInlineLines(quote, onOpenLocalLink)}</blockquote>);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`}>{renderInlineLines(paragraph, onOpenLocalLink)}</p>);
  }

  return <article className={`markdown-preview${compact ? " markdown-preview-embedded" : ""}`}>{blocks.length > 0 ? blocks : <p className="markdown-empty">내용이 없습니다.</p>}</article>;
});

function startsMarkdownBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^\s*```/.test(line)
    || /^(#{1,6})\s+/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^\s*>/.test(line)
    || /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)
    || (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1]));
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function tableAlignment(cell: string): "left" | "center" | "right" {
  const value = cell.replace(/\s/g, "");
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function renderHeading(level: number, text: string, key: string, onOpenLocalLink?: LocalLinkHandler, section = ""): ReactNode {
  const content = renderInline(text, "inline", onOpenLocalLink);
  const headingContent = section
    ? <><span>{content}</span><CopyAction value={section} kind="section" className="markdown-heading-copy" /></>
    : content;
  const className = section ? "markdown-copy-heading" : undefined;
  if (level === 1) return <h1 className={className} key={key}>{headingContent}</h1>;
  if (level === 2) return <h2 className={className} key={key}>{headingContent}</h2>;
  if (level === 3) return <h3 className={className} key={key}>{headingContent}</h3>;
  if (level === 4) return <h4 key={key}>{content}</h4>;
  if (level === 5) return <h5 key={key}>{content}</h5>;
  return <h6 key={key}>{content}</h6>;
}

function renderInlineLines(lines: string[], onOpenLocalLink?: LocalLinkHandler): ReactNode[] {
  return lines.flatMap((line, index) => [index > 0 ? <br key={`break-${index}`} /> : null, ...renderInline(line, `line-${index}`, onOpenLocalLink)]);
}

function renderInline(text: string, keyPrefix = "inline", onOpenLocalLink?: LocalLinkHandler): ReactNode[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^\)\n]+\)|\*[^*\n]+\*)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    const key = `${keyPrefix}-${start}`;
    if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key, onOpenLocalLink)}</strong>);
    else if (token.startsWith("~~")) nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key, onOpenLocalLink)}</del>);
    else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeHref(link[2].trim()) : null;
      const local = href ? isLocalFileHref(href) : false;
      nodes.push(link && href ? <a
        href={href}
        target={!local && /^https?:/i.test(href) ? "_blank" : undefined}
        rel="noreferrer"
        onClick={local && onOpenLocalLink ? (event) => {
          event.preventDefault();
          onOpenLocalLink(href);
        } : undefined}
        key={key}
      >{renderInline(link[1], key, onOpenLocalLink)}</a> : token);
    } else nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key, onOpenLocalLink)}</em>);
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.map((node, index) => <Fragment key={`${keyPrefix}-part-${index}`}>{node}</Fragment>);
}

function safeHref(href: string): string | null {
  if (href.startsWith("//")) return null;
  return /^(https?:|mailto:|#|\/|\\|\.\.?[\\/]|[a-z]:[\\/]|[^:]+$)/i.test(href) ? href : null;
}

function isLocalFileHref(href: string): boolean {
  return !/^(https?:|mailto:|#)/i.test(href);
}
