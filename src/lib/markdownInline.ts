/**
 * 한 줄 안의 인라인 표기 규칙 — 강조·코드 스팬·링크·`<…>`·백슬래시 이스케이프.
 *
 * 블록 구조(목록·코드 펜스·덩어리 분할)와 같은 파일에 있었지만 둘은 공유하는 값이 없다.
 * 여기 있는 것은 "한 줄을 토큰으로 어떻게 쪼개는가"뿐이고, 블록 쪽을 고칠 때 이스케이프
 * 문자 집합이나 HTML 태그 허용목록을 함께 읽을 필요가 없도록 파일을 나눠 둔다.
 */

/**
 * 인라인 표기 토큰. `matchAll`은 정규식을 복제해 쓰므로 `lastIndex`가 공유되지 않는다.
 * 호출마다 리터럴을 다시 만들지 않도록 모듈 수준에 둔다.
 *
 * 백슬래시 이스케이프가 **맨 앞** 갈래인 것이 중요하다. 같은 자리에서는 먼저 적은 갈래가
 * 이기므로, `\*`는 기울임을 열지 못하고 두 글자짜리 토큰으로 먼저 소비된다.
 *
 * 같은 글자를 쓰는 갈래는 긴 것부터 적는다. `***`가 `**`보다 뒤에 있으면 `***중요***`가
 * 안쪽 `**중요**`만 잡혀 양옆 별표가 글자로 남는다. `!`를 링크 갈래 앞에 붙인 것도
 * 같은 이유로, 이미지 표기의 느낌표만 화면에 남던 것을 막는다.
 */
export const MARKDOWN_INLINE_TOKEN =
  /(\\[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|~~[^~\n]+~~|___[^_\n]+___|__[^_\n]+__|_[^_\n]+_|!?\[[^\]\n]+\]\([^)\n]+\)|<[^<>\s][^<>\n]*>|\*[^*\n]+\*)/g;

/** 낱말 안의 글자. `_`는 식별자에 흔해 이 글자에 붙어 있으면 표기로 보지 않는다. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * `_` 표기가 낱말 한가운데인지. CommonMark도 `snake_case_name`의 밑줄은 강조로 보지
 * 않는다. 토큰 앞뒤 글자를 함께 봐야 하므로 매칭 자리를 그대로 받는다.
 */
export function markdownUnderscoreIsIntraword(text: string, start: number, end: number): boolean {
  return WORD_CHARACTER.test(text[start - 1] ?? "") || WORD_CHARACTER.test(text[end] ?? "");
}

/**
 * 미리보기에서 걷어낼 HTML 태그 이름. 목록에 없는 태그는 글자로 남긴다. 모르는 표기를
 * 조용히 숨기면 공급자가 답변에 섞어 보낸 XML이 흔적 없이 사라져, 무엇이 지워졌는지
 * 화면만 보고는 알 수 없다.
 */
const HTML_MARKUP_TAGS = new Set([
  "a", "b", "big", "blockquote", "br", "code", "del", "details", "div", "em", "font",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "s", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

/** 태그 이름과 속성 표기. 속성 없이 `<b>`도, `<img src="x" />`도 받는다. */
const HTML_TAG_TOKEN =
  /^<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+))?)*)\s*\/?>$/;

/** 스킴이 있고 공백이 없는 `<주소>`. CommonMark의 자동 링크 조건과 같다. */
const AUTOLINK_TOKEN = /^<[a-zA-Z][\w+.-]*:[^\s<>]*>$/;

export type MarkdownAngleToken =
  /** `<https://…>` 자동 링크. 주소를 그대로 링크로 그린다. */
  | { kind: "autolink"; href: string }
  /** `<br>`. 줄바꿈으로 그린다. */
  | { kind: "break" }
  /** 그 밖의 표시용 HTML 태그. 태그만 버리고 안쪽 글자는 그대로 둔다. */
  | { kind: "markup" }
  /** 표기가 아니라 부등호. `a <b 비교`처럼 글자로 그린다. */
  | null;

/** `<…>` 토큰의 정체를 가른다. 아는 표기가 아니면 null이라 글자로 남는다. */
export function markdownAngleToken(token: string): MarkdownAngleToken {
  if (AUTOLINK_TOKEN.test(token)) return { kind: "autolink", href: token.slice(1, -1) };
  const tag = token.match(HTML_TAG_TOKEN);
  if (!tag || !HTML_MARKUP_TAGS.has(tag[1].toLowerCase())) return null;
  return tag[1].toLowerCase() === "br" ? { kind: "break" } : { kind: "markup" };
}

/**
 * CommonMark는 ASCII 문장부호 앞의 백슬래시만 이스케이프로 보고, 그 밖의 글자 앞이면
 * 백슬래시를 글자 그대로 남긴다. 위 토큰과 **같은 문자 집합**을 봐야 본문에서는 사라진
 * 백슬래시가 링크 주소에만 남는 어긋남이 생기지 않는다.
 */
const MARKDOWN_ESCAPE = /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g;

/** 이스케이프를 실제 글자로 되돌린다. 마크다운으로 그리지 않는 링크 주소에 쓴다. */
export function unescapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPE, "$1");
}

/** 토큰이 이스케이프면 가려진 글자를, 아니면 null을 돌려준다. */
export function markdownEscapedChar(token: string): string | null {
  return token.length === 2 && token.startsWith("\\") ? token.slice(1) : null;
}
