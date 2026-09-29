import { markdownListItem, type MarkdownListKind } from "./markdownListLine.ts";

/**
 * 목록 줄 여럿을 들여쓰기에 따라 겹친 구조로 읽는 규칙.
 *
 * 줄 하나를 읽는 규칙(`markdownListLine`)과 갈라 둔 이유는 바뀌는 이유가 다르기 때문이다.
 * 저쪽은 마커 문법이 늘 때 손대고, 여기는 단계를 어떻게 겹칠지가 바뀔 때 손댄다.
 *
 * 불변식 하나: **목록 줄로 읽힌 줄은 반드시 어느 항목엔가 들어간다.** 스캐너는 여기서
 * 돌려준 `next`까지를 소비했다고 믿으므로, 어느 단계에도 끼지 못해 버려지는 줄이 생기면
 * 그 줄이 화면에서 조용히 사라진다. 그래서 바깥 순회는 남은 항목이 없어질 때까지 목록을
 * 거듭 만들고(`lists`가 여럿일 수 있다), 하위 목록 만들기는 항상 항목 하나 이상을 먹는다.
 */

/** 목록 하나. 겹친 목록은 항목 안에 다시 목록을 담는다. */
export interface MarkdownListNode {
  kind: MarkdownListKind;
  /** 순서 있는 목록이 시작하는 번호. 순서 없는 목록은 null. */
  start: number | null;
  items: MarkdownListItemNode[];
}

export interface MarkdownListItemNode {
  /** 마커를 떼어낸 본문. 체크박스 판정은 그리는 쪽이 한다. */
  body: string;
  /** 이 항목이 있던 줄(덩어리 기준). 렌더 key로 쓴다. */
  line: number;
  /** 이 항목에 딸린 하위 목록. 갈래가 섞이면 하나가 넘을 수 있다. */
  children: MarkdownListNode[];
}

export interface MarkdownListParse {
  /** 이 자리에서 시작하는 목록들. 들여쓰기가 거꾸로 가는 원문에서만 둘 이상이 된다. */
  lists: MarkdownListNode[];
  /** 목록이 끝난 다음 줄. */
  next: number;
}

interface ListEntry {
  indent: number;
  kind: MarkdownListKind;
  start: number | null;
  body: string;
  line: number;
}

/** 탭은 네 칸으로 센다. 단계 비교에만 쓰므로 정확한 열 계산일 필요는 없다. */
function lineIndent(line: string): number {
  let indent = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === " ") indent += 1;
    else if (char === "\t") indent += 4;
    else break;
  }
  return indent;
}

/**
 * 목록 갈래를 보는 순서. 두 마커 문법은 서로 겹치지 않으므로 순서가 결과를 바꾸지는
 * 않지만, 갈래가 늘 때 더할 자리를 한 곳으로 두려고 목록으로 적는다.
 */
const LIST_KINDS: readonly MarkdownListKind[] = ["ordered", "unordered"];

/**
 * 줄 하나를 목록 항목으로 읽는다. 목록 줄이 아니면 null.
 *
 * 갈래마다 같은 모양의 항목을 따로 짓고 있었다 — 순서 있는 쪽은 본문과 번호를 두 번
 * 매칭해서, 순서 없는 쪽은 번호 자리에 `null`을 손으로 적어서. 항목을 짓는 자리가 하나면
 * `ListEntry`에 칸을 더할 때 한 갈래만 고쳐지는 일이 없다.
 */
function listEntry(line: string, index: number): ListEntry | null {
  for (const kind of LIST_KINDS) {
    const item = markdownListItem(line, kind);
    if (!item) continue;
    return { indent: lineIndent(line), kind, start: item.start, body: item.body, line: index };
  }
  return null;
}

/**
 * 한 단계의 목록을 만든다. 첫 항목은 무조건 먹으므로 호출이 제자리를 맴돌지 않는다.
 * 더 깊이 들여쓴 줄은 바로 앞 항목의 하위 목록으로, 같은 단계에서 갈래가 바뀌거나
 * 단계가 얕아지는 줄은 이 목록의 끝으로 본다.
 */
function buildList(entries: ListEntry[], from: number): { node: MarkdownListNode; next: number } {
  const head = entries[from];
  const items: MarkdownListItemNode[] = [];
  let cursor = from;
  while (cursor < entries.length) {
    const entry = entries[cursor];
    if (cursor > from && (entry.indent < head.indent || entry.kind !== head.kind)) break;
    cursor += 1;
    const children: MarkdownListNode[] = [];
    while (cursor < entries.length && entries[cursor].indent > entry.indent) {
      const child = buildList(entries, cursor);
      children.push(child.node);
      cursor = child.next;
    }
    items.push({ body: entry.body, line: entry.line, children });
  }
  return { node: { kind: head.kind, start: head.start, items }, next: cursor };
}

/**
 * `start` 줄에서 시작하는 목록을 읽는다. 목록 줄이 아니면 null.
 *
 * 같은 단계에서 갈래가 바뀌는 자리는 예전처럼 목록의 끝이다(`- 가` 다음의 `1. 나`는 다른
 * 목록이 된다). 달라진 것은 더 깊이 들여쓴 줄뿐으로, 전에는 같은 목록의 형제 항목으로
 * 납작해져 `1. 첫째 / 1. 하위 / 2. 둘째`가 1·2·3으로 이어 세어졌다.
 */
export function parseMarkdownList(lines: string[], start: number): MarkdownListParse | null {
  const head = listEntry(lines[start], start);
  if (!head) return null;
  const entries: ListEntry[] = [head];
  let index = start + 1;
  while (index < lines.length) {
    const entry = listEntry(lines[index], index);
    if (!entry) break;
    if (entry.indent <= head.indent && entry.kind !== head.kind) break;
    entries.push(entry);
    index += 1;
  }
  const lists: MarkdownListNode[] = [];
  let cursor = 0;
  while (cursor < entries.length) {
    const built = buildList(entries, cursor);
    lists.push(built.node);
    cursor = built.next;
  }
  return { lists, next: index };
}
