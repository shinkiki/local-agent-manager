/** 코드 펜스를 여닫는 줄. 여는 줄과 닫는 줄을 같은 규칙으로 본다. */
const FENCE_LINE = /^\s*```/;

/**
 * 코드가 아닌 글자 조각만 훑는다. 코드 펜스 안쪽 줄과 인라인 코드(홀수 번째 백틱 조각)는
 * `transform`에 넘기지 않고 원문 그대로 남긴다.
 *
 * 가져오기 표기를 링크로 바꾸는 쪽과 링크를 모으는 쪽이 **같은 스캐너**를 써야 한다.
 * 둘이 갈라지면 화면에는 링크로 그려지는데 보관 세트에는 빠지는 문서(또는 그 반대)가
 * 생긴다. 그래서 조각 경계 규칙은 이 함수 하나에만 있고, 모으기만 하는 호출부도
 * `eachProseSegment`를 거쳐 같은 경계를 본다.
 */
function mapProseSegments(source: string, transform: (segment: string) => string): string {
  let fenced = false;
  return source.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.split("`").map((segment, index) => (index % 2 === 1 ? segment : transform(segment))).join("`");
  }).join("\n");
}

/**
 * 산문 조각을 나온 순서대로 넘겨 준다. 문서를 바꿔 쓰지 않는 호출부가 조각을 그대로
 * 되돌려 주고 완성된 문자열을 버리는 모양이었는데, 그러면 읽는 사람이 "이 반환값이
 * 어디에 쓰이는가"를 매번 되짚어야 한다. 훑기만 하는 뜻을 이름으로 드러내고, 경계
 * 규칙은 여전히 `mapProseSegments` 한 곳에서만 정한다.
 */
function eachProseSegment(source: string, visit: (segment: string) => void): void {
  mapProseSegments(source, (segment) => {
    visit(segment);
    return segment;
  });
}

/** `@`로 시작하는 경로 뒤에 오는 문장 부호. 경로에서 떼어내고 링크 밖에 남긴다. */
const IMPORT_TRAILING_PUNCTUATION = /[.,;:)\]]+$/;
const IMPORT_TOKEN = /(^|[\s(])@([A-Za-z0-9._~/-]+)/g;
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\n]+)\)/g;

/**
 * 산문 조각 하나의 가져오기 표기를 링크로 바꾼다. 조각 단위로 끝나는 변환이라 문서를
 * 한 번 훑는 동안 링크 변환과 링크 수집을 같은 자리에서 할 수 있다.
 */
function linkifyImportsInSegment(segment: string): string {
  return segment.replace(IMPORT_TOKEN, (match, lead: string, path: string) => {
    const target = path.replace(IMPORT_TRAILING_PUNCTUATION, "");
    const linkable = target.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(target);
    return linkable ? `${lead}[@${target}](${target})${path.slice(target.length)}` : match;
  });
}

/**
 * `@context/agent/rules.md`처럼 지침이 다른 문서를 가져오는 표기를 마크다운 링크로
 * 바꾼다. 경로처럼 보이는 토큰(슬래시가 있거나 확장자로 끝남)만 바꾸고, 코드 블록과
 * 인라인 코드는 원문 그대로 남긴다. 앞이 공백이어야 하므로 이메일은 걸리지 않는다.
 */
export function linkifyImports(source: string): string {
  return mapProseSegments(source, linkifyImportsInSegment);
}

/**
 * 문서가 참조하는 로컬 파일 링크를 나온 순서대로 모은다. 가져오기 표기를 링크로 바꾼
 * **그 조각에서 바로** 모으므로 화면에 링크로 그려지는 것과 목록이 어긋나지 않는다.
 * 변환한 문서를 따로 만들어 다시 훑지 않는다 — 가져오기 변환은 조각 안에서 끝나고
 * 백틱도 줄바꿈도 새로 만들지 않아, 두 번 훑어도 조각 경계가 같기 때문이다.
 */
export function localDocumentLinks(source: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  eachProseSegment(source, (segment) => {
    for (const match of linkifyImportsInSegment(segment).matchAll(MARKDOWN_LINK)) {
      const href = match[1].trim();
      if (!isLocalFileHref(href) || !safeHref(href) || seen.has(href)) continue;
      seen.add(href);
      links.push(href);
    }
  });
  return links;
}

/**
 * 로컬 파일이 아닌 주소의 스킴. `safeHref`와 `isLocalFileHref`가 같은 목록을 봐야
 * 한쪽만 넓어져 외부 주소가 로컬 문서로 열리거나 그 반대가 되는 일이 없다.
 */
const NON_LOCAL_SCHEME = /^(https?:|mailto:|#)/i;

/** 렌더링해도 되는 링크 주소. 판단할 수 없는 스킴은 링크로 만들지 않는다. */
export function safeHref(href: string): string | null {
  if (href.startsWith("//")) return null;
  if (NON_LOCAL_SCHEME.test(href)) return href;
  return /^(\/|\\|\.\.?[\\/]|[a-z]:[\\/]|[^:]+$)/i.test(href) ? href : null;
}

export function isLocalFileHref(href: string): boolean {
  return !NON_LOCAL_SCHEME.test(href);
}
