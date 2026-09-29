import { readStoredText, writeStoredText } from "./storedText.ts";

export const SECONDARY_PANE_COLLAPSE_MEDIA_QUERY = "(max-width: 760px)";

type StoredPaneState = "open" | "closed";

/**
 * 중메뉴 접힘 상태의 저장 규칙.
 *
 * 저장소 접근은 `storedText.ts`에 맡긴다. 쿠키를 전면 차단한 브라우저는
 * `window.localStorage`를 읽는 것만으로 던지고 사파리 프라이빗 모드는 쓰기에서 던지는데,
 * 이 파일이 그 예외를 자기 try/catch 두 벌로 따로 삼키고 있었다. 예외를 삼키는 자리가
 * 늘어나면 "읽기는 저장값 없음, 쓰기는 무동작"이라는 규칙이 파일마다 조금씩 달라지고,
 * 실제로 여기는 `window` 유무 판정까지 자기 몫으로 안고 있어 저장소가 없는 실행과 막힌
 * 저장소를 서로 다른 갈래로 다뤘다. 이 파일에 남는 것은 저장 문자열과 화면 상태의 대응,
 * 그리고 저장값이 없을 때 무엇으로 시작할지뿐이다.
 */

/** 저장 문자열과 화면의 불리언 상태 사이 대응을 한곳에서 정한다. */
function parseStoredPaneState(value: string | null): boolean | null {
  if (value === "open") return true;
  if (value === "closed") return false;
  return null;
}

function storedPaneState(open: boolean): StoredPaneState {
  return open ? "open" : "closed";
}

/**
 * 중메뉴의 열림 상태를 화면별로 기억한다. 처음 여는 화면은 넓은 화면에서 펼치고,
 * 본문 폭이 더 중요한 좁은 화면에서는 접어 둔다. 저장소가 막혀 있으면 저장값이 없는
 * 것과 같이 보므로 이 기본값으로 떨어진다.
 */
export function readSecondaryPaneOpen(storageKey: string): boolean {
  const stored = parseStoredPaneState(readStoredText(storageKey));
  if (stored !== null) return stored;
  // 화면 폭을 물을 창이 없는 실행(서버 렌더·node 테스트)은 펼친 쪽을 기본으로 둔다.
  if (typeof window === "undefined") return true;
  return !window.matchMedia(SECONDARY_PANE_COLLAPSE_MEDIA_QUERY).matches;
}

/** 접힘 상태는 화면 편의값이라, 저장에 실패해도 현재 실행 중에는 고른 값이 그대로 쓰인다. */
export function writeSecondaryPaneOpen(storageKey: string, open: boolean): void {
  writeStoredText(storageKey, storedPaneState(open));
}
