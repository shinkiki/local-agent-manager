import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useEscapeToClose, useOutsidePointerToClose } from "./Shared";

/** 메뉴가 화면 밖으로 밀려 나지 않게 남기는 여백. */
const CONTEXT_MENU_MARGIN = 8;

/** 메뉴 안에서 초점을 받을 수 있는 항목. 접기·펴기 없이 버튼만 늘어서는 메뉴다. */
const CONTEXT_MENU_ITEMS = "button:not(:disabled)";

/**
 * 우클릭 메뉴가 뜬 자리에 눌러앉기 위한 거동 한 벌 — 화면 안으로 접어 넣는 위치, 첫 항목
 * 초점, 닫는 네 경로(Esc · 바깥 눌림 · 뒤쪽 화면 스크롤 · 창 크기 변경), 방향키 초점 이동.
 * 이 다섯은 메뉴가 그리는 내용과 무관하게 "떠 있는 메뉴라면 늘 같은" 규칙인데 마크업과 한
 * 몸으로 붙어 있어, 항목을 늘리거나 문구를 고치는 변경이 매번 이 규칙들을 헤집고 지나가야
 * 했다. 규칙은 여기 두고, 컴포넌트는 붙일 손잡이 셋만 받는다.
 *
 * 세션 목록 한 곳에서만 쓰던 것을 파일 화면 트리의 우클릭 메뉴도 함께 쓰게 되어 따로 낸다.
 */
export function useContextMenuPopup(anchorX: number, anchorY: number, onClose: () => void): {
  menuRef: RefObject<HTMLDivElement | null>;
  position: { left: number; top: number };
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
} {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: anchorX, top: anchorY });

  useEscapeToClose(onClose);
  useOutsidePointerToClose(onClose, true, [menuRef]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = CONTEXT_MENU_MARGIN;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(margin, Math.min(anchorX, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(anchorY, window.innerHeight - rect.height - margin)),
    });
    menu.querySelector<HTMLButtonElement>(CONTEXT_MENU_ITEMS)?.focus();
  }, [anchorX, anchorY]);

  useEffect(() => {
    const closeOnOutsideScroll = (event: Event) => {
      const target = event.target;
      // scroll은 버블링하지 않지만 캡처 단계에서는 메뉴 내부 목록의 스크롤도 window에
      // 도달한다. 폴더를 훑는 정상 동작은 유지하고, 뒤쪽 화면이 움직일 때만 닫는다.
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", closeOnOutsideScroll, true);
    return () => {
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", closeOnOutsideScroll, true);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(CONTEXT_MENU_ITEMS) ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return { menuRef, position, onKeyDown };
}
