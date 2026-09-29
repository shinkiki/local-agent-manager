import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoveDown, MoveUp } from "lucide-react";
import { uiGuidePointerPlacement, type UiGuideRect } from "../lib/uiGuide";
import { AiaMark, useAnchoredViewportSync, useEscapeToClose } from "./Shared";

function sameRect(a: UiGuideRect, b: UiGuideRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/**
 * AIA 화면 안내 포인터. 대상 요소를 감싸는 링과 튕기는 화살표, 짧은 말풍선을 body에 띄운다.
 * 대상 클릭을 막지 않도록 포인터 이벤트를 받지 않으며, Esc·아무 곳 클릭·대상 소멸로 닫힌다.
 * 시간이 지나서 저절로 사라지지는 않는다. 안내를 본 사용자가 실제로 조작할 때까지 남아 있어야 한다.
 */
export function UiGuidePointer({ anchor, requestId, note, label, onDismiss }: {
  anchor: Element;
  /** 이 안내의 일련번호. 거두기를 부를 때 함께 넘겨 남의 안내를 지우지 않는다(QA #67). */
  requestId: number;
  /** AIA가 보낸 한 문장. 없으면 대상 설명을 대신 보여 준다. */
  note: string | null;
  label: string;
  onDismiss: (requestId: number) => void;
}) {
  // 이 포인터가 거두는 것은 언제나 자기 안내다. 대상이 DOM에서 빠졌다는 늦은 알림이
  // 그사이 새로 선 안내까지 지우지 않도록 번호를 함께 넘긴다.
  const dismiss = useCallback(() => onDismiss(requestId), [onDismiss, requestId]);
  const [rect, setRect] = useState<UiGuideRect>(() => anchor.getBoundingClientRect());
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useAnchoredViewportSync(() => {
    if (!anchor.isConnected) {
      dismiss();
      return;
    }
    const next = anchor.getBoundingClientRect();
    setRect((current) => (sameRect(current, next) ? current : next));
    setViewport((current) => (
      current.width === window.innerWidth && current.height === window.innerHeight
        ? current
        : { width: window.innerWidth, height: window.innerHeight }
    ));
  }, true, anchor);

  useEscapeToClose(dismiss, true);

  useEffect(() => {
    // 안내를 띄운 바로 그 조작의 pointerdown이 뒤늦게 도착해 닫아 버리지 않도록 다음 틱부터 듣는다.
    const listen = window.setTimeout(() => document.addEventListener("pointerdown", dismiss), 0);
    return () => {
      window.clearTimeout(listen);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [dismiss]);

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
          // QA #66. 긴 안내는 화살표 위로 자라 뷰포트를 넘었고, 잘려 나가는 쪽이 문장의
          // 앞부분이라 무슨 안내인지조차 읽을 수 없었다. 남은 공간까지만 자라고 넘치면
          // 말풍선 안에서 스크롤한다.
          maxHeight: placement.note.maxHeight,
        }}
      >
        <span className="ui-guide-note-avatar" aria-hidden="true"><AiaMark size={15} /></span>
        <span data-user-content>{note ?? label}</span>
      </div>
    </div>,
    document.body,
  );
}
