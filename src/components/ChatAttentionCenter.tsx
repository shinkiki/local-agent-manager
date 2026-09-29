import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeftRight, Bell, BellOff, BellRing, CheckCheck, ChevronDown, CircleAlert, CircleCheck, Gauge, LoaderCircle, ShieldAlert, Trash2 } from "lucide-react";
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
import { SourceBadge } from "./Shared";
import { useDismissablePopover } from "./ChatPopover";

const SWIPE_ACTIVATE_PX = 9;

function Icon({ kind }: { kind: ChatAttentionItem["kind"] }) {
  const Glyph = kind === "approval" ? ShieldAlert
    : kind === "running" ? LoaderCircle
      : kind === "completed" ? CircleCheck
        : kind === "accountSwitch" ? ArrowLeftRight
          : kind === "pacingSuggestion" ? Gauge
            : CircleAlert;
  return <Glyph className={kind === "running" ? "spin" : undefined} size={15} aria-hidden="true" />;
}

/**
 * 알림 둘째 줄에 쓰는 대화 이름. 공급자 세션이 카탈로그에 있으면 그 제목이고, 없으면
 * 작업 경로의 폴더 이름, 그것도 비면 공급자 이름으로 내려간다. 낱개 알림과 대화 묶음
 * 머리줄이 같은 규칙을 각자 적고 있어 한쪽만 손보면 두 줄이 어긋났다.
 */
function attentionSessionLabel(item: ChatAttentionItem, sessions: SessionSummary[]): string {
  const session = item.providerSessionId
    ? sessions.find((candidate) => candidate.source === item.source && candidate.id === item.providerSessionId)
    : null;
  return session?.title ?? (attentionFolderName(item.cwd) || item.source);
}

/**
 * 접힌 묶음의 둘째 줄. 무엇이 묶였는지를 먼저 말한다 — 한 대화가 쌓은 알림이면 그
 * 대화 이름, 반복 요청·워크플로 회차면 어느 갈래에서 왔는지를 알려 주는 작업 경로다.
 */
function groupSubtitle(group: AttentionGroup, sessions: SessionSummary[], text: (ko: string, en: string) => string): string {
  // 대화에 묶이지 않는 두 종류는 폴더·세션 이름이 없다. 묶여도 본문이 보여야 머리줄만
  // 읽고 판단할 수 있으므로 대표 항목의 본문을 그대로 쓴다.
  if (group.reason === "account") return group.lead.detail ?? "";
  if (group.lead.kind === "pacingSuggestion") return group.lead.detail ?? "";
  if (group.reason === "chat") return attentionSessionLabel(group.lead, sessions);
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

/**
 * 기기 OS 알림 토글. 차단·켜짐·꺼짐 세 상태가 각각 버튼을 통째로 적고 있어 클래스·아이콘
 * 크기·요소 구조가 세 벌로 갈라져 있었다. 상태마다 다른 것만 고르고 버튼은 한 벌만 그린다.
 * 차단 상태는 누를 곳이 없으므로 onClick과 aria-pressed를 비워 눌림 상태를 말하지 않는다.
 */
function AttentionDeviceToggle({ enabled, onEnabledChange, onFlash }: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onFlash: (label: string) => void;
}) {
  const { text } = useI18n();
  const denied = webNotificationsDenied();
  const state = denied
    ? {
      Glyph: BellOff,
      label: text("기기 알림 차단됨", "Device notifications blocked"),
      title: text("브라우저 설정에서 이 사이트의 알림을 허용해야 합니다", "Allow notifications for this site in your browser settings"),
      onClick: undefined as (() => void) | undefined,
    }
    : enabled
      ? {
        Glyph: BellRing,
        label: text("기기 알림 켜짐", "Device notifications on"),
        title: text("눌러서 이 기기의 OS 알림 끄기", "Click to turn off OS notifications on this device"),
        onClick: () => {
          disableWebNotifications();
          onEnabledChange(false);
          onFlash(text("기기 알림 꺼짐", "Device notifications off"));
        },
      }
      : {
        Glyph: BellOff,
        label: text("기기 알림 꺼짐", "Device notifications off"),
        title: text("눌러서 이 기기의 OS 알림 켜기", "Click to turn on OS notifications on this device"),
        onClick: () => {
          void enableWebNotifications().then((granted) => {
            onEnabledChange(granted);
            onFlash(granted ? text("기기 알림 켜짐", "Device notifications on") : text("기기 알림 차단됨", "Device notifications blocked"));
          });
        },
      };
  return <button
    className="attention-device-toggle"
    type="button"
    disabled={denied}
    aria-pressed={denied ? undefined : enabled}
    aria-label={state.label}
    title={state.title}
    onClick={state.onClick}
  ><state.Glyph size={19} /></button>;
}

/**
 * 왼쪽으로 밀어 지우는 제스처. 포인터 세 단계(누름·이동·뗌)와 그 사이에 들고 있어야 하는
 * 값(추적 중인 포인터, 시작 좌표, 항목 너비, 세로 스크롤과 갈린 뒤인지)이 렌더와 한
 * 함수에 섞여 있으면, 어디까지가 제스처 판정이고 어디부터가 화면인지 읽어 가려야 한다.
 * 판정만 여기로 모으고, 화면은 `offset`·`swiping` 두 값과 손잡이 묶음만 받는다.
 *
 * 눌렀다 뗀 것이 스와이프였으면 뒤따라 오는 click은 열기가 아니다. 그 한 번을 삼키는
 * 것도 제스처의 일부라 여는 손잡이(`onClick`)를 여기서 함께 내준다.
 */
function useSwipeToDismiss({ enabled, onOpen, onDismiss }: {
  enabled: boolean;
  onOpen: () => void;
  /** 실제로 사라졌는지 돌려준다. 남아 있으면 민 만큼을 제자리로 되돌린다. */
  onDismiss: () => Promise<boolean>;
}) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; width: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.offsetWidth,
      active: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
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

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
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

  const onPointerCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    setSwiping(false);
    setOffset(0);
  };

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onOpen();
  };

  return { offset, swiping, onClick, surface: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
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
  const { offset, swiping, onClick, surface } = useSwipeToDismiss({ enabled: dismissable, onOpen, onDismiss });

  return (
    <div className={className} {...surface}>
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
        onClick={onClick}
        style={offset ? { transform: `translateX(${offset}px)`, transition: swiping ? "none" : undefined } : undefined}
      >
        {children}
      </button>
    </div>
  );
}

/**
 * 알림 행의 클래스 이름. 낱개 행과 묶음 머리줄이 `attention-item`·종류·안읽음을 각자
 * 이어 붙이고 있어, 한쪽에만 클래스를 더하면 두 행의 모양이 조용히 갈라졌다.
 */
function attentionRowClassName(kind: ChatAttentionItem["kind"], unread: boolean, variant?: string): string {
  return `attention-item attention-item-${kind}${variant ? ` ${variant}` : ""}${unread ? " unread" : ""}`;
}

/**
 * 알림 행 본문 네 겹 — 종류 아이콘, 제목과 시각, 공급자 배지와 둘째 줄, 보조 설명.
 * 낱개 행과 묶음 머리줄이 같은 네 겹을 각자 적고 있어 요소 구조가 두 벌로 갈라져 있었다.
 * 두 행이 실제로 다른 것은 제목줄·공급자줄에 덧붙는 조각(묶음 건수, 펼침 화살표)과
 * 둘째 줄의 클래스뿐이라 그것만 손잡이로 받는다.
 */
function AttentionRowBody({ kind, source, title, createdAt, secondLine, secondLineClass, titleAside, sessionAside, detail }: {
  kind: ChatAttentionItem["kind"];
  source: ChatAttentionItem["source"];
  title: string;
  createdAt: ChatAttentionItem["createdAt"];
  secondLine: string;
  secondLineClass?: string;
  titleAside?: ReactNode;
  sessionAside?: ReactNode;
  detail?: ReactNode;
}) {
  return <>
    <span className="attention-kind"><Icon kind={kind} /></span>
    <span className="attention-copy">
      <span className="attention-item-title"><strong>{title}</strong>{titleAside}<time>{formatRelative(createdAt)}</time></span>
      <span className="attention-session"><SourceBadge source={source} /><span className={secondLineClass}>{secondLine}</span>{sessionAside}</span>
      {detail}
    </span>
  </>;
}

function AttentionItemRow({ item, nested, sessions, onOpen, onDismiss }: {
  item: ChatAttentionItem;
  nested: boolean;
  sessions: SessionSummary[];
  onOpen: (item: ChatAttentionItem) => void;
  onDismiss: (items: ChatAttentionItem[]) => Promise<boolean>;
}) {
  // 계정 전환은 세션이 없어 둘째 줄에 "A → B · 사유" 전환 문구를 대신 보인다.
  // 채팅에 묶이지 않는 두 종류는 대화 이름이 없다. 본문을 그대로 둘째 줄로 쓴다.
  const secondLine = item.kind === "accountSwitch" || item.kind === "pacingSuggestion"
    ? item.detail ?? ""
    : attentionSessionLabel(item, sessions);
  return <AttentionSwipeItem
    className={attentionRowClassName(item.kind, !item.read || item.kind === "approval", nested ? "attention-item-nested" : undefined)}
    dismissable={item.kind !== "approval"}
    onOpen={() => onOpen(item)}
    onDismiss={() => onDismiss([item])}
  >
    <AttentionRowBody
      kind={item.kind}
      source={item.source}
      title={item.title}
      createdAt={item.createdAt}
      secondLine={secondLine}
      detail={item.kind === "approval" && item.detail ? <small>{item.detail}</small> : null}
    />
  </AttentionSwipeItem>;
}

/**
 * 묶음 머리줄. 누르면 알림을 여는 대신 펼쳐지고, 스와이프는 묶음에 든 알림을 한꺼번에
 * 지운다. 승인 대기 묶음은 서버가 개별 삭제를 거절하므로 스와이프도 열어 두지 않는다.
 */
function AttentionGroupRow({ group, expanded, sessions, text, onToggle, onOpen, onDismiss }: {
  group: AttentionGroup;
  expanded: boolean;
  sessions: SessionSummary[];
  text: (ko: string, en: string) => string;
  onToggle: (key: string) => void;
  onOpen: (item: ChatAttentionItem) => void;
  onDismiss: (items: ChatAttentionItem[]) => Promise<boolean>;
}) {
  return <div className="attention-group">
    <AttentionSwipeItem
      className={attentionRowClassName(group.lead.kind, group.unreadCount > 0, "attention-group-head")}
      dismissable={group.dismissable}
      expanded={expanded}
      onOpen={() => onToggle(group.key)}
      onDismiss={() => onDismiss(group.items)}
    >
      <AttentionRowBody
        kind={group.lead.kind}
        source={group.lead.source}
        title={group.lead.title}
        createdAt={group.lead.createdAt}
        secondLine={groupSubtitle(group, sessions, text)}
        secondLineClass="attention-group-sub"
        titleAside={<em className="attention-group-count">{groupCountLabel(group, text)}</em>}
        sessionAside={<ChevronDown className={`attention-group-chevron${expanded ? " open" : ""}`} size={14} aria-hidden="true" />}
      />
    </AttentionSwipeItem>
    {expanded && group.items.map((item) => <AttentionItemRow
      item={item}
      nested
      sessions={sessions}
      onOpen={onOpen}
      onDismiss={onDismiss}
      key={item.id}
    />)}
  </div>;
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
  const { open, setOpen, rootRef } = useDismissablePopover();
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [deviceNotifications, setDeviceNotifications] = useState(webNotificationsEnabled);
  const [deviceFlash, setDeviceFlash] = useState<string | null>(null);
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

  const openItem = (item: ChatAttentionItem) => {
    setOpen(false);
    onOpen(item);
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => current.includes(key)
      ? current.filter((candidate) => candidate !== key)
      : [...current, key]);
  };

  const groups = groupAttentionItems(snapshot.items);

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
              <AttentionDeviceToggle enabled={deviceNotifications} onEnabledChange={setDeviceNotifications} onFlash={flashDeviceState} />
              {deviceFlash && <em className="attention-device-flash" role="status">{deviceFlash}</em>}
            </span>}
            <div className="attention-heading-text">
              <strong>{text("알림", "Notifications")}</strong>
              <span>{snapshot.pendingCount > 0 ? text(`확인 필요 ${snapshot.pendingCount}개`, `${snapshot.pendingCount} need attention`) : text("새 확인사항", "Nothing new")}</span>
            </div>
          </div>
          <div className="attention-header-actions">
            {snapshot.items.some((item) => item.read && (item.kind === "completed" || item.kind === "failed" || item.kind === "accountSwitch" || item.kind === "pacingSuggestion")) && <button type="button" aria-label={text("읽은 알림 전체 삭제", "Delete all read notifications")} title={text("읽은 알림 전체 삭제", "Delete all read notifications")} onClick={onClearRead}><Trash2 size={13} />{text("읽음 전체삭제", "Clear read")}</button>}
            {snapshot.items.some((item) => item.kind !== "approval" && !item.read) && <button type="button" onClick={onMarkAllRead}><CheckCheck size={13} />{text("모두 읽음", "Mark all read")}</button>}
          </div>
        </header>
        <div className="attention-list">
          {groups.length === 0
            ? <div className="attention-empty"><Bell size={20} /><span>{text("새 알림이 없습니다.", "No new notifications.")}</span></div>
            : groups.map((group) => group.items.length === 1
              ? <AttentionItemRow item={group.lead} nested={false} sessions={sessions} onOpen={openItem} onDismiss={onDismiss} key={group.lead.id} />
              : <AttentionGroupRow
                group={group}
                expanded={expandedGroups.includes(group.key)}
                sessions={sessions}
                text={text}
                onToggle={toggleGroup}
                onOpen={openItem}
                onDismiss={onDismiss}
                key={group.key}
              />)}
        </div>
      </section>}
    </div>
  );
}
