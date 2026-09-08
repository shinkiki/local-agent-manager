import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeftRight, Bell, BellOff, BellRing, CheckCheck, ChevronDown, CircleAlert, CircleCheck, LoaderCircle, ShieldAlert, Trash2 } from "lucide-react";
import { attentionFolderName, attentionFolderSummary, groupAttentionItems, type AttentionGroup } from "../lib/attentionGroups";
import { formatRelative } from "../lib/format";
import { useI18n } from "../lib/i18n";
import {
  disableWebNotifications,
  enableWebNotifications,
  webNotificationsDenied,
  webNotificationsEnabled,
  webNotificationsSupported,
} from "../lib/webNotifications";
import type { ChatAttentionItem, ChatAttentionSnapshot, SessionSummary } from "../types";
import { SourceBadge, useEscapeToClose } from "./Shared";

const SWIPE_ACTIVATE_PX = 9;

function Icon({ kind }: { kind: ChatAttentionItem["kind"] }) {
  const Glyph = kind === "approval" ? ShieldAlert
    : kind === "running" ? LoaderCircle
      : kind === "completed" ? CircleCheck
        : kind === "accountSwitch" ? ArrowLeftRight
          : CircleAlert;
  return <Glyph className={kind === "running" ? "spin" : undefined} size={15} aria-hidden="true" />;
}

/**
 * 접힌 묶음의 둘째 줄. 무엇이 묶였는지를 먼저 말한다 — 한 대화가 쌓은 알림이면 그
 * 대화 이름, 반복 요청·워크플로 회차면 어느 갈래에서 왔는지를 알려 주는 작업 경로다.
 */
function groupSubtitle(group: AttentionGroup, sessions: SessionSummary[], text: (ko: string, en: string) => string): string {
  if (group.reason === "account") return group.lead.detail ?? "";
  if (group.reason === "chat") {
    const session = group.lead.providerSessionId
      ? sessions.find((candidate) => candidate.source === group.lead.source && candidate.id === group.lead.providerSessionId)
      : null;
    return session?.title ?? (attentionFolderName(group.lead.cwd) || group.lead.source);
  }
  const label = group.reason === "schedule" ? text("반복 회차", "Recurring run") : text("워크플로", "Workflow");
  // "외 N곳"은 수와 단위를 한 문장으로 만든다. 따로 그리면 영어 화면에서 "2items"처럼 붙는다.
  const folders = attentionFolderSummary(group.folders, (count) => text(`외 ${count}곳`, `and ${count} more`));
  return folders ? `${label} · ${folders}` : label;
}

/**
 * 묶음 머리줄의 건수. 언어별로 통째 문장을 지어 하나의 텍스트 노드로 그린다 — 숫자와
 * 단위를 따로 그리면 정적 치환기가 "건"만 "items"로 바꿔 "3items"가 된다.
 */
function groupCountLabel(group: AttentionGroup, text: (ko: string, en: string) => string): string {
  const total = group.items.length;
  const partiallyUnread = group.unreadCount > 0 && group.unreadCount < total;
  if (partiallyUnread) {
    return text(`${total}건 · 안읽음 ${group.unreadCount}`, `${total} items · ${group.unreadCount} unread`);
  }
  return text(`${total}건`, `${total} items`);
}

function AttentionSwipeItem({
  className,
  dismissable,
  expanded,
  onOpen,
  onDismiss,
  children,
}: {
  className: string;
  dismissable: boolean;
  /** 묶음 머리줄에서만 준다. 누르면 열리는 대신 펼쳐지므로 그 상태를 읽어 준다. */
  expanded?: boolean;
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
        aria-expanded={expanded}
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
  onDismiss: (items: ChatAttentionItem[]) => Promise<boolean>;
}) {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [deviceNotifications, setDeviceNotifications] = useState(webNotificationsEnabled);
  const [deviceFlash, setDeviceFlash] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | null>(null);

  // 기기 알림 상태는 아이콘으로만 두고, 사용자가 바꾼 순간에만 글자를 잠깐 띄운다.
  const flashDeviceState = (label: string) => {
    setDeviceFlash(label);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => { flashTimer.current = null; setDeviceFlash(null); }, 1800);
  };
  useEffect(() => () => { if (flashTimer.current !== null) window.clearTimeout(flashTimer.current); }, []);

  // 페이지 재로드·권한 변경 등으로 상태가 어긋날 수 있어 열 때마다 실제 값으로 맞춘다.
  useEffect(() => {
    if (open) setDeviceNotifications(webNotificationsEnabled());
    else {
      setDeviceFlash(null);
      // 닫으면 펼친 묶음도 함께 접는다. 다시 열었을 때 지난번에 펼쳐 둔 회차가 그대로
      // 쏟아져 있으면 묶어 놓은 뜻이 없다.
      setExpandedGroups([]);
    }
  }, [open]);

  useEscapeToClose(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const openItem = (item: ChatAttentionItem) => {
    setOpen(false);
    onOpen(item);
  };

  const groups = groupAttentionItems(snapshot.items);

  const renderItem = (item: ChatAttentionItem, nested: boolean) => {
    const session = item.providerSessionId
      ? sessions.find((candidate) => candidate.source === item.source && candidate.id === item.providerSessionId)
      : null;
    const fallbackTitle = attentionFolderName(item.cwd) || item.source;
    // 계정 전환은 세션이 없어 둘째 줄에 "A → B · 사유" 전환 문구를 대신 보인다.
    const secondLine = item.kind === "accountSwitch" ? item.detail ?? "" : session?.title ?? fallbackTitle;
    return <AttentionSwipeItem
      key={item.id}
      className={`attention-item attention-item-${item.kind}${!item.read || item.kind === "approval" ? " unread" : ""}${nested ? " attention-item-nested" : ""}`}
      dismissable={item.kind !== "approval"}
      onOpen={() => openItem(item)}
      onDismiss={() => onDismiss([item])}
    >
      <span className="attention-kind"><Icon kind={item.kind} /></span>
      <span className="attention-copy">
        <span className="attention-item-title"><strong>{item.title}</strong><time>{formatRelative(item.createdAt)}</time></span>
        <span className="attention-session"><SourceBadge source={item.source} /><span>{secondLine}</span></span>
        {item.kind === "approval" && item.detail && <small>{item.detail}</small>}
      </span>
    </AttentionSwipeItem>;
  };

  /**
   * 묶음 머리줄. 누르면 알림을 여는 대신 펼쳐지고, 스와이프는 묶음에 든 알림을 한꺼번에
   * 지운다. 승인 대기 묶음은 서버가 개별 삭제를 거절하므로 스와이프도 열어 두지 않는다.
   */
  const renderGroup = (group: AttentionGroup) => {
    const expanded = expandedGroups.includes(group.key);
    return <div className="attention-group" key={group.key}>
      <AttentionSwipeItem
        className={`attention-item attention-item-${group.lead.kind} attention-group-head${group.unreadCount > 0 ? " unread" : ""}`}
        dismissable={group.dismissable}
        expanded={expanded}
        onOpen={() => setExpandedGroups((current) =>
          current.includes(group.key) ? current.filter((key) => key !== group.key) : [...current, group.key])}
        onDismiss={() => onDismiss(group.items)}
      >
        <span className="attention-kind"><Icon kind={group.lead.kind} /></span>
        <span className="attention-copy">
          <span className="attention-item-title">
            <strong>{group.lead.title}</strong>
            <em className="attention-group-count">{groupCountLabel(group, text)}</em>
            <time>{formatRelative(group.lead.createdAt)}</time>
          </span>
          <span className="attention-session">
            <SourceBadge source={group.lead.source} />
            <span className="attention-group-sub">{groupSubtitle(group, sessions, text)}</span>
            <ChevronDown className={`attention-group-chevron${expanded ? " open" : ""}`} size={14} aria-hidden="true" />
          </span>
        </span>
      </AttentionSwipeItem>
      {expanded && group.items.map((item) => renderItem(item, true))}
    </div>;
  };

  return (
    <div className="attention-center" ref={rootRef}>
      <button
        className={`attention-trigger${deviceNotifications ? " active" : ""}`}
        type="button"
        data-ui-anchor="topbar.attention"
        aria-label={text(`알림 ${snapshot.unreadCount}개`, `${snapshot.unreadCount} notifications`)}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Bell size={17} aria-hidden="true" />
        {snapshot.unreadCount > 0 && <span>{snapshot.unreadCount > 99 ? "99+" : snapshot.unreadCount}</span>}
      </button>
      {open && <section className="attention-popover" aria-label={text("에이전트 알림", "Agent notifications")}>
        <header>
          <div className="attention-heading">
            {webNotificationsSupported() && <span className="attention-device">
              {webNotificationsDenied()
                ? <button className="attention-device-toggle" type="button" disabled aria-label={text("기기 알림 차단됨", "Device notifications blocked")} title={text("브라우저 설정에서 이 사이트의 알림을 허용해야 합니다", "Allow notifications for this site in your browser settings")}><BellOff size={19} /></button>
                : deviceNotifications
                  ? <button className="attention-device-toggle" type="button" aria-pressed={true} aria-label={text("기기 알림 켜짐", "Device notifications on")} title={text("눌러서 이 기기의 OS 알림 끄기", "Click to turn off OS notifications on this device")} onClick={() => { disableWebNotifications(); setDeviceNotifications(false); flashDeviceState(text("기기 알림 꺼짐", "Device notifications off")); }}><BellRing size={19} /></button>
                  : <button className="attention-device-toggle" type="button" aria-pressed={false} aria-label={text("기기 알림 꺼짐", "Device notifications off")} title={text("눌러서 이 기기의 OS 알림 켜기", "Click to turn on OS notifications on this device")} onClick={() => { void enableWebNotifications().then((enabled) => { setDeviceNotifications(enabled); flashDeviceState(enabled ? text("기기 알림 켜짐", "Device notifications on") : text("기기 알림 차단됨", "Device notifications blocked")); }); }}><BellOff size={19} /></button>}
              {deviceFlash && <em className="attention-device-flash" role="status">{deviceFlash}</em>}
            </span>}
            <div className="attention-heading-text">
              <strong>{text("알림", "Notifications")}</strong>
              <span>{snapshot.pendingCount > 0 ? text(`확인 필요 ${snapshot.pendingCount}개`, `${snapshot.pendingCount} need attention`) : text("새 확인사항", "Nothing new")}</span>
            </div>
          </div>
          <div className="attention-header-actions">
            {snapshot.items.some((item) => item.read && (item.kind === "completed" || item.kind === "failed" || item.kind === "accountSwitch")) && <button type="button" aria-label={text("읽은 알림 전체 삭제", "Delete all read notifications")} title={text("읽은 알림 전체 삭제", "Delete all read notifications")} onClick={onClearRead}><Trash2 size={13} />{text("읽음 전체삭제", "Clear read")}</button>}
            {snapshot.items.some((item) => item.kind !== "approval" && !item.read) && <button type="button" onClick={onMarkAllRead}><CheckCheck size={13} />{text("모두 읽음", "Mark all read")}</button>}
          </div>
        </header>
        <div className="attention-list">
          {groups.length === 0
            ? <div className="attention-empty"><Bell size={20} /><span>{text("새 알림이 없습니다.", "No new notifications.")}</span></div>
            : groups.map((group) => group.items.length === 1 ? renderItem(group.lead, false) : renderGroup(group))}
        </div>
      </section>}
    </div>
  );
}
