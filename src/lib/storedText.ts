/**
 * 막힐 수 있다는 전제로만 하는 웹 저장소 접근. 쿠키를 전면 차단한 브라우저는
 * `window.localStorage`를 **읽는 것만으로** SecurityError를 던지고, 사파리 프라이빗
 * 모드는 쓰기에서 던진다. 화면 설정을 읽는 자리는 대부분 컴포넌트의 지연 초기값이라,
 * 감싸지 않으면 그 예외 하나가 앱 셸을 통째로 오류 경계로 떨어뜨린다.
 *
 * 그래서 규칙은 하나다 — 읽기는 저장값 없음(`null`)으로, 쓰기는 무동작으로 떨어지고
 * 현재 실행 중의 선택만 남는다. 이 모양을 모듈마다 각자 try/catch로 적으면 새로 생기는
 * 저장 항목이 그중 한 벌을 빠뜨려도 아무도 알아채지 못하므로, 예외를 삼키는 자리를
 * 여기 한 벌만 둔다. 무엇을 어떤 키로 저장할지는 저장 항목을 가진 모듈이 그대로 안다.
 */

/** 이 모듈이 쓰는 저장소의 최소 모양. 테스트가 저장소를 직접 넘길 수 있게 열어 둔다. */
export interface StoredTextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 기본 저장소. `window.localStorage`에 닿는 것 자체가 던질 수 있으므로 이 접근도 감싼다.
 * 저장소가 없는 실행(서버 렌더·node 테스트)과 막힌 저장소는 같은 뜻으로 `null`이다.
 */
function defaultStorage(): StoredTextStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 저장된 원문. 저장소가 막혀 있으면 저장값이 없는 것과 같이 본다. */
export function readStoredText(key: string, storage: StoredTextStorage | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 원문을 저장한다. 저장에 실패해도 현재 실행 중에는 고른 값이 그대로 쓰인다. */
export function writeStoredText(key: string, value: string, storage: StoredTextStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // 저장 실패는 무시한다.
  }
}
