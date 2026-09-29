import { useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CircleQuestionMark } from "lucide-react";
import { useAnchoredViewportSync, useEscapeToClose, useOutsidePointerToClose } from "./Shared";

const HELP_SHEET_QUERY = "(max-width: 760px)";
const isHelpSheetViewport = () => typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia(HELP_SHEET_QUERY).matches;
// 팝오버와 화면 가장자리 사이에 남겨 둘 여백, 그리고 트리거와의 간격.
const HELP_POPOVER_MARGIN = 12;
const HELP_POPOVER_GAP = 6;

/**
 * 트리거 버튼 옆에 팝오버를 놓을 뷰포트 좌표를 고른다. 아래가 좁으면 위로 뒤집고,
 * 그래도 넘치면 화면 안으로 밀어 넣어 문장 끝이 잘리지 않게 한다.
 */
function helpPopoverPosition(anchor: DOMRect, box: DOMRect) {
  const below = anchor.bottom + HELP_POPOVER_GAP;
  const above = anchor.top - HELP_POPOVER_GAP - box.height;
  const overflowsBelow = below + box.height + HELP_POPOVER_MARGIN > window.innerHeight;
  const top = overflowsBelow && above >= HELP_POPOVER_MARGIN ? above : below;
  const maxTop = Math.max(HELP_POPOVER_MARGIN, window.innerHeight - box.height - HELP_POPOVER_MARGIN);
  const maxLeft = Math.max(HELP_POPOVER_MARGIN, window.innerWidth - box.width - HELP_POPOVER_MARGIN);
  return {
    top: Math.max(HELP_POPOVER_MARGIN, Math.min(top, maxTop)),
    left: Math.max(HELP_POPOVER_MARGIN, Math.min(anchor.left, maxLeft)),
  };
}

/**
 * 도움말 팝오버가 어디에 뜨는지를 정하는 상태 한 벌 — 좁은 화면 판정, 뷰포트 좌표,
 * 그리고 그 둘을 따라가게 하는 구독(미디어 질의·리사이즈·스크롤)까지를 묶는다.
 * HelpHint 본문에서 갈라 두면, 버튼과 팝오버가 무엇을 그리는지 읽을 때 배치 생명주기를
 * 함께 훑지 않아도 되고 배치 규칙을 고칠 자리도 한 곳으로 좁혀진다.
 */
function useHelpPopoverPlacement(open: boolean, rootRef: RefObject<HTMLElement | null>, popoverRef: RefObject<HTMLElement | null>) {
  // 팝오버는 늘 body로 내보낸다. 트리거 자리에 두면 z-index를 가진 조상의 스택 문맥에 갇히고,
  // 무엇보다 .settings-card처럼 overflow: hidden인 카드가 아래로 삐져나온 문장을 잘라 버린다.
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // 좁은 화면에서는 트리거 옆이 아니라 본문 맨 위 하단 시트로 띄운다(위치는 CSS가 정한다).
  const [sheet, setSheet] = useState(isHelpSheetViewport);
  useEffect(() => {
    if (!open || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(HELP_SHEET_QUERY);
    const sync = () => setSheet(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [open]);
  // 좁은 화면(하단 시트)에서는 좌표를 정하지 않는다 — 자리는 CSS가 잡는다.
  const placed = open && !sheet;
  useAnchoredViewportSync(() => {
    const anchor = rootRef.current?.getBoundingClientRect();
    const box = popoverRef.current?.getBoundingClientRect();
    if (anchor && box) setPosition(helpPopoverPosition(anchor, box));
  }, placed);
  useLayoutEffect(() => {
    if (!placed) setPosition(null);
  }, [placed]);
  return { sheet, position };
}

/**
 * 동그라미 물음표 버튼과 상세 설명 팝오버. 화면에 항상 긴 안내를 깔지 않고, 필요한
 * 사람이 눌렀을 때만 동작 설명을 연다. 바깥 클릭과 Esc로 닫는다.
 */
export function HelpHint({ label, title, footer, popoverClassName, children }: PropsWithChildren<{
  label: string;
  title?: ReactNode;
  footer?: ReactNode;
  popoverClassName?: string;
}>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const { sheet, position } = useHelpPopoverPlacement(open, rootRef, popoverRef);
  useEscapeToClose(() => setOpen(false), open);
  // 팝오버가 트리거와 다른 DOM 위치에 있으므로 두 영역을 함께 넘긴다.
  useOutsidePointerToClose(() => setOpen(false), open, [rootRef, popoverRef]);

  const popover = open
    ? <span
        className={`help-hint-popover${popoverClassName ? ` ${popoverClassName}` : ""}`}
        role="note"
        ref={popoverRef}
        // 첫 배치는 팝오버를 실제로 그려 봐야 크기를 알 수 있다. 재는 동안은 숨겨 둔다.
        style={sheet ? undefined : { top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? undefined : "hidden" }}
      >
        {title && <strong>{title}</strong>}
        <small>{children}</small>
        {footer && <span
          className="help-hint-footer"
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest("button")) setOpen(false);
          }}
        >{footer}</span>}
      </span>
    : null;

  return <span className="help-hint" ref={rootRef}>
    <button
      className="help-hint-trigger"
      type="button"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={() => setOpen((current) => !current)}
    >
      <CircleQuestionMark size={14} aria-hidden="true" />
    </button>
    {popover && createPortal(popover, document.body)}
  </span>;
}
