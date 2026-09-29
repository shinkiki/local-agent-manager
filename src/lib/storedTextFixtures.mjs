/**
 * 웹 저장소를 흉내 낸 `window`. `storedText`가 삼키는 실패 모양과 평범한 저장소를
 * 이 한 곳이 소유한다.
 *
 * 저장소를 쓰는 테스트마다 같은 흉내를 각자 적고 있었다(`storedText`·`theme`·
 * `webNotificationPreference`). 세 벌이면 브라우저가 던지는 자리가 하나 늘 때 한
 * 파일만 고쳐도 전부 통과하고, 저장 항목마다 다른 실패 모양으로만 검증하게 된다 —
 * 실제로 같은 "막힌 저장소"를 한쪽은 접근에서 던지는 window로, 다른 쪽은 호출에서
 * 던지는 저장소로 적고 있었다.
 */

/** 원래 값으로 돌려놓을 수 있게 바꾸기 전 `globalThis.window`를 준다. */
export function setWindow(value) {
  const previous = globalThis.window;
  globalThis.window = value;
  return previous;
}

/**
 * 평범한 저장소를 가진 window. 돌려주는 Map이 곧 저장된 원문이라, 쓰기 검증은
 * 읽기 함수를 거치지 않고 저장값을 그대로 본다. 실패 흉내 둘과 달리 이 함수만 저장값을
 * 돌려주므로, 바꾸기 전 window가 필요하면 `setWindow`로 직접 되돌린다.
 */
export function useStorageWindow(initial = {}) {
  const store = new Map(Object.entries(initial));
  setWindow({
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
  });
  return store;
}

/** 쿠키를 전면 차단한 브라우저처럼 `window.localStorage`를 읽는 것만으로 던지는 window. */
export function useBlockedStorageWindow() {
  return setWindow({
    get localStorage() {
      throw new Error("SecurityError: The operation is insecure.");
    },
  });
}

/** 사파리 프라이빗 모드처럼 접근은 되지만 각 호출이 던지는 저장소. */
export function useThrowingStorageWindow() {
  return setWindow({
    localStorage: {
      getItem() { throw new Error("QuotaExceededError"); },
      setItem() { throw new Error("QuotaExceededError"); },
    },
  });
}
