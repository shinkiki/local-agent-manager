import { useEffect, useRef, useState } from "react";
import { useEscapeToClose } from "./Shared";

/**
 * 버튼 하나로 여는 채팅 팝오버의 닫기 배선.
 *
 * 실행 설정 메뉴와 알림함이 각자 같은 세 가지를 적고 있었다 — 열림 상태, Esc 닫기,
 * 바깥을 눌렀을 때 닫기. 세 번째가 특히 손으로 옮겨 적기 쉬운 자리다. 리스너는 열려
 * 있을 때만 걸어야 하고(닫힌 팝오버가 전역 포인터 이벤트를 계속 받으면 안 된다),
 * 판정 기준은 팝오버 버튼까지 감싼 바깥 상자여야 한다(버튼만 빼면 버튼을 누르는 순간
 * 바깥으로 판정돼 열자마자 닫힌다). 그 두 조건을 한곳에서 지키게 모은다.
 *
 * 반환한 `rootRef`는 여는 버튼과 패널을 모두 감싸는 요소에 걸어야 한다.
 */
export function useDismissablePopover<Root extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<Root | null>(null);
  useEscapeToClose(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  return { open, setOpen, rootRef };
}
