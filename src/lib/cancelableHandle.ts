/**
 * 한 번에 한 건만 잡아 두는 예약 손잡이. 예약을 거는 쪽(`arm`)과 걷는 쪽(`cancel`)이 늘
 * "손잡이가 비어 있는지 먼저 보고, 잡거나 걷은 뒤 손잡이를 그 반대로 맞춘다"는 같은 짝을
 * 들고 다닌다.
 *
 * 그 짝이 채팅 이벤트 배치(프레임 예약)와 재연결 감시(재시도 타이머)에 한 벌씩 따로
 * 적혀 있었다. 두 곳 다 "손잡이 비우기를 빠뜨리면 조용히 어긋난다"는 같은 이유로 각자
 * 자기 모듈 안에서 한 번씩 모아 둔 상태였는데, 모아 둔 자리가 둘이라 한쪽에서 규칙을
 * 고쳐도 나머지는 그대로 남는다(예: 걷은 뒤에도 예약이 남았다고 보고 다시 걸지 않는 식).
 *
 * 예약 수단은 두 곳이 다르다(`requestAnimationFrame`과 지연 타이머). 다른 것은 손잡이를
 * 잡고 놓는 방법뿐이므로 그 둘만 받고, 손잡이 상태를 다루는 규칙은 여기서만 정한다.
 * 지연처럼 예약할 때마다 달라지는 값은 `start`를 만드는 쪽이 닫아 두면 되므로 받지 않는다.
 */
interface CancelableHandle {
  /** 아직 터지지 않은 예약이 걸려 있는지. */
  pending(): boolean;
  /** 예약이 없을 때만 새로 건다. 이미 걸려 있으면 그 예약을 그대로 둔다. */
  arm(run: () => void): void;
  /** 걸린 예약을 걷는다. 없으면 아무 일도 하지 않는다. */
  cancel(): void;
}

export function createCancelableHandle(
  start: (run: () => void) => number,
  stop: (handle: number) => void,
): CancelableHandle {
  let handle: number | null = null;

  return {
    pending: () => handle !== null,
    arm(run) {
      if (handle !== null) return;
      // 손잡이는 실행 직전에 비운다. 실행 중에 같은 손잡이로 다시 예약을 걸 수 있어야 하고,
      // 이미 터진 예약을 나중에 걷으려 드는 일도 없어야 한다.
      handle = start(() => {
        handle = null;
        run();
      });
    },
    cancel() {
      if (handle === null) return;
      stop(handle);
      handle = null;
    },
  };
}
