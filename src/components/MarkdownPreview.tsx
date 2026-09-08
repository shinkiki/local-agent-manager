import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { aiaCommandText } from "../lib/aiaCommand";
import { markdownSectionFromLines } from "../lib/copyPayload";
import {
  closesMarkdownFence,
  MARKDOWN_INLINE_TOKEN,
  markdownAngleToken,
  markdownEscapedChar,
  markdownFenceOpen,
  markdownListItemBody,
  markdownTaskItem,
  markdownUnderscoreIsIntraword,
  splitMarkdownChunks,
  startsMarkdownListItem,
  unescapeMarkdown,
} from "../lib/markdownBlocks";
import { isLocalFileHref, linkifyImports, safeHref } from "../lib/markdownLinks";
import { CopyAction } from "./CopyAction";

type LocalLinkHandler = (href: string) => void;
type PromptInsertHandler = (prompt: string) => void;
/** 제목의 문서 기준 줄 번호로 섹션 원문을 만든다. 복사 버튼을 누를 때만 호출된다. */
type SectionLookup = (line: number) => string;

/**
 * 답변을 흘려보내는 동안 `source`는 델타마다 자란다. 문서를 한 덩어리로 파싱하면 델타마다
 * 전체를 다시 엘리먼트로 만들어 비용이 글자 수의 제곱으로 커진다. 그래서 빈 줄 경계로
 * 나눈 덩어리를 각각 memo해, 실제로 바뀌는 마지막 덩어리만 다시 만든다. 앞 덩어리는
 * 문자열이 그대로여서 파싱도 엘리먼트 생성도 건너뛴다.
 */
export const MarkdownPreview = memo(function MarkdownPreview({
  source,
  compact = false,
  copyable = false,
  linkImports = false,
  onOpenLocalLink,
  onInsertPrompt,
}: {
  source: string;
  compact?: boolean;
  copyable?: boolean;
  /** 지침 문서의 `@경로` 가져오기 표기를 링크로 바꿔 이어 볼 수 있게 한다. */
  linkImports?: boolean;
  onOpenLocalLink?: LocalLinkHandler;
  /** AIA가 제안한 `aia-command` 블록을 실행하지 않고 입력 초안으로만 옮긴다. */
  onInsertPrompt?: PromptInsertHandler;
}) {
  const normalized = useMemo(() => source.replace(/\r\n?/g, "\n"), [source]);
  // 링크 치환은 펜스 상태를 문서 전체로 이어 판단한다. 덩어리로 나눈 뒤에 돌리면 경계마다
  // 상태가 초기화되어 결과가 달라지므로, 나누기 전에 문서 단위로 한 번만 돌린다.
  const rendered = useMemo(() => linkImports ? linkifyImports(normalized) : normalized, [linkImports, normalized]);
  const { chunks, fences } = useMemo(() => splitMarkdownChunks(rendered), [rendered]);

  // 입력창으로 옮길 제안 명령은 문서에서 처음 하나만 버튼이 된다. 덩어리는 서로를 볼 수
  // 없으므로, 그 하나가 몇 번째 줄인지를 문서 단위로 정해 내려보낸다.
  const commandLine = useMemo(
    () => onInsertPrompt
      ? fences.find((fence) => fence.language === "aia-command" && aiaCommandText(fence.code))?.line ?? -1
      : -1,
    [fences, onInsertPrompt],
  );

  // 섹션 원문은 눌릴 때 만든다. 렌더 중에 제목마다 뽑으면 쓰이지도 않을 문자열을 계속
  // 만들게 되고, 원문 줄 배열을 덩어리로 내려보내면 배열 신원이 매번 바뀌어 memo가 깨진다.
  const sourceRef = useRef(normalized);
  sourceRef.current = normalized;
  const sectionAt = useCallback<SectionLookup>(
    (line) => markdownSectionFromLines(sourceRef.current.split("\n"), line),
    [],
  );

  return <article className={`markdown-preview${compact ? " markdown-preview-embedded" : ""}`}>{chunks.length > 0
    ? chunks.map((chunk) => <MarkdownChunk
      text={chunk.text}
      lineOffset={chunk.start}
      commandLine={commandLine}
      copyable={copyable}
      sectionAt={sectionAt}
      onOpenLocalLink={onOpenLocalLink}
      onInsertPrompt={onInsertPrompt}
      key={chunk.start}
    />)
    : <p className="markdown-empty">내용이 없습니다.</p>}</article>;
});

/**
 * 덩어리 하나를 블록으로 옮긴다. `text`가 같으면 memo가 이 함수를 아예 부르지 않으므로,
 * 스트리밍 중 앞 덩어리의 파싱과 엘리먼트 생성이 모두 사라진다. key와 섹션 조회는 문서
 * 전체 기준 줄 번호(`lineOffset + index`)를 쓴다.
 */
const MarkdownChunk = memo(function MarkdownChunk({
  text,
  lineOffset,
  commandLine,
  copyable,
  sectionAt,
  onOpenLocalLink,
  onInsertPrompt,
}: {
  text: string;
  lineOffset: number;
  commandLine: number;
  copyable: boolean;
  sectionAt: SectionLookup;
  onOpenLocalLink?: LocalLinkHandler;
  onInsertPrompt?: PromptInsertHandler;
}) {
  const context: BlockContext = {
    lines: text.split("\n"),
    lineOffset,
    commandLine,
    copyable,
    sectionAt,
    onOpenLocalLink,
    onInsertPrompt,
  };
  const blocks: ReactNode[] = [];
  let index = 0;
  let scanned = -1;

  while (index < context.lines.length) {
    if (index === scanned) {
      // 모든 분기는 최소 한 줄을 소비한다. 회귀로 전진이 멈추면 같은 줄을 무한히 다시
      // 파싱하면서 엘리먼트를 쌓아 화면이 영구히 멈추므로, 그 자리에서 강제로 넘긴다.
      index += 1;
      continue;
    }
    scanned = index;
    if (!context.lines[index].trim()) {
      index += 1;
      continue;
    }

    // 앞선 파서가 먼저 집는다. 아무도 집지 않은 줄은 문단으로 떨어진다.
    let parsed: ParsedBlock | null = null;
    for (const parseBlock of BLOCK_PARSERS) {
      parsed = parseBlock(context, index);
      if (parsed) break;
    }
    const block = parsed ?? parseParagraphBlock(context, index);
    // HTML 태그만 있던 줄은 표기를 걷어내면 남는 글자가 없다. 빈 문단을 그리면 까닭
    // 없는 줄 간격만 생기므로 아예 만들지 않는다.
    if (block.node) blocks.push(block.node);
    index = block.next;
  }

  return <>{blocks}</>;
});

/**
 * 덩어리 하나를 그리는 동안 바뀌지 않는 값. 블록 파서 여섯이 저마다 줄 배열·줄 오프셋·
 * 링크 처리기를 꼬리 인자로 이어 받던 것을 한 묶음으로 만들어, 파서가 늘거나 값이
 * 늘어도 서명이 흔들리지 않게 한다.
 */
type BlockContext = {
  lines: string[];
  lineOffset: number;
  commandLine: number;
  copyable: boolean;
  sectionAt: SectionLookup;
  onOpenLocalLink?: LocalLinkHandler;
  onInsertPrompt?: PromptInsertHandler;
};

/**
 * 그 줄에서 시작하는 블록을 옮긴다. 자기 갈래가 아니면 null을 돌려 다음 파서에 넘긴다.
 * 문단은 아무도 집지 않은 줄을 받는 최후의 갈래라 이 표에 들어가지 않는다.
 */
type BlockParser = (context: BlockContext, start: number) => ParsedBlock | null;

// 블록 판별과 파싱이 예전에는 갈래마다 `if` 한 벌씩 흩어져 있었고, 어느 분기든 결과를
// 밀어넣고 커서를 옮기는 세 줄을 똑같이 되풀이했다. 판별을 파서 안으로 들여 표 하나로
// 모은다. 줄 순서(펜스 → 제목 → 구분선 → 표 → 목록 → 인용)는 그대로 유지한다.
const BLOCK_PARSERS: BlockParser[] = [
  parseFenceBlock,
  parseHeadingBlock,
  parseRuleBlock,
  parseTableBlock,
  parseListBlock,
  parseQuoteBlock,
];

/** 펜스 블록. AIA 제안 명령이면 버튼으로, 복사가 켜져 있으면 복사 버튼을 단 코드 상자로 그린다. */
function parseFenceBlock({ lines, lineOffset, commandLine, copyable, onInsertPrompt }: BlockContext, start: number): ParsedBlock | null {
  const fence = markdownFenceOpen(lines[start]);
  if (!fence) return null;
  const fenceLine = lineOffset + start;
  const code: string[] = [];
  let index = start + 1;
  while (index < lines.length && !closesMarkdownFence(lines[index], fence.marker)) {
    code.push(lines[index]);
    index += 1;
  }
  if (index < lines.length) index += 1;
  const codeText = code.join("\n");
  const command = fenceLine === commandLine ? aiaCommandText(codeText) : null;
  const key = `code-${lineOffset + index}`;
  const node = command && onInsertPrompt
    ? <button className="aia-command-action" type="button" onClick={() => onInsertPrompt(command)} key={key}>
      <span>제안 명령을 입력창에 추가</span>
      <strong>{command}</strong>
    </button>
    : copyable
    ? <div className="markdown-code-block-shell" key={key}>
      <CopyAction value={codeText} kind="code" className="markdown-code-copy" />
      <pre className="markdown-code-block"><code data-language={fence.language || undefined}>{codeText}</code></pre>
    </div>
    : <pre className="markdown-code-block" key={key}><code data-language={fence.language || undefined}>{codeText}</code></pre>;
  return { node, next: index };
}

/** 제목. `#` 한 줄이고, 복사가 켜져 있으면 3단계까지 섹션 복사 버튼을 단다. */
function parseHeadingBlock({ lines, lineOffset, copyable, sectionAt, onOpenLocalLink }: BlockContext, start: number): ParsedBlock | null {
  const heading = lines[start].match(/^(#{1,6})\s+(.+)$/);
  if (!heading) return null;
  const level = heading[1].length;
  const headingLine = lineOffset + start;
  const section = copyable && level <= 3 ? () => sectionAt(headingLine) : "";
  return { node: renderHeading(level, heading[2], `heading-${headingLine}`, onOpenLocalLink, section), next: start + 1 };
}

/** 구분선. */
function parseRuleBlock({ lines, lineOffset }: BlockContext, start: number): ParsedBlock | null {
  if (!HORIZONTAL_RULE.test(lines[start])) return null;
  return { node: <hr key={`rule-${lineOffset + start}`} />, next: start + 1 };
}

/** 표. 첫 줄이 머리, 둘째 줄이 정렬 지정이고, 파이프가 있는 줄이 이어지는 동안 본문으로 삼는다. */
function parseTableBlock({ lines, lineOffset, onOpenLocalLink }: BlockContext, start: number): ParsedBlock | null {
  if (!startsMarkdownTable(lines, start)) return null;
  const headers = splitTableRow(lines[start]);
  const alignments = splitTableRow(lines[start + 1]).map(tableAlignment);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const node = <div className="markdown-table-wrap" key={`table-${lineOffset + index}`}>
    <table><thead><tr>{headers.map((cell, cellIndex) => <th style={{ textAlign: alignments[cellIndex] }} key={cellIndex}>{renderInline(cell, "inline", onOpenLocalLink)}</th>)}</tr></thead>
      <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td style={{ textAlign: alignments[cellIndex] }} key={cellIndex}>{renderInline(row[cellIndex] ?? "", "inline", onOpenLocalLink)}</td>)}</tr>)}</tbody>
    </table>
  </div>;
  return { node, next: index };
}

/** 목록. 같은 갈래의 항목이 이어지는 동안 묶고, 순서 없는 목록만 할 일 표기를 본다. */
function parseListBlock({ lines, lineOffset, onOpenLocalLink }: BlockContext, start: number): ParsedBlock | null {
  const kind = startsMarkdownListItem(lines[start], "unordered")
    ? "unordered"
    : startsMarkdownListItem(lines[start], "ordered") ? "ordered" : null;
  if (!kind) return null;
  const items: ReactNode[] = [];
  let index = start;
  while (index < lines.length) {
    const body = markdownListItemBody(lines[index], kind);
    if (body === null) break;
    const task = kind === "unordered" ? markdownTaskItem(body) : null;
    items.push(task
      ? <li className="markdown-task" key={lineOffset + index}><input type="checkbox" checked={task.checked} readOnly tabIndex={-1} /><span>{renderInline(task.body, "inline", onOpenLocalLink)}</span></li>
      : <li key={lineOffset + index}>{renderInline(body, "inline", onOpenLocalLink)}</li>);
    index += 1;
  }
  const node = kind === "unordered"
    ? <ul key={`list-${lineOffset + index}`}>{items}</ul>
    : <ol key={`ordered-${lineOffset + index}`}>{items}</ol>;
  return { node, next: index };
}

/** 인용. `>`로 시작하는 줄이 이어지는 동안 표기만 걷어내고 안쪽을 인라인으로 그린다. */
function parseQuoteBlock({ lines, lineOffset, onOpenLocalLink }: BlockContext, start: number): ParsedBlock | null {
  if (!QUOTE_LINE.test(lines[start])) return null;
  const quote: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = lines[index].match(QUOTE_BODY);
    if (!match) break;
    quote.push(match[1]);
    index += 1;
  }
  return { node: <blockquote key={`quote-${lineOffset + index}`}>{renderInlineLines(quote, onOpenLocalLink)}</blockquote>, next: index };
}

/**
 * 문단. 다른 블록이 시작되기 전까지 줄을 모으고, 바로 뒤가 `===`면 setext 제목으로 올린다.
 * `---`는 여기서 다루지 않는다. 문단 뒤에 구분선을 붙이는 표기가 흔해, 제목으로 바꾸면
 * 이미 그려지던 문서의 모양이 달라진다. 그릴 것이 남지 않으면 `node`가 null이다.
 */
function parseParagraphBlock({ lines, lineOffset, onOpenLocalLink }: BlockContext, start: number): { node: ReactNode | null; next: number } {
  const paragraph: string[] = [lines[start].trim()];
  let index = start + 1;
  while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines, index)) {
    paragraph.push(lines[index].trim());
    index += 1;
  }
  if (index < lines.length && SETEXT_H1_UNDERLINE.test(lines[index])) {
    const node = renderHeading(1, paragraph.join(" "), `heading-${lineOffset + index}`, onOpenLocalLink);
    return { node, next: index + 1 };
  }
  const nodes = renderInlineLines(paragraph, onOpenLocalLink);
  return { node: hasVisibleContent(nodes) ? <p key={`paragraph-${lineOffset + index}`}>{nodes}</p> : null, next: index };
}

/** setext 제목의 `===` 밑줄. `---`는 기존처럼 구분선으로 남긴다. */
const SETEXT_H1_UNDERLINE = /^\s*=+\s*$/;
/** 구분선. 블록 판별과 문단 끊기가 같은 규칙을 봐야 하므로 한 곳에 둔다. */
const HORIZONTAL_RULE = /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const QUOTE_LINE = /^\s*>/;
const QUOTE_BODY = /^\s*>\s?(.*)$/;

/** 블록 하나를 옮긴 결과와, 이어서 볼 줄 번호. */
type ParsedBlock = { node: ReactNode; next: number };

/** 그릴 것이 남았는지. 공백뿐인 문자열만 모여 있으면 문단을 만들지 않는다. */
function hasVisibleContent(nodes: ReactNode[]): boolean {
  return nodes.some((node) => typeof node === "string" ? node.trim() !== "" : node !== null && node !== undefined);
}

function startsMarkdownBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^\s*(```|~~~)/.test(line)
    || SETEXT_H1_UNDERLINE.test(line)
    || /^(#{1,6})\s+/.test(line)
    || startsMarkdownListItem(line, "unordered")
    || startsMarkdownListItem(line, "ordered")
    || QUOTE_LINE.test(line)
    || HORIZONTAL_RULE.test(line)
    || startsMarkdownTable(lines, index);
}

/** 표의 시작. 파이프가 있는 줄 바로 다음이 정렬 지정 줄이어야 한다. */
function startsMarkdownTable(lines: string[], index: number): boolean {
  return index + 1 < lines.length && lines[index].includes("|") && isTableSeparator(lines[index + 1]);
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

function renderHeading(
  level: number,
  text: string,
  key: string,
  onOpenLocalLink?: LocalLinkHandler,
  /** 빈 문자열이면 복사 버튼을 달지 않는다. 함수면 눌릴 때 섹션 원문을 만든다. */
  section: string | (() => string) = "",
): ReactNode {
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

/**
 * 반환 배열의 엘리먼트는 각자 `key`를 들고 있고 문자열 노드는 key가 필요 없다. 예전에는
 * 전체를 `Fragment`로 한 겹 더 감쌌는데, 인라인 노드마다 엘리먼트를 하나씩 더 만드는
 * 비용(개발 빌드에서는 freeze·defineProperty까지)이 그대로 대화 렌더에 실린다.
 */
function renderInline(text: string, keyPrefix = "inline", onOpenLocalLink?: LocalLinkHandler): ReactNode[] {
  const pattern = MARKDOWN_INLINE_TOKEN;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    const key = `${keyPrefix}-${start}`;
    const escaped = markdownEscapedChar(token);
    // 이스케이프는 가려진 글자만 남긴다. 백슬래시가 화면에 찍히면 안 되고, `\*`가 기울임을
    // 여는 일도 없어야 한다.
    if (escaped) nodes.push(escaped);
    else if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    // `_`가 낱말 한가운데면 강조 표기가 아니다. `snake_case_name`이 기울임으로 바뀌지
    // 않도록, 표기로 읽기 전에 앞뒤 글자를 먼저 본다.
    else if (token.startsWith("_") && markdownUnderscoreIsIntraword(text, start, start + token.length)) nodes.push(token);
    else if (token.startsWith("***") || token.startsWith("___")) nodes.push(<strong key={key}><em>{renderInline(token.slice(3, -3), key, onOpenLocalLink)}</em></strong>);
    else if (token.startsWith("**") || token.startsWith("__")) nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key, onOpenLocalLink)}</strong>);
    else if (token.startsWith("~~")) nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key, onOpenLocalLink)}</del>);
    else if (token.startsWith("<")) nodes.push(...renderAngleToken(token, key, onOpenLocalLink));
    else if (token.startsWith("[") || token.startsWith("!")) {
      // 이미지 표기(`![대체 텍스트](주소)`)도 같은 갈래로 받는다. 미리보기는 원격
      // 자원을 불러오지 않으므로, 대체 텍스트를 라벨로 삼은 링크로 그린다.
      const link = token.match(/^!?\[([^\]]+)\]\(([^)]+)\)$/);
      // 주소는 마크다운으로 그리지 않으므로 이스케이프를 여기서 되돌린다. 그러지 않으면
      // 본문에서는 사라진 백슬래시가 실제로 여는 주소에만 남는다.
      const href = link ? safeHref(unescapeMarkdown(link[2].trim())) : null;
      nodes.push(link && href
        ? renderLink(href, renderInline(link[1], key, onOpenLocalLink), key, onOpenLocalLink)
        : token);
    } else nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key, onOpenLocalLink)}</em>);
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * `<…>` 토큰을 그린다. 자동 링크는 주소로, `<br>`은 줄바꿈으로, 그 밖에 아는 표시용
 * 태그는 태그만 버리고 안쪽 글자를 남긴다. 아는 표기가 아니면 부등호를 글자로 그린다.
 */
function renderAngleToken(token: string, key: string, onOpenLocalLink?: LocalLinkHandler): ReactNode[] {
  const angle = markdownAngleToken(token);
  if (!angle) return [token];
  if (angle.kind === "break") return [<br key={key} />];
  if (angle.kind === "markup") return [];
  const href = safeHref(angle.href);
  return href ? [renderLink(href, angle.href, key, onOpenLocalLink)] : [token];
}

/** 로컬 파일 주소는 앱 안에서 열고, 외부 주소만 새 창으로 보낸다. */
function renderLink(href: string, label: ReactNode, key: string, onOpenLocalLink?: LocalLinkHandler): ReactNode {
  const local = isLocalFileHref(href);
  return <a
    href={href}
    target={!local && /^https?:/i.test(href) ? "_blank" : undefined}
    rel="noreferrer"
    onClick={local && onOpenLocalLink ? (event) => {
      event.preventDefault();
      onOpenLocalLink(href);
    } : undefined}
    key={key}
  >{label}</a>;
}
