import { useEffect, useRef } from "react";

/** 테스트에서 시간을 직접 진행시킬 수 있도록 타이머를 주입한다. */
export interface PollTimers {
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

/** 문서 가시성 소스. 브라우저에서는 document.visibilityState를 쓴다. */
export interface PollVisibility {
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface PollLoopOptions {
  /** 성공 후 다음 실행까지의 기본 간격. */
  intervalMs: number;
  /** 연속 실패 시 지수 백오프 상한. */
  maxBackoffMs?: number;
  run: () => Promise<unknown>;
  timers?: PollTimers;
  visibility?: PollVisibility;
}

export interface PollLoop {
  start(): void;
  stop(): void;
  /** 주기를 기다리지 않고 즉시 한 번 갱신한다. 진행 중이면 그 실행을 이어 기다린다. */
  refreshNow(): Promise<void>;
}

const DEFAULT_MAX_POLL_BACKOFF_MS = 30_000;

const browserTimers: PollTimers = {
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (handle) => window.clearTimeout(handle),
};

const browserVisibility: PollVisibility = {
  isVisible: () => document.visibilityState === "visible",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/**
 * 하나뿐인 대기 타이머의 수명을 담는다. 예약과 취소가 루프 곳곳에 흩어져 있으면 핸들을
 * 비우는 자리를 한 곳만 빠뜨려도 취소한 줄 알았던 회차가 뒤늦게 한 번 더 돌고, 그
 * 어긋남은 타이밍에 매여 있어 재현하기 어렵다. 핸들은 여기 안에서만 살고, 바깥은
 * "대기 중인가"만 묻는다.
 */
function createPollTimer(timers: PollTimers) {
  let handle: number | null = null;
  const clear = () => {
    if (handle === null) return;
    timers.clearTimer(handle);
    handle = null;
  };
  return {
    pending: () => handle !== null,
    clear,
    /** 이전 예약은 반드시 취소하고 새로 건다. 발사한 핸들은 콜백보다 먼저 비운다. */
    set(callback: () => void, delayMs: number) {
      clear();
      handle = timers.setTimer(() => {
        handle = null;
        callback();
      }, delayMs);
    },
  };
}

/**
 * 자기 클럭 폴링 루프. 한 회차가 끝난 뒤에 다음 회차를 예약하므로 응답이 간격보다
 * 오래 걸려도 요청이 겹치지 않는다. 문서가 보이지 않는 동안에는 타이머를 두지 않고,
 * 다시 보이는 순간 즉시 한 번 갱신한 뒤 주기를 재개한다. 실패는 지수 백오프한다.
 */
export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { intervalMs, run } = options;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_POLL_BACKOFF_MS;
  const timer = createPollTimer(options.timers ?? browserTimers);
  const visibility = options.visibility ?? browserVisibility;

  let started = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let delayMs = intervalMs;
  let unsubscribe: (() => void) | null = null;

  const schedule = (wait: number) => {
    timer.clear();
    if (stopped || !visibility.isVisible()) return;
    timer.set(() => void cycle(), wait);
  };

  /**
   * 한 회차의 실행과 다음 간격 결정. 예약은 여기서 하지 않는다 — 무엇을 기다릴지
   * 정하는 규칙(백오프)과 언제 걸지 정하는 규칙(가시성)이 한 덩어리에 섞여 있으면
   * 어느 쪽을 고쳐도 다른 쪽 경계까지 함께 읽어야 한다.
   */
  const attempt = async () => {
    try {
      await run();
      delayMs = intervalMs;
    } catch {
      // 원격 어댑터의 일시적 실패는 호출자가 이미 처리한다. 여기서는 간격만 늘린다.
      delayMs = Math.min(delayMs * 2, maxBackoffMs);
    }
  };

  const cycle = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    timer.clear();
    const running = attempt().then(() => {
      inFlight = null;
      schedule(delayMs);
    });
    inFlight = running;
    return running;
  };

  const onVisibilityChange = () => {
    if (stopped) return;
    if (visibility.isVisible()) {
      // 백그라운드에서 멈춘 사이 상태가 변했을 수 있으므로 복귀 즉시 한 번 갱신한다.
      if (!inFlight && !timer.pending()) void cycle();
    } else {
      timer.clear();
    }
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      unsubscribe = visibility.subscribe(onVisibilityChange);
      if (visibility.isVisible()) void cycle();
    },
    stop() {
      stopped = true;
      timer.clear();
      unsubscribe?.();
      unsubscribe = null;
    },
    refreshNow() {
      if (stopped) return Promise.resolve();
      return cycle();
    },
  };
}

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
