import {
  cloneElement,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { aiaCommandText } from "../lib/aiaCommand";
import { markdownSectionFromLines } from "../lib/copyPayload";
import {
  closesMarkdownFence,
  MARKDOWN_INLINE_TOKEN,
  markdownAngleToken,
  markdownEscapedChar,
  markdownFenceOpen,
  markdownTaskItem,
  markdownUnderscoreIsIntraword,
  splitMarkdownChunks,
  startsMarkdownListItem,
  unescapeMarkdown,
} from "../lib/markdownBlocks";
import { isLocalFileHref, linkifyImports, safeHref } from "../lib/markdownLinks";
import { parseMarkdownList, type MarkdownListNode } from "../lib/markdownList";
import { mermaidSource } from "../lib/mermaidBlock";
import { CopyAction } from "./CopyAction";
import { MermaidBlock } from "./MermaidBlock";

type LocalLinkHandler = (href: string) => void;
type PromptInsertHandler = (prompt: string) => void;

/**
 * 마크다운을 그리는 네 단계가 공유하는 사용자 상호작용. 공개 미리보기에서 청크·블록 문맥·
 * 펜스 표시까지 같은 두 콜백을 각자 다시 선언하면 한 동작을 더할 때 중간 계약 하나를 빠뜨릴
 * 수 있으므로, 전달 경로 전체가 이 한 타입을 보게 한다.
 */
interface MarkdownInteractionHandlers {
  onOpenLocalLink?: LocalLinkHandler;
  /** AIA가 제안한 `aia-command` 블록을 실행하지 않고 입력 초안으로만 옮긴다. */
  onInsertPrompt?: PromptInsertHandler;
}

interface MarkdownPreviewProps extends MarkdownInteractionHandlers {
  source: string;
  compact?: boolean;
  copyable?: boolean;
  /** 지침 문서의 `@경로` 가져오기 표기를 링크로 바꿔 이어 볼 수 있게 한다. */
  linkImports?: boolean;
}

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
}: MarkdownPreviewProps) {
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
}: MarkdownInteractionHandlers & {
  text: string;
  lineOffset: number;
  commandLine: number;
  copyable: boolean;
  sectionAt: SectionLookup;
}) {
  const context: BlockContext = {
    lines: text.split("\n"),
    lineOffset,
    commandLine,
    copyable,
    sectionAt,
    inline: inlineRenderer(onOpenLocalLink),
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
    const block = parseKnownBlock(context, index) ?? parseParagraphBlock(context, index);
    // HTML 태그만 있던 줄은 표기를 걷어내면 남는 글자가 없다. 빈 문단을 그리면 까닭
    // 없는 줄 간격만 생기므로 아예 만들지 않는다.
    if (block.node) blocks.push(markBlockLine(block.node, lineOffset + index));
    index = block.next;
  }

  return <>{blocks}</>;
});

/**
 * 블록이 원문 몇 번째 줄에서 시작하는지를 그린 요소에 남긴다. '읽던 자리'는 이 값으로
 * 자리를 적어 둔다(`lib/readingAnchor.ts`) — 스크롤 픽셀과 달리 창 폭이 바뀌어도, 같은
 * 답변을 라이브 채팅이 아니라 세션 원문으로 다시 열어도 같은 곳을 가리킨다.
 *
 * 파서 여섯에 따로 적지 않고 여기 한 벌만 두는 이유는 블록 종류가 늘 때 표시를 빠뜨릴
 * 자리를 없애기 위해서다. 끝 줄이 아니라 **시작 줄**을 쓴다 — 답변이 흘러드는 동안
 * 마지막 블록의 끝 줄은 델타마다 움직이지만 시작 줄은 그대로다.
 *
 * 붙이는 대상은 호스트 엘리먼트뿐이다. 다이어그램처럼 컴포넌트가 그리는 블록은 이
 * 속성을 DOM까지 내려보낼 방법이 없으므로 표시하지 않고, 그 경우 앵커는 메시지 단위로
 * 떨어진다.
 */
function markBlockLine(node: ReactNode, line: number): ReactNode {
  if (!isValidElement(node) || typeof node.type !== "string") return node;
  return cloneElement(node as ReactElement<Record<string, unknown>>, { "data-md-line": line });
}

/**
 * 덩어리 하나를 그리는 동안 바뀌지 않는 값. 블록 파서 여섯이 저마다 줄 배열·줄 오프셋·
 * 링크 처리기를 꼬리 인자로 이어 받던 것을 한 묶음으로 만들어, 파서가 늘거나 값이
 * 늘어도 서명이 흔들리지 않게 한다.
 *
 * 함께 실린 상호작용 처리기 둘은 다이어그램·제안 명령 블록에 그대로 넘어간다. 인라인
 * 표기는 `inline`이 이미 닫아 들고 있으므로, 파서가 그 둘을 직접 보는 자리는 펜스 하나뿐이다.
 */
type BlockContext = MarkdownInteractionHandlers & {
  lines: string[];
  lineOffset: number;
  commandLine: number;
  copyable: boolean;
  sectionAt: SectionLookup;
  /** 인라인 표기를 옮기는 한 벌. 로컬 링크 처리기는 이 안에 닫혀 있다. */
  inline: InlineRenderer;
};

/**
 * 시작 규칙(`BlockKind.starts`)을 통과한 줄을 옮긴다. 그 규칙이 파서보다 느슨한 갈래만
 * null을 돌려 다음 파서에 넘기고, 규칙과 파서가 같은 갈래는 언제나 블록을 만든다.
 * 문단은 아무도 집지 않은 줄을 받는 최후의 갈래라 이 표에 들어가지 않는다.
 */
type BlockParser = (context: BlockContext, start: number) => ParsedBlock | null;

/**
 * 블록 갈래 하나가 정하는 것 한 벌. 갈래를 보는 자리는 둘이다 — 줄을 옮기는 파서와, 문단을
 * 어디서 끊을지 가리는 `startsMarkdownBlock`. 뒤쪽은 갈래 여섯의 시작 규칙을 파서에서 백
 * 줄 넘게 떨어진 자리에 손으로 다시 적고 있어서, 갈래가 하나 늘면 두 자리를 함께 고쳐야
 * 했고 어느 한쪽을 빠뜨려도 타입은 아무 말을 하지 않았다. 갈래당 한 줄로 모은다.
 */
interface BlockKind {
  /**
   * 이 줄에서 이 갈래가 시작하는가. 문단 끊기와 파서 고르기가 **모두** 이것을 본다.
   * 여기서 true인 줄을 파서가 거절하면 그 줄은 예전처럼 다음 갈래를 거쳐 문단으로
   * 떨어진다. 두 규칙이 어긋나 있는 갈래는 아래 표에 그 사실을 적어 둔다.
   */
  starts: (lines: string[], index: number) => boolean;
  /** 시작 규칙을 통과한 줄을 옮긴다. 규칙이 파서보다 느슨한 갈래만 null을 돌려준다. */
  parse: BlockParser;
}

// 블록 판별과 파싱이 예전에는 갈래마다 `if` 한 벌씩 흩어져 있었고, 어느 분기든 결과를
// 밀어넣고 커서를 옮기는 세 줄을 똑같이 되풀이했다. 판별을 파서 안으로 들여 표 하나로
// 모은다. 줄 순서(펜스 → 제목 → 구분선 → 표 → 목록 → 인용)는 그대로 유지한다.
const BLOCK_KINDS: BlockKind[] = [
  // 문단 끊기의 펜스 규칙은 파서(`markdownFenceOpen`)보다 느슨하다. 정보 문자열에 백틱이
  // 섞인 줄은 여기서만 블록의 시작이고 파서는 거절해, 앞 문단을 끊고 자기 문단이 된다.
  { starts: (lines, index) => /^\s*(```|~~~)/.test(lines[index]), parse: parseFenceBlock },
  // 제목 규칙도 파서(`ATX_HEADING`)보다 느슨하다. `#` 뒤에 글자가 없는 줄은 여기서만
  // 블록의 시작이다.
  { starts: (lines, index) => /^(#{1,6})\s+/.test(lines[index]), parse: parseHeadingBlock },
  { starts: (lines, index) => HORIZONTAL_RULE.test(lines[index]), parse: parseRuleBlock },
  { starts: startsMarkdownTable, parse: parseTableBlock },
  // 목록 규칙은 소비 쪽(`parseMarkdownList`의 첫 줄 판정)과 같은 정규식을 본다. 그래도
  // 파서가 null을 돌려줄 수 있는 것은 그 판정이 다른 모듈의 계약이기 때문이지, 여기서
  // 통과한 줄이 실제로 거절되기 때문은 아니다.
  {
    starts: (lines, index) => startsMarkdownListItem(lines[index], "unordered")
      || startsMarkdownListItem(lines[index], "ordered"),
    parse: parseListBlock,
  },
  { starts: (lines, index) => QUOTE_LINE.test(lines[index]), parse: parseQuoteBlock },
];

/**
 * 우선순위가 있는 블록 파서 표에서 현재 줄을 맡을 첫 파서를 찾는다. 청크 렌더 루프는
 * 전진 보장과 결과 적재만 맡고, 갈래 순회와 첫 성공에서 멈추는 규칙은 파서 표 곁에 둔다.
 *
 * 파서를 부르기 전에 그 갈래의 시작 규칙을 본다. 규칙을 통과하지 못하는 줄에 파서를
 * 부르면 어차피 null이 돌아오므로 고르는 결과는 같고, 대신 구분선·표·목록·인용 넷이
 * 문단 끊기와 **글자까지 같은** 판정식을 자기 첫 줄에 한 번 더 들고 있을 이유가 없어진다.
 * 같은 규칙을 두 벌로 두면 한쪽만 고쳤을 때 블록을 열어 놓고 아무도 집지 않아 문단으로
 * 떨어지거나(또는 그 반대) 하는데, 타입은 그 어긋남을 말해 주지 않는다.
 */
function parseKnownBlock(context: BlockContext, start: number): ParsedBlock | null {
  for (const kind of BLOCK_KINDS) {
    if (!kind.starts(context.lines, start)) continue;
    const parsed = kind.parse(context, start);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 펜스 블록. AIA 제안 명령이면 버튼으로, mermaid 다이어그램이면 그림으로, 복사가 켜져
 * 있으면 복사 버튼을 단 코드 상자로 그린다.
 *
 * 다이어그램은 **닫는 펜스를 만난 블록만** 넘긴다. 답변이 흘러드는 동안 마지막 펜스는
 * 델타마다 반쯤 온 원문이라, 그때마다 엔진에 넘기면 실패만 되풀이하면서 그리려는 그림이
 * 깜박인다. 닫히지 않은 펜스는 지금까지처럼 코드 상자로 두고, 닫히는 순간 그림이 된다.
 */
function parseFenceBlock({ lines, lineOffset, commandLine, copyable, onInsertPrompt, onOpenLocalLink }: BlockContext, start: number): ParsedBlock | null {
  const fence = markdownFenceOpen(lines[start]);
  if (!fence) return null;
  const fenceLine = lineOffset + start;
  const body = takeLines(lines, start + 1, (line) => closesMarkdownFence(line, fence.marker) ? null : line);
  const code = body.taken;
  let index = body.next;
  const closed = index < lines.length;
  if (closed) index += 1;
  const codeText = code.join("\n");
  const command = fenceLine === commandLine ? aiaCommandText(codeText) : null;
  const diagram = closed ? mermaidSource(fence.info, codeText) : null;
  const key = `code-${lineOffset + index}`;
  return {
    node: renderFenceBlock({
      codeText,
      language: fence.language,
      command,
      diagram,
      copyable,
      key,
      onInsertPrompt,
      onOpenLocalLink,
    }),
    next: index,
  };
}

/**
 * 해석을 마친 펜스의 표시 갈래. 펜스 범위와 닫힘 여부를 찾는 순회는 위 파서가 맡고,
 * 여기서는 AIA 명령, Mermaid, 일반 코드의 기존 우선순서만 표현한다.
 */
function renderFenceBlock({
  codeText,
  language,
  command,
  diagram,
  copyable,
  key,
  onInsertPrompt,
  onOpenLocalLink,
}: MarkdownInteractionHandlers & {
  codeText: string;
  language: string;
  command: string | null;
  diagram: string | null;
  copyable: boolean;
  key: string;
}): ReactNode {
  const codeBlock = copyable
    ? <div className="markdown-code-block-shell" key={key}>
      <CopyAction value={codeText} kind="code" className="markdown-code-copy" />
      <pre className="markdown-code-block"><code data-language={language || undefined}>{codeText}</code></pre>
    </div>
    : <pre className="markdown-code-block" key={key}><code data-language={language || undefined}>{codeText}</code></pre>;
  return command && onInsertPrompt
    ? <button className="aia-command-action" type="button" onClick={() => onInsertPrompt(command)} key={key}>
      <span>제안 명령을 입력창에 추가</span>
      <strong>{command}</strong>
    </button>
    : diagram
    ? <MermaidBlock source={diagram} fallback={codeBlock} onOpenLocalLink={onOpenLocalLink} key={key} />
    : codeBlock;
}

/** 제목. `#` 한 줄이고, 복사가 켜져 있으면 3단계까지 섹션 복사 버튼을 단다. */
function parseHeadingBlock({ lines, lineOffset, copyable, sectionAt, inline }: BlockContext, start: number): ParsedBlock | null {
  const heading = lines[start].match(ATX_HEADING);
  if (!heading) return null;
  const level = heading[1].length;
  const headingLine = lineOffset + start;
  const section = copyable && level <= 3 ? () => sectionAt(headingLine) : null;
  return { node: inline.heading(level, heading[2], `heading-${headingLine}`, section), next: start + 1 };
}

/** 구분선. 시작 규칙(`HORIZONTAL_RULE`)을 통과한 줄만 오므로 한 줄을 그대로 바꾼다. */
function parseRuleBlock({ lineOffset }: BlockContext, start: number): ParsedBlock {
  return { node: <hr key={`rule-${lineOffset + start}`} />, next: start + 1 };
}

/** 표. 첫 줄이 머리, 둘째 줄이 정렬 지정이고, 파이프가 있는 줄이 이어지는 동안 본문으로 삼는다. */
function parseTableBlock({ lines, lineOffset, inline }: BlockContext, start: number): ParsedBlock {
  const headers = splitTableRow(lines[start]);
  const alignments = splitTableRow(lines[start + 1]).map(tableAlignment);
  const body = takeLines(lines, start + 2, (line) => line.includes("|") && line.trim() ? splitTableRow(line) : null);
  const rows = body.taken;
  const index = body.next;
  const node = <div className="markdown-table-wrap" key={`table-${lineOffset + index}`}>
    <table><thead><tr>{headers.map((cell, cellIndex) => <th style={{ textAlign: alignments[cellIndex] }} key={cellIndex}>{inline.render(cell)}</th>)}</tr></thead>
      <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td style={{ textAlign: alignments[cellIndex] }} key={cellIndex}>{inline.render(row[cellIndex] ?? "")}</td>)}</tr>)}</tbody>
    </table>
  </div>;
  return { node, next: index };
}

/** 목록. 들여쓴 항목은 하위 목록으로 겹치고, 순서 없는 목록만 할 일 표기를 본다. */
function parseListBlock({ lines, lineOffset, inline }: BlockContext, start: number): ParsedBlock | null {
  const parsed = parseMarkdownList(lines, start);
  if (!parsed) return null;
  const nodes = parsed.lists.map((list) => renderList(list, lineOffset, inline));
  return {
    node: nodes.length === 1 ? nodes[0] : <Fragment key={`list-${lineOffset + start}`}>{nodes}</Fragment>,
    next: parsed.next,
  };
}

/**
 * 목록 하나를 그린다. 하위 목록은 제 항목 안에 들어가고, 순서 있는 목록은 원문의 첫 번호를
 * `start`로 받는다 — 항목 사이를 빈 줄로 띄운 목록은 덩어리가 갈려 항목마다 다른 `<ol>`이
 * 되므로, 번호를 넘기지 않으면 뒤 덩어리가 1부터 다시 센다. 1로 시작하는 흔한 목록에는
 * 속성을 붙이지 않는다.
 */
function renderList(list: MarkdownListNode, lineOffset: number, inline: InlineRenderer): ReactElement {
  const items = list.items.map((item) => {
    const task = list.kind === "unordered" ? markdownTaskItem(item.body) : null;
    const children = item.children.map((child) => renderList(child, lineOffset, inline));
    return task
      ? <li className="markdown-task" key={lineOffset + item.line}><input type="checkbox" checked={task.checked} readOnly tabIndex={-1} /><span>{inline.render(task.body)}</span>{children}</li>
      : <li key={lineOffset + item.line}>{inline.render(item.body)}{children}</li>;
  });
  const key = `${list.kind === "ordered" ? "ordered" : "list"}-${lineOffset + (list.items[0]?.line ?? 0)}`;
  return list.kind === "unordered"
    ? <ul key={key}>{items}</ul>
    : <ol start={list.start !== null && list.start !== 1 ? list.start : undefined} key={key}>{items}</ol>;
}

/** 인용. `>`로 시작하는 줄이 이어지는 동안 표기만 걷어내고 안쪽을 인라인으로 그린다. */
function parseQuoteBlock({ lines, lineOffset, inline }: BlockContext, start: number): ParsedBlock {
  const { taken: quote, next: index } = takeLines(lines, start, (line) => line.match(QUOTE_BODY)?.[1] ?? null);
  return { node: <blockquote key={`quote-${lineOffset + index}`}>{inline.renderLines(quote)}</blockquote>, next: index };
}

/**
 * 문단. 다른 블록이 시작되기 전까지 줄을 모으고, 바로 뒤가 `===`면 setext 제목으로 올린다.
 * `---`는 여기서 다루지 않는다. 문단 뒤에 구분선을 붙이는 표기가 흔해, 제목으로 바꾸면
 * 이미 그려지던 문서의 모양이 달라진다. 그릴 것이 남지 않으면 `node`가 null이다.
 */
function parseParagraphBlock({ lines, lineOffset, inline }: BlockContext, start: number): { node: ReactNode | null; next: number } {
  const body = takeLines(lines, start + 1, (line, lineIndex) => line.trim() && !startsMarkdownBlock(lines, lineIndex) ? line.trim() : null);
  const paragraph = [lines[start].trim(), ...body.taken];
  const index = body.next;
  if (index < lines.length && SETEXT_H1_UNDERLINE.test(lines[index])) {
    const node = inline.heading(1, paragraph.join(" "), `heading-${lineOffset + index}`);
    return { node, next: index + 1 };
  }
  const nodes = inline.renderLines(paragraph);
  return { node: hasVisibleContent(nodes) ? <p key={`paragraph-${lineOffset + index}`}>{nodes}</p> : null, next: index };
}

/** setext 제목의 `===` 밑줄. `---`는 기존처럼 구분선으로 남긴다. */
const SETEXT_H1_UNDERLINE = /^\s*=+\s*$/;
/** `#` 제목. 단계와 본문을 함께 꺼내므로 `#` 뒤에 글자가 없는 줄은 제목이 아니다. */
const ATX_HEADING = /^(#{1,6})\s+(.+)$/;
/** 구분선. 블록 판별과 문단 끊기가 같은 규칙을 봐야 하므로 한 곳에 둔다. */
const HORIZONTAL_RULE = /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const QUOTE_LINE = /^\s*>/;
const QUOTE_BODY = /^\s*>\s?(.*)$/;

/** 블록 하나를 옮긴 결과와, 이어서 볼 줄 번호. */
type ParsedBlock = { node: ReactNode; next: number };

/**
 * `start`부터 자기 갈래인 줄을 모으고 멈춘 자리를 함께 돌려준다. 펜스 본문·표 본문·목록
 * 항목·인용 본문·문단이 저마다 커서를 손으로 굴리며 같은 모양의 `while`을 되풀이했고,
 * 그때마다 `index`를 `let`으로 열어 두어야 했다. `take`가 null을 돌려주면 그 줄에서 끊는다
 * (빈 문자열은 값이므로 인용의 빈 줄은 그대로 모인다).
 */
function takeLines<T>(
  lines: string[],
  start: number,
  take: (line: string, index: number) => T | null,
): { taken: T[]; next: number } {
  const taken: T[] = [];
  let next = start;
  while (next < lines.length) {
    const value = take(lines[next], next);
    if (value === null) break;
    taken.push(value);
    next += 1;
  }
  return { taken, next };
}

/** 그릴 것이 남았는지. 공백뿐인 문자열만 모여 있으면 문단을 만들지 않는다. */
function hasVisibleContent(nodes: ReactNode[]): boolean {
  return nodes.some((node) => typeof node === "string" ? node.trim() !== "" : node !== null && node !== undefined);
}

/**
 * 문단을 여기서 끊어야 하는가. 갈래별 규칙은 `BLOCK_KINDS`가 들고 있으므로 여기서 다시
 * 적지 않는다. setext 밑줄만 이 자리에 남는다 — 그것은 블록의 시작이 아니라 앞 문단을
 * 제목으로 바꾸는 표시라 파서 표에 들어갈 갈래가 없다.
 *
 * 갈래를 보는 순서가 예전 `||` 사슬과 다르지만 결과는 같다. 모두 부수효과 없는 판정이고
 * 어느 하나라도 참이면 끊는 논리합이라, 먼저 보는 갈래만 달라진다.
 */
function startsMarkdownBlock(lines: string[], index: number): boolean {
  return SETEXT_H1_UNDERLINE.test(lines[index])
    || BLOCK_KINDS.some((kind) => kind.starts(lines, index));
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

/**
 * 인라인 표기를 옮기는 한 벌. 로컬 링크 처리기는 인라인 재귀 여섯 자리와 `<…>` 토큰·링크
 * 두 도우미, 제목·표·목록·인용·문단 파서까지 꼬리 인자로 끌려다녔다. 인라인에만 쓰이는
 * 값이 블록 파서 서명에 함께 얹혀 있어, 파서가 인라인을 부르지 않게 되어도 인자가 남았다.
 * 처리기를 한 번 닫아 두고 함수 셋만 넘긴다.
 */
interface InlineRenderer {
  /** 한 줄을 인라인 노드 배열로. `keyPrefix`는 재귀가 자기 key를 이어 붙일 때만 넘긴다. */
  render: (text: string, keyPrefix?: string) => ReactNode[];
  /** 여러 줄을 `<br>`로 이어 그린다(인용·문단). */
  renderLines: (lines: string[]) => ReactNode[];
  /**
   * 제목. 섹션 원문을 만드는 함수를 받은 자리에만 복사 버튼을 단다(눌릴 때 원문을 만든다).
   * 버튼을 달지 않을 자리는 넘기지 않거나 null을 넘긴다 — 복사 대상이 없다는 것과 빈
   * 문자열을 복사한다는 것은 다른 말이라, 한 칸이 둘을 겸하지 않게 한다.
   */
  heading: (level: number, text: string, key: string, section?: (() => string) | null) => ReactNode;
}

/** 덩어리 하나를 그리는 동안 한 번만 만든다. 처리기가 같으면 결과도 같은 순수 함수들이다. */
function inlineRenderer(onOpenLocalLink?: LocalLinkHandler): InlineRenderer {
  /** 로컬 파일 주소는 앱 안에서 열고, 외부 주소만 새 창으로 보낸다. */
  const link = (href: string, label: ReactNode, key: string): ReactNode => {
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
  };

  /**
   * `<…>` 토큰을 그린다. 자동 링크는 주소로, `<br>`은 줄바꿈으로, 그 밖에 아는 표시용
   * 태그는 태그만 버리고 안쪽 글자를 남긴다. 아는 표기가 아니면 부등호를 글자로 그린다.
   */
  const angleToken = (token: string, key: string): ReactNode[] => {
    const angle = markdownAngleToken(token);
    if (!angle) return [token];
    if (angle.kind === "break") return [<br key={key} />];
    if (angle.kind === "markup") return [];
    const href = safeHref(angle.href);
    return href ? [link(href, angle.href, key)] : [token];
  };

  /**
   * 링크·이미지 토큰. 이미지 표기(`![대체 텍스트](주소)`)도 같은 갈래로 받는다 —
   * 미리보기는 원격 자원을 불러오지 않으므로, 대체 텍스트를 라벨로 삼은 링크로 그린다.
   * 주소는 마크다운으로 그리지 않으므로 이스케이프를 여기서 되돌린다. 그러지 않으면
   * 본문에서는 사라진 백슬래시가 실제로 여는 주소에만 남는다.
   */
  const linkToken = (token: string, key: string): ReactNode => {
    const image = token.match(/^!?\[([^\]]+)\]\(([^)]+)\)$/);
    const href = image ? safeHref(unescapeMarkdown(image[2].trim())) : null;
    return image && href ? link(href, render(image[1], key), key) : token;
  };

  /**
   * 토큰 하나를 노드로 옮긴다. 갈래 아홉이 `render`의 순회 안에 `else if` 사슬로 눌러
   * 담겨 있어, 줄을 훑어 자르는 일(커서 전진·사이 글자 밀어넣기)과 표기 하나를 읽는 일이
   * 한 몸이었다. 갈래를 여기로 떼어 내면 순회는 자르는 일만, 이 함수는 읽는 일만 맡는다.
   *
   * 보는 순서는 예전 사슬 그대로다. 특히 `_` 낱말 한가운데 판정이 `___`보다 앞에 있어야
   * `snake_case_name`이 기울임으로 바뀌지 않는다.
   */
  const tokenNodes = (token: string, key: string, text: string, start: number): ReactNode[] => {
    // 이스케이프는 가려진 글자만 남긴다. 백슬래시가 화면에 찍히면 안 되고, `\*`가 기울임을
    // 여는 일도 없어야 한다.
    const escaped = markdownEscapedChar(token);
    if (escaped) return [escaped];
    if (token.startsWith("`")) return [<code key={key}>{token.slice(1, -1)}</code>];
    if (token.startsWith("_") && markdownUnderscoreIsIntraword(text, start, start + token.length)) return [token];
    if (token.startsWith("***") || token.startsWith("___")) return [<strong key={key}><em>{render(token.slice(3, -3), key)}</em></strong>];
    if (token.startsWith("**") || token.startsWith("__")) return [<strong key={key}>{render(token.slice(2, -2), key)}</strong>];
    if (token.startsWith("~~")) return [<del key={key}>{render(token.slice(2, -2), key)}</del>];
    if (token.startsWith("<")) return angleToken(token, key);
    if (token.startsWith("[") || token.startsWith("!")) return [linkToken(token, key)];
    return [<em key={key}>{render(token.slice(1, -1), key)}</em>];
  };

  /**
   * 반환 배열의 엘리먼트는 각자 `key`를 들고 있고 문자열 노드는 key가 필요 없다. 예전에는
   * 전체를 `Fragment`로 한 겹 더 감쌌는데, 인라인 노드마다 엘리먼트를 하나씩 더 만드는
   * 비용(개발 빌드에서는 freeze·defineProperty까지)이 그대로 대화 렌더에 실린다.
   */
  const render = (text: string, keyPrefix = "inline"): ReactNode[] => {
    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (const match of text.matchAll(MARKDOWN_INLINE_TOKEN)) {
      const start = match.index ?? 0;
      const token = match[0];
      if (start > cursor) nodes.push(text.slice(cursor, start));
      nodes.push(...tokenNodes(token, `${keyPrefix}-${start}`, text, start));
      cursor = start + token.length;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
  };

  const renderLines = (lines: string[]): ReactNode[] => lines.flatMap((line, index) => [
    index > 0 ? <br key={`break-${index}`} /> : null,
    ...render(line, `line-${index}`),
  ]);

  const heading = (level: number, text: string, key: string, section: (() => string) | null = null): ReactNode => {
    const content = render(text);
    // 여섯 갈래가 저마다 반환하던 것을 태그 이름 하나로 줄이고, 아는 단계 밖은 예전처럼
    // h6로 떨어뜨린다.
    const Tag = (level >= 1 && level <= 6 ? `h${level}` : "h6") as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    // 복사 버튼을 달 단계(3단계까지)는 호출부가 정한다. 여기서 단계를 다시 보면 같은 규칙이
    // 두 자리에 서고, 그 둘이 어긋나면 이미 만든 버튼을 조용히 버리는 갈래가 생긴다.
    if (!section) return <Tag key={key}>{content}</Tag>;
    return <Tag className="markdown-copy-heading" key={key}>
      <span>{content}</span>
      <CopyAction value={section} kind="section" className="markdown-heading-copy" />
    </Tag>;
  };

  return { render, renderLines, heading };
}
