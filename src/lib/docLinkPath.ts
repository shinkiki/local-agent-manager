// 문서 화면에서 Markdown 링크를 눌렀을 때 대상 문서 경로를 등록 폴더 기준으로 해석한다.
// 화면 상태와 무관한 순수 함수라 컴포넌트에서 떼어 시험으로 고정한다.

// 링크 표기에서 바깥 꺾쇠(`<...>`)를 벗겨낸다.
function stripLinkBrackets(target: string): string {
  const trimmed = target.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

// 링크 표기에서 퍼센트 인코딩을 풀고 구분자·쿼리·프래그먼트와 `:12` 같은 줄 번호 꼬리를
// 떼어 경로만 남긴다. 디코드할 수 없는 링크는 비교하지 않고 버린다(null).
function decodeLinkPath(target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  return decoded.replace(/\\/g, "/").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
}

/** 꺾쇠를 벗기고 디코딩과 쿼리·해시 제거를 거쳐 순수 링크 경로만 추출한다. */
export function parseLinkPath(href: string): string | null {
  return decodeLinkPath(stripLinkBrackets(href));
}

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

/**
 * 경로 세그먼트 배열에서 빈 문자열과 '.'을 건너뛰고 '..'으로 상위 디렉터리를 거슬러 올라간다.
 * 최상위 경로를 벗어나려는 '..'이 나오면 잘못된 상대 경로로 보아 null을 돌려준다.
 */
function normalizePathSegments(segments: string[]): string | null {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

/**
 * 구문 분석(꺾쇠·퍼센트 인코딩·쿼리·줄 번호)을 거친 링크 경로를 등록 폴더 기준으로 해석한다.
 * 절대 경로는 등록 폴더 접두사를 확인하고, 상대 경로는 현재 문서 위치에 얹어 정규화한다.
 */
export function resolveDocLinkPath(rootPath: string, currentPath: string, target: string): string | null {
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const absolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
  let segments: string[];
  if (absolute) {
    const rootPrefix = `${root}/`;
    if (target.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
      segments = target.slice(rootPrefix.length).split("/");
    } else if (target.startsWith("/")) {
      segments = target.slice(1).split("/");
    } else {
      return null;
    }
  } else {
    segments = [...currentPath.split("/").slice(0, -1), ...target.split("/")];
  }

  return normalizePathSegments(segments);
}
