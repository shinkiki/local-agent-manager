/**
 * 마크다운 목록 줄 **하나**를 읽는 규칙. 블록 진입 판정과 항목 소비가 **같은 정규식**을
 * 쓰는 것이 이 파일의 존재 이유다. 둘이 갈라지면 진입은 하지만 한 줄도 소비하지 못하는
 * 줄이 생기고, 손으로 짠 라인 스캐너는 그 줄에서 무한 루프에 빠진다(빈 목록 엘리먼트를
 * 메모리가 마를 때까지 만들어내며 화면이 멈춘다). 그래서 본문은 `(.*)`로 빈 항목까지
 * 받아들인다.
 *
 * 미리보기가 블록 구조를 한 자리에서 가져가는 통로(`markdownBlocks`)와 갈라 둔 이유는,
 * 그 통로가 이제 목록·인라인·`<…>`·펜스·덩어리 분할 다섯 갈래를 모으는 자리이기 때문이다.
 * 갈래마다 제 파일에 사는데 목록만 통로 본문에 남아 있으면, 마커 문법 한 줄을 고치러
 * 들어온 사람이 나머지 네 갈래의 가져오기 목록을 먼저 지나야 하고 새 갈래를 더하는
 * 사람은 통로가 규칙도 함께 들고 있는지를 매번 확인해야 한다. 문법과 덩어리 분할을 가른
 * `markdownFences`/`markdownChunks`, 목록과 저장 규칙을 가른
 * `navigationViews`/`navigationPreferences`와 같은 경계다.
 */
export type MarkdownListKind = "unordered" | "ordered";

const LIST_ITEM_PATTERNS: Record<MarkdownListKind, RegExp> = {
  unordered: /^\s*[-*+]\s+(?<body>.*)$/,
  ordered: /^\s*(?<number>\d+)[.)]\s+(?<body>.*)$/,
};

/** 체크박스 목록 항목. `- [x] 할 일`의 상태와 본문을 나눈다. */
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;

export interface MarkdownTaskItem {
  checked: boolean;
  body: string;
}

/** 목록 줄 하나에서 읽어낼 수 있는 것 전부. */
export interface MarkdownListItem {
  /** 마커를 떼어낸 본문. 마커 뒤가 비어 있어도(`"- "`) 빈 문자열이다. */
  body: string;
  /** 순서 있는 항목에 적힌 번호. 순서 없는 목록은 null. */
  start: number | null;
}

/**
 * 목록 줄 하나를 읽는다. 목록 줄이 아니면 null.
 *
 * 본문과 번호를 한 번의 매칭에서 함께 꺼내는 것이 요점이다. 예전에는 본문을 잡는 정규식과
 * 번호만 잡는 정규식이 따로 있었고, 같은 마커 문법(`\s*` 들여쓰기 · `\d+` · `[.)]` ·
 * 뒤따르는 `\s+`)이 두 곳에 손으로 적혀 있었다. 그 둘은 반드시 같아야 한다 — 한쪽만
 * 넓어지면 본문으로는 읽히는데 번호는 없는 줄(또는 그 반대)이 생기고, 목록 스캐너는
 * 본문 판정만 믿고 그 줄을 소비하므로 어긋남이 화면의 번호로만 드러난다. 갈래별 규칙을
 * 한 줄씩만 적고, 이름 있는 그룹으로 어느 조각이 무엇인지 정규식 안에 남긴다.
 *
 * 번호가 왜 필요한지: 미리보기는 빈 줄에서 문서를 덩어리로 자르므로
 * (`splitMarkdownChunks`), 항목 사이를 빈 줄로 띄운 목록은 항목마다 다른 `<ol>`이 된다.
 * 번호를 붙이지 않으면 그 `<ol>`이 전부 1부터 다시 세어 `1. 2. 3.`이 `1. 1. 1.`로 보인다.
 * 원문의 번호를 `start`로 넘겨 이어지게 한다. 1이 아닌 번호로 시작하는 목록(`3. 셋째`)도
 * 같은 규칙으로 제 번호를 지킨다.
 *
 * 마커 뒤가 비어 있어도 빈 본문으로 매칭되므로, 이 함수가 항목을 돌려주는 모든 줄은
 * 스캐너가 반드시 소비한다.
 */
export function markdownListItem(line: string, kind: MarkdownListKind): MarkdownListItem | null {
  const groups = line.match(LIST_ITEM_PATTERNS[kind])?.groups;
  if (!groups) return null;
  return { body: groups.body ?? "", start: groups.number === undefined ? null : Number(groups.number) };
}

/** 목록 줄인지만 본다. `markdownListItem`과 같은 정규식이라 판정이 어긋나지 않는다. */
export function startsMarkdownListItem(line: string, kind: MarkdownListKind): boolean {
  return markdownListItem(line, kind) !== null;
}

/** 체크박스 항목이면 상태와 본문을, 아니면 null을 돌려준다. */
export function markdownTaskItem(body: string): MarkdownTaskItem | null {
  const match = body.match(TASK_ITEM);
  return match ? { checked: match[1].toLowerCase() === "x", body: match[2] } : null;
}
