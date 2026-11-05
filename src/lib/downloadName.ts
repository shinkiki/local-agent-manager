/**
 * 내려받는 파일의 이름을 정하는 규칙 — 이름 다듬기, 링크에서 이름 되짚기, 응답 헤더에서
 * 이름 읽기.
 *
 * 셋 다 입력 문자열만 보는 순수 규칙인데, 저장 갈래(`fileSave.ts`)와 다운로드 통로
 * (`ipcLinkedFile.ts`)에 나뉘어 있었고 그 두 모듈은 Tauri API를 모듈 수준에서 들인다.
 * 그래서 node 시험이 이 규칙을 불러올 수 없었고, 한 문자(`:`로 끝나는 줄 번호, `\0`,
 * `..`) 때문에 다른 이름으로 저장되는 결함이 생겨도 잡을 시험이 없었다. 규칙만 여기
 * 한 벌로 두면 시험이 셸 없이 돌고, 저장 대화상자에 뜨는 기본 이름과 실제로 기록되는
 * 이름이 같은 함수에서 나온다.
 */

/** 경로 구분자·NUL을 걷어낸 파일 이름. 이름이 남지 않으면 `download`으로 떨어진다. */
export function sanitizeDownloadName(name: string): string {
  const safe = name.replace(/[\\/\0]/g, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "download";
}

/**
 * 링크 문자열에서 저장 이름을 되짚는다. 꺾쇠·질의·조각·끝의 `:줄번호`를 걷어낸 뒤
 * 퍼센트 부호를 풀고, 마지막 경로 조각을 이름으로 쓴다. 푸는 데 실패한 링크는 그대로 쓴다.
 */
export function linkedFileName(href: string): string {
  let target = href.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
  target = decodedUriComponent(target) ?? target;
  const name = target.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return sanitizeDownloadName(name || "download");
}

/**
 * `Content-Disposition` 헤더의 파일 이름. RFC 5987 꼴(`filename*=UTF-8''…`)을 먼저 보고,
 * 그 값을 풀 수 없을 때만 따옴표 꼴(`filename="…"`)로 내려간다. 둘 다 없으면 null이다.
 */
export function responseFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    const decoded = decodedUriComponent(encoded);
    if (decoded !== null) return sanitizeDownloadName(decoded);
  }
  const fallback = disposition.match(/filename="([^"]+)"/i)?.[1];
  return fallback ? sanitizeDownloadName(fallback) : null;
}

/** 링크와 응답 헤더가 공유하는 URI 디코딩 실패 규칙. 호출부가 각자의 대체값을 고른다. */
function decodedUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
