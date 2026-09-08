export const SECONDARY_PANE_COLLAPSE_MEDIA_QUERY = "(max-width: 760px)";

/**
 * 중메뉴의 열림 상태를 화면별로 기억한다. 처음 여는 화면은 넓은 화면에서 펼치고,
 * 본문 폭이 더 중요한 좁은 화면에서는 접어 둔다.
 */
export function readSecondaryPaneOpen(storageKey: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "open") return true;
    if (stored === "closed") return false;
  } catch {
    // 저장소가 막혀도 현재 화면의 기본 동작은 유지한다.
  }
  return !window.matchMedia(SECONDARY_PANE_COLLAPSE_MEDIA_QUERY).matches;
}

export function writeSecondaryPaneOpen(storageKey: string, open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, open ? "open" : "closed");
  } catch {
    // 접힘 상태는 화면 편의값이라 저장 실패를 사용자 오류로 올리지 않는다.
  }
}
