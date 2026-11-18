import { errorText } from "./errorText.ts";

/**
 * "마지막 요청만 반영한다"는 문. `begin()`이 돌려준 확인 함수는 다음 `begin()`이 불리기
 * 전까지만 참이다. 같은 읽기를 효과와 버튼이 함께 부르는 자리처럼, 효과 정리(cleanup)
 * 깃발로는 앞선 호출을 무효로 만들 수 없는 곳에서 늦게 도착한 응답을 버리는 데 쓴다.
 */
export interface LatestGate {
  begin(): () => boolean;
}

export function createLatestGate(): LatestGate {
  let current = 0;
  return {
    begin() {
      current += 1;
      const mine = current;
      return () => mine === current;
    },
  };
}

export interface RequestGeneration {
  /** 지금까지의 요청을 모두 무효로 하고 새 세대를 열어 그 번호를 돌려준다. */
  open: () => number;
  /** 지금 세대. 이미 열려 있는 세대에 얹는 후속 요청(더 보기·하위 폴더)이 쓴다. */
  current: () => number;
  /**
   * 한 요청을 끝까지 지킨다. 응답을 기다리는 동안 세대가 바뀌었으면 성공·실패·뒷정리
   * 어느 것도 하지 않는다.
   */
  latest: <T>(
    generation: number,
    work: () => Promise<T>,
    handlers: LatestRequestHandlers<T>,
  ) => Promise<void>;
}

/** `latest`가 최신 요청일 때만 부르는 세 자리. */
export interface LatestRequestHandlers<T> {
  /** 최신 응답이 도착했을 때. */
  onResult: (value: T) => void;
  /** 최신 요청이 실패했을 때. 오류 문구는 여기 닿기 전에 이미 풀어 둔다. */
  onError: (message: string) => void;
  /** 성공·실패와 무관한 뒷정리(진행 표시 끄기). 늦게 온 응답에서는 부르지 않는다. */
  onSettled?: () => void;
}

/**
 * V4. 숫자 세대를 공유하는 트리 페이징과 후속 조회용 요청 문.
 * 각 콜백 직전에 세대를 다시 검사해 콜백이 연 다음 요청의 상태도 지킨다.
 */
export function createRequestGeneration(): RequestGeneration {
  let current = 0;
  const isCurrent = (generation: number) => generation === current;
  return {
    open: () => ++current,
    current: () => current,
    latest: async <T>(
      generation: number,
      work: () => Promise<T>,
      { onResult, onError, onSettled }: LatestRequestHandlers<T>,
    ) => {
      try {
        const value = await work();
        if (isCurrent(generation)) onResult(value);
      } catch (cause) {
        if (isCurrent(generation)) onError(errorText(cause));
      } finally {
        if (isCurrent(generation)) onSettled?.();
      }
    },
  };
}
