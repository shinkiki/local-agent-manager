/**
 * 렌더를 기다리지 않고 최신 값을 읽어야 하는 채팅 화면의 상태.
 *
 * 이벤트 처리기와 전송 절차는 ref를 읽고 화면은 state를 읽으므로 값 하나를 두 그릇에
 * 담는다. 그래서 "ref에 넣고 state에 넣는" 두 줄짜리 손잡이가 값마다 따로 선언되고,
 * 선언(useState)과 그릇(useRef)과 손잡이(useCallback)가 파일의 서로 다른 세 자리에
 * 나뉘어 있었다. 어느 한 벌에서 한 줄이 빠지면 화면과 절차가 다른 값을 보게 되므로,
 * 세 자리를 한 선언으로 묶는다.
 *
 * 채팅 화면과 AIA 팝업이 같은 짝을 각자 적고 있었기에 ChatView 안에 있던 이 손잡이를
 * 두 화면이 함께 읽는 자리로 옮긴다.
 */
import { useCallback, useRef, useState } from "react";

/**
 * 네 번째로 돌려주는 setter는 ref를 건드리지 않던 기존 호출자 몫으로 그대로 남긴다.
 * 그 setter로 값을 바꾸면 ref는 다음 렌더까지 예전 값을 들고 있으므로, 쓰는 쪽이
 * 그 시차를 감당할 수 있을 때만 쓴다.
 */
export function useMirroredState<T>(initial: T) {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(initial);
  const put = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, put, setValue] as const;
}
