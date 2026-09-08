import { createPortal } from "react-dom";
import { MousePointer2 } from "lucide-react";
import { AiaMark } from "./Shared";

export interface UiCursorState {
  x: number;
  y: number;
  /** 대상에 닿아 누르는 순간. 아이콘이 살짝 작아진다. */
  pressing: boolean;
}

/**
 * 아이아 커서. 요소를 눌러 달라는 요청이 오면 마지막 위치에서 대상까지 미끄러져 가서 누른다.
 * 화면 조작을 막지 않도록 포인터 이벤트를 받지 않고, 이동은 CSS transition에 맡긴다.
 */
export function UiCursor({ state }: { state: UiCursorState }) {
  return createPortal(
    <div
      className={`ui-cursor${state.pressing ? " pressing" : ""}`}
      style={{ transform: `translate(${Math.round(state.x)}px, ${Math.round(state.y)}px)` }}
      aria-hidden="true"
    >
      <span className="ui-cursor-icon"><MousePointer2 size={26} strokeWidth={2} /></span>
      <span className="ui-cursor-badge"><AiaMark size={13} /></span>
    </div>,
    document.body,
  );
}
