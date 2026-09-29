import { useEffect, useRef } from "react";
import { createPollLoop, type PollLoop } from "./pollLoop.ts";

/**
 * 화면이 폴링을 붙이는 방법. 루프 자체(예약·백오프·가시성)는 `pollLoop`에 있고, 여기
 * 있는 것은 그 루프를 언제 만들고 언제 버리는가라는 렌더 규칙뿐이다.
 *
 * 루프를 내보내지 않는다. 화면이 쓰는 모양은 아래 훅 하나뿐이고, 루프를 이 통로로도
 * 내주면 훅을 거치지 않고 루프를 만드는 두 번째 경로가 열린다 — 그쪽에는 화면이 사라질
 * 때 루프를 멈추는 자리가 없어, 닫힌 화면이 계속 폴링한다. 루프를 직접 다루는 쪽
 * (node 시험)은 통로가 아니라 `pollLoop`을 바로 가져간다.
 */

/**
 * createPollLoop의 React 래퍼. run은 ref로 최신값을 따라가므로 콜백 신원이 바뀌어도
 * 루프를 다시 만들지 않는다(의존성 변화로 폴링이 재발사되는 것을 막는다).
 */
export function usePoll(
  run: () => Promise<unknown>,
  intervalMs: number,
  options: { enabled?: boolean; maxBackoffMs?: number } = {},
): () => Promise<void> {
  const { enabled = true, maxBackoffMs } = options;
  const runRef = useRef(run);
  const loopRef = useRef<PollLoop | null>(null);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return undefined;
    const loop = createPollLoop({
      intervalMs,
      maxBackoffMs,
      run: () => Promise.resolve(runRef.current()),
    });
    loopRef.current = loop;
    loop.start();
    return () => {
      loop.stop();
      if (loopRef.current === loop) loopRef.current = null;
    };
  }, [enabled, intervalMs, maxBackoffMs]);

  return useRef(() => loopRef.current?.refreshNow() ?? Promise.resolve()).current;
}
