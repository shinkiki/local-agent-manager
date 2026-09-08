import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoveDown, MoveUp } from "lucide-react";
import { uiGuidePointerPlacement, type UiGuideRect } from "../lib/uiGuide";
import { AiaMark, useEscapeToClose } from "./Shared";

/** 사용자가 아무것도 하지 않아도 이 시간이 지나면 안내를 거둔다. */
const UI_GUIDE_TIMEOUT_MS = 15_000;

function sameRect(a: UiGuideRect, b: UiGuideRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/**
 * AIA 화면 안내 포인터. 대상 요소를 감싸는 링과 튕기는 화살표, 짧은 말풍선을 body에 띄운다.
 * 대상 클릭을 막지 않도록 포인터 이벤트를 받지 않으며, Esc·아무 곳 클릭·시간 초과·대상 소멸로 닫힌다.
 */
export function UiGuidePointer({ anchor, note, label, onDismiss }: {
  anchor: Element;
  /** AIA가 보낸 한 문장. 없으면 대상 설명을 대신 보여 준다. */
  note: string | null;
  label: string;
  onDismiss: () => void;
}) {
  const [rect, setRect] = useState<UiGuideRect>(() => anchor.getBoundingClientRect());
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useLayoutEffect(() => {
    const sync = () => {
      if (!anchor.isConnected) {
        onDismiss();
        return;
      }
      const next = anchor.getBoundingClientRect();
      setRect((current) => (sameRect(current, next) ? current : next));
      setViewport((current) => (
        current.width === window.innerWidth && current.height === window.innerHeight
          ? current
          : { width: window.innerWidth, height: window.innerHeight }
      ));
    };
    sync();
    window.addEventListener("resize", sync);
    // 스크롤 컨테이너 안의 대상도 따라가도록 캡처 단계에서 모든 스크롤을 듣는다.
    window.addEventListener("scroll", sync, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    observer?.observe(anchor);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      observer?.disconnect();
    };
  }, [anchor, onDismiss]);

  useEscapeToClose(onDismiss, true);

  useEffect(() => {
    const timer = window.setTimeout(onDismiss, UI_GUIDE_TIMEOUT_MS);
    // 안내를 띄운 바로 그 조작의 pointerdown이 뒤늦게 도착해 닫아 버리지 않도록 다음 틱부터 듣는다.
    const dismiss = () => onDismiss();
    const listen = window.setTimeout(() => document.addEventListener("pointerdown", dismiss), 0);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(listen);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [onDismiss]);

  const placement = uiGuidePointerPlacement(rect, viewport);
  const Arrow = placement.arrow.direction === "down" ? MoveDown : MoveUp;
  return createPortal(
    <div className="ui-guide" role="status" aria-live="polite">
      <div className="ui-guide-ring" style={placement.ring} />
      <div
        className={`ui-guide-arrow ${placement.arrow.direction}`}
        style={{ top: placement.arrow.top, left: placement.arrow.left, width: placement.arrow.size, height: placement.arrow.size }}
      >
        <Arrow size={28} strokeWidth={2.6} aria-hidden="true" />
      </div>
      <div
        className="ui-guide-note"
        style={{
          top: placement.note.top ?? undefined,
          bottom: placement.note.bottom ?? undefined,
          left: placement.note.left,
          width: placement.note.width,
        }}
      >
        <span className="ui-guide-note-avatar" aria-hidden="true"><AiaMark size={15} /></span>
        <span data-user-content>{note ?? label}</span>
      </div>
    </div>,
    document.body,
  );
}
