/**
 * "기본도구 접근 표를 다시 읽어야 한다"는 신호 한 벌.
 *
 * 애드온 화면은 도구마다 접근 상세(`BuiltinToolAccess`)와 그 도구의 카드가 같은 패널에
 * 나란히 선다. 상세는 마운트할 때 카탈로그를 한 번 읽는데, 사용 스위치는 **옆 카드**가
 * 처리하므로 상세가 다시 읽을 계기가 없었다 — 스위치는 켜졌는데 바로 위 상세는 `꺼짐`으로
 * 남아 한 화면이 두 말을 했다(QA #95). 탭을 다녀오면 그제야 맞았다.
 *
 * 부모를 거쳐 콜백을 내리는 길도 있었지만, 그러려면 도구 카드 다섯이 모두 같은 prop을 받아
 * 자기 변경마다 올려 주어야 한다. 카드는 저마다 다른 명령으로 사용 상태를 바꾸므로, 바꾸는
 * 자리(=ipc 함수)에서 한 번 알리고 읽는 자리에서 구독하는 쪽이 빠뜨릴 자리가 적다.
 */

let revision = 0;
const listeners = new Set<() => void>();

/** 기본도구 카탈로그가 달라졌을 수 있다고 알린다. 사용 상태를 바꾸는 ipc 함수가 부른다. */
export function markBuiltinToolsChanged(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore`가 쓰는 구독. 해제 함수를 돌려준다. */
export function subscribeBuiltinTools(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 지금까지 알려 온 횟수. 값 자체에 뜻은 없고, 달라졌다는 것만 쓴다. */
export function builtinToolsRevision(): number {
  return revision;
}

/**
 * 기본도구 접근 상세가 읽는 값을 바꾸는 호출에 씌운다. 성공했을 때만 알린다 — 거절된
 * 요청은 아무것도 바꾸지 않았으므로 다시 읽힐 이유가 없다.
 *
 * 전송(`ipcTransport`)에 기대지 않고 이 신호만 쓰므로 신호와 함께 둔다. 카탈로그 조회
 * 옆(`ipcBuiltinTools`)에 있던 동안에는 이 규칙을 시험하려면 전송 계층 전체를 함께
 * 끌어와야 해서, 어느 명령이 감싸졌는지를 붙잡는 시험이 서지 못했다(QA #101).
 */
export function notifyBuiltinTools<T>(request: Promise<T>): Promise<T> {
  return request.then((value) => { markBuiltinToolsChanged(); return value; });
}
