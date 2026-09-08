import { reconnectNoticeMessage, shouldNoticeReconnectAttempt } from "./chatReconnect.ts";

/**
 * 재연결 감시가 쓰는 브라우저 기능. `createChatEventBatch`의 프레임 스케줄러와 같은 자리로,
 * 테스트는 여기에 결정적인 대역을 끼워 타이머와 화면 복귀를 직접 몰아본다.
 */
export interface ChatReconnectEnvironment {
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
  /** 지금 실패하면 그 원인이 백엔드 쪽이라고 말할 수 있는 상태인지. */
  canReachBackend(): boolean;
  /** 화면 복귀·네트워크 복구 순간을 알린다. 감시를 걷는 함수를 돌려준다. */
  watchResume(onResume: () => void): () => void;
}

export interface ChatReconnectWatch {
  /** 연결이 선 뒤부터 화면 복귀·네트워크 복구를 감시한다. */
  watch(): void;
  /** 다음 재시도를 예약한다. 이미 예약돼 있거나 재시도할 수 없으면 아무 일도 하지 않는다. */
  schedule(): void;
  /** 연결에 성공했으므로 백오프와 실패 집계를 처음으로 되돌린다. */
  reset(): void;
  /**
   * 실패를 한 번 세고, 사용자에게 알릴 차례면 그 문구를 돌려준다. 화면이 백그라운드이거나
   * 기기가 오프라인인 동안의 실패는 백엔드 장애가 아니라 이 기기 상태이므로 알림 집계에
   * 넣지 않는다. 그렇게 세면 잠금 화면 뒤에서 오류 카드가 만들어져, 돌아온 사용자가 이미
   * 끝난 끊김을 현재 상태로 읽는다.
   */
  noteFailure(reason: string): string | null;
  /** 예약된 재시도와 복귀 감시를 함께 걷는다. */
  stop(): void;
}

/** 재시도 간격. 실패가 이어질수록 두 배로 늘리되 15초에서 멈춘다. */
function reconnectDelayMs(attempts: number): number {
  return Math.min(1_000 * 2 ** attempts, 15_000);
}

const browserReconnectEnvironment: ChatReconnectEnvironment = {
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (handle) => window.clearTimeout(handle),
  canReachBackend: () => document.visibilityState === "visible" && navigator.onLine !== false,
  watchResume: (onResume) => {
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
    };
  },
};

/**
 * 한 채팅 연결의 재연결 백오프와 복귀 감시를 맡는다. 연결이 아직 살아 있는지는 호출자만
 * 알 수 있으므로 `canRetry`로 묻고, attach 자체는 `attempt`에 맡긴다. 이 셋(예약 타이머·
 * 시도 횟수·알릴 수 있는 실패 횟수)이 한곳에 모여 있어야 성공·복귀·중단이 각각 무엇을
 * 되돌려야 하는지가 호출부에 흩어지지 않는다.
 */
export function createChatReconnectWatch(
  options: { canRetry(): boolean; attempt(): void },
  environment: ChatReconnectEnvironment = browserReconnectEnvironment,
): ChatReconnectWatch {
  let timer: number | null = null;
  let attempts = 0;
  let reportableFailures = 0;
  let disposeResume: (() => void) | null = null;

  const cancel = () => {
    if (timer !== null) {
      environment.clearTimer(timer);
      timer = null;
    }
  };

  const reset = () => {
    attempts = 0;
    reportableFailures = 0;
  };

  const schedule = () => {
    if (timer !== null || !options.canRetry()) return;
    timer = environment.setTimer(() => {
      timer = null;
      if (!options.canRetry()) return;
      options.attempt();
    }, reconnectDelayMs(attempts));
  };

  /**
   * 화면이 앞으로 돌아오거나 네트워크가 복구된 순간. 백그라운드에서 쌓인 실패와 늘어난
   * 백오프는 더 이상 현재 상태가 아니므로 처음으로 되돌리고 즉시 한 번 더 시도한다.
   * 같은 이벤트가 화면이 뒤로 갈 때도 오므로 도달 가능한 상태에서만 움직이고, 재시도가
   * 이미 진행 중일 때(`timer === null`)는 그 시도가 끝나도록 두어 같은 대화에 소켓 두
   * 개가 동시에 붙지 않게 한다.
   */
  const resume = () => {
    if (timer === null || !options.canRetry()) return;
    if (!environment.canReachBackend()) return;
    cancel();
    reset();
    options.attempt();
  };

  return {
    watch() {
      disposeResume?.();
      disposeResume = environment.watchResume(resume);
    },
    schedule,
    reset,
    noteFailure(reason) {
      attempts += 1;
      if (!environment.canReachBackend()) return null;
      reportableFailures += 1;
      return shouldNoticeReconnectAttempt(reportableFailures)
        ? reconnectNoticeMessage(reportableFailures, reason)
        : null;
    },
    stop() {
      cancel();
      disposeResume?.();
      disposeResume = null;
    },
  };
}
