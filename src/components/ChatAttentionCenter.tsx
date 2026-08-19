import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bell, BellOff, BellRing, CheckCheck, CircleAlert, CircleCheck, LoaderCircle, ShieldAlert, Trash2 } from "lucide-react";
import { formatRelative } from "../lib/format";
import {
  disableWebNotifications,
  enableWebNotifications,
  webNotificationsDenied,
  webNotificationsEnabled,
  webNotificationsSupported,
} from "../lib/webNotifications";
import type { ChatAttentionItem, ChatAttentionSnapshot, SessionSummary } from "../types";
import { SourceBadge } from "./Shared";

const SWIPE_ACTIVATE_PX = 9;

function AttentionSwipeItem({
  className,
  dismissable,
  onOpen,
  onDismiss,
  children,
}: {
  className: string;
  dismissable: boolean;
  onOpen: () => void;
  onDismiss: () => Promise<boolean>;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; width: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dismissable || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.offsetWidth,
      active: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      drag.current = null;
      return;
    }
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.active) {
      // 세로 이동이 먼저면 목록 스크롤 제스처로 보고 스와이프 추적을 중단한다.
      if (Math.abs(dy) > SWIPE_ACTIVATE_PX && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      if (dx > -SWIPE_ACTIVATE_PX) return;
      state.active = true;
      setSwiping(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setOffset(Math.min(0, dx));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!state.active) return;
    setSwiping(false);
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    const dx = event.clientX - state.startX;
    if (-dx >= Math.min(120, state.width * 0.34)) {
      setOffset(-state.width);
      void onDismiss().then((removed) => {
        if (!removed) setOffset(0);
      });
    } else {
      setOffset(0);
    }
  };

  const handlePointerCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    setSwiping(false);
    setOffset(0);
  };

  const handleClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onOpen();
  };

  return (
    <div
      className={className}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {dismissable && <div
        className="attention-swipe-under"
        style={{ width: Math.max(1, -offset), transition: swiping ? "none" : undefined }}
        aria-hidden="true"
      >
        <Trash2 size={15} />
      </div>}
      <button
        className="attention-open"
        type="button"
        onClick={handleClick}
        style={offset ? { transform: `translateX(${offset}px)`, transition: swiping ? "none" : undefined } : undefined}
      >
        {children}
      </button>
    </div>
  );
}

export function ChatAttentionCenter({
  snapshot,
  sessions,
  onOpen,
  onMarkAllRead,
  onClearRead,
  onDismiss,
}: {
  snapshot: ChatAttentionSnapshot;
  sessions: SessionSummary[];
  onOpen: (item: ChatAttentionItem) => void;
  onMarkAllRead: () => void;
  onClearRead: () => void;
  onDismiss: (item: ChatAttentionItem) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [deviceNotifications, setDeviceNotifications] = useState(webNotificationsEnabled);
  const rootRef = useRef<HTMLDivElement>(null);

  // 페이지 재로드·권한 변경 등으로 상태가 어긋날 수 있어 열 때마다 실제 값으로 맞춘다.
  useEffect(() => {
    if (open) setDeviceNotifications(webNotificationsEnabled());
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const openItem = (item: ChatAttentionItem) => {
    setOpen(false);
    onOpen(item);
  };

  return (
    <div className="attention-center" ref={rootRef}>
      <button
        className={`attention-trigger${deviceNotifications ? " active" : ""}`}
        type="button"
        aria-label={`알림 ${snapshot.unreadCount}개`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Bell size={17} aria-hidden="true" />
        {snapshot.unreadCount > 0 && <span>{snapshot.unreadCount > 99 ? "99+" : snapshot.unreadCount}</span>}
      </button>
      {open && <section className="attention-popover" aria-label="에이전트 알림">
        <header>
          <div className="attention-heading"><strong>알림</strong><span>{snapshot.pendingCount > 0 ? `확인 필요 ${snapshot.pendingCount}개` : "새 확인사항"}</span></div>
          <div className="attention-header-actions">
            {webNotificationsSupported() && (webNotificationsDenied()
              ? <button type="button" disabled title="브라우저 설정에서 이 사이트의 알림을 허용해야 합니다"><BellOff size={13} />기기 알림 차단됨</button>
              : deviceNotifications
                ? <button type="button" aria-pressed={true} title="눌러서 이 기기의 OS 알림 끄기" onClick={() => { disableWebNotifications(); setDeviceNotifications(false); }}><BellRing size={13} />기기 알림 켜짐</button>
                : <button type="button" aria-pressed={false} title="눌러서 이 기기의 OS 알림 켜기" onClick={() => { void enableWebNotifications().then(setDeviceNotifications); }}><BellOff size={13} />기기 알림 꺼짐</button>)}
            {snapshot.items.some((item) => item.read && (item.kind === "completed" || item.kind === "failed")) && <button type="button" aria-label="읽은 알림 전체 삭제" title="읽은 알림 전체 삭제" onClick={onClearRead}><Trash2 size={13} />읽음 전체삭제</button>}
            {snapshot.items.some((item) => item.kind !== "approval" && !item.read) && <button type="button" onClick={onMarkAllRead}><CheckCheck size={13} />모두 읽음</button>}
          </div>
        </header>
        <div className="attention-list">
          {snapshot.items.length === 0 ? <div className="attention-empty"><Bell size={20} /><span>새 알림이 없습니다.</span></div> : snapshot.items.map((item) => {
            const session = item.providerSessionId
              ? sessions.find((candidate) => candidate.source === item.source && candidate.id === item.providerSessionId)
              : null;
            const pathParts = item.cwd.split(/[\\/]/).filter(Boolean);
            const fallbackTitle = pathParts[pathParts.length - 1] ?? item.source;
            const Icon = item.kind === "approval" ? ShieldAlert : item.kind === "running" ? LoaderCircle : item.kind === "completed" ? CircleCheck : CircleAlert;
            return <AttentionSwipeItem
              key={item.id}
              className={`attention-item attention-item-${item.kind}${!item.read || item.kind === "approval" ? " unread" : ""}`}
              dismissable={item.kind !== "approval"}
              onOpen={() => openItem(item)}
              onDismiss={() => onDismiss(item)}
            >
              <span className="attention-kind"><Icon className={item.kind === "running" ? "spin" : undefined} size={15} aria-hidden="true" /></span>
              <span className="attention-copy">
                <span className="attention-item-title"><strong>{item.title}</strong><time>{formatRelative(item.createdAt)}</time></span>
                <span className="attention-session"><SourceBadge source={item.source} /><span>{session?.title ?? fallbackTitle}</span></span>
                {item.kind === "approval" && item.detail && <small>{item.detail}</small>}
              </span>
            </AttentionSwipeItem>;
          })}
        </div>
      </section>}
    </div>
  );
}
