import { eachProseSegment, mapProseSegments } from "./markdownProse.ts";

/**
 * 지침 문서의 링크 규칙 — 가져오기 표기를 마크다운 링크로 바꾸고, 문서가 참조하는 로컬
 * 파일 링크를 모으고, 그릴 수 있는 주소인지 가른다.
 *
 * 무엇이 산문인지 가르는 일(코드 펜스·인라인 코드 제외)은 `markdownProse`가 한다. 변환과
 * 수집이 같은 스캐너를 쓰는 것이 이 파일의 불변식이고, 그 스캐너가 어디 사는지는 아래 두
 * 진입점이 가져오는 자리에 한 번만 적힌다.
 */

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
