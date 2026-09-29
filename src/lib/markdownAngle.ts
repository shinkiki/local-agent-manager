/**
 * `<…>` 한 덩이의 정체를 가르는 규칙 — 자동 링크인가, 걷어낼 표시용 HTML 태그인가,
 * 그냥 부등호인가.
 *
 * 한 줄을 토큰으로 쪼개는 규칙(`markdownInline`)과 같은 파일에 있었지만 둘이 바뀌는
 * 이유는 다르다. 쪼개는 쪽은 강조·코드 스팬 표기의 우선순위가 어긋났을 때 손대는
 * 순서 규칙이고, 여기 있는 것은 **에이전트가 보낸 꺾쇠 덩이 중 무엇을 화면에서
 * 없애도 되는가**라는 허용목록이다. 그 목록을 넓히거나 좁히는 판단은 공급자가 답변에
 * 섞어 보내는 표기를 보고 내리는 것이라, 토큰 순서를 고치러 들어온 사람이 함께 읽어야
 * 할 이유가 없다. 문법과 덩어리 분할을 가른 `markdownFences`/`markdownChunks`와 같은
 * 경계다.
 *
 * 토큰 표는 `<…>`를 **한 덩이로만** 잡고 그 안을 들여다보지 않는다. 그래서 이 파일이
 * 바뀌어도 토큰 경계는 움직이지 않고, 반대로 토큰 갈래가 늘어도 허용목록은 그대로다.
 */

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
  const tagName = tag?.[1].toLowerCase();
  if (!tagName || !HTML_MARKUP_TAGS.has(tagName)) return null;
  return tagName === "br" ? { kind: "break" } : { kind: "markup" };
}
