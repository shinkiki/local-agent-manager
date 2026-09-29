/**
 * 자기 클럭 폴링 루프 — 한 회차의 실행, 다음 간격 결정, 문서 가시성에 따른 예약.
 *
 * 화면이 이 루프를 쓰는 방법(`poll`의 훅)과 한 파일에 있었지만 둘이 바뀌는 이유는 다르다.
 * 여기 있는 것은 루프 하나의 수명 동안 지켜야 하는 불변식이라 백오프 규칙이나 가시성
 * 복귀 규칙이 달라질 때 손대고, 훅 쪽은 어느 화면이 언제 루프를 만들고 버리는가라 렌더
 * 규칙이 달라질 때 손댄다. 훅 하나를 고치러 들어온 사람이 예약 핸들을 비우는 자리까지
 * 함께 읽을 필요는 없다.
 *
 * React를 가져오지 않는 것이 이 경계의 표시다. 그 덕에 루프는 타이머·가시성을 주입한
 * node 시험으로 그대로 확인되고, 훅은 루프를 만들어 붙이는 일만 남는다 — 저장소와 훅을
 * 가른 `providerOptionsStore`/`providerOptions`와 같은 경계다.
 */

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

type PollLifecycle = "idle" | "running" | "stopped";

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
 * 다음 회차까지 기다릴 길이를 정하는 규칙만 담는다. 성공하면 기본 간격으로 돌아가고,
 * 실패하면 상한까지 두 배씩 늘린다.
 *
 * 이 값은 루프 변수 하나로 두면 세 자리에서 읽고 쓰인다 — 초기화, 성공·실패 갈래, 그리고
 * 예약할 때. 바로 위 `createPollTimer`와 같은 이유로 가른다: 늘리는 자리와 되돌리는 자리가
 * 흩어져 있으면 한 곳을 빠뜨렸을 때 실패가 그친 뒤에도 간격이 상한에 붙어 있게 되고,
 * 그 어긋남은 타이밍에 매여 있어 눈으로 찾기 어렵다. 바깥은 "다음에 얼마를 기다리나"만
 * 묻고, 그 답이 어떻게 변하는지는 여기 안에서만 산다.
 */
function createPollBackoff(intervalMs: number, maxBackoffMs: number) {
  let delayMs = intervalMs;
  return {
    next: () => delayMs,
    succeeded: () => { delayMs = intervalMs; },
    failed: () => { delayMs = Math.min(delayMs * 2, maxBackoffMs); },
  };
}

/**
 * 자기 클럭 폴링 루프. 한 회차가 끝난 뒤에 다음 회차를 예약하므로 응답이 간격보다
 * 오래 걸려도 요청이 겹치지 않는다. 문서가 보이지 않는 동안에는 타이머를 두지 않고,
 * 다시 보이는 순간 즉시 한 번 갱신한 뒤 주기를 재개한다. 실패는 지수 백오프한다.
 */
export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { intervalMs, run } = options;
  const timer = createPollTimer(options.timers ?? browserTimers);
  const backoff = createPollBackoff(intervalMs, options.maxBackoffMs ?? DEFAULT_MAX_POLL_BACKOFF_MS);
  const visibility = options.visibility ?? browserVisibility;

  let lifecycle: PollLifecycle = "idle";
  let inFlight: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;

  const schedule = (wait: number) => {
    timer.clear();
    if (lifecycle === "stopped" || !visibility.isVisible()) return;
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
      backoff.succeeded();
    } catch {
      // 원격 어댑터의 일시적 실패는 호출자가 이미 처리한다. 여기서는 간격만 늘린다.
      backoff.failed();
    }
  };

  const cycle = (): Promise<void> => {
    if (lifecycle === "stopped") return Promise.resolve();
    if (inFlight) return inFlight;
    timer.clear();
    const running = attempt().then(() => {
      inFlight = null;
      schedule(backoff.next());
    });
    inFlight = running;
    return running;
  };

  const onVisibilityChange = () => {
    if (lifecycle === "stopped") return;
    if (visibility.isVisible()) {
      // 백그라운드에서 멈춘 사이 상태가 변했을 수 있으므로 복귀 즉시 한 번 갱신한다.
      if (!inFlight && !timer.pending()) void cycle();
    } else {
      timer.clear();
    }
  };

  return {
    start() {
      if (lifecycle !== "idle") return;
      lifecycle = "running";
      unsubscribe = visibility.subscribe(onVisibilityChange);
      if (visibility.isVisible()) void cycle();
    },
    stop() {
      lifecycle = "stopped";
      timer.clear();
      unsubscribe?.();
      unsubscribe = null;
    },
    refreshNow() {
      if (lifecycle === "stopped") return Promise.resolve();
      return cycle();
    },
  };
}
