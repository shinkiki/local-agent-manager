/**
 * 한 줄을 토큰으로 쪼개는 규칙 — 강조·코드 스팬·링크·백슬래시 이스케이프.
 *
 * 블록 구조(목록·코드 펜스·덩어리 분할)와 같은 파일에 있었지만 둘은 공유하는 값이 없다.
 * 여기 있는 것은 "한 줄을 토큰으로 어떻게 쪼개는가"뿐이고, 블록 쪽을 고칠 때 이스케이프
 * 문자 집합을 함께 읽을 필요가 없도록 파일을 나눠 둔다.
 *
 * `<…>` 덩이의 정체를 가르는 일(`markdownAngle`)도 같은 이유로 여기 있지 않다. 이 파일이
 * 정하는 것은 **갈래 사이의 우선순위**라 표기가 겹쳐 잘못 잡힐 때 손대고, 그쪽이 정하는
 * 것은 걷어내도 되는 HTML 태그의 허용목록이라 에이전트가 보내는 표기를 보고 손댄다.
 * 토큰 표는 `<…>`를 한 덩이로만 잡고 안을 들여다보지 않으므로 두 규칙은 서로를 모른다.
 */

/**
 * CommonMark가 백슬래시 이스케이프를 인정하는 글자 — ASCII 문장부호 전부.
 *
 * 이 집합이 이스케이프 규칙의 유일한 자리다. 아래 토큰의 이스케이프 갈래와
 * `unescapeMarkdown`의 되돌림이 각자 같은 범위를 손으로 적고 있었는데, 그 둘은 반드시
 * 같아야 한다 — 한쪽만 넓어지면 본문에서는 사라진 백슬래시가 링크 주소에만 남는다.
 * 범위를 눈으로 대조해야 알 수 있는 어긋남이라 주석으로 묶어 둘 수 없고, 한 곳에서
 * 파생되면 그 어긋남이 생길 자리가 없다.
 */
const ASCII_PUNCTUATION = String.raw`[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]`;

/**
 * 인라인 표기 갈래. **적힌 순서가 규칙이다** — 같은 자리에서는 먼저 적은 갈래가 이긴다.
 * 한 줄짜리 정규식 리터럴은 그 순서가 왜 이런지 갈래마다 적어 둘 자리가 없어서, 이유가
 * 위쪽 주석에 뭉쳐 있고 어느 줄이 어느 규칙인지는 세어 봐야 알 수 있었다. 갈래마다 한
 * 줄을 주면 순서를 옮기려는 사람이 그 자리에서 이유를 읽는다.
 */
const INLINE_TOKEN_ALTERNATIVES: readonly string[] = [
  // 이스케이프는 **맨 앞**이어야 한다. `\*`가 기울임을 열지 못하고 두 글자 토큰으로
  // 먼저 소비되는 것이 이 자리에서 나온다.
  String.raw`\\${ASCII_PUNCTUATION}`,
  // 코드 스팬. 안쪽은 어떤 표기도 열지 않으므로 강조보다 먼저 본다.
  // 백틱은 템플릿 리터럴에 그대로 담을 수 없어 이 줄만 보통 문자열이다.
  "`[^`\\n]+`",
  // 같은 글자를 쓰는 강조는 긴 것부터. `***`가 `**`보다 뒤면 `***중요***`가 안쪽만
  // 잡혀 양옆 별표가 글자로 남는다. 밑줄 세 갈래도 같은 이유로 이 순서다.
  String.raw`\*\*\*[^*\n]+\*\*\*`,
  String.raw`\*\*[^*\n]+\*\*`,
  String.raw`~~[^~\n]+~~`,
  String.raw`___[^_\n]+___`,
  String.raw`__[^_\n]+__`,
  String.raw`_[^_\n]+_`,
  // 이미지의 `!`를 링크 갈래에 붙여 잡는다. 떼어 놓으면 느낌표만 화면에 남는다.
  String.raw`!?\[[^\]\n]+\]\([^)\n]+\)`,
  // `<…>` 한 덩이. 자동 링크·HTML 태그·부등호를 가르는 일은 markdownAngle이 한다.
  String.raw`<[^<>\s][^<>\n]*>`,
  // 별표 하나짜리 기울임은 위의 별표 갈래가 모두 지나간 뒤에 본다.
  String.raw`\*[^*\n]+\*`,
];

/**
 * 인라인 표기 토큰. `matchAll`은 정규식을 복제해 쓰므로 `lastIndex`가 공유되지 않는다.
 * 호출마다 다시 조립하지 않도록 모듈 수준에 둔다.
 */
export const MARKDOWN_INLINE_TOKEN = new RegExp(`(${INLINE_TOKEN_ALTERNATIVES.join("|")})`, "g");

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
 * CommonMark는 ASCII 문장부호 앞의 백슬래시만 이스케이프로 보고, 그 밖의 글자 앞이면
 * 백슬래시를 글자 그대로 남긴다. 문자 집합은 토큰의 이스케이프 갈래와 같은
 * `ASCII_PUNCTUATION`에서 나온다.
 */
const MARKDOWN_ESCAPE = new RegExp(String.raw`\\(${ASCII_PUNCTUATION})`, "g");

/** 이스케이프를 실제 글자로 되돌린다. 마크다운으로 그리지 않는 링크 주소에 쓴다. */
export function unescapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPE, "$1");
}

/** 토큰이 이스케이프면 가려진 글자를, 아니면 null을 돌려준다. */
export function markdownEscapedChar(token: string): string | null {
  return token.length === 2 && token.startsWith("\\") ? token.slice(1) : null;
}
