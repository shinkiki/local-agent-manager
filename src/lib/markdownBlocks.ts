/**
 * 마크다운 목록 줄을 읽는 규칙. 블록 진입 판정과 항목 소비가 **같은 정규식**을 쓰는 것이
 * 이 파일의 존재 이유다. 둘이 갈라지면 진입은 하지만 한 줄도 소비하지 못하는 줄이 생기고,
 * 손으로 짠 라인 스캐너는 그 줄에서 무한 루프에 빠진다(빈 목록 엘리먼트를 메모리가 마를
 * 때까지 만들어내며 화면이 멈춘다). 그래서 본문은 `(.*)`로 빈 항목까지 받아들인다.
 */
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;

/** 체크박스 목록 항목. `- [x] 할 일`의 상태와 본문을 나눈다. */
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;

export type MarkdownListKind = "unordered" | "ordered";

export interface MarkdownTaskItem {
  checked: boolean;
  body: string;
}

/**
 * 목록 항목의 본문을 돌려준다. 마커 뒤가 비어 있어도(`"- "`) 빈 문자열로 매칭되므로,
 * 이 함수가 문자열을 돌려주는 모든 줄은 스캐너가 반드시 소비한다.
 */
export function markdownListItemBody(line: string, kind: MarkdownListKind): string | null {
  const match = line.match(kind === "ordered" ? ORDERED_ITEM : UNORDERED_ITEM);
  return match ? match[1] : null;
}

/** 목록 줄인지만 본다. `markdownListItemBody`와 같은 정규식이라 판정이 어긋나지 않는다. */
export function startsMarkdownListItem(line: string, kind: MarkdownListKind): boolean {
  return markdownListItemBody(line, kind) !== null;
}

/** 체크박스 항목이면 상태와 본문을, 아니면 null을 돌려준다. */
export function markdownTaskItem(body: string): MarkdownTaskItem | null {
  const match = body.match(TASK_ITEM);
  return match ? { checked: match[1].toLowerCase() === "x", body: match[2] } : null;
}

/**
 * 인라인 표기 규칙은 markdownInline으로 옮겼다. 미리보기는 블록 구조와 인라인 토큰을 한
 * 자리에서 가져오므로, 가져오는 자리를 흩지 않도록 이름만 그대로 다시 내보낸다.
 */
export {
  MARKDOWN_INLINE_TOKEN,
  markdownUnderscoreIsIntraword,
  markdownAngleToken,
  unescapeMarkdown,
  markdownEscapedChar,
  type MarkdownAngleToken,
} from "./markdownInline.ts";

/**
 * 코드 펜스. 여는 줄은 언어만 붙을 수 있고, 닫는 줄은 마커만 있어야 한다. 블록 파서와
 * 덩어리 분할기가 **같은 함수**를 써야 분할 지점이 펜스 안으로 들어가지 않는다.
 *
 * 마커를 상수 하나로 못박지 않고 여는 줄에서 읽어 오는 이유는 두 가지다. 물결 펜스
 * (`~~~`)를 백틱과 같이 다루려면 종류를 기억해야 하고, 그러지 않으면 백틱 펜스 안에
 * 적힌 `~~~` 한 줄이 코드 블록을 먼저 닫아 뒤 내용이 본문으로 새어 나온다. 마커를
 * 길게 여는 것(```` ```` ````)도 CommonMark처럼 그 길이 이상으로만 닫힌다.
 */
const FENCE_OPEN_LINE = /^\s*(```+|~~~+)([\w+-]*)\s*$/;
const FENCE_CLOSE_LINE = /^\s*(```+|~~~+)\s*$/;

export interface MarkdownFenceOpen {
  /** 여는 줄에 쓰인 마커. 닫는 줄 판정에 그대로 넘긴다. */
  marker: string;
  language: string;
}

/** 코드 펜스를 여는 줄이면 마커와 언어를, 아니면 null을 돌려준다. */
export function markdownFenceOpen(line: string): MarkdownFenceOpen | null {
  const match = line.match(FENCE_OPEN_LINE);
  return match ? { marker: match[1], language: match[2] } : null;
}

/** 같은 종류이고 여는 줄만큼 긴 마커만 펜스를 닫는다. */
export function closesMarkdownFence(line: string, marker: string): boolean {
  const match = line.match(FENCE_CLOSE_LINE);
  return match !== null && match[1][0] === marker[0] && match[1].length >= marker.length;
}

export interface MarkdownChunk {
  /** 문서 전체 기준 시작 줄. 뒤에 내용이 붙어도 바뀌지 않으므로 렌더 key로 쓴다. */
  start: number;
  /** 덩어리 본문. 완성된 덩어리는 문서가 자라도 문자열이 그대로다. */
  text: string;
}

export interface MarkdownFence {
  /** 여는 ``` 줄의 문서 전체 기준 번호. */
  line: number;
  language: string;
  code: string;
}

export interface MarkdownChunkSplit {
  chunks: MarkdownChunk[];
  fences: MarkdownFence[];
}

/**
 * 문서를 빈 줄 경계로 나눈다. 코드 펜스를 뺀 모든 블록은 빈 줄에서 끝나므로, 펜스 밖의
 * 빈 줄에서만 자르면 덩어리마다 블록이 온전히 담긴다. 즉 덩어리별로 파싱한 결과가 문서
 * 전체를 한 번에 파싱한 결과와 같다.
 *
 * 스트리밍 중에는 마지막 덩어리만 자라고 앞의 덩어리는 문자열이 그대로다. 덩어리 단위로
 * memo하면 델타마다 문서 전체를 다시 엘리먼트로 만드는 비용(O(글자수²))이 사라진다.
 */
export function splitMarkdownChunks(normalized: string): MarkdownChunkSplit {
  const lines = normalized.split("\n");
  const chunks: MarkdownChunk[] = [];
  const fences: MarkdownFence[] = [];
  let start = -1;
  let index = 0;

  const close = () => {
    if (start < 0) return;
    chunks.push({ start, text: lines.slice(start, index).join("\n") });
    start = -1;
  };

  while (index < lines.length) {
    const line = lines[index];
    const opened = markdownFenceOpen(line);
    if (opened) {
      if (start < 0) start = index;
      const fence = index;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !closesMarkdownFence(lines[index], opened.marker)) {
        code.push(lines[index]);
        index += 1;
      }
      // 닫히지 않은 펜스는 문서 끝까지가 코드다. 파서와 같은 판단이라 결과가 어긋나지 않는다.
      if (index < lines.length) index += 1;
      fences.push({ line: fence, language: opened.language, code: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      close();
      index += 1;
      continue;
    }
    if (start < 0) start = index;
    index += 1;
  }
  close();
  return { chunks, fences };
}
