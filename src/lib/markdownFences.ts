/**
 * 코드 펜스를 여닫는 줄의 문법. 여는 줄에는 정보 문자열이 붙을 수 있고, 닫는 줄은 마커만
 * 있어야 한다. 블록 파서와 덩어리 분할기(`markdownChunks`)가 **같은 함수**를 써야 분할
 * 지점이 펜스 안으로 들어가지 않는다.
 *
 * 마커를 상수 하나로 못박지 않고 여는 줄에서 읽어 오는 이유는 두 가지다. 물결 펜스
 * (`~~~`)를 백틱과 같이 다루려면 종류를 기억해야 하고, 그러지 않으면 백틱 펜스 안에
 * 적힌 `~~~` 한 줄이 코드 블록을 먼저 닫아 뒤 내용이 본문으로 새어 나온다. 마커를
 * 길게 여는 것(```` ```` ````)도 CommonMark처럼 그 길이 이상으로만 닫힌다.
 *
 * 여는 줄의 정보 문자열은 한 낱말로 제한하지 않는다. `flowchart LR`처럼 낱말 뒤에 값이
 * 붙는 표기가 실제로 오는데, 한 낱말만 받으면 그 줄은 펜스로 **인식조차 되지 않고**
 * 코드가 본문 문단으로 새어 나왔다. 백틱은 정보 문자열에서 제외한다 — CommonMark도
 * 같은 이유로 금지한다(그 줄은 인라인 코드가 섞인 문단일 수 있다).
 */
/**
 * 펜스 마커 표기 — 백틱 셋 이상이거나 물결 셋 이상.
 *
 * 이 표기가 여는 줄과 닫는 줄에 각각 손으로 적혀 있었다. 둘은 반드시 같아야 한다 —
 * 한쪽만 넓어지면 여는 줄로 읽히는데 같은 마커로는 닫히지 않는(또는 그 반대의) 줄이
 * 생기고, 그 펜스는 문서 끝까지 코드로 먹어 뒤 내용이 통째로 사라진다. 눈으로 두 줄을
 * 대조해야 알 수 있는 어긋남이라, 표기를 한 곳에서 파생해 그 자리를 없앤다
 * (`markdownInline`의 `ASCII_PUNCTUATION`과 같은 이유다).
 *
 * 백틱은 템플릿 리터럴에 담을 수 없어 보통 문자열로 적고, 쓰는 자리가 마커를 통째로
 * 잡아 `marker`로 넘기므로 여기서는 잡지 않는 그룹으로 둔다.
 */
const FENCE_MARKER = "(?:```+|~~~+)";
const FENCE_OPEN_LINE = new RegExp(`^\\s*(${FENCE_MARKER})([^\`]*)$`);
const FENCE_CLOSE_LINE = new RegExp(`^\\s*(${FENCE_MARKER})\\s*$`);

export interface MarkdownFenceOpen {
  /** 여는 줄에 쓰인 마커. 닫는 줄 판정에 그대로 넘긴다. */
  marker: string;
  /** 정보 문자열의 첫 낱말. 언어 이름으로 쓰이는 부분이라 적힌 그대로 둔다. */
  language: string;
  /** 정보 문자열 전체(앞뒤 공백 제거). `flowchart LR`처럼 뒤에 붙은 값까지 필요한 갈래가 쓴다. */
  info: string;
}

/**
 * 정보 문자열에서 언어 이름을 꺼낸다 — 첫 낱말까지가 언어이고 그 뒤는 그 언어의 값이다.
 *
 * 이 규칙이 두 곳에 있었다. 여기서 펜스를 읽을 때 한 번, mermaid로 그릴지 가릴 때
 * (`mermaidBlock`) 한 번. 둘은 반드시 같아야 한다 — 갈라지면 코드 상자에는
 * `flowchart`로 칠해지는 펜스가 다이어그램 판정에서는 다른 이름으로 읽혀, 같은 여는 줄을
 * 두 갈래가 다르게 해석한다. 낱말 경계를 넓히거나(붙임표·마침표) 좁히는 변경이 실제로
 * 있었던 자리라, 한 곳에서 파생되면 그 어긋남이 생길 자리가 없다.
 *
 * 대소문자는 여기서 건드리지 않는다. 코드 상자는 적힌 그대로를 `data-language`에 싣고,
 * 이름을 목록과 맞춰 보는 쪽만 자기 자리에서 내린다.
 */
export function markdownFenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0] ?? "";
}

/** 코드 펜스를 여는 줄이면 마커와 정보 문자열을, 아니면 null을 돌려준다. */
export function markdownFenceOpen(line: string): MarkdownFenceOpen | null {
  const match = line.match(FENCE_OPEN_LINE);
  if (!match) return null;
  const info = match[2].trim();
  return { marker: match[1], language: markdownFenceLanguage(info), info };
}

/** 같은 종류이고 여는 줄만큼 긴 마커만 펜스를 닫는다. */
export function closesMarkdownFence(line: string, marker: string): boolean {
  const match = line.match(FENCE_CLOSE_LINE);
  return match !== null && match[1][0] === marker[0] && match[1].length >= marker.length;
}
