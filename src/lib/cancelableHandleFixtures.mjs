// 예약 손잡이를 잡고 놓는 가짜 수단. `createCancelableHandle`이 받는 `start`·`stop` 짝을
// 결정적으로 대신해, 시험이 예약을 원하는 순간에 터뜨린다.
//
// 같은 대장이 세 시험에 한 벌씩 다시 적혀 있었다 — 손잡이 시험은 `armed`·`stopped`로,
// 채팅 이벤트 배치는 `callbacks`·`cancelled`로, 재연결 감시는 `timers`로. 셋 다 하는 일은
// 같다(번호를 하나씩 올려 콜백을 담고, 걷으면 지우고, 터뜨릴 때 지운 뒤 부른다). 이름만
// 달라 한 곳에서 규칙을 고쳐도(예: 터뜨린 예약을 걷힌 목록에 넣을지) 나머지 둘은 예전
// 모양으로 남았고, 세 시험이 같은 대장을 본다는 것도 드러나지 않았다.
//
// 예약 수단이 실제로 다른 점(프레임 예약이냐 지연 타이머냐, 지연 값을 함께 기록하느냐)은
// 각 시험이 이 대장을 감싸 자기 모양으로 낸다.

/**
 * 예약 한 벌을 담아 두는 대장 하나를 만든다.
 *
 * - `start(run)` — 새 번호를 붙여 담고 그 번호를 돌려준다.
 * - `stop(handle)` — 예약을 걷고 `stopped`에 그 번호를 남긴다.
 * - `fire(handle?)` — 예약을 대장에서 지운 뒤 부른다(걷힌 것이 아니므로 `stopped`에는
 *   남기지 않는다). 번호를 생략하면 가장 먼저 담긴 예약을 터뜨린다.
 *
 * `start`·`stop`은 닫아 둔 값만 보므로 메서드 참조로 그대로 넘길 수 있다.
 */
export function createHandleRegistry() {
  const handles = new Map();
  const stopped = [];
  let nextHandle = 1;

  return {
    /** 아직 터지지도 걷히지도 않은 예약. 번호 -> 콜백. */
    handles,
    /** 걷힌 예약 번호를 걷힌 순서대로. */
    stopped,
    get pending() {
      return handles.size;
    },
    start(run) {
      const handle = nextHandle++;
      handles.set(handle, run);
      return handle;
    },
    stop(handle) {
      stopped.push(handle);
      handles.delete(handle);
    },
    fire(handle = handles.keys().next().value) {
      const run = handles.get(handle);
      handles.delete(handle);
      run?.();
    },
  };
}
